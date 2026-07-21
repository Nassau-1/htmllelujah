import { DOCUMENT_LIMITS, MAX_CANONICAL_DOCUMENT_BYTES } from '@htmllelujah/document-core';

import { ExporterError } from './types.js';

const MEBIBYTE = 1024 * 1024;

/** Unique decoded asset bytes accepted by one export. */
export const MAX_TOTAL_ASSET_BYTES = 200 * MEBIBYTE;

const MAX_DATA_URL_PREFIX_BYTES = Buffer.byteLength('data:image/jpeg;base64,', 'utf8');
const MAX_BASE64_SPLIT_OVERHEAD = DOCUMENT_LIMITS.maxAssets * 4;
const MAX_ELEMENT_MARKUP_OVERHEAD_BYTES = 4 * 1024;
const MAX_STATIC_DOCUMENT_OVERHEAD_BYTES = MEBIBYTE;

export interface ExportLimits {
  readonly maxProjectedElementOccurrences: number;
  readonly maxProjectedContentBytes: number;
  readonly maxProjectedAssetBytes: number;
  readonly maxOutputUtf8Bytes: number;
}

export type ExportLimitOverrides = Partial<ExportLimits>;

/**
 * Production export ceilings. The asset projection ceiling admits the full unique-asset
 * allowance once, including base64 rounding and the longest supported data-URL prefix.
 */
const MAX_PROJECTED_ASSET_BYTES =
  Math.ceil(MAX_TOTAL_ASSET_BYTES / 3) * 4 +
  MAX_BASE64_SPLIT_OVERHEAD +
  DOCUMENT_LIMITS.maxAssets * MAX_DATA_URL_PREFIX_BYTES;
const MAX_PROJECTED_CONTENT_BYTES = MAX_CANONICAL_DOCUMENT_BYTES * 6;

export const EXPORT_LIMITS: Readonly<ExportLimits> = Object.freeze({
  maxProjectedElementOccurrences: DOCUMENT_LIMITS.maxElements,
  maxProjectedContentBytes: MAX_PROJECTED_CONTENT_BYTES,
  maxProjectedAssetBytes: MAX_PROJECTED_ASSET_BYTES,
  maxOutputUtf8Bytes:
    MAX_PROJECTED_ASSET_BYTES +
    MAX_PROJECTED_CONTENT_BYTES +
    DOCUMENT_LIMITS.maxElements * MAX_ELEMENT_MARKUP_OVERHEAD_BYTES +
    MAX_STATIC_DOCUMENT_OVERHEAD_BYTES,
});

const LIMIT_KEYS = Object.freeze(Object.keys(EXPORT_LIMITS) as readonly (keyof ExportLimits)[]);

export const resolveExportLimits = (
  overrides: ExportLimitOverrides | undefined,
): Readonly<ExportLimits> => {
  if (overrides === undefined) return EXPORT_LIMITS;
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
    throw new ExporterError('INVALID_REQUEST', 'Export limits are invalid.');
  }
  if (Object.keys(overrides).some((key) => !LIMIT_KEYS.includes(key as keyof ExportLimits))) {
    throw new ExporterError('INVALID_REQUEST', 'Export limits are invalid.');
  }
  const resolved = { ...EXPORT_LIMITS };
  for (const key of LIMIT_KEYS) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0 || value > EXPORT_LIMITS[key]) {
      throw new ExporterError(
        'INVALID_REQUEST',
        'Export limits must only lower production ceilings.',
      );
    }
    resolved[key] = value;
  }
  return Object.freeze(resolved);
};
