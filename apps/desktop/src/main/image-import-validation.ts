import { HdeckError, parseImageHeader, type ParsedImageHeader } from '@htmllelujah/hdeck';
import type { Frame, PageSize } from '@htmllelujah/document-core';

/** Keep renderer-to-main image transfers well below the canonical document asset ceiling. */
export const MAX_DESKTOP_IMAGE_BYTES = 25 * 1024 * 1024;

export class ImageImportValidationError extends Error {
  public constructor(
    public readonly code: 'INVALID_IMAGE' | 'IMAGE_LIMIT_EXCEEDED' | 'DECODE_MISMATCH',
    message: string,
  ) {
    super(message);
    this.name = 'ImageImportValidationError';
  }
}

/** Parses only bounded headers. Call this before passing bytes to a pixel decoder. */
export const inspectImageBeforeDecode = (bytes: Uint8Array): ParsedImageHeader => {
  if (bytes.byteLength === 0) {
    throw new ImageImportValidationError('INVALID_IMAGE', 'The image is empty.');
  }
  if (bytes.byteLength > MAX_DESKTOP_IMAGE_BYTES) {
    throw new ImageImportValidationError(
      'IMAGE_LIMIT_EXCEEDED',
      'Choose an image smaller than 25 MB.',
    );
  }
  try {
    return parseImageHeader(bytes);
  } catch (error) {
    if (error instanceof HdeckError) {
      throw new ImageImportValidationError(
        error.code === 'ARCHIVE_LIMIT_EXCEEDED' ? 'IMAGE_LIMIT_EXCEEDED' : 'INVALID_IMAGE',
        error.code === 'ARCHIVE_LIMIT_EXCEEDED'
          ? 'The image dimensions exceed safe limits.'
          : 'The selected file is not a supported image.',
      );
    }
    throw error;
  }
};

export interface DecodedImageDimensions {
  readonly empty: boolean;
  readonly widthPx: number;
  readonly heightPx: number;
}

export const assertDecodedDimensions = (
  header: ParsedImageHeader,
  decoded: DecodedImageDimensions,
): void => {
  if (decoded.empty || decoded.widthPx !== header.widthPx || decoded.heightPx !== header.heightPx) {
    throw new ImageImportValidationError(
      'DECODE_MISMATCH',
      'The image data does not match its safe header.',
    );
  }
};

/**
 * Applies the exact same bounded header and decoded-pixel checks to dialog and clipboard bytes.
 * A clipboard MIME claim is authoritative only when it agrees with the inspected byte header.
 */
export const validateImageImportBytes = (
  bytes: Uint8Array,
  decode: (bytes: Uint8Array) => DecodedImageDimensions,
  declaredMediaType?: ParsedImageHeader['mediaType'],
): ParsedImageHeader => {
  const header = inspectImageBeforeDecode(bytes);
  if (declaredMediaType !== undefined && declaredMediaType !== header.mediaType) {
    throw new ImageImportValidationError(
      'INVALID_IMAGE',
      'The clipboard image type does not match its contents.',
    );
  }
  assertDecodedDimensions(header, decode(bytes));
  return header;
};

/** Fits a newly imported image entirely inside any valid custom page, including tiny pages. */
export const imageFrameForPage = (widthPx: number, heightPx: number, page: PageSize): Frame => {
  const ratio = widthPx / heightPx;
  const availableWidth = page.widthPt < 1e-6 ? page.widthPt : page.widthPt * 0.9;
  const availableHeight = page.heightPt < 1e-6 ? page.heightPt : page.heightPt * 0.9;
  const naturalWidth = Math.min(480, ratio >= 1 ? 420 : 300);
  const naturalHeight = Math.min(300, naturalWidth / Math.max(0.2, ratio));
  let widthPt = Math.min(naturalWidth, availableWidth);
  let heightPt = Math.min(naturalHeight, availableHeight);
  if (!Number.isFinite(widthPt) || widthPt <= 0) widthPt = availableWidth;
  if (!Number.isFinite(heightPt) || heightPt <= 0) heightPt = availableHeight;
  widthPt = Math.min(widthPt, page.widthPt);
  heightPt = Math.min(heightPt, page.heightPt);
  return {
    xPt: Math.max(0, (page.widthPt - widthPt) / 2),
    yPt: Math.max(0, (page.heightPt - heightPt) / 2),
    widthPt,
    heightPt,
    rotationDeg: 0,
  };
};
