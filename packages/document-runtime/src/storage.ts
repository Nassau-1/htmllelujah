import { randomUUID } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  opendir,
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

export type RecoveryAtomicWriteStep =
  | 'temporary-created'
  | 'temporary-written'
  | 'temporary-synced'
  | 'ready-published'
  | 'ready-directory-synced'
  | 'previous-published'
  | 'previous-directory-synced'
  | 'target-published'
  | 'target-directory-synced'
  | 'ready-removed'
  | 'previous-removed'
  | 'cleanup-directory-synced';

export interface RuntimeRecoveryStoreOptions {
  /** Maximum directory entries inspected during one startup reconciliation pass. */
  readonly startupReconciliationMaxEntries?: number | undefined;
  /** Maximum interrupted-write artifacts changed during one startup reconciliation pass. */
  readonly startupReconciliationMaxActions?: number | undefined;
  /** Deterministic crash boundary used only by durability fault-injection tests. */
  readonly testOnlyCrashAfterAtomicWriteStep?: RecoveryAtomicWriteStep | undefined;
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

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_RECONCILIATION_MAX_ENTRIES = 4_096;
const DEFAULT_RECONCILIATION_MAX_ACTIONS = 1_024;
const TRANSACTION_ARTIFACT_PATTERN =
  /^(.*)\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(tmp|ready|prev)$/i;

interface TransactionArtifact {
  readonly name: string;
  readonly targetName: string;
  readonly transactionId: string;
  readonly kind: 'tmp' | 'ready' | 'prev';
}

class SimulatedAtomicWriteCrash extends Error {
  public constructor(public readonly step: RecoveryAtomicWriteStep) {
    super(`Simulated crash after ${step}.`);
    this.name = 'SimulatedAtomicWriteCrash';
  }
}

const asErrorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

const isMissing = (error: unknown): boolean => asErrorCode(error) === 'ENOENT';

const boundedOption = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isSafeInteger(value) || value < 0 ? fallback : value;

const ensurePrivateDirectory = async (directory: string): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await chmod(directory, PRIVATE_DIRECTORY_MODE);
};

/** Node cannot fsync directory handles on Windows. The generation protocol remains crash-safe. */
const syncDirectory = async (directory: string): Promise<void> => {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (
      process.platform === 'win32' &&
      ['EACCES', 'EINVAL', 'EISDIR', 'ENOSYS', 'ENOTSUP', 'EPERM'].includes(
        asErrorCode(error) ?? '',
      )
    ) {
      return;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const parseTransactionArtifact = (name: string): TransactionArtifact | undefined => {
  const match = TRANSACTION_ARTIFACT_PATTERN.exec(name);
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined)
    return undefined;
  return {
    name,
    targetName: match[1],
    transactionId: match[2].toLowerCase(),
    kind: match[3] as TransactionArtifact['kind'],
  };
};

const regularFileState = async (target: string): Promise<'file' | 'missing' | 'unsafe'> => {
  try {
    const metadata = await lstat(target);
    return metadata.isFile() && !metadata.isSymbolicLink() ? 'file' : 'unsafe';
  } catch (error) {
    if (isMissing(error)) return 'missing';
    throw error;
  }
};

/** Publishes a complete generation only when the canonical path is still absent. */
const publishGeneration = async (source: string, target: string): Promise<void> => {
  await link(source, target);
  await chmod(target, PRIVATE_FILE_MODE);
};

const repairKnownTransaction = async (
  target: string,
  temporary: string,
  ready: string,
  previous: string,
): Promise<void> => {
  let targetState = await regularFileState(target).catch(() => 'unsafe' as const);
  if (targetState === 'missing') {
    for (const candidate of [ready, previous]) {
      if ((await regularFileState(candidate).catch(() => 'missing' as const)) !== 'file') continue;
      try {
        await publishGeneration(candidate, target);
        await syncDirectory(path.dirname(target));
        targetState = 'file';
        break;
      } catch (error) {
        if (asErrorCode(error) === 'EEXIST') targetState = 'file';
      }
    }
  }
  if (targetState === 'file') {
    await Promise.all(
      [temporary, ready, previous].map((candidate) =>
        rm(candidate, { force: true }).catch(() => undefined),
      ),
    );
  } else {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
};

const targetWriteLocks = new Map<string, Promise<void>>();

const withTargetWriteLock = async <T>(target: string, operation: () => Promise<T>): Promise<T> => {
  const key = path.resolve(target);
  const predecessor = targetWriteLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  targetWriteLocks.set(key, current);
  await predecessor.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (targetWriteLocks.get(key) === current) targetWriteLocks.delete(key);
  }
};

const atomicWritePrivate = async (
  target: string,
  bytes: Uint8Array,
  crashAfterStep?: RecoveryAtomicWriteStep,
): Promise<void> =>
  withTargetWriteLock(target, async () => {
    const directory = path.dirname(target);
    await ensurePrivateDirectory(directory);
    const transactionId = randomUUID();
    const temporary = `${target}.${transactionId}.tmp`;
    const ready = `${target}.${transactionId}.ready`;
    const previous = `${target}.${transactionId}.prev`;
    let simulatedCrash = false;
    const checkpoint = (step: RecoveryAtomicWriteStep): void => {
      if (crashAfterStep === step) {
        simulatedCrash = true;
        throw new SimulatedAtomicWriteCrash(step);
      }
    };

    try {
      const handle = await open(temporary, 'wx', PRIVATE_FILE_MODE);
      try {
        checkpoint('temporary-created');
        await handle.writeFile(bytes);
        checkpoint('temporary-written');
        await handle.sync();
        checkpoint('temporary-synced');
      } finally {
        await handle.close();
      }

      await rename(temporary, ready);
      checkpoint('ready-published');
      await syncDirectory(directory);
      checkpoint('ready-directory-synced');

      const targetState = await regularFileState(target);
      if (targetState === 'unsafe') {
        throw new DocumentRuntimeError(
          'RECOVERY_INVALID',
          'The private recovery target is not a regular file.',
        );
      }
      if (targetState === 'file') {
        await rename(target, previous);
        checkpoint('previous-published');
        await syncDirectory(directory);
        checkpoint('previous-directory-synced');
      }

      await publishGeneration(ready, target);
      checkpoint('target-published');
      await syncDirectory(directory);
      checkpoint('target-directory-synced');
      await rm(ready, { force: true });
      checkpoint('ready-removed');
      await rm(previous, { force: true });
      checkpoint('previous-removed');
      await syncDirectory(directory);
      checkpoint('cleanup-directory-synced');
    } catch (error) {
      if (!simulatedCrash) {
        await repairKnownTransaction(target, temporary, ready, previous).catch(() => undefined);
      }
      throw error;
    } finally {
      if (!simulatedCrash) {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    }
  });

const reconcileInterruptedWrites = async (
  directory: string,
  maxEntries: number,
  maxActions: number,
): Promise<void> => {
  const artifacts: TransactionArtifact[] = [];
  const directoryHandle = await opendir(directory);
  let scanned = 0;
  try {
    for await (const entry of directoryHandle) {
      if (scanned >= maxEntries) break;
      scanned += 1;
      if (!entry.isFile()) continue;
      const artifact = parseTransactionArtifact(entry.name);
      if (artifact !== undefined) artifacts.push(artifact);
    }
  } finally {
    await directoryHandle.close().catch(() => undefined);
  }

  const grouped = new Map<string, TransactionArtifact[]>();
  for (const artifact of artifacts) {
    const group = grouped.get(artifact.targetName) ?? [];
    group.push(artifact);
    grouped.set(artifact.targetName, group);
  }

  let actions = 0;
  for (const [targetName, group] of [...grouped.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (actions >= maxActions) break;
    const target = path.join(directory, targetName);
    let targetState = await regularFileState(target).catch(() => 'unsafe' as const);
    if (targetState === 'missing') {
      const complete =
        group.find((artifact) => artifact.kind === 'ready') ??
        group.find((artifact) => artifact.kind === 'prev');
      if (complete !== undefined) {
        try {
          await publishGeneration(path.join(directory, complete.name), target);
          await syncDirectory(directory);
          targetState = 'file';
          actions += 1;
        } catch (error) {
          if (asErrorCode(error) === 'EEXIST') targetState = 'file';
        }
      }
    }
    if (targetState === 'missing') {
      for (const artifact of group.filter((candidate) => candidate.kind === 'tmp')) {
        if (actions >= maxActions) break;
        try {
          await rm(path.join(directory, artifact.name), { force: true });
          actions += 1;
        } catch {
          // A locked incomplete staging file is harmless and can be retried next startup.
        }
      }
      continue;
    }
    if (targetState !== 'file') continue;
    for (const artifact of group.sort((left, right) => left.name.localeCompare(right.name))) {
      if (actions >= maxActions) break;
      try {
        await rm(path.join(directory, artifact.name), { force: true });
        actions += 1;
      } catch {
        // Locked generations remain valid and are retried by a later process startup.
      }
    }
  }
  if (actions > 0) await syncDirectory(directory);
};

export class RuntimeRecoveryStore {
  readonly #options: RuntimeRecoveryStoreOptions;
  #initialization: Promise<void> | undefined;

  public constructor(
    public readonly root: string,
    options: RuntimeRecoveryStoreOptions = {},
  ) {
    if (!path.isAbsolute(root)) {
      throw new DocumentRuntimeError(
        'INVALID_REQUEST',
        'The private recovery directory must be absolute.',
      );
    }
    this.#options = options;
  }

  public async ensure(): Promise<void> {
    this.#initialization ??= (async () => {
      const blobRoot = path.join(this.root, 'blobs');
      await ensurePrivateDirectory(this.root);
      await ensurePrivateDirectory(blobRoot);
      const maxEntries = boundedOption(
        this.#options.startupReconciliationMaxEntries,
        DEFAULT_RECONCILIATION_MAX_ENTRIES,
      );
      const maxActions = boundedOption(
        this.#options.startupReconciliationMaxActions,
        DEFAULT_RECONCILIATION_MAX_ACTIONS,
      );
      await reconcileInterruptedWrites(this.root, maxEntries, maxActions);
      await reconcileInterruptedWrites(blobRoot, maxEntries, maxActions);
    })().catch((error: unknown) => {
      this.#initialization = undefined;
      throw error;
    });
    await this.#initialization;
  }

  public paths(sessionId: string): RecoveryPaths {
    return {
      base: path.join(this.root, `${sessionId}.base.hdeck`),
      journal: path.join(this.root, `${sessionId}.journal`),
      metadata: path.join(this.root, `${sessionId}.meta.json`),
    };
  }

  public async writeBase(sessionId: string, archive: Uint8Array): Promise<void> {
    await this.ensure();
    await atomicWritePrivate(
      this.paths(sessionId).base,
      archive,
      this.#options.testOnlyCrashAfterAtomicWriteStep,
    );
  }

  public async readBase(sessionId: string): Promise<Uint8Array> {
    await this.ensure();
    try {
      return await readFile(this.paths(sessionId).base);
    } catch {
      throw new DocumentRuntimeError('RECOVERY_NOT_FOUND', 'Recovery base is unavailable.');
    }
  }

  public async writeMetadata(metadata: RecoveryMetadata): Promise<void> {
    await this.ensure();
    await atomicWritePrivate(
      this.paths(metadata.sessionId).metadata,
      Buffer.from(JSON.stringify(metadata), 'utf8'),
      this.#options.testOnlyCrashAfterAtomicWriteStep,
    );
  }

  public async readMetadata(sessionId: string): Promise<RecoveryMetadata> {
    await this.ensure();
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
    await this.ensure();
    const target = this.paths(sessionId).journal;
    await atomicWritePrivate(
      target,
      createJournalBytes(header),
      this.#options.testOnlyCrashAfterAtomicWriteStep,
    );
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
    await this.ensure();
    const paths = this.paths(sessionId);
    await Promise.all([
      journal.remove(paths.journal).catch(() => undefined),
      rm(paths.base, { force: true }),
      rm(paths.metadata, { force: true }),
    ]);
  }

  public async putBlob(expectedHash: string, bytes: Uint8Array): Promise<void> {
    await this.ensure();
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
    await atomicWritePrivate(target, bytes, this.#options.testOnlyCrashAfterAtomicWriteStep);
  }

  public async readBlob(hash: string): Promise<Uint8Array | undefined> {
    await this.ensure();
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
