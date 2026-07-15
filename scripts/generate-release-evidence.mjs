#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_ARTIFACT_DIR = path.join(REPO_ROOT, 'apps', 'desktop', 'out');
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, 'artifacts', 'release-evidence');

function usage() {
  return `Usage: node scripts/generate-release-evidence.mjs [options]

Options:
  --artifact-dir <path>   electron-builder output (default: apps/desktop/out)
  --output-dir <path>     evidence output (default: artifacts/release-evidence)
  --version <version>     release version (default: apps/desktop/package.json)
  --repository-url <url>  source repository recorded in the SBOM
  --require-fresh         fail after writing evidence when the artifact is stale
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
    outputDir: DEFAULT_OUTPUT_DIR,
    repositoryUrl: 'https://github.com/Nassau-1/htmllelujah',
    requireFresh: false,
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
    if (
      argument === '--artifact-dir' ||
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

const SOURCE_EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.smoke',
  'artifacts',
  'node_modules',
  'out',
  'coverage',
]);

async function latestSourceInput() {
  const roots = [
    path.join(REPO_ROOT, 'apps', 'desktop', 'src'),
    path.join(REPO_ROOT, 'apps', 'desktop', 'assets'),
    path.join(REPO_ROOT, 'apps', 'desktop', 'dist'),
    path.join(REPO_ROOT, 'apps', 'desktop', 'dist-electron'),
    path.join(REPO_ROOT, 'packages'),
  ];
  const standalone = [
    path.join(REPO_ROOT, 'package.json'),
    path.join(REPO_ROOT, 'pnpm-lock.yaml'),
    path.join(REPO_ROOT, 'pnpm-workspace.yaml'),
    path.join(REPO_ROOT, 'apps', 'desktop', 'package.json'),
    path.join(REPO_ROOT, 'apps', 'desktop', 'scripts', 'apply-fuses.mjs'),
    path.join(REPO_ROOT, 'apps', 'desktop', 'vite.config.ts'),
  ];
  let newest = { mtimeMs: 0, path: null };

  async function consider(filePath) {
    const fileStat = await stat(filePath);
    if (fileStat.mtimeMs > newest.mtimeMs) {
      newest = { mtimeMs: fileStat.mtimeMs, path: repositoryRelative(filePath) };
    }
  }

  async function visit(directory) {
    if (!(await exists(directory))) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && SOURCE_EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) await consider(fullPath);
    }
  }

  for (const root of roots) await visit(root);
  for (const filePath of standalone) if (await exists(filePath)) await consider(filePath);
  return newest;
}

async function artifactFreshness(artifactDir, inventory, installers) {
  const latestSource = await latestSourceInput();
  const preferredReferences =
    installers.length > 0
      ? installers
      : inventory.filter((entry) =>
          /(?:^|\/)win-unpacked\/resources\/app\.asar$/i.test(entry.path),
        );
  const artifactReferences =
    preferredReferences.length > 0
      ? preferredReferences
      : inventory.filter((entry) => /(?:^|\/)win-unpacked\/[^/]+\.exe$/i.test(entry.path));
  if (artifactReferences.length === 0) {
    throw new Error(
      'No installer, packaged app.asar, or unpacked executable freshness reference found.',
    );
  }
  let latestArtifact = { mtimeMs: 0, path: null };
  for (const entry of artifactReferences) {
    const filePath = path.join(artifactDir, ...entry.path.split('/'));
    const fileStat = await stat(filePath);
    if (fileStat.mtimeMs > latestArtifact.mtimeMs) {
      latestArtifact = { mtimeMs: fileStat.mtimeMs, path: entry.path };
    }
  }
  const stale = latestSource.mtimeMs > latestArtifact.mtimeMs + 1_000;
  return {
    stale,
    latestArtifact: {
      path: latestArtifact.path,
      modifiedAt: new Date(latestArtifact.mtimeMs).toISOString(),
    },
    latestSourceInput: {
      path: latestSource.path,
      modifiedAt: new Date(latestSource.mtimeMs).toISOString(),
    },
    reason: stale
      ? 'At least one release input is newer than the newest packaged artifact file.'
      : 'No tracked release input inspected by this tool is newer than the packaged artifact.',
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

function runGit(arguments_) {
  const result = spawnSync('git', arguments_, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function sourceProvenance() {
  const status = runGit(['status', '--porcelain=v1', '--untracked-files=normal']);
  const dirtyEntries = status ? status.split(/\r?\n/).filter(Boolean) : [];
  return {
    commit: runGit(['rev-parse', '--verify', 'HEAD']),
    branch: runGit(['branch', '--show-current']),
    exactTag: runGit(['describe', '--tags', '--exact-match', 'HEAD']),
    dirty: status === null ? null : dirtyEntries.length > 0,
    dirtyEntryCount: status === null ? null : dirtyEntries.length,
  };
}

function inventoryEntry(inventory, relativePath) {
  return inventory.find((entry) => entry.path.toLowerCase() === relativePath.toLowerCase());
}

function detectElectronRuntimeVersions(electronPackageDirectory) {
  const executable =
    process.platform === 'win32'
      ? path.join(electronPackageDirectory, 'dist', 'electron.exe')
      : path.join(electronPackageDirectory, 'dist', 'electron');
  if (!spawnSync || !executable) return null;
  const result = spawnSync(
    executable,
    ['-e', 'process.stdout.write(JSON.stringify(process.versions))'],
    {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 15_000,
      windowsHide: true,
    },
  );
  if (result.status !== 0 || !result.stdout) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

async function compareElectronPayload(artifactDir, inventory, electronPackageDirectory) {
  const comparisons = [];
  for (const name of ['ffmpeg.dll', 'icudtl.dat', 'resources.pak']) {
    const packaged = inventoryEntry(inventory, `win-unpacked/${name}`);
    const toolchainPath = path.join(electronPackageDirectory, 'dist', name);
    if (!packaged || !(await exists(toolchainPath))) continue;
    comparisons.push({
      path: `win-unpacked/${name}`,
      sha256: packaged.sha256,
      matchesElectronToolchain: packaged.sha256 === (await sha256(toolchainPath)),
    });
  }
  return comparisons;
}

async function detectNsis(installerEntries) {
  if (installerEntries.length === 0) return null;
  const cacheRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'nsis')
    : null;
  let candidates = [];
  if (cacheRoot && (await exists(cacheRoot))) {
    candidates = (await readdir(cacheRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^nsis-/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, 'en'));
  }
  const selected = candidates.at(-1);
  return {
    version: selected?.replace(/^nsis-/i, '') ?? null,
    evidence: selected
      ? `electron-builder local tool cache ${selected}`
      : 'installer filename and electron-builder NSIS target; tool version unavailable',
  };
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

async function buildSbom({ artifactDir, inventory, installers, repositoryUrl, version }) {
  const desktopPackagePath = path.join(REPO_ROOT, 'apps', 'desktop', 'package.json');
  const desktopPackage = await readJson(desktopPackagePath);
  const electronPackageDirectory = path.join(
    REPO_ROOT,
    'apps',
    'desktop',
    'node_modules',
    'electron',
  );
  const electronPackagePath = path.join(electronPackageDirectory, 'package.json');
  const electronPackage = (await exists(electronPackagePath))
    ? await readJson(electronPackagePath)
    : null;
  const runtimeVersions = electronPackage
    ? detectElectronRuntimeVersions(electronPackageDirectory)
    : null;
  const payloadComparisons = electronPackage
    ? await compareElectronPayload(artifactDir, inventory, electronPackageDirectory)
    : [];
  const payloadBinding = payloadComparisons.some((item) => item.matchesElectronToolchain);
  const mainExecutable = inventoryEntry(inventory, 'win-unpacked/HTMLlelujah.exe');
  const ffmpeg = inventoryEntry(inventory, 'win-unpacked/ffmpeg.dll');
  const chromiumNotice = inventoryEntry(inventory, 'win-unpacked/LICENSES.chromium.html');
  const nsis = await detectNsis(installers);
  const components = [];

  if (electronPackage && mainExecutable) {
    const electronReference = payloadBinding
      ? `pkg:npm/electron@${electronPackage.version}`
      : `htmllelujah:embedded:electron:${mainExecutable.sha256}`;
    components.push({
      type: 'framework',
      'bom-ref': electronReference,
      group: 'Electron',
      name: 'Electron',
      ...(payloadBinding ? { version: electronPackage.version } : {}),
      ...(payloadBinding ? { purl: `pkg:npm/electron@${electronPackage.version}` } : {}),
      licenses: [{ license: { id: 'MIT' } }],
      properties: [
        componentProperty('evidence', 'packaged Electron executable and LICENSE.electron.txt'),
        componentProperty(
          'toolchain-payload-binding',
          payloadBinding ? 'at least one embedded payload hash matched' : 'not established',
        ),
        ...payloadComparisons.map((item) =>
          componentProperty(`payload.${item.path}.matches`, item.matchesElectronToolchain),
        ),
      ],
    });
  }

  if (payloadBinding && runtimeVersions?.chrome && chromiumNotice) {
    components.push({
      type: 'framework',
      'bom-ref': `pkg:generic/chromium@${runtimeVersions.chrome}`,
      group: 'Chromium',
      name: 'Chromium',
      version: runtimeVersions.chrome,
      purl: `pkg:generic/chromium@${runtimeVersions.chrome}`,
      properties: [
        componentProperty('evidence', 'Electron toolchain process.versions.chrome'),
        componentProperty('license-notice-path', 'win-unpacked/LICENSES.chromium.html'),
      ],
    });
  }

  if (payloadBinding && runtimeVersions?.node && mainExecutable) {
    components.push({
      type: 'framework',
      'bom-ref': `pkg:generic/node.js@${runtimeVersions.node}`,
      name: 'Node.js embedded in Electron',
      version: runtimeVersions.node,
      purl: `pkg:generic/node.js@${runtimeVersions.node}`,
      properties: [componentProperty('evidence', 'Electron toolchain process.versions.node')],
    });
  }

  if (ffmpeg) {
    components.push({
      type: 'library',
      'bom-ref': `htmllelujah:embedded:ffmpeg:${ffmpeg.sha256}`,
      group: 'FFmpeg',
      name: 'FFmpeg (Electron Chromium build)',
      hashes: componentHashes(ffmpeg),
      licenses: [{ expression: 'LGPL-2.1-or-later' }],
      properties: [
        componentProperty('evidence-path', 'win-unpacked/ffmpeg.dll'),
        componentProperty(
          'version-status',
          'not exposed by the packaged DLL; governed by the matching Electron build',
        ),
        componentProperty(
          'license-evidence',
          'FFmpeg entry in packaged LICENSES.chromium.html; build options must be reviewed separately',
        ),
      ],
    });
  }

  if (nsis) {
    const refVersion = nsis.version ?? 'undetected';
    components.push({
      type: 'application',
      'bom-ref': `pkg:generic/nsis@${refVersion}`,
      name: 'Nullsoft Scriptable Install System',
      ...(nsis.version ? { version: nsis.version } : {}),
      ...(nsis.version ? { purl: `pkg:generic/nsis@${nsis.version}` } : {}),
      licenses: [{ license: { id: 'Zlib' } }],
      properties: [
        componentProperty('evidence', nsis.evidence),
        componentProperty('installer-count', installers.length),
      ],
    });
  }

  components.sort((left, right) => left['bom-ref'].localeCompare(right['bom-ref'], 'en'));
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
  const freshness = await artifactFreshness(options.artifactDir, files, grouped.installers);
  const generatedAt = new Date().toISOString();
  const source = sourceProvenance();
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
  const sbom = await buildSbom({
    artifactDir: options.artifactDir,
    installers: grouped.installers,
    inventory: files,
    repositoryUrl: options.repositoryUrl,
    version,
  });

  const inventoryPath = path.join(options.outputDir, 'content-inventory.json');
  const checksumsPath = path.join(options.outputDir, 'checksums-sha256.txt');
  const sbomPath = path.join(options.outputDir, 'build-sbom.cdx.json');
  await writeFile(inventoryPath, canonicalJson(inventory), 'utf8');
  await writeFile(checksumsPath, checksums, 'utf8');
  await writeFile(sbomPath, canonicalJson(sbom), 'utf8');

  const evidenceFiles = [];
  for (const evidencePath of [inventoryPath, checksumsPath, sbomPath]) {
    const evidenceStat = await stat(evidencePath);
    evidenceFiles.push({
      path: path.basename(evidencePath),
      size: evidenceStat.size,
      sha256: await sha256(evidencePath),
    });
  }

  const installerPresent = grouped.installers.length > 0;
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
      stale: freshness.stale,
      cleanSource: source.dirty === false,
      releaseReady: installerPresent && !freshness.stale && source.dirty === false,
      freshness,
      limitations: [
        'This manifest is not a cryptographic signature or code-signing proof.',
        'The build SBOM supplements dependency SBOMs; it does not replace legal review of packaged notices.',
        ...(installerPresent
          ? []
          : ['No Windows installer was present; only the unpacked application was inventoried.']),
        ...(source.dirty === false
          ? []
          : ['The source worktree was dirty or its state could not be established.']),
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
