import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = JSON.parse(readFileSync(path.join(root, 'policy', 'licenses.json'), 'utf8'));
const workspaceRoots = ['apps', 'packages'].flatMap((directory) => {
  const absoluteDirectory = path.join(root, directory);
  if (!existsSync(absoluteDirectory)) return [];

  return readdirSync(absoluteDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(absoluteDirectory, entry.name))
    .filter((directoryPath) => existsSync(path.join(directoryPath, 'package.json')));
});

const allowedRuntime = new Set(policy.allowed);
const allowedDevelopment = new Set([...policy.allowed, ...Object.keys(policy.reviewedBuildOnly)]);
const failures = [];
const projectLicenseIdentifier = 'PolyForm-Noncommercial-1.0.0';
const projectRequiredNotice = 'Required Notice: Copyright (c) 2026 Nassau-1.';
const canonicalProjectLicenseSha256 =
  'c0ea4a896d2c8c394b29f9427589996db826cd501c512279ff0ed3ef48fabbe5';

for (const manifestPath of [
  path.join(root, 'package.json'),
  ...workspaceRoots.map((workspaceRoot) => path.join(workspaceRoot, 'package.json')),
]) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.license !== projectLicenseIdentifier) {
    failures.push(
      `first-party - ${path.relative(root, manifestPath)}: expected ${projectLicenseIdentifier}, found ${String(manifest.license ?? 'missing')}`,
    );
  }
}

const projectLicensePath = path.join(root, 'LICENSE');
const projectLicenseText = readFileSync(projectLicensePath, 'utf8').replaceAll('\r\n', '\n');
const requiredNoticePrefix = `${projectRequiredNotice}\n\n`;
if (!projectLicenseText.startsWith(requiredNoticePrefix)) {
  failures.push(`first-party - LICENSE: missing exact required notice`);
} else {
  const canonicalText = projectLicenseText.slice(requiredNoticePrefix.length);
  const actualSha256 = createHash('sha256').update(canonicalText, 'utf8').digest('hex');
  if (actualSha256 !== canonicalProjectLicenseSha256) {
    failures.push(
      `first-party - LICENSE: PolyForm canonical text hash ${actualSha256} does not match ${canonicalProjectLicenseSha256}`,
    );
  }
}

if (!existsSync(path.join(root, 'COMMERCIAL-LICENSING.md'))) {
  failures.push('first-party - COMMERCIAL-LICENSING.md: missing commercial-license contact path');
}
if (existsSync(path.join(root, 'EULA.txt'))) {
  failures.push('first-party - EULA.txt: remove duplicate or conflicting project license terms');
}

const desktopManifest = JSON.parse(
  readFileSync(path.join(root, 'apps', 'desktop', 'package.json'), 'utf8'),
);
if (desktopManifest.build?.nsis?.license !== '../../LICENSE') {
  failures.push('first-party - desktop installer: NSIS must display ../../LICENSE');
}
const installerCompanionFiles = new Map(
  (desktopManifest.build?.extraFiles ?? []).map((entry) => [entry.to, entry.from]),
);
for (const [destination, source] of [
  ['LICENSE.txt', '../../LICENSE'],
  ['COMMERCIAL-LICENSING.md', '../../COMMERCIAL-LICENSING.md'],
]) {
  if (installerCompanionFiles.get(destination) !== source) {
    failures.push(
      `first-party - desktop installer: expected ${source} to be installed as ${destination}`,
    );
  }
}

if (failures.length > 0) {
  process.stderr.write(`Project license policy failures:\n${failures.join('\n')}\n`);
  process.exit(1);
}

const normalize = (expression) =>
  expression
    .replaceAll('Apache 2.0', 'Apache-2.0')
    .replace(/[()]/g, ' ')
    .split(/\s+(?:AND|OR)\s+|\s*\/\s*/i)
    .map((value) => value.trim())
    .map((value) => (value === 'BSD' ? 'BSD-3-Clause' : value))
    .filter(Boolean);

const pnpmCli = process.env.npm_execpath;
if (typeof pnpmCli !== 'string' || pnpmCli.trim() === '') {
  process.stderr.write('Run this policy through `pnpm licenses:check`.\n');
  process.exit(1);
}

const inspectDependencies = (production) => {
  const arguments_ = [pnpmCli, 'licenses', 'list', ...(production ? ['--prod'] : []), '--json'];
  const result = spawnSync(process.execPath, arguments_, {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    throw new Error(
      `pnpm license inventory failed${production ? ' for production' : ''}: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `pnpm license inventory failed${production ? ' for production' : ''} with exit ${String(result.status)}: ${result.stderr.trim()}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `pnpm license inventory returned invalid JSON${production ? ' for production' : ''}.`,
    );
  }
};

const validateInventory = (inventory, allowed, surface) => {
  for (const [expression, packages] of Object.entries(inventory)) {
    const choices = normalize(expression);
    const requiresEveryChoice = /\sAND\s/i.test(expression);
    const accepted = requiresEveryChoice
      ? choices.every((choice) => allowed.has(choice))
      : choices.some((choice) => allowed.has(choice));
    if (accepted) continue;

    const packageNames = Array.isArray(packages)
      ? packages
          .map((metadata) => String(metadata.name ?? 'unknown'))
          .sort()
          .join(', ')
      : 'unknown';
    failures.push(`${surface} - ${expression}: ${packageNames}`);
  }
};

const developmentDependencies = inspectDependencies(false);
const runtimeDependencies = inspectDependencies(true);
validateInventory(runtimeDependencies, allowedRuntime, 'runtime');
validateInventory(developmentDependencies, allowedDevelopment, 'development');

if (failures.length > 0) {
  process.stderr.write(`Disallowed or unknown dependency licenses:\n${failures.join('\n')}\n`);
  process.exit(1);
}

const dependencyCount = (inventory) =>
  Object.values(inventory).reduce(
    (count, packages) => count + (Array.isArray(packages) ? packages.length : 0),
    0,
  );

process.stdout.write(
  `License policy passed for 10 first-party packages, ${dependencyCount(runtimeDependencies)} runtime packages, and ${dependencyCount(developmentDependencies)} total dependency entries.\n`,
);
