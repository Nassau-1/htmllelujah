import { z } from 'zod';

import { DOCUMENT_LIMITS } from './limits.js';
import type {
  AssetRef,
  BackgroundStyle,
  ConnectorEndpoint,
  ElementStylePatch,
  Layout,
  Master,
  PageSize,
  RichTextDocument,
  Slide,
  TableBorder,
  TableCell,
  TableCellStyle,
  TableStyle,
  Theme,
} from './model.js';
import {
  assetSchema,
  backgroundStyleSchema,
  identifierSchema,
  layoutSchema,
  masterSchema,
  richTextDocumentSchema,
  slideSchema,
  tableCellSchema,
  textStyleOverridesSchema,
  themeSchema,
} from './schemas.js';

interface ContainerTarget {
  readonly containerId?: string | undefined;
}

export interface RenameDeckCommand {
  readonly type: 'deck.rename';
  readonly name: string;
}

export interface SetDeckPageCommand {
  readonly type: 'deck.set-page';
  readonly page: PageSize;
}

export interface SetDeckExportOptionsCommand {
  readonly type: 'deck.set-export-options';
  readonly includeHiddenSlidesInExport: boolean;
}

export interface CreateThemeCommand {
  readonly type: 'theme.create';
  readonly theme: Theme;
  readonly index?: number | undefined;
}

export interface UpdateThemeCommand {
  readonly type: 'theme.update';
  readonly themeId: string;
  readonly replacement: Theme;
}

/** Applies one existing theme across every theme-managed design surface in the deck. */
export interface EnforceDeckThemeCommand {
  readonly type: 'theme.enforce-deck';
  readonly themeId: string;
}

export interface DeleteThemeCommand {
  readonly type: 'theme.delete';
  readonly themeId: string;
  readonly replacementThemeId?: string | undefined;
}

export interface CreateMasterCommand {
  readonly type: 'master.create';
  readonly master: Master;
  readonly index?: number | undefined;
}

export interface UpdateMasterCommand {
  readonly type: 'master.update';
  readonly masterId: string;
  readonly replacement: Master;
}

export interface DeleteMasterCommand {
  readonly type: 'master.delete';
  readonly masterId: string;
  readonly replacementMasterId?: string | undefined;
}

export interface CreateLayoutCommand {
  readonly type: 'layout.create';
  readonly layout: Layout;
  readonly index?: number | undefined;
}

export interface UpdateLayoutCommand {
  readonly type: 'layout.update';
  readonly layoutId: string;
  readonly replacement: Layout;
}

export interface DeleteLayoutCommand {
  readonly type: 'layout.delete';
  readonly layoutId: string;
  readonly replacementLayoutId?: string | undefined;
}

export interface DuplicateSlideCommand {
  readonly type: 'slide.duplicate';
  readonly slideId: string;
  /** A complete deterministic copy with fresh identifiers. */
  readonly duplicate: Slide;
  readonly index?: number | undefined;
}

export interface UpdateSlideCommand {
  readonly type: 'slide.update';
  readonly slideId: string;
  readonly name?: string | undefined;
  /** null removes the slide-level override. */
  readonly background?: BackgroundStyle | null | undefined;
}

export interface SetSlideLayoutCommand {
  readonly type: 'slide.set-layout';
  readonly slideId: string;
  readonly layoutId: string;
}

export interface ResetSlidePlaceholderCommand {
  readonly type: 'slide.reset-placeholder';
  readonly slideId: string;
  readonly placeholderId: string;
}

export interface SetSlideHiddenCommand {
  readonly type: 'slide.set-hidden';
  readonly slideId: string;
  readonly hidden: boolean;
}

export interface UpdateElementStyleCommand extends ContainerTarget {
  readonly type: 'element.update-style';
  readonly slideId: string;
  readonly elementId: string;
  readonly patch: ElementStylePatch;
}

export interface SetElementLockedCommand extends ContainerTarget {
  readonly type: 'element.set-locked';
  readonly slideId: string;
  readonly elementId: string;
  readonly locked: boolean;
}

export interface SetElementVisibleCommand extends ContainerTarget {
  readonly type: 'element.set-visible';
  readonly slideId: string;
  readonly elementId: string;
  readonly visible: boolean;
}

export interface ReorderElementCommand extends ContainerTarget {
  readonly type: 'element.reorder';
  readonly slideId: string;
  readonly elementId: string;
  readonly toIndex: number;
}

export interface ReplaceTextContentCommand extends ContainerTarget {
  readonly type: 'text.replace-content';
  readonly slideId: string;
  readonly textId: string;
  readonly content: RichTextDocument;
}

interface TableTarget extends ContainerTarget {
  readonly slideId: string;
  readonly tableId: string;
}

export interface InsertTableRowCommand extends TableTarget {
  readonly type: 'table.insert-row';
  readonly index: number;
  readonly heightPt: number;
  /** One fresh, single-span cell for every existing column. */
  readonly cells: readonly TableCell[];
}

export interface DeleteTableRowCommand extends TableTarget {
  readonly type: 'table.delete-row';
  readonly index: number;
}

export interface InsertTableColumnCommand extends TableTarget {
  readonly type: 'table.insert-column';
  readonly index: number;
  readonly widthPt: number;
  /** One fresh, single-span cell for every existing row. */
  readonly cells: readonly TableCell[];
}

export interface DeleteTableColumnCommand extends TableTarget {
  readonly type: 'table.delete-column';
  readonly index: number;
}

export interface UpdateTableCellCommand extends TableTarget {
  readonly type: 'table.update-cell';
  readonly cellId: string;
  readonly content?: RichTextDocument | undefined;
  readonly style?: TableCellStyle | undefined;
}

export interface UpdateTableStyleCommand extends TableTarget {
  readonly type: 'table.update-style';
  readonly border?: TableBorder | undefined;
  readonly style?: TableStyle | null | undefined;
}

export interface PasteTableTsvCommand extends TableTarget {
  readonly type: 'table.paste-tsv';
  readonly startRow: number;
  readonly startColumn: number;
  readonly tsv: string;
}

export interface RegisterAssetCommand {
  readonly type: 'asset.register';
  readonly asset: AssetRef;
}

export interface RemoveAssetCommand {
  readonly type: 'asset.remove';
  readonly assetId: string;
}

export interface UpdateConnectorEndpointCommand extends ContainerTarget {
  readonly type: 'connector.update-endpoint';
  readonly slideId: string;
  readonly connectorId: string;
  readonly endpoint: 'start' | 'end';
  readonly value: ConnectorEndpoint;
}

export type V1DocumentCommand =
  | RenameDeckCommand
  | SetDeckPageCommand
  | SetDeckExportOptionsCommand
  | CreateThemeCommand
  | UpdateThemeCommand
  | EnforceDeckThemeCommand
  | DeleteThemeCommand
  | CreateMasterCommand
  | UpdateMasterCommand
  | DeleteMasterCommand
  | CreateLayoutCommand
  | UpdateLayoutCommand
  | DeleteLayoutCommand
  | DuplicateSlideCommand
  | UpdateSlideCommand
  | SetSlideLayoutCommand
  | ResetSlidePlaceholderCommand
  | SetSlideHiddenCommand
  | UpdateElementStyleCommand
  | SetElementLockedCommand
  | SetElementVisibleCommand
  | ReorderElementCommand
  | ReplaceTextContentCommand
  | InsertTableRowCommand
  | DeleteTableRowCommand
  | InsertTableColumnCommand
  | DeleteTableColumnCommand
  | UpdateTableCellCommand
  | UpdateTableStyleCommand
  | PasteTableTsvCommand
  | RegisterAssetCommand
  | RemoveAssetCommand
  | UpdateConnectorEndpointCommand;

const id = identifierSchema;
const name = z.string().trim().min(1).max(DOCUMENT_LIMITS.maxNameLength);
const index = z.number().int().min(0);
const positivePt = z.number().finite().positive().max(DOCUMENT_LIMITS.maxFrameDimensionPt);
const container = { containerId: id.optional() } as const;
const tableTarget = { ...container, slideId: id, tableId: id } as const;

const pageSchema = z
  .object({
    widthPt: positivePt.max(DOCUMENT_LIMITS.maxPageDimensionPt),
    heightPt: positivePt.max(DOCUMENT_LIMITS.maxPageDimensionPt),
  })
  .strict();

const color = z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/);
const stroke = z
  .object({
    color,
    widthPt: z.number().finite().min(0),
    dash: z.enum(['solid', 'dash', 'dot']),
  })
  .strict();
const shadow = z
  .object({
    color,
    blurPt: z.number().finite().min(0).max(1_000),
    offsetXPt: z.number().finite().min(-10_000).max(10_000),
    offsetYPt: z.number().finite().min(-10_000).max(10_000),
    opacity: z.number().finite().min(0).max(1),
  })
  .strict();
const tableStyle = z
  .object({
    fill: color.nullable().optional(),
    headerFill: color.nullable().optional(),
    bandedRows: z.boolean().optional(),
    cellPaddingPt: z.number().finite().min(0).max(100).optional(),
  })
  .strict();
const tableBorder = z.object({ color, widthPt: z.number().finite().min(0) }).strict();
const tableCellStyle = z
  .object({
    fill: color.nullable(),
    textColor: color,
    horizontalAlignment: z.enum(['left', 'center', 'right', 'justify']),
    verticalAlignment: z.enum(['top', 'middle', 'bottom']),
    paddingPt: z.number().finite().min(0).max(100).optional(),
  })
  .strict();
const connectorEndpoint = z
  .object({
    xPt: z.number().finite(),
    yPt: z.number().finite(),
    binding: z
      .object({
        elementId: id.optional(),
        anchor: z.enum(['top', 'right', 'bottom', 'left', 'center']).optional(),
      })
      .strict(),
  })
  .strict();

const stylePatch = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('text'),
      opacity: z.number().finite().min(0).max(1).optional(),
      style: textStyleOverridesSchema.optional(),
      verticalAlignment: z.enum(['top', 'middle', 'bottom']).optional(),
      styleRole: z.enum(['title', 'subtitle', 'body', 'caption', 'label', 'quote']).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('shape'),
      opacity: z.number().finite().min(0).max(1).optional(),
      fill: color.nullable().optional(),
      stroke: stroke.optional(),
      cornerRadiusPt: z.number().finite().min(0).optional(),
      shadow: shadow.nullable().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('table'),
      opacity: z.number().finite().min(0).max(1).optional(),
      border: tableBorder.optional(),
      style: tableStyle.optional(),
    })
    .strict(),
]);

const updateCell = z
  .object({
    type: z.literal('table.update-cell'),
    ...tableTarget,
    cellId: id,
    content: richTextDocumentSchema.optional(),
    style: tableCellStyle.optional(),
  })
  .strict()
  .refine((command) => command.content !== undefined || command.style !== undefined, {
    message: 'A cell update needs content or style.',
  });

const updateTableStyle = z
  .object({
    type: z.literal('table.update-style'),
    ...tableTarget,
    border: tableBorder.optional(),
    style: tableStyle.nullable().optional(),
  })
  .strict()
  .refine((command) => command.border !== undefined || command.style !== undefined, {
    message: 'A table style update needs border or style.',
  });

export const v1DocumentCommandSchema: z.ZodType<V1DocumentCommand> = z.union([
  z.object({ type: z.literal('deck.rename'), name }).strict(),
  z.object({ type: z.literal('deck.set-page'), page: pageSchema }).strict(),
  z
    .object({
      type: z.literal('deck.set-export-options'),
      includeHiddenSlidesInExport: z.boolean(),
    })
    .strict(),
  z
    .object({ type: z.literal('theme.create'), theme: themeSchema, index: index.optional() })
    .strict(),
  z.object({ type: z.literal('theme.update'), themeId: id, replacement: themeSchema }).strict(),
  z.object({ type: z.literal('theme.enforce-deck'), themeId: id }).strict(),
  z
    .object({ type: z.literal('theme.delete'), themeId: id, replacementThemeId: id.optional() })
    .strict(),
  z
    .object({ type: z.literal('master.create'), master: masterSchema, index: index.optional() })
    .strict(),
  z.object({ type: z.literal('master.update'), masterId: id, replacement: masterSchema }).strict(),
  z
    .object({ type: z.literal('master.delete'), masterId: id, replacementMasterId: id.optional() })
    .strict(),
  z
    .object({ type: z.literal('layout.create'), layout: layoutSchema, index: index.optional() })
    .strict(),
  z.object({ type: z.literal('layout.update'), layoutId: id, replacement: layoutSchema }).strict(),
  z
    .object({ type: z.literal('layout.delete'), layoutId: id, replacementLayoutId: id.optional() })
    .strict(),
  z
    .object({
      type: z.literal('slide.duplicate'),
      slideId: id,
      duplicate: slideSchema,
      index: index.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('slide.update'),
      slideId: id,
      name: name.optional(),
      background: backgroundStyleSchema.nullable().optional(),
    })
    .strict()
    .refine((command) => command.name !== undefined || command.background !== undefined, {
      message: 'A slide update needs name or background.',
    }),
  z.object({ type: z.literal('slide.set-layout'), slideId: id, layoutId: id }).strict(),
  z.object({ type: z.literal('slide.reset-placeholder'), slideId: id, placeholderId: id }).strict(),
  z.object({ type: z.literal('slide.set-hidden'), slideId: id, hidden: z.boolean() }).strict(),
  z
    .object({
      type: z.literal('element.update-style'),
      ...container,
      slideId: id,
      elementId: id,
      patch: stylePatch,
    })
    .strict(),
  z
    .object({
      type: z.literal('element.set-locked'),
      ...container,
      slideId: id,
      elementId: id,
      locked: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal('element.set-visible'),
      ...container,
      slideId: id,
      elementId: id,
      visible: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal('element.reorder'),
      ...container,
      slideId: id,
      elementId: id,
      toIndex: index,
    })
    .strict(),
  z
    .object({
      type: z.literal('text.replace-content'),
      ...container,
      slideId: id,
      textId: id,
      content: richTextDocumentSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('table.insert-row'),
      ...tableTarget,
      index,
      heightPt: positivePt,
      cells: z.array(tableCellSchema).min(1).max(DOCUMENT_LIMITS.maxTableColumns),
    })
    .strict(),
  z.object({ type: z.literal('table.delete-row'), ...tableTarget, index }).strict(),
  z
    .object({
      type: z.literal('table.insert-column'),
      ...tableTarget,
      index,
      widthPt: positivePt,
      cells: z.array(tableCellSchema).min(1).max(DOCUMENT_LIMITS.maxTableRows),
    })
    .strict(),
  z.object({ type: z.literal('table.delete-column'), ...tableTarget, index }).strict(),
  updateCell,
  updateTableStyle,
  z
    .object({
      type: z.literal('table.paste-tsv'),
      ...tableTarget,
      startRow: index,
      startColumn: index,
      tsv: z.string().min(1).max(DOCUMENT_LIMITS.maxTsvLength),
    })
    .strict(),
  z.object({ type: z.literal('asset.register'), asset: assetSchema }).strict(),
  z.object({ type: z.literal('asset.remove'), assetId: id }).strict(),
  z
    .object({
      type: z.literal('connector.update-endpoint'),
      ...container,
      slideId: id,
      connectorId: id,
      endpoint: z.enum(['start', 'end']),
      value: connectorEndpoint,
    })
    .strict(),
]);
