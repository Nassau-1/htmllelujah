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
  authAcceptedSchema,
  authChallengeSchema,
  authRejectedSchema,
  commandResultMessageSchema,
  manualInvitationSchema,
  presenceBroadcastSchema,
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
  readonly documentSecret: Uint8Array;
  readonly maxPayloadBytes?: number;
  readonly authTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
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

  public constructor(code: string, message: string) {
    super(message);
    this.name = 'RemoteTransportError';
    this.code = code;
  }
}

const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class CollaborationTransportClient {
  private readonly invitation: ManualInvitation;
  private readonly documentId: string;
  private readonly clientId: string;
  private readonly documentSecret: Buffer;
  private readonly maxPayloadBytes: number;
  private readonly authTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly clock: () => number;
  private readonly idFactory: () => string;
  private readonly nonceFactory: () => string;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly transactionListeners = new Set<(transaction: CommittedTransaction) => void>();
  private readonly presenceListeners = new Set<(presence: PresenceRecord) => void>();
  private readonly disconnectListeners = new Set<(error: RemoteTransportError) => void>();
  private socket: WebSocket | undefined;
  private connectionPromise: Promise<void> | undefined;
  private connectionResolve: (() => void) | undefined;
  private connectionReject: ((error: Error) => void) | undefined;
  private authTimer: ReturnType<typeof setTimeout> | undefined;
  private certificateVerified = false;
  private challengeAnswered = false;
  private authenticated = false;
  private clientNonce = '';

  public constructor(options: CollaborationTransportClientOptions) {
    this.invitation = manualInvitationSchema.parse(options.invitation);
    this.documentId = options.documentId;
    this.clientId = options.clientId;
    this.documentSecret = normalizeDocumentSecret(options.documentSecret);
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.clock = options.clock ?? (() => Date.now());
    this.idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
    this.nonceFactory = options.nonceFactory ?? createNonce;
    if (
      ![this.maxPayloadBytes, this.authTimeoutMs, this.requestTimeoutMs].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    ) {
      throw new CollaborationError(
        'INVALID_REQUEST',
        'Client payload and timeout limits must be positive safe integers.',
      );
    }
  }

  public get isConnected(): boolean {
    return this.authenticated && this.socket?.readyState === WebSocket.OPEN;
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
    this.clientNonce = this.nonceFactory();
    const formattedHost = this.invitation.host.includes(':')
      ? `[${this.invitation.host}]`
      : this.invitation.host;
    const url = `wss://${formattedHost}:${this.invitation.port}/v1/session/${this.invitation.sessionId}`;
    const socket = new WebSocket(url, {
      rejectUnauthorized: false,
      perMessageDeflate: false,
      maxPayload: this.maxPayloadBytes,
    });
    this.socket = socket;
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
    return presenceRecordSchema.parse(presenceResultMessageSchema.parse(response).payload);
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
    return new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new RemoteTransportError('REQUEST_TIMEOUT', 'Collaboration request timed out.'));
      }, this.requestTimeoutMs);
      this.pending.set(requestId, { expectedType, resolve, reject, timer });
      socket.send(JSON.stringify(message));
    });
  }

  private receive(data: WebSocket.RawData, isBinary: boolean): void {
    if (isBinary) {
      this.failConnection(new RemoteTransportError('PROTOCOL_ERROR', 'Binary frame rejected.'));
      return;
    }
    let message: ServerMessage;
    try {
      message = serverMessageSchema.parse(JSON.parse(data.toString()));
    } catch {
      this.failConnection(new RemoteTransportError('PROTOCOL_ERROR', 'Malformed server message.'));
      return;
    }

    if (message.type === 'auth.challenge') {
      this.answerChallenge(authChallengeSchema.parse(message));
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
      if (this.authTimer !== undefined) clearTimeout(this.authTimer);
      this.authTimer = undefined;
      this.connectionResolve?.();
      this.connectionResolve = undefined;
      this.connectionReject = undefined;
      return;
    }
    if (message.type === 'auth.rejected') {
      const rejected = authRejectedSchema.parse(message);
      this.failConnection(new RemoteTransportError(rejected.code, rejected.message));
      return;
    }
    if (message.type === 'transaction.committed') {
      const transaction = transactionBroadcastSchema.parse(message).payload;
      this.transactionListeners.forEach((listener) => listener(transaction));
      return;
    }
    if (message.type === 'presence.changed') {
      const presence = presenceBroadcastSchema.parse(message).payload;
      this.presenceListeners.forEach((listener) => listener(presence));
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
      pending.reject(new RemoteTransportError(remote.code, remote.message));
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
      clientNonce: this.clientNonce,
      expiresAtMs: challenge.expiresAtMs,
    });
    this.challengeAnswered = true;
    this.socket?.send(
      JSON.stringify({
        type: 'auth.response',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        sessionId: challenge.sessionId,
        documentId: this.documentId,
        challengeId: challenge.challengeId,
        clientId: this.clientId,
        clientNonce: this.clientNonce,
        proof,
      }),
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
    this.certificateVerified = false;
    this.challengeAnswered = false;
    this.socket = undefined;
    this.connectionPromise = undefined;
    this.connectionResolve = undefined;
    this.connectionReject = undefined;
    if (wasAuthenticated) this.disconnectListeners.forEach((listener) => listener(error));
  }
}
