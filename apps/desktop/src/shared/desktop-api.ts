import type { DeckDocument, DocumentCommand, PageSize } from '@htmllelujah/document-core';
import type { DocumentSessionSnapshot, RecoveryCandidate } from '@htmllelujah/document-runtime';

export const DESKTOP_API_VERSION = 1 as const;

export const DESKTOP_IPC = Object.freeze({
  getAppInfo: 'htmllelujah:v1:app-info',
  initialize: 'htmllelujah:v1:initialize',
  createDocument: 'htmllelujah:v1:document-create',
  openDocument: 'htmllelujah:v1:document-open',
  execute: 'htmllelujah:v1:document-execute',
  undo: 'htmllelujah:v1:document-undo',
  redo: 'htmllelujah:v1:document-redo',
  save: 'htmllelujah:v1:document-save',
  saveAs: 'htmllelujah:v1:document-save-as',
  importImage: 'htmllelujah:v1:asset-import-image',
  listRecovery: 'htmllelujah:v1:recovery-list',
  recover: 'htmllelujah:v1:recovery-open',
  present: 'htmllelujah:v1:presentation-open',
  exportDocument: 'htmllelujah:v1:document-export',
  collaborationStatus: 'htmllelujah:v1:collaboration-status',
  collaborationHost: 'htmllelujah:v1:collaboration-host',
  collaborationJoin: 'htmllelujah:v1:collaboration-join',
  collaborationLeave: 'htmllelujah:v1:collaboration-leave',
  mcpStatus: 'htmllelujah:v1:mcp-status',
  mcpCreateApproval: 'htmllelujah:v1:mcp-create-approval',
  documentChanged: 'htmllelujah:v1:event-document-changed',
  presentationChanged: 'htmllelujah:v1:event-presentation-changed',
} as const);

export interface DesktopSafeError {
  readonly code: string;
  readonly message: string;
  readonly recoverable: boolean;
}

export type DesktopResult<T> =
  Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: DesktopSafeError }>;

export interface AppInfo {
  readonly apiVersion: typeof DESKTOP_API_VERSION;
  readonly name: string;
  readonly version: string;
  readonly platform: string;
  readonly packaged: boolean;
}

export interface SessionView {
  readonly snapshot: DocumentSessionSnapshot;
  /** Opaque, revocable URLs. They never reveal a filesystem path. */
  readonly assetUrls: Readonly<Record<string, string>>;
}

export interface InitializeResult {
  readonly session: SessionView;
  readonly recoveryCandidates: readonly RecoveryCandidate[];
  readonly mode: 'editor' | 'presentation';
}

export interface ExecuteInput {
  readonly sessionId: string;
  readonly expectedRevision: string;
  readonly label: string;
  readonly commands: readonly DocumentCommand[];
  readonly historyGroupId?: string | undefined;
}

export interface HistoryInput {
  readonly sessionId: string;
  readonly expectedRevision: string;
}

export interface ImportImageInput extends HistoryInput {
  readonly slideId: string;
  readonly replaceElementId?: string | undefined;
}

export interface SessionInput {
  readonly sessionId: string;
}

export interface ImportImageResult {
  readonly session: SessionView;
  readonly assetId: string;
  readonly elementId: string;
}

export type ExportFormat = 'html' | 'pdf';

export interface ExportInput {
  readonly sessionId: string;
  readonly expectedRevision: string;
  readonly format: ExportFormat;
  readonly includeHidden: boolean;
}

export interface ExportResult {
  readonly format: ExportFormat;
  readonly pageCount: number;
  readonly page: PageSize;
  readonly bytesWritten: number;
  readonly durationMs: number;
  readonly warnings: readonly string[];
}

export interface PresentationInput {
  readonly sessionId: string;
  readonly startSlideId?: string | undefined;
}

export interface CollaborationStatus {
  readonly mode: 'offline' | 'host' | 'guest';
  readonly connectedPeers: number;
  readonly sessionCode?: string | undefined;
  readonly hostFingerprint?: string | undefined;
  readonly endpoint?: string | undefined;
  readonly discoveryEnabled: boolean;
  readonly note: string;
}

export interface CollaborationHostInput {
  readonly sessionId: string;
  readonly displayName: string;
  readonly enableDiscovery: boolean;
}

export interface CollaborationJoinInput {
  readonly sessionId: string;
  readonly endpoint: string;
  readonly sessionCode: string;
  readonly expectedFingerprint: string;
  readonly displayName: string;
}

export interface McpStatus {
  readonly available: boolean;
  readonly connected: boolean;
  readonly visibleDocuments: number;
  readonly pendingApprovals: number;
  readonly transport: 'local-stdio';
}

export type McpApprovalAction =
  'commit-destructive' | 'undo' | 'import' | 'export-html' | 'export-pdf';

export interface McpApprovalInput extends SessionInput {
  readonly action: McpApprovalAction;
}

export interface McpApproval {
  readonly approvalId: string;
  readonly action: McpApprovalAction;
  readonly expiresAt: string;
}

export interface SafeDocumentChangedEvent {
  readonly sessionId: string;
  readonly revision: string;
  readonly reason: 'changed' | 'saved' | 'opened' | 'recovered' | 'remote';
}

export interface PresentationChangedEvent {
  readonly sessionId: string;
  readonly activeSlideId?: string | undefined;
  readonly closed: boolean;
}

export interface HtmllelujahDesktopApi {
  readonly version: typeof DESKTOP_API_VERSION;
  getAppInfo(): Promise<DesktopResult<AppInfo>>;
  initialize(): Promise<DesktopResult<InitializeResult>>;
  createDocument(): Promise<DesktopResult<SessionView>>;
  openDocument(): Promise<DesktopResult<SessionView>>;
  execute(input: ExecuteInput): Promise<DesktopResult<SessionView>>;
  undo(input: HistoryInput): Promise<DesktopResult<SessionView>>;
  redo(input: HistoryInput): Promise<DesktopResult<SessionView>>;
  save(input: SessionInput): Promise<DesktopResult<SessionView>>;
  saveAs(input: SessionInput): Promise<DesktopResult<SessionView>>;
  importImage(input: ImportImageInput): Promise<DesktopResult<ImportImageResult>>;
  listRecovery(): Promise<DesktopResult<readonly RecoveryCandidate[]>>;
  recover(candidateId: string): Promise<DesktopResult<SessionView>>;
  present(input: PresentationInput): Promise<DesktopResult<null>>;
  exportDocument(input: ExportInput): Promise<DesktopResult<ExportResult>>;
  collaborationStatus(input: SessionInput): Promise<DesktopResult<CollaborationStatus>>;
  collaborationHost(input: CollaborationHostInput): Promise<DesktopResult<CollaborationStatus>>;
  collaborationJoin(input: CollaborationJoinInput): Promise<DesktopResult<CollaborationStatus>>;
  collaborationLeave(input: SessionInput): Promise<DesktopResult<CollaborationStatus>>;
  mcpStatus(): Promise<DesktopResult<McpStatus>>;
  mcpCreateApproval(input: McpApprovalInput): Promise<DesktopResult<McpApproval>>;
  onDocumentChanged(listener: (event: SafeDocumentChangedEvent) => void): () => void;
  onPresentationChanged(listener: (event: PresentationChangedEvent) => void): () => void;
}

/** Kept explicit so test fixtures can construct a valid initial document without Electron. */
export type DesktopDeckDocument = DeckDocument;
