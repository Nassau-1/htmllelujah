import { createHash } from 'node:crypto';

const aggregateInventory = (entries) => {
  const digest = createHash('sha256');
  for (const entry of entries) {
    digest.update(entry.path);
    digest.update('\0');
    digest.update(String(entry.size));
    digest.update('\0');
    digest.update(entry.sha256);
    digest.update('\n');
  }
  return digest.digest('hex');
};

const sameEntry = (left, right) =>
  left?.path === right?.path && left?.size === right?.size && left?.sha256 === right?.sha256;

const expectedInstallerName = (version) => `HTMLlelujah-${version}-x64-unsigned-Setup.exe`;

export const candidateManifestErrors = ({ manifest, inventory, version, source = null }) => {
  const errors = [];
  const expectedInstaller = expectedInstallerName(version);
  const expectedBlockmap = `${expectedInstaller}.blockmap`;
  if (manifest?.schemaVersion !== 2) errors.push('unsupported candidate manifest schema');
  if (manifest?.productName !== 'HTMLlelujah' || manifest?.version !== version) {
    errors.push('candidate product or version mismatch');
  }
  if (
    manifest?.source?.dirty !== false ||
    !/^[0-9a-f]{40,64}$/u.test(manifest?.source?.commit ?? '') ||
    !/^[0-9a-f]{64}$/u.test(manifest?.source?.treeSha256 ?? '') ||
    !/^[0-9a-f]{64}$/u.test(manifest?.lockfile?.sha256 ?? '')
  ) {
    errors.push('candidate source is not a clean exact commit');
  }
  if (source) {
    if (source.commit !== manifest?.source?.commit) {
      errors.push('candidate source does not match the current source commit');
    }
  }
  const manifestFiles = manifest?.artifact?.files;
  if (!Array.isArray(manifestFiles)) {
    errors.push('candidate artifact inventory is missing');
    return errors;
  }
  const manifestPaths = manifestFiles.map((entry) => entry.path);
  if (
    new Set(manifestPaths).size !== manifestPaths.length ||
    manifestPaths.some(
      (entryPath) =>
        typeof entryPath !== 'string' ||
        entryPath === '' ||
        entryPath.startsWith('/') ||
        entryPath.includes('..') ||
        entryPath.includes('\\'),
    )
  ) {
    errors.push('candidate artifact inventory contains unsafe or duplicate paths');
  }
  if (manifestFiles.length !== inventory.length) {
    errors.push('candidate artifact file count differs from the evidence inventory');
  }
  for (let index = 0; index < Math.max(manifestFiles.length, inventory.length); index += 1) {
    if (!sameEntry(manifestFiles[index], inventory[index])) {
      errors.push(`candidate artifact inventory mismatch at index ${index}`);
      break;
    }
  }
  const totalSize = inventory.reduce((sum, entry) => sum + entry.size, 0);
  const aggregateSha256 = aggregateInventory(inventory);
  if (
    manifest?.artifact?.fileCount !== inventory.length ||
    manifest?.artifact?.totalSize !== totalSize ||
    manifest?.artifact?.aggregateSha256 !== aggregateSha256
  ) {
    errors.push('candidate aggregate artifact identity is inconsistent');
  }
  const installer = inventory.find((entry) => entry.path === expectedInstaller);
  const blockmap = inventory.find((entry) => entry.path === expectedBlockmap);
  if (!sameEntry(manifest?.artifact?.installer, installer)) {
    errors.push('candidate installer identity is missing or inconsistent');
  }
  if (!sameEntry(manifest?.artifact?.blockmap, blockmap)) {
    errors.push('candidate blockmap identity is missing or inconsistent');
  }
  const unpacked = inventory
    .filter((entry) => entry.path.startsWith('win-unpacked/'))
    .map((entry) => ({ ...entry, path: entry.path.slice('win-unpacked/'.length) }));
  const manifestUnpacked = manifest?.artifact?.winUnpacked;
  if (
    manifestUnpacked?.fileCount !== unpacked.length ||
    manifestUnpacked?.totalSize !== unpacked.reduce((sum, entry) => sum + entry.size, 0) ||
    manifestUnpacked?.aggregateSha256 !== aggregateInventory(unpacked) ||
    JSON.stringify(manifestUnpacked?.files) !== JSON.stringify(unpacked)
  ) {
    errors.push('candidate win-unpacked inventory is incomplete or inconsistent');
  }
  const provenance = manifest?.build?.embeddedProvenance;
  if (
    provenance?.schemaVersion !== 2 ||
    provenance?.buildId !== manifest?.buildId ||
    provenance?.sourceCommit !== manifest?.source?.commit ||
    provenance?.sourceDirty !== false ||
    provenance?.sourceTreeSha256 !== manifest?.source?.treeSha256 ||
    provenance?.lockfileSha256 !== manifest?.lockfile?.sha256
  ) {
    errors.push('embedded build provenance is missing or inconsistent');
  }
  const workspacePackages = manifest?.build?.workspacePackages;
  if (JSON.stringify(provenance?.workspacePackages) !== JSON.stringify(workspacePackages)) {
    errors.push('embedded provenance workspace packages differ from the candidate manifest');
  }
  if (!Array.isArray(workspacePackages) || workspacePackages.length === 0) {
    errors.push('workspace package rebuild attestation is missing');
  } else {
    const names = new Set();
    for (const [index, entry] of workspacePackages.entries()) {
      if (
        !entry?.name ||
        names.has(entry.name) ||
        entry.buildOrder !== index + 1 ||
        typeof entry.path !== 'string' ||
        !entry.path.startsWith('packages/') ||
        entry?.dist?.fileCount < 1 ||
        !entry?.dist?.aggregateSha256
      ) {
        errors.push('workspace package rebuild attestation is invalid');
        break;
      }
      names.add(entry.name);
    }
  }
  return errors;
};

export const assertCandidateManifest = (options) => {
  const errors = candidateManifestErrors(options);
  if (errors.length > 0) {
    throw new Error(`Release candidate manifest failed validation: ${errors.join('; ')}`);
  }
};
