import { readFile } from 'node:fs/promises';

const GITHUB_HOST = 'github.com';
const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_WEB_ORIGIN = 'https://github.com';

const assertSafeExpectedAssets = (assets) => {
  if (!Array.isArray(assets) || assets.length === 0) {
    throw new Error('GitHub publication requires an explicit non-empty asset allowlist.');
  }
  const names = new Set();
  for (const asset of assets) {
    if (
      typeof asset?.name !== 'string' ||
      asset.name.length === 0 ||
      asset.name.includes('/') ||
      asset.name.includes('\\') ||
      /[*?[\]]/u.test(asset.name) ||
      names.has(asset.name) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 1 ||
      !/^[0-9a-f]{64}$/u.test(asset.sha256 ?? '') ||
      typeof asset.filePath !== 'string' ||
      asset.filePath.length === 0
    ) {
      throw new Error('GitHub publication asset allowlist is unsafe or contains duplicates.');
    }
    names.add(asset.name);
  }
  if (!assets.some((asset) => asset.role === 'final-release-record')) {
    throw new Error('The final release record must be included in the publication allowlist.');
  }
};

export const assertPublishableReleaseNotes = (body) => {
  if (
    typeof body !== 'string' ||
    body.trim().length < 20 ||
    /\b(?:PENDING|TODO|TBD|PLACEHOLDER)\b/iu.test(body)
  ) {
    throw new Error('Public release notes are empty or contain an unfinished placeholder.');
  }
};

export const assertExactGithubRepository = ({ repositoryRecord, repository }) => {
  if (
    repositoryRecord?.full_name !== repository ||
    repositoryRecord?.private !== false ||
    repositoryRecord?.visibility !== 'public' ||
    repositoryRecord?.html_url !== `${GITHUB_WEB_ORIGIN}/${repository}`
  ) {
    throw new Error('GitHub repository identity or public visibility is not exact.');
  }
};

const exactUrl = (value, expected, label) => {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL.`);
  }
  if (parsed.href !== expected) throw new Error(`${label} escaped the exact GitHub repository.`);
};

const assertGithubRelease = ({
  release,
  repository,
  tag,
  title,
  body,
  assets,
  draft,
  allowMissingAssets = false,
}) => {
  assertSafeExpectedAssets(assets);
  assertPublishableReleaseNotes(body);
  if (
    !Number.isSafeInteger(release?.id) ||
    release.id < 1 ||
    release.tag_name !== tag ||
    release.name !== title ||
    release.body !== body ||
    release.draft !== draft ||
    release.prerelease !== false
  ) {
    throw new Error(
      'GitHub release identity, notes, or state differs from the requested publication.',
    );
  }
  exactUrl(
    release.url,
    `${GITHUB_API_ORIGIN}/repos/${repository}/releases/${release.id}`,
    'GitHub release API URL',
  );
  exactUrl(
    release.html_url,
    `${GITHUB_WEB_ORIGIN}/${repository}/releases/tag/${encodeURIComponent(tag)}`,
    'GitHub release page URL',
  );
  if (!Array.isArray(release.assets)) throw new Error('GitHub release asset list is missing.');
  const expected = new Map(assets.map((entry) => [entry.name, entry]));
  const observedNames = new Set();
  for (const asset of release.assets) {
    if (observedNames.has(asset?.name))
      throw new Error('GitHub release contains duplicate assets.');
    observedNames.add(asset?.name);
    const expectedAsset = expected.get(asset?.name);
    if (
      !expectedAsset ||
      asset?.size !== expectedAsset.size ||
      asset?.state !== 'uploaded' ||
      !Number.isSafeInteger(asset?.id) ||
      asset.id < 1
    ) {
      throw new Error(
        `GitHub release asset is unexpected or changed: ${asset?.name ?? 'unknown'}.`,
      );
    }
    if (asset.digest !== `sha256:${expectedAsset.sha256}`) {
      throw new Error(`GitHub release asset digest mismatch: ${asset.name}.`);
    }
    exactUrl(
      asset.url,
      `${GITHUB_API_ORIGIN}/repos/${repository}/releases/assets/${asset.id}`,
      `GitHub release asset API URL for ${asset.name}`,
    );
    exactUrl(
      asset.browser_download_url,
      `${GITHUB_WEB_ORIGIN}/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset.name)}`,
      `GitHub release asset download URL for ${asset.name}`,
    );
  }
  if (!allowMissingAssets && observedNames.size !== expected.size) {
    throw new Error('GitHub release asset set is incomplete.');
  }
  return assets.filter((asset) => !observedNames.has(asset.name));
};

export const assertExactGithubRelease = (options) =>
  assertGithubRelease({ ...options, allowMissingAssets: false });

const isExactNotFound = (probe) =>
  !probe.error &&
  !probe.signal &&
  probe.status === 1 &&
  String(probe.stderr ?? '')
    .trim()
    .split(/\r?\n/u)
    .some((line) => /^gh: Not Found \(HTTP 404\)$/iu.test(line));

export const publishGithubRelease = async ({
  mode,
  repository,
  tag,
  title,
  notesFile,
  notesBody,
  assets,
  execute,
  run,
  fetchRelease,
  fetchLatestRelease,
  fetchRepository,
  verifyDownloads,
  revalidateBinding,
  checkpoint = async () => {},
}) => {
  if (mode !== 'draft' && mode !== 'publish') {
    throw new Error('GitHub publication mode must be draft or publish.');
  }
  assertSafeExpectedAssets(assets);
  assertPublishableReleaseNotes(notesBody);
  const qualifiedRepository = `${GITHUB_HOST}/${repository}`;
  const assertNotesUnchanged = async () => {
    if ((await readFile(notesFile, 'utf8')) !== notesBody) {
      throw new Error('Public release notes changed during publication.');
    }
  };
  const assertBinding = async (stage) => {
    await assertNotesUnchanged();
    await revalidateBinding(stage);
  };
  const assertLatestRelease = async (verifiedRelease) => {
    let latest;
    try {
      latest = await fetchLatestRelease();
    } catch (error) {
      throw new Error('GitHub latest release could not be verified.', { cause: error });
    }
    if (
      latest?.id !== verifiedRelease.id ||
      latest?.tag_name !== tag ||
      latest?.draft !== false ||
      latest?.prerelease !== false
    ) {
      throw new Error('GitHub latest release does not identify the exact verified publication.');
    }
  };
  const assertRepository = async () =>
    assertExactGithubRepository({ repositoryRecord: await fetchRepository(), repository });
  await assertRepository();
  await assertBinding('before-release-probe');

  const probe = execute(
    'gh',
    ['api', '--hostname', GITHUB_HOST, `repos/${repository}/releases/tags/${tag}`],
    { capture: true },
  );
  let release;
  let resumed = false;
  if (probe.status === 0 && !probe.error && !probe.signal) {
    resumed = true;
    release = await fetchRelease();
    if (typeof release?.draft !== 'boolean' || (mode === 'draft' && release.draft !== true)) {
      throw new Error(`GitHub release ${tag} already exists in an incompatible state.`);
    }
    const missingAssets = assertGithubRelease({
      release,
      repository,
      tag,
      title,
      body: notesBody,
      assets,
      draft: release.draft,
      allowMissingAssets: release.draft,
    });
    if (missingAssets.length > 0) {
      await assertBinding('immediately-before-resumed-draft-upload');
      await run(
        'gh',
        [
          'release',
          'upload',
          tag,
          '--repo',
          qualifiedRepository,
          ...missingAssets.map((asset) => asset.filePath),
        ],
        { timeoutMs: 1_800_000 },
      );
      await checkpoint('resumed-draft-upload-complete');
      await assertBinding('after-resumed-draft-upload');
      release = await fetchRelease();
      assertExactGithubRelease({
        release,
        repository,
        tag,
        title,
        body: notesBody,
        assets,
        draft: true,
      });
    }
    await verifyDownloads(release, assets, release.draft ? 'resumed-draft' : 'resumed-public');
    await assertBinding(
      release.draft ? 'after-resumed-draft-download' : 'after-resumed-public-download',
    );
    await checkpoint(release.draft ? 'resumed-draft-verified' : 'resumed-public-verified');
    if (!release.draft) {
      await assertLatestRelease(release);
      await assertRepository();
      return { release, resumed };
    }
  } else if (isExactNotFound(probe)) {
    await assertBinding('immediately-before-draft-create');
    await run(
      'gh',
      [
        'release',
        'create',
        tag,
        '--repo',
        qualifiedRepository,
        '--draft',
        '--verify-tag',
        '--latest=false',
        '--title',
        title,
        '--notes-file',
        notesFile,
        ...assets.map((entry) => entry.filePath),
      ],
      { timeoutMs: 1_800_000 },
    );
    await checkpoint('draft-command-complete');
    await assertBinding('after-draft-create');
    release = await fetchRelease();
    assertExactGithubRelease({
      release,
      repository,
      tag,
      title,
      body: notesBody,
      assets,
      draft: true,
    });
    await verifyDownloads(release, assets, 'draft');
    await assertBinding('after-draft-download');
    await checkpoint('draft-verified');
  } else {
    const probeError = String(probe.stderr ?? '').trim();
    throw new Error(
      `Could not prove that GitHub release ${tag} is absent or exact: ${probeError || probe.error?.message || probe.signal || `exit ${probe.status ?? 'unknown'}`}.`,
    );
  }

  if (mode === 'draft') {
    await assertRepository();
    return { release, resumed };
  }

  await assertBinding('immediately-before-public-edit');
  await run(
    'gh',
    ['release', 'edit', tag, '--repo', qualifiedRepository, '--draft=false', '--latest'],
    { timeoutMs: 300_000 },
  );
  await checkpoint('public-command-complete');
  await assertBinding('after-public-edit');
  release = await fetchRelease();
  assertExactGithubRelease({
    release,
    repository,
    tag,
    title,
    body: notesBody,
    assets,
    draft: false,
  });
  await verifyDownloads(release, assets, 'public');
  await assertBinding('after-public-download');
  await assertLatestRelease(release);
  await assertRepository();
  await checkpoint('public-verified');
  return { release, resumed };
};
