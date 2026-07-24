import type { ClipboardImageMediaType } from '../../shared/desktop-api.js';

export const MAX_EXTERNAL_CLIPBOARD_IMAGE_BYTES = 25 * 1024 * 1024;

const MEDIA_TYPE_PRIORITY: Readonly<Record<ClipboardImageMediaType, number>> = Object.freeze({
  'image/png': 0,
  'image/webp': 1,
  'image/jpeg': 2,
});

const EXTENSION_BY_MEDIA_TYPE: Readonly<Record<ClipboardImageMediaType, string>> = Object.freeze({
  'image/png': 'png',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
});

const isClipboardImageMediaType = (value: string): value is ClipboardImageMediaType =>
  value === 'image/png' || value === 'image/jpeg' || value === 'image/webp';

export class ExternalClipboardImageError extends Error {
  public constructor(
    public readonly code: 'IMAGE_TOO_LARGE' | 'IMAGE_EMPTY' | 'IMAGE_READ_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'ExternalClipboardImageError';
  }
}

export interface ExternalClipboardImage {
  readonly bytes: Uint8Array;
  readonly mediaType: ClipboardImageMediaType;
  readonly fileName: string;
}

interface ClipboardImageCandidate {
  readonly file: File;
  readonly mediaType: ClipboardImageMediaType;
  readonly ordinal: number;
}

const fileNameIsSafe = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 255 &&
  value !== '.' &&
  value !== '..' &&
  !/[\u0000-\u001f<>:"/\\|?*]/u.test(value) &&
  !/^[a-z][a-z0-9+.-]*:/iu.test(value);

/**
 * File.name should already be a basename, but the renderer never forwards path-like or URL-like
 * clipboard metadata. A stable generic name is used when the source name is unsafe.
 */
export const normalizeExternalClipboardImageFileName = (
  candidate: string,
  mediaType: ClipboardImageMediaType,
): string => {
  const extension = EXTENSION_BY_MEDIA_TYPE[mediaType];
  const trimmed = candidate.trim();
  if (!fileNameIsSafe(trimmed)) return `Clipboard image.${extension}`;
  const withoutExtension = trimmed
    .replace(/\.[^.]+$/u, '')
    .trim()
    .slice(0, 240);
  if (!fileNameIsSafe(withoutExtension)) return `Clipboard image.${extension}`;
  return `${withoutExtension}.${extension}`;
};

const candidateFromFile = (
  file: File | null,
  itemMediaType: string,
  ordinal: number,
): ClipboardImageCandidate | null => {
  if (file === null) return null;
  const mediaType = isClipboardImageMediaType(file.type)
    ? file.type
    : isClipboardImageMediaType(itemMediaType)
      ? itemMediaType
      : null;
  return mediaType === null ? null : { file, mediaType, ordinal };
};

const fileHasBoundedBytes = (file: File): boolean =>
  file.size > 0 && file.size <= MAX_EXTERNAL_CLIPBOARD_IMAGE_BYTES;

const collectCandidates = (
  clipboardData: Pick<DataTransfer, 'items' | 'files'>,
): readonly ClipboardImageCandidate[] => {
  const candidates: ClipboardImageCandidate[] = [];
  const seen = new Set<File>();
  let ordinal = 0;

  for (const item of Array.from(clipboardData.items)) {
    if (item.kind !== 'file') {
      ordinal += 1;
      continue;
    }
    let file: File | null = null;
    try {
      file = item.getAsFile();
    } catch {
      // A malformed clipboard provider cannot prevent inspecting the bounded file fallback.
    }
    const candidate = candidateFromFile(file, item.type, ordinal);
    if (candidate !== null && !seen.has(candidate.file)) {
      seen.add(candidate.file);
      candidates.push(candidate);
    }
    ordinal += 1;
  }

  for (const file of Array.from(clipboardData.files)) {
    if (!seen.has(file)) {
      const candidate = candidateFromFile(file, file.type, ordinal);
      if (candidate !== null) {
        seen.add(file);
        candidates.push(candidate);
      }
    }
    ordinal += 1;
  }

  return candidates.sort(
    (left, right) =>
      Number(!fileHasBoundedBytes(left.file)) - Number(!fileHasBoundedBytes(right.file)) ||
      MEDIA_TYPE_PRIORITY[left.mediaType] - MEDIA_TYPE_PRIORITY[right.mediaType] ||
      left.file.size - right.file.size ||
      left.file.name.localeCompare(right.file.name) ||
      left.ordinal - right.ordinal,
  );
};

/**
 * Extracts only real clipboard file bytes. It deliberately ignores HTML, data URLs, remote URLs,
 * file paths and text representations commonly included beside an Excel or browser image.
 */
export const extractExternalClipboardImage = async (
  clipboardData: Pick<DataTransfer, 'items' | 'files'>,
): Promise<ExternalClipboardImage | null> => {
  const candidate = collectCandidates(clipboardData)[0];
  if (candidate === undefined) return null;
  if (candidate.file.size <= 0) {
    throw new ExternalClipboardImageError('IMAGE_EMPTY', 'The clipboard image is empty.');
  }
  if (candidate.file.size > MAX_EXTERNAL_CLIPBOARD_IMAGE_BYTES) {
    throw new ExternalClipboardImageError('IMAGE_TOO_LARGE', 'Paste an image smaller than 25 MB.');
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await candidate.file.arrayBuffer();
  } catch {
    throw new ExternalClipboardImageError(
      'IMAGE_READ_FAILED',
      'The clipboard image could not be read.',
    );
  }
  const bytes = Uint8Array.from(new Uint8Array(buffer));
  if (bytes.byteLength === 0) {
    throw new ExternalClipboardImageError('IMAGE_EMPTY', 'The clipboard image is empty.');
  }
  if (bytes.byteLength > MAX_EXTERNAL_CLIPBOARD_IMAGE_BYTES) {
    throw new ExternalClipboardImageError('IMAGE_TOO_LARGE', 'Paste an image smaller than 25 MB.');
  }
  return {
    bytes,
    mediaType: candidate.mediaType,
    fileName: normalizeExternalClipboardImageFileName(candidate.file.name, candidate.mediaType),
  };
};

/** Convenience entry point for the window-level paste listener. */
export const extractExternalImageFromClipboardEvent = (
  event: Pick<ClipboardEvent, 'clipboardData'>,
): Promise<ExternalClipboardImage | null> =>
  event.clipboardData === null
    ? Promise.resolve(null)
    : extractExternalClipboardImage(event.clipboardData);
