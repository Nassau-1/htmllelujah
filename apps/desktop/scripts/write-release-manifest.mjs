#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  RELEASE_CANDIDATE_SCHEMA_VERSION,
  aggregateInventory,
  assertBuildProvenance,
  assertSourceSnapshot,
  buildDirectoryInventory,
  readJsonFile,
  readPackagedBuildProvenance,
} from './build-provenance-support.mjs';
import { expectedUnsignedInstallerName } from './installer-smoke-support.mjs';

const desktopRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = path.resolve(desktopRoot, '..', '..');

const usage = () => `Usage: node scripts/write-release-manifest.mjs [options]

Options:
  --artifact-dir <path>  isolated electron-builder candidate directory
  --output <path>        candidate manifest outside the artifact directory
  --session <path>       pre-build provenance session
  --help                 show this help`;

const parseArgs = (argv) => {
  const options = {
    artifactDir: path.join(desktopRoot, 'out'),
    outputPath: path.join(
      repositoryRoot,
      'artifacts',
      'release-evidence',
      'release-candidate-v1.json',
    ),
    sessionPath: path.join(repositoryRoot, 'artifacts', 'build-provenance-session.json'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (['--artifact-dir', '--output', '--session'].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}.`);
      index += 1;
      if (argument === '--artifact-dir') options.artifactDir = path.resolve(value);
      if (argument === '--output') options.outputPath = path.resolve(value);
      if (argument === '--session') options.sessionPath = path.resolve(value);
      continue;
    }
    throw new Error(`Unknown option: ${argument}.`);
  }
  const outputRelation = path.relative(options.artifactDir, options.outputPath);
  if (!outputRelation.startsWith('..') && !path.isAbsolute(outputRelation)) {
    throw new Error('The release candidate manifest must be outside the artifact directory.');
  }
  const evidenceRoot = path.join(repositoryRoot, 'artifacts');
  const evidenceRelation = path.relative(evidenceRoot, options.outputPath);
  if (
    evidenceRelation === '' ||
    evidenceRelation.startsWith('..') ||
    path.isAbsolute(evidenceRelation)
  ) {
    throw new Error('The release candidate manifest must live under ignored artifacts/.');
  }
  return options;
};

const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const selectEntry = (inventory, entryPath) => {
  const entry = inventory.files.find((item) => item.path === entryPath);
  if (!entry) throw new Error(`Missing required release artifact: ${entryPath}.`);
  return entry;
};

const assertCandidateShape = (inventory, version) => {
  const installerName = expectedUnsignedInstallerName(version);
  const blockmapName = `${installerName}.blockmap`;
  const rootFiles = inventory.files.filter((entry) => !entry.path.startsWith('win-unpacked/'));
  const allowedRoot = new Set([installerName, blockmapName]);
  const unexpected = rootFiles.filter((entry) => !allowedRoot.has(entry.path));
  if (unexpected.length > 0) {
    throw new Error(
      `Unexpected artifact-root files: ${unexpected.map((entry) => entry.path).join(', ')}.`,
    );
  }
  if (rootFiles.length !== 2) {
    throw new Error('The release root must contain exactly one installer and its blockmap.');
  }
  const forbidden = inventory.files.filter((entry) =>
    [
      /(?:^|\/)builder-(?:debug|effective-config)\.(?:json|ya?ml)$/iu,
      /(?:^|\/)electron-builder(?:[-_.][^/]*)?\.(?:json|log|ya?ml)$/iu,
      /(?:^|\/)[^/]+\.(?:map|pdb)$/iu,
      /(?:^|\/)\.env(?:\.[^/]*)?$/iu,
    ].some((pattern) => pattern.test(entry.path)),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `Forbidden build metadata: ${forbidden.map((entry) => entry.path).join(', ')}.`,
    );
  }
  for (const required of [
    'win-unpacked/HTMLlelujah.exe',
    'win-unpacked/HTMLlelujah-MCP.cmd',
    'win-unpacked/LICENSE.txt',
    'win-unpacked/COMMERCIAL-LICENSING.md',
    'win-unpacked/LICENSE.electron.txt',
    'win-unpacked/LICENSES.chromium.html',
    'win-unpacked/THIRD_PARTY_NOTICES.md',
    'win-unpacked/resources/app.asar',
  ]) {
    selectEntry(inventory, required);
  }
  if (selectEntry(inventory, installerName).size < 1_048_576) {
    throw new Error('The release installer is not a plausible NSIS artifact.');
  }
  if (selectEntry(inventory, blockmapName).size < 1) {
    throw new Error('The release installer blockmap is empty.');
  }
  if (
    selectEntry(inventory, 'win-unpacked/HTMLlelujah.exe').size < 1_048_576 ||
    selectEntry(inventory, 'win-unpacked/resources/app.asar').size < 1_048_576
  ) {
    throw new Error('The unpacked companion payload is not plausible.');
  }
  return { installerName, blockmapName };
};

const atomicWriteJson = async (filePath, value) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
};

const options = parseArgs(process.argv.slice(2));
await rm(options.outputPath, { force: true });

const artifactRootEntries = await readdir(options.artifactDir, { withFileTypes: true });
const unexpectedArtifactDirectories = artifactRootEntries.filter(
  (entry) => entry.isDirectory() && entry.name !== 'win-unpacked',
);
if (unexpectedArtifactDirectories.length > 0) {
  throw new Error(
    `Unexpected artifact-root directories: ${unexpectedArtifactDirectories
      .map((entry) => entry.name)
      .join(', ')}.`,
  );
}

const desktopPackage = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8'));
const session = await readJsonFile(options.sessionPath);
if (
  session?.schemaVersion !== 1 ||
  session.requireClean !== true ||
  session.source?.dirty !== false ||
  !session.embeddedProvenance
) {
  throw new Error('A release manifest requires a completed clean pre-build provenance session.');
}
await assertSourceSnapshot(repositoryRoot, session.source, { requireClean: true });

const inventory = await buildDirectoryInventory(options.artifactDir);
const { installerName, blockmapName } = assertCandidateShape(inventory, desktopPackage.version);
const appAsarPath = path.join(options.artifactDir, 'win-unpacked', 'resources', 'app.asar');
const sourceProvenance = await readJsonFile(
  path.join(desktopRoot, 'dist-electron', 'build-provenance.json'),
);
const packagedProvenance = readPackagedBuildProvenance(appAsarPath, desktopRoot);
const expectedProvenance = {
  productName: 'HTMLlelujah',
  version: desktopPackage.version,
  sourceCommit: session.source.commit,
  sourceTree: session.source.tree,
  lockfileSha256: session.lockfile.sha256,
};
assertBuildProvenance(sourceProvenance, expectedProvenance);
assertBuildProvenance(packagedProvenance, expectedProvenance);
if (
  !sameJson(sourceProvenance, packagedProvenance) ||
  !sameJson(sourceProvenance, session.embeddedProvenance)
) {
  throw new Error(
    'The source, session, and packaged build provenance are not byte-equivalent JSON.',
  );
}
if (
  !Array.isArray(packagedProvenance.workspacePackages) ||
  packagedProvenance.workspacePackages.length === 0
) {
  throw new Error('The packaged provenance does not attest rebuilt workspace packages.');
}
const expectedWorkspacePackageNames = [];
for (const entry of await readdir(path.join(repositoryRoot, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const packageJson = JSON.parse(
    await readFile(path.join(repositoryRoot, 'packages', entry.name, 'package.json'), 'utf8'),
  );
  if (!packageJson.name || !packageJson.scripts?.build) {
    throw new Error(`Workspace package ${entry.name} lacks its release build contract.`);
  }
  expectedWorkspacePackageNames.push(packageJson.name);
}
expectedWorkspacePackageNames.sort((left, right) => left.localeCompare(right, 'en'));
const attestedWorkspacePackageNames = packagedProvenance.workspacePackages
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right, 'en'));
if (
  JSON.stringify(expectedWorkspacePackageNames) !== JSON.stringify(attestedWorkspacePackageNames)
) {
  throw new Error('The packaged provenance does not attest every workspace package exactly once.');
}
for (const [index, entry] of packagedProvenance.workspacePackages.entries()) {
  if (
    entry.buildOrder !== index + 1 ||
    entry.dist?.fileCount < 1 ||
    !/^[0-9a-f]{64}$/u.test(entry.dist?.aggregateSha256 ?? '')
  ) {
    throw new Error('A workspace package rebuild attestation is incomplete or out of order.');
  }
}

const unpackedFiles = inventory.files
  .filter((entry) => entry.path.startsWith('win-unpacked/'))
  .map((entry) => ({ ...entry, path: entry.path.slice('win-unpacked/'.length) }));
const artifactConfirmation = await buildDirectoryInventory(options.artifactDir);
if (!sameJson(inventory, artifactConfirmation)) {
  throw new Error('Release artifacts changed during candidate attestation.');
}
await assertSourceSnapshot(repositoryRoot, session.source, { requireClean: true });

const manifest = {
  schemaVersion: RELEASE_CANDIDATE_SCHEMA_VERSION,
  productName: 'HTMLlelujah',
  version: desktopPackage.version,
  buildId: packagedProvenance.buildId,
  createdAt: new Date().toISOString(),
  source: {
    commit: session.source.commit,
    dirty: false,
    treeSha256: session.source.tree.sha256,
    fileCount: session.source.tree.fileCount,
    bytes: session.source.tree.bytes,
  },
  lockfile: session.lockfile,
  build: {
    embeddedProvenance: packagedProvenance,
    workspacePackages: packagedProvenance.workspacePackages,
  },
  artifact: {
    fileCount: inventory.fileCount,
    totalSize: inventory.totalSize,
    aggregateSha256: inventory.aggregateSha256,
    installer: selectEntry(inventory, installerName),
    blockmap: selectEntry(inventory, blockmapName),
    winUnpacked: {
      fileCount: unpackedFiles.length,
      totalSize: unpackedFiles.reduce((sum, entry) => sum + entry.size, 0),
      aggregateSha256: aggregateInventory(unpackedFiles),
      files: unpackedFiles,
    },
    files: inventory.files,
  },
};
await atomicWriteJson(options.outputPath, manifest);
const finalArtifactConfirmation = await buildDirectoryInventory(options.artifactDir);
if (!sameJson(inventory, finalArtifactConfirmation)) {
  await rm(options.outputPath, { force: true });
  throw new Error('Release artifacts changed after candidate attestation.');
}
await assertSourceSnapshot(repositoryRoot, session.source, { requireClean: true });
process.stdout.write(`Windows release candidate manifest: ${options.outputPath}\n`);
