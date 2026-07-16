import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, lstat, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const SOURCE_EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.smoke',
  'artifacts',
  'coverage',
  'node_modules',
  'out',
]);

const normalizePath = (value) => value.split(path.sep).join('/');

const exists = async (value) => {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
};

const repositoryRelative = (repositoryRoot, value) => {
  const relative = path.relative(repositoryRoot, value);
  return relative.startsWith('..') ? path.basename(value) : normalizePath(relative);
};

export const latestReleaseInput = async (repositoryRoot) => {
  const roots = [
    path.join(repositoryRoot, 'apps', 'desktop', 'src'),
    path.join(repositoryRoot, 'apps', 'desktop', 'assets'),
    path.join(repositoryRoot, 'apps', 'desktop', 'dist'),
    path.join(repositoryRoot, 'apps', 'desktop', 'dist-electron'),
    path.join(repositoryRoot, 'packages'),
  ];
  const standalone = [
    path.join(repositoryRoot, 'package.json'),
    path.join(repositoryRoot, 'pnpm-lock.yaml'),
    path.join(repositoryRoot, 'pnpm-workspace.yaml'),
    path.join(repositoryRoot, 'LICENSE'),
    path.join(repositoryRoot, 'EULA.txt'),
    path.join(repositoryRoot, 'THIRD_PARTY_NOTICES.md'),
    path.join(repositoryRoot, 'apps', 'desktop', 'index.html'),
    path.join(repositoryRoot, 'apps', 'desktop', 'package.json'),
    path.join(repositoryRoot, 'apps', 'desktop', 'tsconfig.json'),
    path.join(repositoryRoot, 'apps', 'desktop', 'tsconfig.node.json'),
    path.join(repositoryRoot, 'apps', 'desktop', 'scripts', 'apply-fuses.mjs'),
    path.join(repositoryRoot, 'apps', 'desktop', 'scripts', 'installer-association.nsh'),
    path.join(repositoryRoot, 'apps', 'desktop', 'vite.config.ts'),
  ];
  let newest = { mtimeMs: 0, path: null };

  const consider = async (filePath) => {
    const fileStat = await stat(filePath);
    if (fileStat.mtimeMs > newest.mtimeMs) {
      newest = {
        mtimeMs: fileStat.mtimeMs,
        path: repositoryRelative(repositoryRoot, filePath),
      };
    }
  };

  const visit = async (directory) => {
    if (!(await exists(directory))) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && SOURCE_EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) await consider(fullPath);
    }
  };

  for (const root of roots) await visit(root);
  for (const filePath of standalone) if (await exists(filePath)) await consider(filePath);
  if (newest.path === null) throw new Error('No release source input was found.');
  return newest;
};

export const artifactFreshness = async ({ artifactDir, inventory, installers, repositoryRoot }) => {
  const latestSource = await latestReleaseInput(repositoryRoot);
  const preferredReferences =
    installers.length > 0
      ? installers
      : inventory.filter((entry) =>
          /(?:^|\/)win-unpacked\/resources\/app\.asar$/iu.test(entry.path),
        );
  const artifactReferences =
    preferredReferences.length > 0
      ? preferredReferences
      : inventory.filter((entry) => /(?:^|\/)win-unpacked\/[^/]+\.exe$/iu.test(entry.path));
  if (artifactReferences.length === 0) {
    throw new Error(
      'No installer, packaged app.asar, or unpacked executable freshness reference found.',
    );
  }
  let latestArtifact = { mtimeMs: 0, path: null };
  for (const entry of artifactReferences) {
    const filePath = path.join(artifactDir, ...entry.path.split('/'));
    const fileStat = await stat(filePath);
    if (fileStat.mtimeMs > latestArtifact.mtimeMs) {
      latestArtifact = { mtimeMs: fileStat.mtimeMs, path: entry.path };
    }
  }
  const stale = latestSource.mtimeMs > latestArtifact.mtimeMs + 1_000;
  return {
    stale,
    latestArtifact: {
      path: latestArtifact.path,
      modifiedAt: new Date(latestArtifact.mtimeMs).toISOString(),
    },
    latestSourceInput: {
      path: latestSource.path,
      modifiedAt: new Date(latestSource.mtimeMs).toISOString(),
    },
    reason: stale
      ? 'At least one release input is newer than the newest packaged artifact file.'
      : 'No release input inspected by this tool is newer than the packaged artifact.',
  };
};

const runGitProcess = (repositoryRoot, arguments_, allowedStatuses = [0]) => {
  const result = spawnSync('git', arguments_, {
    cwd: repositoryRoot,
    encoding: null,
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.signal || !allowedStatuses.includes(result.status)) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8').trim()
      : String(result.stderr ?? '').trim();
    throw new Error(
      `Git command failed closed (git ${arguments_.join(' ')}): ${stderr || result.error?.message || `exit ${result.status ?? 'unknown'}`}`,
    );
  }
  return result;
};

export const runGitText = (repositoryRoot, arguments_, allowedStatuses = [0]) =>
  runGitProcess(repositoryRoot, arguments_, allowedStatuses).stdout.toString('utf8').trim();

export const gitSourceState = (repositoryRoot, runner = runGitProcess) => {
  const runText = (arguments_, allowedStatuses = [0]) =>
    runner(repositoryRoot, arguments_, allowedStatuses).stdout.toString('utf8').trim();
  const hasChanges = (arguments_) => runner(repositoryRoot, arguments_, [0, 1]).status === 1;
  if (runText(['rev-parse', '--is-inside-work-tree']) !== 'true') {
    throw new Error('The release source is not a Git worktree.');
  }
  const commit = runText(['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!/^[0-9a-f]{40,64}$/u.test(commit)) {
    throw new Error('Git HEAD did not resolve to an exact commit.');
  }
  const staged = hasChanges(['diff', '--cached', '--quiet', '--no-ext-diff', 'HEAD', '--']);
  const unstaged = hasChanges(['diff-files', '--quiet', '--no-ext-diff', '--']);
  const untrackedOutput = runner(repositoryRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ]).stdout;
  const untracked = untrackedOutput.length > 0;
  const statusOutput = runner(repositoryRoot, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]).stdout;
  const dirty = staged || unstaged || untracked;
  const statusDirty = statusOutput.length > 0;
  if (statusDirty !== dirty) {
    throw new Error('Git cleanliness checks disagreed; refusing an ambiguous source state.');
  }
  let branch = null;
  const branchResult = runner(repositoryRoot, ['symbolic-ref', '-q', '--short', 'HEAD'], [0, 1]);
  if (branchResult.status === 0) branch = branchResult.stdout.toString('utf8').trim() || null;
  const exactTagResult = runner(
    repositoryRoot,
    ['describe', '--tags', '--exact-match', 'HEAD'],
    [0, 128],
  );
  const exactTag =
    exactTagResult.status === 0 ? exactTagResult.stdout.toString('utf8').trim() || null : null;
  return {
    commit,
    branch,
    exactTag,
    dirty,
    staged,
    unstaged,
    untracked,
  };
};

const sha256File = (filePath) =>
  new Promise((resolve, reject) => {
    const digest = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(digest.digest('hex')));
  });

export const trackedSourceIdentity = async (repositoryRoot) => {
  const output = runGitProcess(repositoryRoot, ['ls-files', '--cached', '-z']).stdout;
  const files = output
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (files.length === 0 || files.length > 100_000) {
    throw new Error('The tracked source set is outside the supported provenance bounds.');
  }
  const digest = createHash('sha256');
  let bytes = 0;
  for (const relativePath of files) {
    const absolutePath = path.resolve(repositoryRoot, ...relativePath.split('/'));
    const relation = path.relative(repositoryRoot, absolutePath);
    if (relation.startsWith('..') || path.isAbsolute(relation)) {
      throw new Error(`Tracked source path escaped the repository: ${relativePath}.`);
    }
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Tracked provenance entry is not a regular file: ${relativePath}.`);
    }
    const fileSha256 = await sha256File(absolutePath);
    bytes += metadata.size;
    digest.update(relativePath);
    digest.update('\0');
    digest.update(String(metadata.size));
    digest.update('\0');
    digest.update(fileSha256);
    digest.update('\n');
  }
  return { sha256: digest.digest('hex'), fileCount: files.length, bytes };
};

const sameIdentity = (left, right) =>
  left.sha256 === right.sha256 && left.fileCount === right.fileCount && left.bytes === right.bytes;

export const captureSourceSnapshot = async (repositoryRoot, { requireClean = false } = {}) => {
  const before = gitSourceState(repositoryRoot);
  if (requireClean && before.dirty) {
    throw new Error('A release source snapshot requires a clean index and worktree.');
  }
  const tree = await trackedSourceIdentity(repositoryRoot);
  const after = gitSourceState(repositoryRoot);
  if (before.commit !== after.commit || before.dirty !== after.dirty) {
    throw new Error('Source state changed while the provenance snapshot was captured.');
  }
  const confirmation = await trackedSourceIdentity(repositoryRoot);
  if (!sameIdentity(tree, confirmation)) {
    throw new Error('Tracked source changed while the provenance snapshot was captured.');
  }
  return { ...after, tree };
};

export const assertSourceSnapshot = async (
  repositoryRoot,
  expected,
  { requireClean = false } = {},
) => {
  const current = await captureSourceSnapshot(repositoryRoot, { requireClean });
  assertSourceSnapshotIdentity(current, expected);
  return current;
};

export const assertSourceSnapshotIdentity = (current, expected) => {
  if (
    current.commit !== expected.commit ||
    current.dirty !== expected.dirty ||
    !sameIdentity(current.tree, expected.tree)
  ) {
    throw new Error('The source commit or tracked source snapshot changed during the build.');
  }
};

export const sourceProvenance = (repositoryRoot) => {
  const source = gitSourceState(repositoryRoot);
  return {
    commit: source.commit,
    branch: source.branch,
    exactTag: source.exactTag,
    dirty: source.dirty,
    dirtyEntryCount: Number(source.staged) + Number(source.unstaged) + Number(source.untracked),
  };
};
