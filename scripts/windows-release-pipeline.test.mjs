import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertSourceSnapshotIdentity } from './release-source-state.mjs';
import { assertCandidateManifest } from './release-candidate-manifest.mjs';
import {
  attestWorkspacePackageOutputs,
  assertWorkspacePackageOutputsStable,
  buildCommandPlan,
  createReleaseEnvironment,
  discoverWorkspacePackages,
  promoteDirectoriesAtomically,
  runSequentialPlan,
} from './windows-release-pipeline-support.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..');

const aggregateInventory = (entries) => {
  const digest = createHash('sha256');
  for (const entry of entries) {
    digest.update(entry.path);
    digest.update('\0');
    digest.update(String(entry.size));
    digest.update('\0');
    digest.update(entry.sha256);
    digest.update('\n');
  }
  return digest.digest('hex');
};

const withTemporaryRoot = async (prefix, operation) => {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test('workspace packages are complete and topologically ordered', async () => {
  const packages = await discoverWorkspacePackages(repositoryRoot);
  assert.equal(packages.length, 8);
  const positions = new Map(packages.map((entry, index) => [entry.name, index]));
  for (const entry of packages) {
    for (const dependency of entry.dependencyNames) {
      if (positions.has(dependency)) {
        assert.ok(positions.get(dependency) < positions.get(entry.name));
      }
    }
  }
});

test('command plan rebuilds every package sequentially before desktop and packages only to staging', async () => {
  const packageNames = (await discoverWorkspacePackages(repositoryRoot)).map((entry) => entry.name);
  const paths = {
    buildId: 'fixture-build',
    session: 'session.json',
    workspaceBuild: 'workspace.json',
    artifactStaging: 'isolated/out',
    evidenceStaging: 'isolated/evidence',
    candidateManifest: 'isolated/evidence/release-candidate-v1.json',
  };
  const plan = buildCommandPlan({ packageNames, paths, offline: true });
  const packageSteps = plan.filter((entry) => entry.name.startsWith('build-workspace-package:'));
  assert.deepEqual(
    packageSteps.map((entry) => entry.name.slice('build-workspace-package:'.length)),
    packageNames,
  );
  assert.ok(
    plan.find((entry) => entry.name === 'install-exact-lockfile').args.includes('--offline'),
  );
  assert.ok(
    plan.findIndex((entry) => entry.name === 'build-desktop-vite') >
      plan.findIndex((entry) => entry.name === packageSteps.at(-1).name),
  );
  const packageStep = plan.find((entry) => entry.name === 'package-windows-staging');
  assert.ok(packageStep.args.includes('--config.directories.output=isolated/out'));
  assert.deepEqual(packageStep.args.slice(packageStep.args.indexOf('--publish'), -1), [
    '--publish',
    'never',
  ]);
  assert.equal(plan.at(-1).name, 'verify-release-evidence');
});

test('release children cannot inherit publication credentials or renderer overrides', () => {
  const environment = createReleaseEnvironment({
    PATH: 'fixture-path',
    CI: 'true',
    GH_TOKEN: 'github-secret',
    GITHUB_TOKEN: 'actions-secret',
    GITLAB_TOKEN: 'gitlab-secret',
    AWS_ACCESS_KEY_ID: 'cloud-secret',
    NODE_OPTIONS: '--inspect',
    ELECTRON_RUN_AS_NODE: '1',
    VITE_DEV_SERVER_URL: 'https://renderer.invalid/',
  });
  assert.equal(environment.PATH, 'fixture-path');
  assert.equal(environment.CI, 'true');
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GITLAB_TOKEN', 'AWS_ACCESS_KEY_ID']) {
    assert.equal(environment[key], undefined);
  }
  assert.equal(environment.NODE_OPTIONS, '');
  assert.equal(environment.ELECTRON_RUN_AS_NODE, '');
  assert.equal(environment.VITE_DEV_SERVER_URL, '');
});

test('workspace output attestation rejects stale dist and records fresh build order', async () => {
  await withTemporaryRoot('htmllelujah-workspace-output-', async (root) => {
    const firstDist = path.join(root, 'first', 'dist');
    const secondDist = path.join(root, 'second', 'dist');
    await mkdir(firstDist, { recursive: true });
    await mkdir(secondDist, { recursive: true });
    const firstFile = path.join(firstDist, 'index.js');
    const secondFile = path.join(secondDist, 'index.js');
    await writeFile(firstFile, 'first\n');
    await writeFile(secondFile, 'second\n');
    const packages = [
      { name: '@fixture/first', relativePath: 'packages/first', dist: firstDist },
      { name: '@fixture/second', relativePath: 'packages/second', dist: secondDist },
    ];
    const now = Date.now();
    const old = new Date(now - 60_000);
    await utimes(firstFile, old, old);
    const buildTimes = new Map(packages.map((entry) => [entry.name, now]));
    await assert.rejects(
      attestWorkspacePackageOutputs(packages, buildTimes),
      /stale pre-build output/iu,
    );

    const fresh = new Date();
    await utimes(firstFile, fresh, fresh);
    await utimes(secondFile, fresh, fresh);
    const attestation = await attestWorkspacePackageOutputs(packages, buildTimes);
    assert.deepEqual(
      attestation.packages.map((entry) => entry.buildOrder),
      [1, 2],
    );
    assert.ok(attestation.packages.every((entry) => entry.dist.fileCount === 1));
    await assert.doesNotReject(
      assertWorkspacePackageOutputsStable(packages, buildTimes, attestation),
    );
    await writeFile(secondFile, 'changed after attestation\n');
    await assert.rejects(
      assertWorkspacePackageOutputsStable(packages, buildTimes, attestation),
      /changed after its attestation/iu,
    );
  });
});

test('pre-build source snapshot rejects tracked mutation after capture', () => {
  const expected = {
    commit: 'a'.repeat(40),
    dirty: false,
    tree: { sha256: 'b'.repeat(64), fileCount: 10, bytes: 100 },
  };
  const mutated = {
    ...expected,
    tree: { ...expected.tree, sha256: 'c'.repeat(64) },
  };
  assert.throws(() => assertSourceSnapshotIdentity(mutated, expected), /snapshot changed/iu);
});

test('failed step never invokes promotion', async () => {
  let promoted = false;
  await assert.rejects(
    runSequentialPlan(
      [{ name: 'one' }, { name: 'fail' }, { name: 'three' }],
      async (step) => {
        if (step.name === 'fail') throw new Error('synthetic failure');
      },
      async () => {
        promoted = true;
      },
    ),
    /synthetic failure/iu,
  );
  assert.equal(promoted, false);
});

test('candidate manifest binds blockmap, full unpacked inventory, provenance, and packages', () => {
  const installerName = 'HTMLlelujah-1.0.0-x64-unsigned-Setup.exe';
  const inventory = [
    { path: installerName, size: 10, sha256: 'a'.repeat(64) },
    { path: `${installerName}.blockmap`, size: 11, sha256: 'b'.repeat(64) },
    { path: 'win-unpacked/HTMLlelujah.exe', size: 12, sha256: 'c'.repeat(64) },
    { path: 'win-unpacked/resources/app.asar', size: 13, sha256: 'd'.repeat(64) },
  ];
  const unpacked = inventory
    .filter((entry) => entry.path.startsWith('win-unpacked/'))
    .map((entry) => ({ ...entry, path: entry.path.slice('win-unpacked/'.length) }));
  const workspacePackages = [
    {
      name: '@htmllelujah/document-core',
      path: 'packages/document-core',
      buildOrder: 1,
      dist: { fileCount: 1, totalSize: 1, aggregateSha256: 'e'.repeat(64), files: [] },
    },
  ];
  const sourceCommit = 'f'.repeat(40);
  const manifest = {
    schemaVersion: 2,
    productName: 'HTMLlelujah',
    version: '1.0.0',
    buildId: 'fixture',
    source: {
      commit: sourceCommit,
      dirty: false,
      treeSha256: '1'.repeat(64),
      fileCount: 1,
      bytes: 1,
    },
    lockfile: { sha256: '2'.repeat(64) },
    build: {
      embeddedProvenance: {
        schemaVersion: 2,
        buildId: 'fixture',
        sourceCommit,
        sourceDirty: false,
        sourceTreeSha256: '1'.repeat(64),
        lockfileSha256: '2'.repeat(64),
        workspacePackages,
      },
      workspacePackages,
    },
    artifact: {
      fileCount: inventory.length,
      totalSize: inventory.reduce((sum, entry) => sum + entry.size, 0),
      aggregateSha256: aggregateInventory(inventory),
      installer: inventory[0],
      blockmap: inventory[1],
      winUnpacked: {
        fileCount: unpacked.length,
        totalSize: unpacked.reduce((sum, entry) => sum + entry.size, 0),
        aggregateSha256: aggregateInventory(unpacked),
        files: unpacked,
      },
      files: inventory,
    },
  };
  assert.doesNotThrow(() => assertCandidateManifest({ manifest, inventory, version: '1.0.0' }));
  assert.throws(
    () =>
      assertCandidateManifest({
        manifest: {
          ...manifest,
          artifact: {
            ...manifest.artifact,
            blockmap: { ...manifest.artifact.blockmap, sha256: '0'.repeat(64) },
          },
        },
        inventory,
        version: '1.0.0',
      }),
    /blockmap/iu,
  );
});

test('multi-directory promotion rolls back every final artifact on failure', async () => {
  await withTemporaryRoot('htmllelujah-promotion-', async (root) => {
    const sourceOne = path.join(root, 'stage-one');
    const sourceTwo = path.join(root, 'stage-two');
    const destinationOne = path.join(root, 'final-one');
    const destinationTwo = path.join(root, 'final-two');
    const transactionRoot = path.join(root, 'transaction');
    for (const [directory, content] of [
      [sourceOne, 'new-one'],
      [sourceTwo, 'new-two'],
      [destinationOne, 'old-one'],
      [destinationTwo, 'old-two'],
    ]) {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'value.txt'), content);
    }
    const { rename: realRename } = await import('node:fs/promises');
    await assert.rejects(
      promoteDirectoriesAtomically({
        promotions: [
          { source: sourceOne, destination: destinationOne },
          { source: sourceTwo, destination: destinationTwo },
        ],
        transactionRoot,
        fsOps: {
          rename: async (source, destination) => {
            if (source === sourceTwo && destination === destinationTwo) {
              throw new Error('synthetic promotion failure');
            }
            await realRename(source, destination);
          },
        },
      }),
      /synthetic promotion failure/iu,
    );
    assert.equal(await readFile(path.join(destinationOne, 'value.txt'), 'utf8'), 'old-one');
    assert.equal(await readFile(path.join(destinationTwo, 'value.txt'), 'utf8'), 'old-two');
    assert.equal(await readFile(path.join(sourceOne, 'value.txt'), 'utf8'), 'new-one');
    assert.equal(await readFile(path.join(sourceTwo, 'value.txt'), 'utf8'), 'new-two');
  });
});
