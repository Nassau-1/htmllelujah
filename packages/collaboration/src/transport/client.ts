import type { TLSSocket } from 'node:tls';

import WebSocket from 'ws';

import {
  acquireTextLeaseRequestSchema,
  COLLABORATION_PROTOCOL_VERSION,
  commandBatchRequestSchema,
  committedTransactionSchema,
  presenceRecordSchema,
  presenceUpdateSchema,
  releaseTextLeaseRequestSchema,
  renewTextLeaseRequestSchema,
  resyncRequestSchema,
  resyncResponseSchema,
  textLeaseSchema,
  type AcquireTextLeaseRequest,
  type CommandBatchRequest,
  type CommittedTransaction,
  type PresenceRecord,
  type PresenceUpdate,
  type ReleaseTextLeaseRequest,
  type RenewTextLeaseRequest,
  type ResyncRequest,
  type ResyncResponse,
  type TextLease,
} from '../contracts.js';
import { CollaborationError } from '../errors.js';
import {
  constantTimeEqual,
  createAuthProof,
  createNonce,
  fingerprintBytes,
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
  TransportFramingError,
} from './framing.js';
import {
  authAcceptedSchema,
  authChallengeSchema,
  authPendingSchema,
  authRejectedSchema,
  collaborationDisplayNameSchema,
  commandResultMessageSchema,
  manualInvitationSchema,
  presenceBroadcastSchema,
  presenceRemovedBroadcastSchema,
  presenceSnapshotSchema,
  presenceResultMessageSchema,
  requestErrorMessageSchema,
  resyncResultMessageSchema,
  serverMessageSchema,
  transactionBroadcastSchema,
  type ManualInvitation,
  type ServerMessage,
} from './protocol.js';

export interface CollaborationTransportClientOptions {
  readonly invitation: ManualInvitation;
  readonly documentId: string;
  readonly clientId: string;
  readonly displayName: string;
  readonly documentSecret: Uint8Array;
  readonly maxPayloadBytes?: number;
  readonly maxLogicalPayloadBytes?: number;
  readonly maxReassemblyBytes?: number;
  readonly maxConcurrentTransfers?: number;
  readonly chunkTimeoutMs?: number;
  readonly maxBufferedBytes?: number;
  readonly maxQueuedBytes?: number;
  readonly sendTimeoutMs?: number;
  readonly authTimeoutMs?: number;
  readonly joinApprovalTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxPendingRequests?: number;
  readonly clock?: () => number;
  readonly idFactory?: () => string;
  readonly nonceFactory?: () => string;
}

interface PendingRequest {
  readonly expectedType: ServerMessage['type'];
  readonly resolve: (message: ServerMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class RemoteTransportError extends Error {
  public readonly code: string;
  public readonly details: Readonly<Record<string, string | number | boolean | null>> | undefined;

  public constructor(
    code: string,
    message: string,
    details?: Readonly<Record<string, string | number | boolean | null>>,
  ) {
    super(message);
    this.name = 'RemoteTransportError';
    this.code = code;
    this.details = details;
  }
}

const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PENDING_REQUESTS = 128;

export class CollaborationTransportClient {
  private readonly invitation: ManualInvitation;
  private readonly documentId: string;
  private readonly clientId: string;
  private readonly displayName: string;
  private readonly documentSecret: Buffer;
  private readonly maxPayloadBytes: number;
  private readonly maxLogicalPayloadBytes: number;
  private readonly maxReassemblyBytes: number;
  private readonly maxConcurrentTransfers: number;
  private readonly chunkTimeoutMs: number;
  private readonly maxBufferedBytes: number;
  private readonly maxQueuedBytes: number;
  private readonly sendTimeoutMs: number;
  private readonly authTimeoutMs: number;
  private readonly joinApprovalTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxPendingRequests: number;
  private readonly clock: () => number;
  private readonly idFactory: () => string;
  private readonly nonceFactory: () => string;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly transactionListeners = new Set<(transaction: CommittedTransaction) => void>();
  private readonly presenceListeners = new Set<(presence: PresenceRecord) => void>();
  private readonly presenceRemovedListeners = new Set<(clientId: string) => void>();
  private readonly disconnectListeners = new Set<(error: RemoteTransportError) => void>();
  private readonly participants = new Map<string, PresenceRecord>();
  private socket: WebSocket | undefined;
  private connectionPromise: Promise<void> | undefined;
  private connectionResolve: (() => void) | undefined;
  private connectionReject: ((error: Error) => void) | undefined;
  private authTimer: ReturnType<typeof setTimeout> | undefined;
  private certificateVerified = false;
  private challengeAnswered = false;
  private authenticated = false;
  private authAcceptedReceived = false;
  private presenceReady = false;
  private clientNonce = '';
  private reconnectToken: string | undefined;
  private hostClientId: string | undefined;
  private sender: BoundedSender | undefined;
  private reassembler: ChunkReassembler | undefined;

  public constructor(options: CollaborationTransportClientOptions) {
    this.invitation = manualInvitationSchema.parse(options.invitation);
    this.documentId = options.documentId;
    this.clientId = options.clientId;
    this.displayName = collaborationDisplayNameSchema.parse(options.displayName);
    this.documentSecret = normalizeDocumentSecret(options.documentSecret);
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
    this.authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
    this.joinApprovalTimeoutMs = options.joinApprovalTimeoutMs ?? 65_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxPendingRequests = options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS;
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
        this.authTimeoutMs,
        this.joinApprovalTimeoutMs,
        this.requestTimeoutMs,
        this.maxPendingRequests,
      ].every((value) => Number.isSafeInteger(value) && value > 0)
    ) {
      throw new CollaborationError(
        'INVALID_REQUEST',
        'Client payload and timeout limits must be positive safe integers.',
      );
    }
  }

  public get isConnected(): boolean {
    return this.authenticated && this.presenceReady && this.socket?.readyState === WebSocket.OPEN;
  }
  public get authoritativeHostClientId(): string | undefined {
    return this.hostClientId;
  }

  public connect(): Promise<void> {
    if (this.isConnected) return Promise.resolve();
    if (this.connectionPromise !== undefined) return this.connectionPromise;
    if (this.invitation.expiresAtMs <= this.clock()) {
      return Promise.reject(new RemoteTransportError('INVITATION_EXPIRED', 'Invitation expired.'));
    }

    this.certificateVerified = false;
    this.challengeAnswered = false;
    this.authenticated = false;
    this.authAcceptedReceived = false;
    this.presenceReady = false;
    this.clientNonce = this.nonceFactory();
    const formattedHost = this.invitation.host.includes(':')
      ? `[${this.invitation.host}]`
      : this.invitation.host;
    const url = `wss://${formattedHost}:${this.invitation.port}/v1/session/${this.invitation.sessionId}`;
    const socket = new WebSocket(url, {
      // lgtm[js/disabling-certificate-validation] The host uses an ephemeral self-signed
      // certificate. Its out-of-band SHA-256 invitation pin is checked in constant time on the
      // upgrade event below, before any authentication challenge or application frame is trusted.
      rejectUnauthorized: false,
      perMessageDeflate: false,
      maxPayload: this.maxPayloadBytes,
    });
    this.socket = socket;
    this.sender = new BoundedSender(socket, {
      stream: 'client',
      secret: this.documentSecret,
      idFactory: this.idFactory,
      maxFrameBytes: this.maxPayloadBytes,
      maxLogicalPayloadBytes: this.maxLogicalPayloadBytes,
      maxBufferedBytes: this.maxBufferedBytes,
      maxQueuedBytes: this.maxQueuedBytes,
      sendTimeoutMs: this.sendTimeoutMs,
    });
    this.reassembler = new ChunkReassembler({
      stream: 'server',
      secret: this.documentSecret,
      maxFrameBytes: this.maxPayloadBytes,
      maxLogicalPayloadBytes: this.maxLogicalPayloadBytes,
      maxReassemblyBytes: this.maxReassemblyBytes,
      maxConcurrentTransfers: this.maxConcurrentTransfers,
      chunkTimeoutMs: this.chunkTimeoutMs,
      clock: this.clock,
      onTimeout: (error) => this.failFraming(error),
    });
    this.connectionPromise = new Promise<void>((resolve, reject) => {
      this.connectionResolve = resolve;
      this.connectionReject = reject;
    });
    this.authTimer = setTimeout(() => {
      this.failConnection(new RemoteTransportError('AUTH_TIMEOUT', 'Authentication timed out.'));
    }, this.authTimeoutMs);

    socket.on('upgrade', (response) => {
      const tlsSocket = response.socket as TLSSocket;
      const peer = tlsSocket.getPeerCertificate(true);
      if (peer.raw === undefined) {
        this.failConnection(
          new RemoteTransportError('FINGERPRINT_MISMATCH', 'No TLS certificate.'),
        );
        return;
      }
      const actualFingerprint = fingerprintBytes(peer.raw);
      const expectedValue = this.invitation.certificateFingerprint.slice('sha256-'.length);
      const actualValue = actualFingerprint.slice('sha256-'.length);
      if (!constantTimeEqual(expectedValue, actualValue)) {
        this.failConnection(
          new RemoteTransportError('FINGERPRINT_MISMATCH', 'TLS certificate fingerprint mismatch.'),
        );
        return;
      }
      this.certificateVerified = true;
    });
    socket.on('message', (data, isBinary) => this.receive(data, isBinary));
    socket.on('error', (error) => this.failConnection(error));
    socket.on('close', () => this.handleClose());
    return this.connectionPromise;
  }

  public async close(): Promise<void> {
    const socket = this.socket;
    if (socket === undefined) return;
    if (socket.readyState === WebSocket.CLOSED) {
      this.handleClose();
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        socket.terminate();
        resolve();
      }, 1_000);
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.close(1000, 'Client shutdown');
    });
  }

  public onTransaction(listener: (transaction: CommittedTransaction) => void): () => void {
    this.transactionListeners.add(listener);
    return () => this.transactionListeners.delete(listener);
  }

  public onPresence(listener: (presence: PresenceRecord) => void): () => void {
    this.presenceListeners.add(listener);
    return () => this.presenceListeners.delete(listener);
  }

  public onPresenceRemoved(listener: (clientId: string) => void): () => void {
    this.presenceRemovedListeners.add(listener);
    return () => this.presenceRemovedListeners.delete(listener);
  }

  public listPresence(): readonly PresenceRecord[] {
    return [...this.participants.values()]
      .sort((left, right) => left.clientId.localeCompare(right.clientId))
      .map((presence) => structuredClone(presence));
  }

  public onDisconnect(listener: (error: RemoteTransportError) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  public async submit(request: CommandBatchRequest): Promise<CommittedTransaction> {
    const payload = commandBatchRequestSchema.parse(request);
    const response = await this.sendRequest(
      {
        type: 'command.submit',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        requestId: payload.clientRequestId,
        payload,
      },
      'command.result',
    );
    return committedTransactionSchema.parse(commandResultMessageSchema.parse(response).payload);
  }

  public async getResync(request: ResyncRequest): Promise<ResyncResponse> {
    const response = await this.sendRequest(
      {
        type: 'resync.request',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        requestId: this.idFactory(),
        payload: resyncRequestSchema.parse(request),
      },
      'resync.result',
    );
    return resyncResponseSchema.parse(resyncResultMessageSchema.parse(response).payload);
  }

  public async updatePresence(update: PresenceUpdate): Promise<PresenceRecord> {
    const response = await this.sendRequest(
      {
        type: 'presence.update',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        requestId: this.idFactory(),
        payload: presenceUpdateSchema.parse(update),
      },
      'presence.result',
    );
    const presence = presenceRecordSchema.parse(
      presenceResultMessageSchema.parse(response).payload,
    );
    this.participants.set(presence.clientId, structuredClone(presence));
    return presence;
  }

  public async acquireTextLease(request: AcquireTextLeaseRequest): Promise<TextLease> {
    const response = await this.sendRequest(
      {
        type: 'lease.acquire',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        requestId: this.idFactory(),
        payload: acquireTextLeaseRequestSchema.parse(request),
      },
      'lease.result',
    );
    return textLeaseSchema.parse(response.type === 'lease.result' ? response.payload : undefined);
  }

  public async renewTextLease(request: RenewTextLeaseRequest): Promise<TextLease> {
    const response = await this.sendRequest(
      {
        type: 'lease.renew',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        requestId: this.idFactory(),
        payload: renewTextLeaseRequestSchema.parse(request),
      },
      'lease.result',
    );
    return textLeaseSchema.parse(response.type === 'lease.result' ? response.payload : undefined);
  }

  public async releaseTextLease(request: ReleaseTextLeaseRequest): Promise<boolean> {
    const response = await this.sendRequest(
      {
        type: 'lease.release',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        requestId: this.idFactory(),
        payload: releaseTextLeaseRequestSchema.parse(request),
      },
      'lease.release.result',
    );
    return response.type === 'lease.release.result' && response.released;
  }

  private async sendRequest(
    message: Readonly<Record<string, unknown>>,
    expectedType: ServerMessage['type'],
  ): Promise<ServerMessage> {
    await this.connect();
    const requestId = String(message.requestId);
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN || !this.authenticated) {
      throw new RemoteTransportError('NOT_CONNECTED', 'Collaboration transport is not connected.');
    }
    if (this.pending.has(requestId)) {
      throw new RemoteTransportError('DUPLICATE_REQUEST', 'A request with this ID is pending.');
    }
    if (this.pending.size >= this.maxPendingRequests) {
      throw new RemoteTransportError(
        'BACKPRESSURE_LIMIT',
        'Too many collaboration requests are pending.',
      );
    }
    return new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new RemoteTransportError('REQUEST_TIMEOUT', 'Collaboration request timed out.'));
      }, this.requestTimeoutMs);
      this.pending.set(requestId, { expectedType, resolve, reject, timer });
      const sender = this.sender;
      if (sender === undefined) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new RemoteTransportError('NOT_CONNECTED', 'Transport sender is unavailable.'));
        return;
      }
      void sender.sendLogical(message).catch((error: unknown) => {
        const current = this.pending.get(requestId);
        if (current === undefined) return;
        clearTimeout(current.timer);
        this.pending.delete(requestId);
        if (error instanceof TransportFramingError && error.code === 'LOGICAL_PAYLOAD_TOO_LARGE') {
          current.reject(new RemoteTransportError(error.code, error.message));
          return;
        }
        current.reject(error instanceof Error ? error : new Error('Transport send failed.'));
        this.failConnection(error instanceof Error ? error : new Error('Transport send failed.'));
      });
    });
  }

  private receive(data: WebSocket.RawData, isBinary: boolean): void {
    if (isBinary) {
      this.failConnection(new RemoteTransportError('PROTOCOL_ERROR', 'Binary frame rejected.'));
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      this.failConnection(new RemoteTransportError('PROTOCOL_ERROR', 'Malformed server message.'));
      return;
    }

    let message: ServerMessage;
    if (!this.authenticated) {
      try {
        message = serverMessageSchema.parse(raw);
      } catch {
        this.failConnection(
          new RemoteTransportError('PROTOCOL_ERROR', 'Malformed authentication message.'),
        );
        return;
      }
    } else {
      try {
        const logical = this.reassembler?.accept(raw);
        if (logical === undefined) return;
        message = serverMessageSchema.parse(JSON.parse(logical));
      } catch (error) {
        this.failFraming(error);
        return;
      }
    }

    if (message.type === 'auth.challenge') {
      this.answerChallenge(authChallengeSchema.parse(message));
      return;
    }
    if (message.type === 'auth.pending') {
      const pending = authPendingSchema.parse(message);
      if (!this.certificateVerified || !this.challengeAnswered) {
        this.failConnection(
          new RemoteTransportError('AUTH_FAILED', 'Invalid join-approval response.'),
        );
        return;
      }
      if (this.authTimer !== undefined) clearTimeout(this.authTimer);
      const remainingMs = Math.min(this.joinApprovalTimeoutMs, pending.timeoutMs + 250);
      this.authTimer = setTimeout(() => {
        this.failConnection(
          new RemoteTransportError('JOIN_TIMEOUT', 'The host did not confirm this join request.'),
        );
      }, remainingMs);
      return;
    }
    if (message.type === 'auth.accepted') {
      const accepted = authAcceptedSchema.parse(message);
      if (
        !this.certificateVerified ||
        !this.challengeAnswered ||
        accepted.sessionId !== this.invitation.sessionId ||
        accepted.clientId !== this.clientId
      ) {
        this.failConnection(
          new RemoteTransportError('AUTH_FAILED', 'Authentication scope mismatch.'),
        );
        return;
      }
      this.authenticated = true;
      this.authAcceptedReceived = true;
      this.reconnectToken = accepted.reconnectToken;
      this.hostClientId = accepted.hostClientId;
      return;
    }
    if (message.type === 'auth.rejected') {
      const rejected = authRejectedSchema.parse(message);
      this.failConnection(new RemoteTransportError(rejected.code, rejected.message));
      return;
    }
    if (!this.authAcceptedReceived) {
      this.failConnection(
        new RemoteTransportError(
          'PROTOCOL_ERROR',
          'Operational data arrived before host approval.',
        ),
      );
      return;
    }
    if (!this.presenceReady && message.type !== 'presence.snapshot') {
      this.failConnection(
        new RemoteTransportError(
          'PROTOCOL_ERROR',
          'Operational data arrived before the initial presence snapshot.',
        ),
      );
      return;
    }

    if (message.type === 'transaction.committed') {
      const transaction = transactionBroadcastSchema.parse(message).payload;
      if (
        transaction.sessionId !== this.invitation.sessionId ||
        transaction.documentId !== this.documentId
      ) {
        this.failConnection(
          new RemoteTransportError('PROTOCOL_ERROR', 'Transaction scope mismatch.'),
        );
        return;
      }

      this.transactionListeners.forEach((listener) => listener(transaction));
      return;
    }
    if (message.type === 'presence.changed') {
      const presence = presenceBroadcastSchema.parse(message).payload;
      if (
        presence.sessionId !== this.invitation.sessionId ||
        presence.documentId !== this.documentId
      ) {
        this.failConnection(new RemoteTransportError('PROTOCOL_ERROR', 'Presence scope mismatch.'));
        return;
      }
      const current = this.participants.get(presence.clientId);
      if (current !== undefined && presence.sequence <= current.sequence) {
        return;
      }

      this.participants.set(presence.clientId, structuredClone(presence));
      this.presenceListeners.forEach((listener) => listener(presence));
      return;
    }
    if (message.type === 'presence.removed') {
      const removed = presenceRemovedBroadcastSchema.parse(message);
      this.participants.delete(removed.clientId);
      this.presenceRemovedListeners.forEach((listener) => listener(removed.clientId));
      return;
    }
    if (message.type === 'presence.snapshot') {
      if (!this.authAcceptedReceived) {
        this.failConnection(
          new RemoteTransportError('PROTOCOL_ERROR', 'Presence arrived before authentication.'),
        );
        return;
      }
      const snapshot = presenceSnapshotSchema.parse(message);
      const participantIds = snapshot.participants.map((presence) => presence.clientId);
      const self = snapshot.participants.find((presence) => presence.clientId === this.clientId);
      if (
        new Set(participantIds).size !== participantIds.length ||
        snapshot.participants.some(
          (presence) =>
            presence.sessionId !== this.invitation.sessionId ||
            presence.documentId !== this.documentId,
        ) ||
        self === undefined ||
        self.displayName !== this.displayName
      ) {
        this.failConnection(
          new RemoteTransportError(
            'PROTOCOL_ERROR',
            'The initial presence snapshot is incomplete or out of scope.',
          ),
        );
        return;
      }

      const nextIds = new Set(snapshot.participants.map((presence) => presence.clientId));
      this.participants.forEach((_presence, clientId) => {
        if (!nextIds.has(clientId)) this.participants.delete(clientId);
      });
      snapshot.participants.forEach((presence) => {
        const current = this.participants.get(presence.clientId);
        if (current === undefined || presence.sequence >= current.sequence) {
          this.participants.set(presence.clientId, structuredClone(presence));
        }
      });
      if (this.authTimer !== undefined) clearTimeout(this.authTimer);
      this.authTimer = undefined;
      this.presenceReady = true;
      this.connectionResolve?.();
      this.connectionResolve = undefined;
      this.connectionReject = undefined;
      return;
    }

    const requestId = 'requestId' in message ? message.requestId : undefined;
    if (requestId === undefined) return;
    const pending = this.pending.get(requestId);
    if (pending === undefined) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    if (message.type === 'request.error') {
      const remote = requestErrorMessageSchema.parse(message);
      pending.reject(new RemoteTransportError(remote.code, remote.message, remote.details));
      return;
    }
    if (message.type !== pending.expectedType) {
      pending.reject(new RemoteTransportError('PROTOCOL_ERROR', 'Unexpected response type.'));
      return;
    }
    pending.resolve(message);
  }

  private answerChallenge(challenge: ReturnType<typeof authChallengeSchema.parse>): void {
    if (this.challengeAnswered) {
      this.failConnection(
        new RemoteTransportError('PROTOCOL_ERROR', 'Duplicate authentication challenge.'),
      );
      return;
    }
    if (!this.certificateVerified) {
      this.failConnection(
        new RemoteTransportError('FINGERPRINT_MISMATCH', 'TLS certificate was not pinned.'),
      );
      return;
    }
    if (
      challenge.sessionId !== this.invitation.sessionId ||
      challenge.certificateFingerprint !== this.invitation.certificateFingerprint ||
      challenge.expiresAtMs <= this.clock()
    ) {
      this.failConnection(
        new RemoteTransportError('AUTH_FAILED', 'Invalid authentication challenge.'),
      );
      return;
    }
    const proof = createAuthProof(this.documentSecret, {
      sessionId: challenge.sessionId,
      documentId: this.documentId,
      certificateFingerprint: challenge.certificateFingerprint,
      challengeId: challenge.challengeId,
      serverNonce: challenge.serverNonce,
      clientId: this.clientId,
      displayName: this.displayName,
      clientNonce: this.clientNonce,
      ...(this.reconnectToken === undefined ? {} : { reconnectToken: this.reconnectToken }),
      expiresAtMs: challenge.expiresAtMs,
    });
    this.challengeAnswered = true;
    const response = JSON.stringify({
      type: 'auth.response',
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      sessionId: challenge.sessionId,
      documentId: this.documentId,
      challengeId: challenge.challengeId,
      clientId: this.clientId,
      displayName: this.displayName,
      clientNonce: this.clientNonce,
      ...(this.reconnectToken === undefined ? {} : { reconnectToken: this.reconnectToken }),
      proof,
    });
    const sender = this.sender;
    if (sender === undefined) {
      this.failConnection(new RemoteTransportError('NOT_CONNECTED', 'Transport sender missing.'));
      return;
    }
    void sender.sendRaw(response).catch((error: unknown) => {
      this.failConnection(
        error instanceof Error ? error : new Error('Authentication send failed.'),
      );
    });
  }

  private failFraming(error: unknown): void {
    const code =
      error instanceof TransportFramingError && error.code === 'LOGICAL_PAYLOAD_TOO_LARGE'
        ? 'LOGICAL_PAYLOAD_TOO_LARGE'
        : 'PROTOCOL_ERROR';
    this.failConnection(
      new RemoteTransportError(
        code,
        error instanceof Error ? error.message : 'Malformed chunked transport payload.',
      ),
    );
  }

  private failConnection(error: Error): void {
    if (this.authTimer !== undefined) clearTimeout(this.authTimer);
    this.authTimer = undefined;
    this.connectionReject?.(error);
    this.connectionResolve = undefined;
    this.connectionReject = undefined;
    this.pending.forEach((pending) => {
      clearTimeout(pending.timer);
      pending.reject(error);
    });
    this.pending.clear();
    const socket = this.socket;
    this.sender?.dispose();
    this.reassembler?.dispose();
    if (socket !== undefined && socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }

  private handleClose(): void {
    const error = new RemoteTransportError('CONNECTION_CLOSED', 'Collaboration connection closed.');
    const wasAuthenticated = this.authenticated;
    if (!this.authenticated) this.connectionReject?.(error);
    this.pending.forEach((pending) => {
      clearTimeout(pending.timer);
      pending.reject(error);
    });
    this.pending.clear();
    if (this.authTimer !== undefined) clearTimeout(this.authTimer);
    this.authTimer = undefined;
    this.authenticated = false;
    this.authAcceptedReceived = false;
    this.presenceReady = false;
    this.participants.clear();
    this.certificateVerified = false;
    this.challengeAnswered = false;
    this.socket = undefined;
    this.sender?.dispose();
    this.reassembler?.dispose();
    this.sender = undefined;
    this.reassembler = undefined;
    this.connectionPromise = undefined;
    this.connectionResolve = undefined;
    this.connectionReject = undefined;
    if (wasAuthenticated) this.disconnectListeners.forEach((listener) => listener(error));
  }
}
