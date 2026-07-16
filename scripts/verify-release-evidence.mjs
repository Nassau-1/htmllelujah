#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { artifactFreshness, sourceProvenance } from './release-source-state.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

function usage() {
  return `Usage: node scripts/verify-release-evidence.mjs [options]

Options:
  --artifact-dir <path>  artifact directory to verify (default from manifest)
  --evidence-dir <path>  evidence directory (default: artifacts/release-evidence)
  --require-ready        fail if the recorded candidate is stale or has no installer
  --help                 show this help`;
}

function parseArgs(argv) {
  const result = {
    artifactDir: undefined,
    evidenceDir: path.join(REPO_ROOT, 'artifacts', 'release-evidence'),
    requireReady: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      console.log(usage());
      process.exit(0);
    }
    if (argument === '--require-ready') {
      result.requireReady = true;
      continue;
    }
    if (argument === '--artifact-dir' || argument === '--evidence-dir') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
      index += 1;
      result[argument === '--artifact-dir' ? 'artifactDir' : 'evidenceDir'] = path.resolve(value);
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  result.evidenceDir = path.resolve(result.evidenceDir);
  return result;
}

function normalizePath(value) {
  return value.split(path.sep).join('/');
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function listFiles(root, ignoredRoot) {
  const files = [];
  const ignored = ignoredRoot ? path.resolve(ignoredRoot).toLowerCase() : null;
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const canonical = path.resolve(fullPath).toLowerCase();
      if (ignored && (canonical === ignored || canonical.startsWith(`${ignored}${path.sep}`)))
        continue;
      if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink: ${fullPath}`);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  }
  await visit(root);
  return files;
}

function aggregateHash(entries) {
  return sha256Text(
    entries.map((entry) => `${entry.path}\0${entry.size}\0${entry.sha256}\n`).join(''),
  );
}

const isInstaller = (entry) =>
  !entry.path.startsWith('win-unpacked/') &&
  entry.path.toLowerCase().endsWith('.exe') &&
  /(?:setup|installer|install)/iu.test(path.basename(entry.path));

const revalidateCandidateShape = (entries, version) => {
  const errors = [];
  const expectedInstaller = `HTMLlelujah-${version}-x64-unsigned-Setup.exe`;
  const expectedBlockmap = `${expectedInstaller}.blockmap`;
  const installers = entries.filter(isInstaller);
  if (installers.length !== 1 || installers[0]?.path !== expectedInstaller) {
    errors.push(
      `expected exactly ${expectedInstaller}, found ${installers.map((entry) => entry.path).join(', ') || 'none'}`,
    );
  }
  const unexpectedRootFiles = entries
    .filter(
      (entry) =>
        !entry.path.startsWith('win-unpacked/') &&
        entry.path !== expectedInstaller &&
        entry.path !== expectedBlockmap,
    )
    .map((entry) => entry.path);
  if (unexpectedRootFiles.length > 0) {
    errors.push(`unexpected artifact-root files: ${unexpectedRootFiles.join(', ')}`);
  }
  const forbiddenMetadataFiles = entries
    .filter((entry) =>
      [
        /(?:^|\/)builder-(?:debug|effective-config)\.(?:json|ya?ml)$/iu,
        /(?:^|\/)electron-builder(?:[-_.][^/]*)?\.(?:json|log|ya?ml)$/iu,
        /(?:^|\/)\.env(?:\.[^/]*)?$/iu,
        /(?:^|\/)[^/]+\.(?:map|pdb)$/iu,
      ].some((pattern) => pattern.test(entry.path)),
    )
    .map((entry) => entry.path);
  if (forbiddenMetadataFiles.length > 0) {
    errors.push(`forbidden build metadata: ${forbiddenMetadataFiles.join(', ')}`);
  }
  for (const required of [
    'win-unpacked/HTMLlelujah.exe',
    'win-unpacked/HTMLlelujah-MCP.cmd',
    'win-unpacked/EULA.txt',
    'win-unpacked/LICENSE.txt',
    'win-unpacked/LICENSE.electron.txt',
    'win-unpacked/LICENSES.chromium.html',
    'win-unpacked/THIRD_PARTY_NOTICES.md',
    'win-unpacked/resources/app.asar',
  ]) {
    if (!entries.some((entry) => entry.path === required)) {
      errors.push(`missing required unpacked file: ${required}`);
    }
  }
  return { errors, installers };
};

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifestPath = path.join(options.evidenceDir, 'release-manifest.json');
  const inventoryPath = path.join(options.evidenceDir, 'content-inventory.json');
  const checksumsPath = path.join(options.evidenceDir, 'checksums-sha256.txt');
  const manifest = await readJson(manifestPath);
  const inventory = await readJson(inventoryPath);
  const artifactDir = options.artifactDir ?? path.resolve(REPO_ROOT, manifest.artifact.root);

  const errors = [];
  if (manifest.schemaVersion !== 1 || inventory.schemaVersion !== 1) {
    errors.push('Unsupported release evidence schema version');
  }
  const requiredEvidenceFiles = [
    'build-sbom.cdx.json',
    'checksums-sha256.txt',
    'content-inventory.json',
  ];
  const recordedEvidenceFiles = (manifest.evidenceFiles ?? [])
    .map((entry) => entry.path)
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (
    recordedEvidenceFiles.length !== requiredEvidenceFiles.length ||
    recordedEvidenceFiles.join('\n') !== requiredEvidenceFiles.join('\n')
  ) {
    errors.push('Manifest evidence file set is incomplete or unexpected');
  }
  for (const evidence of manifest.evidenceFiles) {
    const evidencePath = path.join(options.evidenceDir, evidence.path);
    const evidenceStat = await stat(evidencePath);
    const actualHash = await sha256(evidencePath);
    if (evidenceStat.size !== evidence.size) {
      errors.push(`${evidence.path}: expected ${evidence.size} bytes, found ${evidenceStat.size}`);
    }
    if (actualHash !== evidence.sha256) {
      errors.push(`${evidence.path}: SHA-256 mismatch`);
    }
  }

  const actualPaths = (await listFiles(artifactDir, options.evidenceDir))
    .map((filePath) => normalizePath(path.relative(artifactDir, filePath)))
    .sort((left, right) => left.localeCompare(right, 'en'));
  const expectedPaths = inventory.files.map((entry) => entry.path);
  const unexpected = actualPaths.filter((entry) => !expectedPaths.includes(entry));
  const missing = expectedPaths.filter((entry) => !actualPaths.includes(entry));
  for (const entry of unexpected) errors.push(`Unexpected artifact file: ${entry}`);
  for (const entry of missing) errors.push(`Missing artifact file: ${entry}`);

  const actualEntries = [];
  for (const expected of inventory.files) {
    if (missing.includes(expected.path)) continue;
    const filePath = path.join(artifactDir, ...expected.path.split('/'));
    const fileStat = await stat(filePath);
    const actualHash = await sha256(filePath);
    actualEntries.push({ path: expected.path, size: fileStat.size, sha256: actualHash });
    if (fileStat.size !== expected.size) errors.push(`${expected.path}: size mismatch`);
    if (actualHash !== expected.sha256) errors.push(`${expected.path}: SHA-256 mismatch`);
  }
  actualEntries.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  if (aggregateHash(actualEntries) !== inventory.aggregateSha256) {
    errors.push('Artifact aggregate SHA-256 mismatch');
  }
  if (manifest.artifact.aggregateSha256 !== inventory.aggregateSha256) {
    errors.push('Manifest and inventory aggregate SHA-256 values differ');
  }
  if (
    manifest.artifact.fileCount !== inventory.files.length ||
    inventory.fileCount !== inventory.files.length
  ) {
    errors.push('Manifest or inventory file count is inconsistent');
  }
  const actualTotalSize = actualEntries.reduce((total, entry) => total + entry.size, 0);
  if (manifest.artifact.totalSize !== actualTotalSize || inventory.totalSize !== actualTotalSize) {
    errors.push('Manifest or inventory total size is inconsistent');
  }

  const checksumLines = (await readFile(checksumsPath, 'utf8'))
    .trimEnd()
    .split(/\r?\n/)
    .filter(Boolean);
  const expectedChecksumLines = inventory.files.map((entry) => `${entry.sha256}  ${entry.path}`);
  if (checksumLines.join('\n') !== expectedChecksumLines.join('\n')) {
    errors.push('checksums-sha256.txt does not exactly match content-inventory.json');
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(`FAIL: ${error}`);
    throw new Error(`${errors.length} release evidence verification error(s)`);
  }

  console.log(`Verified ${actualEntries.length} artifact files.`);
  console.log(`Artifact aggregate SHA-256: ${inventory.aggregateSha256}`);
  console.log('Evidence file hashes: verified.');
  console.log(`Recorded release-ready decision: ${manifest.quality.releaseReady ? 'yes' : 'no'}`);
  if (options.requireReady) {
    const readinessErrors = [];
    const desktopPackage = await readJson(path.join(REPO_ROOT, 'apps', 'desktop', 'package.json'));
    const currentVersion = desktopPackage.version;
    if (manifest.quality.releaseReady !== true) {
      readinessErrors.push('the recorded manifest is not release-ready');
    }
    if (manifest.quality.candidatePolicy?.passed !== true) {
      readinessErrors.push('the manifest lacks a passing current candidate policy');
    }
    if (manifest.release.version !== currentVersion) {
      readinessErrors.push(
        `manifest version ${manifest.release.version ?? 'missing'} does not match package version ${currentVersion}`,
      );
    }
    if (manifest.release.platform !== 'win32' || manifest.release.architecture !== 'x64') {
      readinessErrors.push('manifest platform or architecture is not the Windows x64 V1 target');
    }
    const currentSource = sourceProvenance(REPO_ROOT);
    if (currentSource.commit === null || currentSource.commit !== manifest.release.source?.commit) {
      readinessErrors.push(
        `source commit mismatch (manifest ${manifest.release.source?.commit ?? 'missing'}, current ${currentSource.commit ?? 'unavailable'})`,
      );
    }
    if (currentSource.dirty !== false) {
      readinessErrors.push('the current source worktree is dirty or could not be inspected');
    }
    const candidateShape = revalidateCandidateShape(actualEntries, currentVersion);
    readinessErrors.push(...candidateShape.errors);
    try {
      const currentFreshness = await artifactFreshness({
        artifactDir,
        installers: candidateShape.installers,
        inventory: actualEntries,
        repositoryRoot: REPO_ROOT,
      });
      if (currentFreshness.stale) {
        readinessErrors.push(
          `current source inputs are newer than the artifact (${currentFreshness.latestSourceInput.path})`,
        );
      }
    } catch (error) {
      readinessErrors.push(`current freshness could not be established: ${error.message}`);
    }
    if (readinessErrors.length > 0) {
      for (const error of readinessErrors) console.error(`FAIL: ${error}`);
      process.exitCode = 2;
    }
  }
}

main().catch((error) => {
  console.error(`Release evidence verification failed: ${error.message}`);
  process.exitCode = 1;
});
