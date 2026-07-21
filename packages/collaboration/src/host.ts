import type {
  DeckDocument,
  DocumentCommand,
  DocumentSnapshot,
  Element,
  TransactionOptions,
  TransactionResult,
} from '@htmllelujah/document-core';
import { canonicalSerialize } from '@htmllelujah/document-core';

import { analyzeCommandAccess, elementEntityKey, slideEntityKey } from './access.js';
import {
  acquireTextLeaseRequestSchema,
  COLLABORATION_PROTOCOL_VERSION,
  commandBatchRequestSchema,
  committedTransactionSchema,
  DEFAULT_MAX_COMMAND_PAYLOAD_BYTES,
  DEFAULT_MAX_PRESENCE_PAYLOAD_BYTES,
  DEFAULT_PRESENCE_TTL_MS,
  DEFAULT_TEXT_LEASE_TTL_MS,
  presenceRecordSchema,
  presenceUpdateSchema,
  releaseTextLeaseRequestSchema,
  renewTextLeaseRequestSchema,
  resyncRequestSchema,
  snapshotResyncResponseSchema,
  tailResyncResponseSchema,
  textLeaseSchema,
  type AcquireTextLeaseRequest,
  type CommandAccess,
  type CommandBatchRequest,
  type CommittedTransaction,
  type PresenceRecord,
  type PresenceUpdate,
  type ReleaseTextLeaseRequest,
  type RenewTextLeaseRequest,
  type ResyncRequest,
  type ResyncResponse,
  type TextLease,
} from './contracts.js';
import { CollaborationError, measureJsonBytes } from './errors.js';

export interface CollaborationDocumentAdapter {
  getSnapshot(): DocumentSnapshot;
  transact(commands: readonly DocumentCommand[], options: TransactionOptions): TransactionResult;
}

/** Durable adapters acknowledge only after their asynchronous journal boundary completes. */
export interface DurableCollaborationDocumentAdapter {
  readonly durability: 'async';
  getSnapshot(): DocumentSnapshot;
  transact(
    commands: readonly DocumentCommand[],
    options: TransactionOptions,
  ): Promise<TransactionResult>;
}

export interface AuthoritativeSessionHostOptions {
  readonly sessionId?: string;
  readonly clock?: () => number;
  readonly idFactory?: () => string;
  readonly tailLimit?: number;
  readonly idempotencyLimit?: number;
  readonly maxIdempotencyBytes?: number;
  readonly maxCommandsPerBatch?: number;
  readonly maxCommandPayloadBytes?: number;
  readonly maxPresencePayloadBytes?: number;
  readonly maxTailResyncBytes?: number;
  readonly maxParticipants?: number;
  readonly textLeaseTtlMs?: number;
  readonly presenceTtlMs?: number;
}

interface IdempotencyEntry {
  readonly fingerprint: string;
  readonly transaction: CommittedTransaction;
  readonly accountedBytes: number;
}

interface PreparedSubmission {
  readonly request: CommandBatchRequest;
  readonly fingerprint: string;
  readonly idempotencyKey: string;
  readonly access: CommandAccess;
  readonly rebased: boolean;
  readonly beforeRevision: string;
  readonly transactionId: string;
  readonly idempotencyReservationBytes: number;
  readonly options: TransactionOptions;
}

const DEFAULT_TAIL_LIMIT = 256;
const DEFAULT_MAX_TAIL_RESYNC_BYTES = 24 * 1024 * 1024;
const DEFAULT_IDEMPOTENCY_LIMIT = 10_000;
const DEFAULT_MAX_IDEMPOTENCY_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_PARTICIPANTS = 32;

const isPositiveSafeInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

const clone = <T>(value: T): T => structuredClone(value);

const findElement = (elements: readonly Element[], elementId: string): Element | undefined => {
  for (const element of elements) {
    if (element.id === elementId) return element;
    if (element.type === 'group') {
      const nested = findElement(element.children, elementId);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
};

const findAncestorGroupIds = (
  elements: readonly Element[],
  elementId: string,
  ancestors: readonly string[] = [],
): readonly string[] | undefined => {
  for (const element of elements) {
    if (element.id === elementId) return ancestors;
    if (element.type === 'group') {
      const nested = findAncestorGroupIds(element.children, elementId, [...ancestors, element.id]);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
};

const findElementInSlide = (
  document: DeckDocument,
  slideId: string,
  elementId: string,
): Element | undefined => {
  const slide = document.slides.find((candidate) => candidate.id === slideId);
  return slide === undefined ? undefined : findElement(slide.elements, elementId);
};

const parseRequest = <T>(
  schema: { parse(value: unknown): T },
  raw: unknown,
  maxBytes: number,
): T => {
  const payloadBytes = measureJsonBytes(raw);
  if (payloadBytes > maxBytes) {
    throw new CollaborationError(
      'PAYLOAD_TOO_LARGE',
      `Payload is ${payloadBytes} bytes; maximum is ${maxBytes}.`,
      { payloadBytes, maxBytes },
    );
  }

  try {
    return schema.parse(raw);
  } catch (error) {
    throw new CollaborationError('INVALID_REQUEST', 'Request schema validation failed.', {
      cause: error instanceof Error ? error.message : 'Unknown validation error',
    });
  }
};

export class AuthoritativeSessionHost {
  public readonly sessionId: string;
  public readonly documentId: string;

  private readonly adapter: CollaborationDocumentAdapter | DurableCollaborationDocumentAdapter;
  private readonly clock: () => number;
  private readonly idFactory: () => string;
  private readonly tailLimit: number;
  private readonly idempotencyLimit: number;
  private readonly maxIdempotencyBytes: number;
  private readonly maxCommandsPerBatch: number;
  private readonly maxCommandPayloadBytes: number;
  private readonly maxPresencePayloadBytes: number;
  private readonly maxTailResyncBytes: number;
  private readonly maxParticipants: number;
  private readonly textLeaseTtlMs: number;
  private readonly presenceTtlMs: number;
  private readonly tail: CommittedTransaction[] = [];
  private readonly idempotency = new Map<string, IdempotencyEntry>();
  private idempotencyBytes = 0;
  private readonly lastModifiedSeq = new Map<string, number>();
  private readonly textLeases = new Map<string, TextLease>();
  private readonly presence = new Map<string, PresenceRecord>();
  private sessionSequence = 0;
  private currentRevision: string;
  private readonly initialRevision: string;
  private submissionQueue: Promise<void> = Promise.resolve();

  public constructor(
    adapter: CollaborationDocumentAdapter | DurableCollaborationDocumentAdapter,
    options: AuthoritativeSessionHostOptions = {},
  ) {
    this.adapter = adapter;
    this.clock = options.clock ?? (() => Date.now());
    this.idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
    this.sessionId = options.sessionId ?? this.idFactory();
    this.tailLimit = options.tailLimit ?? DEFAULT_TAIL_LIMIT;
    this.idempotencyLimit =
      options.idempotencyLimit === undefined ? DEFAULT_IDEMPOTENCY_LIMIT : options.idempotencyLimit;
    this.maxIdempotencyBytes = options.maxIdempotencyBytes ?? DEFAULT_MAX_IDEMPOTENCY_BYTES;
    this.maxCommandsPerBatch = options.maxCommandsPerBatch ?? 100;
    this.maxCommandPayloadBytes =
      options.maxCommandPayloadBytes ?? DEFAULT_MAX_COMMAND_PAYLOAD_BYTES;
    this.maxPresencePayloadBytes =
      options.maxPresencePayloadBytes ?? DEFAULT_MAX_PRESENCE_PAYLOAD_BYTES;
    this.maxTailResyncBytes = options.maxTailResyncBytes ?? DEFAULT_MAX_TAIL_RESYNC_BYTES;
    this.maxParticipants = options.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS;
    this.textLeaseTtlMs = options.textLeaseTtlMs ?? DEFAULT_TEXT_LEASE_TTL_MS;
    this.presenceTtlMs = options.presenceTtlMs ?? DEFAULT_PRESENCE_TTL_MS;

    if (
      ![
        this.tailLimit,
        this.idempotencyLimit,
        this.maxIdempotencyBytes,
        this.maxCommandsPerBatch,
        this.maxCommandPayloadBytes,
        this.maxPresencePayloadBytes,
        this.maxTailResyncBytes,
        this.maxParticipants,
        this.textLeaseTtlMs,
        this.presenceTtlMs,
      ].every(isPositiveSafeInteger)
    ) {
      throw new CollaborationError(
        'INVALID_REQUEST',
        'Host limits must be positive safe integers.',
      );
    }

    const snapshot = this.adapter.getSnapshot();
    this.documentId = snapshot.document.id;
    this.currentRevision = snapshot.revision;
    this.initialRevision = snapshot.revision;
  }

  public get sessionSeq(): number {
    return this.sessionSequence;
  }

  public get revision(): string {
    return this.currentRevision;
  }

  public getSnapshot(): DocumentSnapshot {
    this.assertAdapterRevision();
    return clone(this.adapter.getSnapshot());
  }

  public submit(rawRequest: unknown): CommittedTransaction {
    if ('durability' in this.adapter && this.adapter.durability === 'async') {
      throw new CollaborationError(
        'INVALID_REQUEST',
        'A durable collaboration adapter must be submitted through submitAsync().',
      );
    }
    const prepared = this.prepareSubmission(rawRequest);
    if (!('request' in prepared)) return prepared;
    const result = (this.adapter as CollaborationDocumentAdapter).transact(
      prepared.request.commands,
      prepared.options,
    );
    return this.finalizeSubmission(prepared, result);
  }

  /** Serializes durable submissions and broadcasts only after journal acknowledgement. */
  public submitAsync(rawRequest: unknown): Promise<CommittedTransaction> {
    const operation = this.submissionQueue.then(async () => {
      const prepared = this.prepareSubmission(rawRequest);
      if (!('request' in prepared)) return prepared;
      const result = await this.adapter.transact(prepared.request.commands, prepared.options);
      return this.finalizeSubmission(prepared, result);
    });
    this.submissionQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private prepareSubmission(rawRequest: unknown): PreparedSubmission | CommittedTransaction {
    const request = parseRequest(
      commandBatchRequestSchema,
      rawRequest,
      this.maxCommandPayloadBytes,
    );
    this.assertIdentity(request);

    if (request.commands.length > this.maxCommandsPerBatch) {
      throw new CollaborationError(
        'INVALID_REQUEST',
        `A command batch may contain at most ${this.maxCommandsPerBatch} commands.`,
      );
    }

    const fingerprint = canonicalSerialize(request);
    const idempotencyKey = `${request.clientId}\0${request.clientRequestId}`;
    const previous = this.idempotency.get(idempotencyKey);
    if (previous !== undefined) {
      if (previous.fingerprint !== fingerprint) {
        throw new CollaborationError(
          'IDEMPOTENCY_KEY_REUSE',
          'The client request identifier was reused for a different payload.',
        );
      }
      return clone(previous.transaction);
    }

    this.assertAdapterRevision();
    if (request.baseSeq > this.sessionSequence) {
      throw new CollaborationError(
        'FUTURE_BASE',
        'The request refers to a future session sequence.',
        {
          baseSeq: request.baseSeq,
          currentSeq: this.sessionSequence,
        },
      );
    }

    const access = analyzeCommandAccess(request.commands, this.adapter.getSnapshot().document);
    const rebased = this.assertCanApply(request, access);
    this.assertLeaseAccess(request, access);

    const beforeRevision = this.currentRevision;
    const timestampMs = this.clock();
    const transactionId = this.idFactory();
    const options: TransactionOptions = {
      expectedRevision: beforeRevision,
      metadata: {
        transactionId,
        actorId: request.clientId,
        origin: request.metadata.origin,
        label: request.metadata.label,
        timestamp: new Date(timestampMs).toISOString(),
      },
    };
    const idempotencyReservationBytes =
      new TextEncoder().encode(fingerprint).byteLength +
      measureJsonBytes({
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        sessionId: this.sessionId,
        documentId: this.documentId,
        sessionSeq: this.sessionSequence + 1,
        transactionId,
        clientId: request.clientId,
        clientRequestId: request.clientRequestId,
        beforeRevision,
        afterRevision: 'x'.repeat(160),
        ...(rebased ? { rebasedFromRevision: request.baseRevision } : {}),
        commands: request.commands,
        metadata: options.metadata,
        access,
      });
    if (idempotencyReservationBytes > this.maxIdempotencyBytes) {
      throw new CollaborationError(
        'IDEMPOTENCY_CAPACITY',
        'The committed request is too large for the bounded idempotency window.',
        { idempotencyReservationBytes, maxIdempotencyBytes: this.maxIdempotencyBytes },
      );
    }
    return {
      request,
      fingerprint,
      idempotencyKey,
      access,
      rebased,
      beforeRevision,
      transactionId,
      idempotencyReservationBytes,
      options,
    };
  }

  private finalizeSubmission(
    prepared: PreparedSubmission,
    result: TransactionResult,
  ): CommittedTransaction {
    const {
      request,
      fingerprint,
      idempotencyKey,
      access,
      rebased,
      beforeRevision,
      transactionId,
      idempotencyReservationBytes,
    } = prepared;
    const nextSeq = this.sessionSequence + 1;
    const transaction = committedTransactionSchema.parse({
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      documentId: this.documentId,
      sessionSeq: nextSeq,
      transactionId,
      clientId: request.clientId,
      clientRequestId: request.clientRequestId,
      beforeRevision,
      afterRevision: result.revision,
      ...(rebased ? { rebasedFromRevision: request.baseRevision } : {}),
      commands: result.commands,
      metadata: result.metadata,
      access,
    });

    this.sessionSequence = nextSeq;
    this.currentRevision = result.revision;
    access.writeSet.forEach((key) => this.lastModifiedSeq.set(key, nextSeq));
    this.tail.push(transaction);
    if (this.tail.length > this.tailLimit) this.tail.shift();
    this.pruneHistoricalWriteKeys();
    this.rememberIdempotentResult(idempotencyKey, {
      fingerprint,
      transaction,
      accountedBytes: idempotencyReservationBytes,
    });
    this.removeInvalidTextLeases(result.document);

    return clone(transaction);
  }

  private rememberIdempotentResult(key: string, entry: IdempotencyEntry): void {
    const replaced = this.idempotency.get(key);
    if (replaced !== undefined) this.idempotencyBytes -= replaced.accountedBytes;
    this.idempotency.set(key, entry);
    this.idempotencyBytes += entry.accountedBytes;

    // Map iteration follows insertion order. Keeping retries at their original position gives us
    // a deterministic window of the most recently committed requests and prevents an old retry
    // from pinning itself indefinitely. Eviction happens only after a successful transaction.
    while (
      this.idempotency.size > this.idempotencyLimit ||
      this.idempotencyBytes > this.maxIdempotencyBytes
    ) {
      const oldest = this.idempotency.keys().next();
      if (oldest.done) return;
      const evicted = this.idempotency.get(oldest.value);
      this.idempotency.delete(oldest.value);
      if (evicted !== undefined) this.idempotencyBytes -= evicted.accountedBytes;
    }
  }

  private get minimumAcceptedBaseSeq(): number {
    return (this.tail[0]?.sessionSeq ?? this.sessionSequence + 1) - 1;
  }

  private pruneHistoricalWriteKeys(): void {
    const minimumAcceptedBaseSeq = this.minimumAcceptedBaseSeq;
    this.lastModifiedSeq.forEach((lastSeq, key) => {
      if (lastSeq <= minimumAcceptedBaseSeq) this.lastModifiedSeq.delete(key);
    });
  }

  public getResync(rawRequest: unknown): ResyncResponse {
    const request = parseRequest(resyncRequestSchema, rawRequest, 16 * 1024);
    this.assertIdentity(request);
    this.assertAdapterRevision();

    if (request.afterSeq > this.sessionSequence) {
      throw new CollaborationError(
        'RESYNC_RANGE',
        'The requested sequence is newer than the host sequence.',
        { afterSeq: request.afterSeq, currentSeq: this.sessionSequence },
      );
    }

    if (request.afterSeq === this.sessionSequence) {
      if (request.knownRevision !== undefined && request.knownRevision !== this.currentRevision) {
        return this.createSnapshotResync();
      }
      return tailResyncResponseSchema.parse({
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        kind: 'tail',
        sessionId: this.sessionId,
        documentId: this.documentId,
        fromSeq: request.afterSeq,
        toSeq: this.sessionSequence,
        revision: this.currentRevision,
        transactions: [],
      });
    }

    const firstRetainedSeq = this.tail[0]?.sessionSeq ?? this.sessionSequence + 1;
    if (request.afterSeq < firstRetainedSeq - 1) return this.createSnapshotResync();

    const transactions = this.tail.filter(
      (transaction) => transaction.sessionSeq > request.afterSeq,
    );
    const expectedBaseRevision =
      transactions[0]?.beforeRevision ??
      (request.afterSeq === 0 ? this.initialRevision : this.currentRevision);
    if (request.knownRevision !== undefined && request.knownRevision !== expectedBaseRevision) {
      return this.createSnapshotResync();
    }

    const response = tailResyncResponseSchema.parse({
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      kind: 'tail',
      sessionId: this.sessionId,
      documentId: this.documentId,
      fromSeq: request.afterSeq,
      toSeq: this.sessionSequence,
      revision: this.currentRevision,
      transactions,
    });
    return measureJsonBytes(response) > this.maxTailResyncBytes
      ? this.createSnapshotResync()
      : response;
  }

  public acquireTextLease(rawRequest: unknown): TextLease {
    const request = parseRequest(
      acquireTextLeaseRequestSchema,
      rawRequest,
      this.maxPresencePayloadBytes,
    );
    this.assertIdentity(request);
    this.purgeExpiredTextLeases();
    this.assertTextElement(request);

    const now = this.clock();
    const existing = this.textLeases.get(request.elementId);
    if (existing !== undefined && existing.clientId !== request.clientId) {
      throw new CollaborationError('TEXT_LEASE_HELD', 'The text element is being edited.', {
        elementId: request.elementId,
        ownerClientId: existing.clientId,
        expiresAtMs: existing.expiresAtMs,
      });
    }

    const lease = textLeaseSchema.parse({
      ...request,
      token: existing?.token ?? this.idFactory(),
      acquiredAtMs: existing?.acquiredAtMs ?? now,
      expiresAtMs: now + this.textLeaseTtlMs,
    });
    this.textLeases.set(request.elementId, lease);
    return clone(lease);
  }

  public renewTextLease(rawRequest: unknown): TextLease {
    const request = parseRequest(
      renewTextLeaseRequestSchema,
      rawRequest,
      this.maxPresencePayloadBytes,
    );
    this.assertIdentity(request);
    this.purgeExpiredTextLeases();
    const existing = this.requireMatchingLease(request);
    const renewed = textLeaseSchema.parse({
      ...existing,
      expiresAtMs: this.clock() + this.textLeaseTtlMs,
    });
    this.textLeases.set(request.elementId, renewed);
    return clone(renewed);
  }

  public releaseTextLease(rawRequest: unknown): boolean {
    const request = parseRequest(
      releaseTextLeaseRequestSchema,
      rawRequest,
      this.maxPresencePayloadBytes,
    );
    this.assertIdentity(request);
    this.purgeExpiredTextLeases();
    const existing = this.textLeases.get(request.elementId);
    if (existing === undefined) return false;
    this.requireMatchingLease(request);
    return this.textLeases.delete(request.elementId);
  }

  public listTextLeases(): readonly TextLease[] {
    this.purgeExpiredTextLeases();
    return [...this.textLeases.values()]
      .sort((left, right) => left.elementId.localeCompare(right.elementId))
      .map(clone);
  }

  /** Releases every soft text lease owned by a participant that left the session. */
  public releaseTextLeasesForClient(clientId: string): number {
    let released = 0;
    this.textLeases.forEach((lease, elementId) => {
      if (lease.clientId !== clientId) return;
      this.textLeases.delete(elementId);
      released += 1;
    });
    return released;
  }

  public updatePresence(rawUpdate: unknown): PresenceRecord {
    const update = parseRequest(presenceUpdateSchema, rawUpdate, this.maxPresencePayloadBytes);
    this.assertIdentity(update);
    this.purgeExpiredPresence();
    const existing = this.presence.get(update.clientId);
    if (existing !== undefined && update.sequence <= existing.sequence) return clone(existing);
    if (existing === undefined && this.presence.size >= this.maxParticipants) {
      throw new CollaborationError(
        'PRESENCE_CAPACITY',
        'The session reached its participant presence limit.',
      );
    }

    const now = this.clock();
    const record = presenceRecordSchema.parse({
      ...update,
      receivedAtMs: now,
      expiresAtMs: now + this.presenceTtlMs,
    });
    this.presence.set(update.clientId, record);
    return clone(record);
  }

  public listPresence(): readonly PresenceRecord[] {
    this.purgeExpiredPresence();
    return [...this.presence.values()]
      .sort((left, right) => left.clientId.localeCompare(right.clientId))
      .map(clone);
  }

  public removePresence(clientId: string): boolean {
    return this.presence.delete(clientId);
  }

  private assertIdentity(request: {
    readonly sessionId: string;
    readonly documentId: string;
  }): void {
    if (request.sessionId !== this.sessionId) {
      throw new CollaborationError('SESSION_MISMATCH', 'The request targets another session.');
    }
    if (request.documentId !== this.documentId) {
      throw new CollaborationError('DOCUMENT_MISMATCH', 'The request targets another document.');
    }
  }

  private assertAdapterRevision(): void {
    const actual = this.adapter.getSnapshot().revision;
    if (actual !== this.currentRevision) {
      throw new CollaborationError(
        'REVISION_CONFLICT',
        'The document adapter changed outside the authoritative session host.',
        { expectedRevision: this.currentRevision, actualRevision: actual },
      );
    }
  }

  private assertCanApply(request: CommandBatchRequest, access: CommandAccess): boolean {
    if (request.baseSeq === this.sessionSequence) {
      if (request.baseRevision !== this.currentRevision) {
        throw new CollaborationError(
          'REVISION_CONFLICT',
          'The request revision does not match its current session sequence.',
          { currentRevision: this.currentRevision, currentSeq: this.sessionSequence },
        );
      }
      return false;
    }

    const minimumBaseSeq = this.minimumAcceptedBaseSeq;
    if (request.baseSeq < minimumBaseSeq) {
      throw new CollaborationError(
        'REVISION_CONFLICT',
        'The request base sequence predates the retained conflict history.',
        {
          baseSeq: request.baseSeq,
          minimumBaseSeq,
          currentSeq: this.sessionSequence,
          currentRevision: this.currentRevision,
        },
      );
    }

    const touchedKeys = new Set([...access.readSet, ...access.writeSet]);
    const conflicts = [...touchedKeys]
      .filter((key) => (this.lastModifiedSeq.get(key) ?? 0) > request.baseSeq)
      .sort();
    if (conflicts.length > 0) {
      throw new CollaborationError(
        'REVISION_CONFLICT',
        'The stale command batch overlaps entities changed since its base sequence.',
        {
          baseSeq: request.baseSeq,
          currentSeq: this.sessionSequence,
          currentRevision: this.currentRevision,
          conflictKeys: conflicts,
        },
      );
    }
    return true;
  }

  private assertLeaseAccess(request: CommandBatchRequest, access: CommandAccess): void {
    this.purgeExpiredTextLeases();
    const document = this.adapter.getSnapshot().document;
    this.textLeases.forEach((lease) => {
      const slide = document.slides.find((candidate) => candidate.id === lease.slideId);
      const ancestorIds =
        slide === undefined ? [] : (findAncestorGroupIds(slide.elements, lease.elementId) ?? []);
      const protectedKeys = [
        slideEntityKey(lease.slideId),
        elementEntityKey(lease.elementId),
        ...ancestorIds.map(elementEntityKey),
      ];
      if (!protectedKeys.some((key) => access.writeSet.includes(key))) return;
      if (lease.clientId !== request.clientId) {
        throw new CollaborationError('TEXT_LEASE_HELD', 'The text element is being edited.', {
          elementId: lease.elementId,
          ownerClientId: lease.clientId,
          expiresAtMs: lease.expiresAtMs,
        });
      }
      const suppliedToken = request.lockTokens?.[lease.elementId];
      if (suppliedToken === undefined) {
        throw new CollaborationError(
          'LOCK_TOKEN_REQUIRED',
          'The command batch must include the active text lease token.',
          { elementId: lease.elementId },
        );
      }
      if (suppliedToken !== lease.token) {
        throw new CollaborationError('INVALID_LOCK_TOKEN', 'The text lease token is invalid.', {
          elementId: lease.elementId,
        });
      }
    });
  }

  private assertTextElement(request: AcquireTextLeaseRequest): void {
    const element = findElementInSlide(
      this.adapter.getSnapshot().document,
      request.slideId,
      request.elementId,
    );
    if (element === undefined) {
      throw new CollaborationError('NOT_FOUND', 'The requested text element does not exist.');
    }
    if (element.type !== 'text') {
      throw new CollaborationError(
        'NOT_TEXT_ELEMENT',
        'Only text elements may receive a text lease.',
      );
    }
  }

  private requireMatchingLease(
    request: RenewTextLeaseRequest | ReleaseTextLeaseRequest,
  ): TextLease {
    const existing = this.textLeases.get(request.elementId);
    if (
      existing === undefined ||
      existing.clientId !== request.clientId ||
      existing.slideId !== request.slideId ||
      existing.token !== request.token
    ) {
      throw new CollaborationError('INVALID_LOCK_TOKEN', 'The text lease token is invalid.');
    }
    return existing;
  }

  private purgeExpiredTextLeases(): void {
    const now = this.clock();
    this.textLeases.forEach((lease, elementId) => {
      if (lease.expiresAtMs <= now) this.textLeases.delete(elementId);
    });
  }

  private removeInvalidTextLeases(document: DeckDocument): void {
    this.textLeases.forEach((lease, elementId) => {
      const element = findElementInSlide(document, lease.slideId, lease.elementId);
      if (element?.type !== 'text') this.textLeases.delete(elementId);
    });
  }

  private purgeExpiredPresence(): void {
    const now = this.clock();
    this.presence.forEach((record, clientId) => {
      if (record.expiresAtMs <= now) this.presence.delete(clientId);
    });
  }

  private createSnapshotResync(): ResyncResponse {
    return snapshotResyncResponseSchema.parse({
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      kind: 'snapshot',
      sessionId: this.sessionId,
      documentId: this.documentId,
      sessionSeq: this.sessionSequence,
      snapshot: this.adapter.getSnapshot(),
    });
  }
}
