import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { DocumentCommand } from '@htmllelujah/document-core';
import { z } from 'zod';

import {
  commitProposalSchema,
  documentTargetSchema,
  exportDocumentSchema,
  importAssetSchema,
  MCP_LIMITS,
  proposeCommandsSchema,
  slideTargetSchema,
  transactionTargetSchema,
  type CommitProposalInput,
  type CommitProposalResult,
  type ExportDocumentInput,
  type ImportAssetInput,
  type ProposalResult,
  type ProposeCommandsInput,
  type TransactionTargetInput,
} from './contracts.js';

export type SafeRecord = Readonly<Record<string, unknown>>;

export interface HtmllelujahMcpService {
  appStatus(): Promise<SafeRecord>;
  listOpenDocuments(): Promise<readonly SafeRecord[]>;
  getDocumentOutline(documentId: string): Promise<SafeRecord>;
  getSlide(documentId: string, slideId: string): Promise<SafeRecord>;
  getStyleCatalog(documentId: string): Promise<SafeRecord>;
  validateDocument(documentId: string): Promise<SafeRecord>;
  proposeCommands(input: ProposeCommandsInput): Promise<ProposalResult>;
  commitProposal(input: CommitProposalInput): Promise<CommitProposalResult>;
  undoAgentTransaction(input: TransactionTargetInput): Promise<CommitProposalResult>;
  importAsset(input: ImportAssetInput): Promise<SafeRecord>;
  exportDocument(input: ExportDocumentInput): Promise<SafeRecord>;
  collaborationStatus(documentId: string): Promise<SafeRecord>;
}

export interface McpPermissionGate {
  canRead(documentId: string): Promise<boolean> | boolean;
  canEdit(documentId: string): Promise<boolean> | boolean;
  consumeApproval(input: {
    readonly approvalId: string;
    readonly documentId: string;
    readonly action: 'commit-destructive' | 'undo' | 'import' | 'export-html' | 'export-pdf';
  }): Promise<boolean> | boolean;
}

export class McpSafeError extends Error {
  public constructor(
    public readonly code:
      | 'MCP_UNAUTHORIZED'
      | 'APPROVAL_REQUIRED'
      | 'APPROVAL_EXPIRED'
      | 'REVISION_CONFLICT'
      | 'NOT_FOUND'
      | 'INVALID_REQUEST'
      | 'SERVICE_UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'McpSafeError';
  }
}

const assertRead = async (permissions: McpPermissionGate, documentId: string): Promise<void> => {
  if (!(await permissions.canRead(documentId))) {
    throw new McpSafeError('MCP_UNAUTHORIZED', 'Read access is not granted for this document.');
  }
};

const assertEdit = async (permissions: McpPermissionGate, documentId: string): Promise<void> => {
  if (!(await permissions.canEdit(documentId))) {
    throw new McpSafeError('MCP_UNAUTHORIZED', 'Edit access is not granted for this document.');
  }
};

const consumeApproval = async (
  permissions: McpPermissionGate,
  input: Parameters<McpPermissionGate['consumeApproval']>[0],
): Promise<void> => {
  if (!(await permissions.consumeApproval(input))) {
    throw new McpSafeError(
      'APPROVAL_EXPIRED',
      'Desktop approval is missing, expired, or already used.',
    );
  }
};

const safeError = (error: unknown): { readonly code: string; readonly message: string } => {
  if (error instanceof McpSafeError) return { code: error.code, message: error.message };
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { readonly code?: unknown }).code === 'string'
  ) {
    const code = (error as { readonly code: string }).code;
    const allowed = new Set([
      'REVISION_CONFLICT',
      'NOT_FOUND',
      'LOCKED',
      'READ_ONLY',
      'TEXT_LOCKED',
      'RENDER_NOT_READY',
      'TARGET_CHANGED',
    ]);
    if (allowed.has(code))
      return { code, message: 'The requested operation could not be completed.' };
  }
  return { code: 'SERVICE_UNAVAILABLE', message: 'The local document service is unavailable.' };
};

const encodeResult = (value: unknown): string => {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > MCP_LIMITS.maxResultBytes) {
    throw new McpSafeError('INVALID_REQUEST', 'The result exceeds the MCP response limit.');
  }
  return text;
};

const toolResult = async (operation: () => Promise<unknown>) => {
  try {
    const value = await operation();
    return { content: [{ type: 'text' as const, text: encodeResult(value) }] };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: encodeResult({ error: safeError(error) }) }],
    };
  }
};

export const createHtmllelujahMcpServer = (
  service: HtmllelujahMcpService,
  permissions: McpPermissionGate,
): McpServer => {
  const server = new McpServer({ name: 'htmllelujah', version: '1.0.0' });
  const proposals = new Map<
    string,
    {
      readonly documentId: string;
      readonly requiresApproval: boolean;
      readonly expiresAtMs: number;
    }
  >();
  let proposalReservations = 0;

  const purgeExpiredProposals = (now = Date.now()): void => {
    for (const [id, proposal] of proposals) {
      if (proposal.expiresAtMs <= now) proposals.delete(id);
    }
  };

  const reserveProposalSlot = (): void => {
    purgeExpiredProposals();
    if (proposals.size + proposalReservations >= MCP_LIMITS.maxPendingProposals) {
      throw new McpSafeError(
        'INVALID_REQUEST',
        'Too many proposals are pending; commit one or wait for expiry.',
      );
    }
    proposalReservations += 1;
  };

  const registerProposal = (proposal: ProposalResult): void => {
    const now = Date.now();
    const expiresAtMs = Date.parse(proposal.expiresAt);
    if (
      !Number.isFinite(expiresAtMs) ||
      expiresAtMs <= now ||
      expiresAtMs > now + MCP_LIMITS.proposalTtlMs
    ) {
      throw new McpSafeError('SERVICE_UNAVAILABLE', 'Proposal expiration is invalid.');
    }
    if (proposals.has(proposal.proposalId)) {
      throw new McpSafeError('SERVICE_UNAVAILABLE', 'Proposal identity is not unique.');
    }
    proposals.set(proposal.proposalId, {
      documentId: proposal.documentId,
      requiresApproval: proposal.requiresApproval,
      expiresAtMs,
    });
  };

  server.registerTool(
    'app_status',
    {
      title: 'HTMLlelujah application status',
      description: 'Return safe local application status without paths or document content.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => toolResult(() => service.appStatus()),
  );

  server.registerTool(
    'documents_list',
    {
      title: 'List open presentations',
      description: 'List presentations currently open and explicitly visible to this MCP session.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => toolResult(() => service.listOpenDocuments()),
  );

  server.registerTool(
    'documents_get_outline',
    {
      title: 'Get presentation outline',
      description: 'Read slide IDs, titles, ordering, and the current document revision.',
      inputSchema: documentTargetSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ documentId }) =>
      toolResult(async () => {
        await assertRead(permissions, documentId);
        return service.getDocumentOutline(documentId);
      }),
  );

  server.registerTool(
    'slides_get',
    {
      title: 'Read a slide',
      description: 'Read the structured content of one slide at the current revision.',
      inputSchema: slideTargetSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ documentId, slideId }) =>
      toolResult(async () => {
        await assertRead(permissions, documentId);
        return service.getSlide(documentId, slideId);
      }),
  );

  server.registerTool(
    'documents_get_styles',
    {
      title: 'Get presentation style catalog',
      description: 'Read available themes, layouts, text roles, icons, and page settings.',
      inputSchema: documentTargetSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ documentId }) =>
      toolResult(async () => {
        await assertRead(permissions, documentId);
        return service.getStyleCatalog(documentId);
      }),
  );

  server.registerTool(
    'documents_validate',
    {
      title: 'Validate presentation',
      description:
        'Validate structure, references, assets, and renderability without changing the deck.',
      inputSchema: documentTargetSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ documentId }) =>
      toolResult(async () => {
        await assertRead(permissions, documentId);
        return service.validateDocument(documentId);
      }),
  );

  server.registerTool(
    'documents_propose_commands',
    {
      title: 'Propose presentation edits',
      description:
        'Validate typed document commands on a copy and return a revision-bound proposal.',
      inputSchema: proposeCommandsSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) =>
      toolResult(async () => {
        reserveProposalSlot();
        try {
          await assertRead(permissions, input.documentId);
          await assertEdit(permissions, input.documentId);
          const proposal = await service.proposeCommands(input);
          registerProposal(proposal);
          return proposal;
        } finally {
          proposalReservations -= 1;
        }
      }),
  );

  server.registerTool(
    'documents_commit_proposal',
    {
      title: 'Commit proposed presentation edits',
      description: 'Commit a non-expired proposal if the document revision still matches.',
      inputSchema: commitProposalSchema,
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async (input) =>
      toolResult(async () => {
        purgeExpiredProposals();
        const proposal = proposals.get(input.proposalId);
        if (proposal === undefined) {
          throw new McpSafeError('NOT_FOUND', 'Proposal is missing or expired.');
        }
        await assertEdit(permissions, proposal.documentId);
        if (proposal.requiresApproval) {
          if (input.approvalId === undefined) {
            throw new McpSafeError('APPROVAL_REQUIRED', 'Desktop approval is required.');
          }
          await consumeApproval(permissions, {
            approvalId: input.approvalId,
            documentId: proposal.documentId,
            action: 'commit-destructive',
          });
        }
        const result = await service.commitProposal(input);
        proposals.delete(input.proposalId);
        return result;
      }),
  );

  server.registerTool(
    'documents_undo_agent_transaction',
    {
      title: 'Undo an agent transaction',
      description: 'Undo one attributable agent transaction at the expected current revision.',
      inputSchema: transactionTargetSchema
        .extend({ approvalId: z.string().min(16).max(256) })
        .strict(),
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ approvalId, ...input }) =>
      toolResult(async () => {
        await assertEdit(permissions, input.documentId);
        await consumeApproval(permissions, {
          approvalId,
          documentId: input.documentId,
          action: 'undo',
        });
        return service.undoAgentTransaction(input);
      }),
  );

  server.registerTool(
    'assets_request_import',
    {
      title: 'Import an image selected in the desktop app',
      description: 'Use a one-time desktop approval to import validated local image bytes.',
      inputSchema: importAssetSchema,
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async (input) =>
      toolResult(async () => {
        await assertEdit(permissions, input.documentId);
        await consumeApproval(permissions, {
          approvalId: input.approvalId,
          documentId: input.documentId,
          action: 'import',
        });
        return service.importAsset(input);
      }),
  );

  server.registerTool(
    'documents_request_export',
    {
      title: 'Export a presentation',
      description: 'Use a one-time desktop approval to export standalone HTML or PDF.',
      inputSchema: exportDocumentSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) =>
      toolResult(async () => {
        await assertRead(permissions, input.documentId);
        await consumeApproval(permissions, {
          approvalId: input.approvalId,
          documentId: input.documentId,
          action: input.format === 'html' ? 'export-html' : 'export-pdf',
        });
        return service.exportDocument(input);
      }),
  );

  server.registerTool(
    'collaboration_status',
    {
      title: 'Get collaboration status',
      description: 'Return safe session, participant-count, writer, and connectivity status.',
      inputSchema: documentTargetSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ documentId }) =>
      toolResult(async () => {
        await assertRead(permissions, documentId);
        return service.collaborationStatus(documentId);
      }),
  );

  return server;
};

export const runHtmllelujahMcpStdio = async (
  service: HtmllelujahMcpService,
  permissions: McpPermissionGate,
): Promise<void> => {
  const server = createHtmllelujahMcpServer(service, permissions);
  await server.connect(new StdioServerTransport());
};

export const affectedSlideIds = (commands: readonly DocumentCommand[]): readonly string[] => [
  ...new Set(commands.flatMap((command) => ('slideId' in command ? [command.slideId] : []))),
];
