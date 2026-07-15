#!/usr/bin/env node

import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const GENERATOR = path.join(SCRIPT_DIR, 'generate-release-evidence.mjs');
const VERIFIER = path.join(SCRIPT_DIR, 'verify-release-evidence.mjs');

function run(script, arguments_, expectedStatus, expectedText) {
  const result = spawnSync(process.execPath, [script, ...arguments_], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
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
    await writeFile(
      path.join(artifactDir, 'HTMLlelujah-1.0.0-x64-Setup.exe'),
      'synthetic NSIS installer fixture\n',
    );

    const sharedArguments = [
      '--artifact-dir',
      artifactDir,
      '--output-dir',
      evidenceDir,
      '--version',
      '1.0.0-test',
    ];
    run(GENERATOR, sharedArguments, 0, 'Installer detected: yes');
    run(
      VERIFIER,
      ['--artifact-dir', artifactDir, '--evidence-dir', evidenceDir],
      0,
      'Verified 3 artifact files.',
    );

    await appendFile(path.join(resourcesDir, 'app.asar'), 'tampered\n');
    run(
      VERIFIER,
      ['--artifact-dir', artifactDir, '--evidence-dir', evidenceDir],
      1,
      'SHA-256 mismatch',
    );

    await writeFile(path.join(resourcesDir, 'app.asar'), 'synthetic application fixture\n');
    run(GENERATOR, sharedArguments, 0, 'Release ready by evidence policy: no');
    run(
      VERIFIER,
      ['--artifact-dir', artifactDir, '--evidence-dir', evidenceDir, '--require-ready'],
      2,
      'manifest does not describe a fresh candidate with an installer',
    );

    await mkdir(path.join(artifactDir, 'win-unpacked.tmp'));
    run(GENERATOR, sharedArguments, 1, 'Packaging staging directory detected');
    console.log(
      'Release evidence self-test passed: inventory, tamper, policy, and staging guards.',
    );
  } finally {
    await rm(resolvedTemporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Release evidence self-test failed: ${error.message}`);
  process.exitCode = 1;
});
