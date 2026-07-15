import { createHash } from 'node:crypto';

import { DOCUMENT_LIMITS, type AssetRef, type DeckDocument } from '@htmllelujah/document-core';

import { ExporterError, type ExportAssets } from './types.js';

const SUPPORTED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_TOTAL_ASSET_BYTES = 200 * 1024 * 1024;

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

const asAssetMap = (assets: ExportAssets): ReadonlyMap<string, Uint8Array> => {
  if (!Array.isArray(assets)) return assets as ReadonlyMap<string, Uint8Array>;
  const map = new Map<string, Uint8Array>();
  for (const asset of assets) {
    if (map.has(asset.id)) {
      throw new ExporterError('ASSET_INVALID', 'Export assets contain a duplicate identifier.');
    }
    map.set(asset.id, asset.bytes);
  }
  return map;
};

const hasPngSignature = (bytes: Uint8Array): boolean =>
  bytes.length >= 8 &&
  bytes[0] === 0x89 &&
  bytes[1] === 0x50 &&
  bytes[2] === 0x4e &&
  bytes[3] === 0x47 &&
  bytes[4] === 0x0d &&
  bytes[5] === 0x0a &&
  bytes[6] === 0x1a &&
  bytes[7] === 0x0a;

const hasJpegSignature = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 &&
  bytes[0] === 0xff &&
  bytes[1] === 0xd8 &&
  bytes[2] === 0xff &&
  bytes.at(-2) === 0xff &&
  bytes.at(-1) === 0xd9;

const ascii = (bytes: Uint8Array, offset: number, value: string): boolean =>
  [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0));

const hasWebpSignature = (bytes: Uint8Array): boolean =>
  bytes.length >= 12 && ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP');

const matchesSignature = (mediaType: string, bytes: Uint8Array): boolean => {
  if (mediaType === 'image/png') return hasPngSignature(bytes);
  if (mediaType === 'image/jpeg') return hasJpegSignature(bytes);
  if (mediaType === 'image/webp') return hasWebpSignature(bytes);
  return false;
};

const validateAsset = (reference: AssetRef, bytes: Uint8Array): void => {
  if (reference.kind !== 'image' || !SUPPORTED_MEDIA_TYPES.has(reference.mediaType)) {
    throw new ExporterError(
      'ASSET_INVALID',
      'Only validated PNG, JPEG, and WebP assets can be exported.',
    );
  }
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > DOCUMENT_LIMITS.maxAssetByteLength ||
    (reference.byteLength !== undefined && reference.byteLength !== bytes.byteLength)
  ) {
    throw new ExporterError(
      'ASSET_LIMIT_EXCEEDED',
      'An export asset is outside the supported size limits.',
    );
  }
  if (!matchesSignature(reference.mediaType, bytes) || sha256Hex(bytes) !== reference.hash) {
    throw new ExporterError('ASSET_INVALID', 'An export asset failed integrity validation.');
  }
};

export const createDataAssetResolver = (
  document: DeckDocument,
  assets: ExportAssets,
  requiredAssetIds: ReadonlySet<string> = new Set(document.assets.map((asset) => asset.id)),
): ((assetId: string) => string | null) => {
  const supplied = asAssetMap(assets);
  const declared = new Map(document.assets.map((asset) => [asset.id, asset]));
  let totalBytes = 0;
  const dataUrls = new Map<string, string>();
  for (const assetId of requiredAssetIds) {
    const reference = declared.get(assetId);
    const bytes = supplied.get(assetId);
    if (reference === undefined || bytes === undefined) {
      throw new ExporterError('ASSET_INVALID', 'A declared export asset is unavailable.');
    }
    validateAsset(reference, bytes);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_ASSET_BYTES) {
      throw new ExporterError('ASSET_LIMIT_EXCEEDED', 'Export assets exceed the total size limit.');
    }
    const base64 = Buffer.from(bytes).toString('base64');
    if (!/^[a-z0-9+/]+={0,2}$/i.test(base64)) {
      throw new ExporterError('ASSET_INVALID', 'An export asset could not be encoded safely.');
    }
    dataUrls.set(assetId, `data:${reference.mediaType};base64,${base64}`);
  }
  for (const assetId of supplied.keys()) {
    if (!declared.has(assetId)) {
      throw new ExporterError('ASSET_INVALID', 'An undeclared export asset was supplied.');
    }
  }
  return (assetId: string): string | null => dataUrls.get(assetId) ?? null;
};
