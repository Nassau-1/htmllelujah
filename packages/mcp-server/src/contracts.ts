import { documentCommandSchema, type DocumentCommand } from '@htmllelujah/document-core';
import { z } from 'zod';

export const MCP_LIMITS = Object.freeze({
  maxCommands: 100,
  maxLabelLength: 160,
  maxResultBytes: 2 * 1024 * 1024,
  maxFrameBytes: 2 * 1024 * 1024,
  proposalTtlMs: 5 * 60 * 1000,
});

export const identifierSchema = z.string().uuid();
export const revisionSchema = z.string().min(1).max(160);
export const approvalIdSchema = z.string().min(16).max(256);

export const documentTargetSchema = z.object({ documentId: identifierSchema }).strict();

export const slideTargetSchema = z
  .object({ documentId: identifierSchema, slideId: identifierSchema })
  .strict();

export const proposeCommandsSchema = z
  .object({
    documentId: identifierSchema,
    expectedRevision: revisionSchema,
    label: z.string().trim().min(1).max(MCP_LIMITS.maxLabelLength),
    commands: z.array(documentCommandSchema).min(1).max(MCP_LIMITS.maxCommands),
  })
  .strict();

export const commitProposalSchema = z
  .object({
    proposalId: identifierSchema,
    approvalId: approvalIdSchema.optional(),
  })
  .strict();

export const transactionTargetSchema = z
  .object({
    documentId: identifierSchema,
    transactionId: identifierSchema,
    expectedRevision: revisionSchema,
  })
  .strict();

export const importAssetSchema = z
  .object({ documentId: identifierSchema, approvalId: approvalIdSchema })
  .strict();

export const exportDocumentSchema = z
  .object({
    documentId: identifierSchema,
    expectedRevision: revisionSchema,
    format: z.enum(['html', 'pdf']),
    includeHidden: z.boolean().default(false),
    approvalId: approvalIdSchema,
  })
  .strict();

export type ProposeCommandsInput = z.infer<typeof proposeCommandsSchema>;
export type CommitProposalInput = z.infer<typeof commitProposalSchema>;
export type TransactionTargetInput = z.infer<typeof transactionTargetSchema>;
export type ImportAssetInput = z.infer<typeof importAssetSchema>;
export type ExportDocumentInput = z.infer<typeof exportDocumentSchema>;

export interface ProposalResult {
  readonly proposalId: string;
  readonly documentId: string;
  readonly baseRevision: string;
  readonly expiresAt: string;
  readonly requiresApproval: boolean;
  readonly commandCount: number;
  readonly affectedSlideIds: readonly string[];
  readonly warnings: readonly string[];
  readonly summary: string;
}

export interface CommitProposalResult {
  readonly documentId: string;
  readonly transactionId: string;
  readonly previousRevision: string;
  readonly revision: string;
  readonly acceptedCommandCount: number;
}

export const commandsRequireApproval = (commands: readonly DocumentCommand[]): boolean =>
  commands.some((command) => {
    const commandType: string = command.type;
    return ['slide.delete', 'element.delete', 'deck.set-page'].includes(commandType);
  });
