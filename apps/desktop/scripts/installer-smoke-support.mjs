import path from 'node:path';

export const INSTALLER_SMOKE_TEMP_PREFIXES = Object.freeze([
  'htmllelujah-installer-smoke-',
  'htmllelujah-ui-smoke-',
  'htmllelujah-electron-smoke-',
]);

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

/** Selects only the exact installed executable and its observed process descendants. */
export const selectOwnedProcessRecords = (records, installedExecutable) => {
  const expected = normalizeWindowsExecutablePath(installedExecutable);
  if (expected === null) throw new Error('The installed executable path is invalid.');
  const byPid = new Map(
    records
      .filter((record) => Number.isSafeInteger(record?.processId) && record.processId > 0)
      .map((record) => [record.processId, record]),
  );
  const owned = new Set(
    [...byPid.values()]
      .filter((record) => normalizeWindowsExecutablePath(record.executablePath) === expected)
      .map((record) => record.processId),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of byPid.values()) {
      if (
        !owned.has(record.processId) &&
        Number.isSafeInteger(record.parentProcessId) &&
        owned.has(record.parentProcessId)
      ) {
        owned.add(record.processId);
        changed = true;
      }
    }
  }
  return [...owned].sort((left, right) => left - right).map((processId) => byPid.get(processId));
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
