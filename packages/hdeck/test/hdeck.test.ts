import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  canonicalDocumentBytes,
  createNeutralDemoDeck,
  type DeckDocument,
  type TransactionMetadata,
} from '@htmllelujah/document-core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  appendJournalRecord,
  assertDisjointZipMemberRanges,
  assertHdeckRepresentable,
  assertHdeckRepresentableWithValidatedAssets,
  canonicalJson,
  createHdeckArchive,
  createHdeckArchiveWithValidatedAssets,
  createJournalBytes,
  createJournalRecord,
  encodeStoredZip,
  fingerprintFile,
  HdeckError,
  initializeJournalFile,
  JournalError,
  parseImageHeader,
  parseHdeckArchive,
  PersistenceError,
  replayJournal,
  saveHdeckAtomic,
  sha256,
  validateHdeckAsset,
  type HdeckManifestV1,
  type JournalHeader,
} from '../src/index.js';

const imageId = '40000000-0000-4000-8000-000000000001';

const pngHeader = (widthPx: number, heightPx: number): Uint8Array => {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(widthPx, 16);
  bytes.writeUInt32BE(heightPx, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return Uint8Array.from(bytes);
};

const jpegHeader = (widthPx: number, heightPx: number): Uint8Array => {
  const bytes = Buffer.alloc(17);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08], 0);
  bytes.writeUInt16BE(heightPx, 7);
  bytes.writeUInt16BE(widthPx, 9);
  bytes.set([0x01, 0x01, 0x11, 0x00, 0xff, 0xd9], 11);
  return Uint8Array.from(bytes);
};

const webpExtendedHeader = (widthPx: number, heightPx: number): Uint8Array => {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.byteLength - 8, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8X', 12, 'ascii');
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(widthPx - 1, 24, 3);
  bytes.writeUIntLE(heightPx - 1, 27, 3);
  return Uint8Array.from(bytes);
};

const webpLossyHeader = (widthPx: number, heightPx: number): Uint8Array => {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.byteLength - 8, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8 ', 12, 'ascii');
  bytes.writeUInt32LE(10, 16);
  bytes.set([0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a], 20);
  bytes.writeUInt16LE(widthPx, 26);
  bytes.writeUInt16LE(heightPx, 28);
  return Uint8Array.from(bytes);
};

const webpLosslessHeader = (widthPx: number, heightPx: number): Uint8Array => {
  const widthMinusOne = widthPx - 1;
  const heightMinusOne = heightPx - 1;
  const bytes = Buffer.alloc(26);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.byteLength - 8, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8L', 12, 'ascii');
  bytes.writeUInt32LE(5, 16);
  bytes[20] = 0x2f;
  bytes[21] = widthMinusOne & 0xff;
  bytes[22] = ((widthMinusOne >>> 8) & 0x3f) | ((heightMinusOne & 0x03) << 6);
  bytes[23] = (heightMinusOne >>> 2) & 0xff;
  bytes[24] = (heightMinusOne >>> 10) & 0x0f;
  return Uint8Array.from(bytes);
};

interface SyntheticAssetArchiveOptions {
  readonly bytes: Uint8Array;
  readonly manifestMediaType?: 'image/png' | 'image/jpeg' | 'image/webp' | 'font/woff2';
  readonly documentMediaType?: 'image/png' | 'image/jpeg' | 'image/webp' | 'font/woff2';
  readonly kind?: 'image' | 'font';
  readonly manifestWidthPx?: number | undefined;
  readonly manifestHeightPx?: number | undefined;
  readonly documentWidthPx?: number | undefined;
  readonly documentHeightPx?: number | undefined;
}

const syntheticAssetArchive = (options: SyntheticAssetArchiveOptions): Uint8Array => {
  const manifestMediaType = options.manifestMediaType ?? 'image/png';
  const documentMediaType = options.documentMediaType ?? manifestMediaType;
  const kind = options.kind ?? (manifestMediaType === 'font/woff2' ? 'font' : 'image');
  const hash = sha256(options.bytes);
  const extension =
    manifestMediaType === 'image/png'
      ? 'png'
      : manifestMediaType === 'image/jpeg'
        ? 'jpg'
        : manifestMediaType === 'image/webp'
          ? 'webp'
          : 'woff2';
  const document = {
    ...createNeutralDemoDeck(),
    assets: [
      {
        id: imageId,
        kind,
        hash,
        mediaType: documentMediaType,
        fileName: `fixture.${extension}`,
        byteLength: options.bytes.byteLength,
        ...(options.documentWidthPx === undefined ? {} : { widthPx: options.documentWidthPx }),
        ...(options.documentHeightPx === undefined ? {} : { heightPx: options.documentHeightPx }),
      },
    ],
  } as DeckDocument;
  const documentBytes = Buffer.from(canonicalJson(document));
  const entry = `assets/${hash}.${extension}`;
  const manifest: HdeckManifestV1 = {
    format: 'htmllelujah.deck',
    containerVersion: 1,
    documentSchemaVersion: document.schemaVersion,
    documentId: document.id,
    createdAt: '2026-07-15T12:00:00.000Z',
    modifiedAt: '2026-07-15T12:00:00.000Z',
    documentEntry: 'document.json',
    documentSha256: sha256(documentBytes),
    assets: [
      {
        id: imageId,
        entry,
        sha256: hash,
        byteLength: options.bytes.byteLength,
        mediaType: manifestMediaType,
        ...(options.manifestWidthPx === undefined ? {} : { widthPx: options.manifestWidthPx }),
        ...(options.manifestHeightPx === undefined ? {} : { heightPx: options.manifestHeightPx }),
      },
    ],
    optionalEntries: [],
  };
  return encodeStoredZip([
    { name: 'manifest.json', bytes: Buffer.from(canonicalJson(manifest)) },
    { name: 'document.json', bytes: documentBytes },
    { name: entry, bytes: options.bytes },
  ]);
};

const syntheticVersionArchive = (
  containerVersion: number,
  manifestSchemaVersion: number,
  documentSchemaVersion: number,
): Uint8Array => {
  const document = { ...createNeutralDemoDeck(), schemaVersion: documentSchemaVersion };
  const documentBytes = Buffer.from(canonicalJson(document));
  const manifest = {
    format: 'htmllelujah.deck',
    containerVersion,
    documentSchemaVersion: manifestSchemaVersion,
    documentId: document.id,
    createdAt: '2026-07-15T12:00:00.000Z',
    modifiedAt: '2026-07-15T12:00:00.000Z',
    documentEntry: 'document.json',
    documentSha256: sha256(documentBytes),
    assets: [],
    optionalEntries: [],
  };
  return encodeStoredZip([
    { name: 'manifest.json', bytes: Buffer.from(canonicalJson(manifest)) },
    { name: 'document.json', bytes: documentBytes },
  ]);
};

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-é '));
  directories.push(directory);
  return directory;
};

const replaceAllBytes = (source: Uint8Array, before: string, after: string): Uint8Array => {
  expect(Buffer.byteLength(before)).toBe(Buffer.byteLength(after));
  const result = Buffer.from(source);
  const needle = Buffer.from(before);
  const replacement = Buffer.from(after);
  let offset = 0;
  let replacements = 0;
  while ((offset = result.indexOf(needle, offset)) >= 0) {
    replacement.copy(result, offset);
    offset += replacement.length;
    replacements += 1;
  }
  expect(replacements).toBeGreaterThan(0);
  return result;
};

const journalHeader = (): JournalHeader => ({
  format: 'htmllelujah.journal',
  version: 1,
  documentId: '10000000-0000-4000-8000-000000000001',
  baseDocumentSha256: 'a'.repeat(64),
  sessionId: '20000000-0000-4000-8000-000000000001',
});

const metadata: TransactionMetadata = {
  transactionId: '30000000-0000-4000-8000-000000000001',
  actorId: 'test-user',
  origin: 'user',
  label: 'Rename deck',
  timestamp: '2026-07-15T12:00:00.000Z',
};

describe('bounded image header parser', () => {
  it('detects PNG, JPEG, and WebP dimensions without decoding pixels', () => {
    expect(parseImageHeader(pngHeader(640, 480))).toEqual({
      mediaType: 'image/png',
      widthPx: 640,
      heightPx: 480,
    });
    expect(parseImageHeader(jpegHeader(1_920, 1_080))).toEqual({
      mediaType: 'image/jpeg',
      widthPx: 1_920,
      heightPx: 1_080,
    });
    expect(parseImageHeader(webpExtendedHeader(800, 600))).toEqual({
      mediaType: 'image/webp',
      widthPx: 800,
      heightPx: 600,
    });
    expect(parseImageHeader(webpLossyHeader(320, 240))).toEqual({
      mediaType: 'image/webp',
      widthPx: 320,
      heightPx: 240,
    });
    expect(parseImageHeader(webpLosslessHeader(1_024, 768))).toEqual({
      mediaType: 'image/webp',
      widthPx: 1_024,
      heightPx: 768,
    });
    expect(parseImageHeader(webpExtendedHeader(8_192, 8_192))).toMatchObject({
      widthPx: 8_192,
      heightPx: 8_192,
    });
  });

  it('rejects malformed headers, oversized edges, and excessive pixel area', () => {
    expect(() => parseImageHeader(pngHeader(16_385, 1))).toThrowError(
      expect.objectContaining({ code: 'ARCHIVE_LIMIT_EXCEEDED' }),
    );
    expect(() => parseImageHeader(webpExtendedHeader(10_000, 10_000))).toThrowError(
      expect.objectContaining({ code: 'ARCHIVE_LIMIT_EXCEEDED' }),
    );
    expect(() => parseImageHeader(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toThrowError(
      expect.objectContaining({ code: 'ARCHIVE_INVALID' }),
    );
    expect(() => parseImageHeader(Buffer.from('not an image'))).toThrowError(
      expect.objectContaining({ code: 'ARCHIVE_INVALID' }),
    );
    const invalidRiffLength = Uint8Array.from(webpExtendedHeader(320, 240));
    invalidRiffLength[4] = 0;
    expect(() => parseImageHeader(invalidRiffLength)).toThrowError(
      expect.objectContaining({ code: 'ARCHIVE_INVALID' }),
    );
  });
});

describe('bounded ZIP member ownership', () => {
  it('rejects overlap independent of descriptor order and accepts exact adjacency', () => {
    expect(() =>
      assertDisjointZipMemberRanges([
        { memberStart: 48, memberEnd: 96 },
        { memberStart: 0, memberEnd: 64 },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'ARCHIVE_INVALID' }));
    expect(() =>
      assertDisjointZipMemberRanges([
        { memberStart: 20, memberEnd: 40 },
        { memberStart: 20, memberEnd: 40 },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'ARCHIVE_INVALID' }));
    expect(() =>
      assertDisjointZipMemberRanges([
        { memberStart: 10, memberEnd: 90 },
        { memberStart: 30, memberEnd: 40 },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'ARCHIVE_INVALID' }));
    expect(() =>
      assertDisjointZipMemberRanges([
        { memberStart: 48, memberEnd: 96 },
        { memberStart: 0, memberEnd: 48 },
      ]),
    ).not.toThrow();
  });
});

describe('.hdeck archive', () => {
  it('uses the shared canonical UTF-8 document boundary exactly', () => {
    const document = createNeutralDemoDeck();
    const byteLength = canonicalDocumentBytes(document).byteLength;
    expect(() =>
      assertHdeckRepresentable({ document }, { maxDocumentBytes: byteLength }),
    ).not.toThrow();
    expect(() =>
      assertHdeckRepresentable({ document }, { maxDocumentBytes: byteLength - 1 }),
    ).toThrowError(expect.objectContaining({ code: 'ARCHIVE_LIMIT_EXCEEDED' }));
  });

  it('preflights expanded bytes and exact stored-ZIP overhead before archive allocation', () => {
    const input = {
      document: createNeutralDemoDeck(),
      createdAt: '2026-07-20T12:00:00.000Z',
      modifiedAt: '2026-07-20T12:00:00.000Z',
    };
    const archive = createHdeckArchive(input);
    const zipOverhead =
      22 +
      76 +
      Buffer.byteLength('manifest.json', 'utf8') * 2 +
      76 +
      Buffer.byteLength('document.json', 'utf8') * 2;
    const expandedBytes = archive.byteLength - zipOverhead;

    expect(() =>
      assertHdeckRepresentable(input, {
        maxArchiveBytes: archive.byteLength,
        maxTotalBytes: expandedBytes,
        maxEntries: 2,
      }),
    ).not.toThrow();
    expect(() =>
      assertHdeckRepresentable(input, { maxArchiveBytes: archive.byteLength - 1 }),
    ).toThrowError(expect.objectContaining({ code: 'ARCHIVE_LIMIT_EXCEEDED' }));
    expect(() =>
      assertHdeckRepresentable(input, { maxTotalBytes: expandedBytes - 1 }),
    ).toThrowError(expect.objectContaining({ code: 'ARCHIVE_LIMIT_EXCEEDED' }));
    expect(() => assertHdeckRepresentable(input, { maxEntries: 1 })).toThrowError(
      expect.objectContaining({ code: 'ARCHIVE_LIMIT_EXCEEDED' }),
    );
  });

  it('shares one byte-derived asset compatibility policy with precommit callers', () => {
    const bytes = pngHeader(1, 1);
    const hash = sha256(bytes);
    const firstId = '40000000-0000-4000-8000-000000000011';
    const secondId = '40000000-0000-4000-8000-000000000012';
    const reference = (id: string) => ({
      id,
      kind: 'image' as const,
      hash,
      mediaType: 'image/png',
      fileName: 'tiny.png',
      byteLength: bytes.byteLength,
      widthPx: 1,
      heightPx: 1,
    });
    const input = (id: string, widthPx = 1) => ({
      id,
      bytes,
      mediaType: 'image/png' as const,
      widthPx,
      heightPx: 1,
    });
    const document = { ...createNeutralDemoDeck(), assets: [reference(firstId)] };

    expect(() => assertHdeckRepresentable({ document, assets: [input(firstId)] })).not.toThrow();
    expect(() => assertHdeckRepresentable({ document, assets: [input(firstId, 2)] })).toThrowError(
      expect.objectContaining({ code: 'ARCHIVE_INVALID' }),
    );
    expect(() =>
      assertHdeckRepresentable({
        document: { ...document, assets: [reference(firstId), reference(secondId)] },
        assets: [input(firstId), input(secondId)],
      }),
    ).toThrowError(expect.objectContaining({ code: 'ARCHIVE_INVALID' }));
  });

  it('accepts only authoritative immutable-asset proofs for incremental checks', () => {
    const bytes = pngHeader(1, 1);
    const id = '40000000-0000-4000-8000-000000000013';
    const validated = validateHdeckAsset({
      id,
      bytes,
      mediaType: 'image/png',
      widthPx: 1,
      heightPx: 1,
    });
    const document = {
      ...createNeutralDemoDeck(),
      assets: [
        {
          id,
          kind: 'image' as const,
          hash: sha256(bytes),
          mediaType: 'image/png',
          fileName: 'proof.png',
          byteLength: bytes.byteLength,
          widthPx: 1,
          heightPx: 1,
        },
      ],
    };

    expect(Object.isFrozen(validated)).toBe(true);
    expect(() =>
      assertHdeckRepresentableWithValidatedAssets({ document, assets: [validated] }),
    ).not.toThrow();
    const timestamps = {
      createdAt: '2026-07-15T12:00:00.000Z',
      modifiedAt: '2026-07-15T12:00:00.000Z',
    };
    expect(
      createHdeckArchiveWithValidatedAssets({
        document,
        assets: [validated],
        ...timestamps,
      }),
    ).toEqual(
      createHdeckArchive({
        document,
        assets: [
          {
            id,
            bytes,
            mediaType: 'image/png',
            widthPx: 1,
            heightPx: 1,
          },
        ],
        ...timestamps,
      }),
    );
    expect(() =>
      assertHdeckRepresentableWithValidatedAssets({
        document,
        assets: [{ ...validated }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'ARCHIVE_INVALID' }));
  });

  it('round-trips a canonical deck deterministically', () => {
    const document = createNeutralDemoDeck();
    const input = {
      document,
      createdAt: '2026-07-15T12:00:00.000Z',
      modifiedAt: '2026-07-15T12:00:00.000Z',
    };
    const first = createHdeckArchive(input);
    const second = createHdeckArchive(input);
    expect(first).toEqual(second);

    const parsed = parseHdeckArchive(first);
    expect(parsed.document).toEqual(document);
    expect(parsed.manifest.documentId).toBe(document.id);
    expect(parsed.manifest.assets).toEqual([]);
    expect(parsed.archiveSha256).toBe(sha256(first));
  });

  it('distinguishes future container and document schema versions', () => {
    expect(() => parseHdeckArchive(syntheticVersionArchive(2, 2, 2))).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_VERSION' }),
    );
    expect(() => parseHdeckArchive(syntheticVersionArchive(1, 3, 3))).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_VERSION' }),
    );
    expect(() => parseHdeckArchive(syntheticVersionArchive(1, 2, 3))).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_VERSION' }),
    );
  });

  it('stores content-addressed assets and validates document references', () => {
    const bytes = pngHeader(1, 1);
    const hash = sha256(bytes);
    const document = {
      ...createNeutralDemoDeck(),
      assets: [
        {
          id: '40000000-0000-4000-8000-000000000001',
          kind: 'image',
          hash,
          mediaType: 'image/png',
          fileName: 'graph.png',
          byteLength: bytes.byteLength,
          widthPx: 1,
          heightPx: 1,
        },
      ],
    } as DeckDocument;
    const archive = createHdeckArchive({
      document,
      assets: [
        {
          id: '40000000-0000-4000-8000-000000000001',
          bytes,
          mediaType: 'image/png',
          originalName: '../graph.png',
          widthPx: 1,
          heightPx: 1,
        },
      ],
    });
    const parsed = parseHdeckArchive(archive);
    expect(parsed.assets.get('40000000-0000-4000-8000-000000000001')).toEqual(bytes);
    expect(parsed.manifest.assets[0]?.entry).toBe(`assets/${hash}.png`);
  });

  it('does not generate an archive with mislabeled asset input', () => {
    const bytes = pngHeader(2, 3);
    const document = {
      ...createNeutralDemoDeck(),
      assets: [
        {
          id: imageId,
          kind: 'image',
          hash: sha256(bytes),
          mediaType: 'image/jpeg',
          fileName: 'mislabeled.jpg',
          byteLength: bytes.byteLength,
          widthPx: 2,
          heightPx: 3,
        },
      ],
    } as DeckDocument;
    expect(() =>
      createHdeckArchive({
        document,
        assets: [
          {
            id: imageId,
            bytes,
            mediaType: 'image/jpeg',
            widthPx: 2,
            heightPx: 3,
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'ARCHIVE_INVALID' }));
  });

  it('rejects mislabeled image bytes before exposing an asset', () => {
    const archive = syntheticAssetArchive({
      bytes: pngHeader(2, 3),
      manifestMediaType: 'image/jpeg',
      documentMediaType: 'image/jpeg',
      manifestWidthPx: 2,
      manifestHeightPx: 3,
      documentWidthPx: 2,
      documentHeightPx: 3,
    });
    expect(() => parseHdeckArchive(archive)).toThrowError(
      expect.objectContaining({ code: 'ARCHIVE_INVALID' }),
    );
  });

  it('rejects manifest dimensions that disagree with image bytes', () => {
    const archive = syntheticAssetArchive({
      bytes: pngHeader(2, 3),
      manifestWidthPx: 2,
      manifestHeightPx: 4,
      documentWidthPx: 2,
      documentHeightPx: 4,
    });
    expect(() => parseHdeckArchive(archive)).toThrowError(
      expect.objectContaining({ code: 'ARCHIVE_INVALID' }),
    );
  });

  it('rejects document dimensions that disagree with the manifest and bytes', () => {
    const archive = syntheticAssetArchive({
      bytes: pngHeader(2, 3),
      manifestWidthPx: 2,
      manifestHeightPx: 3,
      documentWidthPx: 2,
      documentHeightPx: 4,
    });
    expect(() => parseHdeckArchive(archive)).toThrowError(
      expect.objectContaining({ code: 'ARCHIVE_INVALID' }),
    );
  });

  it('requires both image metadata sources and preserves font assets unchanged', () => {
    const missingDimensions = syntheticAssetArchive({
      bytes: pngHeader(2, 3),
      manifestWidthPx: 2,
      manifestHeightPx: 3,
    });
    expect(() => parseHdeckArchive(missingDimensions)).toThrowError(
      expect.objectContaining({ code: 'ARCHIVE_INVALID' }),
    );

    const fontBytes = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]);
    const fontArchive = syntheticAssetArchive({
      bytes: fontBytes,
      manifestMediaType: 'font/woff2',
      documentMediaType: 'font/woff2',
      kind: 'font',
    });
    expect(parseHdeckArchive(fontArchive).assets.get(imageId)).toEqual(Uint8Array.from(fontBytes));

    const mislabeledFont = syntheticAssetArchive({
      bytes: pngHeader(2, 3),
      manifestMediaType: 'font/woff2',
      documentMediaType: 'font/woff2',
      kind: 'font',
    });
    expect(() => parseHdeckArchive(mislabeledFont)).toThrowError(
      expect.objectContaining({ code: 'ARCHIVE_INVALID' }),
    );
  });

  it('rejects image bombs even when every declared dimension matches', () => {
    const archive = syntheticAssetArchive({
      bytes: webpExtendedHeader(10_000, 10_000),
      manifestMediaType: 'image/webp',
      documentMediaType: 'image/webp',
      manifestWidthPx: 10_000,
      manifestHeightPx: 10_000,
      documentWidthPx: 10_000,
      documentHeightPx: 10_000,
    });
    expect(() => parseHdeckArchive(archive)).toThrowError(
      expect.objectContaining({ code: 'ARCHIVE_LIMIT_EXCEEDED' }),
    );
  });

  it('rejects traversal names before parsing any document content', () => {
    const archive = createHdeckArchive({ document: createNeutralDemoDeck() });
    const malicious = replaceAllBytes(archive, 'document.json', '../evil.jsonx');
    expect(() => parseHdeckArchive(malicious)).toThrowError(HdeckError);
    try {
      parseHdeckArchive(malicious);
    } catch (error) {
      expect((error as HdeckError).code).toBe('ARCHIVE_INVALID');
    }
  });

  it('rejects case-insensitive central-directory collisions', () => {
    const archive = encodeStoredZip([
      { name: 'one/file.json', bytes: Buffer.from('{}') },
      { name: 'two/file.json', bytes: Buffer.from('{}') },
    ]);
    const collision = replaceAllBytes(archive, 'two/file.json', 'ONE/file.json');
    expect(() => parseHdeckArchive(collision)).toThrowError(HdeckError);
  });

  it('rejects undeclared entries even when their ZIP checksums are valid', () => {
    const document = createNeutralDemoDeck();
    const documentBytes = Buffer.from(canonicalJson(document));
    const now = '2026-07-15T12:00:00.000Z';
    const manifest: HdeckManifestV1 = {
      format: 'htmllelujah.deck',
      containerVersion: 1,
      documentSchemaVersion: document.schemaVersion,
      documentId: document.id,
      createdAt: now,
      modifiedAt: now,
      documentEntry: 'document.json',
      documentSha256: sha256(documentBytes),
      assets: [],
      optionalEntries: [],
    };
    const archive = encodeStoredZip([
      { name: 'manifest.json', bytes: Buffer.from(canonicalJson(manifest)) },
      { name: 'document.json', bytes: documentBytes },
      { name: 'surprise.txt', bytes: Buffer.from('untrusted') },
    ]);
    expect(() => parseHdeckArchive(archive)).toThrowError(
      expect.objectContaining({ code: 'ENTRY_UNDECLARED' }),
    );
  });

  it('rejects trailing bytes and corrupted data', () => {
    const archive = createHdeckArchive({ document: createNeutralDemoDeck() });
    expect(() => parseHdeckArchive(Buffer.concat([archive, Buffer.from([1])]))).toThrowError(
      HdeckError,
    );
    const corrupted = Uint8Array.from(archive);
    corrupted[40] = (corrupted[40] ?? 0) ^ 0xff;
    expect(() => parseHdeckArchive(corrupted)).toThrowError(HdeckError);
  });
});

describe('atomic persistence', () => {
  it('writes, reopens, verifies, and replaces only the expected fingerprint', async () => {
    const directory = await temporaryDirectory();
    const target = path.join(directory, 'Présentation V1.hdeck');
    const firstArchive = createHdeckArchive({ document: createNeutralDemoDeck() });
    const first = await saveHdeckAtomic(target, firstArchive, { expectedFingerprint: null });
    expect(first.fingerprint).toBe(await fingerprintFile(target));
    expect(parseHdeckArchive(await readFile(target)).document.name).toBe(
      createNeutralDemoDeck().name,
    );

    const secondDocument = { ...createNeutralDemoDeck(), name: 'Second version' };
    const secondArchive = createHdeckArchive({ document: secondDocument });
    await expect(
      saveHdeckAtomic(target, secondArchive, { expectedFingerprint: '0'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'TARGET_CHANGED' });
    expect(await fingerprintFile(target)).toBe(first.fingerprint);

    const second = await saveHdeckAtomic(target, secondArchive, {
      expectedFingerprint: first.fingerprint,
    });
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(parseHdeckArchive(await readFile(target)).document.name).toBe('Second version');
  });

  it('requires explicit overwrite approval when no fingerprint is supplied', async () => {
    const directory = await temporaryDirectory();
    const target = path.join(directory, 'deck.hdeck');
    const archive = createHdeckArchive({ document: createNeutralDemoDeck() });
    await saveHdeckAtomic(target, archive, { expectedFingerprint: null });
    await expect(saveHdeckAtomic(target, archive)).rejects.toBeInstanceOf(PersistenceError);
    await expect(saveHdeckAtomic(target, archive)).rejects.toMatchObject({
      code: 'OVERWRITE_REQUIRES_APPROVAL',
    });
  });

  it('rejects non-hdeck and relative targets', async () => {
    const archive = createHdeckArchive({ document: createNeutralDemoDeck() });
    await expect(saveHdeckAtomic('relative.hdeck', archive)).rejects.toMatchObject({
      code: 'TARGET_UNAVAILABLE',
    });
    const directory = await temporaryDirectory();
    await expect(saveHdeckAtomic(path.join(directory, 'deck.zip'), archive)).rejects.toMatchObject({
      code: 'TARGET_UNAVAILABLE',
    });
  });
});

describe('recovery journal', () => {
  const firstRecord = () =>
    createJournalRecord({
      sequence: 1,
      previousRevision: 'revision-one',
      revision: 'revision-two',
      metadata,
      commands: [
        {
          type: 'slide.reorder',
          slideId: '10000000-0000-4000-8000-000000000010',
          toIndex: 0,
        },
      ],
    });

  it('round-trips checksummed records', () => {
    const bytes = createJournalBytes(journalHeader(), [firstRecord()]);
    const replay = replayJournal(bytes);
    expect(replay.complete).toBe(true);
    expect(replay.records).toEqual([firstRecord()]);
    expect(replay.validByteLength).toBe(bytes.byteLength);
  });

  it('recovers the valid prefix of a truncated journal', () => {
    const bytes = createJournalBytes(journalHeader(), [firstRecord()]);
    const replay = replayJournal(bytes.subarray(0, bytes.length - 8));
    expect(replay.complete).toBe(false);
    expect(replay.records).toEqual([]);
    expect(replay.stoppedReason).toBe('truncated');
    expect(replay.validByteLength).toBeGreaterThan(8);
  });

  it('rejects invalid headers and record sequence gaps', () => {
    expect(() => replayJournal(Buffer.from('not-a-journal'))).toThrowError(JournalError);
    expect(() =>
      createJournalBytes(journalHeader(), [{ ...firstRecord(), sequence: 2 }]),
    ).toThrowError(JournalError);
  });

  it('durably appends a valid next record and rejects duplicate sequence', async () => {
    const directory = await temporaryDirectory();
    const target = path.join(directory, 'recovery.journal');
    await initializeJournalFile(target, journalHeader());
    await appendJournalRecord(target, firstRecord());
    expect(replayJournal(await readFile(target)).records).toHaveLength(1);
    await expect(appendJournalRecord(target, firstRecord())).rejects.toMatchObject({
      code: 'JOURNAL_INVALID',
    });
  });

  it('stops before a tampered record without accepting it', () => {
    const bytes = createJournalBytes(journalHeader(), [firstRecord()]);
    const tampered = Uint8Array.from(bytes);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    const replay = replayJournal(tampered);
    expect(replay.complete).toBe(false);
    expect(replay.records).toEqual([]);
    expect(replay.stoppedReason).toBe('invalid-frame');
  });
});
