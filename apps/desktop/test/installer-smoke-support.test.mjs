import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertCleanSourceState,
  assertOwnedTemporaryPath,
  assertReleaseCandidateManifest,
  assertSourceStateUnchanged,
  assertStableArtifact,
  assertStableHarnessManifest,
  captureCreatedProductRegistryIdentities,
  expectedInstallerRegistryKeys,
  expectedUnsignedInstallerName,
  newTemporaryEntries,
  normalizeJsonArray,
  parseInstallerSmokeArguments,
  remainingCapturedRegistryIdentities,
  selectOwnedProcessRecords,
  sameAssociationState,
} from '../scripts/installer-smoke-support.mjs';

describe('Windows installer lifecycle smoke support', () => {
  it('requires an explicit final-artifact gate and exactly one installer', () => {
    const fallback = path.resolve('candidate.exe');
    expect(() => parseInstallerSmokeArguments([], fallback)).toThrow(/--final-artifact/u);
    expect(() =>
      parseInstallerSmokeArguments(['one.exe', 'two.exe', '--final-artifact'], fallback),
    ).toThrow(/Only one installer/u);
    expect(() => parseInstallerSmokeArguments(['--unknown', '--final-artifact'], fallback)).toThrow(
      /Unknown/u,
    );
    expect(parseInstallerSmokeArguments(['release.exe', '--final-artifact'], fallback)).toEqual({
      installer: path.resolve('release.exe'),
      finalArtifact: true,
    });
  });

  it('binds the accepted artifact name to the desktop package version', () => {
    expect(expectedUnsignedInstallerName('1.0.0')).toBe('HTMLlelujah-1.0.0-x64-unsigned-Setup.exe');
  });

  it('allows deletion only for an owned child of the Windows temporary directory', () => {
    const temporaryDirectory = path.resolve('C:\\Temp');
    const owned = path.join(temporaryDirectory, 'htmllelujah-installer-smoke-abc');
    expect(
      assertOwnedTemporaryPath(owned, temporaryDirectory, 'htmllelujah-installer-smoke-'),
    ).toBe(path.resolve(owned));
    expect(() =>
      assertOwnedTemporaryPath(
        temporaryDirectory,
        temporaryDirectory,
        'htmllelujah-installer-smoke-',
      ),
    ).toThrow(/unsafe/u);
    expect(() =>
      assertOwnedTemporaryPath(
        path.join(temporaryDirectory, '..', 'foreign'),
        temporaryDirectory,
        'htmllelujah-installer-smoke-',
      ),
    ).toThrow(/unsafe/u);
    expect(() =>
      assertOwnedTemporaryPath(
        path.join(temporaryDirectory, 'foreign'),
        temporaryDirectory,
        'htmllelujah-installer-smoke-',
      ),
    ).toThrow(/unsafe/u);
  });

  it('detects newly leaked temporary entries without blaming an existing entry', () => {
    expect(newTemporaryEntries(new Set(['old']), new Set(['old', 'leak-b', 'leak-a']))).toEqual([
      'leak-a',
      'leak-b',
    ]);
  });

  it('requires the foreign association baseline to be restored exactly', () => {
    const baseline = {
      extensionKeyRegistered: true,
      openWithKeyRegistered: true,
      extensionDefault: 'Another.Editor',
      openWithProgIds: ['Another.Editor'],
      productClassRegistered: false,
    };
    expect(
      sameAssociationState(baseline, { ...baseline, openWithProgIds: ['Another.Editor'] }),
    ).toBe(true);
    expect(
      sameAssociationState(baseline, {
        ...baseline,
        openWithProgIds: ['Another.Editor', 'HTMLlelujah presentation'],
      }),
    ).toBe(false);
    expect(sameAssociationState(baseline, { ...baseline, openWithKeyRegistered: false })).toBe(
      false,
    );
  });

  it('selects only exact product executables with stable creation identities', () => {
    const installedExecutable = 'C:\\Temp\\HTMLlelujah\\HTMLlelujah.exe';
    const records = [
      {
        processId: 10,
        parentProcessId: 1,
        createdAtMs: 2_000,
        executablePath: installedExecutable,
      },
      {
        processId: 11,
        parentProcessId: 10,
        createdAtMs: 2_001,
        executablePath: installedExecutable.toUpperCase(),
      },
      {
        processId: 12,
        parentProcessId: 10,
        createdAtMs: 2_002,
        executablePath: 'C:\\Windows\\System32\\WerFault.exe',
      },
      {
        processId: 20,
        parentProcessId: 10,
        createdAtMs: 1_000,
        executablePath: 'C:\\Windows\\System32\\notepad.exe',
        commandLine: `notepad.exe ${path.dirname(installedExecutable)}`,
      },
      { processId: 21, parentProcessId: 10, executablePath: installedExecutable },
    ];

    expect(
      selectOwnedProcessRecords(records, installedExecutable).map((entry) => entry.processId),
    ).toEqual([10, 11]);
  });

  it('derives the exact collision keys from the pinned NSIS GUID', () => {
    expect(expectedInstallerRegistryKeys('7bf3c6ec-651b-477c-a0b7-399160cda612')).toEqual({
      install: 'Software\\7bf3c6ec-651b-477c-a0b7-399160cda612',
      uninstall:
        'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\7bf3c6ec-651b-477c-a0b7-399160cda612',
    });
    expect(() => expectedInstallerRegistryKeys('not-a-guid')).toThrow(/GUID/u);
  });

  it('binds the candidate manifest to source, lockfile, installer, and companion payload', () => {
    const identity = { sha256: 'a'.repeat(64), size: 100, mtimeMs: 123 };
    const workspacePackages = [
      {
        name: '@htmllelujah/document-core',
        path: 'packages/document-core',
        buildOrder: 1,
        dist: { fileCount: 1, aggregateSha256: 'f'.repeat(64) },
      },
    ];
    const expected = {
      productName: 'HTMLlelujah',
      version: '1.0.0',
      source: { commit: 'b'.repeat(40), treeSha256: 'c'.repeat(64), fileCount: 10, bytes: 20 },
      lockfileSha256: 'd'.repeat(64),
      embeddedProvenance: {
        schemaVersion: 2,
        sourceCommit: 'b'.repeat(40),
        workspacePackages,
      },
      installer: { path: 'candidate.exe', ...identity },
      blockmap: { path: 'candidate.exe.blockmap', ...identity },
      companion: { executable: identity, appAsar: identity },
    };
    const manifest = {
      schemaVersion: 2,
      productName: expected.productName,
      version: expected.version,
      source: { ...expected.source, dirty: false },
      lockfile: { path: 'pnpm-lock.yaml', sha256: expected.lockfileSha256 },
      build: {
        embeddedProvenance: expected.embeddedProvenance,
        workspacePackages,
      },
      artifact: {
        fileCount: 4,
        aggregateSha256: 'e'.repeat(64),
        installer: expected.installer,
        blockmap: expected.blockmap,
        winUnpacked: {
          fileCount: 2,
          aggregateSha256: 'f'.repeat(64),
          files: [
            { path: 'HTMLlelujah.exe', ...identity },
            { path: 'resources/app.asar', ...identity },
          ],
        },
        files: [
          expected.installer,
          expected.blockmap,
          { path: 'win-unpacked/HTMLlelujah.exe', ...identity },
          { path: 'win-unpacked/resources/app.asar', ...identity },
        ],
      },
    };
    expect(() => assertReleaseCandidateManifest(manifest, expected)).not.toThrow();
    expect(() =>
      assertReleaseCandidateManifest(
        {
          ...manifest,
          artifact: {
            ...manifest.artifact,
            installer: { ...manifest.artifact.installer, sha256: '0'.repeat(64) },
          },
        },
        expected,
      ),
    ).toThrow(/not bound/u);
  });

  it('fails closed when source or release-harness identity changes', () => {
    const clean = { commit: 'a'.repeat(40), dirty: false };
    expect(() => assertCleanSourceState(clean)).not.toThrow();
    expect(() => assertCleanSourceState({ ...clean, dirty: true })).toThrow(/clean/u);
    expect(() => assertSourceStateUnchanged(clean, clean)).not.toThrow();
    expect(() =>
      assertSourceStateUnchanged(clean, { commit: 'b'.repeat(40), dirty: false }),
    ).toThrow(/changed/u);
    expect(() => assertStableHarnessManifest([{ sha256: 'a' }], [{ sha256: 'a' }])).not.toThrow();
    expect(() => assertStableHarnessManifest([{ sha256: 'a' }], [{ sha256: 'b' }])).toThrow(
      /changed/u,
    );
  });

  it('tracks exact created registry keys after their identifying values disappear', () => {
    const before = {
      installKeyIdentities: [{ hive: 'HKCU', key: 'Existing' }],
      uninstallKeyIdentities: [{ hive: 'HKCU', key: 'ExistingUninstall' }],
    };
    const installed = {
      installRecords: [{ hive: 'HKCU', key: 'HTMLlelujah' }],
      uninstallRecords: [{ hive: 'HKCU', key: '{PRODUCT-GUID}' }],
      installKeyIdentities: [...before.installKeyIdentities, { hive: 'HKCU', key: 'HTMLlelujah' }],
      uninstallKeyIdentities: [
        ...before.uninstallKeyIdentities,
        { hive: 'HKCU', key: '{PRODUCT-GUID}' },
      ],
    };
    const captured = captureCreatedProductRegistryIdentities(before, installed);
    const emptiedButPresent = {
      installRecords: [],
      uninstallRecords: [],
      installKeyIdentities: installed.installKeyIdentities,
      uninstallKeyIdentities: installed.uninstallKeyIdentities,
    };
    expect(remainingCapturedRegistryIdentities(captured, emptiedButPresent)).toHaveLength(2);
    expect(remainingCapturedRegistryIdentities(captured, before)).toEqual([]);
  });

  it('rejects an artifact whose bytes, length, or timestamp changed', () => {
    const artifact = { sha256: 'a'.repeat(64), size: 10, mtimeMs: 100 };
    expect(() => assertStableArtifact(artifact, { ...artifact })).not.toThrow();
    expect(() => assertStableArtifact(artifact, { ...artifact, sha256: 'b'.repeat(64) })).toThrow(
      /changed/u,
    );
    expect(() => assertStableArtifact(artifact, { ...artifact, size: 11 })).toThrow(/changed/u);
    expect(() => assertStableArtifact(artifact, { ...artifact, mtimeMs: 101 })).toThrow(/changed/u);
  });

  it('normalizes PowerShell singleton JSON values into arrays', () => {
    expect(normalizeJsonArray(undefined)).toEqual([]);
    expect(normalizeJsonArray({ id: 1 })).toEqual([{ id: 1 }]);
    expect(normalizeJsonArray([{ id: 1 }])).toEqual([{ id: 1 }]);
  });

  it('keeps release evidence fail-closed and after every residual check', async () => {
    const source = await readFile(
      new URL('../scripts/smoke-installer-windows.mjs', import.meta.url),
      'utf8',
    );
    const removeStaleEvidence = source.indexOf('await rm(evidencePath, { force: true })');
    const lifecycle = source.indexOf("await stage('install'");
    const finalResidualCheck = source.indexOf('assertStableArtifact(artifactBefore');
    const failureGate = source.indexOf(
      'Windows installer lifecycle smoke failed; no evidence was written.',
    );
    const evidenceWrite = source.indexOf('await writeFile(evidenceTemporary');

    expect(removeStaleEvidence).toBeGreaterThan(-1);
    expect(lifecycle).toBeGreaterThan(removeStaleEvidence);
    expect(finalResidualCheck).toBeGreaterThan(lifecycle);
    expect(failureGate).toBeGreaterThan(finalResidualCheck);
    expect(evidenceWrite).toBeGreaterThan(failureGate);
    expect(source).toContain(
      'assertStableArtifact(artifactBefore, await artifactIdentity(installer))',
    );
    expect(source).toContain(
      'assertSourceStateUnchanged(sourceBefore, inspectGitSourceState(repositoryRoot))',
    );
    expect(source).toContain(
      'assertStableHarnessManifest(harnessBefore.files, harnessAfter.files)',
    );
    expect(source).toContain('await rename(evidenceTemporary, evidencePath)');
    expect(source).toContain("'release-evidence',");
    expect(source).not.toContain("path.join(desktopRoot, 'out', 'release-candidate-v1.json')");
    expect(source).toContain('readPackagedBuildProvenance(companionAsarPath, desktopRoot)');
    expect(source).toContain('readPackagedBuildProvenance(installedAsarPath, desktopRoot)');
  });

  it('contains distinct real repair, upgrade-like, recovery, and uninstall gates', async () => {
    const source = await readFile(
      new URL('../scripts/smoke-installer-windows.mjs', import.meta.url),
      'utf8',
    );

    expect(source).toContain("await stage('repairRerun'");
    expect(source).toContain("await stage('upgradeLikeReinstall'");
    expect(source).toContain("await stage('uninstall'");
    expect(source).toContain('await rm(noticePath, { force: true })');
    expect(source).toContain('if (await exists(obsoletePayload))');
    expect(source).toContain('await inspectRecoverySentinel(recovery, true)');
    expect(source).toContain(`installedExecutableRecoveryExecution: 'not-tested'`);
  });

  it('requires a non-elevated HKCU install and checks every owned residue class', async () => {
    const source = await readFile(
      new URL('../scripts/smoke-installer-windows.mjs', import.meta.url),
      'utf8',
    );

    expect(source).toContain('if (token.isElevated || token.isSystem)');
    expect(source).toContain("entry.hive === 'HKCU'");
    expect(source).toContain("entry.hive === 'HKLM'");
    expect(source).toContain('assertNoProductRegistry(');
    expect(source).toContain('assertNoShortcuts(shortcutState(installedExecutable))');
    expect(source).toContain('productProcesses(installedExecutable).length > 0');
    expect(source).toContain('namedProductProcesses().length > 0');
    expect(source).not.toContain('CommandLine.IndexOf($directory');
    expect(source).toContain('assertNoExpectedRegistryCollisions(');
    expect(source).toContain('terminateExactProductProcess(');
    expect(source).not.toContain('terminateProcessTree(entry.processId)');
    expect(source).not.toContain("spawnSync('taskkill'");
    expect(source).toContain("child.kill('SIGKILL')");
    expect(source).toContain('sha256: await sha256(absolute)');
    expect(source).toContain('application-data snapshot exceeds its byte budget');
    expect(source).toContain('captureCreatedProductRegistryIdentities(');
    expect(source).toContain('remainingCapturedRegistryIdentities(');
    expect(source).toContain('newTemporaryEntries(');
    expect(source).toContain('sameTreeSnapshot(applicationDataBefore, applicationDataAfter)');
  });
});
