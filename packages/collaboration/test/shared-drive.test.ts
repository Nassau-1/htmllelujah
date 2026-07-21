import { lstat, mkdtemp, readFile, rm, unlink, writeFile, type FileHandle } from 'node:fs/promises';
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
const SESSION_C = '95000000-0000-4000-8000-000000000004';
const SECRET = Buffer.alloc(32, 0x51);
const TARGET_FINGERPRINT = fingerprintSharedTargetBytes(Buffer.from('snapshot-one'));
const temporaryDirectories: string[] = [];

const deferred = (): { readonly promise: Promise<void>; readonly resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((settled) => {
    resolve = settled;
  });
  return { promise, resolve };
};

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
    ...(input.fileSystem === undefined ? {} : { fileSystem: input.fileSystem }),
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

class AtomicSwapObservationFileSystem extends NodeSharedDriveFileSystem {
  public readonly observations: Array<string | undefined> = [];

  public constructor(private readonly observedPath: string) {
    super();
  }

  private async observeActivePath(filePath: string): Promise<void> {
    if (filePath === this.observedPath) this.observations.push(await this.readText(filePath));
  }

  public override async writeExclusive(filePath: string, content: string): Promise<void> {
    await this.observeActivePath(filePath);
    await super.writeExclusive(filePath, content);
  }

  protected override async commitAtomicText(
    filePath: string,
    content: string,
    temporaryId: string,
    beforeRename?: () => Promise<void>,
  ): Promise<void> {
    await this.observeActivePath(filePath);
    await super.commitAtomicText(filePath, content, temporaryId, beforeRename);
  }
}

class PausedAtomicSwapFileSystem extends NodeSharedDriveFileSystem {
  public readonly firstWriteEntered = deferred();
  public readonly releaseFirstWrite = deferred();
  private atomicWrites = 0;

  protected override async commitAtomicText(
    filePath: string,
    content: string,
    temporaryId: string,
    beforeRename?: () => Promise<void>,
  ): Promise<void> {
    this.atomicWrites += 1;
    if (this.atomicWrites === 1) {
      this.firstWriteEntered.resolve();
      await this.releaseFirstWrite.promise;
    }
    await super.commitAtomicText(filePath, content, temporaryId, beforeRename);
  }
}

class FailingExclusiveWriteFileSystem extends NodeSharedDriveFileSystem {
  protected override async persistExclusiveContent(
    handle: FileHandle,
    content: string,
  ): Promise<void> {
    await handle.writeFile(content.slice(0, 4), 'utf8');
    throw new Error('injected exclusive persistence failure');
  }
}

class ReplacedFailedExclusiveWriteFileSystem extends NodeSharedDriveFileSystem {
  public constructor(private readonly replacementContent: string) {
    super();
  }

  protected override async persistExclusiveContent(
    handle: FileHandle,
    content: string,
    filePath: string,
  ): Promise<void> {
    await handle.writeFile(content.slice(0, 4), 'utf8');
    await handle.close();
    await unlink(filePath);
    await writeFile(filePath, this.replacementContent, 'utf8');
    throw new Error('injected exclusive persistence failure after replacement');
  }
}

class MemorySharedDriveFileSystem implements SharedDriveFileSystem {
  public sidecar: string | undefined;
  public exclusiveWrites = 0;

  public constructor(public targetFingerprint: string | null) {}

  public readText(): Promise<string | undefined> {
    return Promise.resolve(this.sidecar);
  }

  public writeExclusive(_filePath: string, content: string): Promise<void> {
    this.exclusiveWrites += 1;
    if (this.sidecar !== undefined) {
      return Promise.reject(Object.assign(new Error('exists'), { code: 'EEXIST' }));
    }
    this.sidecar = content;
    return Promise.resolve();
  }

  public compareAndSwapText(
    _filePath: string,
    expectedContent: string,
    replacementContent: string,
  ): Promise<boolean> {
    if (this.sidecar !== expectedContent) return Promise.resolve(false);
    this.sidecar = replacementContent;
    return Promise.resolve(true);
  }

  public compareAndDeleteText(_filePath: string, expectedContent: string): Promise<boolean> {
    if (this.sidecar !== expectedContent) return Promise.resolve(false);
    this.sidecar = undefined;
    return Promise.resolve(true);
  }

  public deleteFile(): Promise<boolean> {
    const deleted = this.sidecar !== undefined;
    this.sidecar = undefined;
    return Promise.resolve(deleted);
  }

  public fingerprint(): Promise<string | null> {
    return Promise.resolve(this.targetFingerprint);
  }

  public watch(): () => void {
    return () => undefined;
  }
}

class ClaimVerificationFileSystem extends MemorySharedDriveFileSystem {
  public provisionalContent: string | undefined;
  public rollbackExpectedContent: string | undefined;
  private readbackPending = false;

  public constructor(
    targetFingerprint: string | null,
    private readonly readback: 'fail' | 'replace',
    private readonly replacementContent = '{"writer":"other"}',
  ) {
    super(targetFingerprint);
  }

  public override async writeExclusive(filePath: string, content: string): Promise<void> {
    await super.writeExclusive(filePath, content);
    this.provisionalContent = content;
    this.readbackPending = true;
  }

  public override readText(): Promise<string | undefined> {
    if (this.readbackPending) {
      this.readbackPending = false;
      if (this.readback === 'fail') return Promise.reject(new Error('readback failed'));
      this.sidecar = this.replacementContent;
    }
    return super.readText();
  }

  public override compareAndDeleteText(
    filePath: string,
    expectedContent: string,
  ): Promise<boolean> {
    this.rollbackExpectedContent = expectedContent;
    return super.compareAndDeleteText(filePath, expectedContent);
  }
}

class DeferredClaimRollbackFileSystem extends ClaimVerificationFileSystem {
  private deferRollback = true;

  public override compareAndDeleteText(
    filePath: string,
    expectedContent: string,
  ): Promise<boolean> {
    this.rollbackExpectedContent = expectedContent;
    if (this.deferRollback) {
      this.deferRollback = false;
      return Promise.resolve(false);
    }
    return super.compareAndDeleteText(filePath, expectedContent);
  }
}

class RetryableReleaseFileSystem extends MemorySharedDriveFileSystem {
  public deleteAttempts = 0;

  public override compareAndDeleteText(
    filePath: string,
    expectedContent: string,
  ): Promise<boolean> {
    this.deleteAttempts += 1;
    if (this.deleteAttempts === 1) {
      return Promise.reject(new Error('injected transient release failure'));
    }
    return super.compareAndDeleteText(filePath, expectedContent);
  }
}

class ReplacedReleaseFileSystem extends MemorySharedDriveFileSystem {
  public readonly replacementContent = '{"writer":"different"}';
  private replaceOnDelete = true;

  public override compareAndDeleteText(): Promise<boolean> {
    if (this.replaceOnDelete) {
      this.replaceOnDelete = false;
      this.sidecar = this.replacementContent;
    }
    return Promise.resolve(false);
  }
}

const installCompetingLease = async (target: string, targetFingerprint?: string): Promise<void> => {
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
  await writeFile(
    sidecar,
    JSON.stringify({ ...parsed, signature: signCanonicalPayload(SECRET, parsed) }),
    'utf8',
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
  it('atomically replaces a sidecar without exposing an unclaimed pathname', async () => {
    const target = await createTarget();
    const sidecar = `${target}.writer.json`;
    await writeFile(sidecar, 'old-lease', 'utf8');
    const fileSystem = new AtomicSwapObservationFileSystem(sidecar);

    await expect(
      fileSystem.compareAndSwapText(sidecar, 'old-lease', 'new-lease', 'atomic-swap'),
    ).resolves.toBe(true);

    expect(fileSystem.observations).toEqual(['old-lease']);
    await expect(readFile(sidecar, 'utf8')).resolves.toBe('new-lease');
    await expect(
      fileSystem.compareAndSwapText(sidecar, 'old-lease', 'unexpected', 'mismatch'),
    ).resolves.toBe(false);
    await expect(readFile(sidecar, 'utf8')).resolves.toBe('new-lease');
  });

  it('serializes the read-to-rename interval so only one competing swap can succeed', async () => {
    const target = await createTarget();
    const sidecar = `${target}.writer.json`;
    await writeFile(sidecar, 'old-lease', 'utf8');
    const firstFileSystem = new PausedAtomicSwapFileSystem();
    const secondFileSystem = new NodeSharedDriveFileSystem();

    const first = firstFileSystem.compareAndSwapText(
      sidecar,
      'old-lease',
      'first-lease',
      'first-competing-swap',
    );
    await firstFileSystem.firstWriteEntered.promise;
    const second = secondFileSystem.compareAndSwapText(
      sidecar,
      'old-lease',
      'second-lease',
      'second-competing-swap',
    );

    await expect(second).resolves.toBe(false);
    firstFileSystem.releaseFirstWrite.resolve();
    await expect(first).resolves.toBe(true);
    await expect(readFile(sidecar, 'utf8')).resolves.toBe('first-lease');
    await expect(lstat(`${sidecar}.mutation-lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never recovers an abandoned mutation lock from a normal swap', async () => {
    const target = await createTarget();
    const sidecar = `${target}.writer.json`;
    const mutationLock = `${sidecar}.mutation-lock`;
    await writeFile(sidecar, 'old-lease', 'utf8');
    await writeFile(mutationLock, 'abandoned-lock-token', 'utf8');

    await expect(
      new NodeSharedDriveFileSystem().compareAndSwapText(
        sidecar,
        'old-lease',
        'recovered-lease',
        'expired-mutation-lock',
      ),
    ).resolves.toBe(false);
    await expect(readFile(sidecar, 'utf8')).resolves.toBe('old-lease');
    await expect(readFile(mutationLock, 'utf8')).resolves.toBe('abandoned-lock-token');
  });

  it('requires stable explicit recovery when a crashed writer left only its mutation lock', async () => {
    const target = await createTarget();
    const sidecar = `${target}.writer.json`;
    const mutationLock = `${sidecar}.mutation-lock`;
    await writeFile(mutationLock, 'orphaned-lock-token', 'utf8');
    const store = createStore(target, {
      writerInstanceId: 'writer-after-orphaned-lock',
      leaseTtlMs: 1,
    });

    await expectCode(
      store.claim({ expectedTargetFingerprint: TARGET_FINGERPRINT }),
      'WRITER_LEASE_STALE',
    );
    await expect(readFile(mutationLock, 'utf8')).resolves.toBe('orphaned-lock-token');

    await expect(
      store.claim({
        expectedTargetFingerprint: TARGET_FINGERPRINT,
        allowExpiredTakeover: true,
      }),
    ).resolves.toMatchObject({ writerInstanceId: 'writer-after-orphaned-lock' });
    await expect(lstat(mutationLock)).rejects.toMatchObject({ code: 'ENOENT' });
    await store.close();
  });

  it('cleans only its exact partial file when an exclusive write fails', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-exclusive-write-'));
    temporaryDirectories.push(directory);
    const partialPath = path.join(directory, 'partial.writer.json');

    await expect(
      new FailingExclusiveWriteFileSystem().writeExclusive(partialPath, 'partial-lease'),
    ).rejects.toThrow('injected exclusive persistence failure');
    await expect(readFile(partialPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const replacementPath = path.join(directory, 'replacement.writer.json');
    await expect(
      new ReplacedFailedExclusiveWriteFileSystem('replacement-lease').writeExclusive(
        replacementPath,
        'partial-lease',
      ),
    ).rejects.toThrow('injected exclusive persistence failure after replacement');
    await expect(readFile(replacementPath, 'utf8')).resolves.toBe('replacement-lease');
  });

  it('compare-deletes its exact provisional sidecar when claim readback fails', async () => {
    const fileSystem = new ClaimVerificationFileSystem(TARGET_FINGERPRINT, 'fail');
    const store = createStore(path.resolve('failed-claim-readback.hdeck'), {
      writerInstanceId: 'writer-readback-failure',
      fileSystem,
    });

    await expect(store.claim({ expectedTargetFingerprint: TARGET_FINGERPRINT })).rejects.toThrow(
      'readback failed',
    );

    expect(fileSystem.rollbackExpectedContent).toBe(fileSystem.provisionalContent);
    expect(fileSystem.sidecar).toBeUndefined();
    await store.close({ release: false });
  });

  it('retains provisional ownership so a failed claim rollback can be retried safely', async () => {
    const fileSystem = new DeferredClaimRollbackFileSystem(TARGET_FINGERPRINT, 'fail');
    const store = createStore(path.resolve('deferred-claim-rollback.hdeck'), {
      writerInstanceId: 'writer-deferred-rollback',
      fileSystem,
    });

    await expect(store.claim({ expectedTargetFingerprint: TARGET_FINGERPRINT })).rejects.toThrow(
      'readback failed',
    );
    expect(fileSystem.sidecar).toBe(fileSystem.provisionalContent);

    await expect(store.close()).resolves.toBeUndefined();
    expect(fileSystem.sidecar).toBeUndefined();
  });

  it('does not delete different bytes observed during claim verification', async () => {
    const replacementContent = '{"writer":"other"}';
    const fileSystem = new ClaimVerificationFileSystem(
      TARGET_FINGERPRINT,
      'replace',
      replacementContent,
    );
    const store = createStore(path.resolve('replaced-claim-readback.hdeck'), {
      writerInstanceId: 'writer-readback-replaced',
      fileSystem,
    });

    await expectCode(store.claim({ expectedTargetFingerprint: TARGET_FINGERPRINT }), 'SPLIT_BRAIN');

    expect(fileSystem.rollbackExpectedContent).toBe(fileSystem.provisionalContent);
    expect(fileSystem.sidecar).toBe(replacementContent);
    await store.close({ release: false });
  });

  it('rejects a changed target before granting writer authority', async () => {
    const sourceFingerprint = fingerprintSharedTargetBytes(Buffer.from('source-generation'));
    const currentFingerprint = fingerprintSharedTargetBytes(Buffer.from('current-generation'));
    const fileSystem = new MemorySharedDriveFileSystem(currentFingerprint);
    const store = createStore(path.resolve('source-target-identity.hdeck'), {
      writerInstanceId: 'writer-source-identity',
      fileSystem,
    });

    await expectCode(
      store.claim({ expectedTargetFingerprint: sourceFingerprint }),
      'TARGET_CHANGED',
    );
    expect(fileSystem.exclusiveWrites).toBe(0);
    expect(fileSystem.sidecar).toBeUndefined();
    await store.close({ release: false });
  });

  it('represents an absent Save As target without a hash sentinel', async () => {
    const fileSystem = new MemorySharedDriveFileSystem(null);
    const store = createStore(path.resolve('absent-save-as-target.hdeck'), {
      writerInstanceId: 'writer-save-as',
      fileSystem,
    });

    const claimed = await store.claim({ expectedTargetFingerprint: null });
    expect(claimed.targetFingerprint).toBeNull();
    expect(await store.preflightTarget(null)).toBeNull();

    const committedFingerprint = fingerprintSharedTargetBytes(Buffer.from('created-target'));
    fileSystem.targetFingerprint = committedFingerprint;
    const recorded = await store.recordSnapshot(null, committedFingerprint);
    expect(recorded.targetFingerprint).toBe(committedFingerprint);
    expect(await store.preflightTarget(committedFingerprint)).toBe(committedFingerprint);
    await store.close();
  });

  it('claims, heartbeats, preflights, releases, and cleans up idempotently', async () => {
    let now = 1_000;
    let id = 10;
    const target = await createTarget();
    const store = createStore(target, {
      writerInstanceId: 'writer-a',
      clock: () => now,
      idFactory: () => `95100000-0000-4000-8000-${String(id++).padStart(12, '0')}`,
    });
    const claimed = await store.claim({ expectedTargetFingerprint: TARGET_FINGERPRINT });
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

  it('allows close to retry an exact sidecar release after the target commit changed', async () => {
    const fileSystem = new RetryableReleaseFileSystem(TARGET_FINGERPRINT);
    const store = createStore(path.resolve('retry-release-after-commit.hdeck'), {
      writerInstanceId: 'writer-retry-release',
      fileSystem,
    });
    await store.claim({ expectedTargetFingerprint: TARGET_FINGERPRINT });
    const committedFingerprint = fingerprintSharedTargetBytes(Buffer.from('committed-snapshot'));
    fileSystem.targetFingerprint = committedFingerprint;

    await expect(store.close()).rejects.toThrow('injected transient release failure');
    expect(fileSystem.sidecar).toBeDefined();
    await expect(store.close()).resolves.toBeUndefined();

    expect(fileSystem.deleteAttempts).toBe(2);
    expect(fileSystem.sidecar).toBeUndefined();

    const nextSave = createStore(path.resolve('retry-release-after-commit.hdeck'), {
      writerInstanceId: 'writer-next-save',
      sessionId: SESSION_B,
      fileSystem,
    });
    await expect(
      nextSave.claim({ expectedTargetFingerprint: committedFingerprint }),
    ).resolves.toMatchObject({ targetFingerprint: committedFingerprint });
    await nextSave.close();
    expect(fileSystem.sidecar).toBeUndefined();
  });

  it('exposes the current target generation for explicit recovery of an expired prior save', async () => {
    let now = 1_000;
    const fileSystem = new MemorySharedDriveFileSystem(TARGET_FINGERPRINT);
    const first = createStore(path.resolve('expired-release-after-commit.hdeck'), {
      writerInstanceId: 'writer-before-crash',
      leaseTtlMs: 1,
      clock: () => now,
      fileSystem,
    });
    await first.claim({ expectedTargetFingerprint: TARGET_FINGERPRINT });
    const committedFingerprint = fingerprintSharedTargetBytes(
      Buffer.from('committed-before-crash'),
    );
    fileSystem.targetFingerprint = committedFingerprint;
    now += 2;

    const successor = createStore(path.resolve('expired-release-after-commit.hdeck'), {
      writerInstanceId: 'writer-after-restart',
      sessionId: SESSION_B,
      documentSecret: Buffer.alloc(32, 0x52),
      leaseTtlMs: 1,
      clock: () => now,
      fileSystem,
    });
    expect(await successor.inspect()).toMatchObject({
      state: 'stale',
      verified: false,
      actualTargetFingerprint: committedFingerprint,
    });
    await expect(
      successor.claim({
        expectedTargetFingerprint: committedFingerprint,
        allowExpiredTakeover: true,
      }),
    ).resolves.toMatchObject({ targetFingerprint: committedFingerprint });

    await first.close({ release: false });
    await successor.close();
    expect(fileSystem.sidecar).toBeUndefined();
  });

  it('never deletes different sidecar bytes while retrying close', async () => {
    const fileSystem = new ReplacedReleaseFileSystem(TARGET_FINGERPRINT);
    const store = createStore(path.resolve('different-release-retry.hdeck'), {
      writerInstanceId: 'writer-different-release',
      fileSystem,
    });
    await store.claim({ expectedTargetFingerprint: TARGET_FINGERPRINT });
    fileSystem.targetFingerprint = fingerprintSharedTargetBytes(Buffer.from('committed-snapshot'));

    await expectCode(store.close(), 'SPLIT_BRAIN');
    await expectCode(store.close(), 'SPLIT_BRAIN');
    expect(fileSystem.sidecar).toBe(fileSystem.replacementContent);
    await store.close({ release: false });
  });

  it('requires explicit takeover of stale leases and detects the old writer as split-brain', async () => {
    let now = 2_000;
    const target = await createTarget();
    const first = createStore(target, {
      writerInstanceId: 'writer-a',
      leaseTtlMs: 100,
      clock: () => now,
    });
    await first.claim({ expectedTargetFingerprint: TARGET_FINGERPRINT });
    now += 101;
    await expectCode(first.preflightTarget(), 'WRITER_LEASE_STALE');
    const second = createStore(target, {
      writerInstanceId: 'writer-b',
      sessionId: SESSION_B,
      leaseTtlMs: 100,
      clock: () => now,
    });
    expect((await second.inspect()).state).toBe('stale');
    await expectCode(
      second.claim({ expectedTargetFingerprint: TARGET_FINGERPRINT }),
      'WRITER_LEASE_STALE',
    );
    const abandonedMutationLock = `${target}.writer.json.mutation-lock`;
    await writeFile(abandonedMutationLock, 'abandoned-lock-token', 'utf8');
    await second.claim({
      expectedTargetFingerprint: TARGET_FINGERPRINT,
      allowExpiredTakeover: true,
    });
    await expect(lstat(abandonedMutationLock)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await first.inspect()).state).toBe('split-brain');
    await first.close({ release: false });
    await second.close();
  });

  it('keeps exactly one writer when two explicit stale takeovers overlap', async () => {
    let now = 2_500;
    const target = await createTarget();
    const firstOwner = createStore(target, {
      writerInstanceId: 'writer-original',
      leaseTtlMs: 1,
      clock: () => now,
    });
    await firstOwner.claim({ expectedTargetFingerprint: TARGET_FINGERPRINT });
    now += 2;

    const pausedFileSystem = new PausedAtomicSwapFileSystem();
    const firstSuccessor = createStore(target, {
      writerInstanceId: 'writer-first-successor',
      sessionId: SESSION_B,
      documentSecret: Buffer.alloc(32, 0x61),
      leaseTtlMs: 1,
      clock: () => now,
      fileSystem: pausedFileSystem,
    });
    const secondSuccessor = createStore(target, {
      writerInstanceId: 'writer-second-successor',
      sessionId: SESSION_C,
      documentSecret: Buffer.alloc(32, 0x62),
      leaseTtlMs: 1,
      clock: () => now,
    });

    const firstTakeover = firstSuccessor.claim({
      expectedTargetFingerprint: TARGET_FINGERPRINT,
      allowExpiredTakeover: true,
    });
    await pausedFileSystem.firstWriteEntered.promise;

    await expect(
      secondSuccessor.claim({
        expectedTargetFingerprint: TARGET_FINGERPRINT,
        allowExpiredTakeover: true,
      }),
    ).resolves.toMatchObject({ writerInstanceId: 'writer-second-successor' });

    pausedFileSystem.releaseFirstWrite.resolve();
    await expectCode(firstTakeover, 'SPLIT_BRAIN');
    await expect(secondSuccessor.inspect()).resolves.toMatchObject({
      state: 'active-self',
      lease: { writerInstanceId: 'writer-second-successor' },
    });
    await expect(lstat(`${target}.writer.json.mutation-lock`)).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await firstOwner.close({ release: false });
    await firstSuccessor.close({ release: false });
    await secondSuccessor.close();
  }, 15_000);

  it('recognizes a crashed foreign-secret lease and requires stable explicit takeover', async () => {
    let now = 3_000;
    const target = await createTarget();
    const first = createStore(target, {
      writerInstanceId: 'writer-old-secret',
      documentSecret: Buffer.alloc(32, 0x31),
      leaseTtlMs: 20,
      clock: () => now,
    });
    await first.claim({ expectedTargetFingerprint: TARGET_FINGERPRINT });
    const successor = createStore(target, {
      writerInstanceId: 'writer-new-secret',
      sessionId: SESSION_B,
      documentSecret: Buffer.alloc(32, 0x32),
      leaseTtlMs: 20,
      clock: () => now,
    });
    expect(await successor.inspect()).toMatchObject({ state: 'active-other', verified: false });
    await expectCode(
      successor.claim({
        expectedTargetFingerprint: TARGET_FINGERPRINT,
        allowExpiredTakeover: true,
      }),
      'WRITER_LEASE_ACTIVE',
    );
    now += 21;
    expect(await successor.inspect()).toMatchObject({ state: 'stale', verified: false });
    await expectCode(
      successor.claim({ expectedTargetFingerprint: TARGET_FINGERPRINT }),
      'WRITER_LEASE_STALE',
    );
    const startedAt = Date.now();
    await successor.claim({
      expectedTargetFingerprint: TARGET_FINGERPRINT,
      allowExpiredTakeover: true,
    });
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
    await heartbeatOwner.claim({ expectedTargetFingerprint: TARGET_FINGERPRINT });
    heartbeatFs.beforeSwap = () => installCompetingLease(heartbeatTarget);
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
    const recordedLease = await recordOwner.claim({
      expectedTargetFingerprint: TARGET_FINGERPRINT,
    });
    const nextBytes = Buffer.from('snapshot-after-race');
    await writeFile(recordTarget, nextBytes);
    const nextFingerprint = fingerprintSharedTargetBytes(nextBytes);
    recordFs.beforeSwap = () => installCompetingLease(recordTarget, nextFingerprint);
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
    await releaseOwner.claim({ expectedTargetFingerprint: TARGET_FINGERPRINT });
    releaseFs.beforeDelete = () => installCompetingLease(releaseTarget);
    await expectCode(releaseOwner.release(), 'SPLIT_BRAIN');
    expect(JSON.parse(await readFile(`${releaseTarget}.writer.json`, 'utf8'))).toMatchObject({
      writerInstanceId: 'writer-racer',
    });
    await releaseOwner.close({ release: false });
  });

  it('rejects tampered sidecars and changed target fingerprints', async () => {
    const target = await createTarget();
    const first = createStore(target, { writerInstanceId: 'writer-a' });
    await first.claim({ expectedTargetFingerprint: TARGET_FINGERPRINT });
    const sidecar = `${target}.writer.json`;
    const parsed = JSON.parse(await readFile(sidecar, 'utf8')) as Record<string, unknown>;
    parsed.writerInstanceId = 'attacker';
    await writeFile(sidecar, JSON.stringify(parsed), 'utf8');
    const observer = createStore(target, { writerInstanceId: 'writer-b', sessionId: SESSION_B });
    expect((await observer.inspect()).state).toBe('tampered');
    await expectCode(
      observer.claim({ expectedTargetFingerprint: TARGET_FINGERPRINT }),
      'SIDECAR_TAMPERED',
    );
    await first.close({ release: false });
    await observer.close({ release: false });

    const secondTarget = await createTarget();
    const owner = createStore(secondTarget, { writerInstanceId: 'writer-c' });
    await owner.claim({ expectedTargetFingerprint: TARGET_FINGERPRINT });
    await writeFile(secondTarget, 'external-snapshot', 'utf8');
    await expectCode(owner.heartbeat(), 'TARGET_CHANGED');
    expect((await owner.inspect()).state).toBe('split-brain');
    await owner.close();
  });

  it('allows only one concurrent local claimant', async () => {
    const target = await createTarget();
    const first = createStore(target, { writerInstanceId: 'writer-a' });
    const second = createStore(target, { writerInstanceId: 'writer-b', sessionId: SESSION_B });
    const results = await Promise.allSettled([
      first.claim({ expectedTargetFingerprint: TARGET_FINGERPRINT }),
      second.claim({ expectedTargetFingerprint: TARGET_FINGERPRINT }),
    ]);
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
    const lease = await store.claim({ expectedTargetFingerprint: TARGET_FINGERPRINT });
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
