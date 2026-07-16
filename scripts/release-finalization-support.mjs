import path from 'node:path';

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
  return {
    schemaVersion: 1,
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
