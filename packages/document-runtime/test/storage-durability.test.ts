import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RuntimeRecoveryStore, type RecoveryAtomicWriteStep } from '../src/storage.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-storage-durability-'));
  directories.push(directory);
  return directory;
};

const replacementSteps: readonly RecoveryAtomicWriteStep[] = [
  'temporary-created',
  'temporary-written',
  'temporary-synced',
  'ready-published',
  'ready-directory-synced',
  'previous-published',
  'previous-directory-synced',
  'target-published',
  'target-directory-synced',
  'ready-removed',
  'previous-removed',
  'cleanup-directory-synced',
];

const transactionArtifact = /\.[0-9a-f-]{36}\.(?:tmp|ready|prev)$/i;

const waitForReady = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(
      () => reject(new Error('Timed out acquiring the file lock.')),
      5_000,
    );
    const onExit = (code: number | null): void => {
      clearTimeout(timeout);
      reject(new Error(`Lock helper exited before ready (${String(code)}).`));
    };
    child.once('exit', onExit);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (!output.includes('READY')) return;
      clearTimeout(timeout);
      child.off('exit', onExit);
      resolve();
    });
  });
};

describe('private recovery replacement durability', () => {
  for (const step of replacementSteps) {
    it(`recovers a complete old or new generation after a crash at ${step}`, async () => {
      const root = await temporaryDirectory();
      const sessionId = 'dddddddd-dddd-4ddd-8ddd-000000000001';
      const oldBytes = Buffer.from('complete-old-generation', 'utf8');
      const newBytes = Buffer.from('complete-new-generation', 'utf8');
      await new RuntimeRecoveryStore(root).writeBase(sessionId, oldBytes);

      const crashingStore = new RuntimeRecoveryStore(root, {
        testOnlyCrashAfterAtomicWriteStep: step,
      });
      await expect(crashingStore.writeBase(sessionId, newBytes)).rejects.toThrow(
        `Simulated crash after ${step}.`,
      );

      const restartedStore = new RuntimeRecoveryStore(root);
      await restartedStore.ensure();
      const recovered = await restartedStore.readBase(sessionId);
      expect([oldBytes.toString('hex'), newBytes.toString('hex')]).toContain(
        Buffer.from(recovered).toString('hex'),
      );
      expect((await readdir(root)).filter((name) => transactionArtifact.test(name))).toEqual([]);
    });
  }

  it('bounds startup cleanup and leaves excess generations for a later startup', async () => {
    const root = await temporaryDirectory();
    const targetName = 'dddddddd-dddd-4ddd-8ddd-000000000002.base.hdeck';
    await writeFile(path.join(root, targetName), Buffer.from('canonical', 'utf8'));
    for (let index = 1; index <= 6; index += 1) {
      const transactionId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      await writeFile(
        path.join(root, `${targetName}.${transactionId}.tmp`),
        Buffer.from(`stale-${index}`, 'utf8'),
      );
    }

    await new RuntimeRecoveryStore(root, {
      startupReconciliationMaxEntries: 100,
      startupReconciliationMaxActions: 2,
    }).ensure();

    expect((await readdir(root)).filter((name) => transactionArtifact.test(name))).toHaveLength(4);
    expect(await readFile(path.join(root, targetName), 'utf8')).toBe('canonical');
  });

  it('keeps private directories and committed files owner-only on POSIX', async () => {
    const root = await temporaryDirectory();
    const store = new RuntimeRecoveryStore(root);
    await store.writeBase('dddddddd-dddd-4ddd-8ddd-000000000003', Buffer.from('private'));
    if (process.platform === 'win32') return;
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(root, 'blobs'))).mode & 0o777).toBe(0o700);
    expect(
      (await stat(store.paths('dddddddd-dddd-4ddd-8ddd-000000000003').base)).mode & 0o777,
    ).toBe(0o600);
  });

  const windowsIt = process.platform === 'win32' ? it : it.skip;
  windowsIt(
    'preserves the previous generation when another Windows process locks the target',
    async () => {
      const root = await temporaryDirectory();
      const sessionId = 'dddddddd-dddd-4ddd-8ddd-000000000004';
      const store = new RuntimeRecoveryStore(root);
      const oldBytes = Buffer.from('locked-old-generation', 'utf8');
      const newBytes = Buffer.from('unlocked-new-generation', 'utf8');
      await store.writeBase(sessionId, oldBytes);
      const target = store.paths(sessionId).base;
      const script = path.join(root, 'hold-exclusive-lock.ps1');
      await writeFile(
        script,
        [
          'param([string]$Target)',
          "$stream = [System.IO.File]::Open($Target, 'Open', 'ReadWrite', 'None')",
          'try {',
          '  [Console]::Out.WriteLine("READY")',
          '  [Console]::Out.Flush()',
          '  [Console]::In.ReadLine() | Out-Null',
          '} finally {',
          '  $stream.Dispose()',
          '}',
        ].join('\r\n'),
        'utf8',
      );
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, target],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      );
      try {
        await waitForReady(child);
        await expect(store.writeBase(sessionId, newBytes)).rejects.toMatchObject({
          code: expect.stringMatching(/^(?:EBUSY|EACCES|EPERM)$/),
        });
      } finally {
        child.stdin.write('\n');
        child.stdin.end();
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null) resolve();
          else child.once('exit', () => resolve());
          setTimeout(() => {
            child.kill();
            resolve();
          }, 3_000).unref();
        });
      }
      expect(await readFile(target)).toEqual(oldBytes);
      await store.writeBase(sessionId, newBytes);
      expect(await readFile(target)).toEqual(newBytes);
    },
    15_000,
  );
});
