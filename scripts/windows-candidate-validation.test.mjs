import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildDirectoryInventory } from '../apps/desktop/scripts/build-provenance-support.mjs';
import {
  DEFAULT_LAN_DURATION_MS,
  EXTERNAL_VALIDATION_LIMITATIONS,
  FUNCTIONAL_VALIDATION_BUNDLE_NAME,
  FUNCTIONAL_VALIDATION_FILE_NAME,
  REQUIRED_FUNCTIONAL_GATES,
  aggregateEvidenceInventory,
  assertFunctionalValidationBundle,
  assertFunctionalValidationManifest,
  createPublicEvidenceZip,
  functionalValidationErrors,
  gateReportErrors,
  publicEvidenceJsonErrors,
  publicPngErrors,
  readPublicEvidenceZipEntries,
  reconstructEvidenceFilesFromBundle,
  sha256Bytes,
} from './windows-candidate-validation-support.mjs';
import {
  buildCandidateValidationPlan,
  createCandidateHarnessEnvironment,
  normalizedPublicInvocation,
  parseCandidateValidationArgs,
  runValidationCommand,
  runWindowsCandidateValidation,
} from './run-windows-candidate-validation.mjs';

const COMMIT = '1'.repeat(40);
const TREE_SHA = '2'.repeat(64);
const LOCK_SHA = '3'.repeat(64);
const BUILD_ID = '10000000-0000-4000-8000-000000000001';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const exists = async (filePath) =>
  stat(filePath)
    .then(() => true)
    .catch((error) => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    });

const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
const nowIso = () => new Date().toISOString();

const allTrue = {
  first: true,
  second: true,
  third: true,
};

const uiReport = () => ({
  passed: true,
  testedAt: nowIso(),
  launchMode: 'packaged-executable',
  performance: { interactiveReadyMs: 100, warmStartBudgetMs: 3_000, withinWarmStartBudget: true },
  checks: Array.from({ length: 12 }, (_, index) => `UI check ${index + 1}`),
});

const mcpReport = (target) => ({
  schemaVersion: 1,
  generatedAt: nowIso(),
  product: 'HTMLlelujah',
  version: '1.0.0',
  target: {
    mode: 'packaged-launcher',
    platform: 'win32',
    architecture: 'x64',
    artifact: {
      executable: { size: target.executable.size, sha256: target.executable.sha256 },
      launcher: { size: target.launcher.size, sha256: target.launcher.sha256 },
    },
  },
  result: 'passed',
  protocol: { transport: 'stdio-json-rpc', frameCount: 120, processCount: 8, stdoutPurity: true },
  cases: Array.from({ length: 9 }, (_, index) => ({
    id: `MCP-${String(index + 1).padStart(3, '0')}`,
    status: 'passed',
    assertions: ['fixture'],
  })),
  limitations: [],
});

const reportForOutput = ({ gate, descriptor, target, lanDurationMs }) => {
  if (descriptor.role === 'installed-ui-report') return uiReport();
  if (descriptor.role === 'installed-mcp-report') return mcpReport(target);
  switch (gate.id) {
    case 'ui-packaged':
      return uiReport();
    case 'exports-widescreen':
    case 'exports-standard':
    case 'exports-a4-landscape':
    case 'exports-stress-50': {
      const stress = gate.id === 'exports-stress-50';
      const preset = stress ? 'widescreen' : gate.id.replace('exports-', '');
      return {
        schemaVersion: 2,
        passed: true,
        testedAt: nowIso(),
        launchMode: 'packaged-executable',
        fixture: { pagePreset: preset },
        run: {
          mode: stress ? 'stress' : 'short',
          exportCount: stress ? 50 : 2,
          alternatingFormats: true,
          uniqueDestinations: true,
        },
        checks: {
          ...allTrue,
          nativeHtmlExportDialogsAutomated: 1,
          nativePdfExportDialogsAutomated: 1,
        },
        security: { publicReportContainsLocalPaths: false },
      };
    }
    case 'mcp-packaged':
      return mcpReport(target);
    case 'accessibility-scaling':
      return {
        schemaVersion: 1,
        passed: true,
        testedAt: nowIso(),
        launchMode: 'packaged-executable',
        requestedScaleFactors: [1, 1.25, 1.5, 2],
        completedScaleFactors: [1, 1.25, 1.5, 2],
        results: [1, 1.25, 1.5, 2].map((factor) => ({ factorRequested: factor })),
        limitations: ['Automated semantics are not a screen reader.'],
      };
    case 'text-lock-two-process':
      return {
        passed: true,
        testedAt: nowIso(),
        launchMode: 'packaged-executable',
        checks: {
          syntheticDeckOpenedByTwoIsolatedProfiles: true,
          manualLanSessionWithoutDiscovery: true,
          invitationReadFromProductUi: true,
          sameTextElementSelectedInBothInstances: true,
          hostReservationVisible: true,
          guestSawParticipantOwnerMessage: true,
          guestTextFieldsetDisabledWhileHeld: true,
          reservationTransferredAfterHostBlur: true,
          guestTextFieldsetEnabledAfterTransfer: true,
          bothSessionsEndedThroughProductUi: true,
          screenshotsCapturedAfterSecretDialogClosed: 3,
          rendererProductBridgeCalledDirectlyByTest: false,
        },
      };
    case 'single-instance-final-artifact':
      return {
        schemaVersion: 1,
        passed: true,
        testedAt: nowIso(),
        artifactFinality: 'final-release-candidate',
        freshForRelease: true,
        installer: { sha256: target.installer.sha256 },
        checks: {
          ...allTrue,
          hdeckOpenedThroughWindowsShellAssociation: true,
          quotedUnicodeCommandLinePathOpened: true,
          exactlyOneDurablePrimaryProcess: true,
          malformedArchivePreservedCurrentSession: true,
          missingArchivePreservedCurrentSession: true,
          allInstalledProcessesExitedBeforeUninstall: true,
          silentUninstallRemovedApplication: true,
        },
      };
    case 'installer-lifecycle':
      return {
        schemaVersion: 4,
        passed: true,
        startedAt: nowIso(),
        completedAt: nowIso(),
        sourceCommit: COMMIT,
        sourceTree: { sha256: TREE_SHA, fileCount: 5, bytes: 100 },
        lockfileSha256: LOCK_SHA,
        sourceCleanAndStable: true,
        installer: { sha256: target.installer.sha256 },
        releaseCandidateManifest: {
          sha256: target.candidateManifestSha256,
          blockmapSha256: target.blockmap.sha256,
          companionExecutableSha256: target.executable.sha256,
          companionAppAsarSha256: target.appAsar.sha256,
          installedPayloadMatchedCompanion: true,
        },
        checks: {
          ...allTrue,
          nonElevatedCurrentUserToken: true,
          dedicatedNonAdministratorAccount: 'not-tested',
          existingHdeckOpenedInRealEditor: true,
          installedMcpLauncherRoundTrip: true,
          repairRerunRestoredMissingPayload: true,
          upgradeLikeReinstallRemovedObsoletePayload: true,
          completeInstalledTreeMatchedCandidateAfterInstall: true,
          completeInstalledTreeMatchedCandidateAfterRepair: true,
          completeInstalledTreeMatchedCandidateAfterUpgradeLikeReinstall: true,
          installedFileSizesAndSha256Verified: true,
          noInstalledSymlinksOrReparsePoints: true,
          maintenancePreservedUserDeck: true,
          uninstallPreservedUserDeck: true,
          noResidualProductProcesses: true,
          noResidualProductRegistry: true,
          noResidualProductShortcuts: true,
        },
      };
    case 'benchmark-core':
      return {
        schemaVersion: 1,
        generatedAt: nowIso(),
        validation: { slides: 500 },
        exports: { mixedExports: 50 },
        gesture: { p95Ms: 1, thresholdMs: 16.7, passed: true },
        runtime: {
          commandP95Ms: 1,
          commandThresholdMs: 100,
          commandPassed: true,
        },
      };
    case 'benchmark-capacity-presentation':
      return {
        schemaVersion: 1,
        generatedAt: nowIso(),
        fixture: { slides: 500, elements: 10_000 },
        capacity: { passed: true },
        presentationNavigation: { p95Ms: 1, thresholdMs: 100, passed: true },
      };
    case 'benchmark-expanded-limit':
      return {
        schemaVersion: 1,
        passed: true,
        testedAt: nowIso(),
        fixture: { expandedAssetMiB: 500 },
        measurements: { saveMs: 20_000, reopenMs: 15_000, peakRssMiB: 3_100 },
        checks: allTrue,
      };
    case 'lan-loopback-soak':
      return {
        schemaVersion: 1,
        status: 'passed',
        startedAt: nowIso(),
        endedAt: nowIso(),
        configuredDurationMs: lanDurationMs,
        steadyStateDurationMs: lanDurationMs,
        topology: { hosts: 1, guests: 2 },
        peers: {
          expectedGuestCount: 2,
          minimumObservedDuringExercise: 2,
          maximumObserved: 2,
        },
        reconnect: { cycles: 0 },
        operations: { commands: 20 },
        continuity: {
          maximumLoopHiatusMs: 1_000,
          thresholdExclusiveMs: 30_000,
          passed: true,
        },
        commandRoundTripMs: { p95: 249.9 },
        invariants: {
          ...allTrue,
          revisionAndHashCheckedAfterEveryCommand: true,
          onlyHostSavedSharedFile: true,
          persistedSnapshotsMatchedHost: true,
          objectEditingExercised: true,
          embeddedAssetInsertionExercised: true,
          textLeaseContentionAndTransferExercised: true,
          hostLossRejectedAllGuestEdits: true,
          cleanupComplete: true,
        },
      };
    default:
      throw new Error(`No fixture report for ${gate.id}.`);
  }
};

const createCandidateFixture = async () => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), 'htmllelujah-candidate-validation-'));
  const artifactDir = path.join(repositoryRoot, 'apps', 'desktop', 'out');
  const evidenceRoot = path.join(repositoryRoot, 'artifacts', 'release-evidence');
  await mkdir(path.join(artifactDir, 'win-unpacked', 'resources'), { recursive: true });
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(
    path.join(repositoryRoot, 'apps', 'desktop', 'package.json'),
    JSON.stringify({ name: '@htmllelujah/desktop', version: '1.0.0' }),
  );
  await writeFile(
    path.join(repositoryRoot, 'package.json'),
    JSON.stringify({ name: 'htmllelujah', packageManager: 'pnpm@11.13.0' }),
  );
  await writeFile(path.join(repositoryRoot, 'pnpm-lock.yaml'), 'fixture lockfile\n');
  const installerName = 'HTMLlelujah-1.0.0-x64-unsigned-Setup.exe';
  for (const [relativePath, content] of [
    [installerName, 'installer'],
    [`${installerName}.blockmap`, 'blockmap'],
    ['win-unpacked/HTMLlelujah.exe', 'executable'],
    ['win-unpacked/HTMLlelujah-MCP.cmd', 'launcher'],
    ['win-unpacked/resources/app.asar', 'asar'],
  ]) {
    const filePath = path.join(artifactDir, ...relativePath.split('/'));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${content}\n`);
  }
  const inventory = await buildDirectoryInventory(artifactDir);
  const installer = inventory.files.find((entry) => entry.path === installerName);
  const blockmap = inventory.files.find((entry) => entry.path === `${installerName}.blockmap`);
  const unpacked = inventory.files
    .filter((entry) => entry.path.startsWith('win-unpacked/'))
    .map((entry) => ({ ...entry, path: entry.path.slice('win-unpacked/'.length) }));
  const workspacePackages = [
    {
      name: '@htmllelujah/document-core',
      path: 'packages/document-core',
      buildOrder: 1,
      dist: { fileCount: 1, aggregateSha256: '4'.repeat(64) },
    },
  ];
  const provenance = {
    schemaVersion: 2,
    buildId: BUILD_ID,
    sourceCommit: COMMIT,
    sourceDirty: false,
    sourceTreeSha256: TREE_SHA,
    lockfileSha256: LOCK_SHA,
    workspacePackages,
  };
  const candidate = {
    schemaVersion: 2,
    productName: 'HTMLlelujah',
    version: '1.0.0',
    buildId: BUILD_ID,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    source: {
      commit: COMMIT,
      dirty: false,
      treeSha256: TREE_SHA,
      fileCount: 5,
      bytes: 100,
    },
    lockfile: { sha256: LOCK_SHA },
    build: { embeddedProvenance: provenance, workspacePackages },
    artifact: {
      fileCount: inventory.fileCount,
      totalSize: inventory.totalSize,
      aggregateSha256: inventory.aggregateSha256,
      installer,
      blockmap,
      winUnpacked: {
        fileCount: unpacked.length,
        totalSize: unpacked.reduce((sum, entry) => sum + entry.size, 0),
        aggregateSha256: aggregateEvidenceInventory(unpacked),
        files: unpacked,
      },
      files: inventory.files,
    },
  };
  const candidatePath = path.join(evidenceRoot, 'release-candidate-v1.json');
  await writeFile(candidatePath, jsonBytes(candidate));
  const source = {
    commit: COMMIT,
    branch: null,
    exactTag: null,
    dirty: false,
    staged: false,
    unstaged: false,
    untracked: false,
    tree: { sha256: TREE_SHA, fileCount: 5, bytes: 100 },
  };
  return { repositoryRoot, artifactDir, evidenceRoot, candidate, candidatePath, inventory, source };
};

const injectedDependencies = (fixture, runCommand) => {
  let clock = Date.now();
  let monotonicClock = 0;
  return {
    platform: 'win32',
    architecture: 'x64',
    now: () => new Date((clock += 10)),
    monotonicNow: () => (monotonicClock += 10),
    assertReleaseLockHeld: async () => undefined,
    captureSourceSnapshot: async () => ({ ...fixture.source, tree: { ...fixture.source.tree } }),
    gitSourceState: () => ({ commit: COMMIT, dirty: false }),
    buildDirectoryInventory,
    regularFileIdentity: async (filePath) => {
      const bytes = await readFile(filePath);
      const metadata = await stat(filePath);
      return {
        size: metadata.size,
        sha256: path.basename(filePath) === 'pnpm-lock.yaml' ? LOCK_SHA : sha256Bytes(bytes),
        mtimeMs: metadata.mtimeMs,
      };
    },
    sha256File: async (filePath) => sha256Bytes(await readFile(filePath)),
    operatingSystemRelease: () => '10.0.26200',
    operatingSystemVersion: () => 'Windows 11 Enterprise',
    runCommand: async (command) => {
      await runCommand(command);
      if (command.gate.id === 'lan-loopback-soak') {
        clock += 100;
        monotonicClock += 100;
      }
    },
  };
};

test('CLI parser is strict and keeps the 30-minute production default', () => {
  assert.deepEqual(parseCandidateValidationArgs([]), { lanMinutes: 30 });
  assert.deepEqual(parseCandidateValidationArgs(['--lan-minutes', '45']), { lanMinutes: 45 });
  assert.throws(() => parseCandidateValidationArgs(['--unknown']), /Unknown/u);
  assert.throws(() => parseCandidateValidationArgs(['--lan-minutes', '0']), /positive/u);
});

test('command plan exactly covers every required candidate gate', () => {
  const plan = buildCandidateValidationPlan({
    repositoryRoot: 'C:\\fixture',
    executable: 'C:\\fixture\\HTMLlelujah.exe',
    launcher: 'C:\\fixture\\HTMLlelujah-MCP.cmd',
    installer: 'C:\\fixture\\Setup.exe',
    evidenceDirectory: 'C:\\fixture\\evidence',
    lanMinutes: 30,
  });
  assert.deepEqual(
    plan.map((gate) => gate.id),
    REQUIRED_FUNCTIONAL_GATES.map((gate) => gate.id),
  );
  assert.match(plan.at(-1).args.join(' '), /--minutes 30/u);
  assert.deepEqual(plan.find((gate) => gate.id === 'installer-lifecycle').args.slice(-2), [
    'C:\\fixture\\Setup.exe',
    '--final-artifact',
  ]);
  assert.equal(
    plan.find((gate) => gate.id === 'single-instance-final-artifact').args.at(-1),
    '--final-artifact',
  );
});

test('public invocation normalization is independent from the caller working directory', () => {
  const evidenceDirectory = path.resolve('apps', 'desktop', 'scripts');
  const executable = path.resolve('candidate', 'HTMLlelujah.exe');
  const launcher = path.resolve('candidate', 'HTMLlelujah-MCP.cmd');
  const installer = path.resolve('candidate', 'Setup.exe');
  const invocation = normalizedPublicInvocation({
    gate: {
      usesCorepack: true,
      corepackArgsPrefixLength: 1,
      args: [
        path.resolve('runtime', 'corepack.js'),
        'pnpm',
        'exec',
        'tsx',
        path.join('apps', 'desktop', 'scripts', 'benchmark-v1.ts'),
        '--output',
        path.join(evidenceDirectory, 'benchmark-v1.json'),
      ],
      env: {},
    },
    executable,
    launcher,
    installer,
    evidenceDirectory,
  });
  assert.deepEqual(invocation.argv, [
    'pnpm',
    'exec',
    'tsx',
    'apps/desktop/scripts/benchmark-v1.ts',
    '--output',
    '<gate-evidence-report>',
  ]);
});

test(
  'Windows command plan launches Corepack through node and Electron without node-mode contamination',
  { skip: process.platform !== 'win32' },
  async () => {
    const plan = buildCandidateValidationPlan({
      repositoryRoot: process.cwd(),
      executable: 'C:\\candidate\\HTMLlelujah.exe',
      launcher: 'C:\\candidate\\HTMLlelujah-MCP.cmd',
      installer: 'C:\\candidate\\Setup.exe',
      evidenceDirectory: path.join(process.cwd(), 'artifacts', 'evidence'),
      lanMinutes: 30,
    });
    const sourceGate = plan.find((gate) => gate.id === 'source-verify');
    assert.equal(sourceGate.command, process.execPath);
    assert.match(sourceGate.args[0], /corepack[\\/]dist[\\/]corepack\.js$/iu);
    await runValidationCommand({
      command: sourceGate.command,
      args: [sourceGate.args[0], '--version'],
      cwd: process.cwd(),
      env: createCandidateHarnessEnvironment(process.env),
      timeoutMs: 15_000,
      label: 'corepack-real-probe',
    });
    const environment = createCandidateHarnessEnvironment({
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      NODE_OPTIONS: '--trace-warnings',
      VITE_DEV_SERVER_URL: 'http://127.0.0.1:9',
    });
    assert.equal('ELECTRON_RUN_AS_NODE' in environment, false);
    assert.equal('NODE_OPTIONS' in environment, false);
    assert.equal('VITE_DEV_SERVER_URL' in environment, false);
    const desktopRequire = createRequire(
      path.join(process.cwd(), 'apps', 'desktop', 'package.json'),
    );
    const electronPath = desktopRequire('electron');
    const probe = spawnSync(electronPath, ['--version'], {
      cwd: process.cwd(),
      env: environment,
      encoding: 'utf8',
      shell: false,
      timeout: 15_000,
      windowsHide: true,
    });
    assert.equal(probe.status, 0, probe.stderr);
    assert.match(probe.stdout.trim(), /^v43\./u);
  },
);

test('public evidence screening rejects private identity and PNG text metadata', () => {
  assert.deepEqual(publicEvidenceJsonErrors(jsonBytes({ passed: true })), []);
  assert.match(
    publicEvidenceJsonErrors(jsonBytes({ path: 'C:\\Users\\Private\\file.hdeck' })).join(' '),
    /private/u,
  );
  assert.match(
    publicEvidenceJsonErrors(jsonBytes({ hostname: 'private-machine' })).join(' '),
    /identity/u,
  );
  assert.deepEqual(publicPngErrors(PNG), []);
  const textChunk = Buffer.concat([
    PNG.subarray(0, PNG.length - 12),
    Buffer.from('00000004744558747061746800000000', 'hex'),
    PNG.subarray(PNG.length - 12),
  ]);
  assert.match(publicPngErrors(textChunk).join(' '), /metadata/u);
});

test('public ZIP is deterministic, sorted, and rejects traversal', () => {
  const generatedAt = '2026-07-16T20:00:00.000Z';
  const entries = [
    { path: 'b.json', bytes: jsonBytes({ passed: true, order: 2 }) },
    { path: 'a.json', bytes: jsonBytes({ passed: true, order: 1 }) },
  ];
  const first = createPublicEvidenceZip(entries, generatedAt);
  const second = createPublicEvidenceZip(entries.reverse(), generatedAt);
  assert.deepEqual(first, second);
  assert.deepEqual(
    readPublicEvidenceZipEntries(first).map((entry) => entry.path),
    ['a.json', 'b.json'],
  );
  assert.throws(
    () =>
      createPublicEvidenceZip([{ path: '../escape.json', bytes: Buffer.from('{}') }], generatedAt),
    /Unsafe/u,
  );
  assert.throws(
    () => createPublicEvidenceZip([...entries, { ...entries[0] }], generatedAt),
    /unique/u,
  );

  const corruptCrc = Buffer.from(first);
  corruptCrc.writeUInt32LE(corruptCrc.readUInt32LE(14) ^ 1, 14);
  assert.throws(() => readPublicEvidenceZipEntries(corruptCrc), /CRC/u);
  const centralOffset = first.readUInt32LE(first.length - 22 + 16);
  const corruptCentral = Buffer.from(first);
  corruptCentral[centralOffset] ^= 1;
  assert.throws(() => readPublicEvidenceZipEntries(corruptCentral), /central/u);
  assert.throws(
    () => readPublicEvidenceZipEntries(Buffer.concat([first, Buffer.from([0])])),
    /central-directory/u,
  );
  const duplicate = Buffer.from(first);
  const firstNameLength = duplicate.readUInt16LE(26);
  const firstSize = duplicate.readUInt32LE(18);
  const secondLocalOffset = 30 + firstNameLength + firstSize;
  Buffer.from('a.json').copy(duplicate, secondLocalOffset + 30);
  const firstCentralNameLength = duplicate.readUInt16LE(centralOffset + 28);
  const secondCentralOffset = centralOffset + 46 + firstCentralNameLength;
  Buffer.from('a.json').copy(duplicate, secondCentralOffset + 46);
  assert.throws(() => readPublicEvidenceZipEntries(duplicate), /duplicate/u);
});

test('LAN and expanded-limit performance caps are exclusive at their boundaries', () => {
  const startedAt = new Date(Date.now() - 1_000).toISOString();
  const completedAt = new Date(Date.now() + 1_000).toISOString();
  const gate = (id, durationMs = 2_000) => ({ id, startedAt, completedAt, durationMs });
  const evidence = (id, report) => [
    {
      gateId: id,
      role: 'report',
      bytes: jsonBytes(report),
    },
  ];
  const lan = reportForOutput({
    gate: { id: 'lan-loopback-soak' },
    descriptor: { role: 'report' },
    target: {},
    lanDurationMs: 100,
  });
  assert.deepEqual(
    gateReportErrors({
      gate: gate('lan-loopback-soak'),
      evidenceFiles: evidence('lan-loopback-soak', lan),
      target: {},
      minimumLanDurationMs: 10,
      lanMinutes: 100 / 60_000,
    }),
    [],
  );
  assert.match(
    gateReportErrors({
      gate: gate('lan-loopback-soak'),
      evidenceFiles: evidence('lan-loopback-soak', {
        ...lan,
        commandRoundTripMs: { p95: 250 },
      }),
      target: {},
      minimumLanDurationMs: 50,
      lanMinutes: 100 / 60_000,
    }).join(' '),
    /threshold/u,
  );
  assert.match(
    gateReportErrors({
      gate: gate('lan-loopback-soak'),
      evidenceFiles: evidence('lan-loopback-soak', {
        ...lan,
        continuity: {
          ...lan.continuity,
          maximumLoopHiatusMs: 30_000,
          passed: false,
        },
      }),
      target: {},
      minimumLanDurationMs: 50,
      lanMinutes: 100 / 60_000,
    }).join(' '),
    /threshold/u,
  );
  assert.match(
    gateReportErrors({
      gate: gate('lan-loopback-soak', 49),
      evidenceFiles: evidence('lan-loopback-soak', lan),
      target: {},
      minimumLanDurationMs: 50,
      lanMinutes: 100 / 60_000,
    }).join(' '),
    /threshold/u,
  );
  const missingTimestamp = { ...lan };
  delete missingTimestamp.startedAt;
  assert.match(
    gateReportErrors({
      gate: gate('lan-loopback-soak'),
      evidenceFiles: evidence('lan-loopback-soak', missingTimestamp),
      target: {},
      minimumLanDurationMs: 50,
      lanMinutes: 100 / 60_000,
    }).join(' '),
    /timestamp/u,
  );

  const expanded = reportForOutput({
    gate: { id: 'benchmark-expanded-limit' },
    descriptor: { role: 'report' },
    target: {},
    lanDurationMs: 100,
  });
  assert.deepEqual(
    gateReportErrors({
      gate: gate('benchmark-expanded-limit'),
      evidenceFiles: evidence('benchmark-expanded-limit', expanded),
      target: {},
    }),
    [],
  );
  for (const measurements of [
    { ...expanded.measurements, saveMs: 120_000 },
    { ...expanded.measurements, reopenMs: 120_000 },
    { ...expanded.measurements, peakRssMiB: 6_144 },
  ]) {
    assert.match(
      gateReportErrors({
        gate: gate('benchmark-expanded-limit'),
        evidenceFiles: evidence('benchmark-expanded-limit', { ...expanded, measurements }),
        target: {},
      }).join(' '),
      /threshold/u,
    );
  }
});

test('injected runner deletes stale outputs, binds the exact target, and fails closed on tamper', async (t) => {
  const fixture = await createCandidateFixture();
  t.after(() => rm(fixture.repositoryRoot, { recursive: true, force: true }));
  const evidenceDirectory = path.join(fixture.repositoryRoot, 'artifacts', 'evidence');
  await mkdir(evidenceDirectory, { recursive: true });
  const staleUiPath = path.join(evidenceDirectory, 'v1-editor-electron.json');
  await writeFile(staleUiPath, jsonBytes({ passed: true, stale: true }));
  const target = {
    installer: fixture.candidate.artifact.installer,
    blockmap: fixture.candidate.artifact.blockmap,
    executable: fixture.candidate.artifact.files.find(
      (entry) => entry.path === 'win-unpacked/HTMLlelujah.exe',
    ),
    launcher: fixture.candidate.artifact.files.find(
      (entry) => entry.path === 'win-unpacked/HTMLlelujah-MCP.cmd',
    ),
    appAsar: fixture.candidate.artifact.files.find(
      (entry) => entry.path === 'win-unpacked/resources/app.asar',
    ),
    candidateManifestSha256: sha256Bytes(await readFile(fixture.candidatePath)),
  };
  const lanDurationMs = 100;
  let staleWasDeleted = false;
  const runCommand = async ({ gate }) => {
    for (const descriptor of gate.outputs) {
      assert.equal(await exists(descriptor.sourcePath), false, `${gate.id} output was not deleted`);
      if (gate.id === 'ui-packaged' && descriptor.originalName === 'v1-editor-electron.json') {
        staleWasDeleted = true;
      }
      await mkdir(path.dirname(descriptor.sourcePath), { recursive: true });
      const bytes = descriptor.role.includes('screenshot')
        ? PNG
        : jsonBytes(reportForOutput({ gate, descriptor, target, lanDurationMs }));
      await writeFile(descriptor.sourcePath, bytes);
    }
  };
  const result = await runWindowsCandidateValidation(
    {
      repositoryRoot: fixture.repositoryRoot,
      releaseLock: { fixture: true },
      lanMinutes: lanDurationMs / 60_000,
      minimumLanDurationMs: 50,
    },
    injectedDependencies(fixture, runCommand),
  );
  assert.equal(staleWasDeleted, true);
  assert.equal(result.manifest.releaseReady, true);
  assert.equal(result.manifest.gates.length, REQUIRED_FUNCTIONAL_GATES.length);
  assert.deepEqual(result.manifest.coverage.external, EXTERNAL_VALIDATION_LIMITATIONS);
  assert.equal(await exists(staleUiPath), false);
  assert.equal(await exists(result.manifestPath), true);
  assert.equal(await exists(result.bundlePath), true);

  const bundleBytes = await readFile(result.bundlePath);
  const archiveEntries = readPublicEvidenceZipEntries(bundleBytes);
  const metadata = new Map(result.manifest.evidence.files.map((entry) => [entry.path, entry]));
  const evidenceFiles = archiveEntries.map((entry) => ({ ...metadata.get(entry.path), ...entry }));
  const candidateBytes = await readFile(fixture.candidatePath);
  const verification = {
    manifest: result.manifest,
    candidateManifest: fixture.candidate,
    candidateManifestSha256: sha256Bytes(candidateBytes),
    artifactInventory: fixture.inventory,
    source: fixture.source,
    lockfileSha256: LOCK_SHA,
    evidenceFiles,
    bundleBytes,
    expectedEnvironment: result.manifest.environment,
    minimumLanDurationMs: 10,
  };
  assert.doesNotThrow(() => assertFunctionalValidationManifest(verification));
  assert.equal(
    assertFunctionalValidationBundle({ ...verification, evidenceFiles: undefined }).length,
    evidenceFiles.length,
  );
  assert.equal(
    reconstructEvidenceFilesFromBundle({ manifest: result.manifest, bundleBytes }).length,
    evidenceFiles.length,
  );
  const unknownGateEvidence = {
    path: '99-unknown-gate--report.json',
    originalName: 'report.json',
    role: 'report',
    gateId: 'unknown-gate',
    bytes: jsonBytes({ passed: true }),
  };
  const evidenceWithUnknownGate = [...evidenceFiles, unknownGateEvidence].sort((left, right) =>
    left.path.localeCompare(right.path, 'en'),
  );
  const unknownGateInventory = evidenceWithUnknownGate.map((entry) => ({
    path: entry.path,
    size: entry.bytes.length,
    sha256: sha256Bytes(entry.bytes),
    gateId: entry.gateId,
    role: entry.role,
    originalName: entry.originalName,
  }));
  const unknownGateBundle = createPublicEvidenceZip(
    evidenceWithUnknownGate.map((entry) => ({ path: entry.path, bytes: entry.bytes })),
    result.manifest.generatedAt,
  );
  const unknownGateManifest = structuredClone(result.manifest);
  unknownGateManifest.evidence = {
    fileCount: unknownGateInventory.length,
    totalSize: unknownGateInventory.reduce((sum, entry) => sum + entry.size, 0),
    aggregateSha256: aggregateEvidenceInventory(unknownGateInventory),
    files: unknownGateInventory,
  };
  unknownGateManifest.bundle = {
    ...unknownGateManifest.bundle,
    size: unknownGateBundle.length,
    sha256: sha256Bytes(unknownGateBundle),
  };
  assert.match(
    functionalValidationErrors({
      ...verification,
      manifest: unknownGateManifest,
      evidenceFiles: evidenceWithUnknownGate,
      bundleBytes: unknownGateBundle,
    }).join(' '),
    /unsafe|unknown|self-referential/iu,
  );
  const metadataTamper = structuredClone(result.manifest);
  metadataTamper.evidence.files[0].role = 'screenshot';
  assert.throws(
    () =>
      assertFunctionalValidationBundle({
        ...verification,
        manifest: metadataTamper,
        evidenceFiles: undefined,
      }),
    /validation failed/u,
  );
  const reorderedMetadata = structuredClone(result.manifest);
  [reorderedMetadata.evidence.files[0], reorderedMetadata.evidence.files[1]] = [
    reorderedMetadata.evidence.files[1],
    reorderedMetadata.evidence.files[0],
  ];
  assert.throws(
    () => reconstructEvidenceFilesFromBundle({ manifest: reorderedMetadata, bundleBytes }),
    /unsorted/u,
  );
  const corruptBundle = Buffer.from(bundleBytes);
  corruptBundle[14] ^= 1;
  const corruptBundleManifest = structuredClone(result.manifest);
  corruptBundleManifest.bundle.sha256 = sha256Bytes(corruptBundle);
  assert.throws(
    () =>
      reconstructEvidenceFilesFromBundle({
        manifest: corruptBundleManifest,
        bundleBytes: corruptBundle,
      }),
    /CRC/u,
  );

  const cases = [
    ['missing evidence', () => ({ ...verification, evidenceFiles: evidenceFiles.slice(1) })],
    [
      'extra evidence',
      () => ({
        ...verification,
        evidenceFiles: [
          ...evidenceFiles,
          {
            path: 'extra.json',
            originalName: 'extra.json',
            role: 'report',
            gateId: 'source-verify',
            bytes: jsonBytes({ passed: true }),
          },
        ],
      }),
    ],
    [
      'duplicate evidence',
      () => ({ ...verification, evidenceFiles: [...evidenceFiles, evidenceFiles[0]] }),
    ],
    [
      'duplicate gate',
      () => ({
        ...verification,
        manifest: {
          ...result.manifest,
          gates: [result.manifest.gates[0], ...result.manifest.gates],
        },
      }),
    ],
    [
      'stale report',
      () => {
        const stale = structuredClone(result.manifest);
        stale.gates[1].startedAt = '2020-01-01T00:00:00.000Z';
        stale.gates[1].completedAt = '2020-01-01T00:00:01.000Z';
        return { ...verification, manifest: stale };
      },
    ],
    [
      'target mismatch',
      () => ({
        ...verification,
        manifest: {
          ...result.manifest,
          target: { ...result.manifest.target, criticalAggregateSha256: 'f'.repeat(64) },
        },
      }),
    ],
    [
      'LAN threshold fail',
      () => ({ ...verification, minimumLanDurationMs: DEFAULT_LAN_DURATION_MS }),
    ],
    [
      'bundle tamper',
      () => ({
        ...verification,
        bundleBytes: Buffer.concat([bundleBytes, Buffer.from('tamper')]),
      }),
    ],
  ];
  for (const [label, mutate] of cases) {
    assert.ok(functionalValidationErrors(mutate()).length > 0, label);
  }
});

test('failed rerun removes old success and never leaves a stale harness success', async (t) => {
  const fixture = await createCandidateFixture();
  t.after(() => rm(fixture.repositoryRoot, { recursive: true, force: true }));
  const evidenceDirectory = path.join(fixture.repositoryRoot, 'artifacts', 'evidence');
  const finalManifest = path.join(fixture.evidenceRoot, FUNCTIONAL_VALIDATION_FILE_NAME);
  const finalBundle = path.join(fixture.evidenceRoot, FUNCTIONAL_VALIDATION_BUNDLE_NAME);
  const staleUi = path.join(evidenceDirectory, 'v1-editor-electron.json');
  const interruptedTemporaryOutput = path.join(
    evidenceDirectory,
    'v1-editor-electron.json.synthetic.tmp',
  );
  const interruptedDirectory = path.join(evidenceDirectory, 'interrupted', 'nested');
  const interruptedNestedOutput = path.join(interruptedDirectory, 'partial.json');
  await mkdir(evidenceDirectory, { recursive: true });
  await Promise.all([
    writeFile(finalManifest, jsonBytes({ releaseReady: true, stale: true })),
    writeFile(finalBundle, Buffer.from('stale bundle')),
    writeFile(staleUi, jsonBytes({ passed: true, stale: true })),
  ]);
  const runCommand = async ({ gate }) => {
    if (gate.id === 'ui-packaged') {
      assert.equal(await exists(staleUi), false);
      await writeFile(interruptedTemporaryOutput, jsonBytes({ partial: true }));
      await mkdir(interruptedDirectory, { recursive: true });
      await writeFile(interruptedNestedOutput, jsonBytes({ partial: true }));
      throw new Error('injected UI failure');
    }
  };
  await assert.rejects(
    runWindowsCandidateValidation(
      {
        repositoryRoot: fixture.repositoryRoot,
        releaseLock: { fixture: true },
        lanMinutes: 0.001,
        minimumLanDurationMs: 1,
      },
      injectedDependencies(fixture, runCommand),
    ),
    /injected UI failure/u,
  );
  assert.equal(await exists(finalManifest), false);
  assert.equal(await exists(finalBundle), false);
  assert.equal(await exists(staleUi), false);
  assert.equal(await exists(interruptedTemporaryOutput), false);
  assert.equal(await exists(path.join(evidenceDirectory, 'interrupted')), false);
});

test('invalid release lock is rejected before any prior result is touched', async (t) => {
  const fixture = await createCandidateFixture();
  t.after(() => rm(fixture.repositoryRoot, { recursive: true, force: true }));
  const manifestPath = path.join(fixture.evidenceRoot, FUNCTIONAL_VALIDATION_FILE_NAME);
  const bundlePath = path.join(fixture.evidenceRoot, FUNCTIONAL_VALIDATION_BUNDLE_NAME);
  const oldManifest = jsonBytes({ releaseReady: true, prior: true });
  const oldBundle = Buffer.from('prior bundle');
  await Promise.all([writeFile(manifestPath, oldManifest), writeFile(bundlePath, oldBundle)]);
  const dependencies = injectedDependencies(fixture, async () => undefined);
  dependencies.assertReleaseLockHeld = async () => {
    throw new Error('fixture lock is stale');
  };
  await assert.rejects(
    runWindowsCandidateValidation(
      { repositoryRoot: fixture.repositoryRoot, releaseLock: { fixture: true }, lanMinutes: 30 },
      dependencies,
    ),
    /fixture lock is stale/u,
  );
  assert.deepEqual(await readFile(manifestPath), oldManifest);
  assert.deepEqual(await readFile(bundlePath), oldBundle);
});

test('reparse-point evidence root is refused before output mutation', async (t) => {
  const fixture = await createCandidateFixture();
  t.after(() => rm(fixture.repositoryRoot, { recursive: true, force: true }));
  const target = path.join(fixture.repositoryRoot, 'artifacts', 'evidence-real');
  const link = path.join(fixture.repositoryRoot, 'artifacts', 'evidence');
  await mkdir(target, { recursive: true });
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    runWindowsCandidateValidation(
      { repositoryRoot: fixture.repositoryRoot, releaseLock: { fixture: true }, lanMinutes: 30 },
      injectedDependencies(fixture, async () => undefined),
    ),
    /reparse point|not plain/u,
  );
});
