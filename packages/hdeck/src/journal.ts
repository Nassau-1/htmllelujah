import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { DocumentCommand, TransactionMetadata } from '@htmllelujah/document-core';

import { canonicalJson, sha256 } from './archive.js';

const MAGIC = Buffer.from('HDECKJ1\n', 'ascii');
const DIGEST_LENGTH = 32;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const MAX_RECORDS = 100_000;

export interface JournalHeader {
  readonly format: 'htmllelujah.journal';
  readonly version: 1;
  readonly documentId: string;
  readonly baseDocumentSha256: string;
  readonly sessionId: string;
}

export interface JournalRecordContent {
  readonly sequence: number;
  readonly previousRevision: string;
  readonly revision: string;
  readonly metadata: TransactionMetadata;
  readonly commands: readonly DocumentCommand[];
}

export interface JournalRecord extends JournalRecordContent {
  readonly checksum: string;
}

export interface JournalReplayResult {
  readonly header: JournalHeader;
  readonly records: readonly JournalRecord[];
  readonly complete: boolean;
  readonly validByteLength: number;
  readonly stoppedReason?: 'truncated' | 'invalid-frame' | 'invalid-record' | undefined;
}

export class JournalError extends Error {
  public constructor(
    public readonly code: 'JOURNAL_INVALID' | 'JOURNAL_LIMIT_EXCEEDED',
    message: string,
  ) {
    super(message);
    this.name = 'JournalError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const digestBytes = (bytes: Uint8Array): Buffer => Buffer.from(sha256(bytes), 'hex');

const encodeFrame = (payload: Uint8Array, maximum: number): Buffer => {
  if (payload.byteLength === 0 || payload.byteLength > maximum) {
    throw new JournalError('JOURNAL_LIMIT_EXCEEDED', 'Journal frame is outside limits.');
  }
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32LE(payload.byteLength, 0);
  return Buffer.concat([prefix, Buffer.from(payload), digestBytes(payload)]);
};

const parseHeader = (value: unknown): JournalHeader => {
  if (!isRecord(value)) throw new JournalError('JOURNAL_INVALID', 'Journal header is invalid.');
  const allowed = new Set(['format', 'version', 'documentId', 'baseDocumentSha256', 'sessionId']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new JournalError('JOURNAL_INVALID', 'Journal header contains unknown fields.');
  }
  if (
    value.format !== 'htmllelujah.journal' ||
    value.version !== 1 ||
    typeof value.documentId !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.baseDocumentSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.baseDocumentSha256)
  ) {
    throw new JournalError('JOURNAL_INVALID', 'Journal header fields are invalid.');
  }
  return {
    format: 'htmllelujah.journal',
    version: 1,
    documentId: value.documentId,
    baseDocumentSha256: value.baseDocumentSha256,
    sessionId: value.sessionId,
  };
};

const recordContent = (record: JournalRecord): JournalRecordContent => ({
  sequence: record.sequence,
  previousRevision: record.previousRevision,
  revision: record.revision,
  metadata: record.metadata,
  commands: record.commands,
});

export const createJournalRecord = (content: JournalRecordContent): JournalRecord => {
  const checksum = sha256(Buffer.from(canonicalJson(content), 'utf8'));
  return { ...content, checksum };
};

const parseJournalRecord = (value: unknown, expectedSequence: number): JournalRecord => {
  if (!isRecord(value)) throw new JournalError('JOURNAL_INVALID', 'Journal record is invalid.');
  const allowed = new Set([
    'sequence',
    'previousRevision',
    'revision',
    'metadata',
    'commands',
    'checksum',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new JournalError('JOURNAL_INVALID', 'Journal record contains unknown fields.');
  }
  if (
    value.sequence !== expectedSequence ||
    typeof value.previousRevision !== 'string' ||
    typeof value.revision !== 'string' ||
    typeof value.checksum !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.checksum) ||
    !isRecord(value.metadata) ||
    !Array.isArray(value.commands) ||
    value.commands.length === 0 ||
    value.commands.length > 100
  ) {
    throw new JournalError('JOURNAL_INVALID', 'Journal record fields are invalid.');
  }
  const candidate = value as unknown as JournalRecord;
  const expectedChecksum = sha256(Buffer.from(canonicalJson(recordContent(candidate)), 'utf8'));
  if (candidate.checksum !== expectedChecksum) {
    throw new JournalError('JOURNAL_INVALID', 'Journal record checksum is invalid.');
  }
  return candidate;
};

const parseJson = (bytes: Uint8Array): unknown => {
  const text = Buffer.from(bytes).toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(Buffer.from(bytes))) {
    throw new JournalError('JOURNAL_INVALID', 'Journal frame is not valid UTF-8.');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new JournalError('JOURNAL_INVALID', 'Journal frame is not valid JSON.');
  }
};

const readFrame = (
  source: Buffer,
  offset: number,
  maximum: number,
):
  | { readonly status: 'ok'; readonly payload: Uint8Array; readonly nextOffset: number }
  | { readonly status: 'truncated' }
  | { readonly status: 'invalid' } => {
  if (source.byteLength - offset < 4) return { status: 'truncated' };
  const length = source.readUInt32LE(offset);
  if (length === 0 || length > maximum) return { status: 'invalid' };
  const payloadStart = offset + 4;
  const digestStart = payloadStart + length;
  const nextOffset = digestStart + DIGEST_LENGTH;
  if (nextOffset > source.byteLength) return { status: 'truncated' };
  const payload = source.subarray(payloadStart, digestStart);
  const digest = source.subarray(digestStart, nextOffset);
  if (!digest.equals(digestBytes(payload))) return { status: 'invalid' };
  return { status: 'ok', payload: Uint8Array.from(payload), nextOffset };
};

export const createJournalBytes = (
  header: JournalHeader,
  records: readonly JournalRecord[] = [],
): Uint8Array => {
  const parsedHeader = parseHeader(header);
  if (records.length > MAX_RECORDS) {
    throw new JournalError('JOURNAL_LIMIT_EXCEEDED', 'Journal has too many records.');
  }
  const parts: Buffer[] = [
    MAGIC,
    encodeFrame(Buffer.from(canonicalJson(parsedHeader), 'utf8'), MAX_HEADER_BYTES),
  ];
  records.forEach((record, index) => {
    const parsed = parseJournalRecord(record, index + 1);
    parts.push(encodeFrame(Buffer.from(canonicalJson(parsed), 'utf8'), MAX_RECORD_BYTES));
  });
  const result = Buffer.concat(parts);
  if (result.byteLength > MAX_JOURNAL_BYTES) {
    throw new JournalError('JOURNAL_LIMIT_EXCEEDED', 'Journal is too large.');
  }
  return result;
};

export const replayJournal = (input: Uint8Array): JournalReplayResult => {
  if (input.byteLength > MAX_JOURNAL_BYTES) {
    throw new JournalError('JOURNAL_LIMIT_EXCEEDED', 'Journal is too large.');
  }
  const source = Buffer.from(input);
  if (source.byteLength < MAGIC.byteLength || !source.subarray(0, MAGIC.byteLength).equals(MAGIC)) {
    throw new JournalError('JOURNAL_INVALID', 'Journal magic is invalid.');
  }
  const headerFrame = readFrame(source, MAGIC.byteLength, MAX_HEADER_BYTES);
  if (headerFrame.status !== 'ok') {
    throw new JournalError('JOURNAL_INVALID', 'Journal header frame is invalid.');
  }
  const header = parseHeader(parseJson(headerFrame.payload));
  const records: JournalRecord[] = [];
  let cursor = headerFrame.nextOffset;
  while (cursor < source.byteLength) {
    if (records.length >= MAX_RECORDS) {
      throw new JournalError('JOURNAL_LIMIT_EXCEEDED', 'Journal has too many records.');
    }
    const frame = readFrame(source, cursor, MAX_RECORD_BYTES);
    if (frame.status !== 'ok') {
      return {
        header,
        records,
        complete: false,
        validByteLength: cursor,
        stoppedReason: frame.status === 'truncated' ? 'truncated' : 'invalid-frame',
      };
    }
    try {
      records.push(parseJournalRecord(parseJson(frame.payload), records.length + 1));
    } catch {
      return {
        header,
        records,
        complete: false,
        validByteLength: cursor,
        stoppedReason: 'invalid-record',
      };
    }
    cursor = frame.nextOffset;
  }
  return { header, records, complete: true, validByteLength: cursor };
};

export const initializeJournalFile = async (
  target: string,
  header: JournalHeader,
): Promise<void> => {
  if (!path.isAbsolute(target))
    throw new JournalError('JOURNAL_INVALID', 'Journal path must be absolute.');
  const handle = await open(target, 'wx', 0o600);
  try {
    await handle.writeFile(createJournalBytes(header));
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export const appendJournalRecord = async (target: string, record: JournalRecord): Promise<void> => {
  const metadata = await stat(target);
  if (!metadata.isFile() || metadata.size > MAX_JOURNAL_BYTES) {
    throw new JournalError('JOURNAL_LIMIT_EXCEEDED', 'Journal file is outside limits.');
  }
  const current = replayJournal(await readFile(target));
  if (!current.complete || record.sequence !== current.records.length + 1) {
    throw new JournalError('JOURNAL_INVALID', 'Journal is incomplete or sequence is invalid.');
  }
  const parsed = parseJournalRecord(record, record.sequence);
  const frame = encodeFrame(Buffer.from(canonicalJson(parsed), 'utf8'), MAX_RECORD_BYTES);
  if (metadata.size + frame.byteLength > MAX_JOURNAL_BYTES) {
    throw new JournalError('JOURNAL_LIMIT_EXCEEDED', 'Journal is too large.');
  }
  const handle = await open(target, 'a', 0o600);
  try {
    await handle.writeFile(frame);
    await handle.sync();
  } finally {
    await handle.close();
  }
};
