import { mkdtemp, rm as remove } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  AuthoritativeSessionHost,
  CollaborationTransportClient,
  CollaborationTransportServer,
  COLLABORATION_PROTOCOL_VERSION,
  RemoteTransportError,
  type CollaborationTransportClientOptions,
  type CommittedTransaction,
  type PresenceRecord,
  type PresenceUpdate,
  type ResyncRequest,
  type ResyncResponse,
} from '@htmllelujah/collaboration';
import { InMemoryDocumentAdapter } from '@htmllelujah/document-core';
import {
  DocumentSessionManager,
  type DocumentSessionSnapshot,
} from '@htmllelujah/document-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DesktopCollaborationCoordinator,
  listPrivateLanAdapters,
  listPrivateLanAddresses,
  persistedTargetFingerprintToWriterLeaseFingerprint,
  selectPrivateLanAddress,
  selectRequestedPrivateLanAddress,
} from '../src/main/collaboration-service.js';

const SESSION_ID = '98000000-0000-4000-8000-000000000001';
const SECRET = Buffer.alloc(32, 0x31);
const FINGERPRINT = `sha256-${Buffer.alloc(32, 0x32).toString('base64url')}`;

class BootstrapTransportClient extends CollaborationTransportClient {
  readonly transactionListeners = new Set<(transaction: CommittedTransaction) => void>();
  readonly disconnectListeners = new Set<(error: RemoteTransportError) => void>();
  readonly resyncRequests: ResyncRequest[] = [];
  listenerCountAtConnect = 0;
  closeCount = 0;
  connectHook: (() => void) | undefined;
  connected = false;

  public constructor(
    options: CollaborationTransportClientOptions,
    private readonly resync: (request: ResyncRequest) => ResyncResponse,
  ) {
    super(options);
  }

  public override get isConnected(): boolean {
    return this.connected;
  }

  public override get authoritativeHostClientId(): string {
    return 'bootstrap-host';
  }

  public override connect(): Promise<void> {
    this.connected = true;
    this.listenerCountAtConnect = this.transactionListeners.size;
    this.connectHook?.();
    return Promise.resolve();
  }

  public override close(): Promise<void> {
    this.closeCount += 1;
    this.connected = false;
    return Promise.resolve();
  }

  public override onTransaction(listener: (transaction: CommittedTransaction) => void): () => void {
    this.transactionListeners.add(listener);
    return () => this.transactionListeners.delete(listener);
  }

  public override onDisconnect(listener: (error: RemoteTransportError) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  public override getResync(request: ResyncRequest): Promise<ResyncResponse> {
    this.resyncRequests.push(structuredClone(request));
    return Promise.resolve(this.resync(request));
  }

  public override updatePresence(update: PresenceUpdate): Promise<PresenceRecord> {
    return Promise.resolve({
      ...structuredClone(update),
      receivedAtMs: 1_000,
      expiresAtMs: 21_000,
    });
  }

  public override listPresence(): readonly PresenceRecord[] {
    return [];
  }

  public emitTransaction(transaction: CommittedTransaction): void {
    this.transactionListeners.forEach((listener) => listener(structuredClone(transaction)));
  }

  public emitDisconnect(error: RemoteTransportError): void {
    this.connected = false;
    this.disconnectListeners.forEach((listener) => listener(error));
  }
}

const commandTransactions = (
  source: DocumentSessionSnapshot,
  count: number,
): readonly CommittedTransaction[] => {
  let id = 10;
  const host = new AuthoritativeSessionHost(new InMemoryDocumentAdapter(source.document), {
    sessionId: SESSION_ID,
    clock: () => 1_000,
    idFactory: () => `98100000-0000-4000-8000-${String(id++).padStart(12, '0')}`,
  });
  return Array.from({ length: count }, (_, index) =>
    host.submit({
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      sessionId: host.sessionId,
      documentId: host.documentId,
      clientId: 'bootstrap-host',
      clientRequestId: `98200000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      baseRevision: host.revision,
      baseSeq: host.sessionSeq,
      commands: [{ type: 'deck.rename', name: `Bootstrap ${index + 1}` }],
      metadata: { origin: 'user', label: 'Bootstrap transaction' },
    }),
  );
};

const joinInput = (source: DocumentSessionSnapshot, targetPath: string) => ({
  sessionId: source.sessionId,
  targetPath,
  endpoint: '127.0.0.1:8443',
  sessionCode: `${SESSION_ID}.${(10_000).toString(36)}.${SECRET.toString('base64url')}`,
  expectedFingerprint: FINGERPRINT,
  displayName: 'Bootstrap guest',
});

const closeRuntime = async (runtime: DocumentSessionManager): Promise<void> => {
  await Promise.all(
    runtime
      .listSessions()
      .map((session) => runtime.close(session.sessionId, { discardUnsaved: true })),
  );
};

describe('desktop collaboration bootstrap boundaries', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const operation of cleanup.splice(0).reverse()) await operation();
  });

  it('selects one private listener literal and converts the exact persisted digest', () => {
    const adapters = [
      { name: 'Public', address: '8.8.8.8', family: 'IPv4', internal: false },
      { name: 'Wi-Fi', address: '192.168.4.20', family: 'IPv4', internal: false },
      { name: 'VPN adapter', address: '10.0.0.8', family: 4, internal: false },
      { name: 'Duplicate', address: '192.168.4.20', family: 4, internal: false },
      { name: 'Loopback', address: '127.0.0.1', family: 'IPv4', internal: true },
    ] as const;
    expect(listPrivateLanAdapters(adapters)).toEqual([
      { address: '10.0.0.8', name: 'VPN adapter' },
      { address: '192.168.4.20', name: 'Wi-Fi' },
    ]);
    expect(listPrivateLanAddresses(adapters)).toEqual(['10.0.0.8', '192.168.4.20']);
    expect(selectPrivateLanAddress(adapters)).toBe('10.0.0.8');
    expect(() => selectRequestedPrivateLanAddress(adapters)).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    );
    expect(selectRequestedPrivateLanAddress(adapters, '192.168.4.20')).toBe('192.168.4.20');
    expect(() => selectRequestedPrivateLanAddress(adapters, '172.16.1.4')).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    );
    expect(selectPrivateLanAddress([])).toBeUndefined();

    const digest = Buffer.alloc(32, 0xab);
    expect(persistedTargetFingerprintToWriterLeaseFingerprint(digest.toString('hex'))).toBe(
      `sha256-${digest.toString('base64url')}`,
    );
    expect(() =>
      persistedTargetFingerprintToWriterLeaseFingerprint(digest.toString('hex').toUpperCase()),
    ).toThrowError(expect.objectContaining({ code: 'TARGET_CHANGED' }));
  });

  it('rejects a different path or captured generation before creating any transport', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-host-source-'));
    const runtime = new DocumentSessionManager({
      recoveryDirectory: path.join(directory, 'recovery'),
      autosaveDelayMs: 0,
    });
    const coordinator = new DesktopCollaborationCoordinator(runtime, {
      bindHost: '127.0.0.1',
    });
    cleanup.push(async () => remove(directory, { recursive: true, force: true }));
    cleanup.push(() => closeRuntime(runtime));
    cleanup.push(() => coordinator.shutdownAll());
    const source = await runtime.createMainOnly();
    const persistedPath = path.join(directory, 'persisted.hdeck');
    await runtime.saveAsMainOnly(source.sessionId, {
      targetPath: persistedPath,
      expectedFingerprint: null,
    });
    const start = vi.spyOn(CollaborationTransportServer.prototype, 'start');
    cleanup.push(async () => start.mockRestore());

    await expect(
      coordinator.host({
        sessionId: source.sessionId,
        targetPath: path.join(directory, 'different.hdeck'),
        displayName: 'Host',
        enableDiscovery: false,
      }),
    ).rejects.toMatchObject({ code: 'TARGET_CHANGED' });

    const captured = await runtime.capturePersistedSourceMainOnly(source.sessionId);
    const staleFingerprint = `${captured.targetFingerprint[0] === '0' ? '1' : '0'}${captured.targetFingerprint.slice(1)}`;
    vi.spyOn(runtime, 'capturePersistedSourceMainOnly').mockResolvedValue({
      ...captured,
      targetFingerprint: staleFingerprint,
    });
    await expect(
      coordinator.host({
        sessionId: source.sessionId,
        targetPath: persistedPath,
        displayName: 'Host',
        enableDiscovery: false,
      }),
    ).rejects.toMatchObject({ code: 'TARGET_CHANGED' });
    expect(start).not.toHaveBeenCalled();
  });

  it('buffers broadcasts before connect and returns the post-fence replica snapshot', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-join-buffer-'));
    const runtime = new DocumentSessionManager({
      recoveryDirectory: path.join(directory, 'recovery'),
      autosaveDelayMs: 0,
    });
    cleanup.push(async () => remove(directory, { recursive: true, force: true }));
    cleanup.push(() => closeRuntime(runtime));
    const source = await runtime.createMainOnly();
    const [transaction] = commandTransactions(source, 1);
    let client!: BootstrapTransportClient;
    const coordinator = new DesktopCollaborationCoordinator(runtime, {
      clock: () => 1_000,
      transportClientFactory: (options) => {
        client = new BootstrapTransportClient(options, (request) => ({
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          kind: 'tail',
          sessionId: SESSION_ID,
          documentId: source.documentId,
          fromSeq: request.afterSeq,
          toSeq: request.afterSeq === 0 ? 0 : 1,
          revision: request.afterSeq === 0 ? source.revision : transaction!.afterRevision,
          transactions: [],
        }));
        return client;
      },
    });
    cleanup.push(() => coordinator.shutdownAll());

    let releaseClone!: () => void;
    let markCloneStarted!: () => void;
    const cloneGate = new Promise<void>((resolve) => {
      releaseClone = resolve;
    });
    const cloneStarted = new Promise<void>((resolve) => {
      markCloneStarted = resolve;
    });
    const createReplica = runtime.createMainOnly.bind(runtime);
    vi.spyOn(runtime, 'createMainOnly').mockImplementation(async (...args) => {
      markCloneStarted();
      await cloneGate;
      return createReplica(...args);
    });

    const joining = coordinator.join(joinInput(source, path.join(directory, 'shared.hdeck')));
    await cloneStarted;
    client.emitTransaction(transaction!);
    releaseClone();
    const joined = await joining;

    expect(client.listenerCountAtConnect).toBe(1);
    expect(client.resyncRequests).toHaveLength(2);
    expect(client.resyncRequests[1]?.afterSeq).toBe(1);
    expect(joined.snapshot.revision).toBe(transaction!.afterRevision);
    expect(joined.snapshot.document.name).toBe('Bootstrap 1');
    expect(runtime.getSnapshot(joined.snapshot.sessionId)).toEqual(joined.snapshot);
    await coordinator.leave(joined.snapshot.sessionId);
  });

  it('removes a cloned replica and its recovery state when bootstrap disconnects during cloning', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-join-clone-disconnect-'));
    const runtime = new DocumentSessionManager({
      recoveryDirectory: path.join(directory, 'recovery'),
      autosaveDelayMs: 0,
    });
    cleanup.push(async () => remove(directory, { recursive: true, force: true }));
    cleanup.push(() => closeRuntime(runtime));
    const source = await runtime.createMainOnly();
    const baselineCandidates = (await runtime.listRecoveryCandidatesMainOnly())
      .map((candidate) => candidate.sessionId)
      .sort();
    let client!: BootstrapTransportClient;
    const coordinator = new DesktopCollaborationCoordinator(runtime, {
      clock: () => 1_000,
      transportClientFactory: (options) => {
        client = new BootstrapTransportClient(options, (request) => ({
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          kind: 'tail',
          sessionId: SESSION_ID,
          documentId: source.documentId,
          fromSeq: request.afterSeq,
          toSeq: 0,
          revision: source.revision,
          transactions: [],
        }));
        return client;
      },
    });
    cleanup.push(() => coordinator.shutdownAll());

    let releaseClone!: () => void;
    let markCloneStarted!: () => void;
    const cloneGate = new Promise<void>((resolve) => {
      releaseClone = resolve;
    });
    const cloneStarted = new Promise<void>((resolve) => {
      markCloneStarted = resolve;
    });
    let clonedSessionId: string | undefined;
    const createReplica = runtime.createMainOnly.bind(runtime);
    vi.spyOn(runtime, 'createMainOnly').mockImplementation(async (...args) => {
      markCloneStarted();
      await cloneGate;
      const replica = await createReplica(...args);
      clonedSessionId = replica.sessionId;
      return replica;
    });

    const joining = coordinator.join(joinInput(source, path.join(directory, 'shared.hdeck')));
    await cloneStarted;
    client.emitDisconnect(
      new RemoteTransportError('CONNECTION_CLOSED', 'Connection closed during replica cloning.'),
    );
    releaseClone();

    await expect(joining).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
    expect(clonedSessionId).toBeDefined();
    expect(runtime.listSessions().map((session) => session.sessionId)).toEqual([source.sessionId]);
    expect(
      (await runtime.listRecoveryCandidatesMainOnly())
        .map((candidate) => candidate.sessionId)
        .sort(),
    ).toEqual(baselineCandidates);
    expect(coordinator.mode(clonedSessionId!)).toBe('offline');
    expect(client.transactionListeners.size).toBe(0);
    expect(client.disconnectListeners.size).toBe(0);
    expect(client.closeCount).toBeGreaterThan(0);
  });

  it('fails closed and removes listeners when the bounded bootstrap buffer overflows', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-join-overflow-'));
    const runtime = new DocumentSessionManager({
      recoveryDirectory: path.join(directory, 'recovery'),
      autosaveDelayMs: 0,
    });
    cleanup.push(async () => remove(directory, { recursive: true, force: true }));
    cleanup.push(() => closeRuntime(runtime));
    const source = await runtime.createMainOnly();
    const transactions = commandTransactions(source, 2);
    let client!: BootstrapTransportClient;
    const coordinator = new DesktopCollaborationCoordinator(runtime, {
      clock: () => 1_000,
      maxJoinBufferedTransactions: 1,
      transportClientFactory: (options) => {
        client = new BootstrapTransportClient(options, () => {
          throw new Error('Resync must not begin after bootstrap overflow.');
        });
        client.connectHook = () =>
          transactions.forEach((transaction) => client.emitTransaction(transaction));
        return client;
      },
    });
    cleanup.push(() => coordinator.shutdownAll());

    await expect(
      coordinator.join(joinInput(source, path.join(directory, 'shared.hdeck'))),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(client.listenerCountAtConnect).toBe(1);
    expect(client.transactionListeners.size).toBe(0);
    expect(client.disconnectListeners.size).toBe(0);
    expect(client.resyncRequests).toEqual([]);
    expect(client.closeCount).toBeGreaterThan(0);
    expect(coordinator.mode(source.sessionId)).toBe('offline');
  });
});
