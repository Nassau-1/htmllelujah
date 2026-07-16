import { createServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';

import WebSocket, { WebSocketServer } from 'ws';

import {
  COLLABORATION_PROTOCOL_VERSION,
  type AcquireTextLeaseRequest,
  type CommandBatchRequest,
  type CommittedTransaction,
  type PresenceUpdate,
  type ReleaseTextLeaseRequest,
  type RenewTextLeaseRequest,
  type ResyncRequest,
} from '../contracts.js';
import { CollaborationError } from '../errors.js';
import type { AuthoritativeSessionHost } from '../host.js';
import {
  constantTimeEqual,
  createAuthProof,
  createNonce,
  generateEphemeralCertificate,
  normalizeDocumentSecret,
} from './crypto.js';
import {
  BoundedSender,
  ChunkReassembler,
  DEFAULT_CHUNK_TIMEOUT_MS,
  DEFAULT_MAX_BUFFERED_BYTES,
  DEFAULT_MAX_CONCURRENT_TRANSFERS,
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_MAX_LOGICAL_PAYLOAD_BYTES,
  DEFAULT_MAX_QUEUED_BYTES,
  DEFAULT_MAX_REASSEMBLY_BYTES,
  DEFAULT_SEND_TIMEOUT_MS,
} from './framing.js';
import {
  authChallengeSchema,
  authPendingSchema,
  authResponseSchema,
  collaborationDisplayNameSchema,
  clientRequestMessageSchema,
  manualInvitationSchema,
  type AuthChallenge,
  type AuthResponse,
  type ClientRequestMessage,
  type ManualInvitation,
} from './protocol.js';

export interface CollaborationTransportServerOptions {
  readonly engine: AuthoritativeSessionHost;
  readonly hostClientId?: string;
  readonly documentSecret: Uint8Array;
  readonly bindHost?: string;
  readonly advertisedHost?: string;
  readonly port?: number;
  readonly maxPayloadBytes?: number;
  readonly maxLogicalPayloadBytes?: number;
  readonly maxReassemblyBytes?: number;
  readonly maxConcurrentTransfers?: number;
  readonly chunkTimeoutMs?: number;
  readonly maxBufferedBytes?: number;
  readonly maxQueuedBytes?: number;
  readonly sendTimeoutMs?: number;
  readonly maxPeers?: number;
  readonly maxPendingConnections?: number;
  readonly maxPendingPerAddress?: number;
  readonly maxQueuedRequestsPerConnection?: number;
  readonly maxQueuedRequestBytesPerConnection?: number;
  readonly maxMessagesPerWindow?: number;
  readonly rateWindowMs?: number;
  readonly authTimeoutMs?: number;
  readonly joinApprovalTimeoutMs?: number;
  readonly reconnectGrantTtlMs?: number;
  readonly invitationTtlMs?: number;
  readonly clock?: () => number;
  readonly idFactory?: () => string;
  readonly nonceFactory?: () => string;
}

interface ConnectionState {
  readonly socket: WebSocket;
  readonly challenge: AuthChallenge;
  readonly remoteAddress: string;
  readonly sender: BoundedSender;
  readonly reassembler: ChunkReassembler;
  authTimer: ReturnType<typeof setTimeout> | undefined;
  authenticated: boolean;
  operationalReady: boolean;
  closing: boolean;
  clientId: string | undefined;
  displayName: string | undefined;
  pendingJoinRequestId: string | undefined;
  pendingJoinRequestedAtMs: number | undefined;
  pendingJoinExpiresAtMs: number | undefined;
  windowStartedAtMs: number;
  messageCount: number;
  requestQueue: Promise<void>;
  queuedRequests: number;
  queuedRequestBytes: number;
}

export interface PendingJoinRequest {
  readonly joinRequestId: string;
  readonly clientId: string;
  readonly displayName: string;
  readonly requestedAtMs: number;
  readonly expiresAtMs: number;
}

interface ReconnectGrant {
  readonly clientId: string;
  readonly displayName: string;
  readonly token: string;
  readonly expiresAtMs: number;
}

interface PreUpgradeConnectionState {
  readonly socket: Socket;
  readonly remoteAddress: string;
  readonly key: string;
  timer: ReturnType<typeof setTimeout> | undefined;
  upgraded: boolean;
}

const MAX_AUTHENTICATED_PEERS = 32;

const DEFAULT_MAX_PEERS = 8;
const DEFAULT_MAX_PENDING_CONNECTIONS = 16;
const DEFAULT_MAX_PENDING_PER_ADDRESS = 8;
const DEFAULT_MAX_QUEUED_REQUESTS = 64;
const DEFAULT_MAX_QUEUED_REQUEST_BYTES = 32 * 1024 * 1024;
const DEFAULT_RATE_LIMIT = 60;
const DEFAULT_RATE_WINDOW_MS = 1_000;
const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const DEFAULT_JOIN_APPROVAL_TIMEOUT_MS = 60_000;
const DEFAULT_RECONNECT_GRANT_TTL_MS = 2 * 60_000;
const DEFAULT_INVITATION_TTL_MS = 12 * 60 * 60 * 1_000;

const json = (value: unknown): string => JSON.stringify(value);

export class CollaborationTransportServer {
  private readonly engine: AuthoritativeSessionHost;
  private readonly documentSecret: Buffer;
  private readonly hostClientId: string | undefined;
  private readonly bindHost: string;
  private readonly advertisedHost: string;
  private readonly requestedPort: number;
  private readonly maxPayloadBytes: number;
  private readonly maxLogicalPayloadBytes: number;
  private readonly maxReassemblyBytes: number;
  private readonly maxConcurrentTransfers: number;
  private readonly chunkTimeoutMs: number;
  private readonly maxBufferedBytes: number;
  private readonly maxQueuedBytes: number;
  private readonly sendTimeoutMs: number;
  private readonly maxPeers: number;
  private readonly maxPendingConnections: number;
  private readonly maxPendingPerAddress: number;
  private readonly maxQueuedRequestsPerConnection: number;
  private readonly maxQueuedRequestBytesPerConnection: number;
  private readonly maxMessagesPerWindow: number;
  private readonly rateWindowMs: number;
  private readonly authTimeoutMs: number;
  private readonly joinApprovalTimeoutMs: number;
  private readonly reconnectGrantTtlMs: number;
  private readonly invitationTtlMs: number;
  private readonly clock: () => number;
  private readonly idFactory: () => string;
  private readonly nonceFactory: () => string;
  private readonly connections = new Map<WebSocket, ConnectionState>();
  private readonly preUpgradeConnections = new Map<string, PreUpgradeConnectionState>();
  private readonly replayNonces = new Map<string, number>();
  private readonly reconnectGrants = new Map<string, ReconnectGrant>();
  private readonly pendingJoinListeners = new Set<(request: PendingJoinRequest) => void>();
  private readonly participantListeners = new Set<() => void>();
  private httpsServer: HttpsServer | undefined;
  private webSocketServer: WebSocketServer | undefined;
  private invitation: ManualInvitation | undefined;
  private startPromise: Promise<ManualInvitation> | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;

  public constructor(options: CollaborationTransportServerOptions) {
    this.engine = options.engine;
    this.hostClientId = options.hostClientId?.trim();
    this.documentSecret = normalizeDocumentSecret(options.documentSecret);
    this.bindHost = options.bindHost ?? '127.0.0.1';
    this.advertisedHost = options.advertisedHost ?? this.bindHost;
    this.requestedPort = options.port ?? 0;
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.maxLogicalPayloadBytes =
      options.maxLogicalPayloadBytes ?? DEFAULT_MAX_LOGICAL_PAYLOAD_BYTES;
    this.maxReassemblyBytes = options.maxReassemblyBytes ?? DEFAULT_MAX_REASSEMBLY_BYTES;
    this.maxConcurrentTransfers =
      options.maxConcurrentTransfers ?? DEFAULT_MAX_CONCURRENT_TRANSFERS;
    this.chunkTimeoutMs = options.chunkTimeoutMs ?? DEFAULT_CHUNK_TIMEOUT_MS;
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
    this.sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    this.maxPeers = options.maxPeers ?? DEFAULT_MAX_PEERS;
    this.maxPendingConnections = options.maxPendingConnections ?? DEFAULT_MAX_PENDING_CONNECTIONS;
    this.maxPendingPerAddress = options.maxPendingPerAddress ?? DEFAULT_MAX_PENDING_PER_ADDRESS;
    this.maxQueuedRequestsPerConnection =
      options.maxQueuedRequestsPerConnection ?? DEFAULT_MAX_QUEUED_REQUESTS;
    this.maxQueuedRequestBytesPerConnection =
      options.maxQueuedRequestBytesPerConnection ?? DEFAULT_MAX_QUEUED_REQUEST_BYTES;
    this.maxMessagesPerWindow = options.maxMessagesPerWindow ?? DEFAULT_RATE_LIMIT;
    this.rateWindowMs = options.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS;
    this.authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
    this.joinApprovalTimeoutMs = options.joinApprovalTimeoutMs ?? DEFAULT_JOIN_APPROVAL_TIMEOUT_MS;
    this.reconnectGrantTtlMs = options.reconnectGrantTtlMs ?? DEFAULT_RECONNECT_GRANT_TTL_MS;
    this.invitationTtlMs = options.invitationTtlMs ?? DEFAULT_INVITATION_TTL_MS;
    this.clock = options.clock ?? (() => Date.now());
    this.idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
    this.nonceFactory = options.nonceFactory ?? createNonce;
    if (
      ![
        this.maxPayloadBytes,
        this.maxLogicalPayloadBytes,
        this.maxReassemblyBytes,
        this.maxConcurrentTransfers,
        this.chunkTimeoutMs,
        this.maxBufferedBytes,
        this.maxQueuedBytes,
        this.sendTimeoutMs,
        this.maxPeers,
        this.maxPendingConnections,
        this.maxPendingPerAddress,
        this.maxQueuedRequestsPerConnection,
        this.maxQueuedRequestBytesPerConnection,
        this.maxMessagesPerWindow,
        this.rateWindowMs,
        this.authTimeoutMs,
        this.joinApprovalTimeoutMs,
        this.reconnectGrantTtlMs,
        this.invitationTtlMs,
      ].every((value) => Number.isSafeInteger(value) && value > 0) ||
      this.joinApprovalTimeoutMs > 5 * 60_000 ||
      this.reconnectGrantTtlMs > 10 * 60_000 ||
      this.maxPeers > MAX_AUTHENTICATED_PEERS ||
      (this.hostClientId !== undefined &&
        (this.hostClientId.length < 1 ||
          this.hostClientId.length > 128 ||
          /[\p{Cc}\p{Cf}]/u.test(this.hostClientId))) ||
      !Number.isSafeInteger(this.requestedPort) ||
      this.requestedPort < 0 ||
      this.requestedPort > 65_535
    ) {
      throw new CollaborationError(
        'INVALID_REQUEST',
        'Transport limits and timeouts must be positive safe integers, maxPeers must not exceed 32, and the port must be valid.',
      );
    }
  }

  public get authenticatedPeerCount(): number {
    return [...this.connections.values()].filter((state) => state.authenticated).length;
  }

  public get connectionCount(): number {
    return this.connections.size;
  }

  public get pendingHandshakeCount(): number {
    return [...this.preUpgradeConnections.values()].filter((state) => !state.upgraded).length;
  }

  public onPendingJoin(listener: (request: PendingJoinRequest) => void): () => void {
    this.pendingJoinListeners.add(listener);
    return () => this.pendingJoinListeners.delete(listener);
  }

  public onParticipantsChanged(listener: () => void): () => void {
    this.participantListeners.add(listener);
    return () => this.participantListeners.delete(listener);
  }

  public listPendingJoins(): readonly PendingJoinRequest[] {
    this.purgeExpiredPendingJoins();
    return [...this.connections.values()]
      .map((state) => this.pendingJoinForState(state))
      .filter((request): request is PendingJoinRequest => request !== undefined)
      .sort((left, right) => left.requestedAtMs - right.requestedAtMs)
      .map((request) => structuredClone(request));
  }

  public async approveJoin(joinRequestId: string): Promise<boolean> {
    this.purgeExpiredPendingJoins();
    const state = [...this.connections.values()].find(
      (candidate) => candidate.pendingJoinRequestId === joinRequestId,
    );
    if (state === undefined || state.clientId === undefined || state.displayName === undefined) {
      return false;
    }
    if (this.authenticatedPeerCount >= this.maxPeers) {
      this.rejectAuthentication(
        state,
        'PEER_LIMIT',
        'The collaboration session reached its authenticated peer limit.',
      );
      return false;
    }
    if (
      [...this.connections.values()].some(
        (candidate) =>
          candidate !== state && candidate.authenticated && candidate.clientId === state.clientId,
      )
    ) {
      this.rejectAuthentication(
        state,
        'CLIENT_ID_IN_USE',
        'The collaboration client identity is already connected.',
      );
      return false;
    }
    await this.acceptAuthenticatedConnection(state);
    return state.authenticated && state.operationalReady;
  }

  public rejectJoin(joinRequestId: string): boolean {
    this.purgeExpiredPendingJoins();
    const state = [...this.connections.values()].find(
      (candidate) => candidate.pendingJoinRequestId === joinRequestId,
    );
    if (state === undefined) return false;
    this.rejectAuthentication(state, 'JOIN_REJECTED', 'The host rejected this join request.');
    return true;
  }

  public async publishPresence(update: PresenceUpdate): Promise<void> {
    const record = this.engine.updatePresence(update);
    this.broadcast({
      type: 'presence.changed',
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      payload: record,
    });
    this.participantListeners.forEach((listener) => listener());
  }

  public start(): Promise<ManualInvitation> {
    if (this.invitation !== undefined) return Promise.resolve(this.invitation);
    if (this.closed) {
      return Promise.reject(
        new CollaborationError('INVALID_REQUEST', 'A closed transport server cannot be restarted.'),
      );
    }
    if (this.startPromise !== undefined) return this.startPromise;
    const attempt = this.startInternal();
    this.startPromise = attempt;
    void attempt.catch(() => {
      if (this.startPromise === attempt) this.startPromise = undefined;
    });
    return attempt;
  }

  private async startInternal(): Promise<ManualInvitation> {
    const certificate = await generateEphemeralCertificate();
    const server = createServer({
      cert: certificate.certificatePem,
      key: certificate.privateKeyPem,
      minVersion: 'TLSv1.3',
    });
    server.on('request', (_request, response) => {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found.');
    });
    const webSocketServer = new WebSocketServer({
      server,
      clientTracking: true,
      maxPayload: this.maxPayloadBytes,
      perMessageDeflate: false,
    });
    webSocketServer.on('connection', (socket, request) => {
      if (!this.markConnectionUpgraded(request.socket as Socket)) {
        socket.close(1013, 'Pending limit');
        socket.terminate();
        return;
      }
      this.acceptConnection(
        socket,
        request.url ?? '',
        certificate.fingerprint,
        request.socket.remoteAddress ?? 'unknown',
      );
    });
    webSocketServer.on('error', () => undefined);
    server.on('connection', (socket) => this.acceptPreUpgradeConnection(socket as Socket));
    server.on('clientError', (_error, socket) => socket.destroy());

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once('error', onError);
      server.listen(this.requestedPort, this.bindHost, () => {
        server.off('error', onError);
        resolve();
      });
    });
    const address = server.address() as AddressInfo | null;
    if (address === null) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new CollaborationError('INVALID_REQUEST', 'The TLS server did not expose an address.');
    }

    this.httpsServer = server;
    this.webSocketServer = webSocketServer;
    this.invitation = manualInvitationSchema.parse({
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      host: this.advertisedHost,
      port: address.port,
      sessionId: this.engine.sessionId,
      certificateFingerprint: certificate.fingerprint,
      expiresAtMs: this.clock() + this.invitationTtlMs,
    });
    return this.invitation;
  }

  public close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closed = true;
    this.closing = this.closeInternal();
    return this.closing;
  }

  /** Commits a trusted host-side command and publishes it to every authenticated replica. */
  public async submitAndBroadcast(request: CommandBatchRequest): Promise<CommittedTransaction> {
    const transaction = await this.engine.submitAsync(request);
    this.broadcast({
      type: 'transaction.committed',
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      payload: transaction,
    });
    return transaction;
  }

  private async closeInternal(): Promise<void> {
    await this.startPromise?.catch(() => undefined);
    const webSocketServer = this.webSocketServer;
    const httpsServer = this.httpsServer;
    this.webSocketServer = undefined;
    this.httpsServer = undefined;
    this.invitation = undefined;

    const connectedClientIds = new Set<string>();
    this.connections.forEach((state) => {
      if (state.authTimer !== undefined) clearTimeout(state.authTimer);
      state.sender.dispose();
      state.reassembler.dispose();
      if (state.clientId !== undefined) connectedClientIds.add(state.clientId);
      state.socket.close(1001, 'Server shutdown');
      state.socket.terminate();
    });
    this.connections.clear();
    this.preUpgradeConnections.forEach((state) => {
      if (state.timer !== undefined) clearTimeout(state.timer);
      state.socket.destroy();
    });
    this.preUpgradeConnections.clear();
    connectedClientIds.forEach((clientId) => {
      this.engine.removePresence(clientId);
      this.engine.releaseTextLeasesForClient(clientId);
    });
    if (webSocketServer !== undefined) {
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
    }
    if (httpsServer !== undefined) {
      await new Promise<void>((resolve) => httpsServer.close(() => resolve()));
    }
    this.replayNonces.clear();
    this.reconnectGrants.clear();
    this.pendingJoinListeners.clear();
    this.participantListeners.clear();
    this.documentSecret.fill(0);
  }

  private acceptConnection(
    socket: WebSocket,
    requestUrl: string,
    fingerprint: string,
    remoteAddress: string,
  ): void {
    const expectedPath = `/v1/session/${this.engine.sessionId}`;
    if (requestUrl !== expectedPath) {
      socket.close(1008, 'Invalid session path');
      return;
    }
    if (this.invitation === undefined || this.invitation.expiresAtMs <= this.clock()) {
      socket.send(
        json({
          type: 'auth.rejected',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          code: 'INVITATION_EXPIRED',
          message: 'The collaboration invitation expired.',
        }),
      );
      socket.close(1008, 'Invitation expired');
      return;
    }
    const pending = [...this.connections.values()].filter((state) => !state.authenticated);
    const pendingPreUpgrade = [...this.preUpgradeConnections.values()].filter(
      (state) => !state.upgraded,
    );
    if (
      pending.length + pendingPreUpgrade.length >= this.maxPendingConnections ||
      pending.filter((state) => state.remoteAddress === remoteAddress).length +
        pendingPreUpgrade.filter((state) => state.remoteAddress === remoteAddress).length >=
        this.maxPendingPerAddress
    ) {
      socket.send(
        json({
          type: 'auth.rejected',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          code: 'PENDING_LIMIT',
          message: 'The collaboration authentication queue is full.',
        }),
      );
      socket.close(1013, 'Pending limit');
      return;
    }

    const challenge = authChallengeSchema.parse({
      type: 'auth.challenge',
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      sessionId: this.engine.sessionId,
      challengeId: this.idFactory(),
      serverNonce: this.nonceFactory(),
      certificateFingerprint: fingerprint,
      expiresAtMs: this.clock() + this.authTimeoutMs,
    });
    let state!: ConnectionState;
    const sender = new BoundedSender(socket, {
      stream: 'server',
      secret: this.documentSecret,
      idFactory: this.idFactory,
      maxFrameBytes: this.maxPayloadBytes,
      maxLogicalPayloadBytes: this.maxLogicalPayloadBytes,
      maxBufferedBytes: this.maxBufferedBytes,
      maxQueuedBytes: this.maxQueuedBytes,
      sendTimeoutMs: this.sendTimeoutMs,
    });
    const reassembler = new ChunkReassembler({
      stream: 'client',
      secret: this.documentSecret,
      maxFrameBytes: this.maxPayloadBytes,
      maxLogicalPayloadBytes: this.maxLogicalPayloadBytes,
      maxReassemblyBytes: this.maxReassemblyBytes,
      maxConcurrentTransfers: this.maxConcurrentTransfers,
      chunkTimeoutMs: this.chunkTimeoutMs,
      clock: this.clock,
      onTimeout: () => {
        if (state !== undefined) this.closeProtocolPeer(state, 'Chunk timeout');
      },
    });
    state = {
      socket,
      challenge,
      remoteAddress,
      sender,
      reassembler,
      authTimer: undefined,
      authenticated: false,
      operationalReady: false,
      closing: false,
      clientId: undefined,
      displayName: undefined,
      pendingJoinRequestId: undefined,
      pendingJoinRequestedAtMs: undefined,
      pendingJoinExpiresAtMs: undefined,
      windowStartedAtMs: this.clock(),
      messageCount: 0,
      requestQueue: Promise.resolve(),
      queuedRequests: 0,
      queuedRequestBytes: 0,
    };
    state.authTimer = setTimeout(() => {
      this.rejectAuthentication(state, 'AUTH_EXPIRED', 'Authentication timed out.');
    }, this.authTimeoutMs);
    this.connections.set(socket, state);
    socket.on('message', (data, isBinary) => this.receive(state, data, isBinary));
    socket.on('close', () => this.removeConnection(state));
    socket.on('error', () => this.removeConnection(state));
    void sender.sendRaw(json(challenge)).catch(() => this.removeConnection(state));
  }

  private acceptPreUpgradeConnection(socket: Socket): void {
    const remoteAddress = socket.remoteAddress ?? 'unknown';
    const key = this.connectionKey(socket);
    const pending = [...this.preUpgradeConnections.values()].filter((state) => !state.upgraded);
    const pendingWebSockets = [...this.connections.values()].filter(
      (state) => !state.authenticated,
    );
    if (
      pending.length + pendingWebSockets.length >= this.maxPendingConnections ||
      pending.filter((state) => state.remoteAddress === remoteAddress).length +
        pendingWebSockets.filter((state) => state.remoteAddress === remoteAddress).length >=
        this.maxPendingPerAddress ||
      this.preUpgradeConnections.has(key)
    ) {
      socket.destroy();
      return;
    }
    const state: PreUpgradeConnectionState = {
      socket,
      remoteAddress,
      key,
      timer: undefined,
      upgraded: false,
    };
    state.timer = setTimeout(() => {
      if (!state.upgraded) socket.destroy();
    }, this.authTimeoutMs);
    state.timer.unref?.();
    this.preUpgradeConnections.set(key, state);
    const remove = (): void => {
      if (state.timer !== undefined) clearTimeout(state.timer);
      state.timer = undefined;
      if (this.preUpgradeConnections.get(key) === state) {
        this.preUpgradeConnections.delete(key);
      }
    };
    socket.once('close', remove);
    socket.once('error', remove);
  }

  private markConnectionUpgraded(socket: Socket): boolean {
    const state = this.preUpgradeConnections.get(this.connectionKey(socket));
    if (state === undefined || state.upgraded) return false;
    state.upgraded = true;
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.timer = undefined;
    return true;
  }

  private connectionKey(socket: Socket): string {
    return [
      socket.remoteAddress ?? 'unknown',
      socket.remotePort ?? -1,
      socket.localAddress ?? 'unknown',
      socket.localPort ?? -1,
    ].join('\0');
  }

  private receive(state: ConnectionState, data: WebSocket.RawData, isBinary: boolean): void {
    if (this.connections.get(state.socket) !== state) {
      state.socket.terminate();
      return;
    }
    if (state.closing) return;
    if (isBinary) {
      this.closeProtocolPeer(state, 'Text frames only');
      return;
    }
    // Charge the raw frame before JSON parsing or HMAC work so malformed and
    // chunked traffic share the same bounded per-peer CPU budget.
    if (!this.consumeRateToken(state)) {
      this.closeProtocolPeer(state, 'Rate limit');
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      this.closeProtocolPeer(state, 'Malformed JSON');
      return;
    }

    if (!state.authenticated) {
      this.authenticate(state, raw);
      return;
    }
    if (!state.operationalReady) {
      this.closeProtocolPeer(state, 'Authentication bootstrap is still in progress');
      return;
    }
    let logical: string | undefined;
    try {
      logical = state.reassembler.accept(raw);
    } catch {
      this.closeProtocolPeer(state, 'Malformed chunk');
      return;
    }
    if (logical === undefined) return;
    const logicalByteLength = Buffer.byteLength(logical);
    if (
      state.queuedRequests >= this.maxQueuedRequestsPerConnection ||
      state.queuedRequestBytes + logicalByteLength > this.maxQueuedRequestBytesPerConnection
    ) {
      this.closeProtocolPeer(state, 'Request queue limit');
      return;
    }
    let message: ClientRequestMessage;
    try {
      message = clientRequestMessageSchema.parse(JSON.parse(logical));
    } catch {
      this.closeProtocolPeer(state, 'Malformed protocol message');
      return;
    }
    state.queuedRequests += 1;
    state.queuedRequestBytes += logicalByteLength;
    const operation = state.requestQueue.then(() => {
      if (
        this.connections.get(state.socket) !== state ||
        !state.authenticated ||
        !state.operationalReady ||
        state.socket.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      return this.handleRequest(state, message);
    });
    state.requestQueue = operation
      .catch(() => this.removeConnection(state))
      .finally(() => {
        state.queuedRequests -= 1;
        state.queuedRequestBytes -= logicalByteLength;
      });
  }

  private authenticate(state: ConnectionState, raw: unknown): void {
    if (state.pendingJoinRequestId !== undefined) {
      this.rejectAuthentication(state, 'PROTOCOL_ERROR', 'Join confirmation is still pending.');
      return;
    }
    let response: AuthResponse;
    try {
      response = authResponseSchema.parse(raw);
    } catch {
      this.rejectAuthentication(state, 'PROTOCOL_ERROR', 'Malformed authentication response.');
      return;
    }
    const challenge = state.challenge;
    if (this.invitation === undefined || this.invitation.expiresAtMs <= this.clock()) {
      this.rejectAuthentication(
        state,
        'INVITATION_EXPIRED',
        'The collaboration invitation expired.',
      );
      return;
    }
    if (
      response.sessionId !== this.engine.sessionId ||
      response.documentId !== this.engine.documentId ||
      response.challengeId !== challenge.challengeId
    ) {
      this.rejectAuthentication(state, 'AUTH_FAILED', 'Authentication scope mismatch.');
      return;
    }
    if (challenge.expiresAtMs <= this.clock()) {
      this.rejectAuthentication(state, 'AUTH_EXPIRED', 'Authentication challenge expired.');
      return;
    }
    this.purgeReplayNonces();
    const replayKey = `${response.clientId}:${response.clientNonce}`;
    if (this.replayNonces.has(replayKey)) {
      this.rejectAuthentication(state, 'AUTH_REPLAY', 'Authentication nonce was already used.');
      return;
    }
    const expectedProof = createAuthProof(this.documentSecret, {
      sessionId: this.engine.sessionId,
      documentId: this.engine.documentId,
      certificateFingerprint: challenge.certificateFingerprint,
      challengeId: challenge.challengeId,
      serverNonce: challenge.serverNonce,
      clientId: response.clientId,
      displayName: response.displayName,
      clientNonce: response.clientNonce,
      ...(response.reconnectToken === undefined ? {} : { reconnectToken: response.reconnectToken }),
      expiresAtMs: challenge.expiresAtMs,
    });
    if (!constantTimeEqual(response.proof, expectedProof)) {
      this.rejectAuthentication(state, 'AUTH_FAILED', 'Authentication proof is invalid.');
      return;
    }
    if (this.authenticatedPeerCount >= this.maxPeers) {
      this.rejectAuthentication(
        state,
        'PEER_LIMIT',
        'The collaboration session reached its authenticated peer limit.',
      );
      return;
    }
    if (
      response.clientId === this.hostClientId ||
      [...this.connections.values()].some(
        (candidate) => candidate !== state && candidate.clientId === response.clientId,
      ) ||
      this.engine.listPresence().some((presence) => presence.clientId === response.clientId)
    ) {
      this.rejectAuthentication(
        state,
        'CLIENT_ID_IN_USE',
        'The collaboration client identity is already connected.',
      );
      return;
    }

    state.clientId = response.clientId;
    state.displayName = response.displayName;
    state.messageCount = 0;
    state.windowStartedAtMs = this.clock();
    if (state.authTimer !== undefined) clearTimeout(state.authTimer);
    this.replayNonces.set(replayKey, challenge.expiresAtMs);
    this.purgeReconnectGrants();
    const reconnectGrant = this.reconnectGrants.get(response.clientId);
    if (
      response.reconnectToken !== undefined &&
      reconnectGrant !== undefined &&
      reconnectGrant.displayName === response.displayName &&
      constantTimeEqual(response.reconnectToken, reconnectGrant.token)
    ) {
      void this.acceptAuthenticatedConnection(state).catch(() => this.removeConnection(state));
      return;
    }

    const requestedAtMs = this.clock();
    const pending = authPendingSchema.parse({
      type: 'auth.pending',
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      joinRequestId: this.idFactory(),
      expiresAtMs: requestedAtMs + this.joinApprovalTimeoutMs,
      timeoutMs: this.joinApprovalTimeoutMs,
    });
    state.pendingJoinRequestId = pending.joinRequestId;
    state.pendingJoinRequestedAtMs = requestedAtMs;
    state.pendingJoinExpiresAtMs = pending.expiresAtMs;
    state.authTimer = setTimeout(() => {
      this.rejectAuthentication(
        state,
        'JOIN_TIMEOUT',
        'The host did not confirm this join request in time.',
      );
    }, this.joinApprovalTimeoutMs);
    void state.sender
      .sendRaw(json(pending))
      .then(() => {
        const request = this.pendingJoinForState(state);
        if (request !== undefined) {
          this.pendingJoinListeners.forEach((listener) => listener(structuredClone(request)));
        }
      })
      .catch(() => this.removeConnection(state));
  }

  private async acceptAuthenticatedConnection(state: ConnectionState): Promise<void> {
    if (
      state.closing ||
      state.clientId === undefined ||
      state.displayName === undefined ||
      state.socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    const reconnectToken = this.nonceFactory();
    const presence = this.engine.updatePresence({
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      sessionId: this.engine.sessionId,
      documentId: this.engine.documentId,
      clientId: state.clientId,
      sequence: 0,
      displayName: collaborationDisplayNameSchema.parse(state.displayName),
      selectedElementIds: [],
    });
    if (state.authTimer !== undefined) clearTimeout(state.authTimer);
    state.authTimer = undefined;
    state.pendingJoinRequestId = undefined;
    state.pendingJoinRequestedAtMs = undefined;
    state.pendingJoinExpiresAtMs = undefined;
    state.authenticated = true;
    state.operationalReady = false;
    this.storeReconnectGrant({
      clientId: state.clientId,
      displayName: state.displayName,
      token: reconnectToken,
      expiresAtMs: this.clock() + this.reconnectGrantTtlMs,
    });
    try {
      await state.sender.sendRaw(
        json({
          type: 'auth.accepted',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          sessionId: this.engine.sessionId,
          ...(this.hostClientId === undefined ? {} : { hostClientId: this.hostClientId }),
          clientId: state.clientId,
          sessionSeq: this.engine.sessionSeq,
          revision: this.engine.revision,
          reconnectToken,
        }),
      );
      const snapshotSend = state.sender.sendLogical({
        type: 'presence.snapshot',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        participants: this.engine.listPresence(),
      });
      // The snapshot is now synchronously ahead of every future broadcast in the
      // bounded sender queue. Mark the peer ready before it can receive that snapshot
      // and immediately submit its first operational request.
      state.operationalReady = true;
      await snapshotSend;
      if (
        this.connections.get(state.socket) !== state ||
        state.closing ||
        state.socket.readyState !== WebSocket.OPEN
      ) {
        throw new CollaborationError(
          'INVALID_REQUEST',
          'The approved peer disconnected during authentication bootstrap.',
        );
      }
    } catch (error) {
      this.removeConnection(state);
      throw error;
    }
    this.broadcast(
      {
        type: 'presence.changed',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        payload: presence,
      },
      state,
    );
    this.participantListeners.forEach((listener) => listener());
  }

  private async handleRequest(
    state: ConnectionState,
    message: ClientRequestMessage,
  ): Promise<void> {
    if ('clientId' in message.payload && message.payload.clientId !== state.clientId) {
      await this.sendRequestError(
        state,
        message.requestId,
        'CLIENT_MISMATCH',
        'Client identity mismatch.',
      );
      return;
    }
    if (message.type === 'presence.update' && message.payload.displayName !== state.displayName) {
      await this.sendRequestError(
        state,
        message.requestId,
        'CLIENT_MISMATCH',
        'Approved display name mismatch.',
      );
      return;
    }
    try {
      switch (message.type) {
        case 'command.submit': {
          const transaction = await this.submitAndBroadcast(message.payload as CommandBatchRequest);
          await state.sender.sendLogical({
            type: 'command.result',
            protocolVersion: COLLABORATION_PROTOCOL_VERSION,
            requestId: message.requestId,
            payload: transaction,
          });
          break;
        }
        case 'resync.request': {
          const result = this.engine.getResync(message.payload as ResyncRequest);
          await state.sender.sendLogical({
            type: 'resync.result',
            protocolVersion: COLLABORATION_PROTOCOL_VERSION,
            requestId: message.requestId,
            payload: result,
          });
          break;
        }
        case 'presence.update': {
          const result = this.engine.updatePresence(message.payload as PresenceUpdate);
          await state.sender.sendLogical({
            type: 'presence.result',
            protocolVersion: COLLABORATION_PROTOCOL_VERSION,
            requestId: message.requestId,
            payload: result,
          });
          this.broadcast({
            type: 'presence.changed',
            protocolVersion: COLLABORATION_PROTOCOL_VERSION,
            payload: result,
          });
          break;
        }
        case 'lease.acquire': {
          const result = this.engine.acquireTextLease(message.payload as AcquireTextLeaseRequest);
          await this.sendLeaseResult(state, message.requestId, result);
          break;
        }
        case 'lease.renew': {
          const result = this.engine.renewTextLease(message.payload as RenewTextLeaseRequest);
          await this.sendLeaseResult(state, message.requestId, result);
          break;
        }
        case 'lease.release': {
          const released = this.engine.releaseTextLease(message.payload as ReleaseTextLeaseRequest);
          await state.sender.sendLogical({
            type: 'lease.release.result',
            protocolVersion: COLLABORATION_PROTOCOL_VERSION,
            requestId: message.requestId,
            released,
          });
          break;
        }
      }
    } catch (error) {
      const code =
        error instanceof CollaborationError
          ? error.code
          : typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              typeof error.code === 'string'
            ? error.code
            : 'REQUEST_FAILED';
      const messageText = error instanceof Error ? error.message : 'Request failed.';
      try {
        await this.sendRequestError(
          state,
          message.requestId,
          code,
          messageText,
          error instanceof CollaborationError ? error.details : undefined,
        );
      } catch {
        this.removeConnection(state);
      }
    }
  }

  private async sendLeaseResult(
    state: ConnectionState,
    requestId: string,
    payload: unknown,
  ): Promise<void> {
    await state.sender.sendLogical({
      type: 'lease.result',
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      requestId,
      payload,
    });
  }

  private async sendRequestError(
    state: ConnectionState,
    requestId: string,
    code: string,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const safeDetails =
      details === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(details).filter(
              (entry): entry is [string, string | number | boolean | null] =>
                entry[1] === null ||
                typeof entry[1] === 'string' ||
                (typeof entry[1] === 'number' && Number.isFinite(entry[1])) ||
                typeof entry[1] === 'boolean',
            ),
          );
    await state.sender.sendLogical({
      type: 'request.error',
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      requestId,
      code: code.slice(0, 64),
      message: message.slice(0, 500),
      ...(safeDetails === undefined ? {} : { details: safeDetails }),
    });
  }

  private broadcast(message: unknown, excludedState?: ConnectionState): void {
    this.connections.forEach((state) => {
      if (
        state !== excludedState &&
        state.authenticated &&
        state.operationalReady &&
        state.socket.readyState === WebSocket.OPEN
      ) {
        void state.sender.sendLogical(message).catch(() => this.removeConnection(state));
      }
    });
  }

  private consumeRateToken(state: ConnectionState): boolean {
    const now = this.clock();
    if (now - state.windowStartedAtMs >= this.rateWindowMs) {
      state.windowStartedAtMs = now;
      state.messageCount = 0;
    }
    state.messageCount += 1;
    return state.messageCount <= this.maxMessagesPerWindow;
  }

  private rejectAuthentication(
    state: ConnectionState,
    code:
      | 'AUTH_FAILED'
      | 'AUTH_EXPIRED'
      | 'AUTH_REPLAY'
      | 'CLIENT_ID_IN_USE'
      | 'INVITATION_EXPIRED'
      | 'JOIN_REJECTED'
      | 'JOIN_TIMEOUT'
      | 'PEER_LIMIT'
      | 'PROTOCOL_ERROR',
    message: string,
  ): void {
    if (state.closing) return;
    state.closing = true;
    if (state.authTimer !== undefined) clearTimeout(state.authTimer);
    state.authTimer = undefined;
    if (state.socket.readyState === WebSocket.OPEN) {
      void state.sender
        .sendRaw(
          json({
            type: 'auth.rejected',
            protocolVersion: COLLABORATION_PROTOCOL_VERSION,
            code,
            message,
          }),
        )
        .finally(() => {
          if (state.socket.readyState !== WebSocket.CLOSED) state.socket.close(1008, code);
        })
        .catch(() => this.removeConnection(state));
    }
  }

  private removeConnection(state: ConnectionState): void {
    if (state.authTimer !== undefined) clearTimeout(state.authTimer);
    state.sender.dispose();
    state.reassembler.dispose();
    const clientId = state.clientId;
    state.authenticated = false;
    state.operationalReady = false;
    state.closing = true;
    state.clientId = undefined;
    state.displayName = undefined;
    state.pendingJoinRequestId = undefined;
    state.pendingJoinRequestedAtMs = undefined;
    state.pendingJoinExpiresAtMs = undefined;
    this.connections.delete(state.socket);
    if (
      clientId !== undefined &&
      ![...this.connections.values()].some(
        (candidate) => candidate.authenticated && candidate.clientId === clientId,
      )
    ) {
      const removed = this.engine.removePresence(clientId);
      this.engine.releaseTextLeasesForClient(clientId);
      if (removed) {
        this.broadcast({
          type: 'presence.removed',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          clientId,
        });
        this.participantListeners.forEach((listener) => listener());
      }
    }
    if (state.socket.readyState !== WebSocket.CLOSED) state.socket.terminate();
  }

  private closeProtocolPeer(state: ConnectionState, reason: string): void {
    if (state.closing) return;
    state.closing = true;
    state.authenticated = false;
    state.operationalReady = false;
    state.sender.dispose();
    state.reassembler.dispose();
    if (state.socket.readyState === WebSocket.OPEN) state.socket.close(1008, reason.slice(0, 123));
    const timer = setTimeout(() => {
      if (state.socket.readyState !== WebSocket.CLOSED) state.socket.terminate();
    }, 100);
    timer.unref?.();
  }

  private purgeReplayNonces(): void {
    const now = this.clock();
    this.replayNonces.forEach((expiresAtMs, key) => {
      if (expiresAtMs <= now) this.replayNonces.delete(key);
    });
  }

  private pendingJoinForState(state: ConnectionState): PendingJoinRequest | undefined {
    if (
      state.authenticated ||
      state.closing ||
      state.pendingJoinRequestId === undefined ||
      state.pendingJoinRequestedAtMs === undefined ||
      state.pendingJoinExpiresAtMs === undefined ||
      state.clientId === undefined ||
      state.displayName === undefined
    ) {
      return undefined;
    }
    return {
      joinRequestId: state.pendingJoinRequestId,
      clientId: state.clientId,
      displayName: state.displayName,
      requestedAtMs: state.pendingJoinRequestedAtMs,
      expiresAtMs: state.pendingJoinExpiresAtMs,
    };
  }

  private purgeExpiredPendingJoins(): void {
    const now = this.clock();
    this.connections.forEach((state) => {
      if ((state.pendingJoinExpiresAtMs ?? Number.POSITIVE_INFINITY) <= now) {
        this.rejectAuthentication(
          state,
          'JOIN_TIMEOUT',
          'The host did not confirm this join request in time.',
        );
      }
    });
  }

  private purgeReconnectGrants(): void {
    const now = this.clock();
    this.reconnectGrants.forEach((grant, clientId) => {
      if (grant.expiresAtMs <= now) this.reconnectGrants.delete(clientId);
    });
  }

  private storeReconnectGrant(grant: ReconnectGrant): void {
    this.purgeReconnectGrants();
    const capacity = Math.max(1, Math.min(this.maxPeers * 4, 256));
    if (!this.reconnectGrants.has(grant.clientId) && this.reconnectGrants.size >= capacity) {
      const oldest = [...this.reconnectGrants.values()].sort(
        (left, right) => left.expiresAtMs - right.expiresAtMs,
      )[0];
      if (oldest !== undefined) this.reconnectGrants.delete(oldest.clientId);
    }
    this.reconnectGrants.set(grant.clientId, grant);
  }
}
