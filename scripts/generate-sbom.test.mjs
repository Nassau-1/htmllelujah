import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { defaultSbomCommand, generateSbom } from './generate-sbom.mjs';
import { inspectDependencySbom } from './security-release-evidence-support.mjs';

const fixtureSbom = () => ({
  bomFormat: 'CycloneDX',
  specVersion: '1.7',
  serialNumber: 'urn:uuid:00000000-0000-4000-8000-000000000001',
  version: 1,
  metadata: {
    component: { type: 'application', name: 'fixture', 'bom-ref': 'fixture@1.0.0' },
  },
  components: [
    {
      type: 'library',
      name: 'dependency',
      version: '1.2.3',
      purl: 'pkg:npm/dependency@1.2.3',
      'bom-ref': 'pkg:npm/dependency@1.2.3',
    },
  ],
  dependencies: [
    { ref: 'fixture@1.0.0', dependsOn: ['pkg:npm/dependency@1.2.3'] },
    { ref: 'pkg:npm/dependency@1.2.3', dependsOn: [] },
  ],
});

test('default SBOM command resolves Corepack directly and ignores inherited pnpm launchers', () => {
  const originalNpmExecPath = process.env.npm_execpath;
  process.env.npm_execpath = 'C:\\poisoned\\pnpm.cjs';
  try {
    assert.deepEqual(
      defaultSbomCommand({
        resolve: () => ({ command: process.execPath, argsPrefix: ['C:\\corepack\\corepack.js'] }),
      }),
      {
        command: process.execPath,
        args: [
          'C:\\corepack\\corepack.js',
          'pnpm',
          'sbom',
          '--sbom-format',
          'cyclonedx',
          '--prod',
          '--sbom-type',
          'application',
        ],
      },
    );
  } finally {
    if (originalNpmExecPath === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = originalNpmExecPath;
  }
});

test('generateSbom creates a missing artifacts directory before piping command output', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'htmllelujah-sbom-test-'));
  const outputPath = path.join(root, 'nested', 'artifacts', 'sbom.cdx.json');
  const fixture = JSON.stringify(fixtureSbom());
  const lockfileBytes = Buffer.from('lockfileVersion: 9.0\n');

  try {
    const generatedPath = await generateSbom({
      cwd: root,
      outputPath,
      commandSpec: {
        command: process.execPath,
        args: ['-e', `process.stdout.write(${JSON.stringify(fixture)})`],
      },
      packageManager: 'pnpm@11.13.0',
      lockfileBytes,
    });

    assert.equal(generatedPath, path.resolve(outputPath));
    const bytes = await readFile(outputPath);
    const identity = inspectDependencySbom({
      bytes,
      expectedLockfileSha256: createHash('sha256').update(lockfileBytes).digest('hex'),
      expectedPackageManager: 'pnpm@11.13.0',
    });
    assert.equal(identity.componentCount, 1);
    assert.equal(identity.dependencyEdgeCount, 1);
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

test('generateSbom removes output when the dependency graph is dangling', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'htmllelujah-sbom-test-'));
  const outputPath = path.join(root, 'artifacts', 'dependency-sbom.cdx.json');
  const malformed = fixtureSbom();
  malformed.dependencies[0].dependsOn = ['pkg:npm/missing@9.9.9'];

  try {
    await assert.rejects(
      generateSbom({
        cwd: root,
        outputPath,
        commandSpec: {
          command: process.execPath,
          args: ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(malformed))})`],
        },
        packageManager: 'pnpm@11.13.0',
        lockfileBytes: Buffer.from('lockfileVersion: 9.0\n'),
      }),
      /binding or graph validation failed/u,
    );
    await assert.rejects(readFile(outputPath), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('generateSbom removes output when the exact lockfile is missing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'htmllelujah-sbom-test-'));
  const outputPath = path.join(root, 'artifacts', 'dependency-sbom.cdx.json');

  try {
    await assert.rejects(
      generateSbom({
        cwd: root,
        outputPath,
        commandSpec: {
          command: process.execPath,
          args: ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(fixtureSbom()))})`],
        },
        packageManager: 'pnpm@11.13.0',
        lockfilePath: path.join(root, 'missing-lockfile.yaml'),
      }),
      /binding or graph validation failed/u,
    );
    await assert.rejects(readFile(outputPath), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
