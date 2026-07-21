import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  watch as watchDirectory,
  type BigIntStats,
  type FSWatcher,
} from 'node:fs';
import { lstat, open, readFile, rename, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { CollaborationError } from './errors.js';
import {
  constantTimeEqual,
  fingerprintBytes,
  normalizeDocumentSecret,
  signCanonicalPayload,
} from './transport/crypto.js';
import { certificateFingerprintSchema } from './transport/protocol.js';

const signatureSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const MUTATION_LOCK_SUFFIX = '.mutation-lock';
const RECOVER_MUTATION_LOCK: unique symbol = Symbol('recoverMutationLock');

/** `null` is the unambiguous identity of a target that does not exist yet. */
export type SharedTargetFingerprint = string | null;

export const writerLeaseBodySchema = z
  .object({
    schemaVersion: z.literal(1),
    signingKeyId: certificateFingerprintSchema,
    documentId: z.string().uuid(),
    sessionId: z.string().uuid(),
    writerInstanceId: z.string().trim().min(1).max(128),
    leaseId: z.string().uuid(),
    targetFingerprint: certificateFingerprintSchema.nullable(),
    issuedAtMs: z.number().int().nonnegative(),
    heartbeatAtMs: z.number().int().nonnegative(),
    expiresAtMs: z.number().int().positive(),
    heartbeatSeq: z.number().int().nonnegative(),
  })
  .strict();

export const signedWriterLeaseSchema = writerLeaseBodySchema
  .safeExtend({ signature: signatureSchema })
  .strict();

export type WriterLeaseBody = z.infer<typeof writerLeaseBodySchema>;
export type SignedWriterLease = z.infer<typeof signedWriterLeaseSchema>;

export type WriterLeaseStatus =
  | { readonly state: 'unclaimed'; readonly targetFingerprint: SharedTargetFingerprint }
  | { readonly state: 'active-self'; readonly lease: SignedWriterLease }
  | {
      readonly state: 'active-other';
      readonly lease: SignedWriterLease;
      readonly verified: boolean;
    }
  | {
      readonly state: 'stale';
      readonly lease: SignedWriterLease;
      readonly verified: boolean;
      readonly actualTargetFingerprint: SharedTargetFingerprint;
    }
  | { readonly state: 'tampered' }
  | {
      readonly state: 'target-changed';
      readonly lease: SignedWriterLease;
      readonly actualTargetFingerprint: SharedTargetFingerprint;
    }
  | { readonly state: 'split-brain'; readonly lease: SignedWriterLease };

export type WriterLeaseWatchEvent =
  | { readonly type: 'status'; readonly status: WriterLeaseStatus }
  | { readonly type: 'error'; readonly error: Error };

export interface SharedDriveFileSystem {
  readText(filePath: string): Promise<string | undefined>;
  writeExclusive(filePath: string, content: string): Promise<void>;
  compareAndSwapText(
    filePath: string,
    expectedContent: string,
    replacementContent: string,
    temporaryId: string,
  ): Promise<boolean>;
  compareAndDeleteText(
    filePath: string,
    expectedContent: string,
    temporaryId: string,
  ): Promise<boolean>;
  /** Module-private capability used only by the explicit stale-writer claim path. */
  [RECOVER_MUTATION_LOCK]?(filePath: string): Promise<boolean>;
  deleteFile(filePath: string): Promise<boolean>;
  fingerprint(filePath: string): Promise<SharedTargetFingerprint>;
  watch(directoryPath: string, listener: (fileName: string | undefined) => void): () => void;
}

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

const fingerprintFile = async (filePath: string): Promise<string> => {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => {
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return `sha256-${hash.digest('base64url')}`;
};

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly birthtimeNs: bigint;
}

const regularSingleLinkIdentity = (stats: BigIntStats): FileIdentity | undefined =>
  stats.isFile() && stats.nlink === 1n && stats.ino !== 0n
    ? { device: stats.dev, inode: stats.ino, birthtimeNs: stats.birthtimeNs }
    : undefined;

const pathIdentity = (stats: BigIntStats): FileIdentity => ({
  device: stats.dev,
  inode: stats.ino,
  birthtimeNs: stats.birthtimeNs,
});

const sameFileIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.device === right.device &&
  left.inode === right.inode &&
  left.birthtimeNs === right.birthtimeNs;

interface MutationLock {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly token: string;
  handle: FileHandle | undefined;
}

type MutationLockResult<T> =
  { readonly acquired: false } | { readonly acquired: true; readonly value: T };

const mutationLockBusyError = (): NodeJS.ErrnoException =>
  Object.assign(new Error('Shared sidecar mutation is already in progress.'), { code: 'EBUSY' });

const isMutationLockBusy = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'EBUSY';

export class NodeSharedDriveFileSystem implements SharedDriveFileSystem {
  public async readText(filePath: string): Promise<string | undefined> {
    try {
      return await readFile(filePath, 'utf8');
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  public async writeExclusive(filePath: string, content: string): Promise<void> {
    const result = await this.withMutationLock(filePath, async () => {
      await this.writeExclusiveUnlocked(filePath, content);
    });
    if (!result.acquired) throw mutationLockBusyError();
  }

  private async writeExclusiveUnlocked(filePath: string, content: string): Promise<void> {
    const handle = await open(filePath, 'wx', 0o600);
    const createdIdentity = regularSingleLinkIdentity(await handle.stat({ bigint: true }));
    let persistenceError: unknown;
    try {
      await this.persistExclusiveContent(handle, content, filePath);
    } catch (error) {
      persistenceError = error;
    }
    let closeError: unknown;
    try {
      await handle.close();
    } catch (error) {
      closeError = error;
    }
    if (persistenceError !== undefined || closeError !== undefined) {
      let cleanupError: unknown;
      try {
        if (createdIdentity !== undefined) {
          await this.cleanupFailedExclusiveWrite(filePath, createdIdentity);
        }
      } catch (error) {
        cleanupError = error;
      }
      const primaryError = persistenceError ?? closeError;
      if (cleanupError !== undefined) {
        throw new AggregateError(
          [primaryError, cleanupError],
          'Exclusive write failed and its exact partial file could not be cleaned up.',
        );
      }
      throw primaryError;
    }
  }

  private async tryAcquireMutationLock(filePath: string): Promise<MutationLock | undefined> {
    const lockPath = `${filePath}${MUTATION_LOCK_SUFFIX}`;
    const token = randomUUID();
    let handle: FileHandle;
    try {
      handle = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
      throw error;
    }

    let lock: MutationLock | undefined;
    try {
      const created = await handle.stat({ bigint: true });
      const identity = regularSingleLinkIdentity(created);
      if (identity === undefined) throw mutationLockBusyError();
      lock = { path: lockPath, identity, token, handle };
      await handle.writeFile(token, 'utf8');
      await handle.sync();
      if (!(await this.ownsMutationLock(lock))) throw mutationLockBusyError();
      return lock;
    } catch (error) {
      await handle.close().catch(() => undefined);
      if (lock !== undefined) {
        lock.handle = undefined;
        await this.removeOwnedMutationLock(lock, 'failed').catch(() => undefined);
      }
      throw error;
    }
  }

  /** Called only after the product's explicit stale-writer confirmation and observation window. */
  public async [RECOVER_MUTATION_LOCK](filePath: string): Promise<boolean> {
    const lockPath = `${filePath}${MUTATION_LOCK_SUFFIX}`;
    let metadata: BigIntStats;
    try {
      metadata = await lstat(lockPath, { bigint: true });
    } catch (error) {
      if (isMissing(error)) return true;
      throw error;
    }
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.nlink !== 1n ||
      metadata.size > 128n
    ) {
      return false;
    }
    const expectedIdentity = pathIdentity(metadata);
    const displaced = `${lockPath}.${randomUUID()}.recovered`;
    try {
      await rename(lockPath, displaced);
    } catch (error) {
      if (isMissing(error)) return true;
      throw error;
    }
    try {
      const moved = await lstat(displaced, { bigint: true });
      if (
        moved.isSymbolicLink() ||
        !moved.isFile() ||
        moved.nlink !== 1n ||
        moved.size > 128n ||
        !sameFileIdentity(pathIdentity(moved), expectedIdentity)
      ) {
        await rename(displaced, lockPath).catch(() => undefined);
        return false;
      }
      await unlink(displaced);
      return true;
    } catch {
      await rename(displaced, lockPath).catch(() => undefined);
      return false;
    }
  }

  private async ownsMutationLock(lock: MutationLock): Promise<boolean> {
    try {
      const metadata = await lstat(lock.path, { bigint: true });
      return (
        !metadata.isSymbolicLink() &&
        metadata.isFile() &&
        metadata.nlink === 1n &&
        metadata.size === BigInt(Buffer.byteLength(lock.token, 'utf8')) &&
        sameFileIdentity(pathIdentity(metadata), lock.identity) &&
        (await readFile(lock.path, 'utf8')) === lock.token
      );
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  private async releaseMutationLock(lock: MutationLock): Promise<boolean> {
    if (lock.handle !== undefined) {
      await lock.handle.close();
      lock.handle = undefined;
    }
    return this.removeOwnedMutationLock(lock, 'released');
  }

  private async removeOwnedMutationLock(
    lock: MutationLock,
    disposition: 'failed' | 'released',
  ): Promise<boolean> {
    if (!(await this.ownsMutationLock(lock))) return false;
    const displaced = `${lock.path}.${randomUUID()}.${disposition}`;
    try {
      await rename(lock.path, displaced);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    try {
      const moved = await lstat(displaced, { bigint: true });
      if (
        moved.isSymbolicLink() ||
        !moved.isFile() ||
        moved.nlink !== 1n ||
        moved.size !== BigInt(Buffer.byteLength(lock.token, 'utf8')) ||
        (await readFile(displaced, 'utf8')) !== lock.token ||
        !sameFileIdentity(pathIdentity(moved), lock.identity)
      ) {
        await rename(displaced, lock.path).catch(() => undefined);
        return false;
      }
      await unlink(displaced);
      return true;
    } catch {
      await rename(displaced, lock.path).catch(() => undefined);
      return false;
    }
  }

  private async withMutationLock<T>(
    filePath: string,
    operation: (lock: MutationLock) => Promise<T>,
  ): Promise<MutationLockResult<T>> {
    const lock = await this.tryAcquireMutationLock(filePath);
    if (lock === undefined) return { acquired: false };

    let value: T | undefined;
    let operationError: unknown;
    try {
      value = await operation(lock);
    } catch (error) {
      operationError = error;
    }

    let releaseError: unknown;
    let released = false;
    for (let attempt = 0; attempt < 2 && !released; attempt += 1) {
      try {
        released = await this.releaseMutationLock(lock);
        if (released) releaseError = undefined;
      } catch (error) {
        releaseError = error;
      }
    }
    if (!released && releaseError === undefined) releaseError = mutationLockBusyError();
    if (operationError !== undefined && releaseError !== undefined) {
      throw new AggregateError(
        [operationError, releaseError],
        'Sidecar mutation failed and its exact mutation lock could not be released.',
      );
    }
    if (releaseError !== undefined) throw releaseError;
    if (operationError !== undefined) throw operationError;
    return { acquired: true, value: value as T };
  }

  protected async persistExclusiveContent(
    handle: FileHandle,
    content: string,
    _filePath: string,
  ): Promise<void> {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  }

  /** Removes only the same one-link regular file created by `writeExclusive`. */
  protected async cleanupFailedExclusiveWrite(
    filePath: string,
    createdIdentity: FileIdentity,
  ): Promise<boolean> {
    let currentStats: BigIntStats;
    try {
      currentStats = await lstat(filePath, { bigint: true });
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    const currentIdentity = regularSingleLinkIdentity(currentStats);
    if (currentIdentity === undefined || !sameFileIdentity(currentIdentity, createdIdentity)) {
      return false;
    }
    await unlink(filePath);
    return true;
  }

  protected async commitAtomicText(
    filePath: string,
    content: string,
    temporaryId: string,
    beforeRename?: () => Promise<void>,
  ): Promise<void> {
    const temporaryPath = `${filePath}.${temporaryId}.tmp`;
    let created = false;
    try {
      const handle = await open(temporaryPath, 'wx', 0o600);
      created = true;
      try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await beforeRename?.();
      await rename(temporaryPath, filePath);
    } catch (error) {
      if (created) await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  public async compareAndSwapText(
    filePath: string,
    expectedContent: string,
    replacementContent: string,
    temporaryId: string,
  ): Promise<boolean> {
    const result = await this.withMutationLock(filePath, async (lock) => {
      let observed: string;
      try {
        observed = await readFile(filePath, 'utf8');
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
      if (observed !== expectedContent) return false;
      // The temporary file is fully persisted before rename, and rename replaces the active
      // pathname atomically. The mutation lock serializes cooperating writers without ever
      // moving the active sidecar out of its pathname during comparison.
      await this.commitAtomicText(filePath, replacementContent, temporaryId, async () => {
        if (!(await this.ownsMutationLock(lock))) throw mutationLockBusyError();
      });
      return (await this.readText(filePath)) === replacementContent;
    });
    return result.acquired ? (result.value ?? false) : false;
  }

  public async compareAndDeleteText(
    filePath: string,
    expectedContent: string,
    temporaryId: string,
  ): Promise<boolean> {
    void temporaryId;
    const result = await this.withMutationLock(filePath, async (lock) => {
      const observed = await this.readText(filePath);
      if (observed === undefined || observed !== expectedContent) return false;
      if (!(await this.ownsMutationLock(lock))) throw mutationLockBusyError();
      try {
        await unlink(filePath);
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    });
    return result.acquired ? (result.value ?? false) : false;
  }

  public async deleteFile(filePath: string): Promise<boolean> {
    try {
      await unlink(filePath);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  public async fingerprint(filePath: string): Promise<SharedTargetFingerprint> {
    try {
      return await fingerprintFile(filePath);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  public watch(
    directoryPath: string,
    listener: (fileName: string | undefined) => void,
  ): () => void {
    const watcher: FSWatcher = watchDirectory(
      directoryPath,
      { persistent: false },
      (_event, file) => listener(file?.toString()),
    );
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      watcher.close();
    };
  }
}

export interface WriterLeaseStoreOptions {
  /** Trusted main-process path. Never pass renderer-supplied paths directly. */
  readonly targetPath: string;
  readonly sidecarPath?: string;
  readonly documentId: string;
  readonly sessionId: string;
  readonly writerInstanceId: string;
  readonly documentSecret: Uint8Array;
  readonly leaseTtlMs?: number;
  readonly clock?: () => number;
  readonly idFactory?: () => string;
  readonly fileSystem?: SharedDriveFileSystem;
}

export class WriterLeaseStore {
  public readonly targetPath: string;
  public readonly sidecarPath: string;

  private readonly documentId: string;
  private readonly sessionId: string;
  private readonly writerInstanceId: string;
  private readonly documentSecret: Buffer;
  private readonly signingKeyId: string;
  private readonly leaseTtlMs: number;
  private readonly clock: () => number;
  private readonly idFactory: () => string;
  private readonly fileSystem: SharedDriveFileSystem;
  private readonly heartbeatStops = new Set<() => void>();
  private readonly watcherStops = new Set<() => void>();
  private ownedLease: SignedWriterLease | undefined;
  private closePromise: Promise<void> | undefined;

  public constructor(options: WriterLeaseStoreOptions) {
    this.targetPath = path.resolve(options.targetPath);
    this.sidecarPath = path.resolve(options.sidecarPath ?? `${this.targetPath}.writer.json`);
    if (
      !path.isAbsolute(options.targetPath) ||
      path.dirname(this.sidecarPath) !== path.dirname(this.targetPath) ||
      this.sidecarPath === this.targetPath
    ) {
      throw new CollaborationError(
        'PATH_NOT_ALLOWED',
        'Target and sidecar must be absolute sibling paths supplied by the trusted main process.',
      );
    }
    this.documentId = z.string().uuid().parse(options.documentId);
    this.sessionId = z.string().uuid().parse(options.sessionId);
    this.writerInstanceId = z.string().trim().min(1).max(128).parse(options.writerInstanceId);
    this.documentSecret = normalizeDocumentSecret(options.documentSecret);
    this.signingKeyId = fingerprintBytes(this.documentSecret);
    this.leaseTtlMs = options.leaseTtlMs ?? 45_000;
    this.clock = options.clock ?? (() => Date.now());
    this.idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
    this.fileSystem = options.fileSystem ?? new NodeSharedDriveFileSystem();
    if (!Number.isSafeInteger(this.leaseTtlMs) || this.leaseTtlMs < 1) {
      throw new CollaborationError(
        'INVALID_REQUEST',
        'Writer lease TTL must be a positive safe integer.',
      );
    }
  }

  public async inspect(): Promise<WriterLeaseStatus> {
    const actualTargetFingerprint = await this.fileSystem.fingerprint(this.targetPath);
    const raw = await this.fileSystem.readText(this.sidecarPath);
    if (raw === undefined)
      return { state: 'unclaimed', targetFingerprint: actualTargetFingerprint };
    const parsedLease = this.parseLease(raw);
    if (parsedLease === undefined || parsedLease.documentId !== this.documentId)
      return { state: 'tampered' };
    const lease = this.parseAndVerify(raw);
    if (lease === undefined) {
      if (this.ownedLease !== undefined) return { state: 'split-brain', lease: parsedLease };
      if (parsedLease.signingKeyId === this.signingKeyId) return { state: 'tampered' };
      return parsedLease.expiresAtMs <= this.clock()
        ? {
            state: 'stale',
            lease: parsedLease,
            verified: false,
            actualTargetFingerprint,
          }
        : { state: 'active-other', lease: parsedLease, verified: false };
    }
    if (lease.targetFingerprint !== actualTargetFingerprint) {
      if (this.ownedLease !== undefined) return { state: 'split-brain', lease };
      return { state: 'target-changed', lease, actualTargetFingerprint };
    }
    if (this.ownedLease !== undefined && lease.leaseId !== this.ownedLease.leaseId) {
      return { state: 'split-brain', lease };
    }
    if (lease.expiresAtMs <= this.clock()) {
      return { state: 'stale', lease, verified: true, actualTargetFingerprint };
    }
    return lease.writerInstanceId === this.writerInstanceId && lease.sessionId === this.sessionId
      ? { state: 'active-self', lease }
      : { state: 'active-other', lease, verified: true };
  }

  public async claim(options: {
    readonly expectedTargetFingerprint: SharedTargetFingerprint;
    readonly allowExpiredTakeover?: boolean;
  }): Promise<SignedWriterLease> {
    const expectedTargetFingerprint =
      options.expectedTargetFingerprint === null
        ? null
        : certificateFingerprintSchema.parse(options.expectedTargetFingerprint);
    const initialTargetFingerprint = await this.fileSystem.fingerprint(this.targetPath);
    if (initialTargetFingerprint !== expectedTargetFingerprint) {
      throw new CollaborationError(
        'TARGET_CHANGED',
        'Shared target changed since its source identity was captured.',
      );
    }
    const status = await this.inspect();
    if (status.state === 'tampered') {
      throw new CollaborationError('SIDECAR_TAMPERED', 'Writer sidecar signature is invalid.');
    }
    if (status.state === 'split-brain' || status.state === 'target-changed') {
      throw new CollaborationError(
        'SPLIT_BRAIN',
        'Writer ownership or target fingerprint diverged.',
      );
    }
    if (status.state === 'active-other') {
      throw new CollaborationError('WRITER_LEASE_ACTIVE', 'Another writer holds the active lease.');
    }
    if (status.state === 'active-self') {
      if (status.lease.targetFingerprint !== expectedTargetFingerprint) {
        throw new CollaborationError(
          'TARGET_CHANGED',
          'Shared target changed since its source identity was captured.',
        );
      }
      this.ownedLease = status.lease;
      return status.lease;
    }
    if (status.state === 'stale' && options.allowExpiredTakeover !== true) {
      throw new CollaborationError(
        'WRITER_LEASE_STALE',
        'The prior writer lease expired; explicit takeover is required.',
      );
    }

    let expectedStaleContent: string | undefined;
    if (status.state === 'stale') {
      expectedStaleContent = await this.fileSystem.readText(this.sidecarPath);
      if (expectedStaleContent === undefined) {
        throw new CollaborationError('SPLIT_BRAIN', 'Expired writer sidecar disappeared.');
      }
      const expectedTarget = await this.fileSystem.fingerprint(this.targetPath);
      await new Promise<void>((resolve) => setTimeout(resolve, this.leaseTtlMs));
      const [afterContent, afterTarget] = await Promise.all([
        this.fileSystem.readText(this.sidecarPath),
        this.fileSystem.fingerprint(this.targetPath),
      ]);
      const afterLease = afterContent === undefined ? undefined : this.parseLease(afterContent);
      if (
        afterContent !== expectedStaleContent ||
        afterTarget !== expectedTarget ||
        afterLease === undefined ||
        afterLease.expiresAtMs > this.clock()
      ) {
        throw new CollaborationError(
          'WRITER_LEASE_ACTIVE',
          'The prior writer changed during the safe takeover observation window.',
        );
      }
      if (
        this.fileSystem[RECOVER_MUTATION_LOCK] !== undefined &&
        !(await this.fileSystem[RECOVER_MUTATION_LOCK](this.sidecarPath))
      ) {
        throw new CollaborationError(
          'SPLIT_BRAIN',
          'Expired writer mutation lock could not be recovered exactly.',
        );
      }
    } else if (status.state === 'unclaimed' && options.allowExpiredTakeover === true) {
      const expectedTarget = status.targetFingerprint;
      await new Promise<void>((resolve) => setTimeout(resolve, this.leaseTtlMs));
      const [afterContent, afterTarget] = await Promise.all([
        this.fileSystem.readText(this.sidecarPath),
        this.fileSystem.fingerprint(this.targetPath),
      ]);
      if (afterContent !== undefined) {
        throw new CollaborationError(
          'WRITER_LEASE_ACTIVE',
          'A writer appeared during the safe orphan-reservation observation window.',
        );
      }
      if (afterTarget !== expectedTarget) {
        throw new CollaborationError(
          'TARGET_CHANGED',
          'Shared target changed during the safe orphan-reservation observation window.',
        );
      }
      if (
        this.fileSystem[RECOVER_MUTATION_LOCK] !== undefined &&
        !(await this.fileSystem[RECOVER_MUTATION_LOCK](this.sidecarPath))
      ) {
        throw new CollaborationError(
          'SPLIT_BRAIN',
          'Orphaned writer mutation lock could not be recovered exactly.',
        );
      }
    }

    const targetFingerprint = await this.fileSystem.fingerprint(this.targetPath);
    if (targetFingerprint !== expectedTargetFingerprint) {
      throw new CollaborationError(
        'TARGET_CHANGED',
        'Shared target changed since its source identity was captured.',
      );
    }
    const now = this.clock();
    const lease = this.signLease({
      schemaVersion: 1,
      signingKeyId: this.signingKeyId,
      documentId: this.documentId,
      sessionId: this.sessionId,
      writerInstanceId: this.writerInstanceId,
      leaseId: this.idFactory(),
      targetFingerprint,
      issuedAtMs: now,
      heartbeatAtMs: now,
      expiresAtMs: now + this.leaseTtlMs,
      heartbeatSeq: 0,
    });
    const provisionalContent = JSON.stringify(lease);
    let provisionalWritten = false;
    try {
      if (status.state === 'unclaimed') {
        await this.fileSystem.writeExclusive(this.sidecarPath, provisionalContent);
        provisionalWritten = true;
      } else {
        const replaced = await this.fileSystem.compareAndSwapText(
          this.sidecarPath,
          expectedStaleContent ?? '',
          provisionalContent,
          this.idFactory(),
        );
        if (!replaced) {
          throw new CollaborationError('SPLIT_BRAIN', 'Concurrent writer takeover detected.');
        }
        provisionalWritten = true;
      }
    } catch (error) {
      const observed = await this.inspect().catch(() => undefined);
      if (observed?.state === 'active-other' || observed?.state === 'split-brain') {
        throw new CollaborationError('SPLIT_BRAIN', 'Concurrent writer claim detected.');
      }
      if (status.state === 'unclaimed' && isMutationLockBusy(error)) {
        throw new CollaborationError(
          options.allowExpiredTakeover === true ? 'SPLIT_BRAIN' : 'WRITER_LEASE_STALE',
          options.allowExpiredTakeover === true
            ? 'Concurrent writer claim retained the mutation lock.'
            : 'A prior writer left an orphaned reservation; explicit recovery is required.',
        );
      }
      throw error;
    }
    try {
      const observedContent = (await this.fileSystem.readText(this.sidecarPath)) ?? '';
      const verified = this.parseAndVerify(observedContent);
      if (observedContent !== provisionalContent || verified?.leaseId !== lease.leaseId) {
        throw new CollaborationError(
          'SPLIT_BRAIN',
          'Concurrent writer claim replaced the sidecar.',
        );
      }
    } catch (error) {
      if (provisionalWritten) {
        const removed = await this.fileSystem
          .compareAndDeleteText(this.sidecarPath, provisionalContent, this.idFactory())
          .catch(() => false);
        if (!removed) {
          // Retain enough authority for close()/release() to retry cleanup. That retry still
          // compare-checks the exact signed bytes and therefore cannot delete a replacement.
          this.ownedLease = lease;
        }
      }
      throw error;
    }
    this.ownedLease = lease;
    return lease;
  }

  public async heartbeat(
    expectedTargetFingerprint?: SharedTargetFingerprint,
    extensionMs = this.leaseTtlMs,
  ): Promise<SignedWriterLease> {
    const owned = this.ownedLease;
    if (owned === undefined) {
      throw new CollaborationError(
        'LEASE_NOT_OWNED',
        'This process does not own the writer lease.',
      );
    }
    if (
      !Number.isSafeInteger(extensionMs) ||
      extensionMs < this.leaseTtlMs ||
      extensionMs > 10 * 60 * 1_000
    ) {
      throw new CollaborationError(
        'INVALID_REQUEST',
        'Writer lease extension must be bounded and at least the normal lease TTL.',
      );
    }
    const actualTargetFingerprint = await this.fileSystem.fingerprint(this.targetPath);
    if (
      actualTargetFingerprint !== owned.targetFingerprint ||
      (expectedTargetFingerprint !== undefined &&
        actualTargetFingerprint !== expectedTargetFingerprint)
    ) {
      throw new CollaborationError(
        'TARGET_CHANGED',
        'Shared target fingerprint changed before save.',
      );
    }
    const currentRaw = await this.fileSystem.readText(this.sidecarPath);
    const current = currentRaw === undefined ? undefined : this.parseAndVerify(currentRaw);
    if (
      current === undefined ||
      current.leaseId !== owned.leaseId ||
      current.writerInstanceId !== this.writerInstanceId
    ) {
      throw new CollaborationError('SPLIT_BRAIN', 'Writer sidecar no longer names this process.');
    }
    const now = this.clock();
    if (current.expiresAtMs <= now) {
      throw new CollaborationError(
        'WRITER_LEASE_STALE',
        'Writer lease expired; explicit recovery is required.',
      );
    }
    const { signature: _signature, ...currentBody } = current;
    const renewed = this.signLease({
      ...writerLeaseBodySchema.parse(currentBody),
      heartbeatAtMs: now,
      expiresAtMs: now + extensionMs,
      heartbeatSeq: current.heartbeatSeq + 1,
    });
    const replaced = await this.fileSystem.compareAndSwapText(
      this.sidecarPath,
      currentRaw ?? '',
      JSON.stringify(renewed),
      this.idFactory(),
    );
    if (!replaced) {
      throw new CollaborationError(
        'SPLIT_BRAIN',
        'Writer heartbeat lost a concurrent sidecar race.',
      );
    }
    const verified = this.parseAndVerify((await this.fileSystem.readText(this.sidecarPath)) ?? '');
    if (verified?.leaseId !== renewed.leaseId || verified.heartbeatSeq !== renewed.heartbeatSeq) {
      throw new CollaborationError(
        'SPLIT_BRAIN',
        'Writer heartbeat lost a concurrent sidecar race.',
      );
    }
    this.ownedLease = renewed;
    return renewed;
  }

  public async preflightTarget(
    expectedTargetFingerprint?: SharedTargetFingerprint,
  ): Promise<SharedTargetFingerprint> {
    const owned = this.ownedLease;
    if (owned === undefined) {
      throw new CollaborationError(
        'LEASE_NOT_OWNED',
        'This process does not own the writer lease.',
      );
    }
    const expected =
      expectedTargetFingerprint === undefined ? owned.targetFingerprint : expectedTargetFingerprint;
    const actual = await this.fileSystem.fingerprint(this.targetPath);
    if (actual !== expected || owned.targetFingerprint !== expected) {
      throw new CollaborationError(
        'TARGET_CHANGED',
        'Shared target fingerprint changed before save.',
      );
    }
    const currentRaw = await this.fileSystem.readText(this.sidecarPath);
    const current = currentRaw === undefined ? undefined : this.parseAndVerify(currentRaw);
    if (
      current?.leaseId !== owned.leaseId ||
      current.writerInstanceId !== this.writerInstanceId ||
      current.targetFingerprint !== expected
    ) {
      throw new CollaborationError('SPLIT_BRAIN', 'Writer sidecar changed before save.');
    }
    if (current.expiresAtMs <= this.clock()) {
      throw new CollaborationError(
        'WRITER_LEASE_STALE',
        'Writer lease expired; explicit recovery is required.',
      );
    }
    return actual;
  }

  /** Records the exact hash of an atomically committed snapshot after a successful preflight. */
  public async recordSnapshot(
    expectedPreviousFingerprint: SharedTargetFingerprint,
    expectedNewFingerprint: SharedTargetFingerprint,
  ): Promise<SignedWriterLease> {
    const owned = this.ownedLease;
    if (owned === undefined) {
      throw new CollaborationError(
        'LEASE_NOT_OWNED',
        'This process does not own the writer lease.',
      );
    }
    const actual = await this.fileSystem.fingerprint(this.targetPath);
    if (actual !== expectedNewFingerprint) {
      throw new CollaborationError(
        'TARGET_CHANGED',
        'Committed snapshot bytes do not match the expected new fingerprint.',
      );
    }
    const currentRaw = await this.fileSystem.readText(this.sidecarPath);
    const current = currentRaw === undefined ? undefined : this.parseAndVerify(currentRaw);
    if (
      current?.leaseId !== owned.leaseId ||
      current.writerInstanceId !== this.writerInstanceId ||
      current.targetFingerprint !== expectedPreviousFingerprint
    ) {
      throw new CollaborationError('SPLIT_BRAIN', 'Writer sidecar changed during snapshot commit.');
    }
    const now = this.clock();
    if (current.expiresAtMs <= now) {
      throw new CollaborationError(
        'WRITER_LEASE_STALE',
        'Writer lease expired; explicit recovery is required.',
      );
    }
    const { signature: _signature, ...currentBody } = current;
    const updated = this.signLease({
      ...writerLeaseBodySchema.parse(currentBody),
      targetFingerprint: expectedNewFingerprint,
      heartbeatAtMs: now,
      expiresAtMs: now + this.leaseTtlMs,
      heartbeatSeq: current.heartbeatSeq + 1,
    });
    const replaced = await this.fileSystem.compareAndSwapText(
      this.sidecarPath,
      currentRaw ?? '',
      JSON.stringify(updated),
      this.idFactory(),
    );
    if (!replaced) {
      throw new CollaborationError(
        'SPLIT_BRAIN',
        'Snapshot fingerprint update lost a sidecar race.',
      );
    }
    const verified = this.parseAndVerify((await this.fileSystem.readText(this.sidecarPath)) ?? '');
    if (
      verified?.leaseId !== updated.leaseId ||
      verified.targetFingerprint !== expectedNewFingerprint
    ) {
      throw new CollaborationError(
        'SPLIT_BRAIN',
        'Snapshot fingerprint update lost a sidecar race.',
      );
    }
    this.ownedLease = updated;
    return updated;
  }

  public async release(): Promise<boolean> {
    const owned = this.ownedLease;
    if (owned === undefined) return false;
    const raw = await this.fileSystem.readText(this.sidecarPath);
    if (raw === undefined) {
      this.ownedLease = undefined;
      return false;
    }
    const current = this.parseAndVerify(raw);
    if (current?.leaseId !== owned.leaseId || current.writerInstanceId !== this.writerInstanceId) {
      throw new CollaborationError('SPLIT_BRAIN', 'Refusing to release another writer sidecar.');
    }
    const deleted = await this.fileSystem.compareAndDeleteText(
      this.sidecarPath,
      raw,
      this.idFactory(),
    );
    if (!deleted) {
      throw new CollaborationError('SPLIT_BRAIN', 'Writer sidecar changed during release.');
    }
    this.ownedLease = undefined;
    return deleted;
  }

  public startHeartbeat(
    intervalMs = 10_000,
    onError: (error: Error) => void = () => undefined,
  ): () => void {
    if (intervalMs < 1 || intervalMs >= this.leaseTtlMs) {
      throw new CollaborationError(
        'INVALID_REQUEST',
        'Heartbeat interval must be positive and shorter than the writer lease TTL.',
      );
    }
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void this.heartbeat()
        .catch((error: unknown) =>
          onError(error instanceof Error ? error : new Error('Heartbeat failed.')),
        )
        .finally(() => {
          running = false;
        });
    }, intervalMs);
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      this.heartbeatStops.delete(stop);
    };
    this.heartbeatStops.add(stop);
    return stop;
  }

  public watch(listener: (event: WriterLeaseWatchEvent) => void, debounceMs = 50): () => void {
    if (!Number.isSafeInteger(debounceMs) || debounceMs < 0) {
      throw new CollaborationError(
        'INVALID_REQUEST',
        'Writer lease debounce must be a non-negative safe integer.',
      );
    }
    const targetName = path.basename(this.targetPath).toLowerCase();
    const sidecarName = path.basename(this.sidecarPath).toLowerCase();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopFileWatch = this.fileSystem.watch(path.dirname(this.targetPath), (fileName) => {
      if (
        fileName !== undefined &&
        fileName.toLowerCase() !== targetName &&
        fileName.toLowerCase() !== sidecarName
      ) {
        return;
      }
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        void this.inspect()
          .then((status) => listener({ type: 'status', status }))
          .catch((error: unknown) =>
            listener({
              type: 'error',
              error: error instanceof Error ? error : new Error('Writer lease inspection failed.'),
            }),
          );
      }, debounceMs);
    });
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      stopFileWatch();
      this.watcherStops.delete(stop);
    };
    this.watcherStops.add(stop);
    return stop;
  }

  public close(options: { readonly release?: boolean } = {}): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    const attempt = this.closeInternal(options.release ?? true);
    this.closePromise = attempt;
    void attempt.catch(() => {
      if (this.closePromise === attempt) this.closePromise = undefined;
    });
    return attempt;
  }

  private async closeInternal(releaseOwned: boolean): Promise<void> {
    this.heartbeatStops.forEach((stop) => stop());
    this.watcherStops.forEach((stop) => stop());
    if (releaseOwned) await this.release();
    this.documentSecret.fill(0);
  }

  private parseAndVerify(raw: string): SignedWriterLease | undefined {
    try {
      const parsed = signedWriterLeaseSchema.parse(JSON.parse(raw));
      const { signature, ...body } = parsed;
      const expected = signCanonicalPayload(this.documentSecret, writerLeaseBodySchema.parse(body));
      return constantTimeEqual(signature, expected) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private parseLease(raw: string): SignedWriterLease | undefined {
    try {
      return signedWriterLeaseSchema.parse(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  private signLease(body: WriterLeaseBody): SignedWriterLease {
    const parsed = writerLeaseBodySchema.parse(body);
    return signedWriterLeaseSchema.parse({
      ...parsed,
      signature: signCanonicalPayload(this.documentSecret, parsed),
    });
  }
}

export const fingerprintSharedTargetBytes = fingerprintBytes;
