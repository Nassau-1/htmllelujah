import { randomBytes, randomUUID } from 'node:crypto';

import {
  affectedSlideIds,
  commandsRequireApproval,
  McpSafeError,
  type CommitProposalInput,
  type CommitProposalResult,
  type ExportDocumentInput,
  type HtmllelujahMcpService,
  type ImportAssetInput,
  type McpPermissionGate,
  type ProposalResult,
  type ProposeCommandsInput,
  type SafeRecord,
  type TransactionTargetInput,
} from '@htmllelujah/mcp-server';
import {
  DocumentRuntimeError,
  DocumentSessionManager,
  type DocumentSessionSnapshot,
} from '@htmllelujah/document-runtime';

export type McpApprovalAction = Parameters<McpPermissionGate['consumeApproval']>[0]['action'];

export interface McpApprovalCapability {
  readonly approvalId: string;
  readonly documentId: string;
  readonly action: McpApprovalAction;
  readonly expiresAt: string;
}

export interface DesktopMcpBridgeOptions {
  readonly runtime: DocumentSessionManager;
  readonly appVersion: () => string;
  readonly visibleSessionIds: () => readonly string[];
  readonly collaborationStatus: (sessionId: string) => {
    readonly mode: 'offline' | 'host' | 'guest';
    readonly connectedPeers: number;
    readonly discoveryEnabled: boolean;
  };
  readonly importAsset: (sessionId: string, expectedRevision: string) => Promise<SafeRecord>;
  readonly exportDocument: (sessionId: string, input: ExportDocumentInput) => Promise<SafeRecord>;
  readonly now?: (() => Date) | undefined;
}

interface PendingProposal {
  readonly sessionId: string;
  readonly documentId: string;
  readonly requiresApproval: boolean;
  readonly commandCount: number;
}

interface ApprovalGrant {
  readonly documentId: string;
  readonly action: McpApprovalAction;
  readonly baseRevision: string;
  readonly expiresAtMs: number;
}

interface ApprovalReceipt extends ApprovalGrant {
  readonly consumedAtMs: number;
}

const APPROVAL_TTL_MS = 2 * 60_000;
const RECEIPT_TTL_MS = 30_000;

const asSafeError = (error: unknown): never => {
  if (error instanceof McpSafeError) throw error;
  if (error instanceof DocumentRuntimeError) {
    const code =
      error.code === 'REVISION_CONFLICT' ||
      error.code === 'PROPOSAL_STALE' ||
      error.code === 'AGENT_UNDO_CONFLICT'
        ? 'REVISION_CONFLICT'
        : error.code === 'PROPOSAL_NOT_FOUND' || error.code === 'SESSION_NOT_FOUND'
          ? 'NOT_FOUND'
          : 'INVALID_REQUEST';
    throw new McpSafeError(code, 'The document operation could not be completed.');
  }
  throw new McpSafeError('SERVICE_UNAVAILABLE', 'The local document service is unavailable.');
};

export class DesktopMcpBridge implements HtmllelujahMcpService, McpPermissionGate {
  readonly #runtime: DocumentSessionManager;
  readonly #options: DesktopMcpBridgeOptions;
  readonly #proposals = new Map<string, PendingProposal>();
  readonly #approvals = new Map<string, ApprovalGrant>();
  readonly #receipts = new Map<string, ApprovalReceipt>();

  public constructor(options: DesktopMcpBridgeOptions) {
    this.#runtime = options.runtime;
    this.#options = options;
  }

  #nowMs(): number {
    return (this.#options.now ?? (() => new Date()))().getTime();
  }

  #visibleSnapshots(): readonly DocumentSessionSnapshot[] {
    const visible = new Set(this.#options.visibleSessionIds());
    return this.#runtime
      .listSessions()
      .filter((snapshot) => visible.has(snapshot.sessionId))
      .filter(
        (snapshot, index, snapshots) =>
          snapshots.findIndex((candidate) => candidate.documentId === snapshot.documentId) ===
          index,
      );
  }

  #sessionForDocument(documentId: string): DocumentSessionSnapshot {
    const snapshot = this.#visibleSnapshots().find(
      (candidate) => candidate.documentId === documentId,
    );
    if (snapshot === undefined) {
      throw new McpSafeError('NOT_FOUND', 'The presentation is not open or visible.');
    }
    return snapshot;
  }

  #assertEditable(documentId: string): DocumentSessionSnapshot {
    const snapshot = this.#sessionForDocument(documentId);
    if (this.#options.collaborationStatus(snapshot.sessionId).mode !== 'offline') {
      throw new McpSafeError(
        'MCP_UNAUTHORIZED',
        'Agent edits are paused while this V1 LAN session is active.',
      );
    }
    return snapshot;
  }

  #purgeExpired(): void {
    const now = this.#nowMs();
    for (const [id, grant] of this.#approvals) {
      if (grant.expiresAtMs <= now) this.#approvals.delete(id);
    }
    for (const [id, receipt] of this.#receipts) {
      if (receipt.consumedAtMs + RECEIPT_TTL_MS <= now) this.#receipts.delete(id);
    }
  }

  #takeReceipt(
    approvalId: string | undefined,
    documentId: string,
    action: McpApprovalAction,
  ): ApprovalReceipt {
    this.#purgeExpired();
    const receiptEntry =
      approvalId === undefined
        ? [...this.#receipts].find(
            ([, candidate]) => candidate.documentId === documentId && candidate.action === action,
          )
        : ([approvalId, this.#receipts.get(approvalId)] as const);
    const receiptId = receiptEntry?.[0];
    const receipt = receiptEntry?.[1];
    if (receiptId !== undefined) this.#receipts.delete(receiptId);
    if (receipt === undefined && approvalId === undefined) {
      throw new McpSafeError('APPROVAL_REQUIRED', 'A desktop approval is required.');
    }
    if (
      receipt === undefined ||
      receipt.documentId !== documentId ||
      receipt.action !== action ||
      receipt.consumedAtMs + RECEIPT_TTL_MS <= this.#nowMs()
    ) {
      throw new McpSafeError('APPROVAL_EXPIRED', 'The desktop approval is invalid or expired.');
    }
    const current = this.#sessionForDocument(documentId);
    if (current.revision !== receipt.baseRevision) {
      throw new McpSafeError('REVISION_CONFLICT', 'The presentation changed after approval.');
    }
    return receipt;
  }

  public issueApproval(documentId: string, action: McpApprovalAction): McpApprovalCapability {
    const snapshot = this.#assertEditable(documentId);
    this.#purgeExpired();
    const approvalId = `approval-${randomBytes(24).toString('base64url')}`;
    const expiresAtMs = this.#nowMs() + APPROVAL_TTL_MS;
    this.#approvals.set(approvalId, {
      documentId,
      action,
      baseRevision: snapshot.revision,
      expiresAtMs,
    });
    return {
      approvalId,
      documentId,
      action,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  public revokeApprovals(): void {
    this.#approvals.clear();
    this.#receipts.clear();
  }

  public pendingApprovalCount(): number {
    this.#purgeExpired();
    return this.#approvals.size;
  }

  public async canRead(documentId: string): Promise<boolean> {
    try {
      this.#sessionForDocument(documentId);
      return true;
    } catch {
      return false;
    }
  }

  public async canEdit(documentId: string): Promise<boolean> {
    try {
      this.#assertEditable(documentId);
      return true;
    } catch {
      return false;
    }
  }

  public async consumeApproval(input: {
    readonly approvalId: string;
    readonly documentId: string;
    readonly action: McpApprovalAction;
  }): Promise<boolean> {
    this.#purgeExpired();
    const grant = this.#approvals.get(input.approvalId);
    if (
      grant === undefined ||
      grant.documentId !== input.documentId ||
      grant.action !== input.action ||
      grant.expiresAtMs <= this.#nowMs()
    ) {
      return false;
    }
    let current: DocumentSessionSnapshot;
    try {
      current = this.#assertEditable(input.documentId);
    } catch {
      return false;
    }
    if (current.revision !== grant.baseRevision) return false;
    this.#approvals.delete(input.approvalId);
    this.#receipts.set(input.approvalId, { ...grant, consumedAtMs: this.#nowMs() });
    return true;
  }

  public async appStatus(): Promise<SafeRecord> {
    return {
      running: true,
      version: this.#options.appVersion(),
      transport: 'authenticated-local-rpc',
      visibleDocuments: this.#visibleSnapshots().length,
    };
  }

  public async listOpenDocuments(): Promise<readonly SafeRecord[]> {
    return this.#visibleSnapshots().map((snapshot) => ({
      documentId: snapshot.documentId,
      revision: snapshot.revision,
      name: snapshot.document.name,
      slideCount: snapshot.document.slides.length,
      dirty: snapshot.dirty,
      hasSaveTarget: snapshot.hasSaveTarget,
      durability: snapshot.durability,
      collaborationMode: this.#options.collaborationStatus(snapshot.sessionId).mode,
    }));
  }

  public async getDocumentOutline(documentId: string): Promise<SafeRecord> {
    const snapshot = this.#sessionForDocument(documentId);
    return {
      documentId,
      revision: snapshot.revision,
      name: snapshot.document.name,
      page: snapshot.document.page,
      slides: this.#runtime.outline(snapshot.sessionId),
    };
  }

  public async getSlide(documentId: string, slideId: string): Promise<SafeRecord> {
    const snapshot = this.#sessionForDocument(documentId);
    return {
      documentId,
      revision: snapshot.revision,
      slide: this.#runtime.slide(snapshot.sessionId, slideId),
    };
  }

  public async getStyleCatalog(documentId: string): Promise<SafeRecord> {
    const snapshot = this.#sessionForDocument(documentId);
    return {
      documentId,
      revision: snapshot.revision,
      page: snapshot.document.page,
      themes: snapshot.document.themes,
      masters: snapshot.document.masters,
      layouts: snapshot.document.layouts,
    };
  }

  public async validateDocument(documentId: string): Promise<SafeRecord> {
    const snapshot = this.#sessionForDocument(documentId);
    const validation = this.#runtime.validate(snapshot.sessionId);
    return {
      documentId,
      revision: snapshot.revision,
      valid: validation.valid,
      issueCount: validation.issues.length,
      issues: validation.issues,
    };
  }

  public async proposeCommands(input: ProposeCommandsInput): Promise<ProposalResult> {
    try {
      const snapshot = this.#assertEditable(input.documentId);
      const requiresApproval = commandsRequireApproval(input.commands);
      const proposal = this.#runtime.propose(snapshot.sessionId, {
        expectedRevision: input.expectedRevision,
        commands: input.commands,
        metadata: {
          transactionId: randomUUID(),
          actorId: 'mcp-local-agent',
          origin: 'agent',
          label: input.label,
          timestamp: new Date(this.#nowMs()).toISOString(),
        },
      });
      this.#proposals.set(proposal.proposalId, {
        sessionId: snapshot.sessionId,
        documentId: input.documentId,
        requiresApproval,
        commandCount: input.commands.length,
      });
      return {
        proposalId: proposal.proposalId,
        documentId: proposal.documentId,
        baseRevision: proposal.baseRevision,
        expiresAt: proposal.expiresAt,
        requiresApproval,
        commandCount: proposal.diff.commandCount,
        affectedSlideIds: affectedSlideIds(input.commands),
        warnings: proposal.diff.changed ? [] : ['NO_EFFECT'],
        summary: `${proposal.diff.commandCount} typed command${proposal.diff.commandCount === 1 ? '' : 's'}; slides ${proposal.diff.slidesBefore} to ${proposal.diff.slidesAfter}; elements ${proposal.diff.elementsBefore} to ${proposal.diff.elementsAfter}.`,
      };
    } catch (error) {
      return asSafeError(error);
    }
  }

  public async commitProposal(input: CommitProposalInput): Promise<CommitProposalResult> {
    const proposal = this.#proposals.get(input.proposalId);
    if (proposal === undefined)
      throw new McpSafeError('NOT_FOUND', 'Proposal is missing or expired.');
    try {
      this.#assertEditable(proposal.documentId);
      if (proposal.requiresApproval) {
        this.#takeReceipt(input.approvalId, proposal.documentId, 'commit-destructive');
      }
      const before = this.#runtime.getSnapshot(proposal.sessionId);
      const after = await this.#runtime.commitProposal(proposal.sessionId, input.proposalId);
      const audit = this.#runtime
        .getAgentAudit(proposal.sessionId)
        .find((entry) => entry.proposalId === input.proposalId);
      if (audit === undefined) {
        throw new McpSafeError('SERVICE_UNAVAILABLE', 'Agent audit acknowledgement is missing.');
      }
      this.#proposals.delete(input.proposalId);
      return {
        documentId: proposal.documentId,
        transactionId: audit.transactionId,
        previousRevision: before.revision,
        revision: after.revision,
        acceptedCommandCount: proposal.commandCount,
      };
    } catch (error) {
      return asSafeError(error);
    }
  }

  public async undoAgentTransaction(input: TransactionTargetInput): Promise<CommitProposalResult> {
    try {
      const snapshot = this.#assertEditable(input.documentId);
      this.#takeReceipt(undefined, input.documentId, 'undo');
      if (snapshot.revision !== input.expectedRevision) {
        throw new McpSafeError('REVISION_CONFLICT', 'The presentation changed before undo.');
      }
      const audit = this.#runtime
        .getAgentAudit(snapshot.sessionId)
        .find((entry) => entry.transactionId === input.transactionId);
      const after = await this.#runtime.undoAgentTransaction(
        snapshot.sessionId,
        input.transactionId,
        {
          expectedRevision: input.expectedRevision,
          metadata: {
            transactionId: randomUUID(),
            actorId: 'mcp-local-agent',
            origin: 'agent',
            label: 'Undo agent transaction',
            timestamp: new Date(this.#nowMs()).toISOString(),
          },
        },
      );
      return {
        documentId: input.documentId,
        transactionId: input.transactionId,
        previousRevision: snapshot.revision,
        revision: after.revision,
        acceptedCommandCount: audit?.commandTypes.length ?? 0,
      };
    } catch (error) {
      return asSafeError(error);
    }
  }

  public async importAsset(input: ImportAssetInput): Promise<SafeRecord> {
    try {
      const receipt = this.#takeReceipt(input.approvalId, input.documentId, 'import');
      const snapshot = this.#assertEditable(input.documentId);
      return await this.#options.importAsset(snapshot.sessionId, receipt.baseRevision);
    } catch (error) {
      return asSafeError(error);
    }
  }

  public async exportDocument(input: ExportDocumentInput): Promise<SafeRecord> {
    try {
      this.#takeReceipt(
        input.approvalId,
        input.documentId,
        input.format === 'html' ? 'export-html' : 'export-pdf',
      );
      const snapshot = this.#sessionForDocument(input.documentId);
      if (snapshot.revision !== input.expectedRevision) {
        throw new McpSafeError('REVISION_CONFLICT', 'The presentation changed before export.');
      }
      return await this.#options.exportDocument(snapshot.sessionId, input);
    } catch (error) {
      return asSafeError(error);
    }
  }

  public async collaborationStatus(documentId: string): Promise<SafeRecord> {
    const snapshot = this.#sessionForDocument(documentId);
    const status = this.#options.collaborationStatus(snapshot.sessionId);
    return {
      documentId,
      mode: status.mode,
      connectedPeers: status.connectedPeers,
      discoveryEnabled: status.discoveryEnabled,
      sharedFileWriter: status.mode === 'host',
    };
  }
}
