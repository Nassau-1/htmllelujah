#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const statePath = process.env.HTMLLELUJAH_FAKE_GH_STATE;
if (!statePath) {
  process.stderr.write('Missing HTMLLELUJAH_FAKE_GH_STATE.\n');
  process.exit(64);
}

const args = process.argv.slice(2);
const state = JSON.parse(await readFile(statePath, 'utf8'));
state.calls ??= [];
state.calls.push({
  args,
  ghHost: process.env.GH_HOST ?? null,
  ghTokenPresent: Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN),
});
const persist = () => writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
const failNotFound = async () => {
  await persist();
  process.stderr.write('gh: Not Found (HTTP 404)\n');
  process.exit(1);
};
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1];
};
const sha256 = (content) => createHash('sha256').update(content).digest('hex');
const apiRelease = () => {
  const release = state.release;
  return {
    id: release.id,
    url: `https://api.github.com/repos/${state.repository}/releases/${release.id}`,
    html_url: `https://github.com/${state.repository}/releases/tag/${encodeURIComponent(state.tag)}`,
    tag_name: state.tag,
    name: release.title,
    body: release.body,
    draft: release.draft,
    prerelease: false,
    assets: release.assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      size: asset.size,
      state: 'uploaded',
      digest: `sha256:${asset.sha256}`,
      url: `https://api.github.com/repos/${state.repository}/releases/assets/${asset.id}`,
      browser_download_url: `https://github.com/${state.repository}/releases/download/${encodeURIComponent(state.tag)}/${encodeURIComponent(asset.name)}`,
    })),
  };
};
const addAssets = async (filePaths) => {
  for (const filePath of filePaths) {
    const content = await readFile(filePath);
    const metadata = await stat(filePath);
    state.release.assets.push({
      id: state.nextAssetId++,
      name: path.basename(filePath),
      size: metadata.size,
      sha256: sha256(content),
      sourcePath: filePath,
    });
  }
};

if (args[0] === 'auth' && args[1] === 'status' && option('--hostname') === 'github.com') {
  await persist();
  process.stdout.write('authenticated\n');
  process.exit(0);
}

if (args[0] === 'api') {
  if (option('--hostname') !== 'github.com') {
    await persist();
    process.stderr.write('hostname was not pinned\n');
    process.exit(2);
  }
  const endpoint = args.at(-1);
  if (endpoint === `repos/${state.repository}`) {
    await persist();
    process.stdout.write(
      JSON.stringify({
        full_name: state.repository,
        private: false,
        visibility: 'public',
        html_url: `https://github.com/${state.repository}`,
      }),
    );
    process.exit(0);
  }
  if (endpoint === `repos/${state.repository}/releases/tags/${state.tag}`) {
    if (state.release === null) await failNotFound();
    await persist();
    process.stdout.write(JSON.stringify(apiRelease()));
    process.exit(0);
  }
  if (endpoint === `repos/${state.repository}/releases/latest`) {
    if (
      state.release === null ||
      state.release.draft ||
      state.latestReleaseId !== state.release.id
    ) {
      await failNotFound();
    }
    await persist();
    process.stdout.write(JSON.stringify(apiRelease()));
    process.exit(0);
  }
}

if (args[0] === 'release' && args[1] === 'create') {
  if (state.release !== null) {
    await persist();
    process.stderr.write('release already exists\n');
    process.exit(2);
  }
  const notesFile = option('--notes-file');
  const notesIndex = args.indexOf('--notes-file');
  state.release = {
    id: 42,
    title: option('--title'),
    body: await readFile(notesFile, 'utf8'),
    draft: true,
    assets: [],
  };
  await addAssets(args.slice(notesIndex + 2));
  await persist();
  process.exit(0);
}

if (args[0] === 'release' && args[1] === 'upload') {
  const repoIndex = args.indexOf('--repo');
  await addAssets(args.slice(repoIndex + 2));
  await persist();
  process.exit(0);
}

if (args[0] === 'release' && args[1] === 'edit') {
  if (args.includes('--draft=false')) state.release.draft = false;
  if (args.includes('--draft=true')) state.release.draft = true;
  if (args.includes('--latest')) state.latestReleaseId = state.release.id;
  await persist();
  process.exit(0);
}

if (args[0] === 'release' && args[1] === 'download') {
  const name = option('--pattern');
  const directory = option('--dir');
  const asset = state.release?.assets.find((entry) => entry.name === name);
  if (!asset) await failNotFound();
  await copyFile(asset.sourcePath, path.join(directory, name));
  if (state.corruptDownloads) {
    await writeFile(path.join(directory, name), 'corrupted-download', 'utf8');
  }
  await persist();
  process.exit(0);
}

await persist();
process.stderr.write(`Unsupported fake gh command: ${args.join(' ')}\n`);
process.exit(2);
