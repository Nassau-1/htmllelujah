import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

import {
  FuseState,
  FuseV1Options,
  FuseVersion,
  getCurrentFuseWire,
} from '../apps/desktop/node_modules/@electron/fuses/dist/index.js';

const RUNTIME_PROPERTY_NAMESPACE = 'app.htmllelujah.release';
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const EXACT_SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const RUNTIME_VERSION_PATTERN = /^[0-9]+\.[0-9]+(?:\.[0-9]+){0,2}(?:[-+][0-9A-Za-z.-]+)?$/u;
const REQUIRED_RUNTIME_COMPONENTS = Object.freeze([
  'Electron',
  'Chromium',
  'Node.js embedded in Electron',
  'FFmpeg (Electron Chromium build)',
  'Nullsoft Scriptable Install System',
]);
const EXPECTED_FUSE_STATES = Object.freeze([
  ['RunAsNode', FuseV1Options.RunAsNode, FuseState.ENABLE],
  ['EnableCookieEncryption', FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
  [
    'EnableNodeOptionsEnvironmentVariable',
    FuseV1Options.EnableNodeOptionsEnvironmentVariable,
    FuseState.DISABLE,
  ],
  ['EnableNodeCliInspectArguments', FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
  [
    'EnableEmbeddedAsarIntegrityValidation',
    FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
    FuseState.ENABLE,
  ],
  ['OnlyLoadAppFromAsar', FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
  [
    'LoadBrowserProcessSpecificV8Snapshot',
    FuseV1Options.LoadBrowserProcessSpecificV8Snapshot,
    FuseState.DISABLE,
  ],
  [
    'GrantFileProtocolExtraPrivileges',
    FuseV1Options.GrantFileProtocolExtraPrivileges,
    FuseState.DISABLE,
  ],
  ['WasmTrapHandlers', FuseV1Options.WasmTrapHandlers, FuseState.ENABLE],
]);
const REQUIRED_BINDINGS = Object.freeze([
  'electronDeclarationsToExecutable',
  'electronExecutableHashPresent',
  'electronFusePolicyPassed',
  'electronFuseWireToExecutable',
  'chromiumVersionToExecutable',
  'chromiumResourcesHashPresent',
  'nodeVersionToExecutable',
  'ffmpegDistributionToElectron',
  'ffmpegHashPresent',
  'nsisVersionToInstaller',
  'nsisInstallerHashPresent',
]);

const property = (name, value) => ({
  name: `${RUNTIME_PROPERTY_NAMESPACE}:${name}`,
  value: String(value),
});

const hash = (content) => ({ alg: 'SHA-256', content });

const assertExactVersion = (value, label, pattern = RUNTIME_VERSION_PATTERN) => {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${label} is missing or malformed.`);
  }
  return value;
};

const assertInventoryEntry = (entry, expectedPath, label) => {
  if (
    entry?.path !== expectedPath ||
    !Number.isSafeInteger(entry?.size) ||
    entry.size < 1 ||
    !SHA256_PATTERN.test(entry?.sha256 ?? '')
  ) {
    throw new Error(`${label} inventory evidence is missing or malformed.`);
  }
  return entry;
};

const inventoryEntry = (inventory, expectedPath, label) =>
  assertInventoryEntry(
    inventory.find((entry) => entry.path === expectedPath),
    expectedPath,
    label,
  );

const resolveInventoryPath = (artifactDir, relativePath, label) => {
  const root = path.resolve(artifactDir);
  const resolved = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} path escapes the candidate artifact directory.`);
  }
  return resolved;
};

const sameOpenedFile = (left, right) =>
  left.isFile() &&
  right.isFile() &&
  !left.isSymbolicLink() &&
  !right.isSymbolicLink() &&
  left.nlink === 1n &&
  right.nlink === 1n &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.birthtimeNs === right.birthtimeNs &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs;

const snapshotInventoryArtifact = async (artifactDir, entry, label) => {
  const filePath = resolveInventoryPath(artifactDir, entry.path, label);
  const before = await lstat(filePath, { bigint: true });
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1n ||
    before.size !== BigInt(entry.size)
  ) {
    throw new Error(`${label} is not the exact one-link regular candidate file.`);
  }

  const handle = await open(filePath, 'r');
  let opened;
  let afterRead;
  const digest = createHash('sha256');
  try {
    opened = await handle.stat({ bigint: true });
    if (!sameOpenedFile(before, opened)) {
      throw new Error(`${label} changed before it was opened for inventory.`);
    }
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) digest.update(chunk);
    afterRead = await handle.stat({ bigint: true });
    if (!sameOpenedFile(opened, afterRead)) {
      throw new Error(`${label} changed while it was inventoried.`);
    }
  } finally {
    await handle.close();
  }
  const afterPath = await lstat(filePath, { bigint: true });
  if (!sameOpenedFile(afterRead, afterPath)) {
    throw new Error(`${label} path identity changed while it was inventoried.`);
  }
  const sha256 = digest.digest('hex');
  if (sha256 !== entry.sha256) {
    throw new Error(`${label} hash differs from the candidate inventory.`);
  }
  return {
    path: entry.path,
    size: Number(afterPath.size),
    sha256,
    dev: afterPath.dev,
    ino: afterPath.ino,
    birthtimeNs: afterPath.birthtimeNs,
  };
};

const snapshotRuntimeArtifacts = async (artifactDir, entries) =>
  Promise.all(
    entries.map(({ entry, label }) => snapshotInventoryArtifact(artifactDir, entry, label)),
  );

const assertRuntimeArtifactsUnchanged = (before, after) => {
  if (before.length !== after.length) {
    throw new Error('Native runtime artifact inventory changed during inspection.');
  }
  for (let index = 0; index < before.length; index += 1) {
    const left = before[index];
    const right = after[index];
    if (
      left.path !== right.path ||
      left.size !== right.size ||
      left.sha256 !== right.sha256 ||
      left.dev !== right.dev ||
      left.ino !== right.ino ||
      left.birthtimeNs !== right.birthtimeNs
    ) {
      throw new Error(`Native runtime artifact changed during inspection: ${left.path}.`);
    }
  }
};

const sanitizedRuntimeEnvironment = (source = process.env) => {
  const environment = {};
  for (const [key, value] of Object.entries(source)) {
    const normalizedKey = key.toUpperCase();
    if (normalizedKey.startsWith('ELECTRON_') || normalizedKey.startsWith('NODE_')) {
      continue;
    }
    environment[key] = value;
  }
  environment.ELECTRON_RUN_AS_NODE = '1';
  return environment;
};

const fuseStateName = (value) => {
  if (value === FuseState.ENABLE) return 'enabled';
  if (value === FuseState.DISABLE) return 'disabled';
  if (value === FuseState.REMOVED) return 'removed';
  if (value === FuseState.INHERIT) return 'inherited';
  return 'unknown';
};

const expectedFuseEvidence = () => ({
  wireVersion: FuseVersion.V1,
  passed: true,
  states: Object.fromEntries(
    EXPECTED_FUSE_STATES.map(([name, , expected]) => [name, fuseStateName(expected)]),
  ),
});

const inspectFuseEvidence = async (executable, readFuseWire) => {
  let wire;
  try {
    wire = await readFuseWire(executable);
  } catch (error) {
    throw new Error('Packaged Electron fuse wire could not be read.', { cause: error });
  }
  if (wire?.version !== FuseVersion.V1) {
    throw new Error('Packaged Electron fuse wire version is missing or unsupported.');
  }
  const actualIndexes = Object.keys(wire)
    .filter((key) => /^\d+$/u.test(key))
    .map(Number)
    .sort((left, right) => left - right);
  const expectedIndexes = EXPECTED_FUSE_STATES.map(([, index]) => index).sort(
    (left, right) => left - right,
  );
  if (JSON.stringify(actualIndexes) !== JSON.stringify(expectedIndexes)) {
    throw new Error('Packaged Electron fuse wire contains an unknown or omitted fuse.');
  }
  for (const [name, index, expected] of EXPECTED_FUSE_STATES) {
    if (wire[index] !== expected) {
      throw new Error(
        `Packaged Electron fuse ${name} must be ${fuseStateName(expected)}, found ${fuseStateName(
          wire[index],
        )}.`,
      );
    }
  }
  return expectedFuseEvidence();
};

export const parseDesktopElectronLockDeclaration = (lockfile) => {
  if (typeof lockfile !== 'string') {
    throw new Error('pnpm lockfile content is unavailable.');
  }
  const lines = lockfile.replaceAll('\r\n', '\n').split('\n');
  const importerStart = lines.findIndex((line) => line === '  apps/desktop:');
  if (importerStart < 0) throw new Error('pnpm lockfile lacks the apps/desktop importer.');
  let importerEnd = lines.length;
  for (let index = importerStart + 1; index < lines.length; index += 1) {
    if (/^  \S/u.test(lines[index])) {
      importerEnd = index;
      break;
    }
  }
  const importer = lines.slice(importerStart + 1, importerEnd);
  const electronStart = importer.findIndex((line) => line === '      electron:');
  if (electronStart < 0) {
    throw new Error('pnpm lockfile lacks apps/desktop electron metadata.');
  }
  let dependencyEnd = importer.length;
  for (let index = electronStart + 1; index < importer.length; index += 1) {
    if (/^      \S/u.test(importer[index])) {
      dependencyEnd = index;
      break;
    }
  }
  const dependency = importer.slice(electronStart + 1, dependencyEnd);
  const value = (key) => {
    const line = dependency.find((entry) => entry.startsWith(`        ${key}:`));
    return line
      ?.slice(line.indexOf(':') + 1)
      .trim()
      .replace(/^['"]|['"]$/gu, '');
  };
  const specifier = assertExactVersion(
    value('specifier'),
    'pnpm lockfile Electron specifier',
    EXACT_SEMVER_PATTERN,
  );
  const version = assertExactVersion(
    value('version'),
    'pnpm lockfile Electron version',
    EXACT_SEMVER_PATTERN,
  );
  if (specifier !== version) {
    throw new Error('pnpm lockfile Electron specifier and resolved version differ.');
  }
  return { specifier, version };
};

export const extractNsisVersion = (content) => {
  const text = Buffer.isBuffer(content) ? content.toString('latin1') : String(content ?? '');
  const versions = new Set(
    [...text.matchAll(/Nullsoft Install System v([0-9]+\.[0-9]+(?:\.[0-9]+){0,2})/gu)].map(
      (match) => match[1],
    ),
  );
  if (versions.size !== 1) {
    throw new Error(
      versions.size === 0
        ? 'The installer lacks an embedded NSIS version.'
        : 'The installer contains ambiguous embedded NSIS versions.',
    );
  }
  return assertExactVersion([...versions][0], 'Embedded NSIS version');
};

const inspectNsisVersion = async (filePath) => {
  try {
    const versions = new Set();
    let carry = Buffer.alloc(0);
    const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
    for await (const chunk of stream) {
      const combined = Buffer.concat([carry, chunk]);
      const text = combined.toString('latin1');
      for (const match of text.matchAll(
        /Nullsoft Install System v([0-9]+\.[0-9]+(?:\.[0-9]+){0,2})/gu,
      )) {
        versions.add(match[1]);
      }
      carry = combined.subarray(Math.max(0, combined.length - 256));
    }
    return extractNsisVersion(
      [...versions].map((version) => `Nullsoft Install System v${version}`).join('\n'),
    );
  } catch (error) {
    throw new Error('Packaged NSIS version inspection failed.', { cause: error });
  }
};

const inspectPackagedRuntime = (executable, spawn = spawnSync) => {
  const result = spawn(
    executable,
    ['-e', 'process.stdout.write(JSON.stringify(process.versions))'],
    {
      encoding: 'utf8',
      env: sanitizedRuntimeEnvironment(),
      maxBuffer: 1024 * 1024,
      shell: false,
      timeout: 30_000,
      windowsHide: true,
    },
  );
  if (result.error || result.signal !== null || result.status !== 0 || !result.stdout) {
    throw new Error(
      `Packaged Electron runtime inspection failed (${result.error?.code ?? result.signal ?? result.status ?? 'no output'}).`,
    );
  }
  let versions;
  try {
    versions = JSON.parse(result.stdout);
  } catch {
    throw new Error('Packaged Electron runtime inspection returned malformed JSON.');
  }
  return {
    electron: assertExactVersion(versions?.electron, 'Packaged Electron version'),
    chromium: assertExactVersion(versions?.chrome, 'Packaged Chromium version'),
    node: assertExactVersion(versions?.node, 'Packaged embedded Node.js version'),
    v8: assertExactVersion(versions?.v8, 'Packaged V8 version'),
  };
};

export const assertNativeRuntimeEvidence = (evidence) => {
  if (evidence?.schemaVersion !== 1 || evidence?.passed !== true) {
    throw new Error('Native runtime evidence is not a passing schema-v1 record.');
  }
  const electronVersion = assertExactVersion(
    evidence.declarations?.desktopElectron,
    'Desktop Electron declaration',
    EXACT_SEMVER_PATTERN,
  );
  if (
    evidence.declarations?.lockSpecifier !== electronVersion ||
    evidence.declarations?.lockVersion !== electronVersion ||
    evidence.packagedRuntime?.electron !== electronVersion
  ) {
    throw new Error(
      'Electron package, lockfile, and packaged executable versions are not exactly bound.',
    );
  }
  assertExactVersion(evidence.packagedRuntime?.chromium, 'Packaged Chromium version');
  assertExactVersion(evidence.packagedRuntime?.node, 'Packaged embedded Node.js version');
  assertExactVersion(evidence.packagedRuntime?.v8, 'Packaged V8 version');
  if (JSON.stringify(evidence.fuses) !== JSON.stringify(expectedFuseEvidence())) {
    throw new Error('Packaged Electron fuse evidence is incomplete or violates policy.');
  }
  assertInventoryEntry(
    evidence.artifacts?.executable,
    'win-unpacked/HTMLlelujah.exe',
    'Packaged Electron executable',
  );
  assertInventoryEntry(
    evidence.artifacts?.chromiumResources,
    'win-unpacked/resources.pak',
    'Packaged Chromium resources',
  );
  assertInventoryEntry(evidence.artifacts?.ffmpeg, 'win-unpacked/ffmpeg.dll', 'Packaged FFmpeg');
  if (!/(?:^|-)Setup\.exe$/u.test(evidence.artifacts?.installer?.path ?? '')) {
    throw new Error('NSIS installer inventory evidence is missing or malformed.');
  }
  assertInventoryEntry(
    evidence.artifacts.installer,
    evidence.artifacts.installer.path,
    'NSIS installer',
  );
  assertExactVersion(evidence.nsis?.version, 'Embedded NSIS version');
  const expectedFfmpegVersion = `electron-${electronVersion}`;
  if (evidence.ffmpeg?.version !== expectedFfmpegVersion) {
    throw new Error('FFmpeg distribution version is missing or not bound to Electron.');
  }
  const bindingNames = Object.keys(evidence.bindings ?? {}).sort((left, right) =>
    left.localeCompare(right, 'en'),
  );
  const expectedBindingNames = [...REQUIRED_BINDINGS].sort((left, right) =>
    left.localeCompare(right, 'en'),
  );
  if (JSON.stringify(bindingNames) !== JSON.stringify(expectedBindingNames)) {
    throw new Error('Native runtime binding set is incomplete or unexpected.');
  }
  for (const binding of REQUIRED_BINDINGS) {
    if (evidence.bindings?.[binding] !== true) {
      throw new Error(`Required native runtime binding ${binding} is missing.`);
    }
  }
  return evidence;
};

export const inspectNativeRuntimeEvidence = async ({
  artifactDir,
  desktopPackage,
  inventory,
  installers,
  lockfile,
  spawn = spawnSync,
  readFuseWire = getCurrentFuseWire,
}) => {
  const declaredElectron = assertExactVersion(
    desktopPackage?.devDependencies?.electron,
    'Desktop Electron devDependency',
    EXACT_SEMVER_PATTERN,
  );
  const lockedElectron = parseDesktopElectronLockDeclaration(lockfile);
  if (
    lockedElectron.specifier !== declaredElectron ||
    lockedElectron.version !== declaredElectron
  ) {
    throw new Error('Desktop Electron devDependency and pnpm lockfile declaration differ.');
  }
  if (installers.length !== 1) {
    throw new Error('Native runtime evidence requires exactly one NSIS installer.');
  }
  const executable = inventoryEntry(
    inventory,
    'win-unpacked/HTMLlelujah.exe',
    'Packaged Electron executable',
  );
  const chromiumResources = inventoryEntry(
    inventory,
    'win-unpacked/resources.pak',
    'Packaged Chromium resources',
  );
  const ffmpeg = inventoryEntry(inventory, 'win-unpacked/ffmpeg.dll', 'Packaged FFmpeg');
  const installer = assertInventoryEntry(installers[0], installers[0].path, 'NSIS installer');
  const inspectedArtifacts = [
    { entry: executable, label: 'Packaged Electron executable' },
    { entry: chromiumResources, label: 'Packaged Chromium resources' },
    { entry: ffmpeg, label: 'Packaged FFmpeg' },
    { entry: installer, label: 'NSIS installer' },
  ];
  const inventoryBeforeInspection = await snapshotRuntimeArtifacts(artifactDir, inspectedArtifacts);
  const executablePath = path.join(artifactDir, ...executable.path.split('/'));
  const fuses = await inspectFuseEvidence(executablePath, readFuseWire);
  const packagedRuntime = inspectPackagedRuntime(executablePath, spawn);
  if (packagedRuntime.electron !== declaredElectron) {
    throw new Error(
      `Packaged Electron ${packagedRuntime.electron} does not match declared Electron ${declaredElectron}.`,
    );
  }
  const nsisVersion = await inspectNsisVersion(
    path.join(artifactDir, ...installer.path.split('/')),
  );
  const evidence = assertNativeRuntimeEvidence({
    schemaVersion: 1,
    passed: true,
    declarations: {
      desktopElectron: declaredElectron,
      lockSpecifier: lockedElectron.specifier,
      lockVersion: lockedElectron.version,
    },
    packagedRuntime,
    fuses,
    ffmpeg: {
      version: `electron-${declaredElectron}`,
      versionScheme: 'electron-distribution',
    },
    nsis: {
      version: nsisVersion,
      versionEvidence: 'embedded installer assembly manifest description',
    },
    artifacts: {
      executable,
      chromiumResources,
      ffmpeg,
      installer,
    },
    bindings: {
      electronDeclarationsToExecutable: true,
      electronExecutableHashPresent: true,
      electronFusePolicyPassed: true,
      electronFuseWireToExecutable: true,
      chromiumVersionToExecutable: true,
      chromiumResourcesHashPresent: true,
      nodeVersionToExecutable: true,
      ffmpegDistributionToElectron: true,
      ffmpegHashPresent: true,
      nsisVersionToInstaller: true,
      nsisInstallerHashPresent: true,
    },
  });
  const inventoryAfterInspection = await snapshotRuntimeArtifacts(artifactDir, inspectedArtifacts);
  assertRuntimeArtifactsUnchanged(inventoryBeforeInspection, inventoryAfterInspection);
  return evidence;
};

export const buildNativeRuntimeComponents = (evidence) => {
  assertNativeRuntimeEvidence(evidence);
  const { artifacts, packagedRuntime } = evidence;
  const executableEvidence = [
    property('evidence-path', artifacts.executable.path),
    property('evidence-sha256', artifacts.executable.sha256),
    property('runtime-inspection', 'exact packaged executable with ELECTRON_RUN_AS_NODE=1'),
  ];
  const components = [
    {
      type: 'framework',
      'bom-ref': `pkg:npm/electron@${packagedRuntime.electron}`,
      group: 'Electron',
      name: 'Electron',
      version: packagedRuntime.electron,
      purl: `pkg:npm/electron@${packagedRuntime.electron}`,
      hashes: [hash(artifacts.executable.sha256)],
      licenses: [{ license: { id: 'MIT' } }],
      properties: [
        ...executableEvidence,
        property('fuse-wire-version', evidence.fuses.wireVersion),
        ...Object.entries(evidence.fuses.states).map(([name, state]) =>
          property(`fuse.${name}`, state),
        ),
        property(
          'package-lock-binding',
          'apps/desktop package declaration and pnpm lock importer match packaged runtime',
        ),
      ],
    },
    {
      type: 'framework',
      'bom-ref': `pkg:generic/chromium@${packagedRuntime.chromium}`,
      group: 'Chromium',
      name: 'Chromium',
      version: packagedRuntime.chromium,
      purl: `pkg:generic/chromium@${packagedRuntime.chromium}`,
      hashes: [hash(artifacts.chromiumResources.sha256)],
      properties: [
        ...executableEvidence,
        property('payload-path', artifacts.chromiumResources.path),
        property('payload-sha256', artifacts.chromiumResources.sha256),
        property('license-notice-path', 'win-unpacked/LICENSES.chromium.html'),
      ],
    },
    {
      type: 'framework',
      'bom-ref': `pkg:generic/node.js@${packagedRuntime.node}`,
      name: 'Node.js embedded in Electron',
      version: packagedRuntime.node,
      purl: `pkg:generic/node.js@${packagedRuntime.node}`,
      hashes: [hash(artifacts.executable.sha256)],
      properties: executableEvidence,
    },
    {
      type: 'library',
      'bom-ref': `pkg:generic/ffmpeg@${evidence.ffmpeg.version}`,
      group: 'FFmpeg',
      name: 'FFmpeg (Electron Chromium build)',
      version: evidence.ffmpeg.version,
      purl: `pkg:generic/ffmpeg@${evidence.ffmpeg.version}`,
      hashes: [hash(artifacts.ffmpeg.sha256)],
      licenses: [{ expression: 'LGPL-2.1-or-later' }],
      properties: [
        property('evidence-path', artifacts.ffmpeg.path),
        property('evidence-sha256', artifacts.ffmpeg.sha256),
        property('version-scheme', evidence.ffmpeg.versionScheme),
        property('distribution-electron-version', packagedRuntime.electron),
        property(
          'license-evidence',
          'FFmpeg entry in packaged LICENSES.chromium.html; build options require separate review',
        ),
      ],
    },
    {
      type: 'application',
      'bom-ref': `pkg:generic/nsis@${evidence.nsis.version}`,
      name: 'Nullsoft Scriptable Install System',
      version: evidence.nsis.version,
      purl: `pkg:generic/nsis@${evidence.nsis.version}`,
      hashes: [hash(artifacts.installer.sha256)],
      licenses: [{ license: { id: 'Zlib' } }],
      properties: [
        property('evidence-path', artifacts.installer.path),
        property('evidence-sha256', artifacts.installer.sha256),
        property('version-evidence', evidence.nsis.versionEvidence),
      ],
    },
  ];
  components.sort((left, right) => left['bom-ref'].localeCompare(right['bom-ref'], 'en'));
  return components;
};

export const assertNativeRuntimeSbom = (sbom, evidence) => {
  const expected = buildNativeRuntimeComponents(evidence);
  const actual = sbom?.components;
  if (!Array.isArray(actual) || actual.length !== REQUIRED_RUNTIME_COMPONENTS.length) {
    throw new Error('Build SBOM does not contain exactly five required native runtime components.');
  }
  const actualNames = actual.map((component) => component?.name);
  for (const name of REQUIRED_RUNTIME_COMPONENTS) {
    if (actualNames.filter((entry) => entry === name).length !== 1) {
      throw new Error(`Build SBOM must contain exactly one ${name} component.`);
    }
  }
  for (const expectedComponent of expected) {
    const actualComponent = actual.find((component) => component?.name === expectedComponent.name);
    if (JSON.stringify(actualComponent) !== JSON.stringify(expectedComponent)) {
      throw new Error(`Build SBOM ${expectedComponent.name} evidence is missing or inconsistent.`);
    }
  }
  return true;
};

export const nativeRuntimeQuality = (evidence) => {
  assertNativeRuntimeEvidence(evidence);
  return {
    passed: true,
    componentCount: REQUIRED_RUNTIME_COMPONENTS.length,
    versions: {
      electron: evidence.packagedRuntime.electron,
      chromium: evidence.packagedRuntime.chromium,
      node: evidence.packagedRuntime.node,
      ffmpeg: evidence.ffmpeg.version,
      nsis: evidence.nsis.version,
    },
    fuses: structuredClone(evidence.fuses),
    bindings: { ...evidence.bindings },
  };
};

export const incompleteNativeRuntimeQuality = () => ({
  passed: false,
  componentCount: 0,
  versions: {
    electron: null,
    chromium: null,
    node: null,
    ffmpeg: null,
    nsis: null,
  },
  fuses: {
    wireVersion: null,
    passed: false,
    states: Object.fromEntries(EXPECTED_FUSE_STATES.map(([name]) => [name, null])),
  },
  bindings: {
    electronDeclarationsToExecutable: false,
    electronExecutableHashPresent: false,
    electronFusePolicyPassed: false,
    electronFuseWireToExecutable: false,
    chromiumVersionToExecutable: false,
    chromiumResourcesHashPresent: false,
    nodeVersionToExecutable: false,
    ffmpegDistributionToElectron: false,
    ffmpegHashPresent: false,
    nsisVersionToInstaller: false,
    nsisInstallerHashPresent: false,
  },
  error: 'Required native runtime identity and binding evidence was not established.',
});
