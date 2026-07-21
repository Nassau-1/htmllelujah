#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { release as operatingSystemRelease, version as operatingSystemVersion } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { buildDirectoryInventory } from '../apps/desktop/scripts/build-provenance-support.mjs';
import {
  assertCandidateManifest,
  assertGithubRepositoryRemote,
  assertReleasePublicationBinding,
  remoteTagIdentityFromLsRemote,
} from './release-candidate-manifest.mjs';
import { captureSourceSnapshot, gitSourceState } from './release-source-state.mjs';
import {
  assertExistingFinalRecordSecurityReceipt,
  assertTrackedReleaseNotes,
  buildFinalReleaseRecord,
} from './release-finalization-support.mjs';
import { runGithubReleasePublication } from './github-release-publication-runner.mjs';
import { assertPublishableReleaseNotes } from './github-release-publication.mjs';
import {
  acquireReleaseLock,
  assertNoPendingReleasePromotions,
  assertSafeReleaseDirectoryPath,
  createReleaseEnvironment,
  releaseReleaseLock,
} from './windows-release-pipeline-support.mjs';
import {
  FUNCTIONAL_VALIDATION_BUNDLE_NAME,
  FUNCTIONAL_VALIDATION_FILE_NAME,
  verifyFunctionalValidationPair,
} from './windows-candidate-validation-support.mjs';
import {
  DEPENDENCY_SBOM_FILE_NAME,
  SECURITY_EVIDENCE_FILE_NAME,
} from './security-release-evidence-support.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const promotionParent = path.dirname(repositoryRoot);
const releaseEnvironment = createReleaseEnvironment(process.env);
const EXPECTED_GITHUB_REPOSITORY = 'Nassau-1/htmllelujah';

const usage = () => `Usage: node scripts/finalize-windows-release.mjs [options]

Verifies the promoted candidate, functional evidence pair, security evidence, and local/remote tag, then writes an ignored public asset record.

Options:
  --tag <tag>          exact version tag (default: v<desktop version>)
  --remote <name>      Git remote containing the already-pushed tag (default: origin)
  --artifact-dir <p>   promoted artifact directory (default: apps/desktop/out)
  --evidence-dir <p>   promoted evidence directory (default: artifacts/release-evidence)
  --output <path>      final record under ignored artifacts/ and outside the candidate/evidence
  --publish-draft      create and independently verify an exact GitHub draft release
  --publish            verify a new draft, publish it, then re-download and verify it again
  --notes-file <path>  GitHub release notes (default: docs/releases/v1.0.0-public.md)
  --help               show this help`;

const parseArgs = (argv) => {
  const options = {
    tag: null,
    remote: 'origin',
    artifactDir: path.join(repositoryRoot, 'apps', 'desktop', 'out'),
    evidenceDir: path.join(repositoryRoot, 'artifacts', 'release-evidence'),
    outputPath: null,
    publishMode: 'none',
    notesFile: path.join(repositoryRoot, 'docs', 'releases', 'v1.0.0-public.md'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (argument === '--publish-draft' || argument === '--publish') {
      if (options.publishMode !== 'none') throw new Error('Choose only one publication mode.');
      options.publishMode = argument === '--publish' ? 'publish' : 'draft';
      continue;
    }
    if (
      [
        '--tag',
        '--remote',
        '--artifact-dir',
        '--evidence-dir',
        '--output',
        '--notes-file',
      ].includes(argument)
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}.`);
      index += 1;
      if (argument === '--tag') options.tag = value;
      if (argument === '--remote') options.remote = value;
      if (argument === '--artifact-dir') options.artifactDir = path.resolve(value);
      if (argument === '--evidence-dir') options.evidenceDir = path.resolve(value);
      if (argument === '--output') options.outputPath = path.resolve(value);
      if (argument === '--notes-file') options.notesFile = path.resolve(value);
      continue;
    }
    throw new Error(`Unknown option: ${argument}.`);
  }
  if (!/^[A-Za-z0-9._/-]+$/u.test(options.remote)) {
    throw new Error('Remote name contains unsupported characters.');
  }
  return options;
};

const isStrictDescendant = (root, target) => {
  const relation = path.relative(path.resolve(root), path.resolve(target));
  return relation !== '' && !relation.startsWith('..') && !path.isAbsolute(relation);
};

const sha256 = (filePath) =>
  new Promise((resolve, reject) => {
    const digest = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(digest.digest('hex')));
  });

const execute = (command, args, { capture = false, timeoutMs = 120_000 } = {}) =>
  spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: capture ? 'utf8' : undefined,
    env: releaseEnvironment,
    shell: false,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: timeoutMs,
    windowsHide: true,
  });

const run = (command, args, options = {}) => {
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

const readJson = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'));

const sameRegularFile = (before, after) =>
  before.isFile() &&
  after.isFile() &&
  !before.isSymbolicLink() &&
  !after.isSymbolicLink() &&
  before.nlink === 1 &&
  after.nlink === 1 &&
  before.size === after.size &&
  before.mtimeMs === after.mtimeMs &&
  (before.ino === 0 || after.ino === 0 || before.ino === after.ino) &&
  (before.dev === 0 || after.dev === 0 || before.dev === after.dev);

const readRegularFileStable = async (filePath, label) => {
  const before = await lstat(filePath);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size < 1) {
    throw new Error(`${label} must be a non-empty regular non-link file with one link.`);
  }
  let handle;
  let opened;
  let bytes;
  try {
    handle = await open(filePath, 'r');
    opened = await handle.stat();
    if (!sameRegularFile(before, opened)) throw new Error(`${label} changed before it was read.`);
    bytes = await handle.readFile();
    const afterRead = await handle.stat();
    if (!sameRegularFile(opened, afterRead)) {
      throw new Error(`${label} changed while it was read.`);
    }
  } finally {
    await handle?.close();
  }
  const after = await lstat(filePath);
  if (!sameRegularFile(opened, after) || bytes.length !== after.size) {
    throw new Error(`${label} changed while its path identity was confirmed.`);
  }
  return bytes;
};

const assetEntry = async ({ role, filePath }) => {
  const linkMetadata = await lstat(filePath);
  const metadata = await stat(filePath);
  if (
    linkMetadata.isSymbolicLink() ||
    !metadata.isFile() ||
    linkMetadata.nlink !== 1 ||
    metadata.nlink !== 1 ||
    metadata.size < 1
  ) {
    throw new Error(`Final release asset is missing or empty: ${filePath}.`);
  }
  const relativePath = path.relative(repositoryRoot, filePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('Final release asset escaped the repository workspace.');
  }
  const identity = {
    role,
    path: relativePath.split(path.sep).join('/'),
    name: path.basename(filePath),
    size: metadata.size,
    sha256: await sha256(filePath),
  };
  const confirmation = await lstat(filePath);
  if (!sameRegularFile(linkMetadata, confirmation) || confirmation.size !== identity.size) {
    throw new Error(`Final release asset changed while it was hashed: ${filePath}.`);
  }
  return identity;
};

const syncDirectoryMetadata = async (directory) => {
  let handle;
  try {
    handle = await open(directory, process.platform === 'win32' ? 'r+' : 'r');
    await handle.sync();
  } finally {
    await handle?.close();
  }
};

const mkdirDurably = async (directory) => {
  const resolved = path.resolve(directory);
  const missing = [];
  let current = resolved;
  for (;;) {
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`Final release output path is not a plain directory: ${current}.`);
      }
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      missing.push(current);
      const parent = path.dirname(current);
      if (parent === current) throw new Error(`No existing parent found for ${resolved}.`);
      current = parent;
    }
  }
  await mkdir(resolved, { recursive: true });
  await syncDirectoryMetadata(current);
  for (const created of missing.reverse()) {
    await assertSafeReleaseDirectoryPath({ directory: created });
    await syncDirectoryMetadata(created);
    await syncDirectoryMetadata(path.dirname(created));
  }
};

const atomicCreateOrVerifyJson = async (filePath, value) => {
  const expected = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error('Existing final release record is not a regular non-link file.');
    }
    if ((await readFile(filePath, 'utf8')) !== expected) {
      throw new Error('Existing final release record differs from the exact candidate record.');
    }
    return 'reused';
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
  }
  await mkdirDurably(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, 'wx');
    await handle.writeFile(expected, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
    await syncDirectoryMetadata(path.dirname(filePath));
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true });
  }
  if ((await readFile(filePath, 'utf8')) !== expected) {
    throw new Error('Final release record failed durable read-back verification.');
  }
  return 'created';
};

const options = parseArgs(process.argv.slice(2));
const releaseLock = await acquireReleaseLock({
  transactionParent: promotionParent,
  purpose: 'finalize-windows-release',
});
try {
  await assertNoPendingReleasePromotions({ transactionParent: promotionParent, releaseLock });
  await assertSafeReleaseDirectoryPath({ directory: repositoryRoot });
  const assertCandidateRootsPlain = async () => {
    await assertSafeReleaseDirectoryPath({ directory: options.artifactDir });
    await assertSafeReleaseDirectoryPath({ directory: options.evidenceDir });
  };
  await assertCandidateRootsPlain();
  if (!isStrictDescendant(repositoryRoot, options.notesFile)) {
    throw new Error('Public release notes must be a regular file inside the repository.');
  }
  const notesMetadata = await lstat(options.notesFile);
  if (notesMetadata.isSymbolicLink() || !notesMetadata.isFile()) {
    throw new Error('Public release notes must be a regular non-link file.');
  }
  const notesBody = await readFile(options.notesFile, 'utf8');
  assertPublishableReleaseNotes(notesBody);
  assertTrackedReleaseNotes({
    repositoryRoot,
    notesFile: options.notesFile,
    runGit: (args) => run('git', args, { capture: true }),
  });
  const notes = await assetEntry({ role: 'release-notes', filePath: options.notesFile });

  const desktopPackage = await readJson(
    path.join(repositoryRoot, 'apps', 'desktop', 'package.json'),
  );
  const rootPackage = await readJson(path.join(repositoryRoot, 'package.json'));
  const candidatePath = path.join(options.evidenceDir, 'release-candidate-v1.json');
  const evidenceManifestPath = path.join(options.evidenceDir, 'release-manifest.json');
  const contentInventoryPath = path.join(options.evidenceDir, 'content-inventory.json');
  const functionalManifestPath = path.join(options.evidenceDir, FUNCTIONAL_VALIDATION_FILE_NAME);
  const functionalBundlePath = path.join(options.evidenceDir, FUNCTIONAL_VALIDATION_BUNDLE_NAME);
  const securityEvidencePath = path.join(options.evidenceDir, SECURITY_EVIDENCE_FILE_NAME);
  const candidateManifestBytes = await readRegularFileStable(
    candidatePath,
    'Release candidate manifest',
  );
  const candidateManifest = JSON.parse(candidateManifestBytes.toString('utf8'));
  const evidenceManifest = await readJson(evidenceManifestPath);
  const contentInventory = await readJson(contentInventoryPath);
  if (
    evidenceManifest?.release?.generatedAt !== contentInventory?.generatedAt ||
    !Number.isFinite(Date.parse(evidenceManifest?.release?.generatedAt ?? '')) ||
    new Date(evidenceManifest.release.generatedAt).toISOString() !==
      evidenceManifest.release.generatedAt
  ) {
    throw new Error('Release evidence and content inventory timestamps are not exactly bound.');
  }
  const tag = options.tag ?? `v${desktopPackage.version}`;
  const outputPath =
    options.outputPath ??
    path.join(
      repositoryRoot,
      'artifacts',
      'release-assets',
      `HTMLlelujah-${desktopPackage.version}-${candidateManifest.source?.commit?.slice(0, 12) ?? 'unknown'}-release-record.json`,
    );
  const artifactsRoot = path.join(repositoryRoot, 'artifacts');
  if (
    !isStrictDescendant(artifactsRoot, outputPath) ||
    isStrictDescendant(options.artifactDir, outputPath) ||
    isStrictDescendant(options.evidenceDir, outputPath) ||
    outputPath === options.artifactDir ||
    outputPath === options.evidenceDir
  ) {
    throw new Error(
      'The final release record must be ignored under artifacts/ and outside candidate/evidence roots.',
    );
  }
  await assertSafeReleaseDirectoryPath({ directory: path.dirname(outputPath), allowMissing: true });

  if (options.publishMode !== 'none') {
    let existingRecordBytes = null;
    try {
      existingRecordBytes = await readRegularFileStable(
        outputPath,
        'Existing final release record',
      );
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
    if (existingRecordBytes !== null) {
      let existingRecord;
      try {
        existingRecord = JSON.parse(existingRecordBytes.toString('utf8'));
      } catch {
        throw new Error(
          'Existing final release record is not valid JSON; publication is refused and any GitHub draft must be left unchanged.',
        );
      }
      assertExistingFinalRecordSecurityReceipt({
        finalRecord: existingRecord,
        securityEvidenceBytes: await readRegularFileStable(
          securityEvidencePath,
          'Security evidence',
        ),
      });
    }
  }

  const readPublicationBinding = () => {
    const currentSource = gitSourceState(repositoryRoot);
    if (currentSource.dirty) throw new Error('Final release recording requires a clean worktree.');
    const remoteUrl = run('git', ['remote', 'get-url', options.remote], { capture: true });
    const canonicalRepositoryUrl = assertGithubRepositoryRemote({
      remoteUrl,
      repository: EXPECTED_GITHUB_REPOSITORY,
    });
    const localTagObjectType = run('git', ['cat-file', '-t', `refs/tags/${tag}`], {
      capture: true,
    });
    const localTagObjectId = run('git', ['rev-parse', '--verify', `refs/tags/${tag}`], {
      capture: true,
    });
    const localTagCommit = run('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], {
      capture: true,
    });
    const remoteTagOutput = run(
      'git',
      [
        'ls-remote',
        '--exit-code',
        '--tags',
        options.remote,
        `refs/tags/${tag}`,
        `refs/tags/${tag}^{}`,
      ],
      { capture: true },
    );
    const remoteTag = remoteTagIdentityFromLsRemote({ output: remoteTagOutput, tag });
    assertReleasePublicationBinding({
      manifest: candidateManifest,
      tag,
      currentCommit: currentSource.commit,
      localTagCommit,
      localTagObjectType,
      localTagObjectId,
      remoteTagCommit: remoteTag.commit,
      remoteTagObjectId: remoteTag.objectId,
      remoteUrl,
      canonicalRepositoryUrl,
    });
    return {
      currentSource,
      remoteUrl,
      canonicalRepositoryUrl,
      localTagCommit,
      localTagObjectType,
      localTagObjectId,
      remoteTagCommit: remoteTag.commit,
      remoteTagObjectId: remoteTag.objectId,
    };
  };

  const initialBinding = readPublicationBinding();

  const verifyExactFunctionalState = async () => {
    await assertCandidateRootsPlain();
    const sourceBefore = await captureSourceSnapshot(repositoryRoot, { requireClean: true });
    const currentCandidateBytes = await readRegularFileStable(
      candidatePath,
      'Release candidate manifest',
    );
    if (!currentCandidateBytes.equals(candidateManifestBytes)) {
      throw new Error('Release candidate manifest changed during finalization.');
    }
    const currentCandidate = JSON.parse(currentCandidateBytes.toString('utf8'));
    const artifactInventoryBefore = await buildDirectoryInventory(options.artifactDir);
    assertCandidateManifest({
      manifest: currentCandidate,
      inventory: artifactInventoryBefore.files,
      version: desktopPackage.version,
      source: sourceBefore,
    });
    const lockfileBytes = await readRegularFileStable(
      path.join(repositoryRoot, 'pnpm-lock.yaml'),
      'Release lockfile',
    );
    const lockfileSha256 = createHash('sha256').update(lockfileBytes).digest('hex');
    const functionalManifestBytes = await readRegularFileStable(
      functionalManifestPath,
      'Functional validation manifest',
    );
    const functionalBundleBytes = await readRegularFileStable(
      functionalBundlePath,
      'Functional validation evidence bundle',
    );
    const functional = verifyFunctionalValidationPair({
      manifestBytes: functionalManifestBytes,
      bundleBytes: functionalBundleBytes,
      candidateManifest: currentCandidate,
      candidateManifestBytes: currentCandidateBytes,
      artifactInventory: artifactInventoryBefore,
      source: sourceBefore,
      lockfileSha256,
      packageManager: rootPackage.packageManager,
      platform: process.platform,
      architecture: process.arch,
      osRelease: operatingSystemRelease(),
      osVersion: operatingSystemVersion(),
      nodeVersion: process.version,
    });

    const [candidateConfirmation, lockfileConfirmation, manifestConfirmation, bundleConfirmation] =
      await Promise.all([
        readRegularFileStable(candidatePath, 'Release candidate manifest'),
        readRegularFileStable(path.join(repositoryRoot, 'pnpm-lock.yaml'), 'Release lockfile'),
        readRegularFileStable(functionalManifestPath, 'Functional validation manifest'),
        readRegularFileStable(functionalBundlePath, 'Functional validation evidence bundle'),
      ]);
    const artifactInventoryAfter = await buildDirectoryInventory(options.artifactDir);
    const sourceAfter = await captureSourceSnapshot(repositoryRoot, { requireClean: true });
    await assertCandidateRootsPlain();
    if (
      !candidateConfirmation.equals(currentCandidateBytes) ||
      !lockfileConfirmation.equals(lockfileBytes) ||
      !manifestConfirmation.equals(functionalManifestBytes) ||
      !bundleConfirmation.equals(functionalBundleBytes) ||
      JSON.stringify(artifactInventoryAfter) !== JSON.stringify(artifactInventoryBefore) ||
      JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore)
    ) {
      throw new Error('Functional release state changed while it was verified.');
    }
    const { evidenceFiles, ...functionalIdentity } = functional;
    return {
      source: sourceBefore,
      candidateManifest: currentCandidate,
      candidateManifestSha256: createHash('sha256').update(currentCandidateBytes).digest('hex'),
      lockfileSha256,
      artifactInventory: artifactInventoryBefore,
      functionalValidation: {
        ...functionalIdentity,
        evidenceFileCount: evidenceFiles.length,
      },
    };
  };

  const verifySecurityGate = () =>
    run(
      process.execPath,
      [
        'scripts/verify-security-release-evidence.mjs',
        '--artifact-dir',
        options.artifactDir,
        '--evidence-dir',
        options.evidenceDir,
      ],
      { timeoutMs: 600_000 },
    );

  run(
    process.execPath,
    [
      'scripts/verify-release-evidence.mjs',
      '--artifact-dir',
      options.artifactDir,
      '--evidence-dir',
      options.evidenceDir,
      '--require-ready',
    ],
    { timeoutMs: 600_000 },
  );
  verifySecurityGate();

  const initialFunctionalState = await verifyExactFunctionalState();
  if (
    JSON.stringify(initialFunctionalState.candidateManifest) !== JSON.stringify(candidateManifest)
  ) {
    throw new Error('Evidence candidate manifest changed during final release recording.');
  }
  if (
    evidenceManifest?.quality?.releaseReady !== true ||
    evidenceManifest?.release?.source?.commit !== candidateManifest.source.commit ||
    evidenceManifest?.artifact?.aggregateSha256 !== candidateManifest.artifact.aggregateSha256
  ) {
    throw new Error('Release evidence is not bound to the exact candidate source and artifacts.');
  }

  const collectPublicationAssets = async () => {
    await assertCandidateRootsPlain();
    const artifactAsset = (entry) => path.join(options.artifactDir, ...entry.path.split('/'));
    const result = [
      await assetEntry({
        role: 'windows-installer',
        filePath: artifactAsset(candidateManifest.artifact.installer),
      }),
      await assetEntry({
        role: 'installer-blockmap',
        filePath: artifactAsset(candidateManifest.artifact.blockmap),
      }),
    ];
    for (const [role, name] of [
      ['checksums', 'checksums-sha256.txt'],
      ['cyclonedx-sbom', 'build-sbom.cdx.json'],
      ['dependency-sbom', DEPENDENCY_SBOM_FILE_NAME],
      ['content-inventory', 'content-inventory.json'],
      ['candidate-manifest', 'release-candidate-v1.json'],
      ['release-evidence', 'release-manifest.json'],
      ['functional-validation', FUNCTIONAL_VALIDATION_FILE_NAME],
      ['functional-validation-evidence', FUNCTIONAL_VALIDATION_BUNDLE_NAME],
      ['security-evidence', SECURITY_EVIDENCE_FILE_NAME],
    ]) {
      result.push(await assetEntry({ role, filePath: path.join(options.evidenceDir, name) }));
    }
    await assertCandidateRootsPlain();
    return result;
  };
  const assets = await collectPublicationAssets();
  if (new Set(assets.map((entry) => entry.name)).size !== assets.length) {
    throw new Error('Final release assets contain duplicate public filenames.');
  }

  run(
    process.execPath,
    [
      'scripts/verify-release-evidence.mjs',
      '--artifact-dir',
      options.artifactDir,
      '--evidence-dir',
      options.evidenceDir,
      '--require-ready',
    ],
    { timeoutMs: 600_000 },
  );
  verifySecurityGate();
  const finalBinding = readPublicationBinding();
  const finalFunctionalState = await verifyExactFunctionalState();
  const finalEvidenceManifest = await readJson(evidenceManifestPath);
  const finalAssets = await collectPublicationAssets();
  if (
    JSON.stringify(finalFunctionalState) !== JSON.stringify(initialFunctionalState) ||
    JSON.stringify(finalEvidenceManifest) !== JSON.stringify(evidenceManifest) ||
    JSON.stringify(finalAssets) !== JSON.stringify(assets) ||
    JSON.stringify(finalBinding) !== JSON.stringify(initialBinding)
  ) {
    throw new Error(
      'Release candidate, evidence, source, tag, or asset identity changed during finalization.',
    );
  }
  await assertNoPendingReleasePromotions({ transactionParent: promotionParent, releaseLock });

  const title = `HTMLlelujah ${tag}`;
  const record = buildFinalReleaseRecord({
    version: desktopPackage.version,
    candidateManifest,
    evidenceManifest,
    tag,
    remote: options.remote,
    binding: finalBinding,
    repository: EXPECTED_GITHUB_REPOSITORY,
    title,
    notes,
    assets,
    candidateManifestSha256: finalFunctionalState.candidateManifestSha256,
    evidenceManifestSha256: assets.find((asset) => asset.role === 'release-evidence').sha256,
    functionalValidation: finalFunctionalState.functionalValidation,
  });
  const recordDisposition = await atomicCreateOrVerifyJson(outputPath, record);
  const confirmation = await readJson(outputPath);
  const postWriteAssets = await collectPublicationAssets();
  const postWriteFunctionalState = await verifyExactFunctionalState();
  verifySecurityGate();
  const postWriteBinding = readPublicationBinding();
  await assertNoPendingReleasePromotions({ transactionParent: promotionParent, releaseLock });
  if (
    JSON.stringify(confirmation) !== JSON.stringify(record) ||
    JSON.stringify(postWriteAssets) !== JSON.stringify(assets) ||
    JSON.stringify(postWriteFunctionalState) !== JSON.stringify(finalFunctionalState) ||
    JSON.stringify(postWriteBinding) !== JSON.stringify(finalBinding)
  ) {
    throw new Error('Final release record failed its post-write verification.');
  }
  const recordAsset = {
    ...(await assetEntry({ role: 'final-release-record', filePath: outputPath })),
    filePath: outputPath,
  };
  const uploadAssets = [
    ...assets.map((asset) => ({
      ...asset,
      filePath: path.join(repositoryRoot, ...asset.path.split('/')),
    })),
    recordAsset,
  ];
  if (new Set(uploadAssets.map((asset) => asset.name)).size !== uploadAssets.length) {
    throw new Error('Publication allowlist contains duplicate filenames after adding the record.');
  }

  const revalidateBinding = async (stage) => {
    verifySecurityGate();
    const currentBinding = readPublicationBinding();
    const currentFunctionalState = await verifyExactFunctionalState();
    const currentAssets = await collectPublicationAssets();
    const currentRecord = await assetEntry({ role: 'final-release-record', filePath: outputPath });
    const currentNotes = await assetEntry({ role: 'release-notes', filePath: options.notesFile });
    const confirmedBinding = readPublicationBinding();
    await assertNoPendingReleasePromotions({ transactionParent: promotionParent, releaseLock });
    if (
      JSON.stringify(currentBinding) !== JSON.stringify(finalBinding) ||
      JSON.stringify(confirmedBinding) !== JSON.stringify(finalBinding) ||
      JSON.stringify(currentFunctionalState) !== JSON.stringify(finalFunctionalState) ||
      JSON.stringify(currentAssets) !== JSON.stringify(assets) ||
      currentRecord.sha256 !== recordAsset.sha256 ||
      currentRecord.size !== recordAsset.size ||
      JSON.stringify(currentNotes) !== JSON.stringify(notes)
    ) {
      throw new Error(`Release identities changed during GitHub publication (${stage}).`);
    }
  };

  let publicationResult = null;
  if (options.publishMode !== 'none') {
    publicationResult = await runGithubReleasePublication({
      mode: options.publishMode,
      repositoryRoot,
      artifactsRoot,
      repository: EXPECTED_GITHUB_REPOSITORY,
      tag,
      title,
      notesFile: options.notesFile,
      notesBody,
      assets: uploadAssets,
      environment: releaseEnvironment,
      revalidateBinding,
    });
    await revalidateBinding('finalizer-post-publication');
  }

  process.stdout.write(`Final release record (${recordDisposition}): ${outputPath}\n`);
  process.stdout.write(`Final release record SHA-256: ${recordAsset.sha256}\n`);
  if (publicationResult) {
    process.stdout.write(
      `GitHub release ${tag} verified as ${publicationResult.release.draft ? 'draft' : 'public'}${publicationResult.resumed ? ' (resumed)' : ''}.\n`,
    );
  } else {
    process.stdout.write(
      'Publication was not requested; use --publish-draft or --publish with this exact record.\n',
    );
  }
} finally {
  await releaseReleaseLock({ releaseLock });
}
