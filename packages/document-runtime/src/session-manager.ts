import path from 'node:path';

import {
  applyTransaction,
  canonicalSerialize,
  createDefaultDeck,
  createRevisionToken,
  DocumentCommandError,
  parseDeck,
  validateDeck,
  type AssetRef,
  type DeckDocument,
  type DocumentCommand,
  type Element,
  type TransactionMetadata,
} from '@htmllelujah/document-core';
import {
  createHdeckArchive,
  createJournalRecord,
  HdeckError,
  parseHdeckArchive,
  PersistenceError,
  sha256,
  type ApprovedMediaType,
  type HdeckAssetInput,
  type JournalHeader,
  type JournalRecord,
  type ParsedHdeck,
} from '@htmllelujah/hdeck';

import { DocumentRuntimeError } from './errors.js';
import {
  defaultArchiveDurability,
  defaultJournalDurability,
  RuntimeRecoveryStore,
  type RecoveryMetadata,
} from './storage.js';
import type {
  AgentAuditEntry,
  ArchiveDurabilityCapability,
  CloseSessionOptions,
  CreateSessionInput,
  DocumentOutlineItem,
  DocumentRuntimeOptions,
  DocumentRuntimeService,
  DocumentSessionSnapshot,
  ExecuteRequest,
  HistoryRequest,
  JournalDurabilityCapability,
  OpenSessionInput,
  ProposalRequest,
  ProposalSummary,
  RecoveryCandidate,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeValidationResult,
  RuntimeAssetBytes,
  SafeDocumentDiff,
  SaveAsOptions,
  SessionDurability,
  StoreAssetRequest,
} from './types.js';

const MAX_COMMANDS_PER_TRANSACTION = 100;
const MIN_PROPOSAL_TTL_MS = 1_000;
const MAX_PROPOSAL_TTL_MS = 15 * 60_000;

interface InternalAsset {
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly mediaType: ApprovedMediaType;
  readonly fileName: string;
  readonly widthPx?: number | undefined;
  readonly heightPx?: number | undefined;
}

interface HistoryEntry {
  readonly before: DeckDocument;
  after: DeckDocument;
  readonly revisionBefore: string;
  revisionAfter: string;
  readonly metadata: TransactionMetadata[];
  readonly historyGroupId?: string | undefined;
}

interface InternalProposal {
  readonly summary: ProposalSummary;
  readonly commands: readonly DocumentCommand[];
  readonly metadata: TransactionMetadata;
  readonly expiresAtMs: number;
}

interface InternalAuditEntry extends AgentAuditEntry {
  undoneAt?: string | undefined;
}

interface SessionState {
  readonly sessionId: string;
  readonly documentId: string;
  document: DeckDocument;
  revision: string;
  savedRevision: string;
  persisted: boolean;
  durability: SessionDurability;
  targetPath?: string | undefined;
  targetFingerprint: string | null;
  assets: Map<string, InternalAsset>;
  journalSequence: number;
  undo: HistoryEntry[];
  redo: HistoryEntry[];
  proposals: Map<string, InternalProposal>;
  queue: Promise<void>;
  autosaveTimer?: ReturnType<typeof setTimeout> | undefined;
}

interface RuntimeRestoreCommand {
  readonly type: 'runtime.restore';
  readonly document: DeckDocument;
}

const asJournalCommands = (
  commands: readonly DocumentCommand[] | readonly RuntimeRestoreCommand[],
): readonly DocumentCommand[] => commands as unknown as readonly DocumentCommand[];

const isRestoreCommand = (command: unknown): command is RuntimeRestoreCommand =>
  typeof command === 'object' &&
  command !== null &&
  'type' in command &&
  (command as { readonly type?: unknown }).type === 'runtime.restore' &&
  'document' in command;

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
};

const immutableClone = <T>(value: T): T => deepFreeze(structuredClone(value));

const countElements = (elements: readonly Element[]): number =>
  elements.reduce(
    (total, element) =>
      total + 1 + (element.type === 'group' ? countElements(element.children) : 0),
    0,
  );

const totalElements = (document: DeckDocument): number =>
  document.masters.reduce((sum, master) => sum + countElements(master.elements), 0) +
  document.layouts.reduce((sum, layout) => sum + countElements(layout.elements), 0) +
  document.slides.reduce((sum, slide) => sum + countElements(slide.elements), 0);

const safeDiff = (
  before: DeckDocument,
  after: DeckDocument,
  commands: readonly DocumentCommand[],
): SafeDocumentDiff => ({
  commandCount: commands.length,
  commandTypes: commands.map((command) => command.type),
  slidesBefore: before.slides.length,
  slidesAfter: after.slides.length,
  elementsBefore: totalElements(before),
  elementsAfter: totalElements(after),
  assetsBefore: before.assets.length,
  assetsAfter: after.assets.length,
  changed: createRevisionToken(before) !== createRevisionToken(after),
});

const documentDigest = (document: DeckDocument): string =>
  sha256(Buffer.from(canonicalSerialize(document), 'utf8'));

const approvedMediaType = (value: string): value is ApprovedMediaType =>
  value === 'image/png' ||
  value === 'image/jpeg' ||
  value === 'image/webp' ||
  value === 'font/woff2';

const runtimeErrorFromPersistence = (error: unknown): DocumentRuntimeError => {
  if (error instanceof DocumentRuntimeError) return error;
  if (error instanceof PersistenceError && error.code === 'TARGET_CHANGED') {
    return new DocumentRuntimeError('TARGET_CHANGED', 'The save target changed externally.');
  }
  return new DocumentRuntimeError('SAVE_FAILED', 'The document could not be saved.', true);
};

const internalAssetsFromParsed = (parsed: ParsedHdeck): Map<string, InternalAsset> => {
  const result = new Map<string, InternalAsset>();
  for (const asset of parsed.document.assets) {
    const bytes = parsed.assets.get(asset.id);
    const manifest = parsed.manifest.assets.find((candidate) => candidate.id === asset.id);
    if (bytes === undefined || manifest === undefined || !approvedMediaType(manifest.mediaType)) {
      throw new DocumentRuntimeError('RECOVERY_INVALID', 'Archive asset data is incomplete.');
    }
    result.set(asset.id, {
      id: asset.id,
      bytes: Uint8Array.from(bytes),
      mediaType: manifest.mediaType,
      fileName: asset.fileName,
      ...(manifest.widthPx === undefined ? {} : { widthPx: manifest.widthPx }),
      ...(manifest.heightPx === undefined ? {} : { heightPx: manifest.heightPx }),
    });
  }
  return result;
};

export class DocumentSessionManager implements DocumentRuntimeService {
  readonly #sessions = new Map<string, SessionState>();
  readonly #listeners = new Set<RuntimeEventListener>();
  readonly #audit: InternalAuditEntry[] = [];
  readonly #recovery: RuntimeRecoveryStore;
  readonly #journal: JournalDurabilityCapability;
  readonly #archive: ArchiveDurabilityCapability;
  readonly #idFactory: () => string;
  readonly #now: () => string;
  readonly #autosaveDelayMs: number;
  readonly #maxHistoryEntries: number;
  readonly #defaultProposalTtlMs: number;

  public constructor(options: DocumentRuntimeOptions) {
    this.#recovery = new RuntimeRecoveryStore(options.recoveryDirectory);
    this.#journal = options.journal ?? defaultJournalDurability;
    this.#archive = options.archive ?? defaultArchiveDurability;
    this.#idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#autosaveDelayMs = options.autosaveDelayMs ?? 1_000;
    this.#maxHistoryEntries = options.maxHistoryEntries ?? 100;
    this.#defaultProposalTtlMs = options.defaultProposalTtlMs ?? 60_000;
    if (
      !Number.isSafeInteger(this.#autosaveDelayMs) ||
      this.#autosaveDelayMs < 0 ||
      !Number.isSafeInteger(this.#maxHistoryEntries) ||
      this.#maxHistoryEntries < 1 ||
      !Number.isSafeInteger(this.#defaultProposalTtlMs) ||
      this.#defaultProposalTtlMs < MIN_PROPOSAL_TTL_MS ||
      this.#defaultProposalTtlMs > MAX_PROPOSAL_TTL_MS
    ) {
      throw new DocumentRuntimeError('INVALID_REQUEST', 'Runtime limits are invalid.');
    }
  }

  public subscribe(listener: RuntimeEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: RuntimeEvent): void {
    const safe = immutableClone(event);
    for (const listener of this.#listeners) {
      try {
        listener(safe);
      } catch {
        // Observers cannot affect the document authority.
      }
    }
  }

  #requireSession(sessionId: string): SessionState {
    const state = this.#sessions.get(sessionId);
    if (state === undefined) {
      throw new DocumentRuntimeError('SESSION_NOT_FOUND', 'Document session does not exist.');
    }
    return state;
  }

  #dirty(state: SessionState): boolean {
    return !state.persisted || state.revision !== state.savedRevision;
  }

  #snapshot(state: SessionState): DocumentSessionSnapshot {
    return immutableClone({
      sessionId: state.sessionId,
      documentId: state.documentId,
      document: state.document,
      revision: state.revision,
      savedRevision: state.savedRevision,
      dirty: this.#dirty(state),
      durability: state.durability,
      canUndo: state.undo.length > 0,
      canRedo: state.redo.length > 0,
      hasSaveTarget: state.targetPath !== undefined,
    });
  }

  public getSnapshot(sessionId: string): DocumentSessionSnapshot {
    return this.#snapshot(this.#requireSession(sessionId));
  }

  public listSessions(): readonly DocumentSessionSnapshot[] {
    return [...this.#sessions.values()].map((state) => this.#snapshot(state));
  }

  /** Main-process only. Returns a defensive copy for an opaque asset protocol response. */
  public getAssetBytesMainOnly(sessionId: string, assetId: string): RuntimeAssetBytes {
    const state = this.#requireSession(sessionId);
    const asset = state.assets.get(assetId);
    if (asset === undefined) {
      throw new DocumentRuntimeError('ASSET_BYTES_MISSING', 'Document asset does not exist.');
    }
    const reference = state.document.assets.find((candidate) => candidate.id === assetId);
    if (reference === undefined) {
      throw new DocumentRuntimeError('ASSET_BYTES_MISSING', 'Document asset reference is missing.');
    }
    return immutableClone({
      id: asset.id,
      hash: reference.hash,
      bytes: Uint8Array.from(asset.bytes),
      mediaType: asset.mediaType,
      fileName: asset.fileName,
      ...(asset.widthPx === undefined ? {} : { widthPx: asset.widthPx }),
      ...(asset.heightPx === undefined ? {} : { heightPx: asset.heightPx }),
    });
  }

  #enqueue<T>(state: SessionState, operation: () => Promise<T>): Promise<T> {
    const result = state.queue.then(operation);
    state.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #assertMainOnlyPath(targetPath: string): void {
    if (
      !path.isAbsolute(targetPath) ||
      path.extname(targetPath).toLocaleLowerCase('en-US') !== '.hdeck'
    ) {
      throw new DocumentRuntimeError(
        'INVALID_REQUEST',
        'A validated absolute .hdeck path is required.',
      );
    }
  }

  async #archiveFor(
    document: DeckDocument,
    assets: ReadonlyMap<string, InternalAsset>,
  ): Promise<Uint8Array> {
    const inputs: HdeckAssetInput[] = [];
    for (const reference of document.assets) {
      let asset = assets.get(reference.id);
      if (asset === undefined) {
        const bytes = await this.#recovery.readBlob(reference.hash);
        if (bytes !== undefined && approvedMediaType(reference.mediaType)) {
          asset = {
            id: reference.id,
            bytes,
            mediaType: reference.mediaType,
            fileName: reference.fileName,
            ...(reference.widthPx === undefined ? {} : { widthPx: reference.widthPx }),
            ...(reference.heightPx === undefined ? {} : { heightPx: reference.heightPx }),
          };
        }
      }
      if (asset === undefined) {
        throw new DocumentRuntimeError(
          'ASSET_BYTES_MISSING',
          `Asset bytes are unavailable for asset ${reference.id}.`,
        );
      }
      inputs.push({
        id: asset.id,
        bytes: asset.bytes,
        mediaType: asset.mediaType,
        originalName: asset.fileName,
        ...(asset.widthPx === undefined ? {} : { widthPx: asset.widthPx }),
        ...(asset.heightPx === undefined ? {} : { heightPx: asset.heightPx }),
      });
    }
    return createHdeckArchive({
      document,
      assets: inputs,
      createdAt: document.metadata.createdAt,
      modifiedAt: document.metadata.modifiedAt,
    });
  }

  #recoveryMetadata(state: SessionState): RecoveryMetadata {
    return {
      version: 1,
      sessionId: state.sessionId,
      documentId: state.documentId,
      targetPath: state.targetPath ?? null,
      targetFingerprint: state.targetFingerprint,
      savedRevision: state.savedRevision,
      persisted: state.persisted,
    };
  }

  #journalHeader(state: SessionState, base: DeckDocument): JournalHeader {
    return {
      format: 'htmllelujah.journal',
      version: 1,
      documentId: state.documentId,
      baseDocumentSha256: documentDigest(base),
      sessionId: state.sessionId,
    };
  }

  async #initializeRecovery(state: SessionState, baseArchive: Uint8Array): Promise<void> {
    await this.#recovery.ensure();
    try {
      await this.#recovery.writeBase(state.sessionId, baseArchive);
      await this.#recovery.writeMetadata(this.#recoveryMetadata(state));
      await this.#journal.initialize(
        this.#recovery.paths(state.sessionId).journal,
        this.#journalHeader(state, state.document),
      );
    } catch (error) {
      await this.#recovery.removeSession(state.sessionId, this.#journal);
      throw new DocumentRuntimeError(
        'JOURNAL_FAILED',
        'The durable recovery journal could not be initialized.',
        true,
      );
    }
  }

  #newState(input: {
    readonly sessionId: string;
    readonly document: DeckDocument;
    readonly assets: Map<string, InternalAsset>;
    readonly persisted: boolean;
    readonly durability: SessionDurability;
    readonly targetPath?: string | undefined;
    readonly targetFingerprint: string | null;
    readonly savedRevision?: string | undefined;
    readonly journalSequence?: number | undefined;
  }): SessionState {
    const revision = createRevisionToken(input.document);
    return {
      sessionId: input.sessionId,
      documentId: input.document.id,
      document: structuredClone(input.document),
      revision,
      savedRevision: input.savedRevision ?? revision,
      persisted: input.persisted,
      durability: input.durability,
      ...(input.targetPath === undefined ? {} : { targetPath: input.targetPath }),
      targetFingerprint: input.targetFingerprint,
      assets: new Map(input.assets),
      journalSequence: input.journalSequence ?? 0,
      undo: [],
      redo: [],
      proposals: new Map(),
      queue: Promise.resolve(),
    };
  }

  /** Main-process-only creation boundary. Paths never enter public snapshots or events. */
  public async createMainOnly(input: CreateSessionInput = {}): Promise<DocumentSessionSnapshot> {
    const document = parseDeck(
      input.document ?? createDefaultDeck({ idFactory: this.#idFactory, now: this.#now }),
    );
    const sessionId = this.#idFactory();
    if (this.#sessions.has(sessionId)) {
      throw new DocumentRuntimeError(
        'SESSION_EXISTS',
        'Generated session identifier already exists.',
      );
    }
    if (input.targetPath !== undefined) {
      this.#assertMainOnlyPath(input.targetPath);
      if ((await this.#archive.fingerprint(input.targetPath)) !== null) {
        throw new DocumentRuntimeError(
          'TARGET_CHANGED',
          'The requested new target already exists.',
        );
      }
    }
    const archive = createHdeckArchive({
      document,
      assets: input.assets,
      createdAt: document.metadata.createdAt,
      modifiedAt: document.metadata.modifiedAt,
    });
    const parsed = parseHdeckArchive(archive);
    const assets = internalAssetsFromParsed(parsed);
    for (const asset of assets.values())
      await this.#recovery.putBlob(sha256(asset.bytes), asset.bytes);
    const state = this.#newState({
      sessionId,
      document: parsed.document,
      assets,
      persisted: false,
      durability: 'journaled',
      ...(input.targetPath === undefined ? {} : { targetPath: input.targetPath }),
      targetFingerprint: null,
    });
    await this.#initializeRecovery(state, archive);
    this.#sessions.set(sessionId, state);
    this.#emit({
      type: 'session-opened',
      sessionId,
      documentId: state.documentId,
      revision: state.revision,
      recovered: false,
    });
    return this.#snapshot(state);
  }

  /** Main-process-only open boundary. */
  public async openMainOnly(input: OpenSessionInput): Promise<DocumentSessionSnapshot> {
    this.#assertMainOnlyPath(input.targetPath);
    const opened = await this.#archive.open(input.targetPath).catch((error: unknown) => {
      throw runtimeErrorFromPersistence(error);
    });
    const sessionId = this.#idFactory();
    if (this.#sessions.has(sessionId)) {
      throw new DocumentRuntimeError(
        'SESSION_EXISTS',
        'Generated session identifier already exists.',
      );
    }
    const assets = internalAssetsFromParsed(opened.parsed);
    for (const asset of assets.values())
      await this.#recovery.putBlob(sha256(asset.bytes), asset.bytes);
    const state = this.#newState({
      sessionId,
      document: opened.parsed.document,
      assets,
      persisted: true,
      durability: 'clean',
      targetPath: input.targetPath,
      targetFingerprint: opened.fingerprint,
    });
    const base = await this.#archiveFor(state.document, state.assets);
    await this.#initializeRecovery(state, base);
    this.#sessions.set(sessionId, state);
    this.#emit({
      type: 'session-opened',
      sessionId,
      documentId: state.documentId,
      revision: state.revision,
      recovered: false,
    });
    return this.#snapshot(state);
  }

  async #assetAdditions(
    commands: readonly DocumentCommand[],
    staged: ReadonlyMap<string, InternalAsset> = new Map(),
  ): Promise<Map<string, InternalAsset>> {
    const additions = new Map(staged);
    for (const command of commands) {
      if (command.type !== 'asset.register' || additions.has(command.asset.id)) continue;
      const bytes = await this.#recovery.readBlob(command.asset.hash);
      if (bytes === undefined || !approvedMediaType(command.asset.mediaType)) {
        throw new DocumentRuntimeError(
          'ASSET_BYTES_MISSING',
          `Asset bytes are unavailable for asset ${command.asset.id}.`,
        );
      }
      additions.set(command.asset.id, {
        id: command.asset.id,
        bytes,
        mediaType: command.asset.mediaType,
        fileName: command.asset.fileName,
        ...(command.asset.widthPx === undefined ? {} : { widthPx: command.asset.widthPx }),
        ...(command.asset.heightPx === undefined ? {} : { heightPx: command.asset.heightPx }),
      });
    }
    return additions;
  }

  #recordHistory(
    state: SessionState,
    before: DeckDocument,
    after: DeckDocument,
    metadata: TransactionMetadata,
    historyGroupId: string | undefined,
  ): void {
    const latest = state.undo.at(-1);
    if (
      historyGroupId !== undefined &&
      latest?.historyGroupId === historyGroupId &&
      latest.revisionAfter === createRevisionToken(before)
    ) {
      latest.after = structuredClone(after);
      latest.revisionAfter = createRevisionToken(after);
      latest.metadata.push(metadata);
    } else {
      state.undo.push({
        before: structuredClone(before),
        after: structuredClone(after),
        revisionBefore: createRevisionToken(before),
        revisionAfter: createRevisionToken(after),
        metadata: [metadata],
        ...(historyGroupId === undefined ? {} : { historyGroupId }),
      });
      if (state.undo.length > this.#maxHistoryEntries) state.undo.shift();
    }
    state.redo.length = 0;
  }

  async #appendRecord(
    state: SessionState,
    previousRevision: string,
    revision: string,
    metadata: TransactionMetadata,
    commands: readonly DocumentCommand[],
  ): Promise<void> {
    const record = createJournalRecord({
      sequence: state.journalSequence + 1,
      previousRevision,
      revision,
      metadata,
      commands,
    });
    try {
      await this.#journal.append(this.#recovery.paths(state.sessionId).journal, record);
    } catch {
      this.#emit({
        type: 'durability-error',
        sessionId: state.sessionId,
        documentId: state.documentId,
        operation: 'journal',
      });
      throw new DocumentRuntimeError(
        'JOURNAL_FAILED',
        'The transaction was not acknowledged because its journal append failed.',
        true,
      );
    }
  }

  async #executeLocked(
    state: SessionState,
    request: ExecuteRequest,
    stagedAssets: ReadonlyMap<string, InternalAsset> = new Map(),
  ): Promise<DocumentSessionSnapshot> {
    if (request.commands.length === 0 || request.commands.length > MAX_COMMANDS_PER_TRANSACTION) {
      throw new DocumentRuntimeError(
        'INVALID_REQUEST',
        'Transaction command count is outside limits.',
      );
    }
    if (
      request.historyGroupId !== undefined &&
      (request.historyGroupId.trim().length === 0 || request.historyGroupId.length > 128)
    ) {
      throw new DocumentRuntimeError('INVALID_REQUEST', 'History group identifier is invalid.');
    }
    if (request.expectedRevision !== state.revision) {
      throw new DocumentRuntimeError('REVISION_CONFLICT', 'Expected revision does not match.');
    }
    const additions = await this.#assetAdditions(request.commands, stagedAssets);
    const before = state.document;
    let transaction;
    try {
      transaction = applyTransaction(before, request.commands, {
        expectedRevision: request.expectedRevision,
        metadata: request.metadata,
      });
    } catch (error) {
      if (error instanceof DocumentCommandError && error.code === 'REVISION_CONFLICT') {
        throw new DocumentRuntimeError('REVISION_CONFLICT', 'Expected revision does not match.');
      }
      throw error;
    }
    const nextAssets = new Map<string, InternalAsset>();
    for (const reference of transaction.document.assets) {
      const asset = additions.get(reference.id) ?? state.assets.get(reference.id);
      if (asset === undefined) {
        throw new DocumentRuntimeError('ASSET_BYTES_MISSING', 'Committed asset bytes disappeared.');
      }
      nextAssets.set(reference.id, asset);
    }
    await this.#appendRecord(
      state,
      transaction.previousRevision,
      transaction.revision,
      transaction.metadata,
      transaction.commands,
    );
    state.document = transaction.document;
    state.revision = transaction.revision;
    state.assets = nextAssets;
    state.journalSequence += 1;
    state.durability = 'journaled';
    this.#recordHistory(
      state,
      before,
      transaction.document,
      transaction.metadata,
      request.historyGroupId,
    );
    this.#emit({
      type: 'document-changed',
      sessionId: state.sessionId,
      documentId: state.documentId,
      revision: state.revision,
      dirty: this.#dirty(state),
      durability: state.durability,
      commandTypes: transaction.commands.map((command) => command.type),
    });
    this.#scheduleAutosave(state);
    return this.#snapshot(state);
  }

  public execute(sessionId: string, request: ExecuteRequest): Promise<DocumentSessionSnapshot> {
    const state = this.#requireSession(sessionId);
    return this.#enqueue(state, () => this.#executeLocked(state, request));
  }

  public async storeAsset(
    sessionId: string,
    request: StoreAssetRequest,
  ): Promise<DocumentSessionSnapshot> {
    const state = this.#requireSession(sessionId);
    const bytes = Uint8Array.from(request.bytes);
    const hash = sha256(bytes);
    await this.#recovery.putBlob(hash, bytes);
    const kind: AssetRef['kind'] = request.mediaType === 'font/woff2' ? 'font' : 'image';
    const asset: InternalAsset = {
      id: request.id,
      bytes,
      mediaType: request.mediaType,
      fileName: request.fileName,
      ...(request.widthPx === undefined ? {} : { widthPx: request.widthPx }),
      ...(request.heightPx === undefined ? {} : { heightPx: request.heightPx }),
    };
    return this.#enqueue(state, () =>
      this.#executeLocked(
        state,
        {
          expectedRevision: request.expectedRevision,
          metadata: request.metadata,
          commands: [
            {
              type: 'asset.register',
              asset: {
                id: request.id,
                kind,
                hash,
                mediaType: request.mediaType,
                fileName: request.fileName,
                byteLength: bytes.byteLength,
                ...(request.widthPx === undefined ? {} : { widthPx: request.widthPx }),
                ...(request.heightPx === undefined ? {} : { heightPx: request.heightPx }),
              },
            },
          ],
        },
        new Map([[request.id, asset]]),
      ),
    );
  }

  async #restoreLocked(
    state: SessionState,
    target: DeckDocument,
    expectedRevision: string,
    metadata: TransactionMetadata,
    eventType: 'history.undo' | 'history.redo',
  ): Promise<void> {
    if (state.revision !== expectedRevision) {
      throw new DocumentRuntimeError('REVISION_CONFLICT', 'Expected revision does not match.');
    }
    const parsed = parseDeck(target);
    const revision = createRevisionToken(parsed);
    const assets = await this.#assetsForRecoveredDocument(parsed, state.assets);
    await this.#appendRecord(
      state,
      state.revision,
      revision,
      metadata,
      asJournalCommands([{ type: 'runtime.restore', document: parsed }]),
    );
    state.document = structuredClone(parsed);
    state.revision = revision;
    state.assets = assets;
    state.journalSequence += 1;
    state.durability = 'journaled';
    this.#emit({
      type: 'document-changed',
      sessionId: state.sessionId,
      documentId: state.documentId,
      revision,
      dirty: this.#dirty(state),
      durability: state.durability,
      commandTypes: [eventType],
    });
    this.#scheduleAutosave(state);
  }

  async #undoLocked(
    state: SessionState,
    request: HistoryRequest,
  ): Promise<DocumentSessionSnapshot> {
    const entry = state.undo.at(-1);
    if (entry === undefined) {
      throw new DocumentRuntimeError('INVALID_REQUEST', 'There is no transaction to undo.');
    }
    await this.#restoreLocked(
      state,
      entry.before,
      request.expectedRevision,
      request.metadata,
      'history.undo',
    );
    state.undo.pop();
    state.redo.push(entry);
    return this.#snapshot(state);
  }

  public undo(sessionId: string, request: HistoryRequest): Promise<DocumentSessionSnapshot> {
    const state = this.#requireSession(sessionId);
    return this.#enqueue(state, () => this.#undoLocked(state, request));
  }

  async #redoLocked(
    state: SessionState,
    request: HistoryRequest,
  ): Promise<DocumentSessionSnapshot> {
    const entry = state.redo.at(-1);
    if (entry === undefined) {
      throw new DocumentRuntimeError('INVALID_REQUEST', 'There is no transaction to redo.');
    }
    await this.#restoreLocked(
      state,
      entry.after,
      request.expectedRevision,
      request.metadata,
      'history.redo',
    );
    state.redo.pop();
    state.undo.push(entry);
    return this.#snapshot(state);
  }

  public redo(sessionId: string, request: HistoryRequest): Promise<DocumentSessionSnapshot> {
    const state = this.#requireSession(sessionId);
    return this.#enqueue(state, () => this.#redoLocked(state, request));
  }

  #scheduleAutosave(state: SessionState): void {
    if (state.targetPath === undefined || this.#autosaveDelayMs === 0) return;
    if (state.autosaveTimer !== undefined) clearTimeout(state.autosaveTimer);
    state.autosaveTimer = setTimeout(() => {
      state.autosaveTimer = undefined;
      void this.save(state.sessionId).catch(() => undefined);
    }, this.#autosaveDelayMs);
  }

  async #saveLocked(
    state: SessionState,
    targetPath: string,
    options: {
      readonly expectedFingerprint: string | null | undefined;
      readonly allowOverwrite?: boolean;
      readonly attachTarget?: boolean;
    },
  ): Promise<DocumentSessionSnapshot> {
    const archive = await this.#archiveFor(state.document, state.assets);
    state.durability = 'saving';
    try {
      const result = await this.#archive.save(targetPath, archive, {
        expectedFingerprint: options.expectedFingerprint,
        ...(options.allowOverwrite === undefined ? {} : { allowOverwrite: options.allowOverwrite }),
      });
      if (options.attachTarget !== false) {
        state.targetPath = targetPath;
        state.targetFingerprint = result.fingerprint;
      }
      state.savedRevision = state.revision;
      state.persisted = true;
      state.durability = 'clean';
      try {
        await this.#recovery.writeBase(state.sessionId, archive);
        await this.#recovery.writeMetadata(this.#recoveryMetadata(state));
        await this.#recovery.resetJournal(
          state.sessionId,
          this.#journalHeader(state, state.document),
          this.#journal,
        );
        state.journalSequence = 0;
      } catch {
        if (options.attachTarget !== false) {
          state.targetPath = targetPath;
          state.targetFingerprint = result.fingerprint;
        }
        state.durability = 'save-error';
        this.#emit({
          type: 'durability-error',
          sessionId: state.sessionId,
          documentId: state.documentId,
          operation: 'recovery',
        });
        // The user file is committed, so retain its new identity even if recovery rotation failed.
        throw new DocumentRuntimeError(
          'JOURNAL_FAILED',
          'The file was saved but recovery state could not be rotated.',
          true,
        );
      }
      this.#emit({
        type: 'document-saved',
        sessionId: state.sessionId,
        documentId: state.documentId,
        revision: state.revision,
        dirty: false,
      });
      return this.#snapshot(state);
    } catch (error) {
      if (error instanceof DocumentRuntimeError && error.code === 'JOURNAL_FAILED') throw error;
      state.durability = 'save-error';
      this.#emit({
        type: 'durability-error',
        sessionId: state.sessionId,
        documentId: state.documentId,
        operation: 'save',
      });
      throw runtimeErrorFromPersistence(error);
    }
  }

  public save(sessionId: string): Promise<DocumentSessionSnapshot> {
    const state = this.#requireSession(sessionId);
    return this.#enqueue(state, async () => {
      if (state.autosaveTimer !== undefined) {
        clearTimeout(state.autosaveTimer);
        state.autosaveTimer = undefined;
      }
      if (state.targetPath === undefined) {
        throw new DocumentRuntimeError('NO_SAVE_TARGET', 'Document has no save target.');
      }
      if (!this.#dirty(state)) return this.#snapshot(state);
      return this.#saveLocked(state, state.targetPath, {
        expectedFingerprint: state.targetFingerprint,
      });
    });
  }

  /** Main-process-only save-as boundary. */
  public saveAsMainOnly(
    sessionId: string,
    options: SaveAsOptions,
  ): Promise<DocumentSessionSnapshot> {
    this.#assertMainOnlyPath(options.targetPath);
    const state = this.#requireSession(sessionId);
    return this.#enqueue(state, async () => {
      if (state.autosaveTimer !== undefined) {
        clearTimeout(state.autosaveTimer);
        state.autosaveTimer = undefined;
      }
      return this.#saveLocked(state, options.targetPath, {
        expectedFingerprint: options.expectedFingerprint,
        ...(options.allowOverwrite === undefined ? {} : { allowOverwrite: options.allowOverwrite }),
      });
    });
  }

  /**
   * Main-process collaboration boundary. Commits a durable shared-file snapshot without
   * attaching the target to this session, so the authoritative writer lease remains the
   * only path that can update the shared file and background autosave cannot bypass it.
   */
  public saveDetachedMainOnly(
    sessionId: string,
    options: SaveAsOptions,
  ): Promise<DocumentSessionSnapshot> {
    this.#assertMainOnlyPath(options.targetPath);
    const state = this.#requireSession(sessionId);
    return this.#enqueue(state, async () => {
      if (state.autosaveTimer !== undefined) {
        clearTimeout(state.autosaveTimer);
        state.autosaveTimer = undefined;
      }
      return this.#saveLocked(state, options.targetPath, {
        expectedFingerprint: options.expectedFingerprint,
        ...(options.allowOverwrite === undefined ? {} : { allowOverwrite: options.allowOverwrite }),
        attachTarget: false,
      });
    });
  }

  /**
   * Main-process collaboration fence. A snapshot reached the shared-file commit boundary but
   * writer-lease confirmation failed, so the in-memory/recovery copy must remain dirty and must
   * not retain a path that could be written in the background.
   */
  public markDetachedSaveUnconfirmedMainOnly(sessionId: string): Promise<DocumentSessionSnapshot> {
    const state = this.#requireSession(sessionId);
    return this.#enqueue(state, async () => {
      state.targetPath = undefined;
      state.targetFingerprint = null;
      state.persisted = false;
      state.durability = 'save-error';
      try {
        await this.#recovery.writeMetadata(this.#recoveryMetadata(state));
      } catch {
        this.#emit({
          type: 'durability-error',
          sessionId: state.sessionId,
          documentId: state.documentId,
          operation: 'recovery',
        });
        throw new DocumentRuntimeError(
          'JOURNAL_FAILED',
          'The uncertain shared-file save remains open but recovery metadata could not be fenced.',
          true,
        );
      }
      this.#emit({
        type: 'durability-error',
        sessionId: state.sessionId,
        documentId: state.documentId,
        operation: 'save',
      });
      return this.#snapshot(state);
    });
  }

  public flush(sessionId: string): Promise<DocumentSessionSnapshot> {
    const state = this.#requireSession(sessionId);
    return this.#enqueue(state, async () => {
      if (state.autosaveTimer !== undefined) {
        clearTimeout(state.autosaveTimer);
        state.autosaveTimer = undefined;
      }
      if (state.targetPath !== undefined && this.#dirty(state)) {
        return this.#saveLocked(state, state.targetPath, {
          expectedFingerprint: state.targetFingerprint,
        });
      }
      return this.#snapshot(state);
    });
  }

  public close(sessionId: string, options: CloseSessionOptions = {}): Promise<void> {
    const state = this.#requireSession(sessionId);
    return this.#enqueue(state, async () => {
      const dirty = this.#dirty(state);
      if (dirty && options.discardUnsaved !== true) {
        throw new DocumentRuntimeError(
          'DIRTY_DOCUMENT',
          'Dirty documents require save or explicit discard before close.',
        );
      }
      if (state.autosaveTimer !== undefined) clearTimeout(state.autosaveTimer);
      await this.#recovery.removeSession(state.sessionId, this.#journal);
      this.#sessions.delete(state.sessionId);
      this.#emit({
        type: 'session-closed',
        sessionId: state.sessionId,
        documentId: state.documentId,
        dirtyDiscarded: dirty,
      });
    });
  }

  public simulate(sessionId: string, request: ExecuteRequest): SafeDocumentDiff {
    const state = this.#requireSession(sessionId);
    if (request.expectedRevision !== state.revision) {
      throw new DocumentRuntimeError('REVISION_CONFLICT', 'Expected revision does not match.');
    }
    const transaction = applyTransaction(state.document, request.commands, {
      expectedRevision: request.expectedRevision,
      metadata: request.metadata,
    });
    return immutableClone(safeDiff(state.document, transaction.document, transaction.commands));
  }

  public propose(sessionId: string, request: ProposalRequest): ProposalSummary {
    const state = this.#requireSession(sessionId);
    if (request.metadata.origin !== 'agent') {
      throw new DocumentRuntimeError(
        'INVALID_REQUEST',
        'Only agent-origin transactions may be proposed.',
      );
    }
    const ttlMs = request.ttlMs ?? this.#defaultProposalTtlMs;
    if (
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < MIN_PROPOSAL_TTL_MS ||
      ttlMs > MAX_PROPOSAL_TTL_MS
    ) {
      throw new DocumentRuntimeError('INVALID_REQUEST', 'Proposal TTL is outside limits.');
    }
    const diff = this.simulate(sessionId, request);
    const proposalId = this.#idFactory();
    const expiresAtMs = Date.parse(this.#now()) + ttlMs;
    const summary: ProposalSummary = {
      proposalId,
      sessionId,
      documentId: state.documentId,
      baseRevision: state.revision,
      expiresAt: new Date(expiresAtMs).toISOString(),
      diff,
    };
    state.proposals.set(proposalId, {
      summary,
      commands: structuredClone(request.commands),
      metadata: structuredClone(request.metadata),
      expiresAtMs,
    });
    return immutableClone(summary);
  }

  public commitProposal(sessionId: string, proposalId: string): Promise<DocumentSessionSnapshot> {
    const state = this.#requireSession(sessionId);
    return this.#enqueue(state, async () => {
      const proposal = state.proposals.get(proposalId);
      if (proposal === undefined) {
        throw new DocumentRuntimeError('PROPOSAL_NOT_FOUND', 'Proposal does not exist.');
      }
      if (Date.parse(this.#now()) >= proposal.expiresAtMs) {
        state.proposals.delete(proposalId);
        throw new DocumentRuntimeError('PROPOSAL_EXPIRED', 'Proposal has expired.');
      }
      if (state.revision !== proposal.summary.baseRevision) {
        throw new DocumentRuntimeError('PROPOSAL_STALE', 'Proposal base revision is stale.');
      }
      const before = state.revision;
      const snapshot = await this.#executeLocked(state, {
        expectedRevision: before,
        commands: proposal.commands,
        metadata: proposal.metadata,
      });
      state.proposals.delete(proposalId);
      this.#audit.push({
        proposalId,
        sessionId,
        documentId: state.documentId,
        transactionId: proposal.metadata.transactionId,
        actorId: proposal.metadata.actorId,
        committedAt: this.#now(),
        revisionBefore: before,
        revisionAfter: snapshot.revision,
        commandTypes: proposal.commands.map((command) => command.type),
      });
      return snapshot;
    });
  }

  public getAgentAudit(sessionId?: string): readonly AgentAuditEntry[] {
    return immutableClone(
      this.#audit.filter((entry) => sessionId === undefined || entry.sessionId === sessionId),
    );
  }

  public undoAgentTransaction(
    sessionId: string,
    transactionId: string,
    request: HistoryRequest,
  ): Promise<DocumentSessionSnapshot> {
    const state = this.#requireSession(sessionId);
    return this.#enqueue(state, async () => {
      const audit = [...this.#audit]
        .reverse()
        .find(
          (entry) =>
            entry.sessionId === sessionId &&
            entry.transactionId === transactionId &&
            entry.undoneAt === undefined,
        );
      const latestHistory = state.undo.at(-1);
      if (
        audit === undefined ||
        latestHistory === undefined ||
        latestHistory.metadata.at(-1)?.transactionId !== transactionId
      ) {
        throw new DocumentRuntimeError(
          'AGENT_UNDO_CONFLICT',
          'Only the latest unaffected agent transaction may be undone.',
        );
      }
      const snapshot = await this.#undoLocked(state, request);
      audit.undoneAt = this.#now();
      return snapshot;
    });
  }

  async #assetsForRecoveredDocument(
    document: DeckDocument,
    existing: ReadonlyMap<string, InternalAsset>,
  ): Promise<Map<string, InternalAsset>> {
    const result = new Map<string, InternalAsset>();
    for (const reference of document.assets) {
      const available = existing.get(reference.id);
      if (available !== undefined && sha256(available.bytes) === reference.hash) {
        result.set(reference.id, available);
        continue;
      }
      const bytes = await this.#recovery.readBlob(reference.hash);
      if (bytes === undefined || !approvedMediaType(reference.mediaType)) {
        throw new DocumentRuntimeError(
          'ASSET_BYTES_MISSING',
          'Recovery asset bytes are unavailable.',
        );
      }
      result.set(reference.id, {
        id: reference.id,
        bytes,
        mediaType: reference.mediaType,
        fileName: reference.fileName,
        ...(reference.widthPx === undefined ? {} : { widthPx: reference.widthPx }),
        ...(reference.heightPx === undefined ? {} : { heightPx: reference.heightPx }),
      });
    }
    return result;
  }

  public async listRecoveryCandidatesMainOnly(): Promise<readonly RecoveryCandidate[]> {
    const candidates: RecoveryCandidate[] = [];
    for (const candidateId of await this.#recovery.listCandidateIds()) {
      if (this.#sessions.has(candidateId)) continue;
      try {
        const metadata = await this.#recovery.readMetadata(candidateId);
        const replay = await this.#journal.read(this.#recovery.paths(candidateId).journal);
        if (
          replay.header.sessionId !== candidateId ||
          replay.header.documentId !== metadata.documentId
        ) {
          continue;
        }
        candidates.push({
          candidateId,
          sessionId: candidateId,
          documentId: metadata.documentId,
          recordCount: replay.records.length,
          complete: replay.complete,
          ...(replay.stoppedReason === undefined ? {} : { stoppedReason: replay.stoppedReason }),
        });
      } catch {
        // Invalid recovery artifacts are never surfaced as actionable candidates.
      }
    }
    return immutableClone(candidates);
  }

  /** Main-process-only recovery boundary. Replays the longest checksummed prefix. */
  public async recoverMainOnly(candidateId: string): Promise<DocumentSessionSnapshot> {
    if (this.#sessions.has(candidateId)) {
      throw new DocumentRuntimeError('SESSION_EXISTS', 'Recovery session is already open.');
    }
    const metadata = await this.#recovery.readMetadata(candidateId);
    let parsed: ParsedHdeck;
    try {
      parsed = parseHdeckArchive(await this.#recovery.readBase(candidateId));
    } catch (error) {
      if (error instanceof HdeckError) {
        throw new DocumentRuntimeError('RECOVERY_INVALID', 'Recovery base archive is invalid.');
      }
      throw error;
    }
    const replay = await this.#journal.read(this.#recovery.paths(candidateId).journal);
    if (
      replay.header.sessionId !== candidateId ||
      replay.header.documentId !== metadata.documentId ||
      replay.header.baseDocumentSha256 !== documentDigest(parsed.document)
    ) {
      throw new DocumentRuntimeError(
        'RECOVERY_INVALID',
        'Recovery journal does not match its base.',
      );
    }
    if (!replay.complete) {
      await this.#journal.truncate(
        this.#recovery.paths(candidateId).journal,
        replay.validByteLength,
      );
    }
    let document = parsed.document;
    let revision = createRevisionToken(document);
    for (const record of replay.records) {
      if (record.previousRevision !== revision) {
        throw new DocumentRuntimeError('RECOVERY_INVALID', 'Recovery revision chain is broken.');
      }
      const only: unknown = record.commands.length === 1 ? record.commands[0] : undefined;
      if (isRestoreCommand(only)) {
        document = parseDeck(only.document);
        revision = createRevisionToken(document);
      } else {
        const transaction = applyTransaction(document, record.commands, {
          expectedRevision: record.previousRevision,
          metadata: record.metadata,
        });
        document = transaction.document;
        revision = transaction.revision;
      }
      if (revision !== record.revision) {
        throw new DocumentRuntimeError(
          'RECOVERY_INVALID',
          'Recovered revision does not match journal.',
        );
      }
    }
    let assets = internalAssetsFromParsed(parsed);
    assets = await this.#assetsForRecoveredDocument(document, assets);
    const state = this.#newState({
      sessionId: candidateId,
      document,
      assets,
      persisted: metadata.persisted,
      durability: 'recovered',
      ...(metadata.targetPath === null ? {} : { targetPath: metadata.targetPath }),
      targetFingerprint: metadata.targetFingerprint,
      savedRevision: metadata.savedRevision,
      journalSequence: replay.records.length,
    });
    this.#sessions.set(candidateId, state);
    this.#emit({
      type: 'session-opened',
      sessionId: candidateId,
      documentId: state.documentId,
      revision: state.revision,
      recovered: true,
    });
    return this.#snapshot(state);
  }

  public outline(sessionId: string): readonly DocumentOutlineItem[] {
    return immutableClone(
      this.#requireSession(sessionId).document.slides.map((slide) => ({
        slideId: slide.id,
        name: slide.name,
        hidden: slide.hidden,
        elementCount: countElements(slide.elements),
      })),
    );
  }

  public slide(sessionId: string, slideId: string) {
    const slide = this.#requireSession(sessionId).document.slides.find(
      (candidate) => candidate.id === slideId,
    );
    if (slide === undefined)
      throw new DocumentRuntimeError('INVALID_REQUEST', 'Slide does not exist.');
    return immutableClone(slide);
  }

  public styles(sessionId: string) {
    return immutableClone(this.#requireSession(sessionId).document.themes);
  }

  public validate(sessionId: string): RuntimeValidationResult {
    const result = validateDeck(this.#requireSession(sessionId).document);
    return immutableClone({
      valid: result.success,
      issues: result.success ? [] : result.issues,
    });
  }
}
