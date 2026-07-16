import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { generateSbom } from './generate-sbom.mjs';

test('generateSbom creates a missing artifacts directory before piping command output', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'htmllelujah-sbom-test-'));
  const outputPath = path.join(root, 'nested', 'artifacts', 'sbom.cdx.json');
  const fixture = JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.6' });

  try {
    const generatedPath = await generateSbom({
      cwd: root,
      outputPath,
      commandSpec: {
        command: process.execPath,
        args: ['-e', `process.stdout.write(${JSON.stringify(fixture)})`],
      },
    });

    assert.equal(generatedPath, path.resolve(outputPath));
    assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), {
      bomFormat: 'CycloneDX',
      specVersion: '1.6',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('generateSbom removes an invalid partial artifact', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'htmllelujah-sbom-test-'));
  const outputPath = path.join(root, 'artifacts', 'sbom.cdx.json');

  try {
    await assert.rejects(
      generateSbom({
        cwd: root,
        outputPath,
        commandSpec: {
          command: process.execPath,
          args: ['-e', "process.stdout.write('not-json')"],
        },
      }),
      /did not produce valid JSON/u,
    );
    await assert.rejects(readFile(outputPath), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('generateSbom removes its output when the generator cannot be started', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'htmllelujah-sbom-test-'));
  const outputPath = path.join(root, 'artifacts', 'sbom.cdx.json');

  try {
    await assert.rejects(
      generateSbom({
        cwd: root,
        outputPath,
        commandSpec: {
          command: path.join(root, 'missing-sbom-generator.exe'),
          args: [],
        },
      }),
      /generator process could not be executed/u,
    );
    await assert.rejects(readFile(outputPath), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
