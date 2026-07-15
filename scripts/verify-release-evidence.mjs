#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

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
  if (options.requireReady && !manifest.quality.releaseReady) {
    console.error('FAIL: manifest does not describe a fresh candidate with an installer.');
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(`Release evidence verification failed: ${error.message}`);
  process.exitCode = 1;
});
