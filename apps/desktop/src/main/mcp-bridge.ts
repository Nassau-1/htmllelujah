import { randomBytes, randomUUID } from 'node:crypto';

import {
  applyTransaction,
  DOCUMENT_LIMITS,
  DocumentCommandError,
  resolveSlideFromValidatedDocument,
  type Element,
  type ResolvedElement,
  type ResolvedElementSource,
} from '@htmllelujah/document-core';
import {
  DocumentRuntimeError,
  DocumentSessionManager,
  type DocumentSessionSnapshot,
} from '@htmllelujah/document-runtime';
import {
  affectedSlideIds,
  commandsRequireApproval,
  designOperationsToCommands,
  MCP_LIMITS,
  McpSafeError,
  type CommitProposalInput,
  type CommitProposalResult,
  type DesignContextInput,
  type ExportDocumentInput,
  type HtmllelujahMcpService,
  type ImportAssetInput,
  type McpPermissionGate,
  type ProposalResult,
  type ProposeCommandsInput,
  type ProposeDesignOperationsInput,
  type SafeRecord,
  type TransactionTargetInput,
  type TrustedClientContext,
} from '@htmllelujah/mcp-server';

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
  readonly importAsset: (
    sessionId: string,
    expectedRevision: string,
    client: TrustedClientContext,
  ) => Promise<SafeRecord>;
  readonly exportDocument: (sessionId: string, input: ExportDocumentInput) => Promise<SafeRecord>;
  readonly now?: (() => Date) | undefined;
}

interface PendingProposal {
  readonly sessionId: string;
  readonly documentId: string;
  readonly clientId: string;
  readonly requiresApproval: boolean;
  readonly commandCount: number;
  readonly expiresAtMs: number;
}

interface ApprovalGrant {
  readonly documentId: string;
  readonly clientId: string;
  readonly action: McpApprovalAction;
  readonly baseRevision: string;
  readonly expiresAtMs: number;
}

interface ApprovalReceipt extends ApprovalGrant {
  readonly consumedAtMs: number;
}

const APPROVAL_TTL_MS = 2 * 60_000;
const RECEIPT_TTL_MS = 30_000;

interface DesignElementSummaryContext {
  readonly source: ResolvedElementSource;
  readonly containerId: string;
  readonly parentId?: string | undefined;
  readonly placeholder?: ResolvedElement['placeholder'] | undefined;
  readonly resolvedTextStyle?: ResolvedElement['resolvedTextStyle'] | undefined;
}

const designElementSummary = (
  element: Element,
  context: DesignElementSummaryContext,
): SafeRecord => ({
  id: element.id,
  name: element.name,
  type: element.type,
  source: context.source,
  containerId: context.containerId,
  ...(context.parentId === undefined ? {} : { parentId: context.parentId }),
  frame: element.frame,
  opacity: element.opacity,
  visible: element.visible,
  locked: element.locked,
  effectiveLockedInSelectedSlide:
    element.locked || context.source !== 'slide' || context.placeholder?.locked === true,
  inherited: context.source !== 'slide',
  ...(element.placeholderBinding === undefined
    ? {}
    : {
        placeholderBinding: element.placeholderBinding,
        inheritedPlaceholder:
          context.placeholder === undefined
            ? undefined
            : {
                id: context.placeholder.id,
                role: context.placeholder.role,
                locked: context.placeholder.locked,
              },
      }),
  ...(element.type === 'placeholder'
    ? {
        placeholder: {
          role: element.role,
          accepts: element.accepts,
          prompt: element.prompt,
          defaultTextStyle: element.defaultTextStyle,
        },
      }
    : {}),
  ...(element.type === 'text'
    ? {
        styleRole: element.styleRole,
        localStyleFields: Object.keys(element.style ?? {}),
        resolvedTextStyle: context.resolvedTextStyle,
      }
    : {}),
  ...(element.type === 'icon'
    ? { catalogIdentity: { iconSet: element.iconSet, iconName: element.iconName } }
    : {}),
  ...(element.type === 'image' ? { assetId: element.assetId } : {}),
  ...(element.type === 'group' ? { childCount: element.children.length } : {}),
});

const flattenDesignElements = (
  elements: readonly Element[],
  context: Omit<DesignElementSummaryContext, 'parentId'>,
  output: SafeRecord[],
  parentId?: string | undefined,
): void => {
  for (const element of elements) {
    output.push(
      designElementSummary(element, {
        ...context,
        ...(parentId === undefined ? {} : { parentId }),
      }),
    );
    if (element.type === 'group') {
      flattenDesignElements(element.children, context, output, element.id);
    }
  }
};

const countElements = (elements: readonly Element[]): number =>
  elements.reduce(
    (total, element) =>
      total + 1 + (element.type === 'group' ? countElements(element.children) : 0),
    0,
  );

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
  if (error instanceof DocumentCommandError) {
    const code =
      error.code === 'REVISION_CONFLICT'
        ? 'REVISION_CONFLICT'
        : error.code === 'NOT_FOUND'
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
  #proposalReservations = 0;

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
    for (const [id, proposal] of this.#proposals) {
      if (proposal.expiresAtMs <= now) this.#proposals.delete(id);
    }
    for (const [id, grant] of this.#approvals) {
      if (grant.expiresAtMs <= now) this.#approvals.delete(id);
    }
    for (const [id, receipt] of this.#receipts) {
      if (receipt.consumedAtMs + RECEIPT_TTL_MS <= now) this.#receipts.delete(id);
    }
  }

  #reserveProposalSlot(): void {
    this.#purgeExpired();
    if (this.#proposals.size + this.#proposalReservations >= MCP_LIMITS.maxPendingProposals) {
      throw new McpSafeError(
        'INVALID_REQUEST',
        'Too many proposals are pending; commit one or wait for expiry.',
      );
    }
    this.#proposalReservations += 1;
  }

  #takeReceipt(
    approvalId: string | undefined,
    documentId: string,
    action: McpApprovalAction,
    clientId: string,
  ): ApprovalReceipt {
    this.#purgeExpired();
    const receiptEntry =
      approvalId === undefined
        ? [...this.#receipts].find(
            ([, candidate]) =>
              candidate.documentId === documentId &&
              candidate.action === action &&
              candidate.clientId === clientId,
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
      receipt.clientId !== clientId ||
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

  public issueApproval(
    documentId: string,
    action: McpApprovalAction,
    clientId: string,
  ): McpApprovalCapability {
    const snapshot = this.#assertEditable(documentId);
    this.#purgeExpired();
    if (this.#approvals.size >= MCP_LIMITS.maxPendingApprovals) {
      throw new McpSafeError(
        'INVALID_REQUEST',
        'Too many desktop approvals are pending; revoke them or wait for expiry.',
      );
    }
    const approvalId = `approval-${randomBytes(24).toString('base64url')}`;
    const expiresAtMs = this.#nowMs() + APPROVAL_TTL_MS;
    this.#approvals.set(approvalId, {
      documentId,
      clientId,
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

  public revokeClient(clientId: string): void {
    for (const [proposalId, proposal] of this.#proposals) {
      if (proposal.clientId === clientId) this.#proposals.delete(proposalId);
    }
    for (const [approvalId, approval] of this.#approvals) {
      if (approval.clientId === clientId) this.#approvals.delete(approvalId);
    }
    for (const [receiptId, receipt] of this.#receipts) {
      if (receipt.clientId === clientId) this.#receipts.delete(receiptId);
    }
  }

  public pendingApprovalCount(): number {
    this.#purgeExpired();
    return this.#approvals.size;
  }

  public async canRead(
    documentId: string,
    client?: TrustedClientContext | undefined,
  ): Promise<boolean> {
    if (client === undefined) return false;
    try {
      this.#sessionForDocument(documentId);
      return true;
    } catch {
      return false;
    }
  }

  public async canEdit(
    documentId: string,
    client?: TrustedClientContext | undefined,
  ): Promise<boolean> {
    if (client === undefined) return false;
    try {
      this.#assertEditable(documentId);
      return true;
    } catch {
      return false;
    }
  }

  public async consumeApproval(
    input: {
      readonly approvalId: string;
      readonly documentId: string;
      readonly action: McpApprovalAction;
    },
    client?: TrustedClientContext | undefined,
  ): Promise<boolean> {
    if (client === undefined) return false;
    this.#purgeExpired();
    const grant = this.#approvals.get(input.approvalId);
    if (
      grant === undefined ||
      grant.documentId !== input.documentId ||
      grant.action !== input.action ||
      grant.clientId !== client.clientId ||
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
    if (this.#receipts.size >= MCP_LIMITS.maxApprovalReceipts) return false;
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

  public async getDesignContext(input: DesignContextInput): Promise<SafeRecord> {
    const snapshot = this.#sessionForDocument(input.documentId);
    const document = snapshot.document;
    const slide =
      input.slideId === undefined
        ? document.slides[0]
        : document.slides.find((candidate) => candidate.id === input.slideId);
    if (slide === undefined) {
      throw new McpSafeError('NOT_FOUND', 'The requested slide does not exist.');
    }
    const projection = resolveSlideFromValidatedDocument(document, slide.id, {
      includePlaceholders: true,
    });
    const elementSummaries: SafeRecord[] = [];
    if (input.elementScope === 'selected-projection') {
      for (const entry of projection.elements) {
        const containerId =
          entry.source === 'master'
            ? projection.master.id
            : entry.source === 'layout'
              ? projection.layout.id
              : projection.slide.id;
        flattenDesignElements(
          [entry.element],
          {
            source: entry.source,
            containerId,
            placeholder: entry.placeholder,
            resolvedTextStyle: entry.resolvedTextStyle,
          },
          elementSummaries,
        );
      }
    } else {
      for (const master of document.masters) {
        flattenDesignElements(
          master.elements,
          { source: 'master', containerId: master.id },
          elementSummaries,
        );
      }
      for (const layout of document.layouts) {
        flattenDesignElements(
          layout.elements,
          { source: 'layout', containerId: layout.id },
          elementSummaries,
        );
      }
      for (const candidate of document.slides) {
        flattenDesignElements(
          candidate.elements,
          { source: 'slide', containerId: candidate.id },
          elementSummaries,
        );
      }
    }
    const validation = this.#runtime.validate(snapshot.sessionId);
    const pagedElements = elementSummaries.slice(
      input.elementOffset,
      input.elementOffset + input.elementLimit,
    );
    const pagedAssets = document.assets.slice(
      input.assetOffset,
      input.assetOffset + input.assetLimit,
    );
    return {
      documentId: document.id,
      revision: snapshot.revision,
      name: document.name,
      page: document.page,
      selectedSlideId: slide.id,
      inheritance: {
        themeId: projection.theme.id,
        masterId: projection.master.id,
        layoutId: projection.layout.id,
        slideId: projection.slide.id,
        background: projection.background,
        guides: projection.guides,
      },
      themes: document.themes,
      masters: document.masters.map((master) => ({
        id: master.id,
        name: master.name,
        themeId: master.themeId,
        background: master.background,
        guideCount: master.guides.length,
        elementCount: countElements(master.elements),
      })),
      layouts: document.layouts.map((layout) => ({
        id: layout.id,
        name: layout.name,
        masterId: layout.masterId,
        background: layout.background,
        guideCount: layout.guides.length,
        elementCount: countElements(layout.elements),
      })),
      slides: document.slides.map((candidate, index) => ({
        id: candidate.id,
        index,
        name: candidate.name,
        layoutId: candidate.layoutId,
        hidden: candidate.hidden,
        background: candidate.background,
        elementCount: countElements(candidate.elements),
      })),
      elements: {
        scope: input.elementScope,
        offset: input.elementOffset,
        limit: input.elementLimit,
        total: elementSummaries.length,
        hasMore: input.elementOffset + pagedElements.length < elementSummaries.length,
        items: pagedElements,
      },
      assets: {
        offset: input.assetOffset,
        limit: input.assetLimit,
        total: document.assets.length,
        hasMore: input.assetOffset + pagedAssets.length < document.assets.length,
        items: pagedAssets,
      },
      constraints: {
        document: DOCUMENT_LIMITS,
        proposal: {
          maxCommands: MCP_LIMITS.maxCommands,
          maxDesignOperations: MCP_LIMITS.maxDesignOperations,
          expectedRevisionRequired: true,
          arbitraryMarkupAccepted: false,
          arbitraryUrlsAccepted: false,
          arbitraryFilesystemPathsAccepted: false,
        },
      },
      validation: {
        valid: validation.valid,
        issueCount: validation.issues.length,
        issues: validation.issues,
      },
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

  public async proposeCommands(
    input: ProposeCommandsInput,
    client?: TrustedClientContext | undefined,
  ): Promise<ProposalResult> {
    try {
      const trustedClient = this.#requireClient(client);
      const snapshot = this.#assertEditable(input.documentId);
      this.#reserveProposalSlot();
      try {
        const metadata = {
          transactionId: randomUUID(),
          actorId: trustedClient.actorId,
          origin: 'agent' as const,
          label: input.label,
          timestamp: new Date(this.#nowMs()).toISOString(),
        };
        const preview = applyTransaction(snapshot.document, input.commands, {
          expectedRevision: input.expectedRevision,
          metadata,
        });
        const requiresApproval = commandsRequireApproval(input.commands, {
          before: snapshot.document,
          after: preview.document,
        });
        const proposal = this.#runtime.propose(snapshot.sessionId, {
          expectedRevision: input.expectedRevision,
          commands: input.commands,
          metadata,
        });
        const expiresAtMs = Date.parse(proposal.expiresAt);
        const now = this.#nowMs();
        if (
          !Number.isFinite(expiresAtMs) ||
          expiresAtMs <= now ||
          expiresAtMs > now + MCP_LIMITS.proposalTtlMs
        ) {
          throw new McpSafeError('SERVICE_UNAVAILABLE', 'Proposal expiration is invalid.');
        }
        this.#proposals.set(proposal.proposalId, {
          sessionId: snapshot.sessionId,
          documentId: input.documentId,
          clientId: trustedClient.clientId,
          requiresApproval,
          commandCount: input.commands.length,
          expiresAtMs,
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
      } finally {
        this.#proposalReservations -= 1;
      }
    } catch (error) {
      return asSafeError(error);
    }
  }

  public async proposeDesignOperations(
    input: ProposeDesignOperationsInput,
    client?: TrustedClientContext | undefined,
  ): Promise<ProposalResult> {
    try {
      const trustedClient = this.#requireClient(client);
      const snapshot = this.#assertEditable(input.documentId);
      const commands = designOperationsToCommands(snapshot.document, input.operations);
      return await this.proposeCommands(
        {
          documentId: input.documentId,
          expectedRevision: input.expectedRevision,
          label: input.label,
          commands: [...commands],
        },
        trustedClient,
      );
    } catch (error) {
      return asSafeError(error);
    }
  }

  public async commitProposal(
    input: CommitProposalInput,
    client?: TrustedClientContext | undefined,
  ): Promise<CommitProposalResult> {
    const trustedClient = this.#requireClient(client);
    this.#purgeExpired();
    const proposal = this.#proposals.get(input.proposalId);
    if (proposal === undefined)
      throw new McpSafeError('NOT_FOUND', 'Proposal is missing or expired.');
    if (proposal.clientId !== trustedClient.clientId) {
      throw new McpSafeError('MCP_UNAUTHORIZED', 'The proposal belongs to another client.');
    }
    try {
      this.#assertEditable(proposal.documentId);
      if (proposal.requiresApproval) {
        this.#takeReceipt(
          input.approvalId,
          proposal.documentId,
          'commit-destructive',
          trustedClient.clientId,
        );
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

  public async undoAgentTransaction(
    input: TransactionTargetInput,
    client?: TrustedClientContext | undefined,
  ): Promise<CommitProposalResult> {
    try {
      const trustedClient = this.#requireClient(client);
      const snapshot = this.#assertEditable(input.documentId);
      this.#takeReceipt(undefined, input.documentId, 'undo', trustedClient.clientId);
      if (snapshot.revision !== input.expectedRevision) {
        throw new McpSafeError('REVISION_CONFLICT', 'The presentation changed before undo.');
      }
      const audit = this.#runtime
        .getAgentAudit(snapshot.sessionId)
        .find((entry) => entry.transactionId === input.transactionId);
      if (audit === undefined || audit.actorId !== trustedClient.actorId) {
        throw new McpSafeError('MCP_UNAUTHORIZED', 'The transaction belongs to another client.');
      }
      const after = await this.#runtime.undoAgentTransaction(
        snapshot.sessionId,
        input.transactionId,
        {
          expectedRevision: input.expectedRevision,
          metadata: {
            transactionId: randomUUID(),
            actorId: trustedClient.actorId,
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

  public async importAsset(
    input: ImportAssetInput,
    client?: TrustedClientContext | undefined,
  ): Promise<SafeRecord> {
    try {
      const trustedClient = this.#requireClient(client);
      const receipt = this.#takeReceipt(
        input.approvalId,
        input.documentId,
        'import',
        trustedClient.clientId,
      );
      const snapshot = this.#assertEditable(input.documentId);
      return await this.#options.importAsset(
        snapshot.sessionId,
        receipt.baseRevision,
        trustedClient,
      );
    } catch (error) {
      return asSafeError(error);
    }
  }

  public async exportDocument(
    input: ExportDocumentInput,
    client?: TrustedClientContext | undefined,
  ): Promise<SafeRecord> {
    try {
      const trustedClient = this.#requireClient(client);
      this.#takeReceipt(
        input.approvalId,
        input.documentId,
        input.format === 'html' ? 'export-html' : 'export-pdf',
        trustedClient.clientId,
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

  #requireClient(client: TrustedClientContext | undefined): TrustedClientContext {
    if (client === undefined) {
      throw new McpSafeError('MCP_UNAUTHORIZED', 'A trusted MCP client is required.');
    }
    return client;
  }
}
