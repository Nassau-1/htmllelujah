import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  canonicalJson,
  EXPECTED_SBOM_GENERATOR_COMMAND,
  inspectDependencySbom,
  LOCKFILE_HASH_PROPERTY,
  PACKAGE_MANAGER_PROPERTY,
  SBOM_GENERATOR_PROPERTY,
  SBOM_SCOPE_PROPERTY,
} from './security-release-evidence-support.mjs';
import { resolveCorepackInvocation } from './windows-release-pipeline-support.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const defaultOutputPath = path.join(repositoryRoot, 'artifacts', 'sbom.cdx.json');

export const defaultSbomCommand = ({ resolve = resolveCorepackInvocation } = {}) => {
  const invocation = resolve();
  return {
    command: invocation.command,
    args: [
      ...invocation.argsPrefix,
      'pnpm',
      'sbom',
      '--sbom-format',
      'cyclonedx',
      '--prod',
      '--sbom-type',
      'application',
    ],
  };
};

export const generateSbom = async ({
  cwd = repositoryRoot,
  outputPath = defaultOutputPath,
  commandSpec = defaultSbomCommand(),
  lockfilePath = path.join(cwd, 'pnpm-lock.yaml'),
  packageManager,
  lockfileBytes,
} = {}) => {
  const resolvedOutputPath = path.resolve(outputPath);
  await mkdir(path.dirname(resolvedOutputPath), { recursive: true });

  const output = await open(resolvedOutputPath, 'w');
  let stderr = '';
  let result;
  let commandError;
  try {
    result = await new Promise((resolve, reject) => {
      const child = spawn(commandSpec.command, commandSpec.args, {
        cwd,
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          NO_COLOR: '1',
        },
        windowsHide: true,
        stdio: ['ignore', output.fd, 'pipe'],
      });
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-8_000);
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
  } catch (error) {
    commandError = error;
  } finally {
    await output.close();
  }

  if (commandError !== undefined) {
    await rm(resolvedOutputPath, { force: true });
    throw new Error('SBOM generator process could not be executed.', { cause: commandError });
  }

  if (result.code !== 0) {
    await rm(resolvedOutputPath, { force: true });
    throw new Error(
      `SBOM generation exited with ${String(result.code ?? result.signal)}.` +
        (stderr === '' ? '' : ` ${stderr.trim()}`),
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(await readFile(resolvedOutputPath, 'utf8'));
  } catch (error) {
    await rm(resolvedOutputPath, { force: true });
    throw new Error('SBOM generation did not produce valid JSON.', { cause: error });
  }
  if (parsed?.bomFormat !== 'CycloneDX') {
    await rm(resolvedOutputPath, { force: true });
    throw new Error('SBOM generation did not produce a CycloneDX document.');
  }

  try {
    const exactPackageManager =
      packageManager ??
      JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8')).packageManager;
    if (typeof exactPackageManager !== 'string' || !/^pnpm@[^\s]+$/u.test(exactPackageManager)) {
      throw new Error('SBOM generation requires an exact pnpm packageManager declaration.');
    }
    const exactLockfileBytes = lockfileBytes ?? (await readFile(lockfilePath));
    const lockfileSha256 = createHash('sha256').update(exactLockfileBytes).digest('hex');
    const properties = (
      Array.isArray(parsed.metadata?.properties) ? parsed.metadata.properties : []
    ).filter(
      (entry) =>
        entry?.name !== LOCKFILE_HASH_PROPERTY &&
        entry?.name !== PACKAGE_MANAGER_PROPERTY &&
        entry?.name !== SBOM_GENERATOR_PROPERTY &&
        entry?.name !== SBOM_SCOPE_PROPERTY,
    );
    properties.push(
      { name: LOCKFILE_HASH_PROPERTY, value: lockfileSha256 },
      { name: PACKAGE_MANAGER_PROPERTY, value: exactPackageManager },
      { name: SBOM_GENERATOR_PROPERTY, value: EXPECTED_SBOM_GENERATOR_COMMAND },
      { name: SBOM_SCOPE_PROPERTY, value: 'production' },
    );
    properties.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    parsed.metadata = { ...(parsed.metadata ?? {}), properties };
    await writeFile(resolvedOutputPath, canonicalJson(parsed), 'utf8');
    inspectDependencySbom({
      bytes: await readFile(resolvedOutputPath),
      expectedLockfileSha256: lockfileSha256,
      expectedPackageManager: exactPackageManager,
    });
  } catch (error) {
    await rm(resolvedOutputPath, { force: true });
    throw new Error('SBOM binding or graph validation failed.', { cause: error });
  }

  return resolvedOutputPath;
};

const parseArgs = (argv) => {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      process.stdout.write(
        'Usage: node scripts/generate-sbom.mjs [--output <path>] [--lockfile <path>]\n',
      );
      process.exit(0);
    }
    if (argument === '--output' || argument === '--lockfile') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}.`);
      index += 1;
      if (argument === '--output') options.outputPath = path.resolve(value);
      else options.lockfilePath = path.resolve(value);
      continue;
    }
    throw new Error(`Unknown option: ${argument}.`);
  }
  return options;
};

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const outputPath = await generateSbom(parseArgs(process.argv.slice(2)));
  process.stdout.write(`CycloneDX SBOM generated: ${outputPath}\n`);
}
