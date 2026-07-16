import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BUILD_PROVENANCE_SCHEMA_VERSION,
  DESKTOP_BUILD_COMMAND,
  WINDOWS_CANDIDATE_BUILD_COMMAND,
  assertBuildProvenance,
  gitSourceState,
  readPackagedBuildProvenance,
} from '../scripts/build-provenance-support.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const desktopRoot = path.join(repositoryRoot, 'apps', 'desktop');
const temporaryRoots = [];
const gitProbe = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
const actualGitAvailable = gitProbe.status === 0;

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

const gitRunner =
  ({ staged = false, unstaged = false, untracked = false } = {}) =>
  (_repositoryRoot, args) => {
    const output = (status, stdout = '') => ({
      status,
      signal: null,
      error: null,
      stdout: Buffer.from(stdout),
      stderr: Buffer.alloc(0),
    });
    if (args.join(' ') === 'rev-parse --is-inside-work-tree') return output(0, 'true\n');
    if (args.join(' ') === 'rev-parse --verify HEAD^{commit}') {
      return output(0, `${'a'.repeat(40)}\n`);
    }
    if (args[0] === 'diff' && args.includes('--cached')) return output(staged ? 1 : 0);
    if (args[0] === 'diff-files') return output(unstaged ? 1 : 0);
    if (args[0] === 'ls-files') return output(0, untracked ? 'new-file\0' : '');
    if (args[0] === 'status') {
      return output(
        staged || unstaged || untracked ? 0 : 0,
        staged ? 'M  tracked\0' : unstaged ? ' M tracked\0' : untracked ? '?? new-file\0' : '',
      );
    }
    if (args[0] === 'symbolic-ref') return output(0, 'codex/v1-release\n');
    if (args[0] === 'describe') return output(128);
    throw new Error(`Unexpected fake Git command: ${args.join(' ')}`);
  };

const runActualGit = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
};

describe('release build provenance', () => {
  it('interprets an exact clean Git commit fail-closed', () => {
    const source = gitSourceState(repositoryRoot, gitRunner());
    expect(source.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(source.dirty).toBe(false);
    expect(source.branch).toBe('codex/v1-release');
  });

  it('treats staged index-to-HEAD changes as dirty and propagates runner failures', () => {
    const staged = gitSourceState(repositoryRoot, gitRunner({ staged: true }));
    expect(staged.dirty).toBe(true);
    expect(staged.staged).toBe(true);
    expect(() =>
      gitSourceState(repositoryRoot, () => {
        throw new Error('synthetic Git failure');
      }),
    ).toThrow(/synthetic Git failure/iu);
  });

  (actualGitAvailable ? it : it.skip)(
    'integration: detects a real staged index-to-HEAD mutation',
    async () => {
      const fixture = await mkdtemp(path.join(os.tmpdir(), 'htmllelujah-real-git-state-'));
      temporaryRoots.push(fixture);
      runActualGit(fixture, 'init');
      runActualGit(fixture, 'config', 'user.email', 'release-test@example.invalid');
      runActualGit(fixture, 'config', 'user.name', 'Release Test');
      await writeFile(path.join(fixture, 'tracked.txt'), 'before\n');
      runActualGit(fixture, 'add', 'tracked.txt');
      runActualGit(fixture, 'commit', '-m', 'fixture');
      expect(gitSourceState(fixture).dirty).toBe(false);
      await writeFile(path.join(fixture, 'tracked.txt'), 'after\n');
      runActualGit(fixture, 'add', 'tracked.txt');
      expect(gitSourceState(fixture)).toMatchObject({ dirty: true, staged: true });
    },
  );

  it('accepts only clean embedded provenance for the exact source tree and lockfile', () => {
    const sourceTree = { sha256: 'a'.repeat(64), fileCount: 123, bytes: 456 };
    const expected = {
      productName: 'HTMLlelujah',
      version: '1.0.0',
      sourceCommit: 'b'.repeat(40),
      sourceTree,
      lockfileSha256: 'c'.repeat(64),
    };
    const provenance = {
      schemaVersion: BUILD_PROVENANCE_SCHEMA_VERSION,
      productName: expected.productName,
      version: expected.version,
      sourceCommit: expected.sourceCommit,
      sourceDirty: false,
      sourceTreeSha256: sourceTree.sha256,
      sourceFileCount: sourceTree.fileCount,
      sourceBytes: sourceTree.bytes,
      lockfileSha256: expected.lockfileSha256,
      desktopBuildCommand: DESKTOP_BUILD_COMMAND,
      releaseBuildCommand: WINDOWS_CANDIDATE_BUILD_COMMAND,
    };

    expect(() => assertBuildProvenance(provenance, expected)).not.toThrow();
    expect(() => assertBuildProvenance({ ...provenance, sourceDirty: true }, expected)).toThrow(
      /does not match/iu,
    );
    expect(() =>
      assertBuildProvenance({ ...provenance, sourceTreeSha256: 'd'.repeat(64) }, expected),
    ).toThrow(/does not match/iu);
  });

  it('reads provenance directly from app.asar without launching the candidate', async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'htmllelujah-asar-provenance-'));
    temporaryRoots.push(fixture);
    const input = path.join(fixture, 'input');
    await mkdir(path.join(input, 'dist-electron'), { recursive: true });
    const provenance = { schemaVersion: 2, sourceCommit: 'a'.repeat(40) };
    await writeFile(
      path.join(input, 'dist-electron', 'build-provenance.json'),
      `${JSON.stringify(provenance)}\n`,
    );
    const rootRequire = createRequire(path.join(desktopRoot, 'package.json'));
    const builderRequire = createRequire(rootRequire.resolve('electron-builder/package.json'));
    const asar = builderRequire('@electron/asar');
    const archive = path.join(fixture, 'app.asar');
    await asar.createPackage(input, archive);

    expect(readPackagedBuildProvenance(archive, desktopRoot)).toEqual(provenance);
  });

  it('pins public packaging scripts to the detached release orchestrator', async () => {
    const desktopPackage = JSON.parse(
      await readFile(path.join(desktopRoot, 'package.json'), 'utf8'),
    );
    const rootPackage = JSON.parse(
      await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
    );
    expect(desktopPackage.scripts.build).toBe(DESKTOP_BUILD_COMMAND);
    expect(desktopPackage.scripts.make).toBe('node ../../scripts/build-windows-release.mjs');
    expect(desktopPackage.scripts.package).toBe('node ../../scripts/build-windows-release.mjs');
    expect(rootPackage.scripts['make:win']).toBe(WINDOWS_CANDIDATE_BUILD_COMMAND);
    expect(rootPackage.scripts.test).toContain('--pool=threads --maxWorkers=1');
    expect(desktopPackage.build.nsis.guid).toBe('7bf3c6ec-651b-477c-a0b7-399160cda612');
  });
});
