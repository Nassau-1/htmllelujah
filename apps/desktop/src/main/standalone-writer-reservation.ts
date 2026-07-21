import { randomBytes, randomUUID } from 'node:crypto';

import {
  CollaborationError,
  WriterLeaseStore,
  type SharedTargetFingerprint,
  type WriterLeaseStatus,
  type WriterLeaseStoreOptions,
} from '@htmllelujah/collaboration';
import { DocumentRuntimeError } from '@htmllelujah/document-runtime';

const DEFAULT_LEASE_TTL_MS = 120_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_COMMIT_EXTENSION_MS = 10 * 60 * 1_000;

interface WriterReservationStore {
  inspect(): Promise<WriterLeaseStatus>;
  claim(options: {
    readonly expectedTargetFingerprint: SharedTargetFingerprint;
    readonly allowExpiredTakeover?: boolean;
  }): Promise<unknown>;
  heartbeat(
    expectedTargetFingerprint?: SharedTargetFingerprint,
    extensionMs?: number,
  ): Promise<unknown>;
  preflightTarget(
    expectedTargetFingerprint?: SharedTargetFingerprint,
  ): Promise<SharedTargetFingerprint>;
  close(options?: { readonly release?: boolean }): Promise<void>;
}

type RepeatScheduler = (callback: () => void, intervalMs: number) => () => void;

export interface StandaloneWriterReservationOptions {
  readonly targetPath: string;
  readonly documentId: string;
  readonly sessionId: string;
  readonly leaseTtlMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly commitExtensionMs?: number;
  /** Deterministic test seam. Production callers must leave this unset. */
  readonly storeFactory?: (options: WriterLeaseStoreOptions) => WriterReservationStore;
  /** Deterministic test seam. Production callers must leave this unset. */
  readonly schedule?: RepeatScheduler;
  /** Deterministic test seam. Production callers must leave this unset. */
  readonly secretFactory?: () => Buffer;
  /** Deterministic test seam. Production callers must leave this unset. */
  readonly writerInstanceIdFactory?: () => string;
}

export interface StandaloneCommitGuard {
  readonly expectedTargetFingerprint: SharedTargetFingerprint;
  /** Called by persistence after its final target CAS and directly before atomic rename. */
  beforeCommit(): Promise<void>;
}

/** Serializes the complete reserve-and-save flow, including any user confirmation, per session. */
export class StandaloneSaveQueue {
  readonly #tails = new Map<string, Promise<void>>();

  public async run<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.#tails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#tails.set(sessionId, tail);
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(sessionId) === tail) this.#tails.delete(sessionId);
    }
  }
}

interface CollaborationTransitionSnapshot {
  readonly dirty: boolean;
}

export interface SerializedStandaloneCollaborationTransitionOptions<
  Snapshot extends CollaborationTransitionSnapshot,
  Result,
> {
  readonly sessionId: string;
  /** Revalidates renderer ownership and standalone mode after any earlier queued operation. */
  readonly assertCurrent: () => void;
  readonly getSnapshot: () => Snapshot;
  readonly getTargetPath: () => Promise<string | undefined>;
  readonly saveDirty: () => Promise<Snapshot | undefined>;
  readonly missingTarget: () => never;
  /** Must include the complete collaboration transition and source-session handoff. */
  readonly transition: (context: {
    readonly source: Snapshot;
    readonly targetPath: string;
  }) => Promise<Result>;
}

/**
 * Serializes a complete standalone-to-collaboration handoff with Save and Save As. The target is
 * read again after dirty-source handling, and the queue remains held until replacement assignment.
 */
export const runSerializedStandaloneCollaborationTransition = <
  Snapshot extends CollaborationTransitionSnapshot,
  Result,
>(
  queue: StandaloneSaveQueue,
  options: SerializedStandaloneCollaborationTransitionOptions<Snapshot, Result>,
): Promise<Result | undefined> =>
  queue.run(options.sessionId, async () => {
    options.assertCurrent();
    if ((await options.getTargetPath()) === undefined) options.missingTarget();

    let source = options.getSnapshot();
    if (source.dirty) {
      const saved = await options.saveDirty();
      if (saved === undefined) return undefined;
      source = saved;
    }

    const targetPath = await options.getTargetPath();
    if (targetPath === undefined) options.missingTarget();
    return options.transition({ source, targetPath });
  });

const WRITER_SAFETY_ERROR_PRIORITY: Partial<Record<CollaborationError['code'], number>> = {
  SPLIT_BRAIN: 60,
  SIDECAR_TAMPERED: 55,
  LEASE_NOT_OWNED: 50,
  TARGET_CHANGED: 45,
  WRITER_LEASE_ACTIVE: 40,
  WRITER_LEASE_STALE: 35,
};

const strongestActionableError = (operationError: unknown, cleanupError: unknown): unknown => {
  let strongestWriterError: CollaborationError | undefined;
  let strongestWriterPriority = -1;
  for (const error of [operationError, cleanupError]) {
    if (error instanceof CollaborationError) {
      const priority = WRITER_SAFETY_ERROR_PRIORITY[error.code] ?? -1;
      if (priority >= strongestWriterPriority) {
        strongestWriterError = error;
        strongestWriterPriority = priority;
      }
    }
  }
  if (strongestWriterError !== undefined && strongestWriterPriority >= 0) {
    return strongestWriterError;
  }
  for (const error of [operationError, cleanupError]) {
    if (error instanceof CollaborationError || error instanceof DocumentRuntimeError) return error;
  }
  return operationError;
};

/** Retains both failures for diagnostics while exposing the safest actionable user-facing cause. */
export class StandaloneWriterReservationAggregateError extends AggregateError {
  public readonly actionableError: unknown;

  public constructor(operationError: unknown, cleanupError: unknown) {
    super(
      [operationError, cleanupError],
      'The save failed and writer reservation cleanup could not be confirmed.',
    );
    this.name = 'StandaloneWriterReservationAggregateError';
    this.actionableError = strongestActionableError(operationError, cleanupError);
  }
}

const defaultSchedule: RepeatScheduler = (callback, intervalMs) => {
  const timer = setInterval(callback, intervalMs);
  return () => clearInterval(timer);
};

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error('Writer reservation validation failed.');

const unavailableStatusError = (status: Exclude<WriterLeaseStatus, { state: 'unclaimed' }>) => {
  switch (status.state) {
    case 'tampered':
      return new CollaborationError(
        'SIDECAR_TAMPERED',
        'The shared-file writer authority is invalid.',
      );
    case 'stale':
      return new CollaborationError(
        'WRITER_LEASE_STALE',
        'The prior shared-file writer authority requires explicit recovery.',
      );
    case 'target-changed':
      return new CollaborationError(
        'TARGET_CHANGED',
        'The shared target changed before writer authority was reserved.',
      );
    case 'split-brain':
      return new CollaborationError(
        'SPLIT_BRAIN',
        'Conflicting shared-file writer authority was detected.',
      );
    case 'active-self':
    case 'active-other':
      return new CollaborationError(
        'WRITER_LEASE_ACTIVE',
        'Another operation currently owns the shared-file writer authority.',
      );
  }
};

const assertTimingOptions = (
  leaseTtlMs: number,
  heartbeatIntervalMs: number,
  commitExtensionMs: number,
): void => {
  if (
    !Number.isSafeInteger(leaseTtlMs) ||
    !Number.isSafeInteger(heartbeatIntervalMs) ||
    !Number.isSafeInteger(commitExtensionMs) ||
    leaseTtlMs < 1 ||
    heartbeatIntervalMs < 1 ||
    heartbeatIntervalMs >= leaseTtlMs ||
    commitExtensionMs < leaseTtlMs ||
    commitExtensionMs > DEFAULT_COMMIT_EXTENSION_MS
  ) {
    throw new CollaborationError(
      'INVALID_REQUEST',
      'Writer reservation timing values are outside supported bounds.',
    );
  }
};

/**
 * Reserves the same sibling authority namespace used by collaboration hosts and retains
 * ownership continuously through the persistence commit guard.
 */
const withStandaloneWriterReservationAttempt = async <T>(
  options: StandaloneWriterReservationOptions,
  confirmExpiredTakeover: (() => Promise<boolean>) | undefined,
  operation: (guard: StandaloneCommitGuard) => Promise<T>,
): Promise<T> => {
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const commitExtensionMs = options.commitExtensionMs ?? DEFAULT_COMMIT_EXTENSION_MS;
  assertTimingOptions(leaseTtlMs, heartbeatIntervalMs, commitExtensionMs);

  const secret = (options.secretFactory ?? (() => randomBytes(32)))();
  if (secret.byteLength !== 32) {
    secret.fill(0);
    throw new CollaborationError(
      'INVALID_REQUEST',
      'Writer reservation secret must contain exactly 32 bytes.',
    );
  }

  const storeFactory =
    options.storeFactory ??
    ((storeOptions: WriterLeaseStoreOptions) => new WriterLeaseStore(storeOptions));
  let store: WriterReservationStore | undefined;
  let stopSchedule: (() => void) | undefined;
  let heartbeatInFlight: Promise<void> | undefined;
  let heartbeatFailure: Error | undefined;
  let expectedTargetFingerprint: SharedTargetFingerprint | undefined;
  let commitGuardUsed = false;

  const stopHeartbeat = (): void => {
    stopSchedule?.();
    stopSchedule = undefined;
  };

  try {
    store = storeFactory({
      targetPath: options.targetPath,
      documentId: options.documentId,
      sessionId: options.sessionId,
      writerInstanceId: options.writerInstanceIdFactory?.() ?? `standalone-save-${randomUUID()}`,
      documentSecret: secret,
      leaseTtlMs,
    });

    const status = await store.inspect();
    let allowExpiredTakeover = false;
    if (status.state === 'unclaimed') {
      expectedTargetFingerprint = status.targetFingerprint;
    } else if (status.state === 'stale' && confirmExpiredTakeover !== undefined) {
      if (!(await confirmExpiredTakeover())) throw unavailableStatusError(status);
      allowExpiredTakeover = true;
      // A prior standalone save may have committed before its exact sidecar release failed.
      // After explicit confirmation and a full stable-observation window, reserve the current
      // target generation; persistence still independently checks the session's own fingerprint.
      expectedTargetFingerprint = status.actualTargetFingerprint;
    } else {
      throw unavailableStatusError(status);
    }
    if (expectedTargetFingerprint === undefined) {
      throw new CollaborationError(
        'INVALID_REQUEST',
        'Writer reservation did not resolve a target fingerprint.',
      );
    }
    const reservationFingerprint = expectedTargetFingerprint;
    try {
      await store.claim({
        expectedTargetFingerprint: reservationFingerprint,
        ...(allowExpiredTakeover ? { allowExpiredTakeover: true } : {}),
      });
    } catch (error) {
      const orphanedReservation =
        status.state === 'unclaimed' &&
        error instanceof CollaborationError &&
        error.code === 'WRITER_LEASE_STALE';
      if (!orphanedReservation || confirmExpiredTakeover === undefined) throw error;
      if (!(await confirmExpiredTakeover())) throw error;
      allowExpiredTakeover = true;
      await store.claim({
        expectedTargetFingerprint: reservationFingerprint,
        allowExpiredTakeover: true,
      });
    }
    const activeStore = store;

    const heartbeat = (): void => {
      if (heartbeatFailure !== undefined || heartbeatInFlight !== undefined) return;
      heartbeatInFlight = activeStore
        .heartbeat(reservationFingerprint)
        .then(() => undefined)
        .catch((error: unknown) => {
          heartbeatFailure = asError(error);
          stopHeartbeat();
        })
        .finally(() => {
          heartbeatInFlight = undefined;
        });
    };
    stopSchedule = (options.schedule ?? defaultSchedule)(heartbeat, heartbeatIntervalMs);

    const guard: StandaloneCommitGuard = {
      expectedTargetFingerprint: reservationFingerprint,
      beforeCommit: async () => {
        if (commitGuardUsed) {
          throw new CollaborationError(
            'INVALID_REQUEST',
            'Writer reservation commit guard may only be used once.',
          );
        }
        commitGuardUsed = true;
        stopHeartbeat();
        await heartbeatInFlight;
        if (heartbeatFailure !== undefined) throw heartbeatFailure;

        // Extend once immediately before the commit and stop periodic renewal so no
        // heartbeat can race the target rename. The persistence layer invokes this guard
        // directly before rename, while the owned sidecar remains present through return.
        await activeStore.heartbeat(reservationFingerprint, commitExtensionMs);
        await activeStore.preflightTarget(reservationFingerprint);
      },
    };

    let result: T | undefined;
    let operationError: unknown;
    try {
      result = await operation(guard);
    } catch (error) {
      operationError = error;
    }

    stopHeartbeat();
    await heartbeatInFlight;
    let cleanupError: unknown;
    try {
      await activeStore.close();
      store = undefined;
    } catch (error) {
      // WriterLeaseStore close is deliberately retryable. A transient release failure after a
      // successful commit must not become a false Save error or leave an old-fingerprint sidecar.
      try {
        await activeStore.close();
        store = undefined;
      } catch {
        cleanupError = error;
      }
    }

    if (operationError !== undefined && cleanupError !== undefined) {
      throw new StandaloneWriterReservationAggregateError(operationError, cleanupError);
    }
    if (cleanupError !== undefined) throw cleanupError;
    if (operationError !== undefined) throw operationError;
    return result as T;
  } finally {
    stopHeartbeat();
    await heartbeatInFlight;
    if (store !== undefined) await store.close().catch(() => undefined);
    secret.fill(0);
  }
};

export const withStandaloneWriterReservation = <T>(
  options: StandaloneWriterReservationOptions,
  operation: (guard: StandaloneCommitGuard) => Promise<T>,
): Promise<T> => withStandaloneWriterReservationAttempt(options, undefined, operation);

/**
 * Claims a stale reservation only after the caller obtains explicit user confirmation.
 * WriterLeaseStore then retains its stable-observation and compare-and-swap checks.
 */
export const withExplicitStandaloneWriterRecovery = async <T>(
  options: StandaloneWriterReservationOptions,
  confirmExpiredTakeover: () => Promise<boolean>,
  operation: (guard: StandaloneCommitGuard) => Promise<T>,
): Promise<T> => {
  return withStandaloneWriterReservationAttempt(options, confirmExpiredTakeover, operation);
};
