import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  truncate,
} from 'node:fs/promises';
import path from 'node:path';

import {
  appendJournalRecord,
  createJournalBytes,
  fingerprintFile,
  initializeJournalFile,
  PersistenceError,
  readHdeckFile,
  replayJournal,
  saveHdeckAtomic,
  sha256,
  type JournalHeader,
} from '@htmllelujah/hdeck';

import { DocumentRuntimeError } from './errors.js';
import type { ArchiveDurabilityCapability, JournalDurabilityCapability } from './types.js';

export const defaultJournalDurability: JournalDurabilityCapability = {
  initialize: initializeJournalFile,
  append: appendJournalRecord,
  read: async (target) => replayJournal(await readFile(target)),
  truncate: async (target, byteLength) => truncate(target, byteLength),
  remove: async (target) => rm(target, { force: true }),
};

export const defaultArchiveDurability: ArchiveDurabilityCapability = {
  open: async (target) => {
    const before = await fingerprintFile(target);
    if (before === null) {
      throw new PersistenceError('TARGET_UNAVAILABLE', 'The document does not exist.', false);
    }
    const parsed = await readHdeckFile(target);
    const after = await fingerprintFile(target);
    if (after === null || before !== after) {
      throw new PersistenceError('TARGET_CHANGED', 'The document changed while opening.', false);
    }
    return { parsed, fingerprint: after };
  },
  fingerprint: fingerprintFile,
  save: saveHdeckAtomic,
};

export interface RecoveryMetadata {
  readonly version: 1;
  readonly sessionId: string;
  readonly documentId: string;
  readonly targetPath: string | null;
  readonly targetFingerprint: string | null;
  readonly savedRevision: string;
  readonly persisted: boolean;
}

export interface RecoveryPaths {
  readonly base: string;
  readonly journal: string;
  readonly metadata: string;
}

export interface RecoveryBlobSweepOptions {
  readonly minimumAgeMs: number;
  readonly maxEntries: number;
  readonly maxDeletes: number;
  readonly nowMs?: number | undefined;
}

export interface RecoveryBlobSweepResult {
  readonly scanned: number;
  readonly deleted: number;
  readonly retained: number;
  readonly truncated: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseRecoveryMetadata = (input: unknown): RecoveryMetadata => {
  if (!isRecord(input))
    throw new DocumentRuntimeError('RECOVERY_INVALID', 'Recovery metadata is invalid.');
  const keys = new Set([
    'version',
    'sessionId',
    'documentId',
    'targetPath',
    'targetFingerprint',
    'savedRevision',
    'persisted',
  ]);
  if (Object.keys(input).some((key) => !keys.has(key))) {
    throw new DocumentRuntimeError('RECOVERY_INVALID', 'Recovery metadata has unknown fields.');
  }
  if (
    input.version !== 1 ||
    typeof input.sessionId !== 'string' ||
    typeof input.documentId !== 'string' ||
    (input.targetPath !== null && typeof input.targetPath !== 'string') ||
    (input.targetFingerprint !== null && typeof input.targetFingerprint !== 'string') ||
    typeof input.savedRevision !== 'string' ||
    typeof input.persisted !== 'boolean'
  ) {
    throw new DocumentRuntimeError('RECOVERY_INVALID', 'Recovery metadata fields are invalid.');
  }
  return {
    version: 1,
    sessionId: input.sessionId,
    documentId: input.documentId,
    targetPath: input.targetPath,
    targetFingerprint: input.targetFingerprint,
    savedRevision: input.savedRevision,
    persisted: input.persisted,
  };
};

const atomicWritePrivate = async (target: string, bytes: Uint8Array): Promise<void> => {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    created = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rm(target, { force: true });
    await rename(temporary, target);
    created = false;
  } finally {
    if (created) await rm(temporary, { force: true }).catch(() => undefined);
  }
};

export class RuntimeRecoveryStore {
  public constructor(public readonly root: string) {
    if (!path.isAbsolute(root)) {
      throw new DocumentRuntimeError(
        'INVALID_REQUEST',
        'The private recovery directory must be absolute.',
      );
    }
  }

  public async ensure(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, 'blobs'), { recursive: true });
  }

  public paths(sessionId: string): RecoveryPaths {
    return {
      base: path.join(this.root, `${sessionId}.base.hdeck`),
      journal: path.join(this.root, `${sessionId}.journal`),
      metadata: path.join(this.root, `${sessionId}.meta.json`),
    };
  }

  public async writeBase(sessionId: string, archive: Uint8Array): Promise<void> {
    await atomicWritePrivate(this.paths(sessionId).base, archive);
  }

  public async readBase(sessionId: string): Promise<Uint8Array> {
    try {
      return await readFile(this.paths(sessionId).base);
    } catch {
      throw new DocumentRuntimeError('RECOVERY_NOT_FOUND', 'Recovery base is unavailable.');
    }
  }

  public async writeMetadata(metadata: RecoveryMetadata): Promise<void> {
    await atomicWritePrivate(
      this.paths(metadata.sessionId).metadata,
      Buffer.from(JSON.stringify(metadata), 'utf8'),
    );
  }

  public async readMetadata(sessionId: string): Promise<RecoveryMetadata> {
    try {
      const value = JSON.parse(
        Buffer.from(await readFile(this.paths(sessionId).metadata)).toString('utf8'),
      ) as unknown;
      const parsed = parseRecoveryMetadata(value);
      if (parsed.sessionId !== sessionId) {
        throw new DocumentRuntimeError('RECOVERY_INVALID', 'Recovery session does not match.');
      }
      return parsed;
    } catch (error) {
      if (error instanceof DocumentRuntimeError) throw error;
      throw new DocumentRuntimeError('RECOVERY_NOT_FOUND', 'Recovery metadata is unavailable.');
    }
  }

  public async resetJournal(
    sessionId: string,
    header: JournalHeader,
    journal: JournalDurabilityCapability,
  ): Promise<void> {
    const target = this.paths(sessionId).journal;
    await atomicWritePrivate(target, createJournalBytes(header));
    // Exercise capability parsing/fault adapters on the freshly committed journal.
    await journal.read(target);
  }

  public async listCandidateIds(): Promise<readonly string[]> {
    await this.ensure();
    const entries = await readdir(this.root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.journal'))
      .map((entry) => entry.name.slice(0, -'.journal'.length))
      .filter((id) => id.length > 0)
      .sort();
  }

  public async removeSession(
    sessionId: string,
    journal: JournalDurabilityCapability,
  ): Promise<void> {
    const paths = this.paths(sessionId);
    await Promise.all([
      journal.remove(paths.journal).catch(() => undefined),
      rm(paths.base, { force: true }),
      rm(paths.metadata, { force: true }),
    ]);
  }

  public async putBlob(expectedHash: string, bytes: Uint8Array): Promise<void> {
    if (sha256(bytes) !== expectedHash) {
      throw new DocumentRuntimeError('INVALID_REQUEST', 'Asset bytes do not match their hash.');
    }
    const target = path.join(this.root, 'blobs', expectedHash);
    try {
      const metadata = await stat(target);
      if (!metadata.isFile() || sha256(await readFile(target)) !== expectedHash) {
        throw new DocumentRuntimeError('RECOVERY_INVALID', 'Stored asset blob is invalid.');
      }
      return;
    } catch (error) {
      if (error instanceof DocumentRuntimeError) throw error;
    }
    await atomicWritePrivate(target, bytes);
  }

  public async readBlob(hash: string): Promise<Uint8Array | undefined> {
    try {
      const bytes = await readFile(path.join(this.root, 'blobs', hash));
      if (sha256(bytes) !== hash) {
        throw new DocumentRuntimeError('RECOVERY_INVALID', 'Stored asset blob is invalid.');
      }
      return bytes;
    } catch (error) {
      if (error instanceof DocumentRuntimeError) throw error;
      return undefined;
    }
  }

  /**
   * Bounded private-store mark-and-sweep. Only canonical content-addressed regular files can be
   * removed; unknown files and links are deliberately ignored.
   */
  public async sweepBlobs(
    referencedHashes: ReadonlySet<string>,
    options: RecoveryBlobSweepOptions,
  ): Promise<RecoveryBlobSweepResult> {
    await this.ensure();
    const blobRoot = path.join(this.root, 'blobs');
    const entries = (await readdir(blobRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^[0-9a-f]{64}$/.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    const limit = Math.max(0, Math.floor(options.maxEntries));
    const candidates = entries.slice(0, limit);
    const nowMs = options.nowMs ?? Date.now();
    const minimumAgeMs = Math.max(0, options.minimumAgeMs);
    const maxDeletes = Math.max(0, Math.floor(options.maxDeletes));
    let deleted = 0;
    let retained = 0;
    for (const entry of candidates) {
      if (referencedHashes.has(entry.name) || deleted >= maxDeletes) {
        retained += 1;
        continue;
      }
      const target = path.join(blobRoot, entry.name);
      let metadata;
      try {
        metadata = await lstat(target);
      } catch {
        continue;
      }
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        nowMs - metadata.mtimeMs < minimumAgeMs
      ) {
        retained += 1;
        continue;
      }
      await rm(target, { force: true });
      deleted += 1;
    }
    return {
      scanned: candidates.length,
      deleted,
      retained,
      truncated: entries.length > candidates.length,
    };
  }
}
