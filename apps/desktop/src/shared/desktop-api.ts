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
  collaborationDecideJoin: 'htmllelujah:v1:collaboration-decide-join',
  collaborationUpdatePresence: 'htmllelujah:v1:collaboration-update-presence',
  collaborationLeave: 'htmllelujah:v1:collaboration-leave',
  collaborationTextLeaseStatus: 'htmllelujah:v1:collaboration-text-lease-status',
  collaborationTextLeaseBegin: 'htmllelujah:v1:collaboration-text-lease-begin',
  collaborationTextLeaseRenew: 'htmllelujah:v1:collaboration-text-lease-renew',
  collaborationTextLeaseEnd: 'htmllelujah:v1:collaboration-text-lease-end',
  mcpStatus: 'htmllelujah:v1:mcp-status',
  mcpCreateApproval: 'htmllelujah:v1:mcp-create-approval',
  windowCloseRequested: 'htmllelujah:v1:event-window-close-requested',
  windowCloseResponse: 'htmllelujah:v1:window-close-response',
  windowCloseReleased: 'htmllelujah:v1:event-window-close-released',
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
  readonly availableHostAddresses?: readonly CollaborationHostAddress[] | undefined;
  readonly sessionCode?: string | undefined;
  readonly hostFingerprint?: string | undefined;
  readonly endpoint?: string | undefined;
  readonly discoveryEnabled: boolean;
  readonly participants: readonly CollaborationParticipant[];
  readonly pendingJoins: readonly CollaborationPendingJoin[];
  readonly note: string;
}

export interface CollaborationHostAddress {
  readonly address: string;
  readonly name: string;
}

export interface CollaborationParticipant {
  readonly clientId: string;
  readonly displayName: string;
  readonly role: 'host' | 'guest';
  readonly isSelf: boolean;
  readonly connection: 'active' | 'reconnecting' | 'disconnected';
  readonly slideId?: string | undefined;
  readonly selectedElementCount: number;
  readonly editingElementId?: string | undefined;
}

export interface CollaborationPendingJoin {
  readonly joinRequestId: string;
  readonly displayName: string;
  readonly expiresAtMs: number;
}

export interface CollaborationHostInput {
  readonly sessionId: string;
  readonly displayName: string;
  readonly enableDiscovery: boolean;
  readonly hostAddress: string;
}

export interface CollaborationJoinInput {
  readonly sessionId: string;
  readonly endpoint: string;
  readonly sessionCode: string;
  readonly expectedFingerprint: string;
  readonly displayName: string;
}

export interface CollaborationJoinDecisionInput extends SessionInput {
  readonly joinRequestId: string;
  readonly decision: 'accept' | 'reject';
}

export interface CollaborationPresenceInput extends SessionInput {
  readonly slideId?: string | undefined;
  readonly selectedElementIds: readonly string[];
  readonly editingElementId?: string | undefined;
}

export interface CollaborationTextLeaseInput extends SessionInput {
  readonly slideId: string;
  readonly elementId: string;
}

export type CollaborationTextLeaseStatus =
  | {
      readonly status: 'available';
      readonly owner: 'none';
      readonly slideId: string;
      readonly elementId: string;
      readonly expiresAtMs: null;
    }
  | {
      readonly status: 'owned';
      readonly owner: 'self';
      readonly slideId: string;
      readonly elementId: string;
      readonly expiresAtMs: number;
    }
  | {
      readonly status: 'held';
      readonly owner: 'peer';
      readonly ownerClientId: string;
      readonly slideId: string;
      readonly elementId: string;
      readonly expiresAtMs: number;
    };

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

export interface WindowCloseRequest {
  readonly requestId: string;
  readonly deadlineAtMs: number;
}

export type WindowCloseDecision = 'ready' | 'blocked';

export interface WindowCloseResponse {
  readonly requestId: string;
  readonly decision: WindowCloseDecision;
}
export interface WindowCloseRelease {
  readonly requestId: string;
}

export type WindowCloseRequestListener = (
  request: WindowCloseRequest,
) => WindowCloseDecision | Promise<WindowCloseDecision>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export type WindowCloseReleaseListener = (release: WindowCloseRelease) => void;

const isStrictRecord = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

export const isWindowCloseRequest = (value: unknown): value is WindowCloseRequest =>
  isStrictRecord(value, ['requestId', 'deadlineAtMs']) &&
  typeof value.requestId === 'string' &&
  UUID_PATTERN.test(value.requestId) &&
  typeof value.deadlineAtMs === 'number' &&
  Number.isSafeInteger(value.deadlineAtMs) &&
  value.deadlineAtMs > 0;

export const isWindowCloseResponse = (value: unknown): value is WindowCloseResponse =>
  isStrictRecord(value, ['requestId', 'decision']) &&
  typeof value.requestId === 'string' &&
  UUID_PATTERN.test(value.requestId) &&
  (value.decision === 'ready' || value.decision === 'blocked');
export const isWindowCloseRelease = (value: unknown): value is WindowCloseRelease =>
  isStrictRecord(value, ['requestId']) &&
  typeof value.requestId === 'string' &&
  UUID_PATTERN.test(value.requestId);

/** A native close is safe only when every registered renderer participant explicitly agrees. */
export const settleWindowCloseListeners = async (
  listeners: readonly WindowCloseRequestListener[],
  request: WindowCloseRequest,
): Promise<WindowCloseDecision> => {
  const remainingMs = request.deadlineAtMs - Date.now();
  if (listeners.length === 0 || remainingMs <= 0) return 'blocked';
  const decisions = Promise.all(
    listeners.map(async (listener): Promise<WindowCloseDecision> => {
      try {
        const decision = await listener(request);
        return decision === 'ready' ? 'ready' : 'blocked';
      } catch {
        return 'blocked';
      }
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<readonly WindowCloseDecision[]>((resolve) => {
    timer = setTimeout(() => resolve(['blocked']), remainingMs);
  });
  try {
    const settled = await Promise.race([decisions, deadline]);
    return settled.every((decision) => decision === 'ready') ? 'ready' : 'blocked';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

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
  collaborationDecideJoin(
    input: CollaborationJoinDecisionInput,
  ): Promise<DesktopResult<CollaborationStatus>>;
  collaborationUpdatePresence(
    input: CollaborationPresenceInput,
  ): Promise<DesktopResult<CollaborationStatus>>;
  collaborationLeave(input: SessionInput): Promise<DesktopResult<CollaborationStatus>>;
  collaborationTextLeaseStatus(
    input: CollaborationTextLeaseInput,
  ): Promise<DesktopResult<CollaborationTextLeaseStatus>>;
  collaborationTextLeaseBegin(
    input: CollaborationTextLeaseInput,
  ): Promise<DesktopResult<CollaborationTextLeaseStatus>>;
  collaborationTextLeaseRenew(
    input: CollaborationTextLeaseInput,
  ): Promise<DesktopResult<CollaborationTextLeaseStatus>>;
  collaborationTextLeaseEnd(
    input: CollaborationTextLeaseInput,
  ): Promise<DesktopResult<CollaborationTextLeaseStatus>>;
  mcpStatus(): Promise<DesktopResult<McpStatus>>;
  mcpCreateApproval(input: McpApprovalInput): Promise<DesktopResult<McpApproval>>;
  onWindowCloseRequested(listener: WindowCloseRequestListener): () => void;
  onDocumentChanged(listener: (event: SafeDocumentChangedEvent) => void): () => void;
  onWindowCloseReleased(listener: WindowCloseReleaseListener): () => void;
  onPresentationChanged(listener: (event: PresentationChangedEvent) => void): () => void;
}

/** Kept explicit so test fixtures can construct a valid initial document without Electron. */
export type DesktopDeckDocument = DeckDocument;
