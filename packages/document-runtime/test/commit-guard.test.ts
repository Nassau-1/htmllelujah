import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DocumentSessionManager, type ArchiveDurabilityCapability } from '../src/index.js';

const directories: string[] = [];

const deferred = (): { readonly promise: Promise<void>; readonly resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((settled) => {
    resolve = settled;
  });
  return { promise, resolve };
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('runtime persistence commit authority', () => {
  it('forwards trusted commit guards through Save, Save As, and detached host Save', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-runtime-guard-'));
    directories.push(directory);
    const guardOrder: string[] = [];
    let saveCount = 0;
    const archive: ArchiveDurabilityCapability = {
      open: async () => {
        throw new Error('open is not used by this test');
      },
      fingerprint: async () => null,
      save: async (_target, bytes, options) => {
        saveCount += 1;
        guardOrder.push(`archive:${saveCount}`);
        await options?.beforeCommit?.();
        return {
          status: 'saved',
          fingerprint: saveCount.toString(16).padStart(64, '0'),
          byteLength: bytes.byteLength,
        };
      },
    };
    const manager = new DocumentSessionManager({
      recoveryDirectory: path.join(directory, 'recovery'),
      archive,
      autosaveDelayMs: 0,
    });
    const created = await manager.createMainOnly();
    const firstTarget = path.join(directory, 'first.hdeck');
    const detachedTarget = path.join(directory, 'detached.hdeck');

    await manager.saveAsMainOnly(created.sessionId, {
      targetPath: firstTarget,
      expectedFingerprint: null,
      beforeCommit: async () => {
        guardOrder.push('guard:save-as');
      },
    });
    const changed = await manager.execute(created.sessionId, {
      expectedRevision: manager.getSnapshot(created.sessionId).revision,
      commands: [{ type: 'deck.rename', name: 'Changed' }],
      metadata: {
        transactionId: '11111111-1111-4111-8111-111111111111',
        actorId: 'runtime-guard-test',
        origin: 'user',
        label: 'Change for guarded save',
        timestamp: '2026-07-20T12:00:00.000Z',
      },
    });
    await manager.save(created.sessionId, {
      beforeCommit: async () => {
        guardOrder.push('guard:save');
      },
    });
    await manager.saveDetachedMainOnly(created.sessionId, {
      targetPath: detachedTarget,
      expectedFingerprint: null,
      beforeCommit: async () => {
        guardOrder.push('guard:detached');
      },
    });

    expect(changed.dirty).toBe(true);
    expect(guardOrder).toEqual([
      'archive:1',
      'guard:save-as',
      'archive:2',
      'guard:save',
      'archive:3',
      'guard:detached',
    ]);
  });

  it('rejects a queued Save when its reserved target was replaced by an earlier Save As', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-runtime-target-fence-'));
    directories.push(directory);
    const firstTarget = path.join(directory, 'first.hdeck');
    const secondTarget = path.join(directory, 'second.hdeck');
    const secondSaveEntered = deferred();
    const releaseSecondSave = deferred();
    const saveTargets: string[] = [];
    let saveCount = 0;
    const archive: ArchiveDurabilityCapability = {
      open: async () => {
        throw new Error('open is not used by this test');
      },
      fingerprint: async () => null,
      save: async (target, bytes) => {
        saveTargets.push(target);
        if (target === secondTarget) {
          secondSaveEntered.resolve();
          await releaseSecondSave.promise;
        }
        saveCount += 1;
        return {
          status: 'saved',
          fingerprint: saveCount.toString(16).padStart(64, '0'),
          byteLength: bytes.byteLength,
        };
      },
    };
    const manager = new DocumentSessionManager({
      recoveryDirectory: path.join(directory, 'recovery'),
      archive,
      autosaveDelayMs: 0,
    });
    const created = await manager.createMainOnly();
    await manager.saveAsMainOnly(created.sessionId, {
      targetPath: firstTarget,
      expectedFingerprint: null,
    });
    await manager.execute(created.sessionId, {
      expectedRevision: manager.getSnapshot(created.sessionId).revision,
      commands: [{ type: 'deck.rename', name: 'Queued target fence' }],
      metadata: {
        transactionId: '55555555-5555-4555-8555-555555555555',
        actorId: 'runtime-target-fence-test',
        origin: 'user',
        label: 'Prepare deterministic save interleaving',
        timestamp: '2026-07-20T12:10:00.000Z',
      },
    });

    const saveAsSecond = manager.saveAsMainOnly(created.sessionId, {
      targetPath: secondTarget,
      expectedFingerprint: null,
    });
    await secondSaveEntered.promise;
    const staleReservedSave = manager.save(created.sessionId, {
      expectedTargetPath: firstTarget,
    });
    releaseSecondSave.resolve();

    await expect(saveAsSecond).resolves.toMatchObject({ hasSaveTarget: true, dirty: false });
    await expect(staleReservedSave).rejects.toMatchObject({ code: 'TARGET_CHANGED' });
    await expect(manager.getSaveTargetMainOnly(created.sessionId)).resolves.toBe(secondTarget);
    expect(saveTargets).toEqual([firstTarget, secondTarget]);
  });

  it('retains the committed target as authoritative when recovery rotation fails afterward', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-runtime-postcommit-'));
    directories.push(directory);
    const recoveryDirectory = path.join(directory, 'recovery');
    const targetPath = path.join(directory, 'committed.hdeck');
    const manager = new DocumentSessionManager({ recoveryDirectory, autosaveDelayMs: 0 });
    const created = await manager.createMainOnly();

    await expect(
      manager.saveAsMainOnly(created.sessionId, {
        targetPath,
        expectedFingerprint: null,
        beforeCommit: async () => {
          await rm(recoveryDirectory, { recursive: true, force: true });
          await writeFile(recoveryDirectory, Buffer.from('test-only recovery blocker', 'utf8'));
        },
      }),
    ).rejects.toMatchObject({ code: 'JOURNAL_FAILED' });

    expect((await readFile(targetPath)).byteLength).toBeGreaterThan(0);
    await expect(manager.getSaveTargetMainOnly(created.sessionId)).resolves.toBe(targetPath);
    expect(manager.getSnapshot(created.sessionId)).toMatchObject({
      hasSaveTarget: true,
      dirty: false,
      durability: 'save-error',
    });
  });
});
