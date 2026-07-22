import path from 'node:path';

type DialogPathApi = Pick<
  typeof path,
  'basename' | 'dirname' | 'isAbsolute' | 'join' | 'normalize' | 'parse' | 'sep'
>;

type DialogPlatformPathApi = Pick<typeof path, 'sep'>;

const windowsReservedDeviceName =
  /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/iu;

/**
 * Neutralizes Win32 device aliases while preserving the user's spelling and extension.
 * Windows resolves the portion before the first dot as a device name after ignoring
 * leading ASCII spaces plus trailing ASCII spaces and dots, so names such as
 * ` con.hdeck`, `con .hdeck`, and `LPT1...pdf` require the same treatment as aliases.
 */
export const neutralizeWindowsReservedFileName = (
  fileName: string,
  pathApi: DialogPlatformPathApi = path,
): string => {
  if (pathApi.sep !== '\\') return fileName;
  const firstDotIndex = fileName.indexOf('.');
  const deviceCandidate = (firstDotIndex === -1 ? fileName : fileName.slice(0, firstDotIndex))
    .replace(/^ +/gu, '')
    .replace(/[ .]+$/gu, '');
  return windowsReservedDeviceName.test(deviceCandidate) ? `_${fileName}` : fileName;
};

const isFullyQualifiedDialogPath = (candidate: string, pathApi: DialogPathApi): boolean => {
  if (candidate.length === 0 || candidate.includes('\u0000')) return false;
  const normalized = pathApi.normalize(candidate);
  if (!pathApi.isAbsolute(normalized)) return false;

  if (pathApi.sep === '\\') {
    if (normalized.startsWith('\\\\?\\') || normalized.startsWith('\\\\.\\')) return false;
    const root = pathApi.parse(normalized).root;
    return /^[A-Za-z]:\\$/u.test(root) || /^\\\\[^\\]+\\[^\\]+\\$/u.test(root);
  }

  return pathApi.parse(normalized).root === pathApi.sep;
};

export const buildSaveDialogDefaultPath = (
  input: {
    readonly fallbackDirectory: string;
    readonly defaultFileName: string;
    readonly currentSaveTarget?: string | undefined;
  },
  pathApi: DialogPathApi = path,
): string => {
  const { fallbackDirectory, defaultFileName, currentSaveTarget } = input;
  if (
    defaultFileName.length === 0 ||
    defaultFileName.includes('\u0000') ||
    defaultFileName === '.' ||
    defaultFileName === '..' ||
    pathApi.basename(defaultFileName) !== defaultFileName
  ) {
    throw new TypeError('The default file name must be a plain file name.');
  }
  if (!isFullyQualifiedDialogPath(fallbackDirectory, pathApi)) {
    throw new TypeError('The fallback directory must be fully qualified.');
  }

  const directory =
    currentSaveTarget !== undefined && isFullyQualifiedDialogPath(currentSaveTarget, pathApi)
      ? pathApi.dirname(pathApi.normalize(currentSaveTarget))
      : pathApi.normalize(fallbackDirectory);
  const safeDefaultFileName = neutralizeWindowsReservedFileName(defaultFileName, pathApi);
  const result = pathApi.join(directory, safeDefaultFileName);
  if (!isFullyQualifiedDialogPath(result, pathApi)) {
    throw new TypeError('The dialog default path must be fully qualified.');
  }
  return result;
};
