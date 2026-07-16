import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { hostname } from 'node:os';

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
  'GH_ENTERPRISE_TOKEN',
  'GH_HOST',
  'GITHUB_RELEASE_TOKEN',
  'GITHUB_TOKEN',
  'GITLAB_PRIVATE_TOKEN',
  'GITLAB_TOKEN',
  'KEYGEN_TOKEN',
  'SNAPCRAFT_STORE_CREDENTIALS',
];

const RELEASE_ENVIRONMENT_KEYS_TO_REMOVE = [
  ...RELEASE_PUBLISH_CREDENTIAL_KEYS,
  'CSC_IDENTITY_AUTO_DISCOVERY',
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'VITE_DEV_SERVER_URL',
];

export const RELEASE_PROMOTION_PREFIX = '.htmllelujah-release-promotion-';
export const RELEASE_PREPARATION_PREFIX = '.htmllelujah-release-preparation-';
export const RELEASE_WORKTREE_PREFIX = '.hlw-';
export const WINDOWS_RELEASE_WORKTREE_ROOT_MAX_LENGTH = 80;
const RELEASE_CLEANUP_PREFIX = '.htmllelujah-release-cleanup-';
const RELEASE_LOCK_NAME = '.htmllelujah-release-lock';
const RELEASE_LOCK_PREPARATION_PREFIX = '.htmllelujah-release-lock-preparation-';
const RELEASE_LOCK_CLEANUP_PREFIX = '.htmllelujah-release-lock-cleanup-';
const RELEASE_PROMOTION_SCHEMA_VERSION = 1;
const RELEASE_LOCK_SCHEMA_VERSION = 1;
const RELEASE_PROMOTION_JOURNAL = 'transaction.json';
const RELEASE_PROMOTION_COMMIT = 'committed.json';
const RELEASE_LOCK_OWNER = 'owner.json';
const CURRENT_PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1_000).toISOString();

const jsonDocument = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256Text = (value) => createHash('sha256').update(value).digest('hex');
const pathKey = (value, platform = process.platform) => {
  const resolved = path.resolve(value);
  return platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
};

export const releaseWorktreeName = (buildId) => {
  if (typeof buildId !== 'string') throw new Error('Release worktree build ID is invalid.');
  const compactId = buildId.replaceAll('-', '').toLowerCase();
  if (!/^[0-9a-f]{32}$/u.test(compactId)) {
    throw new Error('Release worktree build ID is invalid.');
  }
  return `${RELEASE_WORKTREE_PREFIX}${compactId}`;
};

export const isReleaseWorktreeName = (value) =>
  typeof value === 'string' &&
  value.startsWith(RELEASE_WORKTREE_PREFIX) &&
  /^[0-9a-f]{32}$/u.test(value.slice(RELEASE_WORKTREE_PREFIX.length));

export const createReleaseEnvironment = (source = process.env) => {
  const environment = { ...source };
  const keysToRemove = new Set(RELEASE_ENVIRONMENT_KEYS_TO_REMOVE);
  for (const key of Object.keys(environment)) {
    const normalizedKey = key.toUpperCase();
    if (keysToRemove.has(normalizedKey) || normalizedKey.startsWith('GIT_')) {
      delete environment[key];
    }
  }
  environment.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  environment.GIT_NO_REPLACE_OBJECTS = '1';
  environment.GIT_TERMINAL_PROMPT = '0';
  return environment;
};

export const resolveCorepackInvocation = ({
  executable = process.execPath,
  environment = process.env,
  platform = process.platform,
  pathExists = existsSync,
} = {}) => {
  if (platform !== 'win32') {
    return { command: 'corepack', argsPrefix: [] };
  }

  const platformPath = path.win32;
  const pathValue = environment.Path ?? environment.PATH ?? '';
  const candidateDirectories = [
    platformPath.dirname(executable),
    ...String(pathValue)
      .split(platformPath.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean),
  ];
  const seen = new Set();
  for (const directory of candidateDirectories) {
    const normalized = platformPath.resolve(directory).toLocaleLowerCase('en-US');
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const entry = platformPath.join(directory, 'node_modules', 'corepack', 'dist', 'corepack.js');
    if (pathExists(entry)) {
      return { command: executable, argsPrefix: [platformPath.resolve(entry)] };
    }
  }
  throw new Error(
    'Corepack could not be resolved to a JavaScript entry point; refusing to execute a Windows .cmd shim with shell disabled.',
  );
};

const exists = async (value) => {
  try {
    await access(value);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
};

const lstatExists = async (value, operations) => {
  try {
    await operations.lstat(value);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
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

// Two directories cannot be renamed as one filesystem primitive. The immutable,
// flushed journal therefore makes "prepared" mean rollback and the separately
// flushed commit marker mean retain-after-revalidation. Recovery infers progress
// from directory identities, so no mutable phase counter can get ahead of a rename.
const normalizeIdentity = (inventory) => ({
  fileCount: inventory.fileCount,
  totalSize: inventory.totalSize,
  aggregateSha256: inventory.aggregateSha256,
});

const sameIdentity = (left, right) =>
  left !== null &&
  right !== null &&
  left.fileCount === right.fileCount &&
  left.totalSize === right.totalSize &&
  left.aggregateSha256 === right.aggregateSha256;

const isDirectoryIdentity = (value, { requireFiles = false } = {}) =>
  Number.isSafeInteger(value?.fileCount) &&
  value.fileCount >= (requireFiles ? 1 : 0) &&
  Number.isSafeInteger(value?.totalSize) &&
  value.totalSize >= 0 &&
  /^[0-9a-f]{64}$/u.test(value?.aggregateSha256 ?? '');

const optionalDirectoryIdentity = async (directory, operations) => {
  let metadata;
  try {
    metadata = await operations.lstat(directory);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Release identity root is not a plain directory: ${directory}.`);
  }
  await assertPlainDirectoryPath(directory, operations);
  const identity = normalizeIdentity(await operations.inventory(directory));
  await assertPlainDirectoryPath(directory, operations);
  return identity;
};

const renameWithRetry = async (source, destination, operations) => {
  const delays = [0, 25, 50, 100, 200, 400, 800];
  let lastError;
  for (const delay of delays) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await operations.rename(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!['EACCES', 'EBUSY', 'EPERM'].includes(error?.code)) throw error;
    }
  }
  throw lastError;
};

const syncDirectoryMetadata = async (directory, operations) => {
  const resolved = path.resolve(directory);
  if (typeof operations.syncDirectoryMetadata === 'function') {
    await operations.syncDirectoryMetadata(resolved);
    return;
  }
  let handle;
  try {
    // On Windows, opening the directory read/write is required for FlushFileBuffers.
    // A read-only directory handle opens successfully but fsync fails with EPERM.
    handle = await operations.open(resolved, operations.platform === 'win32' ? 'r+' : 'r');
    await handle.sync();
  } finally {
    await handle?.close();
  }
};

const renameDurably = async (source, destination, operations) => {
  await renameWithRetry(source, destination, operations);
  const parents = new Map(
    [path.dirname(source), path.dirname(destination)].map((entry) => [
      pathKey(entry, operations.platform),
      entry,
    ]),
  );
  for (const parent of parents.values()) await syncDirectoryMetadata(parent, operations);
};

const removeDirectoryDurably = async (directory, operations) => {
  await operations.rm(directory, { recursive: true, force: true });
  await syncDirectoryMetadata(path.dirname(directory), operations);
};

const mkdirDurably = async (directory, operations) => {
  const resolved = path.resolve(directory);
  const missing = [];
  let current = resolved;
  while (!(await operations.exists(current))) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Cannot find an existing parent for ${resolved}.`);
    current = parent;
  }
  await operations.mkdir(resolved, { recursive: true });
  await syncDirectoryMetadata(current, operations);
  for (const created of missing.reverse()) {
    await syncDirectoryMetadata(created, operations);
    await syncDirectoryMetadata(path.dirname(created), operations);
  }
};

const atomicWriteJsonDurably = async (filePath, value, operations) => {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await operations.open(temporaryPath, 'wx');
    await handle.writeFile(jsonDocument(value), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameDurably(temporaryPath, filePath, operations);
    handle = await operations.open(filePath, 'r+');
    await handle.sync();
  } finally {
    await handle?.close();
    await operations.rm(temporaryPath, { force: true });
  }
};

const pathsOverlap = (left, right) => {
  const relation = path.relative(left, right);
  return relation === '' || (!relation.startsWith('..') && !path.isAbsolute(relation));
};

const assertTransactionRootDisjoint = (transactionRoot, records) => {
  for (const record of records) {
    for (const candidate of [record.source, record.destination]) {
      if (pathsOverlap(transactionRoot, candidate) || pathsOverlap(candidate, transactionRoot)) {
        throw new Error('Release promotion transaction root overlaps a promoted directory.');
      }
    }
  }
};

const assertDistinctPromotionPaths = (records) => {
  const allDestinations = new Set();
  const allSources = new Set();
  for (const record of records) {
    const sourceKey = pathKey(record.source);
    const destinationKey = pathKey(record.destination);
    if (sourceKey === destinationKey) {
      throw new Error('Promotion source equals destination.');
    }
    if (allSources.has(sourceKey) || allDestinations.has(destinationKey)) {
      throw new Error('Release promotion contains duplicate source or destination paths.');
    }
    allSources.add(sourceKey);
    allDestinations.add(destinationKey);
  }
  for (const sourceKey of allSources) {
    if (allDestinations.has(sourceKey)) {
      throw new Error('Release promotion source and destination graphs must be disjoint.');
    }
  }
  for (const record of records) {
    for (const other of records) {
      if (record === other) continue;
      for (const [parent, child] of [
        [record.source, other.source],
        [record.destination, other.destination],
        [record.source, other.destination],
        [record.destination, other.source],
      ]) {
        const relation = path.relative(parent, child);
        if (relation !== '' && !relation.startsWith('..') && !path.isAbsolute(relation)) {
          throw new Error('Release promotion paths must not contain one another.');
        }
      }
    }
  }
};

const readPlainJsonDocument = async (filePath, operations, label) => {
  const metadata = await operations.lstat(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular non-link file.`);
  }
  const text = await operations.readFile(filePath, 'utf8');
  return { value: JSON.parse(text), text };
};

const validateJournal = async ({
  journal,
  transactionRoot,
  operations,
  allowedDestinations = null,
  allowedSourceParent = null,
  allowedSourceLayouts = null,
}) => {
  if (
    journal?.schemaVersion !== RELEASE_PROMOTION_SCHEMA_VERSION ||
    !/^[0-9a-f-]{36}$/u.test(journal?.transactionId ?? '') ||
    journal?.state !== 'prepared' ||
    !Array.isArray(journal?.records) ||
    journal.records.length === 0
  ) {
    throw new Error('Release promotion journal is missing or invalid.');
  }
  const destinationSet = allowedDestinations
    ? new Set(allowedDestinations.map((entry) => pathKey(entry, operations.platform)))
    : null;
  const sourceLayoutByDestination = allowedSourceLayouts
    ? new Map(
        allowedSourceLayouts.map((entry) => [
          pathKey(entry.destination, operations.platform),
          entry.relativeSource.split('/').join(path.sep),
        ]),
      )
    : null;
  await assertPlainDirectoryPath(transactionRoot, operations);
  for (const [index, record] of journal.records.entries()) {
    const expectedBackup = path.join(transactionRoot, `${journal.transactionId}-${index}.backup`);
    if (
      record.source !== path.resolve(record.source ?? '') ||
      record.destination !== path.resolve(record.destination ?? '') ||
      record.backup !== expectedBackup ||
      !isDirectoryIdentity(record.sourceIdentity, { requireFiles: true }) ||
      (record.destinationIdentity !== null && !isDirectoryIdentity(record.destinationIdentity))
    ) {
      throw new Error('Release promotion journal contains an invalid record.');
    }
    if (destinationSet && !destinationSet.has(pathKey(record.destination, operations.platform))) {
      throw new Error('Release promotion journal targets an unexpected destination.');
    }
    const canonicalSource = await assertPlainDirectoryPath(record.source, operations, {
      allowMissing: true,
    });
    await assertPlainDirectoryPath(record.destination, operations, { allowMissing: true });
    await assertPlainDirectoryPath(record.backup, operations, { allowMissing: true });
    if (allowedSourceParent) {
      const sourceParent = path.resolve(allowedSourceParent);
      const relation = path.relative(sourceParent, record.source);
      const firstSegment = relation.split(path.sep)[0];
      if (
        relation === '' ||
        relation.startsWith('..') ||
        path.isAbsolute(relation) ||
        !isReleaseWorktreeName(firstSegment)
      ) {
        throw new Error('Release promotion journal references an unsafe staging worktree.');
      }
      if (sourceLayoutByDestination) {
        const expectedRelativeSource = sourceLayoutByDestination.get(
          pathKey(record.destination, operations.platform),
        );
        const expectedSource = expectedRelativeSource
          ? path.join(sourceParent, firstSegment, expectedRelativeSource)
          : null;
        if (
          expectedSource === null ||
          pathKey(expectedSource, operations.platform) !==
            pathKey(record.source, operations.platform)
        ) {
          throw new Error('Release promotion journal references an unexpected staging layout.');
        }
      }
      const worktreeRoot = path.join(sourceParent, firstSegment);
      if (canonicalSource !== null) {
        const canonicalWorktree = await assertPlainDirectoryPath(worktreeRoot, operations);
        const canonicalRelation = path.relative(canonicalWorktree, canonicalSource);
        if (
          canonicalRelation === '' ||
          canonicalRelation.startsWith('..') ||
          path.isAbsolute(canonicalRelation)
        ) {
          throw new Error('Release staging source escaped its canonical worktree root.');
        }
      }
    }
  }
  assertDistinctPromotionPaths(journal.records);
  assertTransactionRootDisjoint(transactionRoot, journal.records);
  return journal;
};

const readPromotionJournal = async ({
  transactionRoot,
  operations,
  allowedDestinations,
  allowedSourceParent,
  allowedSourceLayouts,
}) => {
  const journalPath = path.join(transactionRoot, RELEASE_PROMOTION_JOURNAL);
  let journal;
  let journalSha256;
  try {
    const document = await readPlainJsonDocument(
      journalPath,
      operations,
      'Release promotion journal',
    );
    journal = document.value;
    journalSha256 = sha256Text(document.text);
  } catch (error) {
    throw new Error(
      `Release promotion is incomplete but its durable journal cannot be read: ${transactionRoot}.`,
      { cause: error },
    );
  }
  await validateJournal({
    journal,
    transactionRoot,
    operations,
    allowedDestinations,
    allowedSourceParent,
    allowedSourceLayouts,
  });
  const commitPath = path.join(transactionRoot, RELEASE_PROMOTION_COMMIT);
  let committed = false;
  let commitMetadata = null;
  try {
    commitMetadata = await operations.lstat(commitPath);
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
  }
  if (commitMetadata !== null) {
    let marker;
    try {
      marker = (
        await readPlainJsonDocument(commitPath, operations, 'Release promotion commit marker')
      ).value;
    } catch (error) {
      throw new Error('Release promotion commit marker cannot be read.', { cause: error });
    }
    if (
      marker?.schemaVersion !== RELEASE_PROMOTION_SCHEMA_VERSION ||
      marker?.transactionId !== journal.transactionId ||
      marker?.state !== 'committed' ||
      marker?.journalSha256 !== journalSha256 ||
      typeof marker?.committedAt !== 'string'
    ) {
      throw new Error('Release promotion commit marker is invalid.');
    }
    committed = true;
  }
  return { journal, committed };
};

const assertCommittedDestinations = async (journal, operations) => {
  for (const record of journal.records) {
    const sourceIdentity = await optionalDirectoryIdentity(record.source, operations);
    const destinationIdentity = await optionalDirectoryIdentity(record.destination, operations);
    const backupIdentity = await optionalDirectoryIdentity(record.backup, operations);
    if (sourceIdentity !== null || !sameIdentity(destinationIdentity, record.sourceIdentity)) {
      throw new Error('Committed release promotion destination identity is inconsistent.');
    }
    if (
      backupIdentity !== null &&
      (record.destinationIdentity === null ||
        !sameIdentity(backupIdentity, record.destinationIdentity))
    ) {
      throw new Error('Committed release promotion backup identity is inconsistent.');
    }
  }
};

const rollbackPreparedPromotion = async (journal, operations) => {
  for (const record of [...journal.records].reverse()) {
    const sourceIdentity = await optionalDirectoryIdentity(record.source, operations);
    const destinationIdentity = await optionalDirectoryIdentity(record.destination, operations);
    const backupIdentity = await optionalDirectoryIdentity(record.backup, operations);
    if (sourceIdentity !== null && !sameIdentity(sourceIdentity, record.sourceIdentity)) {
      throw new Error('Release recovery found unexpected content at the staging source.');
    }
    if (
      destinationIdentity !== null &&
      !sameIdentity(destinationIdentity, record.sourceIdentity) &&
      !sameIdentity(destinationIdentity, record.destinationIdentity)
    ) {
      throw new Error('Release recovery found unexpected content at the final destination.');
    }
    if (backupIdentity !== null && !sameIdentity(backupIdentity, record.destinationIdentity)) {
      throw new Error('Release recovery found unexpected content in the durable backup.');
    }

    if (sourceIdentity !== null) {
      if (destinationIdentity !== null) {
        if (
          record.destinationIdentity === null ||
          !sameIdentity(destinationIdentity, record.destinationIdentity) ||
          backupIdentity !== null
        ) {
          throw new Error('Release recovery found ambiguous duplicate generations.');
        }
      } else if (record.destinationIdentity !== null) {
        if (!sameIdentity(backupIdentity, record.destinationIdentity)) {
          throw new Error('Release recovery cannot locate the prior destination generation.');
        }
        await mkdirDurably(path.dirname(record.destination), operations);
        await renameDurably(record.backup, record.destination, operations);
      } else if (backupIdentity !== null) {
        throw new Error('Release recovery found a backup for an originally absent destination.');
      }
    } else {
      if (!sameIdentity(destinationIdentity, record.sourceIdentity)) {
        throw new Error('Release recovery cannot locate the candidate generation.');
      }
      await mkdirDurably(path.dirname(record.source), operations);
      await renameDurably(record.destination, record.source, operations);
      if (record.destinationIdentity === null) {
        if (backupIdentity !== null) {
          throw new Error('Release recovery found an impossible prior backup.');
        }
      } else {
        if (!sameIdentity(backupIdentity, record.destinationIdentity)) {
          throw new Error('Release recovery cannot locate the prior destination generation.');
        }
        await mkdirDurably(path.dirname(record.destination), operations);
        await renameDurably(record.backup, record.destination, operations);
      }
    }
  }

  for (const record of journal.records) {
    const sourceIdentity = await optionalDirectoryIdentity(record.source, operations);
    const destinationIdentity = await optionalDirectoryIdentity(record.destination, operations);
    const backupIdentity = await optionalDirectoryIdentity(record.backup, operations);
    if (!sameIdentity(sourceIdentity, record.sourceIdentity) || backupIdentity !== null) {
      throw new Error('Release promotion rollback did not restore the staging generation.');
    }
    if (
      (record.destinationIdentity === null && destinationIdentity !== null) ||
      (record.destinationIdentity !== null &&
        !sameIdentity(destinationIdentity, record.destinationIdentity))
    ) {
      throw new Error('Release promotion rollback did not restore the prior final generation.');
    }
  }
};

const assertPlainDirectoryPath = async (directory, operations, { allowMissing = false } = {}) => {
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let metadata;
    try {
      metadata = await operations.lstat(current);
    } catch (error) {
      if (allowMissing && error?.code === 'ENOENT' && index < segments.length) {
        return null;
      }
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`Release path contains a symbolic link or junction: ${current}.`);
    }
    if (!metadata.isDirectory()) {
      throw new Error(`Release directory path contains a non-directory component: ${current}.`);
    }
  }
  return operations.realpath(resolved);
};

const defaultOperations = (fsOps = {}) => ({
  exists,
  inventory: buildDirectoryInventory,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  platform: process.platform,
  ...fsOps,
});

export const assertSafeReleaseDirectoryPath = async ({
  directory,
  allowMissing = false,
  fsOps = {},
}) => assertPlainDirectoryPath(directory, defaultOperations(fsOps), { allowMissing });

const processIsAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
};

const processIdentity = (pid) => {
  if (!processIsAlive(pid)) return { alive: false, processStartedAt: null };
  if (process.platform !== 'win32' && pid === process.pid) {
    return { alive: true, processStartedAt: CURRENT_PROCESS_STARTED_AT };
  }
  if (process.platform !== 'win32') {
    return { alive: true, processStartedAt: null };
  }
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()`,
    ],
    {
      encoding: 'utf8',
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      windowsHide: true,
    },
  );
  if (result.status !== 0 || result.error || result.signal) {
    return { alive: processIsAlive(pid), processStartedAt: null };
  }
  const processStartedAt = String(result.stdout ?? '').trim();
  return {
    alive: true,
    processStartedAt: processStartedAt.length > 0 ? processStartedAt : null,
  };
};

const readReleaseLockOwner = async (lockRoot, operations) => {
  let owner;
  try {
    owner = (
      await readPlainJsonDocument(
        path.join(lockRoot, RELEASE_LOCK_OWNER),
        operations,
        'Release lock owner record',
      )
    ).value;
  } catch (error) {
    throw new Error(`Release lock owner record is unreadable: ${lockRoot}.`, { cause: error });
  }
  if (
    owner?.schemaVersion !== RELEASE_LOCK_SCHEMA_VERSION ||
    !Number.isSafeInteger(owner?.pid) ||
    owner.pid < 1 ||
    !/^[0-9a-f-]{36}$/u.test(owner?.nonce ?? '') ||
    typeof owner?.purpose !== 'string' ||
    owner.purpose.length < 1 ||
    typeof owner?.host !== 'string' ||
    owner.host.length < 1 ||
    typeof owner?.processStartedAt !== 'string' ||
    typeof owner?.createdAt !== 'string'
  ) {
    throw new Error('Release lock owner record is invalid.');
  }
  return owner;
};

const assertReleaseLockCoversParent = (releaseLock, transactionParent) => {
  if (pathKey(releaseLock?.transactionParent ?? '') !== pathKey(transactionParent ?? '')) {
    throw new Error('Shared release lock does not cover the requested transaction parent.');
  }
};

const assertTransactionRootForLock = (releaseLock, transactionRoot) => {
  const resolvedRoot = path.resolve(transactionRoot);
  assertReleaseLockCoversParent(releaseLock, path.dirname(resolvedRoot));
  if (!path.basename(resolvedRoot).startsWith(RELEASE_PROMOTION_PREFIX)) {
    throw new Error('Release promotion transaction root has an unexpected name.');
  }
};

const cleanupAuxiliaryReleaseRoots = async (transactionParent, operations) => {
  const cleanupPrefixes = [
    RELEASE_PREPARATION_PREFIX,
    RELEASE_CLEANUP_PREFIX,
    RELEASE_LOCK_PREPARATION_PREFIX,
    RELEASE_LOCK_CLEANUP_PREFIX,
  ];
  for (const entry of await operations.readdir(transactionParent, { withFileTypes: true })) {
    if (!cleanupPrefixes.some((prefix) => entry.name.startsWith(prefix))) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Unsafe release cleanup marker: ${entry.name}.`);
    }
    await removeDirectoryDurably(path.join(transactionParent, entry.name), operations);
  }
};

export const assertReleaseLockHeld = async ({ releaseLock, fsOps = {} }) => {
  if (!releaseLock?.root || !releaseLock?.nonce || !releaseLock?.transactionParent) {
    throw new Error('A valid shared release lock is required.');
  }
  const operations = defaultOperations(fsOps);
  const expectedRoot = path.join(path.resolve(releaseLock.transactionParent), RELEASE_LOCK_NAME);
  if (
    pathKey(releaseLock.root, operations.platform) !== pathKey(expectedRoot, operations.platform)
  ) {
    throw new Error('Release lock path is inconsistent.');
  }
  const owner = await readReleaseLockOwner(expectedRoot, operations);
  if (
    owner.nonce !== releaseLock.nonce ||
    owner.pid !== releaseLock.pid ||
    owner.host !== hostname() ||
    owner.processStartedAt !== releaseLock.processStartedAt
  ) {
    throw new Error('Shared release lock ownership changed.');
  }
  return owner;
};

export const acquireReleaseLock = async ({ transactionParent, purpose, fsOps = {} }) => {
  const operations = defaultOperations(fsOps);
  const resolvedParent = path.resolve(transactionParent);
  await assertPlainDirectoryPath(resolvedParent, operations);
  const lockRoot = path.join(resolvedParent, RELEASE_LOCK_NAME);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const nonce = randomUUID();
    const preparationRoot = path.join(
      resolvedParent,
      `${RELEASE_LOCK_PREPARATION_PREFIX}${process.pid}-${nonce}`,
    );
    await operations.mkdir(preparationRoot, { recursive: false });
    await syncDirectoryMetadata(resolvedParent, operations);
    const currentIdentity = fsOps.currentProcessIdentity
      ? await fsOps.currentProcessIdentity(process.pid)
      : processIdentity(process.pid);
    if (!currentIdentity.alive || currentIdentity.processStartedAt === null) {
      throw new Error(
        'Could not establish the exact current process identity for the release lock.',
      );
    }
    const processStartedAt = currentIdentity.processStartedAt;
    const owner = {
      schemaVersion: RELEASE_LOCK_SCHEMA_VERSION,
      pid: process.pid,
      nonce,
      purpose,
      host: hostname(),
      processStartedAt,
      createdAt: new Date().toISOString(),
    };
    await atomicWriteJsonDurably(path.join(preparationRoot, RELEASE_LOCK_OWNER), owner, operations);
    try {
      await renameDurably(preparationRoot, lockRoot, operations);
      const releaseLock = {
        root: lockRoot,
        transactionParent: resolvedParent,
        pid: process.pid,
        nonce,
        processStartedAt,
      };
      await assertReleaseLockHeld({ releaseLock, fsOps });
      try {
        await cleanupAuxiliaryReleaseRoots(resolvedParent, operations);
      } catch (error) {
        await releaseReleaseLock({ releaseLock, fsOps }).catch(() => {});
        throw error;
      }
      return releaseLock;
    } catch (error) {
      await removeDirectoryDurably(preparationRoot, operations);
      if (!(await operations.exists(lockRoot))) throw error;
      const currentOwner = await readReleaseLockOwner(lockRoot, operations);
      if (currentOwner.host !== hostname()) {
        throw new Error(
          `Release lock belongs to another host (${currentOwner.host}); automatic recovery is blocked.`,
          { cause: error },
        );
      }
      const identity = fsOps.processIdentity
        ? await fsOps.processIdentity(currentOwner.pid)
        : fsOps.processIsAlive
          ? {
              alive: fsOps.processIsAlive(currentOwner.pid),
              processStartedAt: null,
            }
          : processIdentity(currentOwner.pid);
      if (
        identity.alive &&
        (identity.processStartedAt === null ||
          identity.processStartedAt === currentOwner.processStartedAt)
      ) {
        throw new Error(
          `Release operation is already active (pid ${currentOwner.pid}, ${currentOwner.purpose}).`,
          { cause: error },
        );
      }
      const staleRoot = path.join(
        resolvedParent,
        `${RELEASE_LOCK_CLEANUP_PREFIX}${currentOwner.nonce}`,
      );
      await renameDurably(lockRoot, staleRoot, operations);
      await removeDirectoryDurably(staleRoot, operations);
    }
  }
  throw new Error('Could not acquire the shared release lock after stale-lock recovery.');
};

export const releaseReleaseLock = async ({ releaseLock, fsOps = {} }) => {
  const operations = defaultOperations(fsOps);
  await assertReleaseLockHeld({ releaseLock, fsOps });
  const cleanupRoot = path.join(
    releaseLock.transactionParent,
    `${RELEASE_LOCK_CLEANUP_PREFIX}${releaseLock.nonce}`,
  );
  await renameDurably(releaseLock.root, cleanupRoot, operations);
  await removeDirectoryDurably(cleanupRoot, operations);
};

const archiveReleaseTransactionForCleanup = async (
  transactionRoot,
  journal,
  operations,
  checkpoint = async () => {},
) => {
  const cleanupRoot = path.join(
    path.dirname(transactionRoot),
    `${RELEASE_CLEANUP_PREFIX}${journal.transactionId}-${randomUUID()}`,
  );
  await renameDurably(transactionRoot, cleanupRoot, operations);
  await checkpoint('tombstone-durable', journal);
  await removeDirectoryDurably(cleanupRoot, operations);
  await checkpoint('tombstone-removed', journal);
};

export const recoverReleasePromotion = async ({
  transactionRoot,
  releaseLock,
  allowedDestinations = null,
  allowedSourceParent = null,
  allowedSourceLayouts = null,
  validateCommitted = async () => {},
  checkpoint = async () => {},
  fsOps = {},
}) => {
  const resolvedRoot = path.resolve(transactionRoot);
  const operations = defaultOperations(fsOps);
  assertTransactionRootForLock(releaseLock, resolvedRoot);
  await assertPlainDirectoryPath(path.dirname(resolvedRoot), operations);
  await assertReleaseLockHeld({ releaseLock, fsOps });
  const { journal, committed } = await readPromotionJournal({
    transactionRoot: resolvedRoot,
    operations,
    allowedDestinations,
    allowedSourceParent,
    allowedSourceLayouts,
  });
  if (committed) {
    await assertCommittedDestinations(journal, operations);
    await validateCommitted(journal);
    await assertCommittedDestinations(journal, operations);
  } else {
    await rollbackPreparedPromotion(journal, operations);
  }
  await archiveReleaseTransactionForCleanup(resolvedRoot, journal, operations, checkpoint);
  return { journal, disposition: committed ? 'committed' : 'rolled-back' };
};

const pendingPromotionRoots = async (transactionParent, operations) => {
  if (!(await operations.exists(transactionParent))) return [];
  const roots = [];
  for (const entry of await operations.readdir(transactionParent, { withFileTypes: true })) {
    if (
      !entry.name.startsWith(RELEASE_PROMOTION_PREFIX) &&
      !entry.name.startsWith(RELEASE_PREPARATION_PREFIX)
    )
      continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Unsafe release promotion marker: ${entry.name}.`);
    }
    roots.push(path.join(transactionParent, entry.name));
  }
  return roots.sort((left, right) => left.localeCompare(right, 'en'));
};

export const assertNoPendingReleasePromotions = async ({
  transactionParent,
  releaseLock,
  fsOps = {},
}) => {
  const operations = defaultOperations(fsOps);
  assertReleaseLockCoversParent(releaseLock, transactionParent);
  await assertReleaseLockHeld({ releaseLock, fsOps });
  const roots = await pendingPromotionRoots(path.resolve(transactionParent), operations);
  if (roots.length > 0) {
    throw new Error(
      `Release publication is blocked by incomplete promotion state: ${roots
        .map((entry) => path.basename(entry))
        .join(', ')}.`,
    );
  }
};

export const recoverPendingReleasePromotions = async ({
  transactionParent,
  releaseLock,
  allowedDestinations,
  allowedSourceParent = transactionParent,
  allowedSourceLayouts = null,
  validateCommitted = async () => {},
  fsOps = {},
}) => {
  const operations = defaultOperations(fsOps);
  assertReleaseLockCoversParent(releaseLock, transactionParent);
  await assertReleaseLockHeld({ releaseLock, fsOps });
  await cleanupAuxiliaryReleaseRoots(path.resolve(transactionParent), operations);
  const roots = await pendingPromotionRoots(path.resolve(transactionParent), operations);
  const recovered = [];
  for (const transactionRoot of roots) {
    recovered.push(
      await recoverReleasePromotion({
        transactionRoot,
        releaseLock,
        allowedDestinations,
        allowedSourceParent,
        allowedSourceLayouts,
        validateCommitted,
        fsOps,
      }),
    );
  }
  return recovered;
};

export const promoteDirectoriesAtomically = async ({
  promotions,
  transactionRoot,
  releaseLock,
  validatePromoted = async () => {},
  checkpoint = async () => {},
  rollbackOnError = true,
  fsOps = {},
}) => {
  const operations = defaultOperations(fsOps);
  if (!Array.isArray(promotions) || promotions.length === 0) {
    throw new Error('Release promotion requires at least one directory pair.');
  }
  await assertReleaseLockHeld({ releaseLock, fsOps });
  const resolvedRoot = path.resolve(transactionRoot);
  assertTransactionRootForLock(releaseLock, resolvedRoot);
  await assertPlainDirectoryPath(path.dirname(resolvedRoot), operations);
  if (await operations.exists(resolvedRoot)) {
    throw new Error(`Release promotion transaction already exists: ${resolvedRoot}.`);
  }
  const transactionId = randomUUID();
  const records = [];
  for (const [index, promotion] of promotions.entries()) {
    const source = path.resolve(promotion.source);
    const destination = path.resolve(promotion.destination);
    if (!(await operations.exists(source))) {
      throw new Error(`Promotion source does not exist: ${source}.`);
    }
    await assertPlainDirectoryPath(source, operations);
    await assertPlainDirectoryPath(destination, operations, { allowMissing: true });
    records.push({
      source,
      destination,
      backup: path.join(resolvedRoot, `${transactionId}-${index}.backup`),
      sourceIdentity: await optionalDirectoryIdentity(source, operations),
      destinationIdentity: await optionalDirectoryIdentity(destination, operations),
    });
  }
  assertDistinctPromotionPaths(records);
  assertTransactionRootDisjoint(resolvedRoot, records);
  for (const record of records) {
    if (!isDirectoryIdentity(record.sourceIdentity, { requireFiles: true })) {
      throw new Error(`Promotion source is empty or invalid: ${record.source}.`);
    }
  }
  const journal = {
    schemaVersion: RELEASE_PROMOTION_SCHEMA_VERSION,
    transactionId,
    state: 'prepared',
    createdAt: new Date().toISOString(),
    records,
  };
  const preparationRoot = path.join(
    path.dirname(resolvedRoot),
    `${RELEASE_PREPARATION_PREFIX}${process.pid}-${transactionId}`,
  );
  const journalPath = path.join(preparationRoot, RELEASE_PROMOTION_JOURNAL);
  const commitPath = path.join(resolvedRoot, RELEASE_PROMOTION_COMMIT);
  let published = false;
  await operations.mkdir(preparationRoot, { recursive: false });
  await syncDirectoryMetadata(path.dirname(preparationRoot), operations);
  try {
    await checkpoint('preparation-created', journal);
    await atomicWriteJsonDurably(journalPath, journal, operations);
    await checkpoint('preparation-durable', journal);
    await renameDurably(preparationRoot, resolvedRoot, operations);
    published = true;
    await checkpoint('journal-durable', journal);
    for (const [index, record] of records.entries()) {
      await mkdirDurably(path.dirname(record.destination), operations);
      if (record.destinationIdentity !== null) {
        await renameDurably(record.destination, record.backup, operations);
      }
      await checkpoint(`backup:${index}`, journal);
      await renameDurably(record.source, record.destination, operations);
      await checkpoint(`promote:${index}`, journal);
    }
    await assertCommittedDestinations(journal, operations);
    await checkpoint('identities-verified', journal);
    await validatePromoted(journal);
    await checkpoint('validation-complete', journal);
    await assertCommittedDestinations(journal, operations);
    await atomicWriteJsonDurably(
      commitPath,
      {
        schemaVersion: RELEASE_PROMOTION_SCHEMA_VERSION,
        transactionId,
        state: 'committed',
        journalSha256: sha256Text(jsonDocument(journal)),
        committedAt: new Date().toISOString(),
      },
      operations,
    );
    await checkpoint('commit-durable', journal);
  } catch (error) {
    if (!published) {
      if (rollbackOnError) {
        await removeDirectoryDurably(preparationRoot, operations);
      }
      throw error;
    }
    if (!rollbackOnError || (await lstatExists(commitPath, operations))) throw error;
    try {
      await recoverReleasePromotion({ transactionRoot: resolvedRoot, releaseLock, fsOps });
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Release promotion failed and durable rollback was incomplete.',
      );
    }
    throw error;
  }
  try {
    const recovered = await recoverReleasePromotion({
      transactionRoot: resolvedRoot,
      releaseLock,
      validateCommitted: validatePromoted,
      checkpoint,
      fsOps,
    });
    if (recovered.disposition !== 'committed') {
      throw new Error('Release promotion unexpectedly recovered as uncommitted.');
    }
  } catch (error) {
    if (!(await operations.exists(resolvedRoot))) throw error;
    try {
      await assertCommittedDestinations(journal, operations);
    } catch (validationError) {
      throw new AggregateError([error, validationError], 'Committed release state is invalid.');
    }
    throw error;
  }
  return journal;
};
