import type {
  DeckDocument,
  DocumentCommand,
  Slide,
  Theme,
  TransactionMetadata,
  ValidationIssue,
} from '@htmllelujah/document-core';
import type {
  AtomicSaveOptions,
  AtomicSaveResult,
  HdeckAssetInput,
  JournalHeader,
  JournalRecord,
  JournalReplayResult,
  ParsedHdeck,
} from '@htmllelujah/hdeck';

export type SessionDurability = 'clean' | 'journaled' | 'saving' | 'save-error' | 'recovered';

export interface DocumentSessionSnapshot {
  readonly sessionId: string;
  readonly documentId: string;
  readonly document: DeckDocument;
  readonly revision: string;
  readonly savedRevision: string;
  readonly dirty: boolean;
  readonly durability: SessionDurability;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly hasSaveTarget: boolean;
}

export interface CreateSessionInput {
  readonly document?: DeckDocument | undefined;
  readonly assets?: readonly HdeckAssetInput[] | undefined;
  /** Main-process only. A future save target; it must not exist yet. */
  readonly targetPath?: string | undefined;
}

export interface OpenSessionInput {
  /** Main-process only. Never appears in snapshots or events. */
  readonly targetPath: string;
}

export interface ExecuteRequest {
  readonly expectedRevision: string;
  readonly commands: readonly DocumentCommand[];
  readonly metadata: TransactionMetadata;
  readonly historyGroupId?: string | undefined;
}

export interface HistoryRequest {
  readonly expectedRevision: string;
  readonly metadata: TransactionMetadata;
}

export interface CloseSessionOptions {
  readonly discardUnsaved?: boolean | undefined;
}

export interface SaveAsOptions {
  /** Main-process only. */
  readonly targetPath: string;
  readonly expectedFingerprint?: string | null | undefined;
  readonly allowOverwrite?: boolean | undefined;
}

export interface AssetBytesInput {
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly mediaType: HdeckAssetInput['mediaType'];
  readonly fileName: string;
  readonly widthPx?: number | undefined;
  readonly heightPx?: number | undefined;
}

export interface StoreAssetRequest extends AssetBytesInput {
  readonly expectedRevision: string;
  readonly metadata: TransactionMetadata;
}

export interface RecoveryCandidate {
  readonly candidateId: string;
  readonly sessionId: string;
  readonly documentId: string;
  readonly recordCount: number;
  readonly complete: boolean;
  readonly stoppedReason?: JournalReplayResult['stoppedReason'];
}

export interface ProposalRequest {
  readonly expectedRevision: string;
  readonly commands: readonly DocumentCommand[];
  readonly metadata: TransactionMetadata;
  readonly ttlMs?: number | undefined;
}

export interface SafeDocumentDiff {
  readonly commandCount: number;
  readonly commandTypes: readonly string[];
  readonly slidesBefore: number;
  readonly slidesAfter: number;
  readonly elementsBefore: number;
  readonly elementsAfter: number;
  readonly assetsBefore: number;
  readonly assetsAfter: number;
  readonly changed: boolean;
}

export interface ProposalSummary {
  readonly proposalId: string;
  readonly sessionId: string;
  readonly documentId: string;
  readonly baseRevision: string;
  readonly expiresAt: string;
  readonly diff: SafeDocumentDiff;
}

export interface AgentAuditEntry {
  readonly proposalId: string;
  readonly sessionId: string;
  readonly documentId: string;
  readonly transactionId: string;
  readonly actorId: string;
  readonly committedAt: string;
  readonly revisionBefore: string;
  readonly revisionAfter: string;
  readonly commandTypes: readonly string[];
  readonly undoneAt?: string | undefined;
}

export interface DocumentOutlineItem {
  readonly slideId: string;
  readonly name: string;
  readonly hidden: boolean;
  readonly elementCount: number;
}

export interface RuntimeValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
}

export interface DocumentRuntimeService {
  outline(sessionId: string): readonly DocumentOutlineItem[];
  slide(sessionId: string, slideId: string): Slide;
  styles(sessionId: string): readonly Theme[];
  validate(sessionId: string): RuntimeValidationResult;
}

export interface JournalDurabilityCapability {
  initialize(target: string, header: JournalHeader): Promise<void>;
  append(target: string, record: JournalRecord): Promise<void>;
  read(target: string): Promise<JournalReplayResult>;
  truncate(target: string, byteLength: number): Promise<void>;
  remove(target: string): Promise<void>;
}

export interface ArchiveDurabilityCapability {
  open(target: string): Promise<{ readonly parsed: ParsedHdeck; readonly fingerprint: string }>;
  fingerprint(target: string): Promise<string | null>;
  save(target: string, archive: Uint8Array, options?: AtomicSaveOptions): Promise<AtomicSaveResult>;
}

export interface DocumentRuntimeOptions {
  /** Main-process private recovery root. Must be absolute. */
  readonly recoveryDirectory: string;
  readonly journal?: JournalDurabilityCapability | undefined;
  readonly archive?: ArchiveDurabilityCapability | undefined;
  readonly idFactory?: (() => string) | undefined;
  readonly now?: (() => string) | undefined;
  readonly autosaveDelayMs?: number | undefined;
  readonly maxHistoryEntries?: number | undefined;
  readonly defaultProposalTtlMs?: number | undefined;
}

export type RuntimeEvent =
  | Readonly<{
      type: 'session-opened';
      sessionId: string;
      documentId: string;
      revision: string;
      recovered: boolean;
    }>
  | Readonly<{
      type: 'document-changed';
      sessionId: string;
      documentId: string;
      revision: string;
      dirty: boolean;
      durability: SessionDurability;
      commandTypes: readonly string[];
    }>
  | Readonly<{
      type: 'document-saved';
      sessionId: string;
      documentId: string;
      revision: string;
      dirty: boolean;
    }>
  | Readonly<{
      type: 'durability-error';
      sessionId: string;
      documentId: string;
      operation: 'journal' | 'save' | 'recovery';
    }>
  | Readonly<{
      type: 'session-closed';
      sessionId: string;
      documentId: string;
      dirtyDiscarded: boolean;
    }>;

export type RuntimeEventListener = (event: RuntimeEvent) => void;
