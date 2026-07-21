import path from 'node:path';

import {
  FUNCTIONAL_VALIDATION_BUNDLE_NAME,
  FUNCTIONAL_VALIDATION_FILE_NAME,
} from './windows-candidate-validation-support.mjs';
import {
  SECURITY_EVIDENCE_FILE_NAME,
  SECURITY_EVIDENCE_MAX_AGE_MS,
  sha256Bytes,
} from './security-release-evidence-support.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const SECURITY_RECEIPT_RECOVERY =
  'Leave any existing GitHub draft unchanged; do not delete or overwrite its assets. Create a new versioned candidate and annotated tag, collect fresh security evidence, and publish a new GitHub release.';

const securityReceiptRefusal = (reason) => {
  throw new Error(
    `Publication from the existing final release record is refused because ${reason} ${SECURITY_RECEIPT_RECOVERY}`,
  );
};

export const assertExistingFinalRecordSecurityReceipt = ({
  finalRecord,
  securityEvidenceBytes,
  now = Date.now(),
  maxAgeMs = SECURITY_EVIDENCE_MAX_AGE_MS,
}) => {
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new Error('Security receipt freshness bounds are invalid.');
  }
  const assets = finalRecord?.publication?.assets;
  const matches = Array.isArray(assets)
    ? assets.filter(
        (asset) =>
          asset?.role === 'security-evidence' || asset?.name === SECURITY_EVIDENCE_FILE_NAME,
      )
    : [];
  if (
    matches.length !== 1 ||
    matches[0]?.role !== 'security-evidence' ||
    matches[0]?.name !== SECURITY_EVIDENCE_FILE_NAME ||
    !Number.isSafeInteger(matches[0]?.size) ||
    matches[0].size < 1 ||
    !SHA256.test(matches[0]?.sha256 ?? '')
  ) {
    securityReceiptRefusal(
      `its immutable ${SECURITY_EVIDENCE_FILE_NAME} identity is missing or malformed.`,
    );
  }

  const bytes = Buffer.isBuffer(securityEvidenceBytes)
    ? securityEvidenceBytes
    : Buffer.from(securityEvidenceBytes ?? '');
  if (bytes.length !== matches[0].size || sha256Bytes(bytes) !== matches[0].sha256) {
    securityReceiptRefusal(
      `its immutable ${SECURITY_EVIDENCE_FILE_NAME} identity differs from the current security evidence.`,
    );
  }

  let securityEvidence;
  try {
    securityEvidence = JSON.parse(bytes.toString('utf8'));
  } catch {
    securityReceiptRefusal(`the bound ${SECURITY_EVIDENCE_FILE_NAME} is not valid JSON.`);
  }
  const generatedAt = securityEvidence?.generatedAt;
  const generatedTime = Date.parse(generatedAt ?? '');
  if (
    typeof generatedAt !== 'string' ||
    !Number.isFinite(generatedTime) ||
    new Date(generatedTime).toISOString() !== generatedAt
  ) {
    securityReceiptRefusal(
      `the bound ${SECURITY_EVIDENCE_FILE_NAME} has no exact generation timestamp.`,
    );
  }
  if (generatedTime > now) {
    securityReceiptRefusal(
      `the bound ${SECURITY_EVIDENCE_FILE_NAME} is dated in the future and is not currently valid.`,
    );
  }
  const expiresAt = generatedTime + maxAgeMs;
  if (now > expiresAt) {
    securityReceiptRefusal(
      `the bound ${SECURITY_EVIDENCE_FILE_NAME} expired at ${new Date(expiresAt).toISOString()}.`,
    );
  }
  return {
    generatedAt,
    expiresAt: new Date(expiresAt).toISOString(),
    size: bytes.length,
    sha256: matches[0].sha256,
  };
};

const exactFunctionalValidationAsset = ({ assets, name, role, size, sha256 }) => {
  if (!Array.isArray(assets)) {
    throw new Error('Final release assets are required for functional validation binding.');
  }
  const matches = assets.filter((asset) => asset?.name === name);
  if (matches.length !== 1) {
    throw new Error(`Final release assets must contain exactly one ${name}.`);
  }
  const [asset] = matches;
  if (
    asset.role !== role ||
    typeof asset.path !== 'string' ||
    asset.path.length === 0 ||
    asset.path.includes('\0') ||
    asset.path.includes('\\') ||
    /^[a-z]:/iu.test(asset.path) ||
    path.posix.isAbsolute(asset.path) ||
    path.win32.isAbsolute(asset.path) ||
    path.posix.normalize(asset.path) !== asset.path ||
    asset.path.split('/').some((part) => part === '' || part === '.' || part === '..') ||
    path.posix.basename(asset.path) !== name ||
    asset.size !== size ||
    asset.sha256 !== sha256
  ) {
    throw new Error(`Final release asset ${name} does not match its functional validation record.`);
  }
  return asset;
};

export const assertTrackedReleaseNotes = ({ repositoryRoot, notesFile, runGit }) => {
  const relative = path.relative(path.resolve(repositoryRoot), path.resolve(notesFile));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Public release notes escaped the repository.');
  }
  const gitPath = relative.split(path.sep).join('/');
  runGit(['ls-files', '--error-unmatch', '--', gitPath]);
  const worktreeBlob = runGit(['hash-object', '--', path.resolve(notesFile)]);
  const headBlob = runGit(['rev-parse', '--verify', `HEAD:${gitPath}`]);
  if (worktreeBlob !== headBlob) {
    throw new Error('Public release notes do not exactly match their tracked blob at HEAD.');
  }
  return { gitPath, blobObjectId: headBlob };
};

export const buildFinalReleaseRecord = ({
  version,
  candidateManifest,
  evidenceManifest,
  tag,
  remote,
  binding,
  repository,
  title,
  notes,
  assets,
  candidateManifestSha256,
  evidenceManifestSha256,
  functionalValidation,
}) => {
  if (
    typeof binding?.canonicalRepositoryUrl !== 'string' ||
    binding.canonicalRepositoryUrl.length === 0 ||
    typeof binding?.remoteUrl !== 'string' ||
    binding.remoteUrl.length === 0
  ) {
    throw new Error('Final release binding lacks the exact repository URLs.');
  }
  const generatedAt = evidenceManifest?.release?.generatedAt;
  if (
    typeof generatedAt !== 'string' ||
    !Number.isFinite(Date.parse(generatedAt)) ||
    new Date(generatedAt).toISOString() !== generatedAt
  ) {
    throw new Error('Release evidence lacks its deterministic generation timestamp.');
  }
  const functionalManifest = functionalValidation?.manifest;
  if (
    functionalManifest?.releaseReady !== true ||
    functionalManifest?.candidate?.manifestSha256 !== candidateManifestSha256 ||
    functionalManifest?.candidate?.artifactAggregateSha256 !==
      candidateManifest?.artifact?.aggregateSha256 ||
    functionalManifest?.source?.commit !== candidateManifest?.source?.commit ||
    functionalManifest?.source?.treeSha256 !== candidateManifest?.source?.treeSha256 ||
    functionalManifest?.source?.fileCount !== candidateManifest?.source?.fileCount ||
    functionalManifest?.source?.bytes !== candidateManifest?.source?.bytes ||
    functionalManifest?.source?.lockfileSha256 !== candidateManifest?.lockfile?.sha256 ||
    functionalManifest?.bundle?.fileName !== FUNCTIONAL_VALIDATION_BUNDLE_NAME ||
    functionalManifest?.bundle?.sha256 !== functionalValidation?.bundleSha256 ||
    functionalManifest?.bundle?.size !== functionalValidation?.bundleSize ||
    !SHA256.test(functionalValidation?.manifestSha256 ?? '') ||
    !SHA256.test(functionalValidation?.bundleSha256 ?? '') ||
    !SHA256.test(functionalManifest?.evidence?.aggregateSha256 ?? '') ||
    !Number.isSafeInteger(functionalValidation?.manifestSize) ||
    functionalValidation.manifestSize < 1 ||
    !Number.isSafeInteger(functionalValidation?.bundleSize) ||
    functionalValidation.bundleSize < 1
  ) {
    throw new Error('Final release record lacks an exact release-ready functional validation.');
  }
  const functionalManifestAsset = exactFunctionalValidationAsset({
    assets,
    name: FUNCTIONAL_VALIDATION_FILE_NAME,
    role: 'functional-validation',
    size: functionalValidation.manifestSize,
    sha256: functionalValidation.manifestSha256,
  });
  const functionalBundleAsset = exactFunctionalValidationAsset({
    assets,
    name: FUNCTIONAL_VALIDATION_BUNDLE_NAME,
    role: 'functional-validation-evidence',
    size: functionalValidation.bundleSize,
    sha256: functionalValidation.bundleSha256,
  });
  return {
    schemaVersion: 2,
    productName: 'HTMLlelujah',
    version,
    generatedAt,
    source: {
      commit: candidateManifest.source.commit,
      tag,
      localTagCommit: binding.localTagCommit,
      localTagObjectType: binding.localTagObjectType,
      localTagObjectId: binding.localTagObjectId,
      remote,
      remoteUrl: binding.remoteUrl,
      remoteTagCommit: binding.remoteTagCommit,
      remoteTagObjectId: binding.remoteTagObjectId,
      repository,
      repositoryUrl: binding.canonicalRepositoryUrl,
      clean: true,
    },
    candidate: {
      buildId: candidateManifest.buildId,
      manifestSha256: candidateManifestSha256,
      artifactAggregateSha256: candidateManifest.artifact.aggregateSha256,
      evidenceManifestSha256,
    },
    functionalValidation: {
      releaseReady: true,
      generatedAt: functionalManifest.generatedAt,
      manifest: {
        path: functionalManifestAsset.path,
        name: functionalManifestAsset.name,
        size: functionalManifestAsset.size,
        sha256: functionalManifestAsset.sha256,
      },
      evidence: {
        fileCount: functionalManifest.evidence.fileCount,
        totalSize: functionalManifest.evidence.totalSize,
        aggregateSha256: functionalManifest.evidence.aggregateSha256,
      },
      bundle: {
        path: functionalBundleAsset.path,
        name: functionalBundleAsset.name,
        size: functionalBundleAsset.size,
        sha256: functionalBundleAsset.sha256,
      },
      binding: {
        candidateManifestSha256,
        artifactAggregateSha256: candidateManifest.artifact.aggregateSha256,
        sourceCommit: candidateManifest.source.commit,
        sourceTreeSha256: candidateManifest.source.treeSha256,
        lockfileSha256: candidateManifest.lockfile.sha256,
      },
    },
    publication: {
      allowed: true,
      repository,
      repositoryUrl: binding.canonicalRepositoryUrl,
      title,
      notes,
      invariant:
        'The local annotated tag object, remote annotated tag object, current HEAD, and candidate manifest identify one exact commit.',
      electronBuilderPublishMode: 'never',
      assets,
      finalRecordIsAdditionalAsset: true,
      finalRecordExcludedFromCandidateHashes: true,
      trackedSourceMutationRequired: false,
    },
  };
};
