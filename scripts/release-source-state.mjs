import { access, readdir, stat } from 'node:fs/promises';
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

const runGit = (repositoryRoot, arguments_) => {
  const result = spawnSync('git', arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
};

export const sourceProvenance = (repositoryRoot) => {
  const status = runGit(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=normal']);
  const dirtyEntries = status ? status.split(/\r?\n/u).filter(Boolean) : [];
  return {
    commit: runGit(repositoryRoot, ['rev-parse', '--verify', 'HEAD']),
    branch: runGit(repositoryRoot, ['branch', '--show-current']),
    exactTag: runGit(repositoryRoot, ['describe', '--tags', '--exact-match', 'HEAD']),
    dirty: status === null ? null : dirtyEntries.length > 0,
    dirtyEntryCount: status === null ? null : dirtyEntries.length,
  };
};
