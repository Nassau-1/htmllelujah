import { createHash } from 'node:crypto';
import path from 'node:path';

export const INSTALLER_SMOKE_TEMP_PREFIXES = Object.freeze([
  'htmllelujah-installer-smoke-',
  'htmllelujah-ui-smoke-',
  'htmllelujah-electron-smoke-',
]);

export const NSIS_INSTALLED_TREE_ALLOWLIST = Object.freeze([
  Object.freeze({
    path: 'Uninstall HTMLlelujah.exe',
    minSize: 1_024,
    maxSize: 64 * 1_024 * 1_024,
  }),
]);

const sha256Pattern = /^[0-9a-f]{64}$/u;
const windowsDeviceNamePattern = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

const windowsPathKey = (value) => value.normalize('NFC').toLocaleUpperCase('en-US');

const assertSafeInventoryPath = (value, label) => {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value !== value.normalize('NFC') ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value.includes('\\') ||
    /[\u0000-\u001f<>:"|?*]/u.test(value)
  ) {
    throw new Error(`${label} contains an unsafe relative path.`);
  }
  const segments = value.split('/');
  if (
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        segment.endsWith('.') ||
        segment.endsWith(' ') ||
        windowsDeviceNamePattern.test(segment),
    )
  ) {
    throw new Error(`${label} is not representable as a unique Windows path.`);
  }
  return value;
};

const parentDirectories = (entryPath) => {
  const segments = entryPath.split('/');
  const directories = [];
  for (let index = 1; index < segments.length; index += 1) {
    directories.push(segments.slice(0, index).join('/'));
  }
  return directories;
};

const inventoryAggregate = (entries) => {
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

const assertUniqueWindowsPaths = (entries, label) => {
  const seen = new Map();
  for (const entry of entries) {
    const key = windowsPathKey(entry.path);
    const prior = seen.get(key);
    if (prior !== undefined) {
      throw new Error(
        `${label} contains duplicate, case-colliding, or file/directory-colliding paths.`,
      );
    }
    seen.set(key, entry);
  }
};

export const assertCandidateWinUnpackedInventory = (manifest) => {
  const inventory = manifest?.artifact?.winUnpacked;
  if (!Array.isArray(inventory?.files) || inventory.files.length === 0) {
    throw new Error('The candidate win-unpacked inventory is missing.');
  }
  if (inventory.files.length > 50_000) {
    throw new Error('The candidate win-unpacked inventory exceeds its file-count budget.');
  }

  const files = inventory.files.map((entry) => {
    const entryPath = assertSafeInventoryPath(entry?.path, 'Candidate win-unpacked inventory');
    if (
      !Number.isSafeInteger(entry?.size) ||
      entry.size < 0 ||
      !sha256Pattern.test(entry?.sha256 ?? '')
    ) {
      throw new Error('The candidate win-unpacked inventory contains an invalid file identity.');
    }
    return { path: entryPath, size: entry.size, sha256: entry.sha256 };
  });
  const directories = [...new Set(files.flatMap((entry) => parentDirectories(entry.path)))].map(
    (entryPath) => ({ path: entryPath, kind: 'directory' }),
  );
  assertUniqueWindowsPaths(
    [...directories, ...files.map((entry) => ({ path: entry.path, kind: 'file' }))],
    'Candidate win-unpacked inventory',
  );

  const totalSize = files.reduce((sum, entry) => sum + entry.size, 0);
  if (
    !Number.isSafeInteger(totalSize) ||
    inventory.fileCount !== files.length ||
    inventory.totalSize !== totalSize ||
    inventory.aggregateSha256 !== inventoryAggregate(files)
  ) {
    throw new Error('The candidate win-unpacked aggregate identity is inconsistent.');
  }

  return {
    files,
    directories: directories.map((entry) => entry.path),
    fileCount: files.length,
    directoryCount: directories.length,
    totalSize,
    aggregateSha256: inventory.aggregateSha256,
  };
};

const shortPathList = (entries) => entries.slice(0, 5).join(', ');

export const assertInstalledTreeMatchesCandidate = ({
  manifest,
  entries,
  generatedAllowlist = NSIS_INSTALLED_TREE_ALLOWLIST,
  expectedGeneratedFiles,
}) => {
  const candidate = assertCandidateWinUnpackedInventory(manifest);
  if (!Array.isArray(entries)) throw new Error('The installed tree inventory is missing.');
  if (!Array.isArray(generatedAllowlist) || generatedAllowlist.length !== 1) {
    throw new Error('The NSIS-generated installed-file allowlist must contain exactly one entry.');
  }

  const allowlist = generatedAllowlist.map((entry) => {
    const entryPath = assertSafeInventoryPath(entry?.path, 'NSIS installed-file allowlist');
    if (
      !Number.isSafeInteger(entry?.minSize) ||
      !Number.isSafeInteger(entry?.maxSize) ||
      entry.minSize < 1 ||
      entry.maxSize < entry.minSize
    ) {
      throw new Error('The NSIS installed-file allowlist has invalid size bounds.');
    }
    return { path: entryPath, minSize: entry.minSize, maxSize: entry.maxSize };
  });
  assertUniqueWindowsPaths(
    allowlist.map((entry) => ({ path: entry.path, kind: 'generated-file' })),
    'NSIS installed-file allowlist',
  );

  const candidateKeys = new Set(
    [...candidate.directories, ...candidate.files.map((entry) => entry.path)].map(windowsPathKey),
  );
  if (allowlist.some((entry) => candidateKeys.has(windowsPathKey(entry.path)))) {
    throw new Error('The candidate payload overlaps the NSIS-generated installed-file allowlist.');
  }

  const normalizedEntries = entries.map((entry) => {
    const entryPath = assertSafeInventoryPath(entry?.path, 'Installed tree inventory');
    if (entry?.reparsePoint === true || entry?.kind === 'symlink' || entry?.kind === 'reparse') {
      throw new Error(`Installed tree contains a symlink or reparse point: ${entryPath}`);
    }
    if (entry?.kind !== 'file' && entry?.kind !== 'directory') {
      throw new Error(`Installed tree contains a non-regular entry: ${entryPath}`);
    }
    if (
      entry.kind === 'file' &&
      (!Number.isSafeInteger(entry?.size) ||
        entry.size < 0 ||
        !sha256Pattern.test(entry?.sha256 ?? ''))
    ) {
      throw new Error(`Installed tree contains an invalid file identity: ${entryPath}`);
    }
    return {
      path: entryPath,
      kind: entry.kind,
      reparsePoint: false,
      ...(entry.kind === 'file' ? { size: entry.size, sha256: entry.sha256 } : {}),
    };
  });
  assertUniqueWindowsPaths(normalizedEntries, 'Installed tree inventory');

  const expectedDirectories = new Set([
    ...candidate.directories,
    ...allowlist.flatMap((entry) => parentDirectories(entry.path)),
  ]);
  const actualFiles = new Map(
    normalizedEntries.filter((entry) => entry.kind === 'file').map((entry) => [entry.path, entry]),
  );
  const actualDirectories = new Set(
    normalizedEntries.filter((entry) => entry.kind === 'directory').map((entry) => entry.path),
  );
  const expectedFiles = new Map(candidate.files.map((entry) => [entry.path, entry]));
  const allowedFiles = new Map(allowlist.map((entry) => [entry.path, entry]));

  const missingFiles = [...expectedFiles.keys()].filter((entryPath) => !actualFiles.has(entryPath));
  const surplusFiles = [...actualFiles.keys()].filter(
    (entryPath) => !expectedFiles.has(entryPath) && !allowedFiles.has(entryPath),
  );
  const missingDirectories = [...expectedDirectories].filter(
    (entryPath) => !actualDirectories.has(entryPath),
  );
  const surplusDirectories = [...actualDirectories].filter(
    (entryPath) => !expectedDirectories.has(entryPath),
  );
  if (
    missingFiles.length > 0 ||
    surplusFiles.length > 0 ||
    missingDirectories.length > 0 ||
    surplusDirectories.length > 0
  ) {
    const details = [
      missingFiles.length > 0 ? `missing files: ${shortPathList(missingFiles)}` : null,
      surplusFiles.length > 0 ? `surplus files: ${shortPathList(surplusFiles)}` : null,
      missingDirectories.length > 0
        ? `missing directories: ${shortPathList(missingDirectories)}`
        : null,
      surplusDirectories.length > 0
        ? `surplus directories: ${shortPathList(surplusDirectories)}`
        : null,
    ].filter(Boolean);
    throw new Error(`Installed tree differs from the candidate payload (${details.join('; ')}).`);
  }

  const mismatchedFiles = candidate.files
    .filter((expected) => {
      const actual = actualFiles.get(expected.path);
      return actual.size !== expected.size || actual.sha256 !== expected.sha256;
    })
    .map((entry) => entry.path);
  if (mismatchedFiles.length > 0) {
    throw new Error(
      `Installed payload size or SHA-256 differs from the candidate: ${shortPathList(mismatchedFiles)}.`,
    );
  }

  const generatedFiles = allowlist.map((allowed) => {
    const actual = actualFiles.get(allowed.path);
    if (actual === undefined) {
      throw new Error(`Required NSIS-generated installed file is missing: ${allowed.path}.`);
    }
    if (actual.size < allowed.minSize || actual.size > allowed.maxSize) {
      throw new Error(`NSIS-generated installed file has an invalid size: ${allowed.path}.`);
    }
    return { path: actual.path, size: actual.size, sha256: actual.sha256 };
  });

  if (expectedGeneratedFiles !== undefined) {
    if (!Array.isArray(expectedGeneratedFiles)) {
      throw new Error('The baseline NSIS-generated file inventory is invalid.');
    }
    const baseline = expectedGeneratedFiles.map((entry) => ({
      path: entry?.path,
      size: entry?.size,
      sha256: entry?.sha256,
    }));
    if (JSON.stringify(generatedFiles) !== JSON.stringify(baseline)) {
      throw new Error('The NSIS-generated installed files changed across maintenance phases.');
    }
  }

  const installedPayload = candidate.files.map((entry) => actualFiles.get(entry.path));
  const installedAggregateSha256 = inventoryAggregate(installedPayload);
  if (installedAggregateSha256 !== candidate.aggregateSha256) {
    throw new Error('The installed payload aggregate SHA-256 differs from the candidate.');
  }

  return {
    exactTreeMatch: true,
    fileCount: candidate.fileCount,
    directoryCount: candidate.directoryCount,
    totalSize: candidate.totalSize,
    aggregateSha256: installedAggregateSha256,
    generatedFiles,
  };
};

export const parseInstallerSmokeArguments = (arguments_, defaultInstaller) => {
  let installer;
  let finalArtifact = false;

  for (const argument of arguments_) {
    if (argument === '--final-artifact') {
      if (finalArtifact) throw new Error('--final-artifact may only be supplied once.');
      finalArtifact = true;
      continue;
    }
    if (argument.startsWith('-')) throw new Error(`Unknown installer smoke option: ${argument}`);
    if (installer !== undefined) throw new Error('Only one installer path may be supplied.');
    installer = argument;
  }

  if (!finalArtifact) {
    throw new Error(
      'Release evidence requires --final-artifact so a diagnostic run cannot be mistaken for V1 proof.',
    );
  }

  return {
    installer: path.resolve(installer ?? defaultInstaller),
    finalArtifact,
  };
};

export const expectedUnsignedInstallerName = (version) =>
  `HTMLlelujah-${version}-x64-unsigned-Setup.exe`;

export const assertOwnedTemporaryPath = (candidate, temporaryDirectory, prefix) => {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedTemporaryDirectory = path.resolve(temporaryDirectory);
  const relative = path.relative(resolvedTemporaryDirectory, resolvedCandidate);
  if (
    relative === '' ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    !path.basename(resolvedCandidate).startsWith(prefix)
  ) {
    throw new Error(`Refusing unsafe installer smoke directory: ${resolvedCandidate}`);
  }
  return resolvedCandidate;
};

export const newTemporaryEntries = (before, after) =>
  [...after].filter((entry) => !before.has(entry)).sort((left, right) => left.localeCompare(right));

export const sameAssociationState = (before, after) =>
  before.extensionKeyRegistered === after.extensionKeyRegistered &&
  before.openWithKeyRegistered === after.openWithKeyRegistered &&
  before.extensionDefault === after.extensionDefault &&
  before.productClassRegistered === after.productClassRegistered &&
  JSON.stringify([...before.openWithProgIds].sort()) ===
    JSON.stringify([...after.openWithProgIds].sort());

const normalizeWindowsExecutablePath = (value) =>
  typeof value === 'string' && value.trim() !== ''
    ? path.win32.normalize(value).toLocaleLowerCase('en-US')
    : null;

/** Selects only exact product executables with a trustworthy creation timestamp. */
export const selectOwnedProcessRecords = (records, installedExecutable) => {
  const expected = normalizeWindowsExecutablePath(installedExecutable);
  if (expected === null) throw new Error('The installed executable path is invalid.');
  return [
    ...new Map(
      records
        .filter(
          (record) =>
            Number.isSafeInteger(record?.processId) &&
            record.processId > 0 &&
            Number.isSafeInteger(record.createdAtMs) &&
            record.createdAtMs > 0 &&
            normalizeWindowsExecutablePath(record.executablePath) === expected,
        )
        .map((record) => [record.processId, record]),
    ).values(),
  ].sort((left, right) => left.processId - right.processId);
};

export const expectedInstallerRegistryKeys = (guid) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(guid)) {
    throw new Error('The NSIS GUID is invalid.');
  }
  return {
    install: `Software\\${guid}`,
    uninstall: `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`,
  };
};

const sameIdentity = (left, right) =>
  left?.sha256 === right?.sha256 && left?.size === right?.size && left?.mtimeMs === right?.mtimeMs;

const samePayloadIdentity = (left, right) =>
  left?.sha256 === right?.sha256 && left?.size === right?.size;

export const assertReleaseCandidateManifest = (manifest, expected) => {
  assertCandidateWinUnpackedInventory(manifest);
  const artifactFiles = Array.isArray(manifest?.artifact?.files) ? manifest.artifact.files : [];
  const artifactEntry = (entryPath) => artifactFiles.find((entry) => entry.path === entryPath);
  const unpackedFiles = Array.isArray(manifest?.artifact?.winUnpacked?.files)
    ? manifest.artifact.winUnpacked.files
    : [];
  const unpackedEntry = (entryPath) => unpackedFiles.find((entry) => entry.path === entryPath);
  const workspacePackages = manifest?.build?.workspacePackages;
  if (
    manifest?.schemaVersion !== 2 ||
    manifest.productName !== expected.productName ||
    manifest.version !== expected.version ||
    manifest.source?.commit !== expected.source.commit ||
    manifest.source?.dirty !== false ||
    manifest.source?.treeSha256 !== expected.source.treeSha256 ||
    manifest.source?.fileCount !== expected.source.fileCount ||
    manifest.source?.bytes !== expected.source.bytes ||
    manifest.lockfile?.path !== 'pnpm-lock.yaml' ||
    manifest.lockfile?.sha256 !== expected.lockfileSha256 ||
    JSON.stringify(manifest.build?.embeddedProvenance) !==
      JSON.stringify(expected.embeddedProvenance) ||
    !Array.isArray(workspacePackages) ||
    workspacePackages.length === 0 ||
    JSON.stringify(workspacePackages) !==
      JSON.stringify(expected.embeddedProvenance.workspacePackages) ||
    !samePayloadIdentity(manifest.artifact?.installer, expected.installer) ||
    manifest.artifact?.installer?.path !== expected.installer.path ||
    !samePayloadIdentity(manifest.artifact?.blockmap, expected.blockmap) ||
    manifest.artifact?.blockmap?.path !== expected.blockmap.path ||
    !samePayloadIdentity(artifactEntry(expected.installer.path), expected.installer) ||
    !samePayloadIdentity(artifactEntry(expected.blockmap.path), expected.blockmap) ||
    !samePayloadIdentity(
      artifactEntry('win-unpacked/HTMLlelujah.exe'),
      expected.companion.executable,
    ) ||
    !samePayloadIdentity(
      artifactEntry('win-unpacked/resources/app.asar'),
      expected.companion.appAsar,
    ) ||
    !samePayloadIdentity(unpackedEntry('HTMLlelujah.exe'), expected.companion.executable) ||
    !samePayloadIdentity(unpackedEntry('resources/app.asar'), expected.companion.appAsar) ||
    manifest.artifact?.fileCount !== artifactFiles.length ||
    manifest.artifact?.winUnpacked?.fileCount !== unpackedFiles.length ||
    !/^[0-9a-f]{64}$/u.test(manifest.artifact?.aggregateSha256 ?? '') ||
    !/^[0-9a-f]{64}$/u.test(manifest.artifact?.winUnpacked?.aggregateSha256 ?? '')
  ) {
    throw new Error(
      'The release-candidate manifest is not bound to this exact source and payload.',
    );
  }
};

export const assertCleanSourceState = (state) => {
  if (!/^[0-9a-f]{40}$/u.test(state?.commit ?? '') || state?.dirty !== false) {
    throw new Error('Release evidence requires a clean repository at an exact source commit.');
  }
};

export const assertSourceStateUnchanged = (before, after) => {
  assertCleanSourceState(before);
  assertCleanSourceState(after);
  if (before.commit !== after.commit) {
    throw new Error('The source commit changed while the installer smoke was running.');
  }
};

export const assertStableHarnessManifest = (before, after) => {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error('A release-smoke harness or support script changed while it was running.');
  }
};

const registryIdentityToken = ({ kind, hive, key }) =>
  `${kind}\u0000${String(hive).toUpperCase()}\u0000${String(key).toLowerCase()}`;

const identities = (state) => [
  ...(state.installKeyIdentities ?? []).map((entry) => ({ ...entry, kind: 'install' })),
  ...(state.uninstallKeyIdentities ?? []).map((entry) => ({ ...entry, kind: 'uninstall' })),
];

export const captureCreatedProductRegistryIdentities = (before, installed) => {
  const prior = new Set(identities(before).map(registryIdentityToken));
  const owned = [
    ...(installed.installRecords ?? []).map((entry) => ({ ...entry, kind: 'install' })),
    ...(installed.uninstallRecords ?? []).map((entry) => ({ ...entry, kind: 'uninstall' })),
  ];
  const unique = [...new Map(owned.map((entry) => [registryIdentityToken(entry), entry])).values()];
  const created = unique.filter((entry) => !prior.has(registryIdentityToken(entry)));
  if (
    created.length !== unique.length ||
    !created.some((entry) => entry.kind === 'install') ||
    !created.some((entry) => entry.kind === 'uninstall')
  ) {
    throw new Error('The exact per-user product registry keys were not newly created by install.');
  }
  return created;
};

export const remainingCapturedRegistryIdentities = (captured, state) => {
  const present = new Set(identities(state).map(registryIdentityToken));
  return captured.filter((entry) => present.has(registryIdentityToken(entry)));
};

export const assertStableArtifact = (before, after) => {
  if (
    before.sha256 !== after.sha256 ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error('The installer artifact changed while its release smoke was running.');
  }
};

export const normalizeJsonArray = (value) =>
  value === null || value === undefined ? [] : Array.isArray(value) ? value : [value];
