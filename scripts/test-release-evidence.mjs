#!/usr/bin/env node

import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { pendingPublicDistributionCompliance } from './public-distribution-compliance.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const GENERATOR = path.join(SCRIPT_DIR, 'generate-release-evidence.mjs');
const VERIFIER = path.join(SCRIPT_DIR, 'verify-release-evidence.mjs');

const aggregateInventory = (entries) => {
  const digest = createHash('sha256');
  for (const entry of entries) {
    digest.update(entry.path);
    digest.update('\0');
    digest.update(String(entry.size));
    digest.update('\0');
    digest.update(entry.sha256);
    digest.update('\n');
  }
  return digest.digest('hex');
};

function run(script, arguments_, expectedStatus, expectedText) {
  const result = spawnSync(process.execPath, [script, ...arguments_], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error?.message ?? ''}`;
  if (result.status !== expectedStatus) {
    throw new Error(
      `${path.basename(script)} exited ${result.status}, expected ${expectedStatus}:\n${combined}`,
    );
  }
  if (expectedText && !combined.includes(expectedText)) {
    throw new Error(
      `${path.basename(script)} did not report expected text ${JSON.stringify(expectedText)}:\n${combined}`,
    );
  }
}

async function main() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'htmllelujah-release-evidence-test-'));
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  const requiredPrefix = `${path.resolve(os.tmpdir())}${path.sep}htmllelujah-release-evidence-test-`;
  if (!resolvedTemporaryRoot.startsWith(requiredPrefix)) {
    throw new Error(`Refusing unsafe temporary path: ${resolvedTemporaryRoot}`);
  }

  const artifactDir = path.join(temporaryRoot, 'out');
  const unpackedDir = path.join(artifactDir, 'win-unpacked');
  const resourcesDir = path.join(unpackedDir, 'resources');
  const evidenceDir = path.join(temporaryRoot, 'evidence');

  try {
    await mkdir(resourcesDir, { recursive: true });
    await writeFile(path.join(unpackedDir, 'HTMLlelujah.exe'), 'synthetic executable fixture\n');
    await writeFile(path.join(resourcesDir, 'app.asar'), 'synthetic application fixture\n');
    for (const [name, content] of [
      ['HTMLlelujah-MCP.cmd', '@echo off\n'],
      ['LICENSE.txt', 'Synthetic project license fixture\n'],
      ['COMMERCIAL-LICENSING.md', '# Synthetic commercial licensing fixture\n'],
      ['LICENSE.electron.txt', 'Synthetic Electron license fixture\n'],
      ['LICENSES.chromium.html', '<!doctype html><title>Synthetic notices</title>\n'],
      ['THIRD_PARTY_NOTICES.md', '# Synthetic notices\n'],
    ]) {
      await writeFile(path.join(unpackedDir, name), content);
    }
    const installerPath = path.join(artifactDir, 'HTMLlelujah-1.0.0-test-x64-unsigned-Setup.exe');
    await writeFile(
      installerPath,
      'synthetic NSIS installer fixture: Nullsoft Install System v3.04\n',
    );
    await writeFile(`${installerPath}.blockmap`, '{"synthetic":true}\n');

    const baseArguments = [
      '--artifact-dir',
      artifactDir,
      '--output-dir',
      evidenceDir,
      '--version',
      '1.0.0-test',
    ];
    run(GENERATOR, baseArguments, 0, 'Installer detected: yes');
    const diagnosticManifest = JSON.parse(
      await readFile(path.join(evidenceDir, 'release-manifest.json'), 'utf8'),
    );
    const diagnosticSbom = JSON.parse(
      await readFile(path.join(evidenceDir, 'build-sbom.cdx.json'), 'utf8'),
    );
    assert.equal(diagnosticManifest.quality.releaseReady, false);
    assert.deepEqual(
      diagnosticManifest.quality.publicDistributionCompliance,
      pendingPublicDistributionCompliance(),
    );
    assert.equal(diagnosticManifest.quality.nativeRuntime.passed, false);
    assert.equal(diagnosticManifest.quality.nativeRuntime.componentCount, 0);
    assert.deepEqual(diagnosticSbom.components, []);
    const inventory = JSON.parse(
      await readFile(path.join(evidenceDir, 'content-inventory.json'), 'utf8'),
    );
    const commitResult = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: path.resolve(SCRIPT_DIR, '..'),
      encoding: 'utf8',
      windowsHide: true,
    });
    if (commitResult.status !== 0) throw new Error('Unable to resolve fixture source commit.');
    const sourceCommit = commitResult.stdout.trim();
    const unpacked = inventory.files
      .filter((entry) => entry.path.startsWith('win-unpacked/'))
      .map((entry) => ({ ...entry, path: entry.path.slice('win-unpacked/'.length) }));
    const installer = inventory.files.find((entry) => entry.path === path.basename(installerPath));
    const blockmap = inventory.files.find(
      (entry) => entry.path === `${path.basename(installerPath)}.blockmap`,
    );
    const candidatePath = path.join(temporaryRoot, 'release-candidate-v1.json');
    const sourceTreeSha256 = 'a'.repeat(64);
    const lockfileSha256 = 'b'.repeat(64);
    const workspacePackages = [
      {
        name: '@htmllelujah/fixture',
        path: 'packages/fixture',
        buildOrder: 1,
        dist: { fileCount: 1, totalSize: 1, aggregateSha256: 'c'.repeat(64), files: [] },
      },
    ];
    await writeFile(
      candidatePath,
      `${JSON.stringify(
        {
          schemaVersion: 2,
          productName: 'HTMLlelujah',
          version: '1.0.0-test',
          buildId: 'synthetic-build',
          source: {
            commit: sourceCommit,
            dirty: false,
            treeSha256: sourceTreeSha256,
            fileCount: 1,
            bytes: 1,
          },
          lockfile: { sha256: lockfileSha256 },
          build: {
            embeddedProvenance: {
              schemaVersion: 2,
              buildId: 'synthetic-build',
              sourceCommit,
              sourceDirty: false,
              sourceTreeSha256,
              lockfileSha256,
              workspacePackages,
            },
            workspacePackages,
          },
          artifact: {
            fileCount: inventory.fileCount,
            totalSize: inventory.totalSize,
            aggregateSha256: inventory.aggregateSha256,
            installer,
            blockmap,
            winUnpacked: {
              fileCount: unpacked.length,
              totalSize: unpacked.reduce((sum, entry) => sum + entry.size, 0),
              aggregateSha256: aggregateInventory(unpacked),
              files: unpacked,
            },
            files: inventory.files,
          },
        },
        null,
        2,
      )}\n`,
    );
    const sharedArguments = [
      ...baseArguments,
      '--candidate-manifest',
      candidatePath,
      '--require-candidate-manifest',
    ];
    run(GENERATOR, sharedArguments, 0, 'Installer detected: yes');
    const candidateDiagnosticManifest = JSON.parse(
      await readFile(path.join(evidenceDir, 'release-manifest.json'), 'utf8'),
    );
    assert.equal(candidateDiagnosticManifest.quality.candidateManifestPresent, true);
    assert.equal(candidateDiagnosticManifest.quality.nativeRuntime.passed, false);
    assert.equal(candidateDiagnosticManifest.quality.releaseReady, false);
    run(VERIFIER, ['--artifact-dir', artifactDir, '--evidence-dir', evidenceDir], 0, 'Verified ');

    const manifestPath = path.join(evidenceDir, 'release-manifest.json');
    const mismatchedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    mismatchedManifest.quality.releaseReady = true;
    mismatchedManifest.quality.candidatePolicy.passed = true;
    await writeFile(manifestPath, `${JSON.stringify(mismatchedManifest, null, 2)}\n`, 'utf8');
    run(
      VERIFIER,
      ['--artifact-dir', artifactDir, '--evidence-dir', evidenceDir],
      1,
      'releaseReady contradicts pending public-distribution compliance',
    );
    mismatchedManifest.quality.releaseReady = false;
    mismatchedManifest.release.source.commit = '0000000000000000000000000000000000000000';
    await writeFile(manifestPath, `${JSON.stringify(mismatchedManifest, null, 2)}\n`, 'utf8');
    run(
      VERIFIER,
      ['--artifact-dir', artifactDir, '--evidence-dir', evidenceDir, '--require-ready'],
      2,
      'source commit mismatch',
    );

    run(GENERATOR, sharedArguments, 0, 'Installer detected: yes');
    const oldTimestamp = new Date('2000-01-01T00:00:00.000Z');
    await utimes(installerPath, oldTimestamp, oldTimestamp);
    run(
      VERIFIER,
      ['--artifact-dir', artifactDir, '--evidence-dir', evidenceDir, '--require-ready'],
      2,
      'current source inputs are newer than the artifact',
    );
    run(GENERATOR, [...sharedArguments, '--require-fresh'], 2, 'Artifact stale: yes');
    const currentTimestamp = new Date();
    await utimes(installerPath, currentTimestamp, currentTimestamp);
    run(GENERATOR, sharedArguments, 0, 'Installer detected: yes');

    await appendFile(path.join(resourcesDir, 'app.asar'), 'tampered\n');
    run(
      VERIFIER,
      ['--artifact-dir', artifactDir, '--evidence-dir', evidenceDir],
      1,
      'SHA-256 mismatch',
    );

    await writeFile(path.join(resourcesDir, 'app.asar'), 'synthetic application fixture\n');
    run(GENERATOR, sharedArguments, 0, 'Installer detected: yes');

    const builderDebugPath = path.join(artifactDir, 'builder-debug.yml');
    await writeFile(builderDebugPath, 'source: C:\\Users\\PrivateUser\\project\n', 'utf8');
    run(GENERATOR, sharedArguments, 1, 'forbidden build metadata');
    await rm(builderDebugPath, { force: true });

    await mkdir(path.join(artifactDir, 'win-unpacked.tmp'));
    run(GENERATOR, sharedArguments, 1, 'Packaging staging directory detected');
    console.log(
      'Release evidence self-test passed: inventory, current-source readiness, hygiene, tamper, and staging guards.',
    );
  } finally {
    await rm(resolvedTemporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Release evidence self-test failed: ${error.message}`);
  process.exitCode = 1;
});
