import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertOwnedTemporaryPath,
  assertStableArtifact,
  expectedUnsignedInstallerName,
  newTemporaryEntries,
  normalizeJsonArray,
  parseInstallerSmokeArguments,
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
    expect(source).toContain('await rename(evidenceTemporary, evidencePath)');
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
    expect(source).toContain('await manager.listRecoveryCandidatesMainOnly()');
    expect(source).toContain('await manager.recoverMainOnly(recovery.candidateId)');
    expect(source).toContain('await manager.close(recovery.candidateId, { discardUnsaved: true })');
  });

  it('requires a non-elevated HKCU install and checks every owned residue class', async () => {
    const source = await readFile(
      new URL('../scripts/smoke-installer-windows.mjs', import.meta.url),
      'utf8',
    );

    expect(source).toContain('if (token.isElevated || token.isSystem)');
    expect(source).toContain("entry.hive === 'HKCU'");
    expect(source).toContain("entry.hive === 'HKLM'");
    expect(source).toContain('assertNoProductRegistry(registryState(installDirectory)');
    expect(source).toContain('assertNoShortcuts(shortcutState(installedExecutable))');
    expect(source).toContain('productProcesses(installDirectory, installedExecutable).length > 0');
    expect(source).toContain('namedProductProcesses().length > 0');
    expect(source).toContain('newTemporaryEntries(');
    expect(source).toContain('sameTreeSnapshot(applicationDataBefore, applicationDataAfter)');
  });
});
