import { describe, expect, it } from 'vitest';

import { CollaborationError, type WriterLeaseStatus } from '@htmllelujah/collaboration';
import { DocumentRuntimeError } from '@htmllelujah/document-runtime';

import {
  runSerializedStandaloneCollaborationTransition,
  StandaloneSaveQueue,
  StandaloneWriterReservationAggregateError,
  withExplicitStandaloneWriterRecovery,
  withStandaloneWriterReservation,
} from '../src/main/standalone-writer-reservation.js';

const ids = {
  documentId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
};

const unclaimed = (targetFingerprint: string | null): WriterLeaseStatus => ({
  state: 'unclaimed',
  targetFingerprint,
});

const deferred = (): { readonly promise: Promise<void>; readonly resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((settled) => {
    resolve = settled;
  });
  return { promise, resolve };
};

const stale = (
  expiresAtMs: number,
  actualTargetFingerprint: string | null = null,
): WriterLeaseStatus => ({
  state: 'stale',
  verified: false,
  actualTargetFingerprint,
  lease: {
    schemaVersion: 1,
    signingKeyId: `sha256-${'A'.repeat(43)}`,
    documentId: ids.documentId,
    sessionId: ids.sessionId,
    writerInstanceId: 'previous-writer',
    leaseId: '33333333-3333-4333-8333-333333333333',
    targetFingerprint: null,
    issuedAtMs: 0,
    heartbeatAtMs: 0,
    expiresAtMs,
    heartbeatSeq: 0,
    signature: 'B'.repeat(43),
  },
});

describe('standalone writer reservation', () => {
  it('serializes complete save flows for one session while leaving other sessions independent', async () => {
    const queue = new StandaloneSaveQueue();
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const calls: string[] = [];

    const first = queue.run(ids.sessionId, async () => {
      calls.push('first:start');
      firstEntered.resolve();
      await releaseFirst.promise;
      calls.push('first:end');
      return 1;
    });
    await firstEntered.promise;
    const second = queue.run(ids.sessionId, async () => {
      calls.push('second');
      return 2;
    });
    const independent = queue.run('44444444-4444-4444-8444-444444444444', async () => {
      calls.push('independent');
      return 3;
    });

    await independent;
    expect(calls).toEqual(['first:start', 'independent']);
    releaseFirst.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(calls).toEqual(['first:start', 'independent', 'first:end', 'second']);
  });

  it('holds Save As behind the complete host handoff and re-reads a dirty save target', async () => {
    const queue = new StandaloneSaveQueue();
    const transitionEntered = deferred();
    const releaseTransition = deferred();
    const calls: string[] = [];
    let targetPath = 'C:\\decks\\before.hdeck';

    const hosting = runSerializedStandaloneCollaborationTransition(queue, {
      sessionId: ids.sessionId,
      assertCurrent: () => calls.push('host:validated'),
      getSnapshot: () => ({ dirty: true, revision: 'before' }),
      getTargetPath: async () => targetPath,
      saveDirty: async () => {
        calls.push('host:saved');
        targetPath = 'C:\\decks\\after.hdeck';
        return { dirty: false, revision: 'saved' };
      },
      missingTarget: () => {
        throw new Error('missing target');
      },
      transition: async ({ source, targetPath: capturedTarget }) => {
        calls.push(`host:transition:${source.revision}:${capturedTarget}`);
        transitionEntered.resolve();
        await releaseTransition.promise;
        calls.push('host:assigned');
        return 'hosted';
      },
    });

    await transitionEntered.promise;
    const saveAs = queue.run(ids.sessionId, async () => {
      calls.push('save-as');
      return 'saved-as';
    });
    await Promise.resolve();
    expect(calls).toEqual([
      'host:validated',
      'host:saved',
      'host:transition:saved:C:\\decks\\after.hdeck',
    ]);

    releaseTransition.resolve();
    await expect(Promise.all([hosting, saveAs])).resolves.toEqual(['hosted', 'saved-as']);
    expect(calls).toEqual([
      'host:validated',
      'host:saved',
      'host:transition:saved:C:\\decks\\after.hdeck',
      'host:assigned',
      'save-as',
    ]);
  });

  it('does not begin hosting when a dirty save is cancelled', async () => {
    const queue = new StandaloneSaveQueue();
    let transitioned = false;
    await expect(
      runSerializedStandaloneCollaborationTransition(queue, {
        sessionId: ids.sessionId,
        assertCurrent: () => undefined,
        getSnapshot: () => ({ dirty: true }),
        getTargetPath: async () => 'C:\\decks\\deck.hdeck',
        saveDirty: async () => undefined,
        missingTarget: () => {
          throw new Error('missing target');
        },
        transition: async () => {
          transitioned = true;
          return 'hosted';
        },
      }),
    ).resolves.toBeUndefined();
    expect(transitioned).toBe(false);
  });

  it('retains one authority token through the commit guard and zeroes its source secret', async () => {
    const calls: string[] = [];
    const secret = Buffer.alloc(32, 7);
    let scheduledHeartbeat: (() => void) | undefined;

    const result = await withStandaloneWriterReservation(
      {
        targetPath: 'C:\\decks\\new.hdeck',
        ...ids,
        secretFactory: () => secret,
        writerInstanceIdFactory: () => 'standalone-save-test',
        schedule: (callback) => {
          scheduledHeartbeat = callback;
          return () => calls.push('schedule:stop');
        },
        storeFactory: () => ({
          inspect: async () => {
            calls.push('inspect');
            return unclaimed(null);
          },
          claim: async ({ expectedTargetFingerprint }) => {
            calls.push(`claim:${String(expectedTargetFingerprint)}`);
          },
          heartbeat: async (expectedTargetFingerprint, extensionMs) => {
            calls.push(`heartbeat:${String(expectedTargetFingerprint)}:${String(extensionMs)}`);
          },
          preflightTarget: async (expectedTargetFingerprint) => {
            calls.push(`preflight:${String(expectedTargetFingerprint)}`);
            return expectedTargetFingerprint ?? null;
          },
          close: async () => {
            calls.push('close');
          },
        }),
      },
      async (guard) => {
        expect(guard.expectedTargetFingerprint).toBeNull();
        scheduledHeartbeat?.();
        await guard.beforeCommit();
        calls.push('commit');
        return 'saved';
      },
    );

    expect(result).toBe('saved');
    expect(calls).toEqual([
      'inspect',
      'claim:null',
      'heartbeat:null:undefined',
      'schedule:stop',
      'heartbeat:null:600000',
      'preflight:null',
      'commit',
      'close',
    ]);
    expect(secret.equals(Buffer.alloc(32))).toBe(true);
  });

  it('fails closed before the operation when the sidecar cannot be trusted', async () => {
    let operationCalled = false;
    let closed = false;

    await expect(
      withStandaloneWriterReservation(
        {
          targetPath: 'C:\\decks\\existing.hdeck',
          ...ids,
          storeFactory: () => ({
            inspect: async () => ({ state: 'tampered' }),
            claim: async () => undefined,
            heartbeat: async () => undefined,
            preflightTarget: async () => null,
            close: async () => {
              closed = true;
            },
          }),
        },
        async () => {
          operationCalled = true;
        },
      ),
    ).rejects.toMatchObject({ code: 'SIDECAR_TAMPERED' });

    expect(operationCalled).toBe(false);
    expect(closed).toBe(true);
  });

  it('latches a renewal failure and rejects before the commit boundary', async () => {
    let scheduledHeartbeat: (() => void) | undefined;
    let heartbeatCalls = 0;
    let closed = false;

    await expect(
      withStandaloneWriterReservation(
        {
          targetPath: 'C:\\decks\\existing.hdeck',
          ...ids,
          schedule: (callback) => {
            scheduledHeartbeat = callback;
            return () => undefined;
          },
          storeFactory: () => ({
            inspect: async () => unclaimed('sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
            claim: async () => undefined,
            heartbeat: async () => {
              heartbeatCalls += 1;
              throw new CollaborationError('SPLIT_BRAIN', 'The owned reservation was replaced.');
            },
            preflightTarget: async () => {
              throw new Error('preflight must not run after a renewal failure');
            },
            close: async () => {
              closed = true;
            },
          }),
        },
        async (guard) => {
          scheduledHeartbeat?.();
          await guard.beforeCommit();
        },
      ),
    ).rejects.toMatchObject({ code: 'SPLIT_BRAIN' });

    expect(heartbeatCalls).toBe(1);
    expect(closed).toBe(true);
  });

  it('refuses to reuse a commit guard', async () => {
    await expect(
      withStandaloneWriterReservation(
        {
          targetPath: 'C:\\decks\\new.hdeck',
          ...ids,
          schedule: () => () => undefined,
          storeFactory: () => ({
            inspect: async () => unclaimed(null),
            claim: async () => undefined,
            heartbeat: async () => undefined,
            preflightTarget: async () => null,
            close: async () => undefined,
          }),
        },
        async (guard) => {
          await guard.beforeCommit();
          await guard.beforeCommit();
        },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('never takes over a stale reservation before explicit confirmation', async () => {
    const expiresAtMs = 100;
    let now = expiresAtMs;
    let confirmationCount = 0;
    const claims: Array<{ readonly allowExpiredTakeover?: boolean }> = [];
    const storeFactory = () => ({
      inspect: async () => {
        expect(now).toBeGreaterThanOrEqual(expiresAtMs);
        return stale(expiresAtMs);
      },
      claim: async (options: { readonly allowExpiredTakeover?: boolean }) => {
        claims.push(options);
      },
      heartbeat: async () => undefined,
      preflightTarget: async () => null,
      close: async () => undefined,
    });

    await expect(
      withStandaloneWriterReservation(
        {
          targetPath: 'C:\\decks\\existing.hdeck',
          ...ids,
          storeFactory,
        },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: 'WRITER_LEASE_STALE' });
    expect(claims).toHaveLength(0);

    await expect(
      withExplicitStandaloneWriterRecovery(
        {
          targetPath: 'C:\\decks\\existing.hdeck',
          ...ids,
          storeFactory,
        },
        async () => {
          confirmationCount += 1;
          return false;
        },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: 'WRITER_LEASE_STALE' });
    expect(claims).toHaveLength(0);

    const result = await withExplicitStandaloneWriterRecovery(
      {
        targetPath: 'C:\\decks\\existing.hdeck',
        ...ids,
        schedule: () => () => undefined,
        storeFactory,
      },
      async () => {
        expect(claims).toHaveLength(0);
        confirmationCount += 1;
        now += 1;
        return true;
      },
      async (guard) => {
        await guard.beforeCommit();
        return 'recovered';
      },
    );

    expect(result).toBe('recovered');
    expect(confirmationCount).toBe(2);
    expect(claims).toEqual([{ expectedTargetFingerprint: null, allowExpiredTakeover: true }]);
  });

  it('prompts before recovering an orphaned mutation lock on an unclaimed file', async () => {
    const claims: Array<{ readonly allowExpiredTakeover?: boolean }> = [];
    let confirmations = 0;
    const result = await withExplicitStandaloneWriterRecovery(
      {
        targetPath: 'C:\\decks\\orphaned-lock.hdeck',
        ...ids,
        schedule: () => () => undefined,
        storeFactory: () => ({
          inspect: async () => unclaimed(null),
          claim: async (options: { readonly allowExpiredTakeover?: boolean }) => {
            claims.push(options);
            if (options.allowExpiredTakeover !== true) {
              throw new CollaborationError(
                'WRITER_LEASE_STALE',
                'orphaned mutation lock requires confirmation',
              );
            }
          },
          heartbeat: async () => undefined,
          preflightTarget: async () => null,
          close: async () => undefined,
        }),
      },
      async () => {
        confirmations += 1;
        return true;
      },
      async (guard) => {
        await guard.beforeCommit();
        return 'recovered-orphan';
      },
    );

    expect(result).toBe('recovered-orphan');
    expect(confirmations).toBe(1);
    expect(claims).toEqual([
      { expectedTargetFingerprint: null },
      { expectedTargetFingerprint: null, allowExpiredTakeover: true },
    ]);
  });

  it('retains the writer-safety error when save and cleanup both fail', async () => {
    const saveError = new DocumentRuntimeError('SAVE_FAILED', 'save failed');
    const cleanupError = new CollaborationError('SPLIT_BRAIN', 'cleanup ownership changed');

    try {
      await withStandaloneWriterReservation(
        {
          targetPath: 'C:\\decks\\existing.hdeck',
          ...ids,
          schedule: () => () => undefined,
          storeFactory: () => ({
            inspect: async () => unclaimed(null),
            claim: async () => undefined,
            heartbeat: async () => undefined,
            preflightTarget: async () => null,
            close: async () => {
              throw cleanupError;
            },
          }),
        },
        async () => {
          throw saveError;
        },
      );
      throw new Error('Expected the reservation to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(StandaloneWriterReservationAggregateError);
      expect((error as StandaloneWriterReservationAggregateError).errors).toEqual([
        saveError,
        cleanupError,
      ]);
      expect((error as StandaloneWriterReservationAggregateError).actionableError).toBe(
        cleanupError,
      );
    }
  });

  it('retries a transient exact release and reports a completed save as successful', async () => {
    let closeCalls = 0;
    const result = await withStandaloneWriterReservation(
      {
        targetPath: 'C:\\decks\\existing.hdeck',
        ...ids,
        schedule: () => () => undefined,
        storeFactory: () => ({
          inspect: async () => unclaimed(null),
          claim: async () => undefined,
          heartbeat: async () => undefined,
          preflightTarget: async () => null,
          close: async () => {
            closeCalls += 1;
            if (closeCalls === 1) throw new Error('transient exact release failure');
          },
        }),
      },
      async (guard) => {
        await guard.beforeCommit();
        return 'saved';
      },
    );

    expect(result).toBe('saved');
    expect(closeCalls).toBe(2);
  });

  it('recovers an expired old-fingerprint sidecar against the current stable target', async () => {
    const currentFingerprint = `sha256-${'C'.repeat(43)}`;
    let claimedFingerprint: string | null | undefined;
    const result = await withExplicitStandaloneWriterRecovery(
      {
        targetPath: 'C:\\decks\\committed-before-release.hdeck',
        ...ids,
        schedule: () => () => undefined,
        storeFactory: () => ({
          inspect: async () => stale(0, currentFingerprint),
          claim: async ({ expectedTargetFingerprint }) => {
            claimedFingerprint = expectedTargetFingerprint;
          },
          heartbeat: async () => undefined,
          preflightTarget: async (expectedTargetFingerprint) => expectedTargetFingerprint ?? null,
          close: async () => undefined,
        }),
      },
      async () => true,
      async (guard) => {
        expect(guard.expectedTargetFingerprint).toBe(currentFingerprint);
        await guard.beforeCommit();
        return 'recovered-save';
      },
    );

    expect(result).toBe('recovered-save');
    expect(claimedFingerprint).toBe(currentFingerprint);
  });
});
