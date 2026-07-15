import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';

import {
  applyCommittedTransaction,
  AuthoritativeSessionHost,
  CollaborationError,
  CollaborationTransportClient,
  CollaborationTransportServer,
  COLLABORATION_PROTOCOL_VERSION,
  fingerprintSharedTargetBytes,
  isPrivateLanAddress,
  LanDiscoveryController,
  WriterLeaseStore,
  type CommandBatchRequest,
  type CommittedTransaction,
  type DurableCollaborationDocumentAdapter,
  type ManualInvitation,
} from '@htmllelujah/collaboration';
import type {
  DocumentCommand,
  DocumentSnapshot,
  TransactionOptions,
  TransactionResult,
} from '@htmllelujah/document-core';
import { InMemoryDocumentAdapter } from '@htmllelujah/document-core';
import {
  DocumentRuntimeError,
  DocumentSessionManager,
  type DocumentSessionSnapshot,
} from '@htmllelujah/document-runtime';

import type { CollaborationStatus } from '../shared/desktop-api.js';

export interface CollaborationTransition {
  readonly previousSessionId: string;
  readonly snapshot: DocumentSessionSnapshot;
  readonly targetPath: string;
  readonly status: CollaborationStatus;
}

export interface DesktopCollaborationCoordinatorOptions {
  readonly bindHost?: string | undefined;
  readonly advertisedHost?: string | undefined;
  readonly port?: number | undefined;
}

type HostState = {
  readonly mode: 'host';
  readonly sessionId: string;
  readonly targetPath: string;
  readonly clientId: string;
  readonly secret: Uint8Array;
  readonly engine: AuthoritativeSessionHost;
  readonly server: CollaborationTransportServer;
  readonly invitation: ManualInvitation;
  readonly writerLease: WriterLeaseStore;
  readonly stopHeartbeat: () => void;
  readonly discovery?: LanDiscoveryController | undefined;
};

type GuestState = {
  readonly mode: 'guest';
  readonly sessionId: string;
  readonly targetPath: string;
  readonly clientId: string;
  readonly secret: Uint8Array;
  readonly invitation: ManualInvitation;
  readonly client: CollaborationTransportClient;
  lastSeq: number;
  applyQueue: Promise<void>;
  stopTransactionListener: () => void;
};

type CollaborationState = HostState | GuestState;

const cloneSecret = (secret: Uint8Array): Uint8Array => Uint8Array.from(secret);

const advertisedLanAddress = (): string => {
  const candidates = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter(
      (entry) => entry.family === 'IPv4' && !entry.internal && isPrivateLanAddress(entry.address),
    )
    .sort((left, right) => left.address.localeCompare(right.address));
  return candidates[0]?.address ?? '127.0.0.1';
};

const invitationEndpoint = (invitation: ManualInvitation): string =>
  `wss://${invitation.host.includes(':') ? `[${invitation.host}]` : invitation.host}:${invitation.port}`;

const encodeSessionCode = (sessionId: string, secret: Uint8Array): string =>
  `${sessionId}.${Buffer.from(secret).toString('base64url')}`;

const decodeSessionCode = (
  sessionCode: string,
): { readonly sessionId: string; readonly secret: Uint8Array } => {
  const separator = sessionCode.indexOf('.');
  if (separator < 0) throw new CollaborationError('INVALID_REQUEST', 'Session code is invalid.');
  const sessionId = sessionCode.slice(0, separator);
  const secret = Buffer.from(sessionCode.slice(separator + 1), 'base64url');
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(sessionId) ||
    secret.byteLength !== 32
  ) {
    secret.fill(0);
    throw new CollaborationError('INVALID_REQUEST', 'Session code is invalid.');
  }
  return { sessionId, secret: Uint8Array.from(secret) };
};

const invitationFromJoin = (input: {
  readonly endpoint: string;
  readonly sessionCode: string;
  readonly expectedFingerprint: string;
}): { readonly invitation: ManualInvitation; readonly secret: Uint8Array } => {
  const normalized = /^[a-z][a-z0-9+.-]*:\/\//iu.test(input.endpoint)
    ? input.endpoint
    : `wss://${input.endpoint}`;
  let endpoint: URL;
  try {
    endpoint = new URL(normalized);
  } catch {
    throw new CollaborationError('INVALID_REQUEST', 'Host address is invalid.');
  }
  if (endpoint.protocol !== 'wss:' || endpoint.username !== '' || endpoint.password !== '') {
    throw new CollaborationError('INVALID_REQUEST', 'A secure WSS host address is required.');
  }
  const port = Number(endpoint.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || endpoint.hostname === '') {
    throw new CollaborationError('INVALID_REQUEST', 'Host address must include a valid port.');
  }
  const hostname =
    endpoint.hostname.startsWith('[') && endpoint.hostname.endsWith(']')
      ? endpoint.hostname.slice(1, -1)
      : endpoint.hostname;
  if (!isPrivateLanAddress(hostname)) {
    throw new CollaborationError(
      'PATH_NOT_ALLOWED',
      'Collaboration is restricted to private LAN addresses.',
    );
  }
  const decoded = decodeSessionCode(input.sessionCode);
  return {
    secret: decoded.secret,
    invitation: {
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      host: hostname,
      port,
      sessionId: decoded.sessionId,
      certificateFingerprint: input.expectedFingerprint,
      expiresAtMs: Date.now() + 12 * 60 * 60 * 1_000,
    },
  };
};

export class DesktopCollaborationCoordinator {
  readonly #runtime: DocumentSessionManager;
  readonly #options: DesktopCollaborationCoordinatorOptions;
  readonly #states = new Map<string, CollaborationState>();

  public constructor(
    runtime: DocumentSessionManager,
    options: DesktopCollaborationCoordinatorOptions = {},
  ) {
    this.#runtime = runtime;
    this.#options = options;
  }

  public mode(sessionId: string): CollaborationState['mode'] | 'offline' {
    return this.#states.get(sessionId)?.mode ?? 'offline';
  }

  public status(sessionId: string): CollaborationStatus {
    const state = this.#states.get(sessionId);
    if (state === undefined) {
      return {
        mode: 'offline',
        connectedPeers: 0,
        discoveryEnabled: false,
        note: 'Open the same .hdeck from your shared drive, then host or join a LAN editing session.',
      };
    }
    if (state.mode === 'host') {
      return {
        mode: 'host',
        connectedPeers: state.server.authenticatedPeerCount,
        sessionCode: encodeSessionCode(state.invitation.sessionId, state.secret),
        hostFingerprint: state.invitation.certificateFingerprint,
        endpoint: invitationEndpoint(state.invitation),
        discoveryEnabled: state.discovery !== undefined,
        note: `${state.server.authenticatedPeerCount} guest${state.server.authenticatedPeerCount === 1 ? '' : 's'} connected. You are the only shared-file writer.`,
      };
    }
    return {
      mode: 'guest',
      connectedPeers: state.client.isConnected ? 1 : 0,
      hostFingerprint: state.invitation.certificateFingerprint,
      endpoint: invitationEndpoint(state.invitation),
      discoveryEnabled: false,
      note: state.client.isConnected
        ? 'Connected to the authoritative host. This device never writes the shared file.'
        : 'The host connection is unavailable. Rejoin before editing.',
    };
  }

  async #cloneDetached(
    sessionId: string,
    document?: DocumentSnapshot,
  ): Promise<DocumentSessionSnapshot> {
    const source = this.#runtime.getSnapshot(sessionId);
    const assets = source.document.assets.map((reference) => {
      const asset = this.#runtime.getAssetBytesMainOnly(sessionId, reference.id);
      return {
        id: asset.id,
        bytes: asset.bytes,
        mediaType: asset.mediaType,
        originalName: asset.fileName,
        ...(asset.widthPx === undefined ? {} : { widthPx: asset.widthPx }),
        ...(asset.heightPx === undefined ? {} : { heightPx: asset.heightPx }),
      };
    });
    const targetDocument = document?.document ?? source.document;
    const sourceAssetIds = new Set(source.document.assets.map((asset) => asset.id));
    if (targetDocument.assets.some((asset) => !sourceAssetIds.has(asset.id))) {
      throw new CollaborationError(
        'INVALID_REQUEST',
        'The host references assets that are not present in the shared file.',
      );
    }
    return this.#runtime.createMainOnly({ document: targetDocument, assets });
  }

  #runtimeAdapter(sessionId: string): DurableCollaborationDocumentAdapter {
    return {
      durability: 'async',
      getSnapshot: () => {
        const snapshot = this.#runtime.getSnapshot(sessionId);
        return { document: snapshot.document, revision: snapshot.revision };
      },
      transact: async (
        commands: readonly DocumentCommand[],
        options: TransactionOptions,
      ): Promise<TransactionResult> => {
        const before = this.#runtime.getSnapshot(sessionId);
        const after = await this.#runtime.execute(sessionId, {
          expectedRevision: options.expectedRevision ?? before.revision,
          commands,
          metadata: options.metadata,
        });
        return {
          document: after.document,
          revision: after.revision,
          previousRevision: before.revision,
          metadata: options.metadata,
          commands: structuredClone(commands),
          undoSnapshot: { document: before.document, revision: before.revision },
        };
      },
    };
  }

  public async host(input: {
    readonly sessionId: string;
    readonly targetPath: string;
    readonly displayName: string;
    readonly enableDiscovery: boolean;
  }): Promise<CollaborationTransition> {
    if (this.#states.has(input.sessionId)) {
      throw new CollaborationError(
        'INVALID_REQUEST',
        'This presentation is already collaborating.',
      );
    }
    const secret = randomBytes(32);
    const detached = await this.#cloneDetached(input.sessionId);
    const clientId = `host-${randomUUID()}`;
    const engine = new AuthoritativeSessionHost(this.#runtimeAdapter(detached.sessionId));
    const writerLease = new WriterLeaseStore({
      targetPath: input.targetPath,
      documentId: detached.documentId,
      sessionId: engine.sessionId,
      writerInstanceId: clientId,
      documentSecret: secret,
    });
    let server: CollaborationTransportServer | undefined;
    let discovery: LanDiscoveryController | undefined;
    let stopHeartbeat: (() => void) | undefined;
    try {
      await writerLease.claim();
      stopHeartbeat = writerLease.startHeartbeat(10_000);
      server = new CollaborationTransportServer({
        engine,
        documentSecret: secret,
        bindHost: this.#options.bindHost ?? '0.0.0.0',
        advertisedHost: this.#options.advertisedHost ?? advertisedLanAddress(),
        ...(this.#options.port === undefined ? {} : { port: this.#options.port }),
        maxPeers: 8,
      });
      const invitation = await server.start();
      if (input.enableDiscovery) {
        discovery = new LanDiscoveryController({ documentSecret: secret, enabled: true });
        discovery.advertise(invitation);
      }
      const state: HostState = {
        mode: 'host',
        sessionId: detached.sessionId,
        targetPath: input.targetPath,
        clientId,
        secret: cloneSecret(secret),
        engine,
        server,
        invitation,
        writerLease,
        stopHeartbeat,
        ...(discovery === undefined ? {} : { discovery }),
      };
      this.#states.set(detached.sessionId, state);
      return {
        previousSessionId: input.sessionId,
        snapshot: detached,
        targetPath: input.targetPath,
        status: this.status(detached.sessionId),
      };
    } catch (error) {
      discovery?.destroy();
      await server?.close().catch(() => undefined);
      stopHeartbeat?.();
      await writerLease.close().catch(() => undefined);
      await this.#runtime
        .close(detached.sessionId, { discardUnsaved: true })
        .catch(() => undefined);
      throw error;
    } finally {
      secret.fill(0);
    }
  }

  public async join(input: {
    readonly sessionId: string;
    readonly targetPath: string;
    readonly endpoint: string;
    readonly sessionCode: string;
    readonly expectedFingerprint: string;
    readonly displayName: string;
  }): Promise<CollaborationTransition> {
    if (this.#states.has(input.sessionId)) {
      throw new CollaborationError(
        'INVALID_REQUEST',
        'This presentation is already collaborating.',
      );
    }
    const source = this.#runtime.getSnapshot(input.sessionId);
    const decoded = invitationFromJoin(input);
    const clientId = `guest-${randomUUID()}`;
    const client = new CollaborationTransportClient({
      invitation: decoded.invitation,
      documentId: source.documentId,
      clientId,
      documentSecret: decoded.secret,
    });
    try {
      await client.connect();
      const initial = await client.getResync({
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        sessionId: decoded.invitation.sessionId,
        documentId: source.documentId,
        afterSeq: 0,
        knownRevision: source.revision,
      });
      let synchronized: DocumentSnapshot;
      let lastSeq: number;
      if (initial.kind === 'snapshot') {
        synchronized = initial.snapshot;
        lastSeq = initial.sessionSeq;
      } else {
        const memory = new InMemoryDocumentAdapter(source.document);
        for (const transaction of initial.transactions)
          applyCommittedTransaction(memory, transaction);
        synchronized = memory.getSnapshot();
        lastSeq = initial.toSeq;
      }
      const detached = await this.#cloneDetached(input.sessionId, synchronized);
      const state: GuestState = {
        mode: 'guest',
        sessionId: detached.sessionId,
        targetPath: input.targetPath,
        clientId,
        secret: cloneSecret(decoded.secret),
        invitation: decoded.invitation,
        client,
        lastSeq,
        applyQueue: Promise.resolve(),
        stopTransactionListener: () => undefined,
      };
      state.stopTransactionListener = client.onTransaction((transaction) => {
        void this.#queueGuestTransaction(state, transaction);
      });
      this.#states.set(detached.sessionId, state);
      return {
        previousSessionId: input.sessionId,
        snapshot: detached,
        targetPath: input.targetPath,
        status: this.status(detached.sessionId),
      };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    } finally {
      decoded.secret.fill(0);
    }
  }

  #queueGuestTransaction(state: GuestState, transaction: CommittedTransaction): Promise<void> {
    const operation = state.applyQueue.then(async () => {
      if (transaction.sessionSeq <= state.lastSeq) return;
      if (transaction.sessionSeq !== state.lastSeq + 1) {
        await this.#resyncGuest(state);
        if (transaction.sessionSeq <= state.lastSeq) return;
      }
      await this.#applyGuestTransaction(state, transaction);
    });
    state.applyQueue = operation.catch(() => undefined);
    return operation;
  }

  async #applyGuestTransaction(
    state: GuestState,
    transaction: CommittedTransaction,
  ): Promise<void> {
    const snapshot = this.#runtime.getSnapshot(state.sessionId);
    if (snapshot.revision !== transaction.beforeRevision) {
      await this.#resyncGuest(state);
      if (transaction.sessionSeq <= state.lastSeq) return;
      const refreshed = this.#runtime.getSnapshot(state.sessionId);
      if (refreshed.revision !== transaction.beforeRevision) {
        throw new CollaborationError('REVISION_CONFLICT', 'Guest replica could not converge.');
      }
    }
    const applied = await this.#runtime.execute(state.sessionId, {
      expectedRevision: transaction.beforeRevision,
      commands: transaction.commands,
      metadata: transaction.metadata,
    });
    if (applied.revision !== transaction.afterRevision) {
      throw new CollaborationError(
        'REVISION_CONFLICT',
        'Guest replica produced a different revision.',
      );
    }
    state.lastSeq = transaction.sessionSeq;
  }

  async #resyncGuest(state: GuestState): Promise<void> {
    const local = this.#runtime.getSnapshot(state.sessionId);
    const response = await state.client.getResync({
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      sessionId: state.invitation.sessionId,
      documentId: local.documentId,
      afterSeq: state.lastSeq,
      knownRevision: local.revision,
    });
    if (response.kind === 'snapshot') {
      throw new CollaborationError(
        'REVISION_CONFLICT',
        'The guest fell outside the retained transaction window; leave and rejoin.',
      );
    }
    for (const transaction of response.transactions) {
      if (transaction.sessionSeq > state.lastSeq)
        await this.#applyGuestTransaction(state, transaction);
    }
    state.lastSeq = response.toSeq;
  }

  public async execute(input: {
    readonly sessionId: string;
    readonly expectedRevision: string;
    readonly label: string;
    readonly commands: readonly DocumentCommand[];
  }): Promise<DocumentSessionSnapshot | undefined> {
    const state = this.#states.get(input.sessionId);
    if (state === undefined) return undefined;
    const snapshot = this.#runtime.getSnapshot(input.sessionId);
    if (snapshot.revision !== input.expectedRevision) {
      throw new DocumentRuntimeError('REVISION_CONFLICT', 'Expected revision does not match.');
    }
    const request: CommandBatchRequest = {
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      sessionId: state.mode === 'host' ? state.engine.sessionId : state.invitation.sessionId,
      documentId: snapshot.documentId,
      clientId: state.clientId,
      clientRequestId: randomUUID(),
      baseRevision: snapshot.revision,
      baseSeq: state.mode === 'host' ? state.engine.sessionSeq : state.lastSeq,
      commands: [...input.commands],
      metadata: { origin: 'user', label: input.label },
    };
    if (state.mode === 'host') {
      await state.server.submitAndBroadcast(request);
      return this.#runtime.getSnapshot(state.sessionId);
    }
    const transaction = await state.client.submit(request);
    await this.#queueGuestTransaction(state, transaction);
    return this.#runtime.getSnapshot(state.sessionId);
  }

  public assertStandaloneOperation(sessionId: string, operation: string): void {
    if (this.#states.has(sessionId)) {
      throw new CollaborationError(
        'INVALID_REQUEST',
        `${operation} is disabled during a live LAN session. End the session first.`,
      );
    }
  }

  public async saveHost(sessionId: string): Promise<DocumentSessionSnapshot | undefined> {
    const state = this.#states.get(sessionId);
    if (state === undefined) return undefined;
    if (state.mode === 'guest') {
      throw new CollaborationError(
        'WRITER_LEASE_ACTIVE',
        'Only the host can save the shared file.',
      );
    }
    const previousFingerprint = await state.writerLease.preflightTarget();
    const snapshot = await this.#runtime.saveDetachedMainOnly(sessionId, {
      targetPath: state.targetPath,
      // The signed writer lease already pins the exact shared-target fingerprint. The hdeck
      // persistence layer uses a different fingerprint encoding, so overwrite approval is
      // intentionally explicit here instead of comparing incompatible representations.
      expectedFingerprint: undefined,
      allowOverwrite: true,
    });
    const nextFingerprint = fingerprintSharedTargetBytes(await readFile(state.targetPath));
    await state.writerLease.recordSnapshot(previousFingerprint, nextFingerprint);
    return snapshot;
  }

  public async leave(
    sessionId: string,
  ): Promise<
    { readonly targetPath: string; readonly mode: CollaborationState['mode'] } | undefined
  > {
    const state = this.#states.get(sessionId);
    if (state === undefined) return undefined;
    if (state.mode === 'host' && this.#runtime.getSnapshot(sessionId).dirty) {
      await this.saveHost(sessionId);
    }
    this.#states.delete(sessionId);
    if (state.mode === 'host') {
      state.stopHeartbeat();
      state.discovery?.destroy();
      await state.server.close();
      await state.writerLease.close();
    } else {
      state.stopTransactionListener();
      await state.client.close();
    }
    state.secret.fill(0);
    return { targetPath: state.targetPath, mode: state.mode };
  }

  public async shutdown(sessionId: string): Promise<void> {
    const state = this.#states.get(sessionId);
    if (state === undefined) return;
    this.#states.delete(sessionId);
    if (state.mode === 'host') {
      state.stopHeartbeat();
      state.discovery?.destroy();
      await state.server.close().catch(() => undefined);
      await state.writerLease.close().catch(() => undefined);
    } else {
      state.stopTransactionListener();
      await state.client.close().catch(() => undefined);
    }
    state.secret.fill(0);
  }

  public async shutdownAll(): Promise<void> {
    await Promise.all([...this.#states.keys()].map((sessionId) => this.shutdown(sessionId)));
  }
}
