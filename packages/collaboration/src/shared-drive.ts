import { createHash } from 'node:crypto';
import { createReadStream, watch as watchDirectory, type FSWatcher } from 'node:fs';
import { open, readFile, rename, unlink } from 'node:fs/promises';
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

export const writerLeaseBodySchema = z
  .object({
    schemaVersion: z.literal(1),
    documentId: z.string().uuid(),
    sessionId: z.string().uuid(),
    writerInstanceId: z.string().trim().min(1).max(128),
    leaseId: z.string().uuid(),
    targetFingerprint: certificateFingerprintSchema,
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
  | { readonly state: 'unclaimed'; readonly targetFingerprint: string }
  | { readonly state: 'active-self'; readonly lease: SignedWriterLease }
  | { readonly state: 'active-other'; readonly lease: SignedWriterLease }
  | { readonly state: 'stale'; readonly lease: SignedWriterLease }
  | { readonly state: 'tampered' }
  | {
      readonly state: 'target-changed';
      readonly lease: SignedWriterLease;
      readonly actualTargetFingerprint: string;
    }
  | { readonly state: 'split-brain'; readonly lease: SignedWriterLease };

export type WriterLeaseWatchEvent =
  | { readonly type: 'status'; readonly status: WriterLeaseStatus }
  | { readonly type: 'error'; readonly error: Error };

export interface SharedDriveFileSystem {
  readText(filePath: string): Promise<string | undefined>;
  writeExclusive(filePath: string, content: string): Promise<void>;
  writeAtomic(filePath: string, content: string, temporaryId: string): Promise<void>;
  deleteFile(filePath: string): Promise<boolean>;
  fingerprint(filePath: string): Promise<string>;
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
    const handle = await open(filePath, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  public async writeAtomic(filePath: string, content: string, temporaryId: string): Promise<void> {
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
      await rename(temporaryPath, filePath);
    } catch (error) {
      if (created) await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
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

  public fingerprint(filePath: string): Promise<string> {
    return fingerprintFile(filePath);
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
    const lease = this.parseAndVerify(raw);
    if (lease === undefined || lease.documentId !== this.documentId) return { state: 'tampered' };
    if (lease.targetFingerprint !== actualTargetFingerprint) {
      if (this.ownedLease !== undefined) return { state: 'split-brain', lease };
      return { state: 'target-changed', lease, actualTargetFingerprint };
    }
    if (this.ownedLease !== undefined && lease.leaseId !== this.ownedLease.leaseId) {
      return { state: 'split-brain', lease };
    }
    if (lease.expiresAtMs <= this.clock()) return { state: 'stale', lease };
    return lease.writerInstanceId === this.writerInstanceId && lease.sessionId === this.sessionId
      ? { state: 'active-self', lease }
      : { state: 'active-other', lease };
  }

  public async claim(
    options: { readonly allowExpiredTakeover?: boolean } = {},
  ): Promise<SignedWriterLease> {
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
      this.ownedLease = status.lease;
      return status.lease;
    }
    if (status.state === 'stale' && options.allowExpiredTakeover !== true) {
      throw new CollaborationError(
        'WRITER_LEASE_STALE',
        'The prior writer lease expired; explicit takeover is required.',
      );
    }

    const now = this.clock();
    const targetFingerprint =
      status.state === 'unclaimed'
        ? status.targetFingerprint
        : await this.fileSystem.fingerprint(this.targetPath);
    const lease = this.signLease({
      schemaVersion: 1,
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
    try {
      if (status.state === 'unclaimed') {
        await this.fileSystem.writeExclusive(this.sidecarPath, JSON.stringify(lease));
      } else {
        await this.fileSystem.writeAtomic(
          this.sidecarPath,
          JSON.stringify(lease),
          this.idFactory(),
        );
      }
    } catch (error) {
      const observed = await this.inspect().catch(() => undefined);
      if (observed?.state === 'active-other' || observed?.state === 'split-brain') {
        throw new CollaborationError('SPLIT_BRAIN', 'Concurrent writer claim detected.');
      }
      throw error;
    }
    const verified = this.parseAndVerify((await this.fileSystem.readText(this.sidecarPath)) ?? '');
    if (verified?.leaseId !== lease.leaseId) {
      throw new CollaborationError('SPLIT_BRAIN', 'Concurrent writer claim replaced the sidecar.');
    }
    this.ownedLease = lease;
    return lease;
  }

  public async heartbeat(expectedTargetFingerprint?: string): Promise<SignedWriterLease> {
    const owned = this.ownedLease;
    if (owned === undefined) {
      throw new CollaborationError(
        'LEASE_NOT_OWNED',
        'This process does not own the writer lease.',
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
      expiresAtMs: now + this.leaseTtlMs,
      heartbeatSeq: current.heartbeatSeq + 1,
    });
    await this.fileSystem.writeAtomic(this.sidecarPath, JSON.stringify(renewed), this.idFactory());
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

  public async preflightTarget(expectedTargetFingerprint?: string): Promise<string> {
    const owned = this.ownedLease;
    if (owned === undefined) {
      throw new CollaborationError(
        'LEASE_NOT_OWNED',
        'This process does not own the writer lease.',
      );
    }
    const expected = expectedTargetFingerprint ?? owned.targetFingerprint;
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
    expectedPreviousFingerprint: string,
    expectedNewFingerprint: string,
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
    await this.fileSystem.writeAtomic(this.sidecarPath, JSON.stringify(updated), this.idFactory());
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
    const deleted = await this.fileSystem.deleteFile(this.sidecarPath);
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
    this.closePromise ??= this.closeInternal(options.release ?? true);
    return this.closePromise;
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

  private signLease(body: WriterLeaseBody): SignedWriterLease {
    const parsed = writerLeaseBodySchema.parse(body);
    return signedWriterLeaseSchema.parse({
      ...parsed,
      signature: signCanonicalPayload(this.documentSecret, parsed),
    });
  }
}

export const fingerprintSharedTargetBytes = fingerprintBytes;
