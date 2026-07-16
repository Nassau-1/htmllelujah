import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { buildDirectoryInventory } from '../apps/desktop/scripts/build-provenance-support.mjs';

const RELEASE_PUBLISH_CREDENTIAL_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'BITBUCKET_TOKEN',
  'DO_KEY_ID',
  'DO_SECRET_KEY',
  'DO_SESSION_TOKEN',
  'GH_TOKEN',
  'GITHUB_RELEASE_TOKEN',
  'GITHUB_TOKEN',
  'GITLAB_PRIVATE_TOKEN',
  'GITLAB_TOKEN',
  'KEYGEN_TOKEN',
  'SNAPCRAFT_STORE_CREDENTIALS',
];

export const createReleaseEnvironment = (source = process.env) => {
  const environment = {
    ...source,
    NODE_OPTIONS: '',
    ELECTRON_RUN_AS_NODE: '',
    VITE_DEV_SERVER_URL: '',
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  };
  for (const key of RELEASE_PUBLISH_CREDENTIAL_KEYS) delete environment[key];
  return environment;
};

const exists = async (value) => {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
};

const assertContained = (root, target, label) => {
  const relation = path.relative(path.resolve(root), path.resolve(target));
  if (relation === '' || relation.startsWith('..') || path.isAbsolute(relation)) {
    throw new Error(`${label} escaped its allowed root.`);
  }
};

export const discoverWorkspacePackages = async (repositoryRoot) => {
  const packagesRoot = path.join(repositoryRoot, 'packages');
  const directories = (await readdir(packagesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  const packages = [];
  for (const directory of directories) {
    const packageRoot = path.join(packagesRoot, directory.name);
    const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    if (!packageJson.name || !packageJson.scripts?.build) {
      throw new Error(`Workspace package ${directory.name} lacks a name or build script.`);
    }
    const dependencyNames = new Set([
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.optionalDependencies ?? {}),
    ]);
    packages.push({
      name: packageJson.name,
      relativePath: `packages/${directory.name}`,
      root: packageRoot,
      dist: path.join(packageRoot, 'dist'),
      dependencyNames,
    });
  }
  const byName = new Map(packages.map((entry) => [entry.name, entry]));
  if (byName.size !== packages.length) throw new Error('Workspace package names are not unique.');
  const remaining = new Set(byName.keys());
  const ordered = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((name) =>
        [...byName.get(name).dependencyNames]
          .filter((dependency) => byName.has(dependency))
          .every((dependency) => !remaining.has(dependency)),
      )
      .sort((left, right) => left.localeCompare(right, 'en'));
    if (ready.length === 0) throw new Error('Workspace package dependency graph contains a cycle.');
    for (const name of ready) {
      remaining.delete(name);
      ordered.push(byName.get(name));
    }
  }
  return ordered;
};

export const clearWorkspacePackageOutputs = async (repositoryRoot, packages) => {
  for (const entry of packages) {
    assertContained(path.join(repositoryRoot, 'packages'), entry.dist, 'Workspace dist path');
    await rm(entry.dist, { recursive: true, force: true });
  }
};

const oldestFileMtime = async (root) => {
  let oldest = Number.POSITIVE_INFINITY;
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Symlink found in workspace output: ${fullPath}.`);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) oldest = Math.min(oldest, (await stat(fullPath)).mtimeMs);
    }
  };
  await visit(root);
  return oldest;
};

export const attestWorkspacePackageOutputs = async (packages, buildTimes) => {
  const attestations = [];
  for (const entry of packages) {
    const startedAtMs = buildTimes.get(entry.name);
    if (!Number.isFinite(startedAtMs)) {
      throw new Error(`No sequential rebuild timestamp was recorded for ${entry.name}.`);
    }
    const inventory = await buildDirectoryInventory(entry.dist);
    if (inventory.fileCount < 1)
      throw new Error(`Workspace package ${entry.name} emitted no files.`);
    const oldestMtime = await oldestFileMtime(entry.dist);
    if (oldestMtime + 2_000 < startedAtMs) {
      throw new Error(`Workspace package ${entry.name} contains stale pre-build output.`);
    }
    attestations.push({
      name: entry.name,
      path: entry.relativePath,
      buildOrder: attestations.length + 1,
      dist: inventory,
    });
  }
  return { schemaVersion: 1, packages: attestations };
};

export const assertWorkspacePackageOutputsStable = async (packages, buildTimes, expected) => {
  const current = await attestWorkspacePackageOutputs(packages, buildTimes);
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new Error('A rebuilt workspace package changed after its attestation.');
  }
  return current;
};

export const buildCommandPlan = ({ packageNames, paths, offline = true }) => [
  {
    name: 'capture-pre-build-provenance',
    command: process.execPath,
    args: [
      'apps/desktop/scripts/write-build-provenance.mjs',
      '--prepare',
      '--session',
      paths.session,
      '--build-id',
      paths.buildId,
      '--require-clean',
    ],
  },
  {
    name: 'install-exact-lockfile',
    command: 'corepack',
    args: ['pnpm', 'install', '--frozen-lockfile', ...(offline ? ['--offline'] : [])],
  },
  ...packageNames.map((name) => ({
    name: `build-workspace-package:${name}`,
    command: 'corepack',
    args: ['pnpm', '--filter', name, 'run', 'build'],
  })),
  {
    name: 'build-desktop-vite',
    command: 'corepack',
    args: ['pnpm', '--filter', '@htmllelujah/desktop', 'exec', 'vite', 'build'],
  },
  {
    name: 'embed-post-build-provenance',
    command: process.execPath,
    args: [
      'apps/desktop/scripts/write-build-provenance.mjs',
      '--embed',
      '--session',
      paths.session,
      '--workspace-build',
      paths.workspaceBuild,
      '--require-clean',
    ],
  },
  {
    name: 'package-windows-staging',
    command: 'corepack',
    args: [
      'pnpm',
      '--filter',
      '@htmllelujah/desktop',
      'exec',
      'electron-builder',
      '--win',
      'nsis',
      '--x64',
      '--publish',
      'never',
      `--config.directories.output=${paths.artifactStaging}`,
    ],
  },
  {
    name: 'verify-post-package-provenance',
    command: process.execPath,
    args: [
      'apps/desktop/scripts/write-build-provenance.mjs',
      '--verify',
      '--session',
      paths.session,
      '--require-clean',
    ],
  },
  {
    name: 'write-candidate-manifest',
    command: process.execPath,
    args: [
      'apps/desktop/scripts/write-release-manifest.mjs',
      '--artifact-dir',
      paths.artifactStaging,
      '--output',
      paths.candidateManifest,
      '--session',
      paths.session,
    ],
  },
  {
    name: 'generate-release-evidence',
    command: process.execPath,
    args: [
      'scripts/generate-release-evidence.mjs',
      '--artifact-dir',
      paths.artifactStaging,
      '--output-dir',
      paths.evidenceStaging,
      '--candidate-manifest',
      paths.candidateManifest,
      '--require-candidate-manifest',
      '--require-fresh',
    ],
  },
  {
    name: 'verify-release-evidence',
    command: process.execPath,
    args: [
      'scripts/verify-release-evidence.mjs',
      '--artifact-dir',
      paths.artifactStaging,
      '--evidence-dir',
      paths.evidenceStaging,
      '--require-ready',
    ],
  },
];

export const runSequentialPlan = async (steps, run, promote) => {
  for (const step of steps) await run(step);
  await promote();
};

export const promoteDirectoriesAtomically = async ({ promotions, transactionRoot, fsOps = {} }) => {
  const operations = {
    exists,
    mkdir,
    rename,
    rm,
    ...fsOps,
  };
  await operations.mkdir(transactionRoot, { recursive: true });
  const transactionId = randomUUID();
  const records = promotions.map((promotion, index) => ({
    ...promotion,
    source: path.resolve(promotion.source),
    destination: path.resolve(promotion.destination),
    backup: path.join(transactionRoot, `${transactionId}-${index}.backup`),
    hadDestination: false,
    promoted: false,
  }));
  for (const record of records) {
    if (!(await operations.exists(record.source))) {
      throw new Error(`Promotion source does not exist: ${record.source}.`);
    }
    if (record.source === record.destination)
      throw new Error('Promotion source equals destination.');
  }
  try {
    for (const record of records) {
      await operations.mkdir(path.dirname(record.destination), { recursive: true });
      record.hadDestination = await operations.exists(record.destination);
      if (record.hadDestination) await operations.rename(record.destination, record.backup);
      await operations.rename(record.source, record.destination);
      record.promoted = true;
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const record of [...records].reverse()) {
      try {
        if (record.promoted && (await operations.exists(record.destination))) {
          await operations.rename(record.destination, record.source);
        }
        if (record.hadDestination && (await operations.exists(record.backup))) {
          await operations.rename(record.backup, record.destination);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Release promotion failed and rollback was incomplete.',
      );
    }
    throw error;
  }
  for (const record of records) {
    if (record.hadDestination) {
      try {
        await operations.rm(record.backup, { recursive: true, force: true });
      } catch {
        // Promotion is committed; the transaction root is only best-effort cleanup now.
      }
    }
  }
};
