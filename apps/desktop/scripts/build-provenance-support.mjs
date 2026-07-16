import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  assertSourceSnapshot,
  captureSourceSnapshot,
  gitSourceState,
  trackedSourceIdentity,
} from '../../../scripts/release-source-state.mjs';

export { assertSourceSnapshot, captureSourceSnapshot, gitSourceState, trackedSourceIdentity };

export const BUILD_PROVENANCE_SCHEMA_VERSION = 2;
export const RELEASE_CANDIDATE_SCHEMA_VERSION = 2;
export const DESKTOP_BUILD_COMMAND =
  'node scripts/write-build-provenance.mjs --prepare && vite build && node scripts/write-build-provenance.mjs --embed';
export const WINDOWS_CANDIDATE_BUILD_COMMAND = 'node scripts/build-windows-release.mjs';
export const EMBEDDED_PROVENANCE_PATH = 'dist-electron/build-provenance.json';

export const sha256File = (filePath) =>
  new Promise((resolve, reject) => {
    const digest = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(digest.digest('hex')));
  });

export const regularFileIdentity = async (filePath, minimumSize = 1) => {
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size < minimumSize) {
    throw new Error(`Expected a regular file at ${filePath}.`);
  }
  return {
    sha256: await sha256File(filePath),
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    mtimeUtc: metadata.mtime.toISOString(),
  };
};

const normalizePath = (value) => value.split(path.sep).join('/');

export const aggregateInventory = (entries, stripPrefix = '') => {
  const digest = createHash('sha256');
  for (const entry of entries) {
    const entryPath =
      stripPrefix && entry.path.startsWith(stripPrefix)
        ? entry.path.slice(stripPrefix.length)
        : entry.path;
    digest.update(entryPath);
    digest.update('\0');
    digest.update(String(entry.size));
    digest.update('\0');
    digest.update(entry.sha256);
    digest.update('\n');
  }
  return digest.digest('hex');
};

export const buildDirectoryInventory = async (root) => {
  const resolvedRoot = path.resolve(root);
  const files = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const metadata = await lstat(fullPath);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Refusing symlink in release inventory: ${fullPath}.`);
      }
      if (metadata.isDirectory()) {
        await visit(fullPath);
      } else if (metadata.isFile()) {
        const before = { size: metadata.size, mtimeMs: metadata.mtimeMs };
        const sha256 = await sha256File(fullPath);
        const after = await stat(fullPath);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
          throw new Error(`File changed while it was inventoried: ${fullPath}.`);
        }
        files.push({
          path: normalizePath(path.relative(resolvedRoot, fullPath)),
          size: after.size,
          sha256,
        });
      }
    }
  };
  await visit(resolvedRoot);
  files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const confirmation = [];
  const collectPaths = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Refusing symlink in release inventory: ${fullPath}.`);
      if (entry.isDirectory()) await collectPaths(fullPath);
      else if (entry.isFile())
        confirmation.push(normalizePath(path.relative(resolvedRoot, fullPath)));
    }
  };
  await collectPaths(resolvedRoot);
  if (confirmation.join('\n') !== files.map((entry) => entry.path).join('\n')) {
    throw new Error('Release file set changed while it was inventoried.');
  }
  return {
    files,
    fileCount: files.length,
    totalSize: files.reduce((sum, entry) => sum + entry.size, 0),
    aggregateSha256: aggregateInventory(files),
  };
};

const resolveAsarModule = (moduleSearchRoot) => {
  const rootRequire = createRequire(path.join(path.resolve(moduleSearchRoot), 'package.json'));
  const electronBuilderPackage = rootRequire.resolve('electron-builder/package.json');
  const builderRequire = createRequire(electronBuilderPackage);
  const asar = builderRequire('@electron/asar');
  if (typeof asar.extractFile !== 'function') {
    throw new Error('The packaging toolchain does not expose direct ASAR extraction.');
  }
  return asar;
};

export const readPackagedBuildProvenance = (appAsarPath, moduleSearchRoot) => {
  let raw;
  try {
    raw = resolveAsarModule(moduleSearchRoot).extractFile(
      appAsarPath,
      EMBEDDED_PROVENANCE_PATH,
      false,
    );
  } catch (error) {
    throw new Error(`Unable to read embedded provenance directly from app.asar: ${error.message}`);
  }
  try {
    return JSON.parse(
      raw
        .toString('utf8')
        .replace(/^\uFEFF/u, '')
        .trim(),
    );
  } catch {
    throw new Error('The packaged build provenance is not valid JSON.');
  }
};

export const assertBuildProvenance = (provenance, expected) => {
  const sourceTree = expected.sourceTree ?? expected.source?.tree;
  if (
    provenance?.schemaVersion !== BUILD_PROVENANCE_SCHEMA_VERSION ||
    provenance.productName !== expected.productName ||
    provenance.version !== expected.version ||
    provenance.sourceCommit !== expected.sourceCommit ||
    provenance.sourceDirty !== false ||
    provenance.sourceTreeSha256 !== sourceTree?.sha256 ||
    provenance.sourceFileCount !== sourceTree?.fileCount ||
    provenance.sourceBytes !== sourceTree?.bytes ||
    provenance.lockfileSha256 !== expected.lockfileSha256 ||
    provenance.desktopBuildCommand !== DESKTOP_BUILD_COMMAND ||
    provenance.releaseBuildCommand !== WINDOWS_CANDIDATE_BUILD_COMMAND
  ) {
    throw new Error('The embedded build provenance does not match the captured release source.');
  }
};

export const readJsonFile = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'));
