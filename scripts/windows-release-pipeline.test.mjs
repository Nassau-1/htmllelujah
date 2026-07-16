import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertSourceSnapshotIdentity } from './release-source-state.mjs';
import {
  assertCandidateManifest,
  assertReleasePublicationBinding,
  remoteTagCommitFromLsRemote,
} from './release-candidate-manifest.mjs';
import {
  assertTrackedReleaseNotes,
  buildFinalReleaseRecord,
} from './release-finalization-support.mjs';
import { runGithubReleasePublication } from './github-release-publication-runner.mjs';
import {
  assertExactGithubRelease,
  assertPublishableReleaseNotes,
  publishGithubRelease,
} from './github-release-publication.mjs';
import {
  acquireReleaseLock,
  attestWorkspacePackageOutputs,
  assertNoPendingReleasePromotions,
  assertSafeReleaseDirectoryPath,
  assertWorkspacePackageOutputsStable,
  buildCommandPlan,
  createReleaseEnvironment,
  discoverWorkspacePackages,
  promoteDirectoriesAtomically,
  recoverPendingReleasePromotions,
  recoverReleasePromotion,
  releaseReleaseLock,
  RELEASE_PROMOTION_PREFIX,
  resolveCorepackInvocation,
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
  const releaseLock = await acquireReleaseLock({
    transactionParent: root,
    purpose: `test:${prefix}`,
  });
  try {
    return await operation(root, releaseLock);
  } finally {
    await releaseReleaseLock({ releaseLock });
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
    github_token: 'case-insensitive-secret',
    electron_run_as_node: '1',
  });
  assert.equal(environment.PATH, 'fixture-path');
  assert.equal(environment.CI, 'true');
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GITLAB_TOKEN', 'AWS_ACCESS_KEY_ID']) {
    assert.equal(environment[key], undefined);
  }
  for (const key of Object.keys(environment)) {
    assert.equal(key.toUpperCase() === 'NODE_OPTIONS', false);
    assert.equal(key.toUpperCase() === 'ELECTRON_RUN_AS_NODE', false);
    assert.equal(key.toUpperCase() === 'VITE_DEV_SERVER_URL', false);
    assert.equal(key.toUpperCase() === 'GITHUB_TOKEN', false);
  }
  assert.equal(environment.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
});

test('Windows Corepack resolves to a JavaScript entry instead of a cmd shim', () => {
  const executable = path.join('C:\\', 'Program Files', 'nodejs', 'node.exe');
  const corepackEntry = path.join(
    path.dirname(executable),
    'node_modules',
    'corepack',
    'dist',
    'corepack.js',
  );
  const invocation = resolveCorepackInvocation({
    executable,
    environment: { Path: '' },
    platform: 'win32',
    pathExists: (entry) => path.resolve(entry) === path.resolve(corepackEntry),
  });
  assert.equal(invocation.command, executable);
  assert.deepEqual(invocation.argsPrefix, [path.resolve(corepackEntry)]);
  assert.equal(invocation.command.toLowerCase().endsWith('.cmd'), false);
});

test(
  'resolved Windows Corepack entry launches without a shell',
  { skip: process.platform !== 'win32' },
  () => {
    const invocation = resolveCorepackInvocation();
    const result = spawnSync(invocation.command, [...invocation.argsPrefix, '--version'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: createReleaseEnvironment(process.env),
      shell: false,
      windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, String(result.stderr ?? ''));
    assert.match(String(result.stdout ?? '').trim(), /^\d+\.\d+\.\d+/u);
  },
);

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

test('publication binding requires the exact current, local-tag, and remote-tag candidate commit', () => {
  const commit = 'a'.repeat(40);
  const tagObject = 'e'.repeat(40);
  const manifest = {
    schemaVersion: 2,
    version: '1.0.0',
    source: { commit, dirty: false },
  };
  assert.doesNotThrow(() =>
    assertReleasePublicationBinding({
      manifest,
      tag: 'v1.0.0',
      currentCommit: commit,
      localTagCommit: commit,
      localTagObjectType: 'tag',
      localTagObjectId: tagObject,
      remoteTagCommit: commit,
      remoteTagObjectId: tagObject,
    }),
  );
  for (const mismatch of [
    { tag: 'v1.0.1' },
    { currentCommit: 'b'.repeat(40) },
    { localTagCommit: 'c'.repeat(40) },
    { localTagObjectType: 'commit' },
    { remoteTagObjectId: 'f'.repeat(40) },
    { remoteTagCommit: 'd'.repeat(40) },
  ]) {
    assert.throws(
      () =>
        assertReleasePublicationBinding({
          manifest,
          tag: 'v1.0.0',
          currentCommit: commit,
          localTagCommit: commit,
          localTagObjectType: 'tag',
          localTagObjectId: tagObject,
          remoteTagCommit: commit,
          remoteTagObjectId: tagObject,
          ...mismatch,
        }),
      /publication binding failed/iu,
    );
  }
  assert.equal(
    remoteTagCommitFromLsRemote({
      output: `${tagObject}\trefs/tags/v1.0.0\n${commit}\trefs/tags/v1.0.0^{}`,
      tag: 'v1.0.0',
    }),
    commit,
  );
  assert.throws(
    () => remoteTagCommitFromLsRemote({ output: '', tag: 'v1.0.0' }),
    /does not exist/iu,
  );
  assert.throws(
    () =>
      remoteTagCommitFromLsRemote({
        output: `${commit}\trefs/tags/v1.0.0`,
        tag: 'v1.0.0',
      }),
    /not an annotated tag/iu,
  );
  assert.throws(
    () =>
      remoteTagCommitFromLsRemote({
        output: `${'a'.repeat(41)}\trefs/tags/v1.0.0`,
        tag: 'v1.0.0',
      }),
    /malformed output/iu,
  );
});

test('multi-directory promotion rolls back every final artifact on failure', async () => {
  await withTemporaryRoot('htmllelujah-promotion-', async (root, releaseLock) => {
    const sourceOne = path.join(root, 'stage-one');
    const sourceTwo = path.join(root, 'stage-two');
    const destinationOne = path.join(root, 'final-one');
    const destinationTwo = path.join(root, 'final-two');
    const transactionRoot = path.join(root, `${RELEASE_PROMOTION_PREFIX}rollback-fixture`);
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
        releaseLock,
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

test('promotion rejects empty, cross-linked, case-folded, and wrong-lock transaction graphs', async () => {
  await withTemporaryRoot('htmllelujah-promotion-graph-', async (root, releaseLock) => {
    await assert.rejects(
      promoteDirectoriesAtomically({
        promotions: [],
        transactionRoot: path.join(root, `${RELEASE_PROMOTION_PREFIX}empty`),
        releaseLock,
      }),
      /at least one/iu,
    );
    const sourceOne = path.join(root, 'source-one');
    const shared = path.join(root, 'shared-generation');
    const destinationTwo = path.join(root, 'destination-two');
    for (const directory of [sourceOne, shared, destinationTwo]) {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'value.txt'), directory);
    }
    await assert.rejects(
      promoteDirectoriesAtomically({
        promotions: [
          { source: sourceOne, destination: shared },
          { source: shared, destination: destinationTwo },
        ],
        transactionRoot: path.join(root, `${RELEASE_PROMOTION_PREFIX}cross-linked`),
        releaseLock,
      }),
      /graphs must be disjoint/iu,
    );
    if (process.platform === 'win32') {
      await assert.rejects(
        promoteDirectoriesAtomically({
          promotions: [{ source: sourceOne, destination: sourceOne.toUpperCase() }],
          transactionRoot: path.join(root, `${RELEASE_PROMOTION_PREFIX}case-folded`),
          releaseLock,
        }),
        /source equals destination/iu,
      );
    }
    const otherRoot = await mkdtemp(path.join(os.tmpdir(), 'htmllelujah-wrong-lock-parent-'));
    try {
      await assert.rejects(
        assertNoPendingReleasePromotions({ transactionParent: otherRoot, releaseLock }),
        /does not cover/iu,
      );
      await assert.rejects(
        recoverReleasePromotion({
          transactionRoot: path.join(otherRoot, `${RELEASE_PROMOTION_PREFIX}wrong-lock`),
          releaseLock,
        }),
        /does not cover/iu,
      );
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });
});

const createPromotionFixture = async (root, name) => {
  const fixtureRoot = path.join(root, name.replaceAll(':', '-'));
  const sourceOne = path.join(fixtureRoot, 'stage-one');
  const sourceTwo = path.join(fixtureRoot, 'stage-two');
  const destinationOne = path.join(fixtureRoot, 'final-one');
  const destinationTwo = path.join(fixtureRoot, 'final-two');
  const transactionRoot = path.join(
    root,
    `${RELEASE_PROMOTION_PREFIX}${name.replaceAll(':', '-')}`,
  );
  for (const [directory, content] of [
    [sourceOne, 'new-one'],
    [sourceTwo, 'new-two'],
    [destinationOne, 'old-one'],
    [destinationTwo, 'old-two'],
  ]) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'value.txt'), content);
  }
  return {
    sourceOne,
    sourceTwo,
    destinationOne,
    destinationTwo,
    transactionRoot,
    promotions: [
      { source: sourceOne, destination: destinationOne },
      { source: sourceTwo, destination: destinationTwo },
    ],
  };
};

test('durable journal recovers every pre-commit crash checkpoint to the prior pair', async () => {
  await withTemporaryRoot('htmllelujah-promotion-crash-', async (root, releaseLock) => {
    for (const phase of [
      'preparation-created',
      'preparation-durable',
      'journal-durable',
      'backup:0',
      'promote:0',
      'backup:1',
      'promote:1',
      'identities-verified',
      'validation-complete',
    ]) {
      const fixture = await createPromotionFixture(root, phase);
      await assert.rejects(
        promoteDirectoriesAtomically({
          promotions: fixture.promotions,
          transactionRoot: fixture.transactionRoot,
          releaseLock,
          rollbackOnError: false,
          checkpoint: async (checkpoint) => {
            if (checkpoint === phase) throw new Error(`synthetic crash at ${phase}`);
          },
        }),
        /synthetic crash/iu,
      );
      await assert.rejects(
        assertNoPendingReleasePromotions({ transactionParent: root, releaseLock }),
        /publication is blocked/iu,
      );
      if (phase.startsWith('preparation-')) {
        const recovered = await recoverPendingReleasePromotions({
          transactionParent: root,
          releaseLock,
          allowedSourceParent: null,
        });
        assert.equal(recovered.length, 0);
      } else {
        const recovered = await recoverReleasePromotion({
          transactionRoot: fixture.transactionRoot,
          releaseLock,
        });
        assert.equal(recovered.disposition, 'rolled-back');
      }
      assert.equal(await readFile(path.join(fixture.sourceOne, 'value.txt'), 'utf8'), 'new-one');
      assert.equal(await readFile(path.join(fixture.sourceTwo, 'value.txt'), 'utf8'), 'new-two');
      assert.equal(
        await readFile(path.join(fixture.destinationOne, 'value.txt'), 'utf8'),
        'old-one',
      );
      assert.equal(
        await readFile(path.join(fixture.destinationTwo, 'value.txt'), 'utf8'),
        'old-two',
      );
      await assert.rejects(access(fixture.transactionRoot), /ENOENT/iu);
      await assert.doesNotReject(
        assertNoPendingReleasePromotions({ transactionParent: root, releaseLock }),
      );
    }
  });
});

test('real child termination recovers journal, commit, and tombstone checkpoints fail-closed', async () => {
  const childScript = path.join(repositoryRoot, 'scripts', 'release-promotion-crash-child.mjs');
  for (const phase of [
    'journal-durable',
    'backup:0',
    'promote:0',
    'commit-durable',
    'tombstone-durable',
  ]) {
    const safePhase = phase.replaceAll(':', '-');
    const root = await mkdtemp(path.join(os.tmpdir(), `htmllelujah-sigkill-${safePhase}-`));
    let releaseLock;
    try {
      const source = path.join(root, 'stage');
      const destination = path.join(root, 'final');
      const transactionRoot = path.join(root, `${RELEASE_PROMOTION_PREFIX}${safePhase}`);
      const reachedMarker = path.join(root, `reached-${safePhase}.txt`);
      await mkdir(source, { recursive: true });
      await mkdir(destination, { recursive: true });
      await writeFile(path.join(source, 'value.txt'), 'new-generation');
      await writeFile(path.join(destination, 'value.txt'), 'old-generation');
      const child = spawnSync(
        process.execPath,
        [childScript, transactionRoot, source, destination, phase, reachedMarker],
        {
          cwd: repositoryRoot,
          encoding: 'utf8',
          env: process.env,
          shell: false,
          timeout: 60_000,
          windowsHide: true,
        },
      );
      assert.notEqual(child.status, 0, `child unexpectedly survived ${phase}`);
      assert.equal((await readFile(reachedMarker, 'utf8')).trim(), phase);
      releaseLock = await acquireReleaseLock({
        transactionParent: root,
        purpose: `recover-sigkill:${phase}`,
      });
      if (['journal-durable', 'backup:0', 'promote:0'].includes(phase)) {
        const recovered = await recoverReleasePromotion({
          transactionRoot,
          releaseLock,
        });
        assert.equal(recovered.disposition, 'rolled-back');
        assert.equal(await readFile(path.join(source, 'value.txt'), 'utf8'), 'new-generation');
        assert.equal(await readFile(path.join(destination, 'value.txt'), 'utf8'), 'old-generation');
      } else if (phase === 'commit-durable') {
        const recovered = await recoverReleasePromotion({
          transactionRoot,
          releaseLock,
        });
        assert.equal(recovered.disposition, 'committed');
        await assert.rejects(access(source), /ENOENT/iu);
        assert.equal(await readFile(path.join(destination, 'value.txt'), 'utf8'), 'new-generation');
      } else {
        await assert.doesNotReject(
          assertNoPendingReleasePromotions({ transactionParent: root, releaseLock }),
        );
        await assert.rejects(access(source), /ENOENT/iu);
        assert.equal(await readFile(path.join(destination, 'value.txt'), 'utf8'), 'new-generation');
      }
    } finally {
      if (releaseLock) await releaseReleaseLock({ releaseLock });
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('a crash after the durable commit keeps only the revalidated candidate pair', async () => {
  await withTemporaryRoot('htmllelujah-promotion-committed-', async (root, releaseLock) => {
    const fixture = await createPromotionFixture(root, 'committed');
    let validationCount = 0;
    let committedJournal;
    await assert.rejects(
      promoteDirectoriesAtomically({
        promotions: fixture.promotions,
        transactionRoot: fixture.transactionRoot,
        releaseLock,
        rollbackOnError: false,
        validatePromoted: async () => {
          validationCount += 1;
        },
        checkpoint: async (checkpoint, journal) => {
          if (checkpoint === 'commit-durable') {
            committedJournal = journal;
            throw new Error('synthetic committed crash');
          }
        },
      }),
      /synthetic committed crash/iu,
    );
    assert.equal(validationCount, 1);
    assert.ok(committedJournal);
    await rm(committedJournal.records[0].backup, { recursive: true, force: true });
    const recovered = await recoverReleasePromotion({
      transactionRoot: fixture.transactionRoot,
      releaseLock,
      validateCommitted: async () => {
        validationCount += 1;
      },
    });
    assert.equal(recovered.disposition, 'committed');
    assert.equal(validationCount, 2);
    assert.equal(await readFile(path.join(fixture.destinationOne, 'value.txt'), 'utf8'), 'new-one');
    assert.equal(await readFile(path.join(fixture.destinationTwo, 'value.txt'), 'utf8'), 'new-two');
    await assert.rejects(access(fixture.sourceOne), /ENOENT/iu);
    await assert.rejects(access(fixture.sourceTwo), /ENOENT/iu);
  });
});

test('commit marker is cryptographically bound to the exact durable journal bytes', async () => {
  await withTemporaryRoot('htmllelujah-promotion-journal-hash-', async (root, releaseLock) => {
    const fixture = await createPromotionFixture(root, 'journal-hash');
    await assert.rejects(
      promoteDirectoriesAtomically({
        promotions: fixture.promotions,
        transactionRoot: fixture.transactionRoot,
        releaseLock,
        rollbackOnError: false,
        checkpoint: async (checkpoint) => {
          if (checkpoint === 'commit-durable') throw new Error('synthetic committed crash');
        },
      }),
      /synthetic committed crash/iu,
    );
    const journalPath = path.join(fixture.transactionRoot, 'transaction.json');
    const journalText = await readFile(journalPath, 'utf8');
    await writeFile(journalPath, ` ${journalText}`);
    await assert.rejects(
      recoverReleasePromotion({ transactionRoot: fixture.transactionRoot, releaseLock }),
      /commit marker is invalid/iu,
    );
    await assert.rejects(
      assertNoPendingReleasePromotions({ transactionParent: root, releaseLock }),
      /publication is blocked/iu,
    );
  });
});

test('post-promotion validation failure rolls back and ambiguous recovery stays fail-closed', async () => {
  await withTemporaryRoot('htmllelujah-promotion-validation-', async (root, releaseLock) => {
    const validationFixture = await createPromotionFixture(root, 'validation-failure');
    await assert.rejects(
      promoteDirectoriesAtomically({
        promotions: validationFixture.promotions,
        transactionRoot: validationFixture.transactionRoot,
        releaseLock,
        validatePromoted: async () => {
          throw new Error('synthetic post-promotion validation failure');
        },
      }),
      /post-promotion validation failure/iu,
    );
    assert.equal(
      await readFile(path.join(validationFixture.destinationOne, 'value.txt'), 'utf8'),
      'old-one',
    );
    assert.equal(
      await readFile(path.join(validationFixture.destinationTwo, 'value.txt'), 'utf8'),
      'old-two',
    );

    const ambiguousFixture = await createPromotionFixture(root, 'ambiguous');
    await assert.rejects(
      promoteDirectoriesAtomically({
        promotions: ambiguousFixture.promotions,
        transactionRoot: ambiguousFixture.transactionRoot,
        releaseLock,
        rollbackOnError: false,
        checkpoint: async (checkpoint) => {
          if (checkpoint === 'promote:0') throw new Error('synthetic abrupt exit');
        },
      }),
      /synthetic abrupt exit/iu,
    );
    await writeFile(path.join(ambiguousFixture.destinationOne, 'value.txt'), 'tampered');
    await assert.rejects(
      recoverReleasePromotion({
        transactionRoot: ambiguousFixture.transactionRoot,
        releaseLock,
      }),
      /unexpected content/iu,
    );
    await assert.rejects(
      assertNoPendingReleasePromotions({ transactionParent: root, releaseLock }),
      /publication is blocked/iu,
    );
  });
});

test('startup recovery scans only safe release worktrees and exact final destinations', async () => {
  await withTemporaryRoot('htmllelujah-promotion-startup-', async (root, releaseLock) => {
    const worktreeRoot = path.join(root, '.htmllelujah-release-worktree-fixture');
    const sourceOne = path.join(worktreeRoot, 'apps', 'desktop', 'out');
    const sourceTwo = path.join(worktreeRoot, 'artifacts', 'release-evidence');
    const destinationOne = path.join(root, 'repository', 'apps', 'desktop', 'out');
    const destinationTwo = path.join(root, 'repository', 'artifacts', 'release-evidence');
    for (const [directory, content] of [
      [sourceOne, 'new-one'],
      [sourceTwo, 'new-two'],
      [destinationOne, 'old-one'],
      [destinationTwo, 'old-two'],
    ]) {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'value.txt'), content);
    }
    const transactionRoot = path.join(root, `${RELEASE_PROMOTION_PREFIX}startup-fixture`);
    await assert.rejects(
      promoteDirectoriesAtomically({
        promotions: [
          { source: sourceOne, destination: destinationOne },
          { source: sourceTwo, destination: destinationTwo },
        ],
        transactionRoot,
        releaseLock,
        rollbackOnError: false,
        checkpoint: async (checkpoint) => {
          if (checkpoint === 'promote:0') throw new Error('synthetic startup crash');
        },
      }),
      /synthetic startup crash/iu,
    );
    await assert.rejects(
      recoverPendingReleasePromotions({
        transactionParent: root,
        releaseLock,
        allowedSourceParent: root,
        allowedDestinations: [destinationOne, destinationTwo],
        allowedSourceLayouts: [
          { destination: destinationOne, relativeSource: 'unexpected/out' },
          { destination: destinationTwo, relativeSource: 'artifacts/release-evidence' },
        ],
      }),
      /unexpected staging layout/iu,
    );
    const recovered = await recoverPendingReleasePromotions({
      transactionParent: root,
      releaseLock,
      allowedSourceParent: root,
      allowedDestinations: [destinationOne, destinationTwo],
      allowedSourceLayouts: [
        { destination: destinationOne, relativeSource: 'apps/desktop/out' },
        { destination: destinationTwo, relativeSource: 'artifacts/release-evidence' },
      ],
    });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].disposition, 'rolled-back');
    assert.equal(await readFile(path.join(sourceOne, 'value.txt'), 'utf8'), 'new-one');
    assert.equal(await readFile(path.join(sourceTwo, 'value.txt'), 'utf8'), 'new-two');
    assert.equal(await readFile(path.join(destinationOne, 'value.txt'), 'utf8'), 'old-one');
    assert.equal(await readFile(path.join(destinationTwo, 'value.txt'), 'utf8'), 'old-two');
  });
});

test('promotion retries bounded transient Windows rename failures before committing', async () => {
  await withTemporaryRoot('htmllelujah-promotion-retry-', async (root, releaseLock) => {
    const fixture = await createPromotionFixture(root, 'retry');
    const { rename: realRename } = await import('node:fs/promises');
    let transientFailures = 0;
    await promoteDirectoriesAtomically({
      promotions: fixture.promotions,
      transactionRoot: fixture.transactionRoot,
      releaseLock,
      fsOps: {
        rename: async (source, destination) => {
          if (
            source === fixture.sourceOne &&
            destination === fixture.destinationOne &&
            transientFailures < 2
          ) {
            transientFailures += 1;
            const error = new Error('synthetic sharing violation');
            error.code = 'EPERM';
            throw error;
          }
          await realRename(source, destination);
        },
      },
    });
    assert.equal(transientFailures, 2);
    assert.equal(await readFile(path.join(fixture.destinationOne, 'value.txt'), 'utf8'), 'new-one');
    assert.equal(await readFile(path.join(fixture.destinationTwo, 'value.txt'), 'utf8'), 'new-two');
    await assert.rejects(access(fixture.transactionRoot), /ENOENT/iu);
  });
});

test('every critical rename flushes both parent directories before its checkpoint', async () => {
  await withTemporaryRoot('htmllelujah-promotion-flush-order-', async (root, releaseLock) => {
    const source = path.join(root, 'staging', 'candidate');
    const destination = path.join(root, 'final', 'candidate');
    const transactionRoot = path.join(root, `${RELEASE_PROMOTION_PREFIX}flush-order`);
    await mkdir(source, { recursive: true });
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(source, 'value.txt'), 'new');
    await writeFile(path.join(destination, 'value.txt'), 'old');
    const { rename: realRename } = await import('node:fs/promises');
    const events = [];
    await promoteDirectoriesAtomically({
      promotions: [{ source, destination }],
      transactionRoot,
      releaseLock,
      fsOps: {
        rename: async (from, to) => {
          events.push(`rename:${from}->${to}`);
          await realRename(from, to);
        },
        syncDirectoryMetadata: async (directory) => {
          events.push(`sync:${directory}`);
        },
      },
      checkpoint: async (checkpoint) => {
        events.push(`checkpoint:${checkpoint}`);
      },
    });
    const assertRenameBarrier = ({ from, to, checkpoint, parents }) => {
      const renameIndex = events.findIndex((event) => event === `rename:${from}->${to}`);
      const checkpointIndex = events.findIndex((event) => event === `checkpoint:${checkpoint}`);
      assert.ok(
        renameIndex >= 0 && checkpointIndex > renameIndex,
        `${checkpoint} ordering is missing`,
      );
      const between = events.slice(renameIndex + 1, checkpointIndex);
      for (const parent of parents) assert.ok(between.includes(`sync:${parent}`));
    };
    const activeRename = events.find((event) =>
      event.startsWith(`rename:${path.join(root, '.htmllelujah-release-preparation-')}`),
    );
    assert.ok(activeRename);
    const [activeFrom, activeTo] = activeRename.slice('rename:'.length).split('->');
    assertRenameBarrier({
      from: activeFrom,
      to: activeTo,
      checkpoint: 'journal-durable',
      parents: [root],
    });
    const backupRename = events.find(
      (event) => event.startsWith(`rename:${destination}->`) && event.includes('.backup'),
    );
    assert.ok(backupRename);
    const [, backupTo] = backupRename.slice('rename:'.length).split('->');
    assertRenameBarrier({
      from: destination,
      to: backupTo,
      checkpoint: 'backup:0',
      parents: [path.dirname(destination), transactionRoot],
    });
    assertRenameBarrier({
      from: source,
      to: destination,
      checkpoint: 'promote:0',
      parents: [path.dirname(source), path.dirname(destination)],
    });
    const commitRename = events.find(
      (event) =>
        event.startsWith(`rename:${path.join(transactionRoot, 'committed.json.')}`) &&
        event.endsWith(`->${path.join(transactionRoot, 'committed.json')}`),
    );
    assert.ok(commitRename);
    const [commitFrom, commitTo] = commitRename.slice('rename:'.length).split('->');
    assertRenameBarrier({
      from: commitFrom,
      to: commitTo,
      checkpoint: 'commit-durable',
      parents: [transactionRoot],
    });
    const tombstoneRename = events.find(
      (event) =>
        event.startsWith(`rename:${transactionRoot}->`) && event.includes('release-cleanup'),
    );
    assert.ok(tombstoneRename);
    const [, tombstoneTo] = tombstoneRename.slice('rename:'.length).split('->');
    assertRenameBarrier({
      from: transactionRoot,
      to: tombstoneTo,
      checkpoint: 'tombstone-durable',
      parents: [root],
    });
  });
});

test('rollback accepts an initial prior destination identical to the staged candidate', async () => {
  await withTemporaryRoot('htmllelujah-promotion-identical-', async (root, releaseLock) => {
    const source = path.join(root, 'stage');
    const destination = path.join(root, 'final');
    const transactionRoot = path.join(root, `${RELEASE_PROMOTION_PREFIX}identical`);
    for (const directory of [source, destination]) {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'value.txt'), 'same-generation');
    }
    await assert.rejects(
      promoteDirectoriesAtomically({
        promotions: [{ source, destination }],
        transactionRoot,
        releaseLock,
        rollbackOnError: false,
        checkpoint: async (checkpoint) => {
          if (checkpoint === 'journal-durable') throw new Error('synthetic identical crash');
        },
      }),
      /synthetic identical crash/iu,
    );
    const recovered = await recoverReleasePromotion({ transactionRoot, releaseLock });
    assert.equal(recovered.disposition, 'rolled-back');
    assert.equal(await readFile(path.join(source, 'value.txt'), 'utf8'), 'same-generation');
    assert.equal(await readFile(path.join(destination, 'value.txt'), 'utf8'), 'same-generation');
  });
});

test('committed cleanup crash leaves a safe tombstone that startup recovery removes', async () => {
  await withTemporaryRoot('htmllelujah-promotion-tombstone-', async (root, releaseLock) => {
    const fixture = await createPromotionFixture(root, 'tombstone');
    const { rm: realRm } = await import('node:fs/promises');
    let cleanupCrashInjected = false;
    await assert.rejects(
      promoteDirectoriesAtomically({
        promotions: fixture.promotions,
        transactionRoot: fixture.transactionRoot,
        releaseLock,
        fsOps: {
          rm: async (target, options) => {
            if (
              !cleanupCrashInjected &&
              path.basename(target).startsWith('.htmllelujah-release-cleanup-')
            ) {
              cleanupCrashInjected = true;
              throw new Error('synthetic tombstone cleanup crash');
            }
            await realRm(target, options);
          },
        },
      }),
      /tombstone cleanup crash/iu,
    );
    assert.equal(cleanupCrashInjected, true);
    await assert.doesNotReject(
      assertNoPendingReleasePromotions({ transactionParent: root, releaseLock }),
    );
    const recovered = await recoverPendingReleasePromotions({
      transactionParent: root,
      releaseLock,
      allowedSourceParent: null,
    });
    assert.equal(recovered.length, 0);
    assert.equal(await readFile(path.join(fixture.destinationOne, 'value.txt'), 'utf8'), 'new-one');
    assert.equal(await readFile(path.join(fixture.destinationTwo, 'value.txt'), 'utf8'), 'new-two');
  });
});

test('shared release lock rejects a concurrent live release operation', async () => {
  await withTemporaryRoot('htmllelujah-release-lock-', async (root, releaseLock) => {
    await assert.rejects(
      acquireReleaseLock({ transactionParent: root, purpose: 'concurrent-test' }),
      /already active/iu,
    );
    await assert.rejects(
      assertNoPendingReleasePromotions({
        transactionParent: root,
        releaseLock,
        fsOps: {
          exists: async () => {
            const error = new Error('synthetic access denial');
            error.code = 'EACCES';
            throw error;
          },
        },
      }),
      /synthetic access denial/iu,
    );
  });
});

test('release roots reject symbolic links and Windows junctions before inventory', async (t) => {
  await withTemporaryRoot('htmllelujah-release-reparse-', async (root) => {
    const target = path.join(root, 'real-target');
    const linked = path.join(root, 'linked-target');
    await mkdir(target, { recursive: true });
    try {
      await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip('Creating a junction/symlink is unavailable for this Windows token.');
        return;
      }
      throw error;
    }
    await assert.rejects(
      assertSafeReleaseDirectoryPath({ directory: linked }),
      /symbolic link or junction/iu,
    );
  });
});

test('journal, commit marker, and lock owner must each be regular non-link files', async () => {
  await withTemporaryRoot('htmllelujah-release-control-file-links-', async (root, releaseLock) => {
    const linkMetadata = {
      isSymbolicLink: () => true,
      isFile: () => false,
      isDirectory: () => false,
    };
    const journalFixture = await createPromotionFixture(root, 'linked-journal');
    await assert.rejects(
      promoteDirectoriesAtomically({
        promotions: journalFixture.promotions,
        transactionRoot: journalFixture.transactionRoot,
        releaseLock,
        rollbackOnError: false,
        checkpoint: async (checkpoint) => {
          if (checkpoint === 'journal-durable') throw new Error('journal crash');
        },
      }),
      /journal crash/iu,
    );
    const journalPath = path.join(journalFixture.transactionRoot, 'transaction.json');
    await assert.rejects(
      recoverReleasePromotion({
        transactionRoot: journalFixture.transactionRoot,
        releaseLock,
        fsOps: {
          lstat: async (target) => (target === journalPath ? linkMetadata : lstat(target)),
        },
      }),
      (error) =>
        /durable journal cannot be read/iu.test(error?.message ?? '') &&
        /regular non-link/iu.test(error?.cause?.message ?? ''),
    );
    await recoverReleasePromotion({
      transactionRoot: journalFixture.transactionRoot,
      releaseLock,
    });

    const commitFixture = await createPromotionFixture(root, 'linked-commit');
    await assert.rejects(
      promoteDirectoriesAtomically({
        promotions: commitFixture.promotions,
        transactionRoot: commitFixture.transactionRoot,
        releaseLock,
        rollbackOnError: false,
        checkpoint: async (checkpoint) => {
          if (checkpoint === 'commit-durable') throw new Error('commit crash');
        },
      }),
      /commit crash/iu,
    );
    const commitPath = path.join(commitFixture.transactionRoot, 'committed.json');
    await assert.rejects(
      recoverReleasePromotion({
        transactionRoot: commitFixture.transactionRoot,
        releaseLock,
        fsOps: {
          lstat: async (target) => (target === commitPath ? linkMetadata : lstat(target)),
        },
      }),
      (error) =>
        /commit marker cannot be read/iu.test(error?.message ?? '') &&
        /regular non-link/iu.test(error?.cause?.message ?? ''),
    );
    await recoverReleasePromotion({
      transactionRoot: commitFixture.transactionRoot,
      releaseLock,
    });

    const ownerPath = path.join(releaseLock.root, 'owner.json');
    await assert.rejects(
      assertNoPendingReleasePromotions({
        transactionParent: root,
        releaseLock,
        fsOps: {
          lstat: async (target) => (target === ownerPath ? linkMetadata : lstat(target)),
        },
      }),
      (error) =>
        /owner record is unreadable/iu.test(error?.message ?? '') &&
        /regular non-link/iu.test(error?.cause?.message ?? ''),
    );
  });
});

test('shared release lock replaces a provably dead prior owner', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'htmllelujah-release-stale-lock-'));
  let replacement;
  try {
    await acquireReleaseLock({ transactionParent: root, purpose: 'synthetic-dead-owner' });
    replacement = await acquireReleaseLock({
      transactionParent: root,
      purpose: 'replacement-owner',
      fsOps: { processIsAlive: () => false },
    });
    await assert.doesNotReject(
      assertNoPendingReleasePromotions({ transactionParent: root, releaseLock: replacement }),
    );
  } finally {
    if (replacement) await releaseReleaseLock({ releaseLock: replacement });
    await rm(root, { recursive: true, force: true });
  }
});

test('shared release lock treats a live PID with a different start identity as PID reuse', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'htmllelujah-release-reused-pid-lock-'));
  let replacement;
  try {
    await acquireReleaseLock({ transactionParent: root, purpose: 'synthetic-prior-process' });
    replacement = await acquireReleaseLock({
      transactionParent: root,
      purpose: 'pid-reuse-replacement',
      fsOps: {
        processIdentity: async () => ({
          alive: true,
          processStartedAt: 'different-process-start-identity',
        }),
      },
    });
    await assert.doesNotReject(
      assertNoPendingReleasePromotions({ transactionParent: root, releaseLock: replacement }),
    );
  } finally {
    if (replacement) await releaseReleaseLock({ releaseLock: replacement });
    await rm(root, { recursive: true, force: true });
  }
});

test('shared release lock distinguishes a live child identity and recovers only after its death', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'htmllelujah-release-multiprocess-lock-'));
  const childScript = path.join(repositoryRoot, 'scripts', 'release-lock-child.mjs');
  const holder = spawn(process.execPath, [childScript, 'hold', root], {
    cwd: repositoryRoot,
    env: process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Timed out waiting for child lock.')),
        15_000,
      );
      let stderr = '';
      holder.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      holder.stdout.on('data', (chunk) => {
        if (!chunk.toString().includes('LOCKED')) return;
        clearTimeout(timeout);
        resolve();
      });
      holder.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Lock holder exited early (${code}): ${stderr}`));
      });
    });
    const contender = spawnSync(process.execPath, [childScript, 'try', root], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: process.env,
      shell: false,
      timeout: 30_000,
      windowsHide: true,
    });
    assert.equal(contender.status, 2);
    assert.match(contender.stderr, /already active/iu);

    holder.kill('SIGKILL');
    await new Promise((resolve) => holder.once('exit', resolve));
    const recovery = spawnSync(process.execPath, [childScript, 'try', root], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: process.env,
      shell: false,
      timeout: 30_000,
      windowsHide: true,
    });
    assert.equal(recovery.status, 0, recovery.stderr);
    assert.match(recovery.stdout, /ACQUIRED/iu);
  } finally {
    if (holder.exitCode === null) holder.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});

const publicationRepository = 'Nassau-1/htmllelujah';
const publicationTag = 'v1.0.0';
const publicationTitle = 'HTMLlelujah v1.0.0';
const publicationNotes = '# HTMLlelujah v1.0.0\n\nA verified offline-first Windows release.\n';
const publicationAssets = [
  {
    role: 'windows-installer',
    name: 'HTMLlelujah-1.0.0.exe',
    size: 101,
    sha256: 'a'.repeat(64),
    filePath: 'C:\\release\\HTMLlelujah-1.0.0.exe',
  },
  {
    role: 'final-release-record',
    name: 'HTMLlelujah-1.0.0-release-record.json',
    size: 202,
    sha256: 'b'.repeat(64),
    filePath: 'C:\\release\\HTMLlelujah-1.0.0-release-record.json',
  },
];

const githubReleaseFixture = ({ draft = true, assets = publicationAssets } = {}) => ({
  id: 42,
  url: `https://api.github.com/repos/${publicationRepository}/releases/42`,
  html_url: `https://github.com/${publicationRepository}/releases/tag/${publicationTag}`,
  tag_name: publicationTag,
  name: publicationTitle,
  body: publicationNotes,
  draft,
  prerelease: false,
  assets: assets.map((asset, index) => ({
    id: 100 + index,
    name: asset.name,
    size: asset.size,
    state: 'uploaded',
    digest: `sha256:${asset.sha256}`,
    url: `https://api.github.com/repos/${publicationRepository}/releases/assets/${100 + index}`,
    browser_download_url: `https://github.com/${publicationRepository}/releases/download/${publicationTag}/${encodeURIComponent(asset.name)}`,
  })),
});

const githubRepositoryFixture = () => ({
  full_name: publicationRepository,
  private: false,
  visibility: 'public',
  html_url: `https://github.com/${publicationRepository}`,
});

test('GitHub release validation rejects every non-exact public identity', () => {
  const exact = githubReleaseFixture();
  assert.doesNotThrow(() =>
    assertExactGithubRelease({
      release: exact,
      repository: publicationRepository,
      tag: publicationTag,
      title: publicationTitle,
      body: publicationNotes,
      assets: publicationAssets,
      draft: true,
    }),
  );
  const mutations = [
    (release) => {
      release.prerelease = true;
    },
    (release) => {
      release.name = 'Wrong title';
    },
    (release) => {
      release.body = 'Wrong body';
    },
    (release) => {
      release.assets.pop();
    },
    (release) => {
      release.assets.push(structuredClone(release.assets[0]));
    },
    (release) => {
      release.assets[0].size += 1;
    },
    (release) => {
      release.assets[0].digest = `sha256:${'c'.repeat(64)}`;
    },
    (release) => {
      release.assets[0].state = 'new';
    },
    (release) => {
      release.assets[0].url = 'https://api.github.example/repos/escaped';
    },
    (release) => {
      release.assets[0].browser_download_url = 'https://github.com/other/repo/file';
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(exact);
    mutate(changed);
    assert.throws(
      () =>
        assertExactGithubRelease({
          release: changed,
          repository: publicationRepository,
          tag: publicationTag,
          title: publicationTitle,
          body: publicationNotes,
          assets: publicationAssets,
          draft: true,
        }),
      /GitHub release/iu,
    );
  }
  assert.throws(
    () =>
      assertExactGithubRelease({
        release: exact,
        repository: publicationRepository,
        tag: publicationTag,
        title: publicationTitle,
        body: publicationNotes,
        assets: [...publicationAssets, publicationAssets[0]],
        draft: true,
      }),
    /allowlist/iu,
  );
});

const withPublicationFixture = async (operation) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'htmllelujah-publication-'));
  const notesFile = path.join(root, 'release-notes.md');
  await writeFile(notesFile, publicationNotes);
  try {
    return await operation(notesFile);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const publicationHarness = ({ notesFile, initialRelease = null, downloadFailure = null }) => {
  let release = initialRelease === null ? null : structuredClone(initialRelease);
  const commands = [];
  const stages = [];
  const bindings = [];
  return {
    get release() {
      return release;
    },
    commands,
    stages,
    bindings,
    options: {
      mode: 'publish',
      repository: publicationRepository,
      tag: publicationTag,
      title: publicationTitle,
      notesFile,
      notesBody: publicationNotes,
      assets: publicationAssets,
      execute: (command, args) => {
        commands.push([command, ...args]);
        return release === null
          ? { status: 1, stderr: 'gh: Not Found (HTTP 404)' }
          : { status: 0, stdout: JSON.stringify(release), stderr: '' };
      },
      run: async (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === 'release' && args[1] === 'create') {
          release = githubReleaseFixture({ draft: true });
        }
        if (args[0] === 'release' && args[1] === 'upload') {
          release = githubReleaseFixture({ draft: true });
        }
        if (args[0] === 'release' && args[1] === 'edit') {
          release.draft = !args.includes('--draft=false');
        }
      },
      fetchRelease: async () => structuredClone(release),
      fetchLatestRelease: async () => structuredClone(release),
      fetchRepository: async () => githubRepositoryFixture(),
      verifyDownloads: async (_release, _assets, stage) => {
        stages.push(stage);
        if (downloadFailure === stage) throw new Error(`synthetic ${stage} download mismatch`);
      },
      revalidateBinding: async (stage) => {
        bindings.push(stage);
      },
    },
  };
};

test('executable publication verifies a draft before publishing and re-verifies the public release', async () => {
  await withPublicationFixture(async (notesFile) => {
    const harness = publicationHarness({ notesFile });
    const result = await publishGithubRelease(harness.options);
    assert.equal(result.release.draft, false);
    assert.equal(result.resumed, false);
    assert.deepEqual(harness.stages, ['draft', 'public']);
    const create = harness.commands.find((command) => command[2] === 'create');
    const edit = harness.commands.find(
      (command) => command[2] === 'edit' && command.includes('--draft=false'),
    );
    assert.ok(create.includes('github.com/Nassau-1/htmllelujah'));
    assert.ok(edit);
    assert.ok(
      harness.commands[0].includes('--hostname') && harness.commands[0].includes('github.com'),
    );
    assert.ok(
      harness.bindings.indexOf('after-draft-download') <
        harness.bindings.indexOf('immediately-before-public-edit'),
    );
    assert.equal(create.at(-1), publicationAssets.at(-1).filePath);
  });
});

test('publication resumes only an exact existing draft or public release', async () => {
  await withPublicationFixture(async (notesFile) => {
    const draftHarness = publicationHarness({
      notesFile,
      initialRelease: githubReleaseFixture({ draft: true }),
    });
    const draftResult = await publishGithubRelease(draftHarness.options);
    assert.equal(draftResult.resumed, true);
    assert.equal(draftResult.release.draft, false);
    assert.deepEqual(draftHarness.stages, ['resumed-draft', 'public']);
    assert.equal(
      draftHarness.commands.some((command) => command[2] === 'create'),
      false,
    );

    const publicHarness = publicationHarness({
      notesFile,
      initialRelease: githubReleaseFixture({ draft: false }),
    });
    const publicResult = await publishGithubRelease(publicHarness.options);
    assert.equal(publicResult.resumed, true);
    assert.equal(publicResult.release.draft, false);
    assert.deepEqual(publicHarness.stages, ['resumed-public']);
    assert.equal(
      publicHarness.commands.some((command) => command[2] === 'edit' || command[2] === 'create'),
      false,
    );
  });
});

test('publication repairs only missing allowlisted assets on an exact partial draft', async () => {
  await withPublicationFixture(async (notesFile) => {
    const partialDraft = publicationHarness({
      notesFile,
      initialRelease: githubReleaseFixture({ draft: true, assets: [publicationAssets[0]] }),
    });
    const result = await publishGithubRelease(partialDraft.options);
    assert.equal(result.release.draft, false);
    const upload = partialDraft.commands.find((command) => command[2] === 'upload');
    assert.ok(upload);
    assert.ok(upload.includes(publicationAssets[1].filePath));
    assert.equal(upload.includes(publicationAssets[0].filePath), false);

    const partialPublic = publicationHarness({
      notesFile,
      initialRelease: githubReleaseFixture({ draft: false, assets: [publicationAssets[0]] }),
    });
    await assert.rejects(publishGithubRelease(partialPublic.options), /asset set is incomplete/iu);
    assert.equal(
      partialPublic.commands.some((command) => command[2] === 'upload'),
      false,
    );
  });
});

test('ambiguous absence, draft download failure, and moved tags fail closed before publication', async () => {
  await withPublicationFixture(async (notesFile) => {
    const ambiguous = publicationHarness({ notesFile });
    ambiguous.options.execute = () => ({ status: 1, stderr: 'proxy returned 404 while offline' });
    await assert.rejects(publishGithubRelease(ambiguous.options), /Could not prove/iu);
    assert.equal(ambiguous.release, null);

    const failedDownload = publicationHarness({ notesFile, downloadFailure: 'draft' });
    await assert.rejects(
      publishGithubRelease(failedDownload.options),
      /synthetic draft download mismatch/iu,
    );
    assert.equal(failedDownload.release.draft, true);
    assert.equal(
      failedDownload.commands.some(
        (command) => command[2] === 'edit' && command.includes('--draft=false'),
      ),
      false,
    );

    for (const failureStage of [
      'immediately-before-draft-create',
      'after-draft-create',
      'after-draft-download',
      'immediately-before-public-edit',
      'after-public-edit',
      'after-public-download',
    ]) {
      const moved = publicationHarness({ notesFile });
      moved.options.revalidateBinding = async (stage) => {
        if (stage === failureStage) throw new Error(`synthetic tag moved at ${stage}`);
      };
      await assert.rejects(publishGithubRelease(moved.options), /synthetic tag moved/iu);
      if (moved.release !== null) {
        assert.equal(moved.release.draft, failureStage.startsWith('after-public-') ? false : true);
      }
    }

    const publicNetworkFailure = publicationHarness({ notesFile, downloadFailure: 'public' });
    await assert.rejects(
      publishGithubRelease(publicNetworkFailure.options),
      /synthetic public download mismatch/iu,
    );
    assert.equal(publicNetworkFailure.release.draft, false);

    const resumedPublicNetworkFailure = publicationHarness({
      notesFile,
      initialRelease: githubReleaseFixture({ draft: false }),
      downloadFailure: 'resumed-public',
    });
    await assert.rejects(
      publishGithubRelease(resumedPublicNetworkFailure.options),
      /synthetic resumed-public download mismatch/iu,
    );
    assert.equal(resumedPublicNetworkFailure.release.draft, false);
  });
});

test('publication rerun audits command-side create and publish success after an interrupted CLI', async () => {
  await withPublicationFixture(async (notesFile) => {
    const createCrash = publicationHarness({ notesFile });
    const createRun = createCrash.options.run;
    let crashCreate = true;
    createCrash.options.run = async (command, args) => {
      await createRun(command, args);
      if (crashCreate && args[1] === 'create') {
        crashCreate = false;
        throw new Error('synthetic create client interruption');
      }
    };
    await assert.rejects(
      publishGithubRelease(createCrash.options),
      /synthetic create client interruption/iu,
    );
    assert.equal(createCrash.release.draft, true);
    createCrash.options.run = createRun;
    const resumedDraft = await publishGithubRelease(createCrash.options);
    assert.equal(resumedDraft.resumed, true);
    assert.equal(resumedDraft.release.draft, false);

    const publishCrash = publicationHarness({ notesFile });
    const publishRun = publishCrash.options.run;
    let crashPublish = true;
    publishCrash.options.run = async (command, args) => {
      await publishRun(command, args);
      if (crashPublish && args[1] === 'edit' && args.includes('--draft=false')) {
        crashPublish = false;
        throw new Error('synthetic publish client interruption');
      }
    };
    await assert.rejects(
      publishGithubRelease(publishCrash.options),
      /synthetic publish client interruption/iu,
    );
    assert.equal(publishCrash.release.draft, false);
    publishCrash.options.run = publishRun;
    const resumedPublic = await publishGithubRelease(publishCrash.options);
    assert.equal(resumedPublic.resumed, true);
    assert.equal(resumedPublic.release.draft, false);
  });
});

test('exported publication runner executes a fake gh child, verifies filesystem downloads, latest, and resume', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'htmllelujah-publication-runner-'));
  try {
    const artifactsRoot = path.join(root, 'artifacts');
    const notesFile = path.join(root, 'release-notes.md');
    const installerPath = path.join(root, 'HTMLlelujah-1.0.0.exe');
    const recordPath = path.join(root, 'HTMLlelujah-1.0.0-release-record.json');
    const statePath = path.join(root, 'fake-gh-state.json');
    const installerContent = Buffer.from('installer-content');
    const recordContent = Buffer.from('{"verified":true}\n');
    await writeFile(notesFile, publicationNotes);
    await writeFile(installerPath, installerContent);
    await writeFile(recordPath, recordContent);
    await writeFile(
      statePath,
      `${JSON.stringify({
        repository: publicationRepository,
        tag: publicationTag,
        release: null,
        latestReleaseId: null,
        nextAssetId: 100,
        calls: [],
      })}\n`,
    );
    const assets = [
      {
        role: 'windows-installer',
        name: path.basename(installerPath),
        size: installerContent.length,
        sha256: createHash('sha256').update(installerContent).digest('hex'),
        filePath: installerPath,
      },
      {
        role: 'final-release-record',
        name: path.basename(recordPath),
        size: recordContent.length,
        sha256: createHash('sha256').update(recordContent).digest('hex'),
        filePath: recordPath,
      },
    ];
    const fakeGhScript = path.join(repositoryRoot, 'scripts', 'fake-gh-release-test-child.mjs');
    const environment = {
      ...process.env,
      GH_HOST: 'evil.example',
      GH_TOKEN: 'must-not-reach-child',
      GITHUB_TOKEN: 'must-not-reach-child',
      HTMLLELUJAH_FAKE_GH_STATE: statePath,
    };
    const options = {
      mode: 'publish',
      repositoryRoot: root,
      artifactsRoot,
      repository: publicationRepository,
      tag: publicationTag,
      title: publicationTitle,
      notesFile,
      notesBody: publicationNotes,
      assets,
      environment,
      revalidateBinding: async () => {},
      ghCommand: process.execPath,
      ghArgsPrefix: [fakeGhScript],
    };
    const first = await runGithubReleasePublication(options);
    assert.equal(first.resumed, false);
    assert.equal(first.release.draft, false);
    let state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.latestReleaseId, state.release.id);
    assert.equal(
      state.calls.every((call) => call.ghHost === null),
      true,
    );
    assert.equal(
      state.calls.every((call) => call.ghTokenPresent === false),
      true,
    );
    const createCall = state.calls.find(
      (call) => call.args[0] === 'release' && call.args[1] === 'create',
    );
    assert.ok(createCall.args.includes(installerPath));
    assert.ok(createCall.args.includes(recordPath));
    assert.ok(
      state.calls.some(
        (call) =>
          call.args[0] === 'api' &&
          call.args.includes('--hostname') &&
          call.args.includes('github.com'),
      ),
    );

    const second = await runGithubReleasePublication(options);
    assert.equal(second.resumed, true);
    assert.equal(second.release.draft, false);
    state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(
      state.calls.filter((call) => call.args[0] === 'release' && call.args[1] === 'create').length,
      1,
    );
    state.latestReleaseId = null;
    const callsBeforeLatestRepair = state.calls.length;
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    await assert.rejects(runGithubReleasePublication(options), /latest release/iu);
    state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.latestReleaseId, null);
    assert.equal(
      state.calls
        .slice(callsBeforeLatestRepair)
        .some(
          (call) =>
            call.args[0] === 'release' && call.args[1] === 'edit' && call.args.includes('--latest'),
        ),
      false,
    );
    state.latestReleaseId = state.release.id;
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

    const partialStatePath = path.join(root, 'fake-gh-partial-state.json');
    await writeFile(
      partialStatePath,
      `${JSON.stringify({
        repository: publicationRepository,
        tag: publicationTag,
        release: {
          id: 42,
          title: publicationTitle,
          body: publicationNotes,
          draft: true,
          assets: [
            {
              id: 100,
              name: path.basename(installerPath),
              size: installerContent.length,
              sha256: assets[0].sha256,
              sourcePath: installerPath,
            },
          ],
        },
        latestReleaseId: null,
        nextAssetId: 101,
        calls: [],
      })}\n`,
    );
    const repaired = await runGithubReleasePublication({
      ...options,
      environment: {
        ...environment,
        HTMLLELUJAH_FAKE_GH_STATE: partialStatePath,
      },
    });
    assert.equal(repaired.release.draft, false);
    const partialState = JSON.parse(await readFile(partialStatePath, 'utf8'));
    const uploadCall = partialState.calls.find(
      (call) => call.args[0] === 'release' && call.args[1] === 'upload',
    );
    assert.ok(uploadCall);
    assert.equal(uploadCall.args.includes(installerPath), false);
    assert.equal(uploadCall.args.includes(recordPath), true);

    state.corruptDownloads = true;
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    await assert.rejects(runGithubReleasePublication(options), /asset hash mismatch/iu);
    const failedAuditState = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(failedAuditState.release.draft, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('public release notes and final JSON record are deterministic and contain exact repository identity', () => {
  assert.throws(
    () => assertPublishableReleaseNotes('# Release\n\nPENDING verification.'),
    /placeholder/iu,
  );
  const record = buildFinalReleaseRecord({
    version: '1.0.0',
    candidateManifest: {
      buildId: 'build-1',
      source: { commit: '1'.repeat(40) },
      artifact: { aggregateSha256: '2'.repeat(64) },
    },
    evidenceManifest: { release: { generatedAt: '2026-07-16T12:00:00.000Z' } },
    tag: publicationTag,
    remote: 'origin',
    binding: {
      remoteUrl: 'git@github.com:Nassau-1/htmllelujah.git',
      canonicalRepositoryUrl: 'https://github.com/Nassau-1/htmllelujah',
      localTagCommit: '1'.repeat(40),
      localTagObjectType: 'tag',
      localTagObjectId: '3'.repeat(40),
      remoteTagCommit: '1'.repeat(40),
      remoteTagObjectId: '3'.repeat(40),
    },
    repository: publicationRepository,
    title: publicationTitle,
    notes: { path: 'docs/releases/v1.0.0-public.md', size: 99, sha256: '4'.repeat(64) },
    assets: publicationAssets.map(({ filePath: _filePath, ...asset }) => asset),
    candidateManifestSha256: '5'.repeat(64),
    evidenceManifestSha256: '6'.repeat(64),
  });
  const serialized = JSON.parse(`${JSON.stringify(record)}\n`);
  assert.equal(serialized.source.repositoryUrl, 'https://github.com/Nassau-1/htmllelujah');
  assert.equal(serialized.source.remoteUrl, 'git@github.com:Nassau-1/htmllelujah.git');
  assert.equal(serialized.publication.repositoryUrl, 'https://github.com/Nassau-1/htmllelujah');
  assert.equal(serialized.publication.title, publicationTitle);
  assert.equal(serialized.publication.requestedMode, undefined);
  assert.equal(serialized.generatedAt, '2026-07-16T12:00:00.000Z');
});

test('release notes must be tracked and byte-identical to the candidate HEAD blob', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'htmllelujah-notes-provenance-'));
  try {
    const runGit = (args) => {
      const result = spawnSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        shell: false,
        timeout: 30_000,
        windowsHide: true,
      });
      if (result.status !== 0 || result.error || result.signal) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.error?.message}.`);
      }
      return String(result.stdout ?? '').trim();
    };
    runGit(['init', '--quiet']);
    runGit(['config', 'user.name', 'Release Test']);
    runGit(['config', 'user.email', 'release-test@example.invalid']);
    await writeFile(path.join(root, '.gitignore'), 'ignored-notes.md\n');
    const trackedNotes = path.join(root, 'public-notes.md');
    const ignoredNotes = path.join(root, 'ignored-notes.md');
    await writeFile(trackedNotes, publicationNotes);
    await writeFile(ignoredNotes, publicationNotes);
    runGit(['add', '.gitignore', 'public-notes.md']);
    runGit(['commit', '--quiet', '-m', 'tracked release notes']);
    assert.doesNotThrow(() =>
      assertTrackedReleaseNotes({ repositoryRoot: root, notesFile: trackedNotes, runGit }),
    );
    assert.throws(
      () => assertTrackedReleaseNotes({ repositoryRoot: root, notesFile: ignoredNotes, runGit }),
      /failed/iu,
    );
    await writeFile(trackedNotes, `${publicationNotes}\nchanged\n`);
    assert.throws(
      () => assertTrackedReleaseNotes({ repositoryRoot: root, notesFile: trackedNotes, runGit }),
      /do not exactly match/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
