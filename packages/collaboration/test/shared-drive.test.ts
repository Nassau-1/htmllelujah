import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CollaborationError,
  fingerprintSharedTargetBytes,
  NodeSharedDriveFileSystem,
  signCanonicalPayload,
  WriterLeaseStore,
  writerLeaseBodySchema,
  type SharedDriveFileSystem,
  type WriterLeaseStoreOptions,
} from '../src/index.js';

const DOCUMENT_ID = '95000000-0000-4000-8000-000000000001';
const SESSION_A = '95000000-0000-4000-8000-000000000002';
const SESSION_B = '95000000-0000-4000-8000-000000000003';
const SECRET = Buffer.alloc(32, 0x51);
const temporaryDirectories: string[] = [];

const createTarget = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-collaboration-'));
  temporaryDirectories.push(directory);
  const target = path.join(directory, 'deck.hdeck');
  await writeFile(target, 'snapshot-one', 'utf8');
  return target;
};

const createStore = (
  targetPath: string,
  input: Partial<WriterLeaseStoreOptions> & { readonly writerInstanceId: string },
): WriterLeaseStore =>
  new WriterLeaseStore({
    targetPath,
    documentId: DOCUMENT_ID,
    sessionId: input.sessionId ?? SESSION_A,
    writerInstanceId: input.writerInstanceId,
    documentSecret: input.documentSecret ?? SECRET,
    leaseTtlMs: input.leaseTtlMs ?? 45_000,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
    ...(input.idFactory === undefined ? {} : { idFactory: input.idFactory }),
  });

const expectCode = async (operation: Promise<unknown>, code: CollaborationError['code']) => {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(CollaborationError);
    expect((error as CollaborationError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}.`);
};

class TriggerableFileSystem extends NodeSharedDriveFileSystem implements SharedDriveFileSystem {
  private listener: ((fileName: string | undefined) => void) | undefined;
  public stopped = false;

  public override watch(
    _directoryPath: string,
    listener: (fileName: string | undefined) => void,
  ): () => void {
    this.listener = listener;
    return () => {
      this.stopped = true;
      this.listener = undefined;
    };
  }

  public trigger(fileName: string): void {
    this.listener?.(fileName);
  }
}

class InterleavingFileSystem extends NodeSharedDriveFileSystem {
  public beforeSwap: (() => Promise<void>) | undefined;
  public beforeDelete: (() => Promise<void>) | undefined;

  public override async compareAndSwapText(
    filePath: string,
    expectedContent: string,
    replacementContent: string,
    temporaryId: string,
  ): Promise<boolean> {
    const hook = this.beforeSwap;
    this.beforeSwap = undefined;
    await hook?.();
    return super.compareAndSwapText(filePath, expectedContent, replacementContent, temporaryId);
  }

  public override async compareAndDeleteText(
    filePath: string,
    expectedContent: string,
    temporaryId: string,
  ): Promise<boolean> {
    const hook = this.beforeDelete;
    this.beforeDelete = undefined;
    await hook?.();
    return super.compareAndDeleteText(filePath, expectedContent, temporaryId);
  }
}

const installCompetingLease = async (
  fileSystem: NodeSharedDriveFileSystem,
  target: string,
  targetFingerprint?: string,
): Promise<void> => {
  const sidecar = `${target}.writer.json`;
  const current = JSON.parse(await readFile(sidecar, 'utf8')) as Record<string, unknown>;
  const { signature: _signature, ...body } = current;
  const parsed = writerLeaseBodySchema.parse({
    ...body,
    writerInstanceId: 'writer-racer',
    leaseId: '95900000-0000-4000-8000-000000000099',
    heartbeatSeq: Number(body.heartbeatSeq) + 1,
    ...(targetFingerprint === undefined ? {} : { targetFingerprint }),
  });
  await fileSystem.writeAtomic(
    sidecar,
    JSON.stringify({ ...parsed, signature: signCanonicalPayload(SECRET, parsed) }),
    '95900000-0000-4000-8000-000000000098',
  );
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('shared-drive writer lease', () => {
  it('claims, heartbeats, preflights, releases, and cleans up idempotently', async () => {
    let now = 1_000;
    let id = 10;
    const target = await createTarget();
    const store = createStore(target, {
      writerInstanceId: 'writer-a',
      clock: () => now,
      idFactory: () => `95100000-0000-4000-8000-${String(id++).padStart(12, '0')}`,
    });
    const claimed = await store.claim();
    expect((await store.inspect()).state).toBe('active-self');

    expect(await store.preflightTarget(claimed.targetFingerprint)).toBe(claimed.targetFingerprint);
    const nextSnapshot = Buffer.from('snapshot-two');
    await writeFile(target, nextSnapshot);
    const nextFingerprint = fingerprintSharedTargetBytes(nextSnapshot);
    const recorded = await store.recordSnapshot(claimed.targetFingerprint, nextFingerprint);
    expect(recorded.targetFingerprint).toBe(nextFingerprint);

    now += 10_000;
    const heartbeat = await store.heartbeat(nextFingerprint);
    expect(heartbeat.heartbeatSeq).toBe(2);
    expect(heartbeat.expiresAtMs).toBe(now + 45_000);
    expect(await store.release()).toBe(true);
    expect((await store.inspect()).state).toBe('unclaimed');
    await store.close();
    await store.close();
  });

  it('requires explicit takeover of stale leases and detects the old writer as split-brain', async () => {
    let now = 2_000;
    const target = await createTarget();
    const first = createStore(target, {
      writerInstanceId: 'writer-a',
      leaseTtlMs: 100,
      clock: () => now,
    });
    await first.claim();
    now += 101;
    await expectCode(first.preflightTarget(), 'WRITER_LEASE_STALE');
    const second = createStore(target, {
      writerInstanceId: 'writer-b',
      sessionId: SESSION_B,
      leaseTtlMs: 100,
      clock: () => now,
    });
    expect((await second.inspect()).state).toBe('stale');
    await expectCode(second.claim(), 'WRITER_LEASE_STALE');
    await second.claim({ allowExpiredTakeover: true });
    expect((await first.inspect()).state).toBe('split-brain');
    await first.close({ release: false });
    await second.close();
  });

  it('recognizes a crashed foreign-secret lease and requires stable explicit takeover', async () => {
    let now = 3_000;
    const target = await createTarget();
    const first = createStore(target, {
      writerInstanceId: 'writer-old-secret',
      documentSecret: Buffer.alloc(32, 0x31),
      leaseTtlMs: 20,
      clock: () => now,
    });
    await first.claim();
    const successor = createStore(target, {
      writerInstanceId: 'writer-new-secret',
      sessionId: SESSION_B,
      documentSecret: Buffer.alloc(32, 0x32),
      leaseTtlMs: 20,
      clock: () => now,
    });
    expect(await successor.inspect()).toMatchObject({ state: 'active-other', verified: false });
    await expectCode(successor.claim({ allowExpiredTakeover: true }), 'WRITER_LEASE_ACTIVE');
    now += 21;
    expect(await successor.inspect()).toMatchObject({ state: 'stale', verified: false });
    await expectCode(successor.claim(), 'WRITER_LEASE_STALE');
    const startedAt = Date.now();
    await successor.claim({ allowExpiredTakeover: true });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
    expect((await first.inspect()).state).toBe('split-brain');
    await first.close({ release: false });
    await successor.close();
  });

  it('uses sidecar CAS for heartbeat, snapshot recording, and release interleavings', async () => {
    const heartbeatTarget = await createTarget();
    const heartbeatFs = new InterleavingFileSystem();
    const heartbeatOwner = new WriterLeaseStore({
      targetPath: heartbeatTarget,
      documentId: DOCUMENT_ID,
      sessionId: SESSION_A,
      writerInstanceId: 'writer-heartbeat',
      documentSecret: SECRET,
      fileSystem: heartbeatFs,
    });
    await heartbeatOwner.claim();
    heartbeatFs.beforeSwap = () => installCompetingLease(heartbeatFs, heartbeatTarget);
    await expectCode(heartbeatOwner.heartbeat(), 'SPLIT_BRAIN');
    expect(JSON.parse(await readFile(`${heartbeatTarget}.writer.json`, 'utf8'))).toMatchObject({
      writerInstanceId: 'writer-racer',
    });
    await heartbeatOwner.close({ release: false });

    const recordTarget = await createTarget();
    const recordFs = new InterleavingFileSystem();
    const recordOwner = new WriterLeaseStore({
      targetPath: recordTarget,
      documentId: DOCUMENT_ID,
      sessionId: SESSION_A,
      writerInstanceId: 'writer-record',
      documentSecret: SECRET,
      fileSystem: recordFs,
    });
    const recordedLease = await recordOwner.claim();
    const nextBytes = Buffer.from('snapshot-after-race');
    await writeFile(recordTarget, nextBytes);
    const nextFingerprint = fingerprintSharedTargetBytes(nextBytes);
    recordFs.beforeSwap = () => installCompetingLease(recordFs, recordTarget, nextFingerprint);
    await expectCode(
      recordOwner.recordSnapshot(recordedLease.targetFingerprint, nextFingerprint),
      'SPLIT_BRAIN',
    );
    expect(JSON.parse(await readFile(`${recordTarget}.writer.json`, 'utf8'))).toMatchObject({
      writerInstanceId: 'writer-racer',
      targetFingerprint: nextFingerprint,
    });
    await recordOwner.close({ release: false });

    const releaseTarget = await createTarget();
    const releaseFs = new InterleavingFileSystem();
    const releaseOwner = new WriterLeaseStore({
      targetPath: releaseTarget,
      documentId: DOCUMENT_ID,
      sessionId: SESSION_A,
      writerInstanceId: 'writer-release',
      documentSecret: SECRET,
      fileSystem: releaseFs,
    });
    await releaseOwner.claim();
    releaseFs.beforeDelete = () => installCompetingLease(releaseFs, releaseTarget);
    await expectCode(releaseOwner.release(), 'SPLIT_BRAIN');
    expect(JSON.parse(await readFile(`${releaseTarget}.writer.json`, 'utf8'))).toMatchObject({
      writerInstanceId: 'writer-racer',
    });
    await releaseOwner.close({ release: false });
  });

  it('rejects tampered sidecars and changed target fingerprints', async () => {
    const target = await createTarget();
    const first = createStore(target, { writerInstanceId: 'writer-a' });
    await first.claim();
    const sidecar = `${target}.writer.json`;
    const parsed = JSON.parse(await readFile(sidecar, 'utf8')) as Record<string, unknown>;
    parsed.writerInstanceId = 'attacker';
    await writeFile(sidecar, JSON.stringify(parsed), 'utf8');
    const observer = createStore(target, { writerInstanceId: 'writer-b', sessionId: SESSION_B });
    expect((await observer.inspect()).state).toBe('tampered');
    await expectCode(observer.claim(), 'SIDECAR_TAMPERED');
    await first.close({ release: false });
    await observer.close({ release: false });

    const secondTarget = await createTarget();
    const owner = createStore(secondTarget, { writerInstanceId: 'writer-c' });
    await owner.claim();
    await writeFile(secondTarget, 'external-snapshot', 'utf8');
    await expectCode(owner.heartbeat(), 'TARGET_CHANGED');
    expect((await owner.inspect()).state).toBe('split-brain');
    await owner.close();
  });

  it('allows only one concurrent local claimant', async () => {
    const target = await createTarget();
    const first = createStore(target, { writerInstanceId: 'writer-a' });
    const second = createStore(target, { writerInstanceId: 'writer-b', sessionId: SESSION_B });
    const results = await Promise.allSettled([first.claim(), second.claim()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await first.close({ release: results[0]?.status === 'fulfilled' });
    await second.close({ release: results[1]?.status === 'fulfilled' });
  });

  it('rejects unsafe paths and non-finite timing options', async () => {
    const target = await createTarget();
    expect(
      () =>
        new WriterLeaseStore({
          targetPath: target,
          sidecarPath: target,
          documentId: DOCUMENT_ID,
          sessionId: SESSION_A,
          writerInstanceId: 'writer-invalid',
          documentSecret: SECRET,
        }),
    ).toThrowError(expect.objectContaining({ code: 'PATH_NOT_ALLOWED' }));
    expect(() =>
      createStore(target, { writerInstanceId: 'writer-invalid', leaseTtlMs: Number.NaN }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  it('reports watched target changes without electing another writer', async () => {
    const target = await createTarget();
    const fileSystem = new TriggerableFileSystem();
    const store = new WriterLeaseStore({
      targetPath: target,
      documentId: DOCUMENT_ID,
      sessionId: SESSION_A,
      writerInstanceId: 'writer-watch',
      documentSecret: SECRET,
      fileSystem,
    });
    const lease = await store.claim();
    const eventPromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Watch event timed out.')), 2_000);
      store.watch((event) => {
        clearTimeout(timeout);
        resolve(event.type === 'status' ? event.status.state : 'error');
      }, 0);
    });
    await writeFile(target, 'changed-by-sync', 'utf8');
    fileSystem.trigger(path.basename(target));
    expect(await eventPromise).toBe('split-brain');
    const sidecar = JSON.parse(await readFile(`${target}.writer.json`, 'utf8')) as {
      leaseId: string;
    };
    expect(sidecar.leaseId).toBe(lease.leaseId);
    await store.close();
    expect(fileSystem.stopped).toBe(true);
  });
});
