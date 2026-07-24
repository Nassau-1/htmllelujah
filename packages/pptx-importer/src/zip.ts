import { inflateRawSync } from 'node:zlib';

import { PresentationImportError, importFailure } from './errors.js';
import { PRESENTATION_IMPORT_LIMITS } from './limits.js';

const LOCAL_FILE_SIGNATURE = 0x04034b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const ZIP64_EXTRA_ID = 0x0001;
const AES_EXTRA_ID = 0x9901;
const UNICODE_PATH_EXTRA_ID = 0x7075;
const UNICODE_COMMENT_EXTRA_ID = 0x6375;
const STORE_METHOD = 0;
const DEFLATE_METHOD = 8;
const UNSAFE_FLAG_MASK = 0x0001 | 0x0008 | 0x0040 | 0x2000;

export interface OpcArchiveEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly compressedSize: number;
  readonly expandedSize: number;
  readonly compressionMethod: 'stored' | 'deflate';
  readonly crc32: number;
}

export interface OpcArchive {
  readonly entries: ReadonlyMap<string, OpcArchiveEntry>;
  readonly archiveBytes: number;
  readonly expandedBytes: number;
}

interface CentralEntry {
  readonly name: string;
  readonly expectedCrc: number;
  readonly compressedSize: number;
  readonly expandedSize: number;
  readonly method: number;
  readonly dataOffset: number;
  readonly memberStart: number;
  readonly memberEnd: number;
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
    if (tableValue === undefined) return importFailure('ZIP_INVALID', 'CRC lookup failed.');
    value = tableValue ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
};

const checkedRange = (start: number, length: number, total: number): void => {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(length) ||
    start < 0 ||
    length < 0 ||
    start > total - length
  ) {
    importFailure('ZIP_INVALID', 'ZIP range is truncated or invalid.');
  }
};

const findEndOffset = (archive: Buffer): number => {
  const minimum = Math.max(0, archive.byteLength - 65_557);
  for (let offset = archive.byteLength - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) !== END_SIGNATURE) continue;
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === archive.byteLength) return offset;
  }
  return importFailure('ZIP_INVALID', 'ZIP end record is missing or ambiguous.');
};

const validateExtraFields = (extra: Buffer): void => {
  let cursor = 0;
  while (cursor < extra.byteLength) {
    checkedRange(cursor, 4, extra.byteLength);
    const id = extra.readUInt16LE(cursor);
    const length = extra.readUInt16LE(cursor + 2);
    checkedRange(cursor + 4, length, extra.byteLength);
    if (
      id === ZIP64_EXTRA_ID ||
      id === AES_EXTRA_ID ||
      id === UNICODE_PATH_EXTRA_ID ||
      id === UNICODE_COMMENT_EXTRA_ID
    ) {
      importFailure(
        'ZIP_UNSUPPORTED',
        'ZIP64, AES, and alternate-name ZIP metadata are not supported.',
      );
    }
    cursor += 4 + length;
  }
};

const validateName = (nameBytes: Buffer, flags: number): string => {
  if (
    nameBytes.byteLength === 0 ||
    nameBytes.byteLength > PRESENTATION_IMPORT_LIMITS.maxNameBytes
  ) {
    importFailure('ZIP_LIMIT_EXCEEDED', 'ZIP entry name is outside the fixed budget.');
  }
  if ((flags & 0x0800) === 0 && nameBytes.some((byte) => byte > 0x7f)) {
    importFailure('ZIP_UNSUPPORTED', 'Non-ASCII ZIP names require the UTF-8 flag.');
  }
  const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
  if (!Buffer.from(name, 'utf8').equals(nameBytes)) {
    importFailure('ZIP_INVALID', 'ZIP entry name is not canonical UTF-8.');
  }
  if (
    name !== name.normalize('NFC') ||
    name.includes('\\') ||
    name.includes('\0') ||
    /[\u0000-\u001f\u007f]/u.test(name) ||
    name.startsWith('/') ||
    name.startsWith('//') ||
    /^[a-zA-Z]:/u.test(name)
  ) {
    importFailure('ZIP_INVALID', 'ZIP entry name is unsafe.');
  }
  const segments = name.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    importFailure('ZIP_INVALID', 'ZIP entry name contains traversal or a directory record.');
  }
  return name;
};

const assertDisjointRanges = (entries: readonly CentralEntry[]): void => {
  const ordered = [...entries].sort((left, right) => left.memberStart - right.memberStart);
  let previousEnd = -1;
  for (const entry of ordered) {
    if (entry.memberStart < previousEnd) {
      importFailure('ZIP_INVALID', 'ZIP local member ranges overlap.');
    }
    previousEnd = entry.memberEnd;
  }
};

const decodeEntry = (archive: Buffer, entry: CentralEntry): Uint8Array => {
  const compressed = archive.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  let expanded: Buffer;
  if (entry.method === STORE_METHOD) {
    expanded = Buffer.from(compressed);
  } else {
    try {
      expanded = inflateRawSync(compressed, {
        maxOutputLength: Math.min(
          PRESENTATION_IMPORT_LIMITS.maxExpandedEntryBytes,
          entry.expandedSize + 1,
        ),
      });
    } catch (cause) {
      throw new PresentationImportError('ZIP_INVALID', 'Deflated ZIP member is invalid.', {
        part: entry.name,
        cause,
      });
    }
  }
  if (expanded.byteLength !== entry.expandedSize) {
    importFailure(
      'ZIP_INVALID',
      'ZIP expanded size does not match its central record.',
      entry.name,
    );
  }
  if (crc32(expanded) !== entry.expectedCrc) {
    importFailure('CRC_MISMATCH', 'ZIP entry checksum is invalid.', entry.name);
  }
  return Uint8Array.from(expanded);
};

export const parseOpcArchive = (input: Uint8Array): OpcArchive => {
  if (!(input instanceof Uint8Array)) {
    importFailure('ZIP_INVALID', 'Presentation input must be bytes.');
  }
  if (input.byteLength < 22) importFailure('ZIP_INVALID', 'ZIP archive is truncated.');
  if (input.byteLength > PRESENTATION_IMPORT_LIMITS.maxArchiveBytes) {
    importFailure('INPUT_LIMIT_EXCEEDED', 'Presentation archive exceeds the fixed input budget.');
  }

  const archive = Buffer.from(input);
  const endOffset = findEndOffset(archive);
  checkedRange(endOffset, 22, archive.byteLength);
  const disk = archive.readUInt16LE(endOffset + 4);
  const centralDisk = archive.readUInt16LE(endOffset + 6);
  const diskEntries = archive.readUInt16LE(endOffset + 8);
  const totalEntries = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    importFailure('ZIP_UNSUPPORTED', 'Multi-disk ZIP archives are not supported.');
  }
  if (
    totalEntries === 0 ||
    totalEntries > PRESENTATION_IMPORT_LIMITS.maxEntries ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    importFailure('ZIP_LIMIT_EXCEEDED', 'ZIP entry count or directory size is outside limits.');
  }
  checkedRange(centralOffset, centralSize, endOffset);
  if (centralOffset + centralSize !== endOffset) {
    importFailure('ZIP_INVALID', 'ZIP central directory ownership is inconsistent.');
  }

  const pending: CentralEntry[] = [];
  const collisionKeys = new Set<string>();
  let cursor = centralOffset;
  let totalExpanded = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    checkedRange(cursor, 46, endOffset);
    if (archive.readUInt32LE(cursor) !== CENTRAL_FILE_SIGNATURE) {
      importFailure('ZIP_INVALID', 'ZIP central record is invalid.');
    }
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const expectedCrc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const expandedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const diskStart = archive.readUInt16LE(cursor + 34);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localHeaderOffset = archive.readUInt32LE(cursor + 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    checkedRange(cursor, recordLength, endOffset);

    if ((flags & UNSAFE_FLAG_MASK) !== 0) {
      importFailure(
        'ZIP_UNSUPPORTED',
        'Encrypted, masked, or data-descriptor ZIP members are not supported.',
      );
    }
    const allowedFlagMask = 0x0800 | (method === DEFLATE_METHOD ? 0x0006 : 0);
    if ((flags & ~allowedFlagMask) !== 0) {
      importFailure('ZIP_UNSUPPORTED', 'ZIP member uses unsupported general-purpose flags.');
    }
    if (diskStart !== 0 || localHeaderOffset === 0xffffffff) {
      importFailure('ZIP_UNSUPPORTED', 'ZIP64 or multi-disk members are not supported.');
    }
    if (method !== STORE_METHOD && method !== DEFLATE_METHOD) {
      importFailure('ZIP_UNSUPPORTED', 'Only stored and deflated ZIP members are supported.');
    }
    if (
      compressedSize > PRESENTATION_IMPORT_LIMITS.maxCompressedEntryBytes ||
      expandedSize > PRESENTATION_IMPORT_LIMITS.maxExpandedEntryBytes
    ) {
      importFailure('ZIP_LIMIT_EXCEEDED', 'ZIP member exceeds the fixed size budget.');
    }
    if (method === STORE_METHOD && compressedSize !== expandedSize) {
      importFailure('ZIP_INVALID', 'Stored ZIP member sizes disagree.');
    }
    if (
      method === DEFLATE_METHOD &&
      expandedSize > PRESENTATION_IMPORT_LIMITS.maxCompressionRatio * Math.max(1, compressedSize)
    ) {
      importFailure('ZIP_LIMIT_EXCEEDED', 'ZIP member exceeds the compression-ratio budget.');
    }
    if (totalExpanded > PRESENTATION_IMPORT_LIMITS.maxTotalExpandedBytes - expandedSize) {
      importFailure('ZIP_LIMIT_EXCEEDED', 'ZIP aggregate expanded size exceeds its budget.');
    }
    totalExpanded += expandedSize;
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0o170000) === 0o120000) {
      importFailure('ZIP_INVALID', 'Symlink ZIP members are forbidden.');
    }

    const nameBytes = archive.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = validateName(nameBytes, flags);
    const collisionKey = name.normalize('NFC').toLocaleLowerCase('en-US');
    if (collisionKeys.has(collisionKey)) {
      importFailure('ZIP_INVALID', 'ZIP contains duplicate or case-colliding entry names.');
    }
    collisionKeys.add(collisionKey);
    validateExtraFields(
      archive.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength),
    );

    checkedRange(localHeaderOffset, 30, centralOffset);
    if (archive.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_SIGNATURE) {
      importFailure('ZIP_INVALID', 'ZIP local record is invalid.', name);
    }
    const localFlags = archive.readUInt16LE(localHeaderOffset + 6);
    const localMethod = archive.readUInt16LE(localHeaderOffset + 8);
    const localCrc = archive.readUInt32LE(localHeaderOffset + 14);
    const localCompressed = archive.readUInt32LE(localHeaderOffset + 18);
    const localExpanded = archive.readUInt32LE(localHeaderOffset + 22);
    const localNameLength = archive.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
    checkedRange(localHeaderOffset + 30, localNameLength + localExtraLength, centralOffset);
    const localNameBytes = archive.subarray(
      localHeaderOffset + 30,
      localHeaderOffset + 30 + localNameLength,
    );
    const localName = validateName(localNameBytes, localFlags);
    const localExtra = archive.subarray(
      localHeaderOffset + 30 + localNameLength,
      localHeaderOffset + 30 + localNameLength + localExtraLength,
    );
    validateExtraFields(localExtra);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    checkedRange(dataOffset, compressedSize, centralOffset);
    if (
      localName !== name ||
      localFlags !== flags ||
      localMethod !== method ||
      localCrc !== expectedCrc ||
      localCompressed !== compressedSize ||
      localExpanded !== expandedSize
    ) {
      importFailure('ZIP_INVALID', 'ZIP local and central records disagree.', name);
    }
    pending.push({
      name,
      expectedCrc,
      compressedSize,
      expandedSize,
      method,
      dataOffset,
      memberStart: localHeaderOffset,
      memberEnd: dataOffset + compressedSize,
    });
    cursor += recordLength;
  }
  if (cursor !== endOffset) {
    importFailure('ZIP_INVALID', 'ZIP central directory contains extra records.');
  }
  assertDisjointRanges(pending);

  const entries = new Map<string, OpcArchiveEntry>();
  for (const entry of pending) {
    entries.set(
      entry.name,
      Object.freeze({
        name: entry.name,
        bytes: decodeEntry(archive, entry),
        compressedSize: entry.compressedSize,
        expandedSize: entry.expandedSize,
        compressionMethod: entry.method === STORE_METHOD ? 'stored' : 'deflate',
        crc32: entry.expectedCrc,
      }),
    );
  }
  return Object.freeze({
    entries,
    archiveBytes: input.byteLength,
    expandedBytes: totalExpanded,
  });
};
