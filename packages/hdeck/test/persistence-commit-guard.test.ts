import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createNeutralDemoDeck } from '@htmllelujah/document-core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createHdeckArchive,
  fingerprintFile,
  PersistenceError,
  saveHdeckAtomic,
} from '../src/index.js';

const temporaryDirectories: string[] = [];

const temporaryTarget = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-commit-guard-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'deck.hdeck');
};

const archiveNamed = (name: string): Uint8Array => {
  const base = createNeutralDemoDeck();
  return createHdeckArchive({
    document: { ...base, name },
    createdAt: base.metadata.createdAt,
    modifiedAt: base.metadata.modifiedAt,
  });
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('atomic persistence commit guard', () => {
  it('leaves the target untouched when authority is rejected before rename', async () => {
    const target = await temporaryTarget();
    const original = archiveNamed('Original');
    const replacement = archiveNamed('Replacement');
    const first = await saveHdeckAtomic(target, original, { expectedFingerprint: null });
    let guardCalls = 0;
    const guardError = new Error('authority lost');

    await expect(
      saveHdeckAtomic(target, replacement, {
        expectedFingerprint: first.fingerprint,
        beforeCommit: async () => {
          guardCalls += 1;
          throw guardError;
        },
      }),
    ).rejects.toMatchObject({ code: 'TARGET_CHANGED', cause: guardError });

    expect(guardCalls).toBe(1);
    expect(Buffer.from(await readFile(target)).equals(Buffer.from(original))).toBe(true);
    expect(await readdir(path.dirname(target))).toEqual(['deck.hdeck']);
  });

  it('runs the authority check after target CAS and commits exactly once when accepted', async () => {
    const target = await temporaryTarget();
    const original = archiveNamed('Original');
    const replacement = archiveNamed('Replacement');
    const first = await saveHdeckAtomic(target, original, { expectedFingerprint: null });
    let observedDuringGuard: string | null | undefined;

    const saved = await saveHdeckAtomic(target, replacement, {
      expectedFingerprint: first.fingerprint,
      beforeCommit: async () => {
        observedDuringGuard = await fingerprintFile(target);
      },
    });

    expect(observedDuringGuard).toBe(first.fingerprint);
    expect(saved.fingerprint).not.toBe(first.fingerprint);
    expect(Buffer.from(await readFile(target)).equals(Buffer.from(replacement))).toBe(true);
    expect(await readdir(path.dirname(target))).toEqual(['deck.hdeck']);
  });

  it('rejects an existing target changed during the asynchronous authority check', async () => {
    const target = await temporaryTarget();
    const original = archiveNamed('Original');
    const replacement = archiveNamed('Replacement');
    const first = await saveHdeckAtomic(target, original, { expectedFingerprint: null });
    const externalBytes = Buffer.from('external generation');

    await expect(
      saveHdeckAtomic(target, replacement, {
        expectedFingerprint: first.fingerprint,
        beforeCommit: async () => {
          await writeFile(target, externalBytes);
        },
      }),
    ).rejects.toMatchObject({ code: 'TARGET_CHANGED' });

    expect(Buffer.from(await readFile(target)).equals(externalBytes)).toBe(true);
    expect(await readdir(path.dirname(target))).toEqual(['deck.hdeck']);
  });

  it('rejects an absent target created during the asynchronous authority check', async () => {
    const target = await temporaryTarget();
    const externalBytes = Buffer.from('created externally');

    await expect(
      saveHdeckAtomic(target, archiveNamed('Replacement'), {
        expectedFingerprint: null,
        beforeCommit: async () => {
          await writeFile(target, externalBytes);
        },
      }),
    ).rejects.toMatchObject({ code: 'TARGET_CHANGED' });

    expect(Buffer.from(await readFile(target)).equals(externalBytes)).toBe(true);
    expect(await readdir(path.dirname(target))).toEqual(['deck.hdeck']);
  });

  it('rejects a same-byte temporary path substituted during the authority check', async () => {
    const target = await temporaryTarget();
    const directory = path.dirname(target);
    const original = archiveNamed('Original');
    const replacement = archiveNamed('Replacement');
    const first = await saveHdeckAtomic(target, original, { expectedFingerprint: null });
    let substitutedName: string | undefined;

    await expect(
      saveHdeckAtomic(target, replacement, {
        expectedFingerprint: first.fingerprint,
        beforeCommit: async () => {
          const temporaryName = (await readdir(directory)).find((name) => name.endsWith('.tmp'));
          if (temporaryName === undefined) throw new Error('temporary archive not found');
          const temporaryPath = path.join(directory, temporaryName);
          const sameBytes = await readFile(temporaryPath);
          await rename(temporaryPath, `${temporaryPath}.displaced`);
          await writeFile(temporaryPath, sameBytes, { flag: 'wx' });
          substitutedName = temporaryName;
        },
      }),
    ).rejects.toMatchObject({ code: 'ARCHIVE_INVALID' });

    expect(substitutedName).toBeDefined();
    expect(Buffer.from(await readFile(target)).equals(Buffer.from(original))).toBe(true);
    const remaining = await readdir(directory);
    expect(remaining).toContain('deck.hdeck');
    // Neither the substituted path nor the displaced original is removed by unsafe pathname-only cleanup.
    expect(remaining.filter((name) => name !== 'deck.hdeck')).toHaveLength(2);
  });

  it('preserves an actionable commit-guard error and the original cause', async () => {
    const target = await temporaryTarget();
    const guardError = new PersistenceError('DISK_FULL', 'Guard storage is full.', true);

    let caught: unknown;
    try {
      await saveHdeckAtomic(target, archiveNamed('Replacement'), {
        expectedFingerprint: null,
        beforeCommit: async () => {
          throw guardError;
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(guardError);
    expect(caught).toMatchObject({ code: 'DISK_FULL', retryable: true });
    expect(await readdir(path.dirname(target))).toEqual([]);
  });
});
