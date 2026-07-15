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
  RemoteTransportError,
  WriterLeaseStore,
  type CommandBatchRequest,
  type CommittedTransaction,
  type DurableCollaborationDocumentAdapter,
  type ManualInvitation,
  type TextLease,
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
  readonly clock?: (() => number) | undefined;
  readonly invitationTtlMs?: number | undefined;
  readonly writerLeaseTtlMs?: number | undefined;
  readonly heartbeatIntervalMs?: number | undefined;
  readonly saveLeaseReservationMs?: number | undefined;
  readonly textLeaseTtlMs?: number | undefined;
}

export type DesktopTextLeaseStatus =
  | {
      readonly status: 'available';
      readonly owner: 'none';
      readonly slideId: string;
      readonly elementId: string;
      readonly expiresAtMs: null;
    }
  | {
      readonly status: 'owned';
      readonly owner: 'self';
      readonly slideId: string;
      readonly elementId: string;
      readonly expiresAtMs: number;
    }
  | {
      readonly status: 'held';
      readonly owner: 'peer';
      readonly ownerClientId: string;
      readonly slideId: string;
      readonly elementId: string;
      readonly expiresAtMs: number;
    };

type StoredTextLease =
  | {
      readonly view: Extract<DesktopTextLeaseStatus, { status: 'owned' }>;
      readonly lease: TextLease;
    }
  | { readonly view: Extract<DesktopTextLeaseStatus, { status: 'held' }> };

type CollaborationSafetyLatch = { failure?: Error };

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
  readonly safety: CollaborationSafetyLatch;
  readonly discovery?: LanDiscoveryController | undefined;
  leaseQueue: Promise<void>;
  textLeaseQueue: Promise<void>;
  readonly textLeases: Map<string, StoredTextLease>;
  saveUnconfirmed: boolean;
  safeTransition?: Promise<void>;
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
  textLeaseQueue: Promise<void>;
  readonly textLeases: Map<string, StoredTextLease>;
  stopTransactionListener: () => void;
  stopDisconnectListener: () => void;
  failure?: Error;
  safeTransition?: Promise<void>;
  reconnectPromise?: Promise<void>;
};

type CollaborationState = HostState | GuestState;

const cloneSecret = (secret: Uint8Array): Uint8Array => Uint8Array.from(secret);

const textLeaseKey = (slideId: string, elementId: string): string => `${slideId}\0${elementId}`;

const availableTextLease = (slideId: string, elementId: string): DesktopTextLeaseStatus => ({
  status: 'available',
  owner: 'none',
  slideId,
  elementId,
  expiresAtMs: null,
});

const ownedTextLease = (lease: TextLease): StoredTextLease => ({
  lease,
  view: {
    status: 'owned',
    owner: 'self',
    slideId: lease.slideId,
    elementId: lease.elementId,
    expiresAtMs: lease.expiresAtMs,
  },
});

const heldTextLeaseFromError = (
  error: unknown,
  slideId: string,
  elementId: string,
): StoredTextLease | undefined => {
  if (!(
    (error instanceof CollaborationError || error instanceof RemoteTransportError) &&
    error.code === 'TEXT_LEASE_HELD'
  )) {
    return undefined;
  }
  const ownerClientId = error.details?.ownerClientId;
  const expiresAtMs = error.details?.expiresAtMs;
  if (
    typeof ownerClientId !== 'string' ||
    ownerClientId.length < 1 ||
    ownerClientId.length > 128 ||
    typeof expiresAtMs !== 'number' ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= 0
  ) {
    return undefined;
  }
  return {
    view: {
      status: 'held',
      owner: 'peer',
      ownerClientId,
      slideId,
      elementId,
      expiresAtMs,
    },
  };
};

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

const MAX_SESSION_CODE_LENGTH = 128;

const encodeSessionCode = (invitation: ManualInvitation, secret: Uint8Array): string =>
  `${invitation.sessionId}.${invitation.expiresAtMs.toString(36)}.${Buffer.from(secret).toString('base64url')}`;

const decodeSessionCode = (
  sessionCode: string,
): { readonly sessionId: string; readonly expiresAtMs: number; readonly secret: Uint8Array } => {
  if (sessionCode.length > MAX_SESSION_CODE_LENGTH) {
    throw new CollaborationError('INVALID_REQUEST', 'Session code is invalid.');
  }
  const parts = sessionCode.split('.');
  const sessionId = parts[0] ?? '';
  const encodedExpiry = parts[1] ?? '';
  const encodedSecret = parts[2] ?? '';
  const expiresAtMs = /^[0-9a-z]{1,11}$/u.test(encodedExpiry)
    ? Number.parseInt(encodedExpiry, 36)
    : Number.NaN;
  const secret = Buffer.from(encodedSecret, 'base64url');
  if (
    parts.length !== 3 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(sessionId) ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= 0 ||
    expiresAtMs.toString(36) !== encodedExpiry ||
    !/^[A-Za-z0-9_-]{43}$/u.test(encodedSecret) ||
    secret.byteLength !== 32
  ) {
    secret.fill(0);
    throw new CollaborationError('INVALID_REQUEST', 'Session code is invalid.');
  }
  return { sessionId, expiresAtMs, secret: Uint8Array.from(secret) };
};

const invitationFromJoin = (
  input: {
    readonly endpoint: string;
    readonly sessionCode: string;
    readonly expectedFingerprint: string;
  },
  clock: () => number,
): { readonly invitation: ManualInvitation; readonly secret: Uint8Array } => {
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
  if (decoded.expiresAtMs <= clock()) {
    decoded.secret.fill(0);
    throw new CollaborationError(
      'INVALID_REQUEST',
      'Session code expired. Ask the host to share a new one.',
    );
  }
  return {
    secret: decoded.secret,
    invitation: {
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      host: hostname,
      port,
      sessionId: decoded.sessionId,
      certificateFingerprint: input.expectedFingerprint,
      expiresAtMs: decoded.expiresAtMs,
    },
  };
};

export class DesktopCollaborationCoordinator {
  readonly #runtime: DocumentSessionManager;
  readonly #options: DesktopCollaborationCoordinatorOptions;
  readonly #clock: () => number;
  readonly #states = new Map<string, CollaborationState>();

  public constructor(
    runtime: DocumentSessionManager,
    options: DesktopCollaborationCoordinatorOptions = {},
  ) {
    this.#runtime = runtime;
    this.#options = options;
    this.#clock = options.clock ?? (() => Date.now());
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
      if (state.safety.failure !== undefined) {
        return {
          mode: 'host',
          connectedPeers: 0,
          discoveryEnabled: false,
          note: 'The writer lease failed. Editing and saving are disabled; end the session and recover explicitly.',
        };
      }
      return {
        mode: 'host',
        connectedPeers: state.server.authenticatedPeerCount,
        sessionCode: encodeSessionCode(state.invitation, state.secret),
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
      note:
        state.failure !== undefined
          ? 'Replica convergence failed. This copy is read-only and disconnected; leave and rejoin.'
          : state.reconnectPromise !== undefined
            ? 'Connection interrupted. Reconnecting and resynchronizing the guest replica.'
            : state.client.isConnected
              ? 'Connected to the authoritative host. This device never writes the shared file.'
              : 'The host connection is unavailable. Rejoin before editing.',
    };
  }

  async #failHost(state: HostState, error: Error): Promise<void> {
    if (state.safety.failure !== undefined) {
      await state.safeTransition;
      return;
    }
    state.safety.failure = error;
    state.stopHeartbeat();
    state.discovery?.destroy();
    state.textLeases.clear();
    state.engine.releaseTextLeasesForClient(state.clientId);
    state.safeTransition = (async () => {
      await state.server.close().catch(() => undefined);
      await state.leaseQueue;
      // Ownership is uncertain after a heartbeat/save failure. Leaving the sidecar in place
      // forces the next writer through expiry plus explicit stable takeover.
      await state.writerLease.close({ release: false }).catch(() => undefined);
      state.secret.fill(0);
    })();
    await state.safeTransition;
  }

  async #failGuest(state: GuestState, error: Error): Promise<void> {
    if (state.failure !== undefined) {
      await state.safeTransition;
      return;
    }
    state.failure = error;
    state.stopTransactionListener();
    state.stopDisconnectListener();
    state.textLeases.clear();
    state.safeTransition = (async () => {
      await state.client.close().catch(() => undefined);
      state.secret.fill(0);
    })();
    await state.safeTransition;
  }

  #assertHealthy(state: CollaborationState): void {
    if (state.mode === 'host' && state.safety.failure !== undefined) {
      throw new CollaborationError(
        'SPLIT_BRAIN',
        'The writer lease failed; this collaboration session is read-only.',
      );
    }
    if (state.mode === 'guest' && (state.failure !== undefined || !state.client.isConnected)) {
      throw new CollaborationError(
        'REVISION_CONFLICT',
        'The guest replica is disconnected or divergent; leave and rejoin.',
      );
    }
  }

  #purgeLocalTextLeases(state: CollaborationState): void {
    const now = this.#clock();
    state.textLeases.forEach((stored, elementId) => {
      if (stored.view.expiresAtMs <= now) state.textLeases.delete(elementId);
    });
  }

  #enqueueTextLease<T>(state: CollaborationState, operation: () => Promise<T>): Promise<T> {
    const result = state.textLeaseQueue.then(async () => {
      if (this.#states.get(state.sessionId) !== state) {
        throw new CollaborationError(
          'INVALID_REQUEST',
          'The collaboration session ended before the text lease operation completed.',
        );
      }
      if (state.mode === 'guest' && !state.client.isConnected) await this.#reconnectGuest(state);
      this.#assertHealthy(state);
      return operation();
    });
    state.textLeaseQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #ownedLockTokens(state: CollaborationState): Readonly<Record<string, string>> | undefined {
    this.#purgeLocalTextLeases(state);
    const entries = [...state.textLeases.values()]
      .filter(
        (stored): stored is Extract<StoredTextLease, { lease: TextLease }> => 'lease' in stored,
      )
      .map((stored) => [stored.lease.elementId, stored.lease.token] as const);
    return entries.length === 0 ? undefined : Object.fromEntries(entries);
  }

  async #releaseOwnedTextLeases(state: CollaborationState): Promise<void> {
    const owned = [...state.textLeases.values()].filter(
      (stored): stored is Extract<StoredTextLease, { lease: TextLease }> => 'lease' in stored,
    );
    try {
      for (const stored of owned) {
        const request = {
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          sessionId: stored.lease.sessionId,
          documentId: stored.lease.documentId,
          clientId: state.clientId,
          slideId: stored.lease.slideId,
          elementId: stored.lease.elementId,
          token: stored.lease.token,
        } as const;
        if (state.mode === 'host') state.engine.releaseTextLease(request);
        else if (state.client.isConnected) await state.client.releaseTextLease(request);
      }
    } finally {
      state.textLeases.clear();
    }
  }

  async #reconnectGuest(state: GuestState): Promise<void> {
    if (state.failure !== undefined) this.#assertHealthy(state);
    if (state.client.isConnected) return;
    if (state.reconnectPromise !== undefined) return state.reconnectPromise;
    const operation = (async () => {
      let lastError: Error = new Error('Guest reconnect failed.');
      for (const delayMs of [0, 250, 750]) {
        if (this.#states.get(state.sessionId) !== state || state.failure !== undefined) return;
        if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        try {
          await state.client.connect();
          const resync = state.applyQueue.then(() => this.#resyncGuest(state));
          state.applyQueue = resync.catch(() => undefined);
          await resync;
          return;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error('Guest reconnect failed.');
          await state.client.close().catch(() => undefined);
        }
      }
      await this.#failGuest(state, lastError);
      throw lastError;
    })();
    state.reconnectPromise = operation;
    try {
      await operation;
    } finally {
      if (state.reconnectPromise === operation) delete state.reconnectPromise;
    }
  }

  #enqueueHostLease<T>(state: HostState, operation: () => Promise<T>): Promise<T> {
    const result = state.leaseQueue.then(async () => {
      this.#assertHealthy(state);
      return operation();
    });
    state.leaseQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #startHostHeartbeat(state: HostState): () => void {
    const leaseTtlMs = this.#options.writerLeaseTtlMs ?? 45_000;
    const intervalMs = this.#options.heartbeatIntervalMs ?? 10_000;
    if (
      !Number.isSafeInteger(intervalMs) ||
      intervalMs < 1 ||
      !Number.isSafeInteger(leaseTtlMs) ||
      intervalMs >= leaseTtlMs
    ) {
      throw new CollaborationError(
        'INVALID_REQUEST',
        'Heartbeat interval must be positive and shorter than the writer lease TTL.',
      );
    }
    let stopped = false;
    let queued = false;
    const timer = setInterval(() => {
      if (stopped || queued) return;
      queued = true;
      void this.#enqueueHostLease(state, () => state.writerLease.heartbeat())
        .catch((error: unknown) =>
          this.#failHost(
            state,
            error instanceof Error ? error : new Error('Writer heartbeat failed.'),
          ),
        )
        .finally(() => {
          queued = false;
        });
    }, intervalMs);
    return () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
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

  #runtimeAdapter(
    sessionId: string,
    safety: CollaborationSafetyLatch,
  ): DurableCollaborationDocumentAdapter {
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
        if (safety.failure !== undefined) {
          throw new CollaborationError(
            'SPLIT_BRAIN',
            'The writer lease failed; the authoritative replica is read-only.',
          );
        }
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
    readonly allowExpiredTakeover?: boolean;
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
    const safety: CollaborationSafetyLatch = {};
    const engine = new AuthoritativeSessionHost(this.#runtimeAdapter(detached.sessionId, safety), {
      clock: this.#clock,
      ...(this.#options.textLeaseTtlMs === undefined
        ? {}
        : { textLeaseTtlMs: this.#options.textLeaseTtlMs }),
    });
    const writerLease = new WriterLeaseStore({
      targetPath: input.targetPath,
      documentId: detached.documentId,
      sessionId: engine.sessionId,
      writerInstanceId: clientId,
      documentSecret: secret,
      ...(this.#options.writerLeaseTtlMs === undefined
        ? {}
        : { leaseTtlMs: this.#options.writerLeaseTtlMs }),
      clock: this.#clock,
    });
    let server: CollaborationTransportServer | undefined;
    let discovery: LanDiscoveryController | undefined;
    let stopHeartbeat: (() => void) | undefined;
    try {
      await writerLease.claim({ allowExpiredTakeover: input.allowExpiredTakeover === true });
      server = new CollaborationTransportServer({
        engine,
        documentSecret: secret,
        bindHost: this.#options.bindHost ?? '0.0.0.0',
        advertisedHost: this.#options.advertisedHost ?? advertisedLanAddress(),
        ...(this.#options.port === undefined ? {} : { port: this.#options.port }),
        maxPeers: 8,
        clock: this.#clock,
        ...(this.#options.invitationTtlMs === undefined
          ? {}
          : { invitationTtlMs: this.#options.invitationTtlMs }),
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
        stopHeartbeat: () => stopHeartbeat?.(),
        safety,
        leaseQueue: Promise.resolve(),
        textLeaseQueue: Promise.resolve(),
        textLeases: new Map(),
        saveUnconfirmed: false,
        ...(discovery === undefined ? {} : { discovery }),
      };
      this.#states.set(detached.sessionId, state);
      stopHeartbeat = this.#startHostHeartbeat(state);
      return {
        previousSessionId: input.sessionId,
        snapshot: detached,
        targetPath: input.targetPath,
        status: this.status(detached.sessionId),
      };
    } catch (error) {
      this.#states.delete(detached.sessionId);
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
    const decoded = invitationFromJoin(input, this.#clock);
    const clientId = `guest-${randomUUID()}`;
    const client = new CollaborationTransportClient({
      invitation: decoded.invitation,
      documentId: source.documentId,
      clientId,
      documentSecret: decoded.secret,
      clock: this.#clock,
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
        textLeaseQueue: Promise.resolve(),
        textLeases: new Map(),
        stopTransactionListener: () => undefined,
        stopDisconnectListener: () => undefined,
      };
      state.stopTransactionListener = client.onTransaction((transaction) => {
        // The queue records a fatal replica failure and disconnects before this rejection is
        // consumed at the event boundary, so a divergence can never remain silent/editable.
        void this.#queueGuestTransaction(state, transaction).catch(() => undefined);
      });
      this.#states.set(detached.sessionId, state);
      state.stopDisconnectListener = client.onDisconnect(() => {
        if (this.#states.get(state.sessionId) !== state || state.failure !== undefined) return;
        state.textLeases.clear();
        void this.#reconnectGuest(state).catch(() => undefined);
      });
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
    const guarded = operation.catch(async (error: unknown) => {
      await this.#failGuest(
        state,
        error instanceof Error ? error : new Error('Guest replica application failed.'),
      );
      throw error;
    });
    state.applyQueue = guarded.catch(() => undefined);
    return guarded;
  }

  async #applyGuestTransaction(
    state: GuestState,
    transaction: CommittedTransaction,
    allowResync = true,
  ): Promise<void> {
    const snapshot = this.#runtime.getSnapshot(state.sessionId);
    if (snapshot.revision !== transaction.beforeRevision) {
      if (!allowResync) {
        throw new CollaborationError('REVISION_CONFLICT', 'Guest replica could not converge.');
      }
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
        await this.#applyGuestTransaction(state, transaction, false);
    }
    state.lastSeq = response.toSeq;
  }

  /** Returns the last authoritative lease result known to this desktop session. */
  public textLeaseStatus(input: {
    readonly sessionId: string;
    readonly slideId: string;
    readonly elementId: string;
  }): DesktopTextLeaseStatus {
    const state = this.#states.get(input.sessionId);
    if (state === undefined) return availableTextLease(input.slideId, input.elementId);
    this.#purgeLocalTextLeases(state);
    const stored = state.textLeases.get(textLeaseKey(input.slideId, input.elementId));
    if (stored === undefined || stored.view.slideId !== input.slideId) {
      return availableTextLease(input.slideId, input.elementId);
    }
    return structuredClone(stored.view);
  }

  /** Begins (or idempotently reacquires) the current participant's text-editing lease. */
  public async beginTextLease(input: {
    readonly sessionId: string;
    readonly slideId: string;
    readonly elementId: string;
  }): Promise<DesktopTextLeaseStatus> {
    const state = this.#states.get(input.sessionId);
    if (state === undefined) {
      throw new CollaborationError(
        'INVALID_REQUEST',
        'Text leases are only available during a live collaboration session.',
      );
    }
    return this.#enqueueTextLease(state, async () => {
      this.#purgeLocalTextLeases(state);
      const request = {
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        sessionId: state.mode === 'host' ? state.engine.sessionId : state.invitation.sessionId,
        documentId: this.#runtime.getSnapshot(state.sessionId).documentId,
        clientId: state.clientId,
        slideId: input.slideId,
        elementId: input.elementId,
      } as const;
      try {
        const lease =
          state.mode === 'host'
            ? state.engine.acquireTextLease(request)
            : await state.client.acquireTextLease(request);
        if (this.#states.get(state.sessionId) !== state) {
          throw new CollaborationError(
            'INVALID_REQUEST',
            'The collaboration session ended while acquiring the text lease.',
          );
        }
        const stored = ownedTextLease(lease);
        state.textLeases.set(textLeaseKey(input.slideId, input.elementId), stored);
        return structuredClone(stored.view);
      } catch (error) {
        const held = heldTextLeaseFromError(error, input.slideId, input.elementId);
        if (held !== undefined) {
          state.textLeases.set(textLeaseKey(input.slideId, input.elementId), held);
          return structuredClone(held.view);
        }
        state.textLeases.delete(textLeaseKey(input.slideId, input.elementId));
        throw error;
      }
    });
  }

  /** Extends an owned lease. The opaque lock token never crosses the desktop/UI boundary. */
  public async renewTextLease(input: {
    readonly sessionId: string;
    readonly slideId: string;
    readonly elementId: string;
  }): Promise<DesktopTextLeaseStatus> {
    const state = this.#states.get(input.sessionId);
    if (state === undefined) {
      throw new CollaborationError('INVALID_LOCK_TOKEN', 'No text lease is owned by this session.');
    }
    return this.#enqueueTextLease(state, async () => {
      this.#purgeLocalTextLeases(state);
      const key = textLeaseKey(input.slideId, input.elementId);
      const stored = state.textLeases.get(key);
      if (stored === undefined || !('lease' in stored) || stored.lease.slideId !== input.slideId) {
        throw new CollaborationError(
          'INVALID_LOCK_TOKEN',
          'No active text lease is owned for this element.',
        );
      }
      try {
        const request = {
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          sessionId: stored.lease.sessionId,
          documentId: stored.lease.documentId,
          clientId: state.clientId,
          slideId: input.slideId,
          elementId: input.elementId,
          token: stored.lease.token,
        } as const;
        const lease =
          state.mode === 'host'
            ? state.engine.renewTextLease(request)
            : await state.client.renewTextLease(request);
        if (this.#states.get(state.sessionId) !== state) {
          throw new CollaborationError(
            'INVALID_REQUEST',
            'The collaboration session ended while renewing the text lease.',
          );
        }
        const renewed = ownedTextLease(lease);
        state.textLeases.set(key, renewed);
        return structuredClone(renewed.view);
      } catch (error) {
        state.textLeases.delete(key);
        throw error;
      }
    });
  }

  /** Releases an owned lease, or clears a locally observed peer lease. */
  public async endTextLease(input: {
    readonly sessionId: string;
    readonly slideId: string;
    readonly elementId: string;
  }): Promise<DesktopTextLeaseStatus> {
    const state = this.#states.get(input.sessionId);
    if (state === undefined) return availableTextLease(input.slideId, input.elementId);
    return this.#enqueueTextLease(state, async () => {
      const key = textLeaseKey(input.slideId, input.elementId);
      const stored = state.textLeases.get(key);
      if (stored === undefined || !('lease' in stored)) {
        state.textLeases.delete(key);
        return availableTextLease(input.slideId, input.elementId);
      }
      try {
        const request = {
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          sessionId: stored.lease.sessionId,
          documentId: stored.lease.documentId,
          clientId: state.clientId,
          slideId: stored.lease.slideId,
          elementId: stored.lease.elementId,
          token: stored.lease.token,
        } as const;
        if (state.mode === 'host') state.engine.releaseTextLease(request);
        else await state.client.releaseTextLease(request);
        return availableTextLease(input.slideId, input.elementId);
      } finally {
        state.textLeases.delete(key);
      }
    });
  }

  public async execute(input: {
    readonly sessionId: string;
    readonly expectedRevision: string;
    readonly label: string;
    readonly commands: readonly DocumentCommand[];
  }): Promise<DocumentSessionSnapshot | undefined> {
    const state = this.#states.get(input.sessionId);
    if (state === undefined) return undefined;
    if (state.mode === 'guest' && !state.client.isConnected) await this.#reconnectGuest(state);
    this.#assertHealthy(state);
    const snapshot = this.#runtime.getSnapshot(input.sessionId);
    if (snapshot.revision !== input.expectedRevision) {
      throw new DocumentRuntimeError('REVISION_CONFLICT', 'Expected revision does not match.');
    }
    const lockTokens = this.#ownedLockTokens(state);
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
      ...(lockTokens === undefined ? {} : { lockTokens }),
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
    this.#assertHealthy(state);
    try {
      return await this.#enqueueHostLease(state, async () => {
        const previousFingerprint = await state.writerLease.preflightTarget();
        await state.writerLease.heartbeat(
          previousFingerprint,
          Math.max(
            this.#options.writerLeaseTtlMs ?? 45_000,
            this.#options.saveLeaseReservationMs ?? 120_000,
          ),
        );
        const encoded = previousFingerprint.slice('sha256-'.length);
        const expectedBytes = Buffer.from(encoded, 'base64url');
        if (
          !/^sha256-[A-Za-z0-9_-]{43}$/u.test(previousFingerprint) ||
          expectedBytes.byteLength !== 32
        ) {
          throw new CollaborationError('TARGET_CHANGED', 'Shared target fingerprint is invalid.');
        }
        state.saveUnconfirmed = true;
        const snapshot = await this.#runtime.saveDetachedMainOnly(sessionId, {
          targetPath: state.targetPath,
          // The hdeck persistence CAS uses the same SHA-256 bytes encoded as lowercase hex.
          expectedFingerprint: expectedBytes.toString('hex'),
        });
        const nextFingerprint = fingerprintSharedTargetBytes(await readFile(state.targetPath));
        await state.writerLease.recordSnapshot(previousFingerprint, nextFingerprint);
        state.saveUnconfirmed = false;
        return snapshot;
      });
    } catch (error) {
      if (state.saveUnconfirmed) {
        await this.#runtime.markDetachedSaveUnconfirmedMainOnly(sessionId).catch(() => undefined);
      }
      await this.#failHost(
        state,
        error instanceof Error ? error : new Error('Authoritative shared-file save failed.'),
      );
      throw error;
    }
  }

  public async leave(sessionId: string): Promise<
    | {
        readonly targetPath: string;
        readonly mode: CollaborationState['mode'];
        readonly preserveDetached: boolean;
        readonly preservationReason?: 'unsafe-host' | 'guest-copy';
      }
    | undefined
  > {
    const state = this.#states.get(sessionId);
    if (state === undefined) return undefined;
    if (
      state.mode === 'host' &&
      state.safety.failure === undefined &&
      this.#runtime.getSnapshot(sessionId).dirty
    ) {
      await this.saveHost(sessionId);
    }
    const snapshot = this.#runtime.getSnapshot(sessionId);
    const preserveDetached =
      (state.mode === 'host' &&
        state.safety.failure !== undefined &&
        (state.saveUnconfirmed || snapshot.dirty)) ||
      (state.mode === 'guest' && snapshot.dirty);
    await state.textLeaseQueue;
    await this.#releaseOwnedTextLeases(state).catch(() => undefined);
    this.#states.delete(sessionId);
    if (state.mode === 'host') {
      state.stopHeartbeat();
      state.discovery?.destroy();
      await state.leaseQueue;
      await state.safeTransition;
      await state.server.close();
      await state.writerLease.close({ release: state.safety.failure === undefined });
    } else {
      state.stopTransactionListener();
      state.stopDisconnectListener();
      await state.safeTransition;
      await state.reconnectPromise?.catch(() => undefined);
      await state.client.close();
    }
    state.secret.fill(0);
    return {
      targetPath: state.targetPath,
      mode: state.mode,
      preserveDetached,
      ...(preserveDetached
        ? { preservationReason: state.mode === 'host' ? 'unsafe-host' : 'guest-copy' }
        : {}),
    };
  }

  public async shutdown(sessionId: string): Promise<void> {
    const state = this.#states.get(sessionId);
    if (state === undefined) return;
    await state.textLeaseQueue;
    await this.#releaseOwnedTextLeases(state).catch(() => undefined);
    this.#states.delete(sessionId);
    if (state.mode === 'host') {
      state.stopHeartbeat();
      state.discovery?.destroy();
      await state.server.close().catch(() => undefined);
      await state.leaseQueue;
      await state.safeTransition;
      await state.writerLease
        .close({ release: state.safety.failure === undefined })
        .catch(() => undefined);
    } else {
      state.stopTransactionListener();
      state.stopDisconnectListener();
      await state.safeTransition;
      await state.reconnectPromise?.catch(() => undefined);
      await state.client.close().catch(() => undefined);
    }
    state.secret.fill(0);
  }

  public async shutdownAll(): Promise<void> {
    await Promise.all([...this.#states.keys()].map((sessionId) => this.shutdown(sessionId)));
  }
}
