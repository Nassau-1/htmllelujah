import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = JSON.parse(readFileSync(path.join(root, 'policy', 'licenses.json'), 'utf8'));
const require = createRequire(import.meta.url);
const checker = require('license-checker-rseidelsohn');
function inspect(start, production = false) {
  return new Promise((resolve, reject) => {
    checker.init({ start, production, excludePrivatePackages: true }, (error, packages) => {
      if (error) reject(error);
      else resolve(packages);
    });
  });
}

const workspaceRoots = ['apps', 'packages'].flatMap((directory) => {
  const absoluteDirectory = path.join(root, directory);
  if (!existsSync(absoluteDirectory)) return [];

  return readdirSync(absoluteDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(absoluteDirectory, entry.name))
    .filter((directoryPath) => existsSync(path.join(directoryPath, 'package.json')));
});

const developmentDependencies = await inspect(root);
const runtimeDependencies = Object.assign(
  {},
  ...(await Promise.all(workspaceRoots.map((workspaceRoot) => inspect(workspaceRoot, true)))),
);

const allowedRuntime = new Set(policy.allowed);
const allowedDevelopment = new Set([...policy.allowed, ...Object.keys(policy.reviewedBuildOnly)]);
const failures = [];

function normalize(expression) {
  return expression
    .replaceAll('Apache 2.0', 'Apache-2.0')
    .replace(/[()]/g, ' ')
    .split(/\s+(?:AND|OR)\s+|\s*\/\s*/i)
    .map((value) => value.trim())
    .map((value) => (value === 'BSD' ? 'BSD-3-Clause' : value))
    .filter(Boolean);
}

function validate(dependencies, allowed, surface) {
  for (const [name, metadata] of Object.entries(dependencies)) {
    const expression = String(metadata.licenses ?? 'UNKNOWN');
    const choices = normalize(expression);
    const requiresEveryChoice = /\sAND\s/i.test(expression);
    const accepted = requiresEveryChoice
      ? choices.every((choice) => allowed.has(choice))
      : choices.some((choice) => allowed.has(choice));

    if (!accepted) failures.push(`${surface} - ${name}: ${expression}`);
  }
}

validate(runtimeDependencies, allowedRuntime, 'runtime');
validate(developmentDependencies, allowedDevelopment, 'development');

if (failures.length > 0) {
  process.stderr.write(`Disallowed or unknown dependency licenses:\n${failures.join('\n')}\n`);
  process.exit(1);
}

process.stdout.write(
  `License policy passed for ${Object.keys(runtimeDependencies).length} runtime packages and ${Object.keys(developmentDependencies).length} development packages.\n`,
);
