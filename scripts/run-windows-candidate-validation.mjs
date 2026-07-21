#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { release as operatingSystemRelease, version as operatingSystemVersion } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildDirectoryInventory,
  regularFileIdentity,
  sha256File,
} from '../apps/desktop/scripts/build-provenance-support.mjs';
import { UI_SMOKE_TIMEOUT_MS } from '../apps/desktop/scripts/ui-smoke-performance.mjs';
import { assertCandidateManifest } from './release-candidate-manifest.mjs';
import { captureSourceSnapshot, gitSourceState } from './release-source-state.mjs';
import {
  acquireReleaseLock,
  assertReleaseLockHeld,
  releaseReleaseLock,
  resolveCorepackInvocation,
} from './windows-release-pipeline-support.mjs';
import {
  DEFAULT_LAN_DURATION_MS,
  FUNCTIONAL_VALIDATION_BUNDLE_NAME,
  FUNCTIONAL_VALIDATION_FILE_NAME,
  REQUIRED_FUNCTIONAL_GATES,
  assertFunctionalValidationManifest,
  buildFunctionalValidationManifest,
  buildPublicValidationEnvironment,
  candidateTargetIdentity,
  createPublicEvidenceZip,
  expectedGateScope,
  expectedGateThresholdRecords,
  expectedPublicGateInvocation,
  publicEvidenceJsonErrors,
  publicPngErrors,
  sha256Bytes,
} from './windows-candidate-validation-support.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = path.resolve(scriptDirectory, '..');

// `pnpm verify` intentionally repeats the full release-pipeline suite and the local license
// inventory. The latter alone can take several minutes on Windows, so this gate needs enough
// headroom for a busy but healthy release machine while remaining strictly bounded.
export const SOURCE_VERIFY_TIMEOUT_MS = 60 * 60_000;

const usage = () => `Usage: node scripts/run-windows-candidate-validation.mjs [options]

Runs the V1 matrix bound to the exact promoted candidate. Packaged gates target the unpacked or
installed application; explicitly scoped benchmark and LAN gates execute source harnesses.

Options:
  --lan-minutes <number>  loopback LAN soak duration; values below 30 fail release readiness
  --help                  show this help`;

export const parseCandidateValidationArgs = (argv) => {
  const options = { lanMinutes: 30 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') return { ...options, help: true };
    if (argument === '--lan-minutes') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--lan-minutes requires a numeric value.');
      }
      options.lanMinutes = Number(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown candidate validation option: ${argument}.`);
  }
  if (!Number.isFinite(options.lanMinutes) || options.lanMinutes <= 0) {
    throw new Error('--lan-minutes must be a finite positive number.');
  }
  return options;
};

const exists = async (filePath) => {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
};

const normalizePath = (value) => value.split(path.sep).join('/');

const assertContainedFile = (root, filePath, label) => {
  const relation = path.relative(path.resolve(root), path.resolve(filePath));
  if (relation === '' || relation.startsWith('..') || path.isAbsolute(relation)) {
    throw new Error(`${label} escaped its owned directory.`);
  }
};

const assertPlainDirectorySegments = async (
  repositoryRoot,
  target,
  { allowMissingFinal = false } = {},
) => {
  const resolvedRoot = path.resolve(repositoryRoot);
  const resolvedTarget = path.resolve(target);
  const relation = path.relative(resolvedRoot, resolvedTarget);
  if (relation.startsWith('..') || path.isAbsolute(relation)) {
    throw new Error('Candidate validation directory escaped the repository.');
  }
  const segments = relation === '' ? [] : relation.split(path.sep);
  let current = resolvedRoot;
  for (const [index, segment] of ['', ...segments].entries()) {
    if (segment !== '') current = path.join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      const isFinal = index === segments.length;
      if (allowMissingFinal && isFinal && error?.code === 'ENOENT') return;
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(
        `Candidate validation directory is a reparse point or not plain: ${current}.`,
      );
    }
  }
};

const assertRegularOutputOrMissing = async (filePath) => {
  try {
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
      throw new Error(`Candidate validation output is not a plain regular file: ${filePath}.`);
    }
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
};

const syncDirectoryMetadata = async (directory) => {
  let handle;
  try {
    handle = await open(directory, process.platform === 'win32' ? 'r+' : 'r');
    await handle.sync();
  } finally {
    await handle?.close();
  }
};

const removeDeclaredOutput = async (filePath) => {
  if (!(await assertRegularOutputOrMissing(filePath))) return;
  await rm(filePath, { force: true });
  await syncDirectoryMetadata(path.dirname(filePath));
};

export const createCandidateHarnessEnvironment = (source = process.env) => {
  const allow = new Set([
    'ALLUSERSPROFILE',
    'APPDATA',
    'COMSPEC',
    'COREPACK_HOME',
    'HOMEDRIVE',
    'HOMEPATH',
    'LANG',
    'LC_ALL',
    'LOCALAPPDATA',
    'NUMBER_OF_PROCESSORS',
    'OS',
    'PATH',
    'PATHEXT',
    'PNPM_HOME',
    'PROCESSOR_ARCHITECTURE',
    'PROCESSOR_IDENTIFIER',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMW6432',
    'PSMODULEPATH',
    'SYSTEMDRIVE',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'TZ',
    'USERDOMAIN',
    'USERNAME',
    'USERPROFILE',
    'WINDIR',
  ]);
  const environment = {};
  for (const [key, value] of Object.entries(source)) {
    if (allow.has(key.toUpperCase()) && typeof value === 'string') environment[key] = value;
  }
  return {
    ...environment,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    COREPACK_ENABLE_NETWORK: '0',
    npm_config_offline: 'true',
  };
};

const terminateProcessTree = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 15_000,
    });
  } else {
    child.kill('SIGKILL');
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error(
      `Validation process tree rooted at PID ${child.pid} remained alive after termination.`,
    );
  }
};

export const runValidationCommand = ({ command, args, cwd, env, timeoutMs, label }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: 'inherit',
      windowsHide: true,
    });
    let settled = false;
    let timedOut = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      const timeoutError = new Error(`${label} exceeded its ${timeoutMs} ms timeout.`);
      void terminateProcessTree(child).then(
        () => finish(timeoutError),
        (cleanupError) =>
          finish(
            new AggregateError(
              [timeoutError, cleanupError],
              `${label} timed out and its process tree could not be drained.`,
            ),
          ),
      );
    }, timeoutMs);
    child.once('error', (error) => {
      if (!timedOut) finish(error);
    });
    child.once('exit', (code, signal) => {
      if (timedOut) return;
      if (code === 0 && signal === null) finish();
      else finish(new Error(`${label} exited with ${signal ?? code ?? 'unknown status'}.`));
    });
  });

const output = (evidenceDirectory, originalName, role) => ({
  sourcePath: path.join(evidenceDirectory, originalName),
  originalName,
  role,
});

export const normalizedPublicInvocation = ({
  gate,
  executable,
  launcher,
  installer,
  evidenceDirectory,
}) => {
  const replaceValue = (value) => {
    if (value === executable) return '<candidate-executable>';
    if (value === launcher) return '<candidate-launcher>';
    if (value === installer) return '<candidate-installer>';
    if (path.isAbsolute(value)) {
      const evidenceRelation = path.relative(evidenceDirectory, value);
      if (
        evidenceRelation !== '' &&
        !evidenceRelation.startsWith('..') &&
        !path.isAbsolute(evidenceRelation)
      ) {
        return '<gate-evidence-report>';
      }
    }
    return normalizePath(value);
  };
  return {
    commandId: gate.usesCorepack ? 'corepack-pnpm' : 'node',
    argv: (gate.usesCorepack ? gate.args.slice(gate.corepackArgsPrefixLength) : gate.args).map(
      replaceValue,
    ),
    environment: Object.entries(gate.env)
      .map(([key, value]) => `${key}=${replaceValue(value)}`)
      .sort((left, right) => left.localeCompare(right, 'en')),
  };
};

export const buildCandidateValidationPlan = ({
  repositoryRoot,
  executable,
  launcher,
  installer,
  evidenceDirectory,
  lanMinutes,
}) => {
  const node = process.execPath;
  const corepack = resolveCorepackInvocation();
  const throughCorepack = (args) => ({
    command: corepack.command,
    args: [...corepack.argsPrefix, ...args],
    usesCorepack: true,
    corepackArgsPrefixLength: corepack.argsPrefix.length,
  });
  const desktopScript = (name) => path.join('apps', 'desktop', 'scripts', name);
  const commonEnv = {
    HTMLLELUJAH_EXECUTABLE: executable,
  };
  const exportGate = (id, preset) => ({
    id,
    command: node,
    args: [desktopScript('smoke-system-exports-windows.mjs')],
    env: { ...commonEnv, HTMLLELUJAH_EXPORT_PAGE_PRESET: preset },
    timeoutMs: 8 * 60_000,
    outputs: [
      output(evidenceDirectory, `system-exports-v1-${preset}.json`, 'report'),
      output(evidenceDirectory, `v1-standalone-html-${preset}.png`, 'screenshot'),
      output(evidenceDirectory, `v1-pdf-${preset}.png`, 'screenshot'),
    ],
  });
  return [
    {
      id: 'source-verify',
      ...throughCorepack(['pnpm', 'verify']),
      env: {},
      timeoutMs: SOURCE_VERIFY_TIMEOUT_MS,
      outputs: [],
      syntheticReceipt: true,
    },
    {
      id: 'ui-packaged',
      command: node,
      args: [desktopScript('smoke-ui-electron.mjs')],
      env: commonEnv,
      timeoutMs: UI_SMOKE_TIMEOUT_MS,
      outputs: [
        output(evidenceDirectory, 'v1-editor-electron.json', 'report'),
        output(evidenceDirectory, 'v1-editor-electron.png', 'screenshot'),
        output(evidenceDirectory, 'v1-presentation-electron.png', 'screenshot'),
      ],
    },
    exportGate('exports-widescreen', 'widescreen'),
    exportGate('exports-standard', 'standard'),
    exportGate('exports-a4-landscape', 'a4-landscape'),
    {
      id: 'exports-stress-50',
      command: node,
      args: [desktopScript('smoke-system-exports-windows.mjs'), '--stress-count', '50'],
      env: { ...commonEnv, HTMLLELUJAH_EXPORT_PAGE_PRESET: 'widescreen' },
      timeoutMs: 25 * 60_000,
      outputs: [output(evidenceDirectory, 'system-exports-v1-stress-widescreen.json', 'report')],
    },
    {
      id: 'mcp-packaged',
      command: node,
      args: [desktopScript('smoke-mcp-electron.mjs')],
      env: {
        ...commonEnv,
        HTMLLELUJAH_MCP_LAUNCHER: launcher,
        HTMLLELUJAH_MCP_EVIDENCE: path.join(evidenceDirectory, 'mcp-v1.json'),
      },
      timeoutMs: 8 * 60_000,
      outputs: [output(evidenceDirectory, 'mcp-v1.json', 'report')],
    },
    {
      id: 'accessibility-scaling',
      command: node,
      args: [desktopScript('smoke-accessibility-scaling-windows.mjs')],
      env: { ...commonEnv, HTMLLELUJAH_SCALE_FACTORS: '1,1.25,1.5,2' },
      timeoutMs: 15 * 60_000,
      outputs: [
        output(evidenceDirectory, 'v1-accessibility-scaling.json', 'report'),
        ...['100', '125', '150', '200'].map((factor) =>
          output(evidenceDirectory, `v1-accessibility-scale-${factor}.png`, 'screenshot'),
        ),
      ],
    },
    {
      id: 'text-lock-two-process',
      command: node,
      args: [desktopScript('smoke-text-lock-ui-system.mjs')],
      env: commonEnv,
      timeoutMs: 10 * 60_000,
      outputs: [
        output(evidenceDirectory, 'text-lock-ui-system-v1.json', 'report'),
        output(evidenceDirectory, 'text-lock-host-owned-v1.png', 'screenshot'),
        output(evidenceDirectory, 'text-lock-guest-blocked-v1.png', 'screenshot'),
        output(evidenceDirectory, 'text-lock-guest-owned-v1.png', 'screenshot'),
      ],
    },
    {
      id: 'single-instance-final-artifact',
      command: node,
      args: [desktopScript('smoke-single-instance-windows.mjs'), installer, '--final-artifact'],
      env: {},
      timeoutMs: 12 * 60_000,
      outputs: [output(evidenceDirectory, 'single-instance-windows-v1.json', 'report')],
    },
    {
      id: 'installer-lifecycle',
      command: node,
      args: [desktopScript('smoke-installer-windows.mjs'), installer, '--final-artifact'],
      env: {},
      timeoutMs: 25 * 60_000,
      outputs: [
        output(evidenceDirectory, 'installer-v1.json', 'report'),
        output(evidenceDirectory, 'v1-editor-electron.json', 'installed-ui-report'),
        output(evidenceDirectory, 'v1-editor-electron.png', 'installed-ui-screenshot'),
        output(evidenceDirectory, 'v1-presentation-electron.png', 'installed-ui-screenshot'),
        output(evidenceDirectory, 'mcp-v1.json', 'installed-mcp-report'),
      ],
    },
    {
      id: 'benchmark-core',
      ...throughCorepack([
        'pnpm',
        'exec',
        'tsx',
        desktopScript('benchmark-v1.ts'),
        '--output',
        path.join(evidenceDirectory, 'benchmark-v1.json'),
      ]),
      env: {},
      timeoutMs: 12 * 60_000,
      outputs: [output(evidenceDirectory, 'benchmark-v1.json', 'report')],
    },
    {
      id: 'benchmark-capacity-presentation',
      ...throughCorepack([
        'pnpm',
        'exec',
        'tsx',
        desktopScript('benchmark-capacity-presentation-v1.ts'),
        '--output',
        path.join(evidenceDirectory, 'benchmark-capacity-presentation-v1.json'),
      ]),
      env: {},
      timeoutMs: 15 * 60_000,
      outputs: [output(evidenceDirectory, 'benchmark-capacity-presentation-v1.json', 'report')],
    },
    {
      id: 'benchmark-expanded-limit',
      ...throughCorepack(['pnpm', 'exec', 'tsx', desktopScript('benchmark-expanded-limit-v1.ts')]),
      env: {},
      timeoutMs: 25 * 60_000,
      outputs: [output(evidenceDirectory, 'expanded-limit-benchmark-v1.json', 'report')],
    },
    {
      id: 'lan-loopback-soak',
      ...throughCorepack([
        'pnpm',
        'exec',
        'tsx',
        desktopScript('lan-soak-v1.ts'),
        '--minutes',
        String(lanMinutes),
        '--report',
        path.join(evidenceDirectory, 'lan-soak-v1.json'),
      ]),
      env: {},
      timeoutMs: Math.ceil(lanMinutes * 60_000) + 12 * 60_000,
      outputs: [output(evidenceDirectory, 'lan-soak-v1.json', 'report')],
    },
  ].map((gate) => ({ ...gate, cwd: repositoryRoot }));
};

const criticalSnapshot = async (artifactDir, candidate, dependencies) => {
  const expected = candidateTargetIdentity(candidate);
  const entries = [];
  for (const candidateEntry of [
    expected.installer,
    expected.blockmap,
    expected.executable,
    expected.launcher,
    expected.appAsar,
  ]) {
    const absolutePath = path.join(artifactDir, ...candidateEntry.path.split('/'));
    const before = await lstat(absolutePath);
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
      throw new Error(
        `Critical candidate artifact is a reparse point or hardlink: ${candidateEntry.path}.`,
      );
    }
    const identity = await dependencies.regularFileIdentity(absolutePath);
    const after = await lstat(absolutePath);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.nlink !== 1 ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      (before.ino !== 0 && after.ino !== before.ino) ||
      (before.dev !== 0 && after.dev !== before.dev)
    ) {
      throw new Error(
        `Critical candidate artifact changed while inspected: ${candidateEntry.path}.`,
      );
    }
    if (identity.sha256 !== candidateEntry.sha256 || identity.size !== candidateEntry.size) {
      throw new Error(`Critical candidate artifact changed: ${candidateEntry.path}.`);
    }
    entries.push(candidateEntry);
  }
  return candidateTargetIdentity(candidate).criticalAggregateSha256;
};

const validateCandidateState = async (
  { repositoryRoot, artifactDir, candidatePath },
  dependencies,
) => {
  const source = await dependencies.captureSourceSnapshot(repositoryRoot, { requireClean: true });
  const desktopPackage = JSON.parse(
    await readFile(path.join(repositoryRoot, 'apps', 'desktop', 'package.json'), 'utf8'),
  );
  const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const candidateMetadata = await lstat(candidatePath);
  if (
    candidateMetadata.isSymbolicLink() ||
    !candidateMetadata.isFile() ||
    candidateMetadata.nlink !== 1
  ) {
    throw new Error('Candidate manifest must be a regular non-link file.');
  }
  const candidateBytes = await readFile(candidatePath);
  const candidate = JSON.parse(candidateBytes.toString('utf8'));
  const inventory = await dependencies.buildDirectoryInventory(artifactDir);
  assertCandidateManifest({
    manifest: candidate,
    inventory: inventory.files,
    version: desktopPackage.version,
    source,
  });
  const lockfile = await dependencies.regularFileIdentity(
    path.join(repositoryRoot, 'pnpm-lock.yaml'),
  );
  if (
    source.tree.sha256 !== candidate.source.treeSha256 ||
    source.tree.fileCount !== candidate.source.fileCount ||
    source.tree.bytes !== candidate.source.bytes ||
    lockfile.sha256 !== candidate.lockfile.sha256
  ) {
    throw new Error('Candidate source tree or lockfile does not match the clean worktree.');
  }
  await criticalSnapshot(artifactDir, candidate, dependencies);
  return {
    source,
    candidate,
    candidateSha256: sha256Bytes(candidateBytes),
    candidateSize: candidateBytes.length,
    lockfileSha256: lockfile.sha256,
    inventory,
    packageManager: rootPackage.packageManager,
  };
};

const evidenceDirectorySnapshot = async (directory, dependencies) => {
  if (!(await exists(directory))) return new Map();
  const snapshot = new Map();
  const visit = async (current) => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const metadata = await lstat(fullPath);
      if (metadata.isSymbolicLink()) throw new Error('Evidence directory contains a symlink.');
      if (metadata.isDirectory()) {
        snapshot.set(normalizePath(path.relative(directory, fullPath)), { kind: 'directory' });
        await visit(fullPath);
      } else if (metadata.isFile()) {
        if (metadata.nlink !== 1) throw new Error('Evidence directory contains a hardlink.');
        snapshot.set(normalizePath(path.relative(directory, fullPath)), {
          kind: 'file',
          size: metadata.size,
          sha256: await dependencies.sha256File(fullPath),
        });
      } else throw new Error('Evidence directory contains an unsupported filesystem entry.');
    }
  };
  await visit(directory);
  return snapshot;
};

const assertOnlyDeclaredOutputsChanged = (before, after, outputs, evidenceDirectory) => {
  const allowed = new Set(
    outputs.map((entry) => normalizePath(path.relative(evidenceDirectory, entry.sourcePath))),
  );
  for (const [entryPath, identity] of before) {
    if (!jsonEqual(identity, after.get(entryPath))) {
      throw new Error(`Harness changed undeclared evidence output: ${entryPath}.`);
    }
  }
  for (const entryPath of after.keys()) {
    if (!before.has(entryPath) && !allowed.has(entryPath)) {
      throw new Error(`Harness created undeclared evidence output: ${entryPath}.`);
    }
  }
};

const removeEvidenceFilesCreatedAfterSnapshot = async (before, evidenceDirectory, dependencies) => {
  const afterFailure = await evidenceDirectorySnapshot(evidenceDirectory, dependencies);
  const newEntries = [...afterFailure]
    .filter(([entryPath]) => !before.has(entryPath))
    .sort(([leftPath, left], [rightPath, right]) => {
      const depthDifference = rightPath.split('/').length - leftPath.split('/').length;
      if (depthDifference !== 0) return depthDifference;
      if (left.kind !== right.kind) return left.kind === 'file' ? -1 : 1;
      return rightPath.localeCompare(leftPath, 'en');
    });
  for (const [entryPath, identity] of newEntries) {
    const absolutePath = path.join(evidenceDirectory, ...entryPath.split('/'));
    assertContainedFile(evidenceDirectory, absolutePath, 'Failed harness output');
    if (identity.kind === 'file') await removeDeclaredOutput(absolutePath);
    else {
      await rmdir(absolutePath);
      await syncDirectoryMetadata(path.dirname(absolutePath));
    }
  }
  const confirmation = await evidenceDirectorySnapshot(evidenceDirectory, dependencies);
  if (
    confirmation.size !== before.size ||
    [...before].some(([entryPath, identity]) => !jsonEqual(confirmation.get(entryPath), identity))
  ) {
    throw new Error(
      'Failed harness changed pre-existing evidence and it cannot be restored safely.',
    );
  }
};

const jsonEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const collectOutput = async ({ outputDescriptor, destinationPath, gateId, startedAtMs }) => {
  const before = await lstat(outputDescriptor.sourcePath);
  if (before.isSymbolicLink() || !before.isFile() || before.size === 0 || before.nlink !== 1) {
    throw new Error(
      `${gateId} produced an unsafe or empty output: ${outputDescriptor.originalName}.`,
    );
  }
  if (before.mtimeMs < startedAtMs - 2_000) {
    throw new Error(`${gateId} produced a stale output: ${outputDescriptor.originalName}.`);
  }
  let sourceHandle;
  let bytes;
  let opened;
  try {
    sourceHandle = await open(outputDescriptor.sourcePath, 'r');
    opened = await sourceHandle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      before.size !== opened.size ||
      before.mtimeMs !== opened.mtimeMs
    ) {
      throw new Error(`${gateId} output changed before it was collected.`);
    }
    bytes = await sourceHandle.readFile();
    const afterRead = await sourceHandle.stat();
    if (
      !afterRead.isFile() ||
      afterRead.nlink !== 1 ||
      opened.dev !== afterRead.dev ||
      opened.ino !== afterRead.ino ||
      opened.size !== afterRead.size ||
      opened.mtimeMs !== afterRead.mtimeMs
    ) {
      throw new Error(`${gateId} output changed while it was collected.`);
    }
  } finally {
    await sourceHandle?.close();
  }
  const after = await lstat(outputDescriptor.sourcePath);
  if (
    after.isSymbolicLink() ||
    !after.isFile() ||
    after.nlink !== 1 ||
    opened.dev !== after.dev ||
    opened.ino !== after.ino ||
    opened.size !== after.size ||
    opened.mtimeMs !== after.mtimeMs
  ) {
    throw new Error(`${gateId} output changed while it was collected.`);
  }
  const safetyErrors = outputDescriptor.role.includes('screenshot')
    ? publicPngErrors(bytes)
    : publicEvidenceJsonErrors(bytes);
  if (safetyErrors.length > 0) {
    throw new Error(`${gateId} output is not public-safe: ${safetyErrors.join('; ')}.`);
  }
  await rename(outputDescriptor.sourcePath, destinationPath);
  await syncDirectoryMetadata(path.dirname(outputDescriptor.sourcePath));
  if (path.dirname(destinationPath) !== path.dirname(outputDescriptor.sourcePath)) {
    await syncDirectoryMetadata(path.dirname(destinationPath));
  }
  const moved = await lstat(destinationPath);
  if (
    moved.isSymbolicLink() ||
    !moved.isFile() ||
    moved.nlink !== 1 ||
    opened.dev !== moved.dev ||
    opened.ino !== moved.ino ||
    opened.size !== moved.size ||
    opened.mtimeMs !== moved.mtimeMs
  ) {
    throw new Error(`${gateId} output changed while it was moved into the evidence bundle.`);
  }
  return {
    path: path.basename(destinationPath),
    originalName: outputDescriptor.originalName,
    role: outputDescriptor.role,
    gateId,
    bytes,
  };
};

const recordedThresholds = (gateId, collected) => {
  const reportEntry = collected.find((entry) => entry.role === 'report');
  if (reportEntry === undefined) return [];
  const report = JSON.parse(Buffer.from(reportEntry?.bytes ?? []).toString('utf8'));
  return expectedGateThresholdRecords(gateId, report);
};

const atomicWrite = async (target, bytes) => {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    handle = await open(target, 'r+');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectoryMetadata(path.dirname(target));
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
};

const defaultDependencies = {
  platform: process.platform,
  architecture: process.arch,
  now: () => new Date(),
  monotonicNow: () => performance.now(),
  runCommand: runValidationCommand,
  assertReleaseLockHeld,
  captureSourceSnapshot,
  gitSourceState,
  buildDirectoryInventory,
  regularFileIdentity,
  sha256File,
  operatingSystemRelease,
  operatingSystemVersion,
};

export const runWindowsCandidateValidation = async (options, injected = {}) => {
  const dependencies = { ...defaultDependencies, ...injected };
  const repositoryRoot = path.resolve(options.repositoryRoot ?? defaultRepositoryRoot);
  const artifactDir = path.join(repositoryRoot, 'apps', 'desktop', 'out');
  const candidatePath = path.join(
    repositoryRoot,
    'artifacts',
    'release-evidence',
    'release-candidate-v1.json',
  );
  const outputDirectory = path.dirname(candidatePath);
  const finalManifestPath = path.join(outputDirectory, FUNCTIONAL_VALIDATION_FILE_NAME);
  const finalBundlePath = path.join(outputDirectory, FUNCTIONAL_VALIDATION_BUNDLE_NAME);
  const evidenceDirectory = path.join(repositoryRoot, 'artifacts', 'evidence');
  const temporaryParent = path.join(repositoryRoot, 'artifacts');
  const temporaryRoot = path.join(temporaryParent, `.candidate-validation-${randomUUID()}`);
  const lanMinutes = options.lanMinutes ?? 30;
  const minimumLanDurationMs = options.minimumLanDurationMs ?? DEFAULT_LAN_DURATION_MS;

  if (dependencies.platform !== 'win32' || dependencies.architecture !== 'x64') {
    throw new Error('Functional V1 candidate validation requires Windows x64.');
  }
  if (!options.releaseLock) throw new Error('An existing shared release lock is required.');
  if (!Number.isFinite(lanMinutes) || lanMinutes <= 0) throw new Error('LAN duration is invalid.');
  await dependencies.assertReleaseLockHeld({ releaseLock: options.releaseLock });
  await assertPlainDirectorySegments(repositoryRoot, repositoryRoot);
  await assertPlainDirectorySegments(repositoryRoot, artifactDir);
  await assertPlainDirectorySegments(repositoryRoot, outputDirectory);
  await assertPlainDirectorySegments(repositoryRoot, temporaryParent);
  await assertPlainDirectorySegments(repositoryRoot, evidenceDirectory, {
    allowMissingFinal: true,
  });
  await assertRegularOutputOrMissing(finalManifestPath);
  await assertRegularOutputOrMissing(finalBundlePath);
  await mkdir(outputDirectory, { recursive: true });
  await mkdir(evidenceDirectory, { recursive: true });
  await removeDeclaredOutput(finalManifestPath);
  await removeDeclaredOutput(finalBundlePath);
  await mkdir(temporaryParent, { recursive: true });
  await mkdir(temporaryRoot, { recursive: false });
  await assertPlainDirectorySegments(repositoryRoot, evidenceDirectory);
  await assertPlainDirectorySegments(repositoryRoot, temporaryRoot);

  let pendingPublication;
  let executionError;
  let evidenceBaseline;
  const allDeclaredSources = [];
  try {
    await dependencies.assertReleaseLockHeld({ releaseLock: options.releaseLock });
    const initial = await validateCandidateState(
      { repositoryRoot, artifactDir, candidatePath },
      dependencies,
    );
    const target = candidateTargetIdentity(initial.candidate);
    const executable = path.join(artifactDir, ...target.executable.path.split('/'));
    const launcher = path.join(artifactDir, ...target.launcher.path.split('/'));
    const installer = path.join(artifactDir, ...target.installer.path.split('/'));
    const plan = buildCandidateValidationPlan({
      repositoryRoot,
      executable,
      launcher,
      installer,
      evidenceDirectory,
      lanMinutes,
    });
    if (
      !jsonEqual(
        plan.map((gate) => gate.id),
        REQUIRED_FUNCTIONAL_GATES.map((gate) => gate.id),
      )
    ) {
      throw new Error('Candidate validation plan differs from the required gate matrix.');
    }
    for (const gate of plan) {
      gate.publicInvocation = normalizedPublicInvocation({
        gate,
        executable,
        launcher,
        installer,
        evidenceDirectory,
      });
      if (
        !jsonEqual(gate.publicInvocation, expectedPublicGateInvocation(gate.id, { lanMinutes }))
      ) {
        throw new Error(`${gate.id} invocation differs from the public gate contract.`);
      }
      for (const descriptor of gate.outputs) {
        assertContainedFile(evidenceDirectory, descriptor.sourcePath, 'Harness output');
        allDeclaredSources.push(descriptor.sourcePath);
      }
    }

    for (const sourcePath of new Set(allDeclaredSources)) {
      await removeDeclaredOutput(sourcePath);
    }
    evidenceBaseline = await evidenceDirectorySnapshot(evidenceDirectory, dependencies);

    const evidenceFiles = [];
    const gateRecords = [];
    const cleanBaseEnvironment = createCandidateHarnessEnvironment(process.env);
    for (const [index, gate] of plan.entries()) {
      await dependencies.assertReleaseLockHeld({ releaseLock: options.releaseLock });
      const quickSource = dependencies.gitSourceState(repositoryRoot);
      if (quickSource.dirty || quickSource.commit !== initial.source.commit) {
        throw new Error(`Source state changed before ${gate.id}.`);
      }
      const criticalBefore = await criticalSnapshot(artifactDir, initial.candidate, dependencies);
      await assertPlainDirectorySegments(repositoryRoot, evidenceDirectory);
      for (const descriptor of gate.outputs) {
        await removeDeclaredOutput(descriptor.sourcePath);
      }
      const evidenceBefore = await evidenceDirectorySnapshot(evidenceDirectory, dependencies);
      const startedAt = dependencies.now();
      const monotonicStartedAt = dependencies.monotonicNow();
      process.stdout.write(`\n[candidate] ${gate.id}\n`);
      try {
        await dependencies.runCommand({
          gate,
          command: gate.command,
          args: gate.args,
          cwd: gate.cwd,
          env: { ...cleanBaseEnvironment, ...gate.env },
          timeoutMs: gate.timeoutMs,
          label: gate.id,
        });
      } catch (error) {
        const failureErrors = [error];
        try {
          await assertPlainDirectorySegments(repositoryRoot, evidenceDirectory);
          await removeEvidenceFilesCreatedAfterSnapshot(
            evidenceBefore,
            evidenceDirectory,
            dependencies,
          );
        } catch (safetyError) {
          failureErrors.push(safetyError);
        }
        for (const descriptor of gate.outputs) {
          try {
            await removeDeclaredOutput(descriptor.sourcePath);
          } catch (cleanupError) {
            failureErrors.push(cleanupError);
          }
        }
        if (failureErrors.length > 1) {
          throw new AggregateError(
            failureErrors,
            `${gate.id} failed and its evidence cleanup also failed: ${error.message}`,
          );
        }
        throw error;
      }
      await assertPlainDirectorySegments(repositoryRoot, evidenceDirectory);
      const monotonicCompletedAt = dependencies.monotonicNow();
      const completedAt = dependencies.now();
      const evidenceAfter = await evidenceDirectorySnapshot(evidenceDirectory, dependencies);
      assertOnlyDeclaredOutputsChanged(
        evidenceBefore,
        evidenceAfter,
        gate.outputs,
        evidenceDirectory,
      );
      const collected = [];
      if (gate.syntheticReceipt) {
        const bytes = Buffer.from(
          `${JSON.stringify(
            {
              schemaVersion: 1,
              passed: true,
              gateId: gate.id,
              testedAt: completedAt.toISOString(),
              command: 'pnpm verify',
            },
            null,
            2,
          )}\n`,
          'utf8',
        );
        const destinationName = `${String(index + 1).padStart(2, '0')}-${gate.id}--receipt.json`;
        await atomicWrite(path.join(temporaryRoot, destinationName), bytes);
        collected.push({
          path: destinationName,
          originalName: 'receipt.json',
          role: 'receipt',
          gateId: gate.id,
          bytes,
        });
      } else {
        for (const descriptor of gate.outputs) {
          const destinationName = `${String(index + 1).padStart(2, '0')}-${gate.id}--${descriptor.originalName}`;
          collected.push(
            await collectOutput({
              outputDescriptor: descriptor,
              destinationPath: path.join(temporaryRoot, destinationName),
              gateId: gate.id,
              startedAtMs: startedAt.getTime(),
            }),
          );
        }
      }
      const criticalAfter = await criticalSnapshot(artifactDir, initial.candidate, dependencies);
      await assertPlainDirectorySegments(repositoryRoot, evidenceDirectory);
      if (criticalBefore !== criticalAfter)
        throw new Error(`${gate.id} changed the target payload.`);
      evidenceFiles.push(...collected);
      gateRecords.push({
        id: gate.id,
        required: true,
        status: 'passed',
        scope: expectedGateScope(gate.id),
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: Math.max(0, monotonicCompletedAt - monotonicStartedAt),
        criticalBeforeSha256: criticalBefore,
        criticalAfterSha256: criticalAfter,
        commandId: gate.publicInvocation.commandId,
        argv: gate.publicInvocation.argv,
        environment: gate.publicInvocation.environment,
        thresholds: recordedThresholds(gate.id, collected),
        evidence: collected.map((entry) => entry.path),
      });
    }

    await dependencies.assertReleaseLockHeld({ releaseLock: options.releaseLock });
    const final = await validateCandidateState(
      { repositoryRoot, artifactDir, candidatePath },
      dependencies,
    );
    if (
      final.candidateSha256 !== initial.candidateSha256 ||
      final.candidateSize !== initial.candidateSize ||
      !jsonEqual(final.inventory, initial.inventory) ||
      !jsonEqual(final.source, initial.source) ||
      final.lockfileSha256 !== initial.lockfileSha256 ||
      final.packageManager !== initial.packageManager
    ) {
      throw new Error('Candidate, artifact inventory, or clean source changed during validation.');
    }
    const generatedAt = dependencies.now().toISOString();
    const bundleEntries = [...evidenceFiles]
      .sort((left, right) => left.path.localeCompare(right.path, 'en'))
      .map(({ path: entryPath, bytes }) => ({ path: entryPath, bytes }));
    const bundleBytes = createPublicEvidenceZip(bundleEntries, generatedAt);
    const installerEvidence = evidenceFiles.find(
      (entry) => entry.gateId === 'installer-lifecycle' && entry.role === 'report',
    );
    const publicEnvironment = buildPublicValidationEnvironment({
      platform: dependencies.platform,
      architecture: dependencies.architecture,
      osRelease: dependencies.operatingSystemRelease(),
      osVersion: dependencies.operatingSystemVersion(),
      nodeVersion: process.version,
      packageManager: initial.packageManager,
      installerReport: JSON.parse(Buffer.from(installerEvidence?.bytes ?? []).toString('utf8')),
    });
    const manifest = buildFunctionalValidationManifest({
      candidateManifest: initial.candidate,
      candidateManifestSha256: initial.candidateSha256,
      source: initial.source,
      lockfileSha256: initial.lockfileSha256,
      gates: gateRecords,
      evidenceFiles,
      bundleBytes,
      generatedAt,
      lanMinutes,
      environment: publicEnvironment,
    });
    assertFunctionalValidationManifest({
      manifest,
      candidateManifest: initial.candidate,
      candidateManifestSha256: initial.candidateSha256,
      artifactInventory: final.inventory,
      source: final.source,
      lockfileSha256: final.lockfileSha256,
      evidenceFiles,
      bundleBytes,
      expectedEnvironment: publicEnvironment,
      minimumLanDurationMs,
    });
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    if (publicEvidenceJsonErrors(manifestBytes).length > 0) {
      throw new Error('Functional validation manifest is not public-safe.');
    }
    pendingPublication = {
      baseline: initial,
      bundleBytes,
      manifest,
      manifestBytes,
    };
  } catch (error) {
    executionError = error;
  }

  const cleanupErrors = [];
  let evidenceRootIsSafe = false;
  try {
    await assertPlainDirectorySegments(repositoryRoot, evidenceDirectory);
    evidenceRootIsSafe = true;
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (evidenceRootIsSafe) {
    if (evidenceBaseline !== undefined) {
      try {
        await removeEvidenceFilesCreatedAfterSnapshot(
          evidenceBaseline,
          evidenceDirectory,
          dependencies,
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    } else {
      for (const sourcePath of new Set(allDeclaredSources)) {
        try {
          await removeDeclaredOutput(sourcePath);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
  }
  try {
    await assertPlainDirectorySegments(repositoryRoot, temporaryRoot);
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await syncDirectoryMetadata(path.dirname(temporaryRoot));
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (executionError !== undefined || cleanupErrors.length > 0) {
    for (const finalOutput of [finalManifestPath, finalBundlePath]) {
      try {
        await removeDeclaredOutput(finalOutput);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (executionError !== undefined || cleanupErrors.length > 0) {
    const primaryError = executionError ?? cleanupErrors[0];
    throw new AggregateError(
      [executionError, ...cleanupErrors].filter((error) => error !== undefined),
      `Windows candidate validation or fail-closed cleanup failed: ${primaryError?.message ?? 'unknown error'}`,
    );
  }

  const publicationErrors = [];
  try {
    await dependencies.assertReleaseLockHeld({ releaseLock: options.releaseLock });
    const publicationState = await validateCandidateState(
      { repositoryRoot, artifactDir, candidatePath },
      dependencies,
    );
    const baseline = pendingPublication.baseline;
    if (
      publicationState.candidateSha256 !== baseline.candidateSha256 ||
      publicationState.candidateSize !== baseline.candidateSize ||
      !jsonEqual(publicationState.inventory, baseline.inventory) ||
      !jsonEqual(publicationState.source, baseline.source) ||
      publicationState.lockfileSha256 !== baseline.lockfileSha256 ||
      publicationState.packageManager !== baseline.packageManager
    ) {
      throw new Error('Candidate, artifact inventory, or clean source changed before publication.');
    }
    await assertPlainDirectorySegments(repositoryRoot, outputDirectory);
    await assertPlainDirectorySegments(repositoryRoot, artifactDir);
    await dependencies.assertReleaseLockHeld({ releaseLock: options.releaseLock });
    // The manifest is the commit marker: a crash after the bundle write but before this write
    // leaves no publishable releaseReady validation record.
    await atomicWrite(finalBundlePath, pendingPublication.bundleBytes);
    await atomicWrite(finalManifestPath, pendingPublication.manifestBytes);
  } catch (error) {
    publicationErrors.push(error);
  }
  if (publicationErrors.length > 0) {
    for (const finalOutput of [finalManifestPath, finalBundlePath]) {
      try {
        await removeDeclaredOutput(finalOutput);
      } catch (error) {
        publicationErrors.push(error);
      }
    }
    throw new AggregateError(
      publicationErrors,
      `Windows candidate validation publication failed: ${publicationErrors[0]?.message ?? 'unknown error'}`,
    );
  }
  return {
    manifest: pendingPublication.manifest,
    manifestPath: finalManifestPath,
    bundlePath: finalBundlePath,
  };
};

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const parsed = parseCandidateValidationArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
  } else {
    if (parsed.lanMinutes * 60_000 < DEFAULT_LAN_DURATION_MS) {
      throw new Error('Release readiness requires a LAN soak of at least 30 minutes.');
    }
    const transactionParent = path.dirname(defaultRepositoryRoot);
    const releaseLock = await acquireReleaseLock({
      transactionParent,
      purpose: 'windows-candidate-validation',
    });
    try {
      const result = await runWindowsCandidateValidation({
        repositoryRoot: defaultRepositoryRoot,
        releaseLock,
        lanMinutes: parsed.lanMinutes,
      });
      process.stdout.write(
        `\nWindows candidate functional validation passed.\nManifest: ${result.manifestPath}\nBundle: ${result.bundlePath}\n`,
      );
    } finally {
      await releaseReleaseLock({ releaseLock });
    }
  }
}
