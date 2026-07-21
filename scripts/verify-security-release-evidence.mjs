#!/usr/bin/env node

import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildDirectoryInventory } from '../apps/desktop/scripts/build-provenance-support.mjs';
import { assertCandidateManifest } from './release-candidate-manifest.mjs';
import { captureSourceSnapshot } from './release-source-state.mjs';
import {
  DEPENDENCY_SBOM_FILE_NAME,
  SECURITY_RAW_RECEIPT_PATHS,
  SECURITY_EVIDENCE_FILE_NAME,
  verifySecurityEvidence,
} from './security-release-evidence-support.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');

const samePlainFile = (left, right) =>
  left.isFile() &&
  right.isFile() &&
  !left.isSymbolicLink() &&
  !right.isSymbolicLink() &&
  left.nlink === 1 &&
  right.nlink === 1 &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.birthtimeMs === right.birthtimeMs &&
  left.mtimeMs === right.mtimeMs &&
  left.size === right.size;

const readStablePlainFile = async (filePath, label) => {
  const before = await lstat(filePath);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size < 1) {
    throw new Error(`${label} must be a non-empty regular one-link file.`);
  }
  const handle = await open(filePath, 'r');
  let opened;
  let afterRead;
  let bytes;
  try {
    opened = await handle.stat();
    if (!samePlainFile(before, opened)) throw new Error(`${label} changed before it was opened.`);
    bytes = await handle.readFile();
    afterRead = await handle.stat();
    if (!samePlainFile(opened, afterRead) || bytes.length !== afterRead.size) {
      throw new Error(`${label} changed while it was read.`);
    }
  } finally {
    await handle.close();
  }
  const after = await lstat(filePath);
  if (!samePlainFile(afterRead, after)) {
    throw new Error(`${label} changed while it was read.`);
  }
  return bytes;
};

const sameInventory = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const parseArgs = (argv) => {
  const options = {
    artifactDir: path.join(repositoryRoot, 'apps', 'desktop', 'out'),
    evidenceDir: path.join(repositoryRoot, 'artifacts', 'release-evidence'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      process.stdout.write(
        'Usage: node scripts/verify-security-release-evidence.mjs [--artifact-dir <path>] [--evidence-dir <path>]\n',
      );
      process.exit(0);
    }
    if (argument === '--artifact-dir' || argument === '--evidence-dir') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}.`);
      index += 1;
      options[argument === '--artifact-dir' ? 'artifactDir' : 'evidenceDir'] = path.resolve(value);
      continue;
    }
    throw new Error(`Unknown option: ${argument}.`);
  }
  return options;
};

export const verifySecurityReleaseEvidenceFiles = async ({
  artifactDir,
  evidenceDir,
  now = Date.now(),
}) => {
  const paths = {
    candidate: path.join(evidenceDir, 'release-candidate-v1.json'),
    release: path.join(evidenceDir, 'release-manifest.json'),
    sbom: path.join(evidenceDir, DEPENDENCY_SBOM_FILE_NAME),
    security: path.join(evidenceDir, SECURITY_EVIDENCE_FILE_NAME),
    workflow: path.join(repositoryRoot, '.github', 'workflows', 'codeql.yml'),
    package: path.join(repositoryRoot, 'package.json'),
  };
  const entries = Object.entries(paths);
  const initialFiles = new Map(
    await Promise.all(
      entries.map(async ([label, filePath]) => [
        label,
        await readStablePlainFile(filePath, `Security input ${label}`),
      ]),
    ),
  );
  const candidateBytes = initialFiles.get('candidate');
  const releaseManifestBytes = initialFiles.get('release');
  const dependencySbomBytes = initialFiles.get('sbom');
  const securityBytes = initialFiles.get('security');
  const workflowBytes = initialFiles.get('workflow');
  const packageBytes = initialFiles.get('package');
  const candidateManifest = JSON.parse(candidateBytes.toString('utf8'));
  const releaseManifest = JSON.parse(releaseManifestBytes.toString('utf8'));
  const rootPackage = JSON.parse(packageBytes.toString('utf8'));
  const source = await captureSourceSnapshot(repositoryRoot, { requireClean: true });
  const inventory = await buildDirectoryInventory(artifactDir);
  assertCandidateManifest({
    manifest: candidateManifest,
    inventory: inventory.files,
    version: candidateManifest.version,
    source,
  });
  const securityManifest = JSON.parse(securityBytes.toString('utf8'));
  const allowedDefenderLogs = new Set([
    'private-security/installer-defender-scan.log',
    'private-security/win-unpacked-defender-scan.log',
  ]);
  const defenderLogFiles = new Map();
  for (const scan of securityManifest?.defender?.scans ?? []) {
    if (!allowedDefenderLogs.has(scan?.outputLog)) {
      throw new Error('Security evidence references an unexpected Defender log path.');
    }
    defenderLogFiles.set(
      scan.outputLog,
      await readStablePlainFile(
        path.join(evidenceDir, ...scan.outputLog.split('/')),
        `Defender receipt ${scan.outputLog}`,
      ),
    );
  }
  if (
    defenderLogFiles.size !== allowedDefenderLogs.size ||
    [...allowedDefenderLogs].some((entry) => !defenderLogFiles.has(entry))
  ) {
    throw new Error('Security evidence does not contain both exact Defender logs.');
  }
  const rawReceiptFiles = new Map(
    await Promise.all(
      Object.values(SECURITY_RAW_RECEIPT_PATHS).map(async (relativePath) => [
        relativePath,
        await readStablePlainFile(
          path.join(evidenceDir, ...relativePath.split('/')),
          `Raw security receipt ${relativePath}`,
        ),
      ]),
    ),
  );
  const result = verifySecurityEvidence({
    manifestBytes: securityBytes,
    candidateManifest,
    candidateManifestBytes: candidateBytes,
    releaseManifest,
    releaseManifestBytes,
    dependencySbomBytes,
    packageManager: rootPackage.packageManager,
    codeqlWorkflowBytes: workflowBytes,
    rawReceiptFiles,
    defenderLogFiles,
    source,
    now,
  });
  const [finalFiles, finalDefenderLogs, finalRawReceipts, finalSource, finalInventory] =
    await Promise.all([
      Promise.all(
        entries.map(async ([label, filePath]) => [
          label,
          await readStablePlainFile(filePath, `Security input ${label}`),
        ]),
      ),
      Promise.all(
        [...defenderLogFiles.keys()].map(async (relativePath) => [
          relativePath,
          await readStablePlainFile(
            path.join(evidenceDir, ...relativePath.split('/')),
            `Defender receipt ${relativePath}`,
          ),
        ]),
      ),
      Promise.all(
        [...rawReceiptFiles.keys()].map(async (relativePath) => [
          relativePath,
          await readStablePlainFile(
            path.join(evidenceDir, ...relativePath.split('/')),
            `Raw security receipt ${relativePath}`,
          ),
        ]),
      ),
      captureSourceSnapshot(repositoryRoot, { requireClean: true }),
      buildDirectoryInventory(artifactDir),
    ]);
  if (
    finalFiles.some(([label, bytes]) => !initialFiles.get(label)?.equals(bytes)) ||
    finalDefenderLogs.some(
      ([relativePath, bytes]) => !defenderLogFiles.get(relativePath)?.equals(bytes),
    ) ||
    finalRawReceipts.some(
      ([relativePath, bytes]) => !rawReceiptFiles.get(relativePath)?.equals(bytes),
    ) ||
    JSON.stringify(finalSource) !== JSON.stringify(source) ||
    !sameInventory(finalInventory, inventory)
  ) {
    throw new Error('Security evidence inputs changed during verification.');
  }
  process.stdout.write(
    `Security evidence verified: ${result.manifestSha256} (${result.manifestSize} bytes).\n`,
  );
  return result;
};

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  try {
    await verifySecurityReleaseEvidenceFiles(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`Security release evidence verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
