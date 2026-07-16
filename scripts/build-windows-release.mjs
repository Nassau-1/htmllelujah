#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  assertSourceSnapshot,
  captureSourceSnapshot,
} from '../apps/desktop/scripts/build-provenance-support.mjs';
import {
  attestWorkspacePackageOutputs,
  assertWorkspacePackageOutputsStable,
  buildCommandPlan,
  clearWorkspacePackageOutputs,
  createReleaseEnvironment,
  discoverWorkspacePackages,
  promoteDirectoriesAtomically,
} from './windows-release-pipeline-support.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const corepackCommand = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
const releaseEnvironment = createReleaseEnvironment(process.env);

const usage = () => `Usage: node scripts/build-windows-release.mjs [options]

Builds from a clean detached worktree, attests the exact candidate, then atomically promotes it.

Options:
  --dry-run          print the detached-worktree command plan without executing it
  --online-install   permit pnpm to use the network (default is --offline)
  --help             show this help`;

const parseArgs = (argv) => {
  const options = { dryRun: false, offline: true };
  for (const argument of argv) {
    if (argument === '--help') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--online-install') options.offline = false;
    else throw new Error(`Unknown option: ${argument}.`);
  }
  return options;
};

const runProcess = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    const executable = command === 'corepack' ? corepackCommand : command;
    process.stdout.write(`\n[release] ${executable} ${args.join(' ')}\n`);
    const child = spawn(executable, args, {
      cwd,
      env: releaseEnvironment,
      shell: false,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error(`${executable} exited with ${signal ?? code ?? 'unknown status'}.`));
    });
  });

const atomicWriteJson = async (filePath, value) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, filePath);
};

const assertSafeWorktree = (worktreeRoot) => {
  const parent = path.dirname(repositoryRoot);
  const relation = path.relative(parent, worktreeRoot);
  if (
    relation.startsWith('..') ||
    path.isAbsolute(relation) ||
    !path.basename(worktreeRoot).startsWith('.htmllelujah-release-worktree-')
  ) {
    throw new Error(`Refusing unsafe release worktree path: ${worktreeRoot}.`);
  }
};

const options = parseArgs(process.argv.slice(2));
const packageBlueprint = await discoverWorkspacePackages(repositoryRoot);
const dryRunId = '00000000-0000-4000-8000-000000000000';
const buildId = options.dryRun ? dryRunId : randomUUID();
const worktreeRoot = path.join(
  path.dirname(repositoryRoot),
  `.htmllelujah-release-worktree-${buildId}`,
);
const paths = {
  buildId,
  session: path.join(worktreeRoot, 'artifacts', 'build-provenance-session.json'),
  workspaceBuild: path.join(worktreeRoot, 'artifacts', 'workspace-package-builds.json'),
  artifactStaging: path.join(worktreeRoot, 'apps', 'desktop', 'out'),
  evidenceStaging: path.join(worktreeRoot, 'artifacts', 'release-evidence'),
};
paths.candidateManifest = path.join(paths.evidenceStaging, 'release-candidate-v1.json');
const plan = buildCommandPlan({
  packageNames: packageBlueprint.map((entry) => entry.name),
  paths,
  offline: options.offline,
});

if (options.dryRun) {
  process.stdout.write(`Detached worktree: ${worktreeRoot}\n`);
  process.stdout.write(
    'All workspace package outputs are removed before these sequential builds:\n',
  );
  for (const step of plan) {
    process.stdout.write(`  ${step.name}: ${step.command} ${step.args.join(' ')}\n`);
  }
  process.stdout.write('No command was executed.\n');
  process.exit(0);
}

if (process.platform !== 'win32') {
  throw new Error('The V1 release pipeline targets Windows x64 and must run on Windows.');
}
const signingEnvironmentKeys = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'WIN_CSC_LINK',
  'WIN_CSC_KEY_PASSWORD',
];
const configuredSigningKeys = signingEnvironmentKeys.filter(
  (key) => typeof process.env[key] === 'string' && process.env[key].trim() !== '',
);
if (configuredSigningKeys.length > 0) {
  throw new Error(
    `The unsigned V1 pipeline refuses configured signing environment keys: ${configuredSigningKeys.join(', ')}.`,
  );
}

assertSafeWorktree(worktreeRoot);
const originalSource = await captureSourceSnapshot(repositoryRoot, { requireClean: true });
let worktreeAdded = false;
let promoted = false;
try {
  await runProcess(
    'git',
    ['worktree', 'add', '--detach', worktreeRoot, originalSource.commit],
    repositoryRoot,
  );
  worktreeAdded = true;
  const worktreeSource = await captureSourceSnapshot(worktreeRoot, { requireClean: true });
  if (
    worktreeSource.commit !== originalSource.commit ||
    JSON.stringify(worktreeSource.tree) !== JSON.stringify(originalSource.tree)
  ) {
    throw new Error('Detached release worktree does not match the exact requested commit.');
  }

  const packages = await discoverWorkspacePackages(worktreeRoot);
  const packageBuildTimes = new Map();
  let outputsCleared = false;
  let workspaceAttested = false;
  let workspaceBuildRecord = null;
  for (const step of plan) {
    if (step.name.startsWith('build-workspace-package:')) {
      if (!outputsCleared) {
        await clearWorkspacePackageOutputs(worktreeRoot, packages);
        outputsCleared = true;
      }
      packageBuildTimes.set(step.name.slice('build-workspace-package:'.length), Date.now());
    } else if (step.name === 'build-desktop-vite' && !workspaceAttested) {
      workspaceBuildRecord = await attestWorkspacePackageOutputs(packages, packageBuildTimes);
      await atomicWriteJson(paths.workspaceBuild, workspaceBuildRecord);
      workspaceAttested = true;
    }
    await runProcess(step.command, step.args, worktreeRoot);
  }
  if (!workspaceAttested) throw new Error('Workspace package rebuilds were not attested.');
  await assertWorkspacePackageOutputsStable(packages, packageBuildTimes, workspaceBuildRecord);

  await assertSourceSnapshot(worktreeRoot, worktreeSource, { requireClean: true });
  await assertSourceSnapshot(repositoryRoot, originalSource, { requireClean: true });
  const transactionRoot = path.join(
    path.dirname(repositoryRoot),
    `.htmllelujah-release-promotion-${buildId}`,
  );
  await promoteDirectoriesAtomically({
    promotions: [
      {
        source: paths.artifactStaging,
        destination: path.join(repositoryRoot, 'apps', 'desktop', 'out'),
      },
      {
        source: paths.evidenceStaging,
        destination: path.join(repositoryRoot, 'artifacts', 'release-evidence'),
      },
    ],
    transactionRoot,
  });
  promoted = true;
  try {
    await rm(transactionRoot, { recursive: true, force: true });
  } catch (error) {
    process.stderr.write(`Release promotion cleanup warning: ${error.message}\n`);
  }
  process.stdout.write('\nRelease candidate and evidence promoted atomically.\n');
} finally {
  if (worktreeAdded) {
    try {
      await runProcess('git', ['worktree', 'remove', '--force', worktreeRoot], repositoryRoot);
    } catch (error) {
      process.stderr.write(`Release worktree cleanup warning: ${error.message}\n`);
      try {
        assertSafeWorktree(worktreeRoot);
        await rm(worktreeRoot, { recursive: true, force: true });
      } catch (fallbackError) {
        process.stderr.write(`Release staging cleanup warning: ${fallbackError.message}\n`);
      }
    }
    try {
      await runProcess('git', ['worktree', 'prune'], repositoryRoot);
    } catch (error) {
      process.stderr.write(`Git worktree prune warning: ${error.message}\n`);
    }
  } else if (!promoted) {
    try {
      assertSafeWorktree(worktreeRoot);
      await rm(worktreeRoot, { recursive: true, force: true });
    } catch (error) {
      process.stderr.write(`Release staging cleanup warning: ${error.message}\n`);
    }
  }
}
