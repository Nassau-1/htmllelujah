import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { publishGithubRelease } from './github-release-publication.mjs';
import { createReleaseEnvironment } from './windows-release-pipeline-support.mjs';

const sha256 = (filePath) =>
  new Promise((resolve, reject) => {
    const digest = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(digest.digest('hex')));
  });

export const runGithubReleasePublication = async ({
  mode,
  repositoryRoot,
  artifactsRoot,
  repository,
  tag,
  title,
  notesFile,
  notesBody,
  assets,
  environment,
  revalidateBinding,
  checkpoint = async () => {},
  ghCommand = 'gh',
  ghArgsPrefix = [],
}) => {
  const childEnvironment = createReleaseEnvironment(environment);
  const execute = (_command, args, { capture = false, timeoutMs = 120_000 } = {}) =>
    spawnSync(ghCommand, [...ghArgsPrefix, ...args], {
      cwd: repositoryRoot,
      encoding: capture ? 'utf8' : undefined,
      env: childEnvironment,
      shell: false,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      timeout: timeoutMs,
      windowsHide: true,
    });
  const run = async (command, args, options = {}) => {
    const capture = options.capture === true;
    const result = execute(command, args, options);
    if (result.error || result.signal || result.status !== 0) {
      const stderr = capture ? String(result.stderr ?? '').trim() : '';
      throw new Error(
        `${command} ${args.join(' ')} failed closed: ${stderr || result.error?.message || result.signal || `exit ${result.status ?? 'unknown'}`}.`,
      );
    }
    return capture ? String(result.stdout ?? '').trim() : '';
  };
  const fetchApi = async (endpoint) =>
    JSON.parse(await run('gh', ['api', '--hostname', 'github.com', endpoint], { capture: true }));
  await run('gh', ['auth', 'status', '--hostname', 'github.com'], { capture: true });
  const qualifiedRepository = `github.com/${repository}`;
  const verifyDownloads = async (_release, expectedAssets, stage) => {
    await mkdir(artifactsRoot, { recursive: true });
    const downloadRoot = await mkdtemp(
      path.join(artifactsRoot, '.htmllelujah-release-download-verification-'),
    );
    try {
      for (const asset of expectedAssets) {
        await run(
          'gh',
          [
            'release',
            'download',
            tag,
            '--repo',
            qualifiedRepository,
            '--dir',
            downloadRoot,
            '--pattern',
            asset.name,
          ],
          { timeoutMs: 1_800_000 },
        );
      }
      const downloadedNames = (await readdir(downloadRoot)).sort((left, right) =>
        left.localeCompare(right, 'en'),
      );
      const expectedNames = expectedAssets
        .map((asset) => asset.name)
        .sort((left, right) => left.localeCompare(right, 'en'));
      if (JSON.stringify(downloadedNames) !== JSON.stringify(expectedNames)) {
        throw new Error(`Downloaded GitHub ${stage} asset set is not exact.`);
      }
      for (const asset of expectedAssets) {
        const downloadedPath = path.join(downloadRoot, asset.name);
        const metadata = await lstat(downloadedPath);
        if (
          metadata.isSymbolicLink() ||
          !metadata.isFile() ||
          metadata.size !== asset.size ||
          (await sha256(downloadedPath)) !== asset.sha256
        ) {
          throw new Error(`Downloaded GitHub ${stage} asset hash mismatch: ${asset.name}.`);
        }
      }
    } finally {
      await rm(downloadRoot, { recursive: true, force: true });
    }
  };
  return publishGithubRelease({
    mode,
    repository,
    tag,
    title,
    notesFile,
    notesBody,
    assets,
    execute,
    run,
    fetchRelease: () => fetchApi(`repos/${repository}/releases/tags/${tag}`),
    fetchLatestRelease: () => fetchApi(`repos/${repository}/releases/latest`),
    fetchRepository: () => fetchApi(`repos/${repository}`),
    verifyDownloads,
    revalidateBinding,
    checkpoint,
  });
};
