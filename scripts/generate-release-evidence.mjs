#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { artifactFreshness, sourceProvenance } from './release-source-state.mjs';
import { assertCandidateManifest } from './release-candidate-manifest.mjs';
import {
  buildNativeRuntimeComponents,
  incompleteNativeRuntimeQuality,
  inspectNativeRuntimeEvidence,
  nativeRuntimeQuality,
} from './native-runtime-evidence-support.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_ARTIFACT_DIR = path.join(REPO_ROOT, 'apps', 'desktop', 'out');
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, 'artifacts', 'release-evidence');

function usage() {
  return `Usage: node scripts/generate-release-evidence.mjs [options]

Options:
  --artifact-dir <path>   electron-builder output (default: apps/desktop/out)
  --output-dir <path>     evidence output (default: artifacts/release-evidence)
  --candidate-manifest <path>  attested candidate manifest outside artifact root
  --version <version>     release version (default: apps/desktop/package.json)
  --repository-url <url>  source repository recorded in the SBOM
  --require-fresh         fail after writing evidence when the artifact is stale
  --require-candidate-manifest  fail unless the candidate manifest validates
  --help                  show this help

Outputs:
  content-inventory.json  exact artifact file inventory and aggregate hashes
  checksums-sha256.txt    SHA-256 checksums for every inventoried file
  build-sbom.cdx.json     CycloneDX build/runtime supplement
  release-manifest.json   release evidence index and freshness decision`;
}

function parseArgs(argv) {
  const result = {
    artifactDir: DEFAULT_ARTIFACT_DIR,
    candidateManifest: undefined,
    outputDir: DEFAULT_OUTPUT_DIR,
    repositoryUrl: 'https://github.com/Nassau-1/htmllelujah',
    requireFresh: false,
    requireCandidateManifest: false,
    version: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      console.log(usage());
      process.exit(0);
    }
    if (argument === '--require-fresh') {
      result.requireFresh = true;
      continue;
    }
    if (argument === '--require-candidate-manifest') {
      result.requireCandidateManifest = true;
      continue;
    }
    if (
      argument === '--artifact-dir' ||
      argument === '--candidate-manifest' ||
      argument === '--output-dir' ||
      argument === '--repository-url' ||
      argument === '--version'
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${argument}`);
      }
      index += 1;
      const key = {
        '--artifact-dir': 'artifactDir',
        '--candidate-manifest': 'candidateManifest',
        '--output-dir': 'outputDir',
        '--repository-url': 'repositoryUrl',
        '--version': 'version',
      }[argument];
      result[key] = value;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  result.artifactDir = path.resolve(result.artifactDir);
  result.outputDir = path.resolve(result.outputDir);
  result.candidateManifest = path.resolve(
    result.candidateManifest ?? path.join(result.outputDir, 'release-candidate-v1.json'),
  );
  return result;
}

function normalizePath(value) {
  return value.split(path.sep).join('/');
}

function repositoryRelative(value) {
  const relative = path.relative(REPO_ROOT, value);
  return relative.startsWith('..') ? path.basename(value) : normalizePath(relative);
}

async function exists(value) {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
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

async function listFiles(root, ignoredRoots = []) {
  const files = [];
  const canonicalIgnored = ignoredRoots.map((item) => path.resolve(item).toLowerCase());

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const canonical = path.resolve(fullPath).toLowerCase();
      if (
        canonicalIgnored.some(
          (ignored) => canonical === ignored || canonical.startsWith(`${ignored}${path.sep}`),
        )
      ) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing symlink in release artifact: ${fullPath}`);
      }
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  await visit(root);
  return files;
}

async function buildFileInventory(root, outputDir) {
  const files = await listFiles(root, [outputDir]);
  if (files.length === 0) {
    throw new Error(`No files found under artifact directory: ${root}`);
  }

  const inventory = [];
  for (const filePath of files) {
    const before = await stat(filePath);
    const digest = await sha256(filePath);
    const after = await stat(filePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(
        `Artifact changed while it was being inventoried (is packaging still running?): ${filePath}`,
      );
    }
    inventory.push({
      path: normalizePath(path.relative(root, filePath)),
      size: after.size,
      sha256: digest,
    });
  }
  const finalFiles = await listFiles(root, [outputDir]);
  const initialSet = files
    .map((item) => path.resolve(item))
    .sort()
    .join('\n');
  const finalSet = finalFiles
    .map((item) => path.resolve(item))
    .sort()
    .join('\n');
  if (initialSet !== finalSet) {
    throw new Error(
      'Artifact file set changed while it was being inventoried (is packaging still running?).',
    );
  }
  inventory.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return inventory;
}

function aggregateHash(entries, prefix = '') {
  return sha256Text(
    entries.map((entry) => `${prefix}${entry.path}\0${entry.size}\0${entry.sha256}\n`).join(''),
  );
}

function groupDeliverables(inventory) {
  const unpacked = inventory.filter((entry) => entry.path.startsWith('win-unpacked/'));
  const installers = inventory.filter(
    (entry) =>
      !entry.path.startsWith('win-unpacked/') &&
      entry.path.toLowerCase().endsWith('.exe') &&
      /(?:setup|installer|install)/i.test(path.basename(entry.path)),
  );
  const blockmaps = inventory.filter((entry) => entry.path.toLowerCase().endsWith('.blockmap'));

  const deliverables = [];
  if (unpacked.length > 0) {
    deliverables.push({
      kind: 'windows-unpacked-directory',
      path: 'win-unpacked/',
      fileCount: unpacked.length,
      size: unpacked.reduce((total, entry) => total + entry.size, 0),
      aggregateSha256: aggregateHash(
        unpacked.map((entry) => ({ ...entry, path: entry.path.slice('win-unpacked/'.length) })),
      ),
    });
  }
  for (const installer of installers) {
    deliverables.push({
      kind: 'windows-installer',
      path: installer.path,
      fileCount: 1,
      size: installer.size,
      sha256: installer.sha256,
    });
  }
  for (const blockmap of blockmaps) {
    deliverables.push({
      kind: 'update-blockmap',
      path: blockmap.path,
      fileCount: 1,
      size: blockmap.size,
      sha256: blockmap.sha256,
    });
  }
  return { blockmaps, deliverables, installers, unpacked };
}

const TEXT_ARTIFACT_EXTENSIONS = new Set([
  '.blockmap',
  '.cfg',
  '.cmd',
  '.config',
  '.html',
  '.ini',
  '.json',
  '.log',
  '.md',
  '.ps1',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);
const MAX_TEXT_ARTIFACT_BYTES = 64 * 1024 * 1024;
const FORBIDDEN_METADATA_PATTERNS = [
  /(?:^|\/)builder-(?:debug|effective-config)\.(?:json|ya?ml)$/iu,
  /(?:^|\/)electron-builder(?:[-_.][^/]*)?\.(?:json|log|ya?ml)$/iu,
  /(?:^|\/)\.env(?:\.[^/]*)?$/iu,
  /(?:^|\/)[^/]+\.(?:map|pdb)$/iu,
];
const PRIVATE_PATH_PATTERNS = [
  {
    kind: 'Windows user-profile path',
    pattern: /[a-z]:[\\/]users[\\/][^\\/\r\n"'<>]+(?:[\\/]|$)/iu,
  },
  {
    kind: 'macOS user-profile path',
    pattern: /\/users\/[^/\s"'<>]+(?:\/|$)/iu,
  },
  {
    kind: 'Unix home path',
    pattern: /\/home\/[^/\s"'<>]+(?:\/|$)/iu,
  },
];

async function validateCandidatePolicy({ artifactDir, grouped, inventory, version }) {
  const expectedInstaller = `HTMLlelujah-${version}-x64-unsigned-Setup.exe`;
  const expectedBlockmap = `${expectedInstaller}.blockmap`;
  const forbiddenMetadataFiles = inventory
    .filter((entry) => FORBIDDEN_METADATA_PATTERNS.some((pattern) => pattern.test(entry.path)))
    .map((entry) => entry.path);
  const unexpectedRootFiles = inventory
    .filter(
      (entry) =>
        !entry.path.startsWith('win-unpacked/') &&
        entry.path !== expectedInstaller &&
        entry.path !== expectedBlockmap,
    )
    .map((entry) => entry.path);
  const candidateErrors = [];
  if (grouped.installers.length > 1) {
    candidateErrors.push(`expected at most one installer, found ${grouped.installers.length}`);
  }
  if (grouped.installers.length === 1 && grouped.installers[0].path !== expectedInstaller) {
    candidateErrors.push(
      `installer filename must be ${expectedInstaller}, found ${grouped.installers[0].path}`,
    );
  }
  if (grouped.installers.length === 1) {
    const exactBlockmaps = grouped.blockmaps.filter((entry) => entry.path === expectedBlockmap);
    if (exactBlockmaps.length !== 1 || grouped.blockmaps.length !== 1) {
      candidateErrors.push(`expected exactly one installer blockmap named ${expectedBlockmap}`);
    }
  }
  if (forbiddenMetadataFiles.length > 0) {
    candidateErrors.push(`forbidden build metadata: ${forbiddenMetadataFiles.join(', ')}`);
  }
  if (unexpectedRootFiles.length > 0) {
    candidateErrors.push(`unexpected artifact-root files: ${unexpectedRootFiles.join(', ')}`);
  }

  const requiredUnpackedFiles = [
    'win-unpacked/HTMLlelujah.exe',
    'win-unpacked/HTMLlelujah-MCP.cmd',
    'win-unpacked/EULA.txt',
    'win-unpacked/LICENSE.txt',
    'win-unpacked/LICENSE.electron.txt',
    'win-unpacked/LICENSES.chromium.html',
    'win-unpacked/THIRD_PARTY_NOTICES.md',
    'win-unpacked/resources/app.asar',
  ];
  const inventoryPaths = new Set(inventory.map((entry) => entry.path));
  const missingRequiredUnpackedFiles =
    grouped.unpacked.length === 0
      ? []
      : requiredUnpackedFiles.filter((entry) => !inventoryPaths.has(entry));
  if (missingRequiredUnpackedFiles.length > 0) {
    candidateErrors.push(
      `missing required unpacked files: ${missingRequiredUnpackedFiles.join(', ')}`,
    );
  }

  const privatePathFindings = [];
  let scannedTextFileCount = 0;
  let scannedTextBytes = 0;
  for (const entry of inventory) {
    if (!TEXT_ARTIFACT_EXTENSIONS.has(path.extname(entry.path).toLowerCase())) continue;
    if (entry.size > MAX_TEXT_ARTIFACT_BYTES) {
      candidateErrors.push(
        `text artifact exceeds the ${MAX_TEXT_ARTIFACT_BYTES}-byte hygiene scan limit: ${entry.path}`,
      );
      continue;
    }
    const filePath = path.join(artifactDir, ...entry.path.split('/'));
    const content = await readFile(filePath, 'utf8');
    scannedTextFileCount += 1;
    scannedTextBytes += entry.size;
    for (const { kind, pattern } of PRIVATE_PATH_PATTERNS) {
      if (pattern.test(content)) privatePathFindings.push({ path: entry.path, kind });
    }
  }
  if (privatePathFindings.length > 0) {
    candidateErrors.push(
      `private local paths found in loose text artifacts: ${privatePathFindings
        .map((entry) => `${entry.path} (${entry.kind})`)
        .join(', ')}`,
    );
  }
  if (candidateErrors.length > 0) {
    throw new Error(`Release candidate policy failed: ${candidateErrors.join('; ')}`);
  }

  return {
    passed: true,
    expectedInstaller,
    allowedArtifactRootFiles: [expectedInstaller, expectedBlockmap],
    forbiddenMetadataFiles,
    unexpectedRootFiles,
    missingRequiredUnpackedFiles,
    looseTextHygiene: {
      scannedFileCount: scannedTextFileCount,
      scannedBytes: scannedTextBytes,
      maxFileBytes: MAX_TEXT_ARTIFACT_BYTES,
      privatePathFindings,
      scope:
        'Loose text-like release files; binary and compressed payloads require separate exact-artifact scanning.',
    },
  };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function hashObject(algorithm, content) {
  return { alg: algorithm, content };
}

function componentProperty(name, value) {
  return { name: `app.htmllelujah.release:${name}`, value: String(value) };
}

function componentHashes(entry) {
  return entry ? [hashObject('SHA-256', entry.sha256)] : undefined;
}

function inventoryEntry(inventory, relativePath) {
  return inventory.find((entry) => entry.path.toLowerCase() === relativePath.toLowerCase());
}

function inspectAuthenticode(filePath) {
  if (process.platform !== 'win32') {
    return { status: 'NotChecked', reason: 'Authenticode inspection requires Windows.' };
  }
  const script = [
    '$signature = Get-AuthenticodeSignature -LiteralPath $env:HTMLLELUJAH_SIGNATURE_TARGET',
    '$result = [ordered]@{ status = $signature.Status.ToString(); signerSubject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }; signerThumbprint = if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { $null }; timestampSubject = if ($signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.Subject } else { $null } }',
    '$result | ConvertTo-Json -Compress',
  ].join('; ');
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      env: { ...process.env, HTMLLELUJAH_SIGNATURE_TARGET: filePath },
      timeout: 30_000,
      windowsHide: true,
    },
  );
  if (result.status !== 0 || !result.stdout) {
    return {
      status: 'CheckFailed',
      reason: `PowerShell Authenticode inspection exited with status ${result.status ?? 'unknown'}.`,
    };
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { status: 'CheckFailed', reason: 'PowerShell returned invalid JSON.' };
  }
}

function signingEvidence(artifactDir, inventory, installers) {
  const mainExecutable = inventoryEntry(inventory, 'win-unpacked/HTMLlelujah.exe');
  const targets = [...installers];
  if (mainExecutable) targets.push(mainExecutable);
  return targets.map((entry) => ({
    path: entry.path,
    sha256: entry.sha256,
    ...inspectAuthenticode(path.join(artifactDir, ...entry.path.split('/'))),
  }));
}

async function buildSbom({ inventory, installers, nativeRuntimeEvidence, repositoryUrl, version }) {
  const desktopPackagePath = path.join(REPO_ROOT, 'apps', 'desktop', 'package.json');
  const desktopPackage = await readJson(desktopPackagePath);
  const mainExecutable = inventoryEntry(inventory, 'win-unpacked/HTMLlelujah.exe');
  const components =
    nativeRuntimeEvidence === null ? [] : buildNativeRuntimeComponents(nativeRuntimeEvidence);
  const appHashes =
    installers.length > 0
      ? installers.map((entry) => hashObject('SHA-256', entry.sha256))
      : componentHashes(mainExecutable);

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: {
        components: [
          {
            type: 'application',
            name: 'HTMLlelujah release evidence generator',
            version: '1.0.0',
          },
        ],
      },
      component: {
        type: 'application',
        'bom-ref': `pkg:generic/htmllelujah@${version}`,
        name: desktopPackage.productName ?? 'HTMLlelujah',
        version,
        ...(appHashes ? { hashes: appHashes } : {}),
        externalReferences: [{ type: 'vcs', url: repositoryUrl }],
        properties: [
          componentProperty('inventory', 'content-inventory.json'),
          componentProperty(
            'artifact-kind',
            installers.length > 0
              ? 'NSIS installer and unpacked application'
              : 'unpacked application only',
          ),
          componentProperty(
            'native-runtime-inventory',
            nativeRuntimeEvidence === null ? 'incomplete' : 'complete',
          ),
        ],
      },
    },
    components,
  };
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!(await exists(options.artifactDir))) {
    throw new Error(`Artifact directory does not exist: ${options.artifactDir}`);
  }
  const artifactStat = await stat(options.artifactDir);
  if (!artifactStat.isDirectory()) {
    throw new Error(`Artifact path must be a directory: ${options.artifactDir}`);
  }
  const rootEntries = await readdir(options.artifactDir, { withFileTypes: true });
  const stagingDirectories = rootEntries
    .filter((entry) => entry.isDirectory() && /(?:\.tmp|\.partial|\.staging)$/i.test(entry.name))
    .map((entry) => entry.name);
  if (stagingDirectories.length > 0) {
    throw new Error(
      `Packaging staging directory detected (${stagingDirectories.join(', ')}); wait for packaging to finish and remove abandoned staging output.`,
    );
  }
  const unexpectedRootDirectories = rootEntries
    .filter((entry) => entry.isDirectory() && entry.name !== 'win-unpacked')
    .map((entry) => entry.name);
  if (unexpectedRootDirectories.length > 0) {
    throw new Error(
      `Unexpected artifact-root directories: ${unexpectedRootDirectories.join(', ')}.`,
    );
  }
  const outputRelativeToArtifact = path.relative(options.artifactDir, options.outputDir);
  if (!outputRelativeToArtifact.startsWith('..') && outputRelativeToArtifact !== '') {
    throw new Error('Output directory must not be nested inside the artifact directory.');
  }

  const desktopPackage = await readJson(path.join(REPO_ROOT, 'apps', 'desktop', 'package.json'));
  const version = options.version ?? desktopPackage.version;
  if (!version) throw new Error('A release version is required.');

  await mkdir(options.outputDir, { recursive: true });
  const files = await buildFileInventory(options.artifactDir, options.outputDir);
  const grouped = groupDeliverables(files);
  if (grouped.unpacked.length === 0 && grouped.installers.length === 0) {
    throw new Error('No win-unpacked directory or Windows installer was detected.');
  }
  const candidatePolicy = await validateCandidatePolicy({
    artifactDir: options.artifactDir,
    grouped,
    inventory: files,
    version,
  });
  const freshness = await artifactFreshness({
    artifactDir: options.artifactDir,
    installers: grouped.installers,
    inventory: files,
    repositoryRoot: REPO_ROOT,
  });
  const generatedAt = new Date().toISOString();
  const source = sourceProvenance(REPO_ROOT);
  let candidateManifest = null;
  if (await exists(options.candidateManifest)) {
    candidateManifest = await readJson(options.candidateManifest);
    assertCandidateManifest({
      manifest: candidateManifest,
      inventory: files,
      version,
      source,
    });
  } else if (options.requireCandidateManifest) {
    throw new Error(`Required candidate manifest does not exist: ${options.candidateManifest}`);
  }
  const codeSigning = signingEvidence(options.artifactDir, files, grouped.installers);
  const inventory = {
    schemaVersion: 1,
    generatedAt,
    artifactRoot: repositoryRelative(options.artifactDir),
    fileCount: files.length,
    totalSize: files.reduce((total, entry) => total + entry.size, 0),
    aggregateSha256: aggregateHash(files),
    deliverables: grouped.deliverables,
    files,
  };
  const checksums = files.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n') + '\n';
  let nativeRuntimeEvidence = null;
  let nativeRuntime = incompleteNativeRuntimeQuality();
  try {
    nativeRuntimeEvidence = await inspectNativeRuntimeEvidence({
      artifactDir: options.artifactDir,
      desktopPackage,
      installers: grouped.installers,
      inventory: files,
      lockfile: await readFile(path.join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8'),
    });
    nativeRuntime = nativeRuntimeQuality(nativeRuntimeEvidence);
  } catch {
    // Non-ready diagnostic evidence is still useful. Promotion remains fail-closed:
    // --require-ready requires the complete five-component inventory and all bindings.
  }
  const sbom = await buildSbom({
    installers: grouped.installers,
    inventory: files,
    nativeRuntimeEvidence,
    repositoryUrl: options.repositoryUrl,
    version,
  });

  const inventoryPath = path.join(options.outputDir, 'content-inventory.json');
  const checksumsPath = path.join(options.outputDir, 'checksums-sha256.txt');
  const sbomPath = path.join(options.outputDir, 'build-sbom.cdx.json');
  const candidateEvidencePath = path.join(options.outputDir, 'release-candidate-v1.json');
  await writeFile(inventoryPath, canonicalJson(inventory), 'utf8');
  await writeFile(checksumsPath, checksums, 'utf8');
  await writeFile(sbomPath, canonicalJson(sbom), 'utf8');
  if (candidateManifest !== null) {
    await writeFile(candidateEvidencePath, canonicalJson(candidateManifest), 'utf8');
  } else {
    await rm(candidateEvidencePath, { force: true });
  }

  const evidenceFiles = [];
  const evidencePaths = [inventoryPath, checksumsPath, sbomPath];
  if (candidateManifest !== null) evidencePaths.push(candidateEvidencePath);
  for (const evidencePath of evidencePaths) {
    const evidenceStat = await stat(evidencePath);
    evidenceFiles.push({
      path: path.basename(evidencePath),
      size: evidenceStat.size,
      sha256: await sha256(evidencePath),
    });
  }

  const installerPresent = grouped.installers.length > 0;
  const unpackedApplicationPresent = grouped.unpacked.length > 0;
  const manifest = {
    schemaVersion: 1,
    release: {
      product: 'HTMLlelujah',
      version,
      platform: 'win32',
      architecture: 'x64',
      generatedAt,
      repository: options.repositoryUrl,
      source,
    },
    artifact: {
      root: repositoryRelative(options.artifactDir),
      fileCount: files.length,
      totalSize: inventory.totalSize,
      aggregateSha256: inventory.aggregateSha256,
      deliverables: grouped.deliverables,
      codeSigning,
    },
    evidenceFiles,
    quality: {
      integrityEvidenceGenerated: true,
      installerPresent,
      unpackedApplicationPresent,
      stale: freshness.stale,
      cleanSource: source.dirty === false,
      candidateManifestPresent: candidateManifest !== null,
      nativeRuntime,
      releaseReady:
        installerPresent &&
        unpackedApplicationPresent &&
        candidateManifest !== null &&
        nativeRuntime.passed &&
        candidatePolicy.passed &&
        !freshness.stale &&
        source.dirty === false,
      freshness,
      candidatePolicy,
      limitations: [
        'This manifest is not a cryptographic signature or code-signing proof.',
        'The build SBOM supplements dependency SBOMs; it does not replace legal review of packaged notices.',
        ...(installerPresent
          ? []
          : ['No Windows installer was present; only the unpacked application was inventoried.']),
        ...(unpackedApplicationPresent
          ? []
          : ['No unpacked application was present; installed payload inspection was unavailable.']),
        ...(source.dirty === false
          ? []
          : ['The source worktree was dirty or its state could not be established.']),
        ...(candidateManifest !== null
          ? []
          : ['No validated pre-promotion release candidate manifest was supplied.']),
        ...(nativeRuntime.passed
          ? []
          : ['The required native runtime inventory or one of its bindings is incomplete.']),
      ],
    },
  };
  const manifestPath = path.join(options.outputDir, 'release-manifest.json');
  await writeFile(manifestPath, canonicalJson(manifest), 'utf8');

  console.log(`Inventoried ${files.length} files (${inventory.totalSize} bytes).`);
  console.log(`Artifact aggregate SHA-256: ${inventory.aggregateSha256}`);
  console.log(`Installer detected: ${installerPresent ? 'yes' : 'no'}`);
  console.log(`Artifact stale: ${freshness.stale ? 'yes' : 'no'}`);
  console.log(`Release ready by evidence policy: ${manifest.quality.releaseReady ? 'yes' : 'no'}`);
  console.log(`Evidence written to ${options.outputDir}`);

  if (options.requireFresh && freshness.stale) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(`Release evidence generation failed: ${error.message}`);
  process.exitCode = 1;
});
