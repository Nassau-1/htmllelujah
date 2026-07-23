import {
  DOCUMENT_LIMITS,
  documentCommandSchema,
  layoutSchema,
  masterSchema,
  themeSchema,
  type DeckDocument,
  type DocumentCommand,
  type Element,
} from '@htmllelujah/document-core';
import { z } from 'zod';

export const MCP_LIMITS = Object.freeze({
  maxCommands: 100,
  maxLabelLength: 160,
  maxResultBytes: 2 * 1024 * 1024,
  maxFrameBytes: 2 * 1024 * 1024,
  proposalTtlMs: 5 * 60 * 1000,
  maxPendingProposals: 64,
  maxPendingApprovals: 32,
  maxApprovalReceipts: 64,
  maxDesignOperations: 20,
  maxDesignContextPageSize: 500,
});

export const identifierSchema = z.string().uuid();
export const revisionSchema = z.string().min(1).max(160);
export const approvalIdSchema = z.string().min(16).max(256);

export const documentTargetSchema = z.object({ documentId: identifierSchema }).strict();

export const slideTargetSchema = z
  .object({ documentId: identifierSchema, slideId: identifierSchema })
  .strict();

const designContextPageSizeSchema = z
  .number()
  .int()
  .min(1)
  .max(MCP_LIMITS.maxDesignContextPageSize)
  .default(250);

export const designContextSchema = z
  .object({
    documentId: identifierSchema,
    slideId: identifierSchema.optional(),
    elementScope: z
      .enum(['selected-projection', 'all-authoritative'])
      .default('selected-projection'),
    elementOffset: z.number().int().min(0).max(DOCUMENT_LIMITS.maxElements).default(0),
    elementLimit: designContextPageSizeSchema,
    assetOffset: z.number().int().min(0).max(DOCUMENT_LIMITS.maxAssets).default(0),
    assetLimit: z.number().int().min(1).max(250).default(100),
  })
  .strict();

export const proposeCommandsSchema = z
  .object({
    documentId: identifierSchema,
    expectedRevision: revisionSchema,
    label: z.string().trim().min(1).max(MCP_LIMITS.maxLabelLength),
    commands: z.array(documentCommandSchema).min(1).max(MCP_LIMITS.maxCommands),
  })
  .strict();

const pageSchema = z
  .object({
    widthPt: z.number().finite().positive().max(DOCUMENT_LIMITS.maxPageDimensionPt),
    heightPt: z.number().finite().positive().max(DOCUMENT_LIMITS.maxPageDimensionPt),
  })
  .strict();

const indexSchema = z.number().int().min(0);
const boundedNameSchema = z.string().trim().min(1).max(DOCUMENT_LIMITS.maxNameLength);
const colorPatchSchema = themeSchema.shape.colors.partial().strict();
const themePatchSchema = z
  .object({
    name: boundedNameSchema.optional(),
    colors: colorPatchSchema.optional(),
    headingFontFamily: themeSchema.shape.headingFontFamily.optional(),
    bodyFontFamily: themeSchema.shape.bodyFontFamily.optional(),
    textStyles: themeSchema.shape.textStyles.optional(),
  })
  .strict()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: 'A theme update needs at least one field.',
  });
const masterPatchSchema = z
  .object({
    name: boundedNameSchema.optional(),
    themeId: identifierSchema.optional(),
    elements: masterSchema.shape.elements.optional(),
    guides: masterSchema.shape.guides.optional(),
    background: masterSchema.shape.background.nullable().optional(),
  })
  .strict()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: 'A master update needs at least one field.',
  });
const layoutPatchSchema = z
  .object({
    name: boundedNameSchema.optional(),
    masterId: identifierSchema.optional(),
    elements: layoutSchema.shape.elements.optional(),
    guides: layoutSchema.shape.guides.optional(),
    background: layoutSchema.shape.background.nullable().optional(),
  })
  .strict()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: 'A layout update needs at least one field.',
  });

export const designOperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('page.set'), page: pageSchema }).strict(),
  z
    .object({ type: z.literal('theme.create'), theme: themeSchema, index: indexSchema.optional() })
    .strict(),
  z
    .object({
      type: z.literal('theme.update'),
      themeId: identifierSchema,
      patch: themePatchSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('theme.delete'),
      themeId: identifierSchema,
      replacementThemeId: identifierSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal('theme.enforce-deck'), themeId: identifierSchema }).strict(),
  z
    .object({
      type: z.literal('master.create'),
      master: masterSchema,
      index: indexSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('master.update'),
      masterId: identifierSchema,
      patch: masterPatchSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('master.delete'),
      masterId: identifierSchema,
      replacementMasterId: identifierSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('layout.create'),
      layout: layoutSchema,
      index: indexSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('layout.update'),
      layoutId: identifierSchema,
      patch: layoutPatchSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('layout.delete'),
      layoutId: identifierSchema,
      replacementLayoutId: identifierSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('slide.set-layout'),
      slideId: identifierSchema,
      layoutId: identifierSchema,
    })
    .strict(),
]);

export const proposeDesignOperationsSchema = z
  .object({
    documentId: identifierSchema,
    expectedRevision: revisionSchema,
    label: z.string().trim().min(1).max(MCP_LIMITS.maxLabelLength),
    operations: z.array(designOperationSchema).min(1).max(MCP_LIMITS.maxDesignOperations),
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
export type DesignContextInput = z.infer<typeof designContextSchema>;
export type DesignOperation = z.infer<typeof designOperationSchema>;
export type ProposeDesignOperationsInput = z.infer<typeof proposeDesignOperationsSchema>;
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

const ALWAYS_APPROVAL_REQUIRED_COMMANDS = new Set<DocumentCommand['type']>([
  'slide.delete',
  'element.delete',
  'theme.delete',
  'master.delete',
  'layout.delete',
  'asset.remove',
  'table.delete-row',
  'table.delete-column',
  'slide.set-layout',
  'slide.reset-placeholder',
  'deck.set-page',
]);

const STRUCTURAL_REPLACEMENT_COMMANDS = new Set<DocumentCommand['type']>([
  'theme.update',
  'master.update',
  'layout.update',
  'element.update',
]);

export interface ApprovalClassificationContext {
  readonly before: DeckDocument;
  readonly after: DeckDocument;
}

interface ElementIdentity {
  readonly type: Element['type'];
  readonly owner: string;
  readonly parentId?: string | undefined;
  readonly placeholderId?: string | undefined;
  readonly placeholderRole?: string | undefined;
  readonly placeholderAccepts?: string | undefined;
  readonly rowCount?: number | undefined;
  readonly columnCount?: number | undefined;
  readonly cellIds?: ReadonlySet<string> | undefined;
}

const collectElementIdentities = (
  elements: readonly Element[],
  owner: string,
  output: Map<string, ElementIdentity>,
  parentId?: string | undefined,
): void => {
  for (const element of elements) {
    output.set(element.id, {
      type: element.type,
      owner,
      ...(parentId === undefined ? {} : { parentId }),
      ...(element.placeholderBinding === undefined
        ? {}
        : { placeholderId: element.placeholderBinding.placeholderId }),
      ...(element.type === 'placeholder'
        ? {
            placeholderRole: element.role,
            placeholderAccepts: [...element.accepts].sort().join(','),
          }
        : {}),
      ...(element.type === 'table'
        ? {
            rowCount: element.rowCount,
            columnCount: element.columnCount,
            cellIds: new Set(element.cells.map((cell) => cell.id)),
          }
        : {}),
    });
    if (element.type === 'group') {
      collectElementIdentities(element.children, owner, output, element.id);
    }
  }
};

const documentElementIdentities = (
  document: DeckDocument,
): ReadonlyMap<string, ElementIdentity> => {
  const output = new Map<string, ElementIdentity>();
  for (const master of document.masters) {
    collectElementIdentities(master.elements, `master:${master.id}`, output);
  }
  for (const layout of document.layouts) {
    collectElementIdentities(layout.elements, `layout:${layout.id}`, output);
  }
  for (const slide of document.slides) {
    collectElementIdentities(slide.elements, `slide:${slide.id}`, output);
  }
  return output;
};

const containsEvery = (after: ReadonlySet<string>, before: ReadonlySet<string>): boolean => {
  for (const id of before) if (!after.has(id)) return false;
  return true;
};

const replacementRemovedStructure = ({ before, after }: ApprovalClassificationContext): boolean => {
  const collections: ReadonlyArray<
    readonly [readonly { readonly id: string }[], readonly { readonly id: string }[]]
  > = [
    [before.themes, after.themes],
    [before.masters, after.masters],
    [before.layouts, after.layouts],
    [before.slides, after.slides],
    [before.assets, after.assets],
    [
      before.themes.flatMap((theme) => theme.textStyles),
      after.themes.flatMap((theme) => theme.textStyles),
    ],
  ];
  for (const [previous, next] of collections) {
    const nextIds = new Set(next.map((item) => item.id));
    if (previous.some((item) => !nextIds.has(item.id))) return true;
  }
  const nextLayouts = new Map(after.layouts.map((layout) => [layout.id, layout]));
  if (before.layouts.some((layout) => nextLayouts.get(layout.id)?.masterId !== layout.masterId)) {
    return true;
  }

  const previousElements = documentElementIdentities(before);
  const nextElements = documentElementIdentities(after);
  for (const [elementId, previous] of previousElements) {
    const next = nextElements.get(elementId);
    if (
      next === undefined ||
      next.type !== previous.type ||
      next.owner !== previous.owner ||
      next.parentId !== previous.parentId ||
      next.placeholderId !== previous.placeholderId ||
      next.placeholderRole !== previous.placeholderRole ||
      next.placeholderAccepts !== previous.placeholderAccepts
    ) {
      return true;
    }
    if (
      previous.type === 'table' &&
      (next.rowCount! < previous.rowCount! ||
        next.columnCount! < previous.columnCount! ||
        !containsEvery(next.cellIds!, previous.cellIds!))
    ) {
      return true;
    }
  }
  return false;
};

export const commandsRequireApproval = (
  commands: readonly DocumentCommand[],
  context?: ApprovalClassificationContext | undefined,
): boolean => {
  if (commands.some((command) => ALWAYS_APPROVAL_REQUIRED_COMMANDS.has(command.type))) return true;
  if (!commands.some((command) => STRUCTURAL_REPLACEMENT_COMMANDS.has(command.type))) return false;
  // Complete replacements fail closed unless the already-validated simulation proves
  // that no resource, nested element, table structure, or placeholder binding was lost.
  return context === undefined || replacementRemovedStructure(context);
};
