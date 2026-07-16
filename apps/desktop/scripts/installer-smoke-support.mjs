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
  before.extensionDefault === after.extensionDefault &&
  before.productClassRegistered === after.productClassRegistered &&
  JSON.stringify([...before.openWithProgIds].sort()) ===
    JSON.stringify([...after.openWithProgIds].sort());

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
