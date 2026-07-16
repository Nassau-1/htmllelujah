#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  BUILD_PROVENANCE_SCHEMA_VERSION,
  DESKTOP_BUILD_COMMAND,
  WINDOWS_CANDIDATE_BUILD_COMMAND,
  assertSourceSnapshot,
  buildDirectoryInventory,
  captureSourceSnapshot,
  readJsonFile,
  regularFileIdentity,
} from './build-provenance-support.mjs';

const desktopRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = path.resolve(desktopRoot, '..', '..');
const defaultSessionPath = path.join(repositoryRoot, 'artifacts', 'build-provenance-session.json');
const outputPath = path.join(desktopRoot, 'dist-electron', 'build-provenance.json');

const usage = () => `Usage: node scripts/write-build-provenance.mjs <mode> [options]

Modes:
  --prepare                 capture source provenance before any build command
  --embed                   verify the snapshot after build and embed it
  --verify                  verify source and embedded provenance without writing

Options:
  --session <path>          ignored/out-of-tree session file
  --workspace-build <path>  post-build workspace package inventory (embed only)
  --build-id <uuid>         build identifier (prepare only)
  --require-clean           reject staged, unstaged, or untracked source
  --help                    show this help`;

const parseArgs = (argv) => {
  const options = {
    mode: null,
    sessionPath: defaultSessionPath,
    workspaceBuildPath: null,
    buildId: null,
    requireClean: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (['--prepare', '--embed', '--verify'].includes(argument)) {
      if (options.mode !== null) throw new Error('Choose exactly one provenance mode.');
      options.mode = argument.slice(2);
      continue;
    }
    if (argument === '--require-clean') {
      options.requireClean = true;
      continue;
    }
    if (['--session', '--workspace-build', '--build-id'].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}.`);
      index += 1;
      if (argument === '--session') options.sessionPath = path.resolve(value);
      if (argument === '--workspace-build') options.workspaceBuildPath = path.resolve(value);
      if (argument === '--build-id') options.buildId = value;
      continue;
    }
    throw new Error(`Unknown option: ${argument}.`);
  }
  if (options.mode === null) throw new Error('A provenance mode is required.');
  if (options.mode !== 'embed' && options.workspaceBuildPath !== null) {
    throw new Error('--workspace-build is valid only with --embed.');
  }
  return options;
};

const assertSafeSessionPath = (sessionPath) => {
  const relation = path.relative(repositoryRoot, sessionPath);
  if (!relation.startsWith('..') && !path.isAbsolute(relation)) {
    const firstSegment = relation.split(path.sep)[0];
    if (firstSegment !== 'artifacts') {
      throw new Error('An in-repository provenance session must live under ignored artifacts/.');
    }
  }
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

const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const validateSession = (session) => {
  if (
    session?.schemaVersion !== 1 ||
    !session.buildId ||
    !session.source?.commit ||
    !session.source?.tree?.sha256 ||
    !session.lockfile?.sha256
  ) {
    throw new Error('The build provenance session is invalid or incomplete.');
  }
};

const prepare = async (options) => {
  const source = await captureSourceSnapshot(repositoryRoot, {
    requireClean: options.requireClean,
  });
  const lockfile = await regularFileIdentity(path.join(repositoryRoot, 'pnpm-lock.yaml'));
  const desktopPackage = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8'));
  const confirmation = await captureSourceSnapshot(repositoryRoot, {
    requireClean: options.requireClean,
  });
  if (source.commit !== confirmation.commit || !sameJson(source.tree, confirmation.tree)) {
    throw new Error('Source changed while the pre-build provenance session was prepared.');
  }
  const session = {
    schemaVersion: 1,
    buildId: options.buildId ?? randomUUID(),
    preparedAt: new Date().toISOString(),
    requireClean: options.requireClean,
    productName: 'HTMLlelujah',
    version: desktopPackage.version,
    source,
    lockfile: {
      path: 'pnpm-lock.yaml',
      sha256: lockfile.sha256,
      size: lockfile.size,
    },
  };
  await atomicWriteJson(options.sessionPath, session);
  process.stdout.write(`Captured pre-build provenance for ${source.commit}.\n`);
};

const verifySessionSource = async (session, requireClean) => {
  await assertSourceSnapshot(repositoryRoot, session.source, {
    requireClean: requireClean || session.requireClean,
  });
  const lockfile = await regularFileIdentity(path.join(repositoryRoot, 'pnpm-lock.yaml'));
  if (lockfile.sha256 !== session.lockfile.sha256 || lockfile.size !== session.lockfile.size) {
    throw new Error('The lockfile changed after the pre-build provenance snapshot.');
  }
};

const embed = async (options, session) => {
  await verifySessionSource(session, options.requireClean);
  const workspacePackages = options.workspaceBuildPath
    ? await readJsonFile(options.workspaceBuildPath)
    : null;
  if (
    workspacePackages !== null &&
    (workspacePackages.schemaVersion !== 1 || !Array.isArray(workspacePackages.packages))
  ) {
    throw new Error('The workspace package build inventory is invalid.');
  }
  if (workspacePackages !== null) {
    for (const [index, entry] of workspacePackages.packages.entries()) {
      const packageRoot = path.resolve(repositoryRoot, ...String(entry.path ?? '').split('/'));
      const relation = path.relative(path.join(repositoryRoot, 'packages'), packageRoot);
      if (
        entry.buildOrder !== index + 1 ||
        relation === '' ||
        relation.startsWith('..') ||
        path.isAbsolute(relation)
      ) {
        throw new Error('A workspace package build entry has an unsafe path or build order.');
      }
      const currentDist = await buildDirectoryInventory(path.join(packageRoot, 'dist'));
      if (JSON.stringify(currentDist) !== JSON.stringify(entry.dist)) {
        throw new Error(`Workspace package output differs from its attestation: ${entry.name}.`);
      }
    }
  }
  const provenance = {
    schemaVersion: BUILD_PROVENANCE_SCHEMA_VERSION,
    buildId: session.buildId,
    productName: session.productName,
    version: session.version,
    capturedAt: session.preparedAt,
    embeddedAt: new Date().toISOString(),
    sourceCommit: session.source.commit,
    sourceDirty: session.source.dirty,
    sourceTreeSha256: session.source.tree.sha256,
    sourceFileCount: session.source.tree.fileCount,
    sourceBytes: session.source.tree.bytes,
    lockfileSha256: session.lockfile.sha256,
    desktopBuildCommand: DESKTOP_BUILD_COMMAND,
    releaseBuildCommand: WINDOWS_CANDIDATE_BUILD_COMMAND,
    workspacePackages: workspacePackages?.packages ?? [],
    nodeVersion: process.version,
  };
  await atomicWriteJson(outputPath, provenance);
  await verifySessionSource(session, options.requireClean);
  const nextSession = { ...session, embeddedProvenance: provenance };
  await atomicWriteJson(options.sessionPath, nextSession);
  process.stdout.write(`Embedded verified provenance for ${session.source.commit}.\n`);
};

const verify = async (options, session) => {
  await verifySessionSource(session, options.requireClean);
  if (!session.embeddedProvenance) {
    throw new Error('The provenance session has not been embedded yet.');
  }
  const embedded = await readJsonFile(outputPath);
  if (!sameJson(embedded, session.embeddedProvenance)) {
    throw new Error('The embedded provenance differs from the verified build session.');
  }
  process.stdout.write(`Verified embedded provenance for ${session.source.commit}.\n`);
};

const options = parseArgs(process.argv.slice(2));
assertSafeSessionPath(options.sessionPath);
if (options.mode === 'prepare') {
  await prepare(options);
} else {
  const session = await readJsonFile(options.sessionPath);
  validateSession(session);
  if (options.mode === 'embed') await embed(options, session);
  else await verify(options, session);
}
