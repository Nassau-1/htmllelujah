#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  DEPENDENCY_SBOM_FILE_NAME,
  inspectDependencySbom,
} from './security-release-evidence-support.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arguments_ = process.argv.slice(2);
let sbomPath = path.join(
  repositoryRoot,
  'artifacts',
  'release-evidence',
  DEPENDENCY_SBOM_FILE_NAME,
);
for (let index = 0; index < arguments_.length; index += 1) {
  if (arguments_[index] === '--help') {
    process.stdout.write('Usage: node scripts/verify-dependency-sbom.mjs [--sbom <path>]\n');
    process.exit(0);
  }
  if (arguments_[index] !== '--sbom') {
    throw new Error(`Unknown option: ${arguments_[index]}.`);
  }
  const value = arguments_[index + 1];
  if (!value || value.startsWith('--')) throw new Error('Missing value for --sbom.');
  sbomPath = path.resolve(value);
  index += 1;
}

const [bytes, lockfileBytes, packageBytes] = await Promise.all([
  readFile(sbomPath),
  readFile(path.join(repositoryRoot, 'pnpm-lock.yaml')),
  readFile(path.join(repositoryRoot, 'package.json')),
]);
const identity = inspectDependencySbom({
  bytes,
  expectedLockfileSha256: createHash('sha256').update(lockfileBytes).digest('hex'),
  expectedPackageManager: JSON.parse(packageBytes.toString('utf8')).packageManager,
});
process.stdout.write(
  `Dependency SBOM verified: ${identity.sha256} (${identity.componentCount} components, ${identity.dependencyEdgeCount} edges).\n`,
);
