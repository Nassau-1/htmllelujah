import { createHash } from 'node:crypto';

import {
  canonicalDocumentBytes,
  canonicalSerialize,
  CURRENT_DOCUMENT_SCHEMA_VERSION,
  MAX_CANONICAL_DOCUMENT_BYTES,
  parseDeck,
  type DeckDocument,
} from '@htmllelujah/document-core';

const LOCAL_FILE_SIGNATURE = 0x04034b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const UTF8_FLAG = 0x0800;
const STORE_METHOD = 0;

export const HDECK_LIMITS = Object.freeze({
  maxArchiveBytes: 512 * 1024 * 1024,
  maxEntries: 2048,
  maxEntryBytes: 256 * 1024 * 1024,
  maxDocumentBytes: MAX_CANONICAL_DOCUMENT_BYTES,
  maxManifestBytes: 2 * 1024 * 1024,
  maxNameBytes: 240,
  maxTotalBytes: 512 * 1024 * 1024,
});

export type HdeckErrorCode =
  | 'ARCHIVE_INVALID'
  | 'ARCHIVE_LIMIT_EXCEEDED'
  | 'UNSUPPORTED_COMPRESSION'
  | 'UNSUPPORTED_VERSION'
  | 'HASH_MISMATCH'
  | 'ENTRY_UNDECLARED'
  | 'ASSET_MISSING'
  | 'DOCUMENT_INVALID';

export class HdeckError extends Error {
  public constructor(
    public readonly code: HdeckErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HdeckError';
  }
}

export type ApprovedImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp';
export type ApprovedFontMediaType = 'font/woff2';
export type ApprovedMediaType = ApprovedImageMediaType | ApprovedFontMediaType;

export const IMAGE_HEADER_LIMITS = Object.freeze({
  maxEdgePx: 16_384,
  maxPixelArea: 64 * 1024 * 1024,
  maxHeaderBytes: 1024 * 1024,
  maxJpegSegments: 4_096,
});

export interface ParsedImageHeader {
  readonly mediaType: ApprovedImageMediaType;
  readonly widthPx: number;
  readonly heightPx: number;
}

const imageHeaderInvalid = (message: string): never => {
  throw new HdeckError('ARCHIVE_INVALID', message);
};

const requireImageHeaderRange = (
  bytes: Uint8Array,
  offset: number,
  length: number,
  label: string,
): void => {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > bytes.byteLength
  ) {
    imageHeaderInvalid(`${label} image header is truncated.`);
  }
};

const readUint16BigEndian = (bytes: Uint8Array, offset: number, label: string): number => {
  requireImageHeaderRange(bytes, offset, 2, label);
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
};

const readUint16LittleEndian = (bytes: Uint8Array, offset: number, label: string): number => {
  requireImageHeaderRange(bytes, offset, 2, label);
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
};

const readUint24LittleEndian = (bytes: Uint8Array, offset: number, label: string): number => {
  requireImageHeaderRange(bytes, offset, 3, label);
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
};

const readUint32BigEndian = (bytes: Uint8Array, offset: number, label: string): number => {
  requireImageHeaderRange(bytes, offset, 4, label);
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
};

const readUint32LittleEndian = (bytes: Uint8Array, offset: number, label: string): number => {
  requireImageHeaderRange(bytes, offset, 4, label);
  return (
    ((bytes[offset] ?? 0) +
      ((bytes[offset + 1] ?? 0) << 8) +
      ((bytes[offset + 2] ?? 0) << 16) +
      (bytes[offset + 3] ?? 0) * 0x1000000) >>>
    0
  );
};

const bytesEqual = (bytes: Uint8Array, offset: number, expected: readonly number[]): boolean =>
  offset >= 0 &&
  offset + expected.length <= bytes.byteLength &&
  expected.every((value, index) => bytes[offset + index] === value);

const asciiEquals = (bytes: Uint8Array, offset: number, value: string): boolean =>
  bytesEqual(
    bytes,
    offset,
    [...value].map((character) => character.charCodeAt(0)),
  );

const boundedImageDimensions = (
  mediaType: ApprovedImageMediaType,
  widthPx: number,
  heightPx: number,
): ParsedImageHeader => {
  if (
    !Number.isSafeInteger(widthPx) ||
    !Number.isSafeInteger(heightPx) ||
    widthPx < 1 ||
    heightPx < 1
  ) {
    imageHeaderInvalid('Image dimensions are invalid.');
  }
  if (
    widthPx > IMAGE_HEADER_LIMITS.maxEdgePx ||
    heightPx > IMAGE_HEADER_LIMITS.maxEdgePx ||
    widthPx * heightPx > IMAGE_HEADER_LIMITS.maxPixelArea
  ) {
    throw new HdeckError('ARCHIVE_LIMIT_EXCEEDED', 'Image dimensions exceed safe limits.');
  }
  return { mediaType, widthPx, heightPx };
};

const parsePngHeader = (bytes: Uint8Array): ParsedImageHeader => {
  requireImageHeaderRange(bytes, 0, 29, 'PNG');
  if (readUint32BigEndian(bytes, 8, 'PNG') !== 13 || !asciiEquals(bytes, 12, 'IHDR')) {
    imageHeaderInvalid('PNG image does not start with a canonical IHDR chunk.');
  }
  if ((bytes[26] ?? -1) !== 0 || (bytes[27] ?? -1) !== 0 || (bytes[28] ?? -1) > 1) {
    imageHeaderInvalid('PNG IHDR encoding fields are invalid.');
  }
  const bitDepth = bytes[24] ?? 0;
  const colorType = bytes[25] ?? -1;
  const permittedBitDepths =
    colorType === 0
      ? [1, 2, 4, 8, 16]
      : colorType === 2 || colorType === 4 || colorType === 6
        ? [8, 16]
        : colorType === 3
          ? [1, 2, 4, 8]
          : [];
  if (!permittedBitDepths.includes(bitDepth)) {
    imageHeaderInvalid('PNG IHDR color type or bit depth is invalid.');
  }
  return boundedImageDimensions(
    'image/png',
    readUint32BigEndian(bytes, 16, 'PNG'),
    readUint32BigEndian(bytes, 20, 'PNG'),
  );
};

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

const parseJpegHeader = (bytes: Uint8Array): ParsedImageHeader => {
  let cursor = 2;
  let segments = 0;
  while (cursor < bytes.byteLength && cursor < IMAGE_HEADER_LIMITS.maxHeaderBytes) {
    if ((bytes[cursor] ?? -1) !== 0xff) {
      imageHeaderInvalid('JPEG marker stream is invalid.');
    }
    while (cursor < bytes.byteLength && bytes[cursor] === 0xff) cursor += 1;
    if (cursor >= bytes.byteLength) imageHeaderInvalid('JPEG marker is truncated.');
    const marker = bytes[cursor] ?? 0;
    cursor += 1;
    segments += 1;
    if (segments > IMAGE_HEADER_LIMITS.maxJpegSegments) {
      throw new HdeckError('ARCHIVE_LIMIT_EXCEEDED', 'JPEG header has too many segments.');
    }
    if (marker === 0x00) imageHeaderInvalid('JPEG contains an escaped byte before scan data.');
    if (marker === 0xd9 || marker === 0xda) {
      imageHeaderInvalid('JPEG is missing a start-of-frame header.');
    }
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    const segmentLength = readUint16BigEndian(bytes, cursor, 'JPEG');
    if (segmentLength < 2) imageHeaderInvalid('JPEG segment length is invalid.');
    const segmentEnd = cursor + segmentLength;
    requireImageHeaderRange(bytes, cursor, segmentLength, 'JPEG');
    if (segmentEnd > IMAGE_HEADER_LIMITS.maxHeaderBytes) {
      throw new HdeckError('ARCHIVE_LIMIT_EXCEEDED', 'JPEG dimensions are too deep in the file.');
    }
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 8) imageHeaderInvalid('JPEG start-of-frame header is truncated.');
      const componentCount = bytes[cursor + 7] ?? 0;
      if (componentCount < 1 || segmentLength !== 8 + componentCount * 3) {
        imageHeaderInvalid('JPEG start-of-frame component table is invalid.');
      }
      return boundedImageDimensions(
        'image/jpeg',
        readUint16BigEndian(bytes, cursor + 5, 'JPEG'),
        readUint16BigEndian(bytes, cursor + 3, 'JPEG'),
      );
    }
    cursor = segmentEnd;
  }
  if (cursor >= IMAGE_HEADER_LIMITS.maxHeaderBytes) {
    throw new HdeckError('ARCHIVE_LIMIT_EXCEEDED', 'JPEG dimensions are too deep in the file.');
  }
  return imageHeaderInvalid('JPEG is missing a start-of-frame header.');
};

const parseWebpHeader = (bytes: Uint8Array): ParsedImageHeader => {
  requireImageHeaderRange(bytes, 0, 20, 'WebP');
  const riffLength = readUint32LittleEndian(bytes, 4, 'WebP') + 8;
  if (riffLength !== bytes.byteLength) {
    imageHeaderInvalid('WebP RIFF length does not match the asset bytes.');
  }
  const chunkLength = readUint32LittleEndian(bytes, 16, 'WebP');
  if (20 + chunkLength > bytes.byteLength) {
    imageHeaderInvalid('WebP image chunk is truncated.');
  }
  if (asciiEquals(bytes, 12, 'VP8X')) {
    if (chunkLength !== 10) imageHeaderInvalid('WebP VP8X header length is invalid.');
    if (((bytes[20] ?? 0) & 0xc1) !== 0 || bytes[21] !== 0 || bytes[22] !== 0 || bytes[23] !== 0) {
      imageHeaderInvalid('WebP VP8X reserved fields are invalid.');
    }
    return boundedImageDimensions(
      'image/webp',
      readUint24LittleEndian(bytes, 24, 'WebP') + 1,
      readUint24LittleEndian(bytes, 27, 'WebP') + 1,
    );
  }
  if (asciiEquals(bytes, 12, 'VP8 ')) {
    if (
      chunkLength < 10 ||
      ((bytes[20] ?? 1) & 1) !== 0 ||
      !bytesEqual(bytes, 23, [0x9d, 0x01, 0x2a])
    ) {
      imageHeaderInvalid('WebP VP8 frame header is invalid.');
    }
    return boundedImageDimensions(
      'image/webp',
      readUint16LittleEndian(bytes, 26, 'WebP') & 0x3fff,
      readUint16LittleEndian(bytes, 28, 'WebP') & 0x3fff,
    );
  }
  if (asciiEquals(bytes, 12, 'VP8L')) {
    if (chunkLength < 5 || bytes[20] !== 0x2f || ((bytes[24] ?? 0) & 0xe0) !== 0) {
      imageHeaderInvalid('WebP VP8L frame header is invalid.');
    }
    const byteOne = bytes[21] ?? 0;
    const byteTwo = bytes[22] ?? 0;
    const byteThree = bytes[23] ?? 0;
    const byteFour = bytes[24] ?? 0;
    return boundedImageDimensions(
      'image/webp',
      1 + byteOne + ((byteTwo & 0x3f) << 8),
      1 + (byteTwo >>> 6) + (byteThree << 2) + ((byteFour & 0x0f) << 10),
    );
  }
  return imageHeaderInvalid('WebP first image chunk is unsupported.');
};

/**
 * Reads only bounded container/frame headers and never decodes image pixels.
 * The returned dimensions are safe to allocate or hand to a renderer under the V1 limits.
 */
export const parseImageHeader = (bytes: Uint8Array): ParsedImageHeader => {
  if (bytesEqual(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return parsePngHeader(bytes);
  }
  if (bytesEqual(bytes, 0, [0xff, 0xd8])) return parseJpegHeader(bytes);
  if (asciiEquals(bytes, 0, 'RIFF') && asciiEquals(bytes, 8, 'WEBP')) {
    return parseWebpHeader(bytes);
  }
  return imageHeaderInvalid('Image signature is unsupported or truncated.');
};

const hasWoff2Signature = (bytes: Uint8Array): boolean => asciiEquals(bytes, 0, 'wOF2');

export interface ManifestAsset {
  readonly id: string;
  readonly entry: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: ApprovedMediaType;
  readonly originalName?: string | undefined;
  readonly widthPx?: number | undefined;
  readonly heightPx?: number | undefined;
}

export interface ManifestOptionalEntry {
  readonly entry: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
}

export interface HdeckManifestV1 {
  readonly format: 'htmllelujah.deck';
  readonly containerVersion: 1;
  readonly documentSchemaVersion: number;
  readonly documentId: string;
  readonly createdAt: string;
  readonly modifiedAt: string;
  readonly documentEntry: 'document.json';
  readonly documentSha256: string;
  readonly assets: readonly ManifestAsset[];
  readonly optionalEntries: readonly ManifestOptionalEntry[];
}

export interface HdeckAssetInput {
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly mediaType: ApprovedMediaType;
  readonly originalName?: string | undefined;
  readonly widthPx?: number | undefined;
  readonly heightPx?: number | undefined;
}

/**
 * Opaque proof that immutable asset bytes were hashed and their bounded header was validated.
 * Instances are created only by `validateHdeckAsset`; representability checks reject forged or
 * cloned descriptors at runtime.
 */
export interface ValidatedHdeckAsset {
  readonly id: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: ApprovedMediaType;
  readonly originalName?: string | undefined;
  readonly widthPx?: number | undefined;
  readonly heightPx?: number | undefined;
}

const validatedHdeckAssets = new WeakSet<ValidatedHdeckAsset>();
const validatedHdeckAssetBytes = new WeakMap<ValidatedHdeckAsset, Uint8Array>();

export interface CreateHdeckInput {
  readonly document: DeckDocument;
  readonly assets?: readonly HdeckAssetInput[] | undefined;
  readonly createdAt?: string | undefined;
  readonly modifiedAt?: string | undefined;
}

export interface ParsedHdeck {
  readonly manifest: HdeckManifestV1;
  readonly document: DeckDocument;
  readonly assets: ReadonlyMap<string, Uint8Array>;
  readonly archiveSha256: string;
}

interface ZipEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

interface ParsedCentralEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly crc32: number;
}

export interface ZipMemberRange {
  readonly memberStart: number;
  readonly memberEnd: number;
}

/** Validates half-open ZIP local-member ownership without touching member payloads. */
export const assertDisjointZipMemberRanges = (ranges: readonly ZipMemberRange[]): void => {
  const ordered = [...ranges].sort((left, right) => left.memberStart - right.memberStart);
  let previousEnd = -1;
  for (const range of ordered) {
    if (
      !Number.isSafeInteger(range.memberStart) ||
      !Number.isSafeInteger(range.memberEnd) ||
      range.memberStart < 0 ||
      range.memberEnd <= range.memberStart
    ) {
      throw new HdeckError('ARCHIVE_INVALID', 'ZIP local member range is invalid.');
    }
    if (range.memberStart < previousEnd) {
      throw new HdeckError('ARCHIVE_INVALID', 'ZIP local member ranges overlap.');
    }
    previousEnd = range.memberEnd;
  }
};

interface PendingCentralEntry extends ZipMemberRange {
  readonly name: string;
  readonly expectedCrc: number;
  readonly dataOffset: number;
  readonly expandedSize: number;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export const crc32 = (bytes: Uint8Array): number => {
  let value = 0xffffffff;
  for (const byte of bytes) {
    const tableValue = crcTable[(value ^ byte) & 0xff];
    if (tableValue === undefined) throw new HdeckError('ARCHIVE_INVALID', 'CRC lookup failed.');
    value = tableValue ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
};

export const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const canonicalJson = (value: unknown): string => canonicalSerialize(value);

const validateEntryName = (name: string): void => {
  const bytes = Buffer.byteLength(name, 'utf8');
  if (bytes === 0 || bytes > HDECK_LIMITS.maxNameBytes) {
    throw new HdeckError('ARCHIVE_LIMIT_EXCEEDED', 'Archive entry name is outside limits.');
  }
  if (
    name.includes('\\') ||
    name.includes('\0') ||
    /[\u0000-\u001f\u007f]/u.test(name) ||
    name.startsWith('/') ||
    /^[a-zA-Z]:/u.test(name) ||
    name.startsWith('//')
  ) {
    throw new HdeckError('ARCHIVE_INVALID', 'Archive entry name is unsafe.');
  }
  const segments = name.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new HdeckError('ARCHIVE_INVALID', 'Archive entry name contains traversal.');
  }
};

const extensionForMediaType = (mediaType: ApprovedMediaType): string => {
  switch (mediaType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'font/woff2':
      return 'woff2';
  }
};

const safeOriginalName = (name: string | undefined): string | undefined => {
  if (name === undefined) return undefined;
  const normalized = name
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .trim();
  if (normalized.length === 0) return undefined;
  return normalized.slice(0, 160);
};

const writeUInt16 = (value: number): Buffer => {
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
};

const writeUInt32 = (value: number): Buffer => {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
};

interface StoredZipLimits {
  readonly maxArchiveBytes: number;
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
  readonly maxTotalBytes: number;
}

interface PreparedStoredZipEntry {
  readonly entry: ZipEntry;
  readonly name: Buffer;
}

interface StoredZipEntryDescription {
  readonly name: string;
  readonly byteLength: number;
}

const prepareStoredZipEntryDescriptions = (
  entries: readonly StoredZipEntryDescription[],
  limits: StoredZipLimits,
): readonly Buffer[] => {
  if (entries.length === 0 || entries.length > limits.maxEntries) {
    throw new HdeckError('ARCHIVE_LIMIT_EXCEEDED', 'Archive entry count is outside limits.');
  }
  const prepared: Buffer[] = [];
  const names = new Set<string>();
  let expandedBytes = 0;
  let archiveBytes = 22;
  for (const entry of entries) {
    validateEntryName(entry.name);
    const collisionKey = entry.name.normalize('NFC').toLocaleLowerCase('en-US');
    if (names.has(collisionKey)) {
      throw new HdeckError('ARCHIVE_INVALID', 'Archive contains a duplicate entry name.');
    }
    names.add(collisionKey);
    if (
      !Number.isSafeInteger(entry.byteLength) ||
      entry.byteLength < 0 ||
      entry.byteLength > limits.maxEntryBytes
    ) {
      throw new HdeckError('ARCHIVE_LIMIT_EXCEEDED', 'Archive entry is too large.');
    }
    if (expandedBytes > limits.maxTotalBytes - entry.byteLength) {
      throw new HdeckError('ARCHIVE_LIMIT_EXCEEDED', 'Archive expanded size is too large.');
    }
    expandedBytes += entry.byteLength;
    const name = Buffer.from(entry.name, 'utf8');
    const encodedContribution = entry.byteLength + 76 + name.byteLength * 2;
    if (
      !Number.isSafeInteger(encodedContribution) ||
      archiveBytes > limits.maxArchiveBytes - encodedContribution
    ) {
      throw new HdeckError('ARCHIVE_LIMIT_EXCEEDED', 'Archive is too large.');
    }
    archiveBytes += encodedContribution;
    prepared.push(name);
  }
  return prepared;
};

const prepareStoredZipEntries = (
  entries: readonly ZipEntry[],
  limits: StoredZipLimits,
): readonly PreparedStoredZipEntry[] => {
  const names = prepareStoredZipEntryDescriptions(
    entries.map((entry) => ({ name: entry.name, byteLength: entry.bytes.byteLength })),
    limits,
  );
  return entries.map((entry, index) => {
    const name = names[index];
    if (name === undefined) throw new HdeckError('ARCHIVE_INVALID', 'ZIP entry name is missing.');
    return { entry, name };
  });
};

/** Encodes a deterministic STORE-only ZIP. Exposed for bounded adversarial tests. */
export const encodeStoredZip = (entries: readonly ZipEntry[]): Uint8Array => {
  const prepared = prepareStoredZipEntries(entries, HDECK_LIMITS);
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const { entry, name } of prepared) {
    const data = Buffer.from(entry.bytes);
    const checksum = crc32(data);
    const localHeader = Buffer.concat([
      writeUInt32(LOCAL_FILE_SIGNATURE),
      writeUInt16(20),
      writeUInt16(UTF8_FLAG),
      writeUInt16(STORE_METHOD),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(checksum),
      writeUInt32(data.byteLength),
      writeUInt32(data.byteLength),
      writeUInt16(name.byteLength),
      writeUInt16(0),
      name,
    ]);
    localParts.push(localHeader, data);

    const centralHeader = Buffer.concat([
      writeUInt32(CENTRAL_FILE_SIGNATURE),
      writeUInt16(20),
      writeUInt16(20),
      writeUInt16(UTF8_FLAG),
      writeUInt16(STORE_METHOD),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(checksum),
      writeUInt32(data.byteLength),
      writeUInt32(data.byteLength),
      writeUInt16(name.byteLength),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(0),
      writeUInt32(localOffset),
      name,
    ]);
    centralParts.push(centralHeader);
    localOffset += localHeader.byteLength + data.byteLength;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([
    writeUInt32(END_SIGNATURE),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(entries.length),
    writeUInt16(entries.length),
    writeUInt32(central.byteLength),
    writeUInt32(localOffset),
    writeUInt16(0),
  ]);
  const result = Buffer.concat([...localParts, central, end]);
  if (result.byteLength > HDECK_LIMITS.maxArchiveBytes) {
    throw new HdeckError('ARCHIVE_LIMIT_EXCEEDED', 'Archive is too large.');
  }
  return result;
};

const findEndOffset = (archive: Buffer): number => {
  const minimum = Math.max(0, archive.byteLength - 65_557);
  for (let offset = archive.byteLength - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === END_SIGNATURE) return offset;
  }
  throw new HdeckError('ARCHIVE_INVALID', 'ZIP end record is missing.');
};

const checkedRange = (start: number, length: number, total: number): void => {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0) {
    throw new HdeckError('ARCHIVE_INVALID', 'ZIP range is invalid.');
  }
  if (start + length > total) {
    throw new HdeckError('ARCHIVE_INVALID', 'ZIP range is truncated.');
  }
};

const decodeStoredZip = (input: Uint8Array): readonly ParsedCentralEntry[] => {
  if (input.byteLength > HDECK_LIMITS.maxArchiveBytes) {
    throw new HdeckError('ARCHIVE_LIMIT_EXCEEDED', 'Archive is too large.');
  }
  const archive = Buffer.from(input);
  if (archive.byteLength < 22) throw new HdeckError('ARCHIVE_INVALID', 'Archive is truncated.');
  const endOffset = findEndOffset(archive);
  checkedRange(endOffset, 22, archive.byteLength);

  const disk = archive.readUInt16LE(endOffset + 4);
  const centralDisk = archive.readUInt16LE(endOffset + 6);
  const diskEntries = archive.readUInt16LE(endOffset + 8);
  const totalEntries = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  const commentLength = archive.readUInt16LE(endOffset + 20);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    throw new HdeckError('ARCHIVE_INVALID', 'Multi-disk ZIP is unsupported.');
  }
  if (totalEntries === 0 || totalEntries > HDECK_LIMITS.maxEntries) {
    throw new HdeckError('ARCHIVE_LIMIT_EXCEEDED', 'Archive entry count is outside limits.');
  }
  checkedRange(endOffset + 22, commentLength, archive.byteLength);
  if (endOffset + 22 + commentLength !== archive.byteLength) {
    throw new HdeckError('ARCHIVE_INVALID', 'Trailing ZIP data is not allowed.');
  }
  checkedRange(centralOffset, centralSize, endOffset);
  if (centralOffset + centralSize !== endOffset) {
    throw new HdeckError('ARCHIVE_INVALID', 'ZIP central directory is inconsistent.');
  }

  const pending: PendingCentralEntry[] = [];
  const seenNames = new Set<string>();
  let cursor = centralOffset;
  let totalExpanded = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    checkedRange(cursor, 46, endOffset);
    if (archive.readUInt32LE(cursor) !== CENTRAL_FILE_SIGNATURE) {
      throw new HdeckError('ARCHIVE_INVALID', 'ZIP central record is invalid.');
    }
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const expectedCrc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const expandedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const entryCommentLength = archive.readUInt16LE(cursor + 32);
    const diskStart = archive.readUInt16LE(cursor + 34);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localHeaderOffset = archive.readUInt32LE(cursor + 42);
    const recordLength = 46 + nameLength + extraLength + entryCommentLength;
    checkedRange(cursor, recordLength, endOffset);
    if ((flags & 0x0001) !== 0 || (flags & 0x0008) !== 0 || diskStart !== 0) {
      throw new HdeckError(
        'ARCHIVE_INVALID',
        'Encrypted or streaming ZIP entries are unsupported.',
      );
    }
    if (method !== STORE_METHOD || compressedSize !== expandedSize) {
      throw new HdeckError('UNSUPPORTED_COMPRESSION', 'Only stored ZIP entries are supported.');
    }
    if (expandedSize > HDECK_LIMITS.maxEntryBytes) {
      throw new HdeckError('ARCHIVE_LIMIT_EXCEEDED', 'Archive entry is too large.');
    }
    totalExpanded += expandedSize;
    if (totalExpanded > HDECK_LIMITS.maxTotalBytes) {
      throw new HdeckError('ARCHIVE_LIMIT_EXCEEDED', 'Archive expanded size is too large.');
    }
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0o170000) === 0o120000) {
      throw new HdeckError('ARCHIVE_INVALID', 'Symlink archive entries are forbidden.');
    }

    const nameBytes = archive.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = nameBytes.toString('utf8');
    if (!Buffer.from(name, 'utf8').equals(nameBytes)) {
      throw new HdeckError('ARCHIVE_INVALID', 'Archive entry name is not valid UTF-8.');
    }
    validateEntryName(name);
    const collisionKey = name.normalize('NFC').toLocaleLowerCase('en-US');
    if (seenNames.has(collisionKey)) {
      throw new HdeckError('ARCHIVE_INVALID', 'Archive contains duplicate entry names.');
    }
    seenNames.add(collisionKey);

    checkedRange(localHeaderOffset, 30, centralOffset);
    if (archive.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_SIGNATURE) {
      throw new HdeckError('ARCHIVE_INVALID', 'ZIP local record is invalid.');
    }
    const localFlags = archive.readUInt16LE(localHeaderOffset + 6);
    const localMethod = archive.readUInt16LE(localHeaderOffset + 8);
    const localCrc = archive.readUInt32LE(localHeaderOffset + 14);
    const localCompressed = archive.readUInt32LE(localHeaderOffset + 18);
    const localExpanded = archive.readUInt32LE(localHeaderOffset + 22);
    const localNameLength = archive.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    checkedRange(localHeaderOffset + 30, localNameLength + localExtraLength, centralOffset);
    checkedRange(dataOffset, compressedSize, centralOffset);
    const localName = archive
      .subarray(localHeaderOffset + 30, localHeaderOffset + 30 + localNameLength)
      .toString('utf8');
    if (
      localName !== name ||
      localFlags !== flags ||
      localMethod !== method ||
      localCrc !== expectedCrc ||
      localCompressed !== compressedSize ||
      localExpanded !== expandedSize
    ) {
      throw new HdeckError('ARCHIVE_INVALID', 'ZIP local and central records disagree.');
    }
    const memberEnd = dataOffset + compressedSize;
    if (!Number.isSafeInteger(memberEnd)) {
      throw new HdeckError('ARCHIVE_INVALID', 'ZIP local member range is invalid.');
    }
    pending.push({
      name,
      expectedCrc,
      dataOffset,
      expandedSize,
      memberStart: localHeaderOffset,
      memberEnd,
    });
    cursor += recordLength;
  }
  if (cursor !== endOffset) {
    throw new HdeckError('ARCHIVE_INVALID', 'ZIP central directory has extra records.');
  }
  assertDisjointZipMemberRanges(pending);

  return pending.map((entry): ParsedCentralEntry => {
    const bytes = archive.subarray(entry.dataOffset, entry.dataOffset + entry.expandedSize);
    if (crc32(bytes) !== entry.expectedCrc) {
      throw new HdeckError('ARCHIVE_INVALID', 'Archive entry checksum is invalid.');
    }
    return {
      name: entry.name,
      bytes: Uint8Array.from(bytes),
      crc32: entry.expectedCrc,
    };
  });
};

const requireString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  if (typeof value !== 'string')
    throw new HdeckError('ARCHIVE_INVALID', `Manifest ${key} is invalid.`);
  return value;
};

const requireInteger = (record: Record<string, unknown>, key: string): number => {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new HdeckError('ARCHIVE_INVALID', `Manifest ${key} is invalid.`);
  }
  return value;
};

const assertExactKeys = (
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void => {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new HdeckError('ARCHIVE_INVALID', 'Manifest contains an unknown field.');
  }
  if (required.some((key) => !(key in record))) {
    throw new HdeckError('ARCHIVE_INVALID', 'Manifest is missing a required field.');
  }
};

const parseManifestAsset = (input: unknown): ManifestAsset => {
  if (!isRecord(input)) throw new HdeckError('ARCHIVE_INVALID', 'Manifest asset is invalid.');
  assertExactKeys(
    input,
    ['id', 'entry', 'sha256', 'byteLength', 'mediaType'],
    ['originalName', 'widthPx', 'heightPx'],
  );
  const mediaType = requireString(input, 'mediaType');
  if (!['image/png', 'image/jpeg', 'image/webp', 'font/woff2'].includes(mediaType)) {
    throw new HdeckError('ARCHIVE_INVALID', 'Manifest asset media type is unsupported.');
  }
  const hash = requireString(input, 'sha256');
  if (!/^[0-9a-f]{64}$/u.test(hash))
    throw new HdeckError('ARCHIVE_INVALID', 'Manifest asset hash is invalid.');
  const optionalString = input.originalName;
  const optionalWidth = input.widthPx;
  const optionalHeight = input.heightPx;
  if (optionalString !== undefined && typeof optionalString !== 'string') {
    throw new HdeckError('ARCHIVE_INVALID', 'Manifest asset name is invalid.');
  }
  if (
    optionalWidth !== undefined &&
    (!Number.isSafeInteger(optionalWidth) || (optionalWidth as number) <= 0)
  ) {
    throw new HdeckError('ARCHIVE_INVALID', 'Manifest asset width is invalid.');
  }
  if (
    optionalHeight !== undefined &&
    (!Number.isSafeInteger(optionalHeight) || (optionalHeight as number) <= 0)
  ) {
    throw new HdeckError('ARCHIVE_INVALID', 'Manifest asset height is invalid.');
  }
  const asset: ManifestAsset = {
    id: requireString(input, 'id'),
    entry: requireString(input, 'entry'),
    sha256: hash,
    byteLength: requireInteger(input, 'byteLength'),
    mediaType: mediaType as ApprovedMediaType,
    ...(optionalString === undefined ? {} : { originalName: optionalString }),
    ...(optionalWidth === undefined ? {} : { widthPx: optionalWidth as number }),
    ...(optionalHeight === undefined ? {} : { heightPx: optionalHeight as number }),
  };
  validateEntryName(asset.entry);
  return asset;
};

const parseOptionalEntry = (input: unknown): ManifestOptionalEntry => {
  if (!isRecord(input)) throw new HdeckError('ARCHIVE_INVALID', 'Optional entry is invalid.');
  assertExactKeys(input, ['entry', 'sha256', 'byteLength', 'mediaType']);
  const hash = requireString(input, 'sha256');
  if (!/^[0-9a-f]{64}$/u.test(hash))
    throw new HdeckError('ARCHIVE_INVALID', 'Optional entry hash is invalid.');
  const result: ManifestOptionalEntry = {
    entry: requireString(input, 'entry'),
    sha256: hash,
    byteLength: requireInteger(input, 'byteLength'),
    mediaType: requireString(input, 'mediaType'),
  };
  validateEntryName(result.entry);
  return result;
};

const parseManifest = (input: unknown): HdeckManifestV1 => {
  if (!isRecord(input)) throw new HdeckError('ARCHIVE_INVALID', 'Manifest root is invalid.');
  assertExactKeys(input, [
    'format',
    'containerVersion',
    'documentSchemaVersion',
    'documentId',
    'createdAt',
    'modifiedAt',
    'documentEntry',
    'documentSha256',
    'assets',
    'optionalEntries',
  ]);
  if (input.format !== 'htmllelujah.deck' || input.documentEntry !== 'document.json') {
    throw new HdeckError('ARCHIVE_INVALID', 'Manifest format is invalid.');
  }
  if (input.containerVersion !== 1)
    throw new HdeckError('UNSUPPORTED_VERSION', 'Container version is unsupported.');
  const documentHash = requireString(input, 'documentSha256');
  if (!/^[0-9a-f]{64}$/u.test(documentHash))
    throw new HdeckError('ARCHIVE_INVALID', 'Document hash is invalid.');
  if (!Array.isArray(input.assets) || !Array.isArray(input.optionalEntries)) {
    throw new HdeckError('ARCHIVE_INVALID', 'Manifest entry lists are invalid.');
  }
  if (input.assets.length > HDECK_LIMITS.maxEntries || input.optionalEntries.length > 32) {
    throw new HdeckError('ARCHIVE_LIMIT_EXCEEDED', 'Manifest entry lists are too large.');
  }
  const createdAt = requireString(input, 'createdAt');
  const modifiedAt = requireString(input, 'modifiedAt');
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(modifiedAt))) {
    throw new HdeckError('ARCHIVE_INVALID', 'Manifest timestamp is invalid.');
  }
  return {
    format: 'htmllelujah.deck',
    containerVersion: 1,
    documentSchemaVersion: requireInteger(input, 'documentSchemaVersion'),
    documentId: requireString(input, 'documentId'),
    createdAt,
    modifiedAt,
    documentEntry: 'document.json',
    documentSha256: documentHash,
    assets: input.assets.map(parseManifestAsset),
    optionalEntries: input.optionalEntries.map(parseOptionalEntry),
  };
};

export interface HdeckRepresentabilityLimits extends StoredZipLimits {
  readonly maxDocumentBytes: number;
  readonly maxManifestBytes: number;
}

export type HdeckRepresentabilityLimitOverrides = Partial<HdeckRepresentabilityLimits>;

interface PreparedHdeckContent {
  readonly entries: readonly ZipEntry[];
  readonly documentBytes: Uint8Array;
  readonly manifestBytes: Uint8Array;
}

interface PreparedHdeckAssetEntry {
  readonly name: string;
  readonly asset: ValidatedHdeckAsset;
}

interface PreparedHdeckMetadata {
  readonly assetEntries: readonly PreparedHdeckAssetEntry[];
  readonly documentBytes: Uint8Array;
  readonly manifestBytes: Uint8Array;
}

export interface CreateHdeckWithValidatedAssetsInput {
  readonly document: DeckDocument;
  readonly assets?: readonly ValidatedHdeckAsset[] | undefined;
  readonly createdAt?: string | undefined;
  readonly modifiedAt?: string | undefined;
}

const representabilityLimits = (
  overrides: HdeckRepresentabilityLimitOverrides = {},
): HdeckRepresentabilityLimits => {
  const resolved: HdeckRepresentabilityLimits = {
    maxArchiveBytes: overrides.maxArchiveBytes ?? HDECK_LIMITS.maxArchiveBytes,
    maxEntries: overrides.maxEntries ?? HDECK_LIMITS.maxEntries,
    maxEntryBytes: overrides.maxEntryBytes ?? HDECK_LIMITS.maxEntryBytes,
    maxTotalBytes: overrides.maxTotalBytes ?? HDECK_LIMITS.maxTotalBytes,
    maxDocumentBytes: overrides.maxDocumentBytes ?? HDECK_LIMITS.maxDocumentBytes,
    maxManifestBytes: overrides.maxManifestBytes ?? HDECK_LIMITS.maxManifestBytes,
  };
  for (const key of Object.keys(resolved) as readonly (keyof HdeckRepresentabilityLimits)[]) {
    const value = resolved[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > HDECK_LIMITS[key]) {
      throw new HdeckError('ARCHIVE_INVALID', 'Archive representability limits are invalid.');
    }
  }
  return resolved;
};

const validateHdeckAssetWithLimits = (
  asset: HdeckAssetInput,
  limits: HdeckRepresentabilityLimits,
): ValidatedHdeckAsset => {
  if (asset.bytes.byteLength > limits.maxEntryBytes) {
    throw new HdeckError('ARCHIVE_LIMIT_EXCEEDED', 'Archive entry is too large.');
  }
  const hash = sha256(asset.bytes);
  if (asset.mediaType === 'font/woff2') {
    if (
      !hasWoff2Signature(asset.bytes) ||
      asset.widthPx !== undefined ||
      asset.heightPx !== undefined
    ) {
      throw new HdeckError('ARCHIVE_INVALID', 'Font asset metadata is invalid.');
    }
  } else {
    const parsedImage = parseImageHeader(asset.bytes);
    if (
      parsedImage.mediaType !== asset.mediaType ||
      asset.widthPx === undefined ||
      asset.heightPx === undefined ||
      asset.widthPx !== parsedImage.widthPx ||
      asset.heightPx !== parsedImage.heightPx
    ) {
      throw new HdeckError(
        'ARCHIVE_INVALID',
        'Image signature or dimensions do not match supplied metadata.',
      );
    }
  }
  const originalName = safeOriginalName(asset.originalName);
  const validated = Object.freeze({
    id: asset.id,
    sha256: hash,
    byteLength: asset.bytes.byteLength,
    mediaType: asset.mediaType,
    ...(originalName === undefined ? {} : { originalName }),
    ...(asset.widthPx === undefined ? {} : { widthPx: asset.widthPx }),
    ...(asset.heightPx === undefined ? {} : { heightPx: asset.heightPx }),
  });
  validatedHdeckAssets.add(validated);
  validatedHdeckAssetBytes.set(validated, asset.bytes);
  return validated;
};

/** Hashes and validates one immutable asset exactly once for incremental runtime checks. */
export const validateHdeckAsset = (asset: HdeckAssetInput): ValidatedHdeckAsset =>
  validateHdeckAssetWithLimits(asset, representabilityLimits());

const requireValidatedHdeckAsset = (asset: ValidatedHdeckAsset): ValidatedHdeckAsset => {
  if (!validatedHdeckAssets.has(asset)) {
    throw new HdeckError('ARCHIVE_INVALID', 'Validated asset descriptor provenance is invalid.');
  }
  return asset;
};

const prepareHdeckMetadata = (
  input: CreateHdeckWithValidatedAssetsInput,
  limits: HdeckRepresentabilityLimits,
): PreparedHdeckMetadata => {
  const document = input.document;
  const assets = input.assets ?? [];
  if (assets.length > limits.maxEntries - 2) {
    throw new HdeckError('ARCHIVE_LIMIT_EXCEEDED', 'Archive entry count is outside limits.');
  }
  const assetIds = new Set<string>();
  const assetHashes = new Set<string>();
  const assetEntries: PreparedHdeckAssetEntry[] = [];
  const manifestAssets: ManifestAsset[] = [];
  let totalAssetBytes = 0;
  for (const candidate of assets) {
    const asset = requireValidatedHdeckAsset(candidate);
    if (assetIds.has(asset.id)) {
      throw new HdeckError('ARCHIVE_INVALID', 'Asset identifier is duplicated.');
    }
    assetIds.add(asset.id);
    if (asset.byteLength > limits.maxEntryBytes) {
      throw new HdeckError('ARCHIVE_LIMIT_EXCEEDED', 'Archive entry is too large.');
    }
    if (totalAssetBytes > limits.maxTotalBytes - asset.byteLength) {
      throw new HdeckError('ARCHIVE_LIMIT_EXCEEDED', 'Archive expanded size is too large.');
    }
    totalAssetBytes += asset.byteLength;
    if (assetHashes.has(asset.sha256)) {
      throw new HdeckError('ARCHIVE_INVALID', 'Asset bytes are duplicated.');
    }
    assetHashes.add(asset.sha256);
    const entry = `assets/${asset.sha256}.${extensionForMediaType(asset.mediaType)}`;
    assetEntries.push({ name: entry, asset });
    manifestAssets.push({
      id: asset.id,
      entry,
      sha256: asset.sha256,
      byteLength: asset.byteLength,
      mediaType: asset.mediaType,
      ...(asset.originalName === undefined ? {} : { originalName: asset.originalName }),
      ...(asset.widthPx === undefined ? {} : { widthPx: asset.widthPx }),
      ...(asset.heightPx === undefined ? {} : { heightPx: asset.heightPx }),
    });
  }

  const declaredAssets = new Map(document.assets.map((asset) => [asset.id, asset]));
  if (declaredAssets.size !== document.assets.length || declaredAssets.size !== assets.length) {
    throw new HdeckError('ASSET_MISSING', 'Document assets and supplied asset bytes differ.');
  }
  for (const asset of manifestAssets) {
    const declared = declaredAssets.get(asset.id);
    if (
      declared === undefined ||
      declared.hash !== asset.sha256 ||
      declared.mediaType !== asset.mediaType ||
      (declared.byteLength !== undefined && declared.byteLength !== asset.byteLength) ||
      (asset.mediaType === 'font/woff2'
        ? declared.kind !== 'font' ||
          declared.widthPx !== undefined ||
          declared.heightPx !== undefined
        : declared.kind !== 'image' ||
          declared.widthPx !== asset.widthPx ||
          declared.heightPx !== asset.heightPx)
    ) {
      throw new HdeckError(
        'HASH_MISMATCH',
        'Document asset metadata does not match supplied bytes.',
      );
    }
  }

  const documentBytes = canonicalDocumentBytes(document);
  if (documentBytes.byteLength > limits.maxDocumentBytes) {
    throw new HdeckError('ARCHIVE_LIMIT_EXCEEDED', 'Document JSON is too large.');
  }
  const now = new Date().toISOString();
  const createdAt = input.createdAt ?? now;
  const modifiedAt = input.modifiedAt ?? now;
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(modifiedAt))) {
    throw new HdeckError('ARCHIVE_INVALID', 'Manifest timestamp is invalid.');
  }
  const manifest: HdeckManifestV1 = {
    format: 'htmllelujah.deck',
    containerVersion: 1,
    documentSchemaVersion: document.schemaVersion,
    documentId: document.id,
    createdAt,
    modifiedAt,
    documentEntry: 'document.json',
    documentSha256: sha256(documentBytes),
    assets: manifestAssets.sort((left, right) => left.entry.localeCompare(right.entry)),
    optionalEntries: [],
  };
  const manifestBytes = Buffer.from(canonicalJson(manifest), 'utf8');
  if (manifestBytes.byteLength > limits.maxManifestBytes) {
    throw new HdeckError('ARCHIVE_LIMIT_EXCEEDED', 'Manifest is too large.');
  }
  const fixedEntryBytes = documentBytes.byteLength + manifestBytes.byteLength;
  if (
    !Number.isSafeInteger(fixedEntryBytes) ||
    fixedEntryBytes > limits.maxTotalBytes - totalAssetBytes
  ) {
    throw new HdeckError('ARCHIVE_LIMIT_EXCEEDED', 'Archive expanded size is too large.');
  }
  const orderedAssetEntries = assetEntries.sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  prepareStoredZipEntryDescriptions(
    [
      { name: 'manifest.json', byteLength: manifestBytes.byteLength },
      { name: 'document.json', byteLength: documentBytes.byteLength },
      ...orderedAssetEntries.map((entry) => ({
        name: entry.name,
        byteLength: entry.asset.byteLength,
      })),
    ],
    limits,
  );
  return { assetEntries: orderedAssetEntries, documentBytes, manifestBytes };
};

const prepareHdeckContent = (
  input: CreateHdeckInput,
  limitOverrides: HdeckRepresentabilityLimitOverrides = {},
): PreparedHdeckContent => {
  const limits = representabilityLimits(limitOverrides);
  const assetInputs = input.assets ?? [];
  const validatedInputs = assetInputs.map((asset) => ({
    asset,
    validated: validateHdeckAssetWithLimits(asset, limits),
  }));
  const bytesByValidatedAsset = new Map(
    validatedInputs.map(({ asset, validated }) => [validated, asset.bytes] as const),
  );
  const prepared = prepareHdeckMetadata(
    {
      document: input.document,
      assets: validatedInputs.map(({ validated }) => validated),
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
      ...(input.modifiedAt === undefined ? {} : { modifiedAt: input.modifiedAt }),
    },
    limits,
  );
  return {
    documentBytes: prepared.documentBytes,
    manifestBytes: prepared.manifestBytes,
    entries: prepared.assetEntries.map((entry) => {
      const bytes = bytesByValidatedAsset.get(entry.asset);
      if (bytes === undefined) {
        throw new HdeckError('ARCHIVE_INVALID', 'Validated asset bytes are unavailable.');
      }
      return { name: entry.name, bytes };
    }),
  };
};

/**
 * Pure candidate-state check shared by the runtime commit boundary and archive writer.
 * The document must already be a validated current-schema value.
 */
export const assertHdeckRepresentable = (
  input: CreateHdeckInput,
  limitOverrides: HdeckRepresentabilityLimitOverrides = {},
): void => {
  prepareHdeckContent(input, limitOverrides);
};

/**
 * Incremental candidate-state check for assets already validated from private immutable bytes.
 * Descriptor provenance is enforced by this module, so callers cannot substitute metadata-only
 * claims for the original hash/header validation.
 */
export const assertHdeckRepresentableWithValidatedAssets = (
  input: CreateHdeckWithValidatedAssetsInput,
  limitOverrides: HdeckRepresentabilityLimitOverrides = {},
): void => {
  prepareHdeckMetadata(input, representabilityLimits(limitOverrides));
};

/** Encodes from the exact private immutable byte arrays that produced the validated proofs. */
export const createHdeckArchiveWithValidatedAssets = (
  input: CreateHdeckWithValidatedAssetsInput,
): Uint8Array => {
  const document = parseDeck(input.document);
  const prepared = prepareHdeckMetadata(
    {
      ...input,
      document,
    },
    representabilityLimits(),
  );
  return encodeStoredZip([
    { name: 'manifest.json', bytes: prepared.manifestBytes },
    { name: 'document.json', bytes: prepared.documentBytes },
    ...prepared.assetEntries.map((entry) => {
      const bytes = validatedHdeckAssetBytes.get(entry.asset);
      if (bytes === undefined) {
        throw new HdeckError('ARCHIVE_INVALID', 'Validated asset bytes are unavailable.');
      }
      return { name: entry.name, bytes };
    }),
  ]);
};

export const createHdeckArchive = (input: CreateHdeckInput): Uint8Array => {
  const document = parseDeck(input.document);
  const prepared = prepareHdeckContent({ ...input, document });
  return encodeStoredZip([
    { name: 'manifest.json', bytes: prepared.manifestBytes },
    { name: 'document.json', bytes: prepared.documentBytes },
    ...prepared.entries,
  ]);
};

const parseJsonEntry = (bytes: Uint8Array, maximum: number, label: string): unknown => {
  if (bytes.byteLength > maximum)
    throw new HdeckError('ARCHIVE_LIMIT_EXCEEDED', `${label} is too large.`);
  const text = Buffer.from(bytes).toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(Buffer.from(bytes))) {
    throw new HdeckError('ARCHIVE_INVALID', `${label} is not valid UTF-8.`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HdeckError('ARCHIVE_INVALID', `${label} is not valid JSON.`);
  }
};

export const parseHdeckArchive = (archive: Uint8Array): ParsedHdeck => {
  const decoded = decodeStoredZip(archive);
  const entries = new Map(decoded.map((entry) => [entry.name, entry.bytes]));
  const manifestBytes = entries.get('manifest.json');
  const documentBytes = entries.get('document.json');
  if (manifestBytes === undefined || documentBytes === undefined) {
    throw new HdeckError('ARCHIVE_INVALID', 'Archive is missing required entries.');
  }
  const manifest = parseManifest(
    parseJsonEntry(manifestBytes, HDECK_LIMITS.maxManifestBytes, 'Manifest'),
  );
  if (manifest.documentSchemaVersion > CURRENT_DOCUMENT_SCHEMA_VERSION) {
    throw new HdeckError('UNSUPPORTED_VERSION', 'Document schema version is unsupported.');
  }
  if (manifest.documentSha256 !== sha256(documentBytes)) {
    throw new HdeckError('HASH_MISMATCH', 'Document hash does not match the manifest.');
  }
  let document: DeckDocument;
  try {
    const documentInput = parseJsonEntry(documentBytes, HDECK_LIMITS.maxDocumentBytes, 'Document');
    if (
      isRecord(documentInput) &&
      typeof documentInput.schemaVersion === 'number' &&
      Number.isSafeInteger(documentInput.schemaVersion) &&
      documentInput.schemaVersion > CURRENT_DOCUMENT_SCHEMA_VERSION
    ) {
      throw new HdeckError('UNSUPPORTED_VERSION', 'Document schema version is unsupported.');
    }
    document = parseDeck(documentInput);
  } catch (error) {
    if (error instanceof HdeckError) throw error;
    throw new HdeckError('DOCUMENT_INVALID', 'Document model is invalid.');
  }
  if (
    document.id !== manifest.documentId ||
    document.schemaVersion !== manifest.documentSchemaVersion
  ) {
    throw new HdeckError('ARCHIVE_INVALID', 'Manifest and document identity disagree.');
  }

  const declaredEntries = new Set(['manifest.json', 'document.json']);
  const assets = new Map<string, Uint8Array>();
  const declaredAssetIds = new Set<string>();
  const documentAssets = new Map(document.assets.map((asset) => [asset.id, asset]));
  if (documentAssets.size !== manifest.assets.length) {
    throw new HdeckError('ASSET_MISSING', 'Document and manifest asset lists differ.');
  }
  for (const asset of manifest.assets) {
    if (declaredAssetIds.has(asset.id) || declaredEntries.has(asset.entry)) {
      throw new HdeckError('ARCHIVE_INVALID', 'Manifest declares a duplicate asset.');
    }
    declaredAssetIds.add(asset.id);
    declaredEntries.add(asset.entry);
    const bytes = entries.get(asset.entry);
    if (bytes === undefined)
      throw new HdeckError('ASSET_MISSING', 'Declared asset entry is missing.');
    if (bytes.byteLength !== asset.byteLength || sha256(bytes) !== asset.sha256) {
      throw new HdeckError('HASH_MISMATCH', 'Asset does not match the manifest.');
    }
    const expectedEntry = `assets/${asset.sha256}.${extensionForMediaType(asset.mediaType)}`;
    if (asset.entry !== expectedEntry) {
      throw new HdeckError('ARCHIVE_INVALID', 'Asset entry is not content-addressed.');
    }
    const reference = documentAssets.get(asset.id);
    if (
      reference === undefined ||
      reference.hash !== asset.sha256 ||
      reference.mediaType !== asset.mediaType
    ) {
      throw new HdeckError(
        'HASH_MISMATCH',
        'Document asset reference does not match the manifest.',
      );
    }
    if (asset.mediaType === 'font/woff2') {
      if (
        !hasWoff2Signature(bytes) ||
        reference.kind !== 'font' ||
        asset.widthPx !== undefined ||
        asset.heightPx !== undefined ||
        reference.widthPx !== undefined ||
        reference.heightPx !== undefined
      ) {
        throw new HdeckError('ARCHIVE_INVALID', 'Font asset metadata is invalid.');
      }
    } else {
      if (reference.kind !== 'image') {
        throw new HdeckError('ARCHIVE_INVALID', 'Image asset kind is invalid.');
      }
      const parsedImage = parseImageHeader(bytes);
      if (
        parsedImage.mediaType !== asset.mediaType ||
        asset.widthPx === undefined ||
        asset.heightPx === undefined ||
        reference.widthPx === undefined ||
        reference.heightPx === undefined ||
        asset.widthPx !== parsedImage.widthPx ||
        asset.heightPx !== parsedImage.heightPx ||
        reference.widthPx !== parsedImage.widthPx ||
        reference.heightPx !== parsedImage.heightPx
      ) {
        throw new HdeckError(
          'ARCHIVE_INVALID',
          'Image signature or dimensions do not match declared metadata.',
        );
      }
    }
    assets.set(asset.id, bytes);
  }
  for (const optional of manifest.optionalEntries) {
    if (declaredEntries.has(optional.entry)) {
      throw new HdeckError('ARCHIVE_INVALID', 'Manifest declares a duplicate optional entry.');
    }
    declaredEntries.add(optional.entry);
    const bytes = entries.get(optional.entry);
    if (
      bytes === undefined ||
      bytes.byteLength !== optional.byteLength ||
      sha256(bytes) !== optional.sha256
    ) {
      throw new HdeckError('HASH_MISMATCH', 'Optional entry does not match the manifest.');
    }
  }
  for (const entryName of entries.keys()) {
    if (!declaredEntries.has(entryName)) {
      throw new HdeckError('ENTRY_UNDECLARED', 'Archive contains an undeclared entry.');
    }
  }
  return { manifest, document, assets, archiveSha256: sha256(archive) };
};
