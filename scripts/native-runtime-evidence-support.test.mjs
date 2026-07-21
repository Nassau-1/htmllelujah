import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertNativeRuntimeEvidence,
  assertNativeRuntimeSbom,
  buildNativeRuntimeComponents,
  extractNsisVersion,
  incompleteNativeRuntimeQuality,
  inspectNativeRuntimeEvidence,
  nativeRuntimeQuality,
  parseDesktopElectronLockDeclaration,
} from './native-runtime-evidence-support.mjs';

const digest = (character) => character.repeat(64);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const entry = (pathValue, character) => ({
  path: pathValue,
  size: 100,
  sha256: digest(character),
});
const executable = entry('win-unpacked/HTMLlelujah.exe', 'a');
const chromiumResources = entry('win-unpacked/resources.pak', 'b');
const ffmpeg = entry('win-unpacked/ffmpeg.dll', 'c');
const installer = entry('HTMLlelujah-1.0.0-x64-unsigned-Setup.exe', 'd');
const fuseWire = () => ({
  0: 49,
  1: 49,
  2: 48,
  3: 48,
  4: 49,
  5: 49,
  6: 48,
  7: 48,
  8: 49,
  version: '1',
});
const fuseEvidence = () => ({
  wireVersion: '1',
  passed: true,
  states: {
    RunAsNode: 'enabled',
    EnableCookieEncryption: 'enabled',
    EnableNodeOptionsEnvironmentVariable: 'disabled',
    EnableNodeCliInspectArguments: 'disabled',
    EnableEmbeddedAsarIntegrityValidation: 'enabled',
    OnlyLoadAppFromAsar: 'enabled',
    LoadBrowserProcessSpecificV8Snapshot: 'disabled',
    GrantFileProtocolExtraPrivileges: 'disabled',
    WasmTrapHandlers: 'enabled',
  },
});

const lockfile = `lockfileVersion: '9.0'

importers:

  apps/desktop:
    devDependencies:
      electron:
        specifier: 43.1.1
        version: 43.1.1

  packages/fixture:
    dependencies: {}
`;

const validEvidence = () => ({
  schemaVersion: 1,
  passed: true,
  declarations: {
    desktopElectron: '43.1.1',
    lockSpecifier: '43.1.1',
    lockVersion: '43.1.1',
  },
  packagedRuntime: {
    electron: '43.1.1',
    chromium: '150.0.7871.114',
    node: '24.18.0',
    v8: '15.0.245.15-electron.0',
  },
  fuses: fuseEvidence(),
  ffmpeg: {
    version: 'electron-43.1.1',
    versionScheme: 'electron-distribution',
  },
  nsis: {
    version: '3.04',
    versionEvidence: 'embedded installer assembly manifest description',
  },
  artifacts: { executable, chromiumResources, ffmpeg, installer },
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

test('lock and installer parsers accept exact runtime versions and reject malformed evidence', () => {
  assert.deepEqual(parseDesktopElectronLockDeclaration(lockfile), {
    specifier: '43.1.1',
    version: '43.1.1',
  });
  assert.equal(
    extractNsisVersion(
      '<assembly><description>Nullsoft Install System v3.04</description></assembly>',
    ),
    '3.04',
  );
  assert.throws(
    () =>
      parseDesktopElectronLockDeclaration(
        lockfile.replace('specifier: 43.1.1', 'specifier: ^43.1.1'),
      ),
    /specifier is missing or malformed/iu,
  );
  assert.throws(
    () =>
      parseDesktopElectronLockDeclaration(lockfile.replace('version: 43.1.1', 'version: 43.1.2')),
    /specifier and resolved version differ/iu,
  );
  assert.throws(
    () => extractNsisVersion('nsis-resources-3.4.1-nsis-resources-3.4.1'),
    /lacks an embedded NSIS version/iu,
  );
  assert.throws(
    () => extractNsisVersion('Nullsoft Install System v3.04\nNullsoft Install System v3.10'),
    /ambiguous/iu,
  );
});

test('packaged executable inspection binds declarations, hashes, and five exact components', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'htmllelujah-native-runtime-'));
  const originalElectronLogFile = process.env.ELECTRON_LOG_FILE;
  const originalNodeV8Coverage = process.env.NODE_V8_COVERAGE;
  try {
    await mkdir(path.join(root, 'win-unpacked'), { recursive: true });
    const artifactBytes = {
      executable: Buffer.from('fixture-electron-executable'),
      chromiumResources: Buffer.from('fixture-chromium-resources'),
      ffmpeg: Buffer.from('fixture-ffmpeg-library'),
      installer: Buffer.from('fixture <description>Nullsoft Install System v3.04</description>'),
    };
    const runtimeExecutable = {
      path: executable.path,
      size: artifactBytes.executable.length,
      sha256: sha256(artifactBytes.executable),
    };
    const runtimeChromiumResources = {
      path: chromiumResources.path,
      size: artifactBytes.chromiumResources.length,
      sha256: sha256(artifactBytes.chromiumResources),
    };
    const runtimeFfmpeg = {
      path: ffmpeg.path,
      size: artifactBytes.ffmpeg.length,
      sha256: sha256(artifactBytes.ffmpeg),
    };
    const runtimeInstaller = {
      path: installer.path,
      size: artifactBytes.installer.length,
      sha256: sha256(artifactBytes.installer),
    };
    await Promise.all([
      writeFile(path.join(root, ...runtimeExecutable.path.split('/')), artifactBytes.executable),
      writeFile(
        path.join(root, ...runtimeChromiumResources.path.split('/')),
        artifactBytes.chromiumResources,
      ),
      writeFile(path.join(root, ...runtimeFfmpeg.path.split('/')), artifactBytes.ffmpeg),
      writeFile(path.join(root, runtimeInstaller.path), artifactBytes.installer),
    ]);
    const runtimeInventory = [
      runtimeExecutable,
      runtimeChromiumResources,
      runtimeFfmpeg,
      runtimeInstaller,
    ];
    let inspectedPath = null;
    let inspectedFusePath = null;
    process.env.ELECTRON_LOG_FILE = 'C:\\private\\electron.log';
    process.env.NODE_V8_COVERAGE = 'C:\\private\\coverage';
    const evidence = await inspectNativeRuntimeEvidence({
      artifactDir: root,
      desktopPackage: { devDependencies: { electron: '43.1.1' } },
      inventory: runtimeInventory,
      installers: [runtimeInstaller],
      lockfile,
      readFuseWire: async (filePath) => {
        inspectedFusePath = filePath;
        return fuseWire();
      },
      spawn: (command, args, options) => {
        inspectedPath = command;
        assert.deepEqual(args, ['-e', 'process.stdout.write(JSON.stringify(process.versions))']);
        assert.equal(options.shell, false);
        assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
        assert.equal(
          Object.keys(options.env).filter((key) => key.toUpperCase() === 'NODE_OPTIONS').length,
          0,
        );
        assert.equal(options.env.ELECTRON_LOG_FILE, undefined);
        assert.equal(options.env.NODE_V8_COVERAGE, undefined);
        return {
          error: undefined,
          signal: null,
          status: 0,
          stdout: JSON.stringify({
            electron: '43.1.1',
            chrome: '150.0.7871.114',
            node: '24.18.0',
            v8: '15.0.245.15-electron.0',
          }),
        };
      },
    });
    assert.equal(inspectedPath, path.join(root, 'win-unpacked', 'HTMLlelujah.exe'));
    assert.equal(inspectedFusePath, path.join(root, 'win-unpacked', 'HTMLlelujah.exe'));
    assert.deepEqual(evidence, {
      ...validEvidence(),
      artifacts: {
        executable: runtimeExecutable,
        chromiumResources: runtimeChromiumResources,
        ffmpeg: runtimeFfmpeg,
        installer: runtimeInstaller,
      },
    });
    const components = buildNativeRuntimeComponents(evidence);
    assert.equal(components.length, 5);
    assert.deepEqual(
      new Set(components.map((component) => component.name)),
      new Set([
        'Electron',
        'Chromium',
        'Node.js embedded in Electron',
        'FFmpeg (Electron Chromium build)',
        'Nullsoft Scriptable Install System',
      ]),
    );
    assert.equal(components.find((item) => item.name === 'Electron').version, '43.1.1');
    assert.equal(components.find((item) => item.name === 'Chromium').version, '150.0.7871.114');
    assert.equal(
      components.find((item) => item.name === 'Node.js embedded in Electron').version,
      '24.18.0',
    );
    assert.equal(
      components.find((item) => item.name === 'FFmpeg (Electron Chromium build)').version,
      'electron-43.1.1',
    );
    assert.equal(
      components.find((item) => item.name === 'Nullsoft Scriptable Install System').version,
      '3.04',
    );
    assertNativeRuntimeSbom({ components }, evidence);
    assert.equal(nativeRuntimeQuality(evidence).passed, true);
    assert.equal(nativeRuntimeQuality(evidence).fuses.passed, true);

    await assert.rejects(
      inspectNativeRuntimeEvidence({
        artifactDir: root,
        desktopPackage: { devDependencies: { electron: '43.1.1' } },
        inventory: runtimeInventory,
        installers: [runtimeInstaller],
        lockfile,
        readFuseWire: async () => ({ ...fuseWire(), 9: 49 }),
        spawn: () => {
          throw new Error('runtime execution must not precede fuse validation');
        },
      }),
      /unknown or omitted fuse/iu,
    );

    await assert.rejects(
      inspectNativeRuntimeEvidence({
        artifactDir: root,
        desktopPackage: { devDependencies: { electron: '43.1.1' } },
        inventory: runtimeInventory,
        installers: [runtimeInstaller],
        lockfile,
        readFuseWire: async () => fuseWire(),
        spawn: (command) => {
          writeFileSync(command, Buffer.from('X'.repeat(artifactBytes.executable.length)));
          return {
            error: undefined,
            signal: null,
            status: 0,
            stdout: JSON.stringify({
              electron: '43.1.1',
              chrome: '150.0.7871.114',
              node: '24.18.0',
              v8: '15.0.245.15-electron.0',
            }),
          };
        },
      }),
      /hash differs from the candidate inventory|changed during inspection/iu,
    );
  } finally {
    if (originalElectronLogFile === undefined) delete process.env.ELECTRON_LOG_FILE;
    else process.env.ELECTRON_LOG_FILE = originalElectronLogFile;
    if (originalNodeV8Coverage === undefined) delete process.env.NODE_V8_COVERAGE;
    else process.env.NODE_V8_COVERAGE = originalNodeV8Coverage;
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime evidence fails closed on absent, malformed, or unbound identities', () => {
  const mutations = [
    (value) => {
      delete value.packagedRuntime.chromium;
    },
    (value) => {
      value.packagedRuntime.electron = '43.1.2';
    },
    (value) => {
      value.artifacts.executable.sha256 = 'not-a-hash';
    },
    (value) => {
      value.fuses.states.EnableNodeOptionsEnvironmentVariable = 'enabled';
    },
    (value) => {
      delete value.fuses.states.WasmTrapHandlers;
    },
    (value) => {
      value.ffmpeg.version = 'unknown';
    },
    (value) => {
      value.nsis.version = 'resources-3.4.1-nsis-resources-3.4.1';
    },
    (value) => {
      value.bindings.chromiumResourcesHashPresent = false;
    },
    (value) => {
      delete value.bindings.nsisVersionToInstaller;
    },
  ];
  for (const mutate of mutations) {
    const evidence = structuredClone(validEvidence());
    mutate(evidence);
    assert.throws(() => assertNativeRuntimeEvidence(evidence));
  }
});

test('SBOM verifier rejects omissions, duplicates, malformed versions, and broken hashes', () => {
  const evidence = validEvidence();
  const exact = buildNativeRuntimeComponents(evidence);
  const mutations = [
    (components) => components.slice(1),
    (components) => [...components, structuredClone(components[0])],
    (components) =>
      components.filter((component) => component.name !== 'Node.js embedded in Electron'),
    (components) =>
      components.map((component) =>
        component.name === 'Electron' ? { ...component, version: undefined } : component,
      ),
    (components) =>
      components.map((component) =>
        component.name === 'FFmpeg (Electron Chromium build)'
          ? { ...component, version: 'unknown' }
          : component,
      ),
    (components) =>
      components.map((component) =>
        component.name === 'Nullsoft Scriptable Install System'
          ? { ...component, version: 'resources-3.4.1-nsis-resources-3.4.1' }
          : component,
      ),
    (components) =>
      components.map((component) =>
        component.name === 'Chromium'
          ? { ...component, hashes: [{ alg: 'SHA-256', content: digest('f') }] }
          : component,
      ),
  ];
  for (const mutate of mutations) {
    assert.throws(() =>
      assertNativeRuntimeSbom({ components: mutate(structuredClone(exact)) }, evidence),
    );
  }
});

test('incomplete diagnostics are stable and can never describe a ready inventory', () => {
  const incomplete = incompleteNativeRuntimeQuality();
  assert.equal(incomplete.passed, false);
  assert.equal(incomplete.componentCount, 0);
  assert.equal(incomplete.fuses.passed, false);
  assert.equal(
    Object.values(incomplete.fuses.states).every((value) => value === null),
    true,
  );
  assert.match(incomplete.error, /not established/iu);
  assert.equal(
    Object.values(incomplete.bindings).every((value) => value === false),
    true,
  );
});
