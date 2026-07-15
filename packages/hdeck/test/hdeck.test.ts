import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createNeutralDemoDeck,
  type DeckDocument,
  type TransactionMetadata,
} from '@htmllelujah/document-core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  appendJournalRecord,
  canonicalJson,
  createHdeckArchive,
  createJournalBytes,
  createJournalRecord,
  encodeStoredZip,
  fingerprintFile,
  HdeckError,
  initializeJournalFile,
  JournalError,
  parseHdeckArchive,
  PersistenceError,
  replayJournal,
  saveHdeckAtomic,
  sha256,
  type HdeckManifestV1,
  type JournalHeader,
} from '../src/index.js';

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

describe('.hdeck archive', () => {
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

  it('stores content-addressed assets and validates document references', () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
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
