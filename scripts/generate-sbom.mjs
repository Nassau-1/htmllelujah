import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const defaultOutputPath = path.join(repositoryRoot, 'artifacts', 'sbom.cdx.json');

const defaultCommand = () => {
  const pnpmCli = process.env.npm_execpath;
  if (pnpmCli !== undefined && pnpmCli !== '') {
    return {
      command: process.execPath,
      args: [pnpmCli, 'sbom', '--sbom-format', 'cyclonedx', '--prod', '--sbom-type', 'application'],
    };
  }

  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        'corepack pnpm sbom --sbom-format cyclonedx --prod --sbom-type application',
      ],
    };
  }

  return {
    command: 'corepack',
    args: ['pnpm', 'sbom', '--sbom-format', 'cyclonedx', '--prod', '--sbom-type', 'application'],
  };
};

export const generateSbom = async ({
  cwd = repositoryRoot,
  outputPath = defaultOutputPath,
  commandSpec = defaultCommand(),
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

  return resolvedOutputPath;
};

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const outputPath = await generateSbom();
  process.stdout.write(`CycloneDX SBOM generated: ${outputPath}\n`);
}
