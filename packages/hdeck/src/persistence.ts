import { randomUUID } from 'node:crypto';
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
  ) {
    super(message);
    this.name = 'PersistenceError';
  }
}

export interface AtomicSaveOptions {
  /** SHA-256 fingerprint observed when the document was opened. `null` means no file existed. */
  readonly expectedFingerprint?: string | null | undefined;
  readonly allowOverwrite?: boolean | undefined;
}

export interface AtomicSaveResult {
  readonly status: 'saved';
  readonly fingerprint: string;
  readonly byteLength: number;
}

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
};

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error;

const mapFilesystemError = (error: unknown): PersistenceError => {
  if (error instanceof PersistenceError) return error;
  if (isNodeError(error) && (error.code === 'ENOSPC' || error.code === 'EDQUOT')) {
    return new PersistenceError('DISK_FULL', 'The destination has insufficient space.', true);
  }
  return new PersistenceError('TARGET_UNAVAILABLE', 'The destination is unavailable.', true);
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
  try {
    const handle = await open(temporary, 'wx', 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(archive);
      await handle.sync();
    } finally {
      await handle.close();
    }

    const writtenMetadata = await stat(temporary);
    if (!writtenMetadata.isFile() || writtenMetadata.size !== archive.byteLength) {
      throw new PersistenceError(
        'ARCHIVE_INVALID',
        'Temporary archive length is inconsistent.',
        false,
      );
    }
    const reopened = await readFile(temporary);
    parseHdeckArchive(reopened);
    const fingerprint = sha256(reopened);
    if (fingerprint !== sha256(archive)) {
      throw new PersistenceError(
        'ARCHIVE_INVALID',
        'Temporary archive fingerprint is inconsistent.',
        false,
      );
    }

    await assertRegularTarget(target);
    const beforeCommit = await fingerprintFile(target);
    if (beforeCommit !== observed) {
      throw new PersistenceError('TARGET_CHANGED', 'The destination changed during save.', false);
    }
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
    if (temporaryCreated && (await pathExists(temporary).catch(() => false))) {
      await rm(temporary, { force: true }).catch(() => undefined);
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
