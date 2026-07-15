import { createServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';

import WebSocket, { WebSocketServer } from 'ws';

import {
  COLLABORATION_PROTOCOL_VERSION,
  type AcquireTextLeaseRequest,
  type CommandBatchRequest,
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
  authChallengeSchema,
  authResponseSchema,
  clientRequestMessageSchema,
  manualInvitationSchema,
  type AuthChallenge,
  type ClientRequestMessage,
  type ManualInvitation,
} from './protocol.js';

export interface CollaborationTransportServerOptions {
  readonly engine: AuthoritativeSessionHost;
  readonly documentSecret: Uint8Array;
  readonly bindHost?: string;
  readonly advertisedHost?: string;
  readonly port?: number;
  readonly maxPayloadBytes?: number;
  readonly maxPeers?: number;
  readonly maxMessagesPerWindow?: number;
  readonly rateWindowMs?: number;
  readonly authTimeoutMs?: number;
  readonly invitationTtlMs?: number;
  readonly clock?: () => number;
  readonly idFactory?: () => string;
  readonly nonceFactory?: () => string;
}

interface ConnectionState {
  readonly socket: WebSocket;
  readonly challenge: AuthChallenge;
  authTimer: ReturnType<typeof setTimeout> | undefined;
  authenticated: boolean;
  clientId: string | undefined;
  windowStartedAtMs: number;
  messageCount: number;
}

const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_MAX_PEERS = 8;
const DEFAULT_RATE_LIMIT = 60;
const DEFAULT_RATE_WINDOW_MS = 1_000;
const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const DEFAULT_INVITATION_TTL_MS = 12 * 60 * 60 * 1_000;

const json = (value: unknown): string => JSON.stringify(value);

export class CollaborationTransportServer {
  private readonly engine: AuthoritativeSessionHost;
  private readonly documentSecret: Buffer;
  private readonly bindHost: string;
  private readonly advertisedHost: string;
  private readonly requestedPort: number;
  private readonly maxPayloadBytes: number;
  private readonly maxPeers: number;
  private readonly maxMessagesPerWindow: number;
  private readonly rateWindowMs: number;
  private readonly authTimeoutMs: number;
  private readonly invitationTtlMs: number;
  private readonly clock: () => number;
  private readonly idFactory: () => string;
  private readonly nonceFactory: () => string;
  private readonly connections = new Map<WebSocket, ConnectionState>();
  private readonly replayNonces = new Map<string, number>();
  private httpsServer: HttpsServer | undefined;
  private webSocketServer: WebSocketServer | undefined;
  private invitation: ManualInvitation | undefined;
  private startPromise: Promise<ManualInvitation> | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;

  public constructor(options: CollaborationTransportServerOptions) {
    this.engine = options.engine;
    this.documentSecret = normalizeDocumentSecret(options.documentSecret);
    this.bindHost = options.bindHost ?? '127.0.0.1';
    this.advertisedHost = options.advertisedHost ?? this.bindHost;
    this.requestedPort = options.port ?? 0;
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.maxPeers = options.maxPeers ?? DEFAULT_MAX_PEERS;
    this.maxMessagesPerWindow = options.maxMessagesPerWindow ?? DEFAULT_RATE_LIMIT;
    this.rateWindowMs = options.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS;
    this.authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
    this.invitationTtlMs = options.invitationTtlMs ?? DEFAULT_INVITATION_TTL_MS;
    this.clock = options.clock ?? (() => Date.now());
    this.idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
    this.nonceFactory = options.nonceFactory ?? createNonce;
    if (
      ![
        this.maxPayloadBytes,
        this.maxPeers,
        this.maxMessagesPerWindow,
        this.rateWindowMs,
        this.authTimeoutMs,
        this.invitationTtlMs,
      ].every((value) => Number.isSafeInteger(value) && value > 0) ||
      !Number.isSafeInteger(this.requestedPort) ||
      this.requestedPort < 0 ||
      this.requestedPort > 65_535
    ) {
      throw new CollaborationError(
        'INVALID_REQUEST',
        'Transport limits and timeouts must be positive safe integers and the port must be valid.',
      );
    }
  }

  public get authenticatedPeerCount(): number {
    return [...this.connections.values()].filter((state) => state.authenticated).length;
  }

  public get connectionCount(): number {
    return this.connections.size;
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
      this.acceptConnection(socket, request.url ?? '', certificate.fingerprint);
    });
    webSocketServer.on('error', () => undefined);
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

  private async closeInternal(): Promise<void> {
    await this.startPromise?.catch(() => undefined);
    const webSocketServer = this.webSocketServer;
    const httpsServer = this.httpsServer;
    this.webSocketServer = undefined;
    this.httpsServer = undefined;
    this.invitation = undefined;

    this.connections.forEach((state) => {
      if (state.authTimer !== undefined) clearTimeout(state.authTimer);
      state.socket.close(1001, 'Server shutdown');
      state.socket.terminate();
    });
    this.connections.clear();
    if (webSocketServer !== undefined) {
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
    }
    if (httpsServer !== undefined) {
      await new Promise<void>((resolve) => httpsServer.close(() => resolve()));
    }
    this.replayNonces.clear();
    this.documentSecret.fill(0);
  }

  private acceptConnection(socket: WebSocket, requestUrl: string, fingerprint: string): void {
    const expectedPath = `/v1/session/${this.engine.sessionId}`;
    if (requestUrl !== expectedPath) {
      socket.close(1008, 'Invalid session path');
      return;
    }
    if (this.connections.size >= this.maxPeers) {
      socket.send(
        json({
          type: 'auth.rejected',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          code: 'PEER_LIMIT',
          message: 'The collaboration session reached its peer limit.',
        }),
      );
      socket.close(1013, 'Peer limit');
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
    const state: ConnectionState = {
      socket,
      challenge,
      authTimer: undefined,
      authenticated: false,
      clientId: undefined,
      windowStartedAtMs: this.clock(),
      messageCount: 0,
    };
    state.authTimer = setTimeout(() => {
      this.rejectAuthentication(state, 'AUTH_EXPIRED', 'Authentication timed out.');
    }, this.authTimeoutMs);
    this.connections.set(socket, state);
    socket.on('message', (data, isBinary) => this.receive(state, data, isBinary));
    socket.on('close', () => this.removeConnection(state));
    socket.on('error', () => this.removeConnection(state));
    socket.send(json(challenge));
  }

  private receive(state: ConnectionState, data: WebSocket.RawData, isBinary: boolean): void {
    if (isBinary || !this.consumeRateToken(state)) {
      state.socket.close(1008, isBinary ? 'Text frames only' : 'Rate limit');
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      state.socket.close(1008, 'Malformed JSON');
      return;
    }

    if (!state.authenticated) {
      this.authenticate(state, raw);
      return;
    }
    let message: ClientRequestMessage;
    try {
      message = clientRequestMessageSchema.parse(raw);
    } catch {
      state.socket.close(1008, 'Malformed protocol message');
      return;
    }
    this.handleRequest(state, message);
  }

  private authenticate(state: ConnectionState, raw: unknown): void {
    let response;
    try {
      response = authResponseSchema.parse(raw);
    } catch {
      this.rejectAuthentication(state, 'PROTOCOL_ERROR', 'Malformed authentication response.');
      return;
    }
    const challenge = state.challenge;
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
      clientNonce: response.clientNonce,
      expiresAtMs: challenge.expiresAtMs,
    });
    if (!constantTimeEqual(response.proof, expectedProof)) {
      this.rejectAuthentication(state, 'AUTH_FAILED', 'Authentication proof is invalid.');
      return;
    }

    state.authenticated = true;
    state.clientId = response.clientId;
    state.messageCount = 0;
    state.windowStartedAtMs = this.clock();
    if (state.authTimer !== undefined) clearTimeout(state.authTimer);
    state.authTimer = undefined;
    this.replayNonces.set(replayKey, challenge.expiresAtMs);
    state.socket.send(
      json({
        type: 'auth.accepted',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        sessionId: this.engine.sessionId,
        clientId: response.clientId,
        sessionSeq: this.engine.sessionSeq,
        revision: this.engine.revision,
      }),
    );
  }

  private handleRequest(state: ConnectionState, message: ClientRequestMessage): void {
    if ('clientId' in message.payload && message.payload.clientId !== state.clientId) {
      this.sendRequestError(
        state,
        message.requestId,
        'CLIENT_MISMATCH',
        'Client identity mismatch.',
      );
      return;
    }
    try {
      switch (message.type) {
        case 'command.submit': {
          const transaction = this.engine.submit(message.payload as CommandBatchRequest);
          state.socket.send(
            json({
              type: 'command.result',
              protocolVersion: COLLABORATION_PROTOCOL_VERSION,
              requestId: message.requestId,
              payload: transaction,
            }),
          );
          this.broadcast({
            type: 'transaction.committed',
            protocolVersion: COLLABORATION_PROTOCOL_VERSION,
            payload: transaction,
          });
          break;
        }
        case 'resync.request': {
          const result = this.engine.getResync(message.payload as ResyncRequest);
          state.socket.send(
            json({
              type: 'resync.result',
              protocolVersion: COLLABORATION_PROTOCOL_VERSION,
              requestId: message.requestId,
              payload: result,
            }),
          );
          break;
        }
        case 'presence.update': {
          const result = this.engine.updatePresence(message.payload as PresenceUpdate);
          state.socket.send(
            json({
              type: 'presence.result',
              protocolVersion: COLLABORATION_PROTOCOL_VERSION,
              requestId: message.requestId,
              payload: result,
            }),
          );
          this.broadcast({
            type: 'presence.changed',
            protocolVersion: COLLABORATION_PROTOCOL_VERSION,
            payload: result,
          });
          break;
        }
        case 'lease.acquire': {
          const result = this.engine.acquireTextLease(message.payload as AcquireTextLeaseRequest);
          this.sendLeaseResult(state, message.requestId, result);
          break;
        }
        case 'lease.renew': {
          const result = this.engine.renewTextLease(message.payload as RenewTextLeaseRequest);
          this.sendLeaseResult(state, message.requestId, result);
          break;
        }
        case 'lease.release': {
          const released = this.engine.releaseTextLease(message.payload as ReleaseTextLeaseRequest);
          state.socket.send(
            json({
              type: 'lease.release.result',
              protocolVersion: COLLABORATION_PROTOCOL_VERSION,
              requestId: message.requestId,
              released,
            }),
          );
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
      this.sendRequestError(state, message.requestId, code, messageText);
    }
  }

  private sendLeaseResult(state: ConnectionState, requestId: string, payload: unknown): void {
    state.socket.send(
      json({
        type: 'lease.result',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        requestId,
        payload,
      }),
    );
  }

  private sendRequestError(
    state: ConnectionState,
    requestId: string,
    code: string,
    message: string,
  ): void {
    state.socket.send(
      json({
        type: 'request.error',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        requestId,
        code: code.slice(0, 64),
        message: message.slice(0, 500),
      }),
    );
  }

  private broadcast(message: unknown): void {
    const encoded = json(message);
    this.connections.forEach((state) => {
      if (state.authenticated && state.socket.readyState === WebSocket.OPEN) {
        state.socket.send(encoded);
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
    code: 'AUTH_FAILED' | 'AUTH_EXPIRED' | 'AUTH_REPLAY' | 'PROTOCOL_ERROR',
    message: string,
  ): void {
    if (state.socket.readyState === WebSocket.OPEN) {
      state.socket.send(
        json({
          type: 'auth.rejected',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          code,
          message,
        }),
      );
      state.socket.close(1008, code);
    }
  }

  private removeConnection(state: ConnectionState): void {
    if (state.authTimer !== undefined) clearTimeout(state.authTimer);
    this.connections.delete(state.socket);
    if (state.clientId !== undefined) this.engine.removePresence(state.clientId);
  }

  private purgeReplayNonces(): void {
    const now = this.clock();
    this.replayNonces.forEach((expiresAtMs, key) => {
      if (expiresAtMs <= now) this.replayNonces.delete(key);
    });
  }
}
