import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { HDECK_LIMITS, parseHdeckArchive, sha256 } from './archive.js';

export type SaveErrorCode =
  | 'TARGET_UNAVAILABLE'
  | 'TARGET_CHANGED'
  | 'OVERWRITE_REQUIRES_APPROVAL'
  | 'DISK_FULL'
  | 'ARCHIVE_INVALID';

export class PersistenceError extends Error {
  public constructor(
    public readonly code: SaveErrorCode,
    message: string,
    public readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PersistenceError';
  }
}

export interface AtomicSaveOptions {
  /** SHA-256 fingerprint observed when the document was opened. `null` means no file existed. */
  readonly expectedFingerprint?: string | null | undefined;
  readonly allowOverwrite?: boolean | undefined;
  /** Trusted authority check invoked after the final target CAS and directly before rename. */
  readonly beforeCommit?: (() => Promise<void>) | undefined;
}

export interface AtomicSaveResult {
  readonly status: 'saved';
  readonly fingerprint: string;
  readonly byteLength: number;
}

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error;

const mapFilesystemError = (error: unknown): PersistenceError => {
  if (error instanceof PersistenceError) return error;
  if (isNodeError(error) && (error.code === 'ENOSPC' || error.code === 'EDQUOT')) {
    return new PersistenceError('DISK_FULL', 'The destination has insufficient space.', true);
  }
  return new PersistenceError('TARGET_UNAVAILABLE', 'The destination is unavailable.', true);
};

const isSaveErrorCode = (value: unknown): value is SaveErrorCode =>
  value === 'TARGET_UNAVAILABLE' ||
  value === 'TARGET_CHANGED' ||
  value === 'OVERWRITE_REQUIRES_APPROVAL' ||
  value === 'DISK_FULL' ||
  value === 'ARCHIVE_INVALID';

const mapCommitGuardError = (error: unknown): PersistenceError => {
  if (error instanceof PersistenceError) return error;
  const reportedCode =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  const code = isSaveErrorCode(reportedCode) ? reportedCode : 'TARGET_CHANGED';
  return new PersistenceError(
    code,
    'Save authority changed before the destination commit.',
    code === 'DISK_FULL' || code === 'TARGET_UNAVAILABLE',
    { cause: error },
  );
};

const assertRegularTarget = async (target: string): Promise<void> => {
  try {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new PersistenceError(
        'TARGET_UNAVAILABLE',
        'The destination is not a regular file.',
        false,
      );
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
};

export const fingerprintFile = async (target: string): Promise<string | null> => {
  try {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new PersistenceError(
        'TARGET_UNAVAILABLE',
        'The destination is not a regular file.',
        false,
      );
    }
    if (metadata.size > HDECK_LIMITS.maxArchiveBytes) {
      throw new PersistenceError('ARCHIVE_INVALID', 'The destination is too large.', false);
    }
    return sha256(await readFile(target));
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw mapFilesystemError(error);
  }
};

const syncDirectoryBestEffort = async (directory: string): Promise<void> => {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is not available on every supported Windows filesystem.
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

interface TemporaryFileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly birthtimeNs: bigint;
}

const temporaryFileIdentity = (metadata: BigIntStats): TemporaryFileIdentity => ({
  device: metadata.dev,
  inode: metadata.ino,
  birthtimeNs: metadata.birthtimeNs,
});

const sameTemporaryFile = (left: TemporaryFileIdentity, right: TemporaryFileIdentity): boolean =>
  left.device === right.device &&
  left.inode === right.inode &&
  left.birthtimeNs === right.birthtimeNs;

const invalidTemporaryArchive = (message: string, cause?: unknown): PersistenceError =>
  new PersistenceError(
    'ARCHIVE_INVALID',
    message,
    false,
    cause === undefined ? undefined : { cause },
  );

const inspectOwnedTemporaryArchive = async (
  temporary: string,
  expectedIdentity: TemporaryFileIdentity,
  expectedByteLength: number,
  expectedFingerprint: string,
): Promise<void> => {
  try {
    const before = await lstat(temporary, { bigint: true });
    const beforeIdentity = temporaryFileIdentity(before);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size !== BigInt(expectedByteLength) ||
      !sameTemporaryFile(beforeIdentity, expectedIdentity)
    ) {
      throw invalidTemporaryArchive('Temporary archive identity or length is inconsistent.');
    }

    const reopened = await readFile(temporary);
    const after = await lstat(temporary, { bigint: true });
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.nlink !== 1n ||
      after.size !== before.size ||
      !sameTemporaryFile(temporaryFileIdentity(after), beforeIdentity)
    ) {
      throw invalidTemporaryArchive('Temporary archive changed while it was being verified.');
    }
    parseHdeckArchive(reopened);
    if (sha256(reopened) !== expectedFingerprint) {
      throw invalidTemporaryArchive('Temporary archive fingerprint is inconsistent.');
    }
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    throw invalidTemporaryArchive('Temporary archive could not be verified.', error);
  }
};

const removeOwnedTemporaryBestEffort = async (
  temporary: string,
  expectedIdentity: TemporaryFileIdentity | undefined,
): Promise<void> => {
  if (expectedIdentity === undefined) return;
  try {
    const metadata = await lstat(temporary, { bigint: true });
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.nlink !== 1n ||
      !sameTemporaryFile(temporaryFileIdentity(metadata), expectedIdentity)
    ) {
      return;
    }
    await rm(temporary);
  } catch {
    // Cleanup is best effort and must never remove a path substituted by another process.
  }
};

export const saveHdeckAtomic = async (
  target: string,
  archive: Uint8Array,
  options: AtomicSaveOptions = {},
): Promise<AtomicSaveResult> => {
  if (!path.isAbsolute(target) || path.extname(target).toLocaleLowerCase('en-US') !== '.hdeck') {
    throw new PersistenceError(
      'TARGET_UNAVAILABLE',
      'A validated absolute .hdeck target is required.',
      false,
    );
  }
  if (archive.byteLength === 0 || archive.byteLength > HDECK_LIMITS.maxArchiveBytes) {
    throw new PersistenceError(
      'ARCHIVE_INVALID',
      'Archive bytes are outside supported limits.',
      false,
    );
  }
  try {
    parseHdeckArchive(archive);
  } catch {
    throw new PersistenceError('ARCHIVE_INVALID', 'Archive validation failed before save.', false);
  }

  const directory = path.dirname(target);
  const baseName = path.basename(target);
  await mkdir(directory, { recursive: true });
  await assertRegularTarget(target);
  const observed = await fingerprintFile(target);
  if (options.expectedFingerprint !== undefined && observed !== options.expectedFingerprint) {
    throw new PersistenceError(
      'TARGET_CHANGED',
      'The destination changed since it was opened.',
      false,
    );
  }
  if (
    observed !== null &&
    options.expectedFingerprint === undefined &&
    options.allowOverwrite !== true
  ) {
    throw new PersistenceError(
      'OVERWRITE_REQUIRES_APPROVAL',
      'Replacing an existing file requires explicit approval.',
      false,
    );
  }

  const temporary = path.join(directory, `.${baseName}.${randomUUID()}.tmp`);
  let temporaryCreated = false;
  let temporaryIdentity: TemporaryFileIdentity | undefined;
  let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    temporaryHandle = await open(temporary, 'wx', 0o600);
    temporaryCreated = true;
    temporaryIdentity = temporaryFileIdentity(await temporaryHandle.stat({ bigint: true }));
    await temporaryHandle.writeFile(archive);
    await temporaryHandle.sync();

    const fingerprint = sha256(archive);
    await inspectOwnedTemporaryArchive(
      temporary,
      temporaryIdentity,
      archive.byteLength,
      fingerprint,
    );

    await assertRegularTarget(target);
    const beforeCommit = await fingerprintFile(target);
    if (beforeCommit !== observed) {
      throw new PersistenceError('TARGET_CHANGED', 'The destination changed during save.', false);
    }
    if (options.beforeCommit !== undefined) {
      try {
        await options.beforeCommit();
      } catch (error) {
        throw mapCommitGuardError(error);
      }
    }
    await assertRegularTarget(target);
    const immediatelyBeforeRename = await fingerprintFile(target);
    if (immediatelyBeforeRename !== observed) {
      throw new PersistenceError('TARGET_CHANGED', 'The destination changed during save.', false);
    }
    // The authority callback is asynchronous. Re-prove both the bytes and the exact temporary
    // file identity afterwards so a sibling-path substitution is rejected before target rename.
    await inspectOwnedTemporaryArchive(
      temporary,
      temporaryIdentity,
      archive.byteLength,
      fingerprint,
    );
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await rename(temporary, target);
    temporaryCreated = false;
    await syncDirectoryBestEffort(directory);
    const committed = await fingerprintFile(target);
    if (committed !== fingerprint) {
      throw new PersistenceError(
        'ARCHIVE_INVALID',
        'Committed archive fingerprint is inconsistent.',
        false,
      );
    }
    return { status: 'saved', fingerprint, byteLength: archive.byteLength };
  } catch (error) {
    throw mapFilesystemError(error);
  } finally {
    await temporaryHandle?.close().catch(() => undefined);
    if (temporaryCreated) {
      await removeOwnedTemporaryBestEffort(temporary, temporaryIdentity);
    }
  }
};

export const readHdeckFile = async (
  target: string,
): Promise<ReturnType<typeof parseHdeckArchive>> => {
  await assertRegularTarget(target);
  const metadata = await stat(target);
  if (metadata.size > HDECK_LIMITS.maxArchiveBytes) {
    throw new PersistenceError('ARCHIVE_INVALID', 'Archive is too large.', false);
  }
  return parseHdeckArchive(await readFile(target));
};
