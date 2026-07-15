import { z } from 'zod';

import type { DeckDocument, DeckDocumentV1, Element, Frame, Slide } from './model.js';
import { DOCUMENT_LIMITS } from './limits.js';

const identifierSchema = z.string().uuid();
const nonEmptyStringSchema = z.string().trim().min(1).max(DOCUMENT_LIMITS.maxNameLength);
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/);
const nonNegativeFiniteSchema = z.number().finite().min(0);
const positiveFiniteSchema = z.number().finite().positive();
const boundedFontFamilySchema = z.string().trim().min(1).max(DOCUMENT_LIMITS.maxFontFamilyLength);
const frameCoordinateSchema = z
  .number()
  .finite()
  .min(-DOCUMENT_LIMITS.maxFrameCoordinatePt)
  .max(DOCUMENT_LIMITS.maxFrameCoordinatePt);
const frameDimensionSchema = positiveFiniteSchema.max(DOCUMENT_LIMITS.maxFrameDimensionPt);

export const frameSchema: z.ZodType<Frame> = z
  .object({
    xPt: frameCoordinateSchema,
    yPt: frameCoordinateSchema,
    widthPt: frameDimensionSchema,
    heightPt: frameDimensionSchema,
    rotationDeg: z.number().finite(),
  })
  .strict();

const textAlignmentSchema = z.enum(['left', 'center', 'right', 'justify']);
const textStyleRoleSchema = z.enum(['title', 'subtitle', 'body', 'caption', 'label', 'quote']);

const textMarksSchema = z
  .object({
    bold: z.boolean(),
    italic: z.boolean(),
    underline: z.boolean(),
    strikethrough: z.boolean(),
    color: colorSchema.optional(),
    fontFamily: boundedFontFamilySchema.optional(),
    fontSizePt: positiveFiniteSchema.max(1_000).optional(),
    fontWeight: z.number().int().min(1).max(1_000).optional(),
  })
  .strict();

const textRunSchema = z
  .object({
    text: z.string().max(DOCUMENT_LIMITS.maxTextRunLength),
    marks: textMarksSchema,
  })
  .strict();

const paragraphBlockSchema = z
  .object({
    id: identifierSchema,
    type: z.literal('paragraph'),
    alignment: textAlignmentSchema,
    runs: z.array(textRunSchema).max(DOCUMENT_LIMITS.maxTextRunsPerBlock),
  })
  .strict();

const headingBlockSchema = z
  .object({
    id: identifierSchema,
    type: z.literal('heading'),
    level: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal(6),
    ]),
    alignment: textAlignmentSchema,
    runs: z.array(textRunSchema).max(DOCUMENT_LIMITS.maxTextRunsPerBlock),
  })
  .strict();

const listItemSchema = z
  .object({
    id: identifierSchema,
    level: z.number().int().min(0).max(DOCUMENT_LIMITS.maxListLevel),
    runs: z.array(textRunSchema).max(DOCUMENT_LIMITS.maxTextRunsPerBlock),
  })
  .strict();

const listBlockSchema = z
  .object({
    id: identifierSchema,
    type: z.literal('list'),
    ordered: z.boolean(),
    items: z.array(listItemSchema).min(1).max(DOCUMENT_LIMITS.maxListItems),
  })
  .strict();

const richTextDocumentSchema = z
  .object({
    blocks: z
      .array(
        z.discriminatedUnion('type', [paragraphBlockSchema, headingBlockSchema, listBlockSchema]),
      )
      .max(DOCUMENT_LIMITS.maxRichTextBlocks),
  })
  .strict();

const textStyleOverridesSchema = z
  .object({
    fontFamily: boundedFontFamilySchema.optional(),
    fontSizePt: positiveFiniteSchema.max(1_000).optional(),
    fontWeight: z.number().int().min(1).max(1_000).optional(),
    italic: z.boolean().optional(),
    color: colorSchema.optional(),
    alignment: textAlignmentSchema.optional(),
    lineHeight: positiveFiniteSchema.max(20).optional(),
    letterSpacingPt: z.number().finite().min(-100).max(1_000).optional(),
  })
  .strict();

const placeholderBindingSchema = z
  .object({
    placeholderId: identifierSchema,
    overrides: z.array(z.enum(['frame', 'style', 'visibility'])).max(3),
  })
  .strict()
  .refine((binding) => new Set(binding.overrides).size === binding.overrides.length, {
    message: 'Placeholder overrides must be unique.',
  });

const baseElementShape = {
  id: identifierSchema,
  name: nonEmptyStringSchema,
  frame: frameSchema,
  opacity: z.number().finite().min(0).max(1),
  visible: z.boolean(),
  locked: z.boolean(),
  placeholderBinding: placeholderBindingSchema.optional(),
} as const;

const textElementSchema = z
  .object({
    ...baseElementShape,
    type: z.literal('text'),
    styleRole: textStyleRoleSchema,
    verticalAlignment: z.enum(['top', 'middle', 'bottom']),
    content: richTextDocumentSchema,
    style: textStyleOverridesSchema.optional(),
  })
  .strict();

const imageElementSchema = z
  .object({
    ...baseElementShape,
    type: z.literal('image'),
    assetId: identifierSchema,
    altText: z.string(),
    fit: z.enum(['contain', 'cover', 'fill']),
    crop: z
      .object({
        top: z.number().finite().min(0).max(1),
        right: z.number().finite().min(0).max(1),
        bottom: z.number().finite().min(0).max(1),
        left: z.number().finite().min(0).max(1),
      })
      .strict()
      .refine((crop) => crop.left + crop.right < 1, {
        message: 'Horizontal crop must leave visible content.',
      })
      .refine((crop) => crop.top + crop.bottom < 1, {
        message: 'Vertical crop must leave visible content.',
      }),
  })
  .strict();

const tableCellStyleSchema = z
  .object({
    fill: colorSchema.nullable(),
    textColor: colorSchema,
    horizontalAlignment: textAlignmentSchema,
    verticalAlignment: z.enum(['top', 'middle', 'bottom']),
    paddingPt: nonNegativeFiniteSchema.max(100).optional(),
  })
  .strict();

const tableCellSchema = z
  .object({
    id: identifierSchema,
    row: z.number().int().min(0),
    column: z.number().int().min(0),
    rowSpan: z.number().int().positive(),
    columnSpan: z.number().int().positive(),
    content: richTextDocumentSchema,
    style: tableCellStyleSchema,
  })
  .strict();

const strokeStyleSchema = z
  .object({
    color: colorSchema,
    widthPt: nonNegativeFiniteSchema,
    dash: z.enum(['solid', 'dash', 'dot']),
  })
  .strict();

const tableElementSchema = z
  .object({
    ...baseElementShape,
    type: z.literal('table'),
    rowCount: z.number().int().positive().max(DOCUMENT_LIMITS.maxTableRows),
    columnCount: z.number().int().positive().max(DOCUMENT_LIMITS.maxTableColumns),
    rowHeightsPt: z
      .array(positiveFiniteSchema.max(DOCUMENT_LIMITS.maxFrameDimensionPt))
      .min(1)
      .max(DOCUMENT_LIMITS.maxTableRows),
    columnWidthsPt: z
      .array(positiveFiniteSchema.max(DOCUMENT_LIMITS.maxFrameDimensionPt))
      .min(1)
      .max(DOCUMENT_LIMITS.maxTableColumns),
    cells: z.array(tableCellSchema).min(1).max(DOCUMENT_LIMITS.maxTableCells),
    border: z
      .object({
        color: colorSchema,
        widthPt: nonNegativeFiniteSchema,
      })
      .strict(),
    style: z
      .object({
        fill: colorSchema.nullable().optional(),
        headerFill: colorSchema.nullable().optional(),
        bandedRows: z.boolean().optional(),
        cellPaddingPt: nonNegativeFiniteSchema.max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const shapeElementSchema = z
  .object({
    ...baseElementShape,
    type: z.literal('shape'),
    shape: z.enum([
      'rectangle',
      'rounded-rectangle',
      'ellipse',
      'triangle',
      'diamond',
      'line',
      'arrow',
    ]),
    fill: colorSchema.nullable(),
    stroke: strokeStyleSchema,
    cornerRadiusPt: nonNegativeFiniteSchema,
    shadow: z
      .object({
        color: colorSchema,
        blurPt: nonNegativeFiniteSchema.max(1_000),
        offsetXPt: z.number().finite().min(-10_000).max(10_000),
        offsetYPt: z.number().finite().min(-10_000).max(10_000),
        opacity: z.number().finite().min(0).max(1),
      })
      .strict()
      .optional(),
  })
  .strict();

const connectorBindingSchema = z
  .object({
    elementId: identifierSchema.optional(),
    anchor: z.enum(['top', 'right', 'bottom', 'left', 'center']).optional(),
  })
  .strict();

const connectorEndpointSchema = z
  .object({
    xPt: z.number().finite(),
    yPt: z.number().finite(),
    binding: connectorBindingSchema,
  })
  .strict();

const connectorElementSchema = z
  .object({
    ...baseElementShape,
    type: z.literal('connector'),
    start: connectorEndpointSchema,
    end: connectorEndpointSchema,
    routing: z.enum(['straight', 'elbow']),
    stroke: strokeStyleSchema,
    startCap: z.enum(['none', 'arrow']),
    endCap: z.enum(['none', 'arrow']),
  })
  .strict();

const iconElementSchema = z
  .object({
    ...baseElementShape,
    type: z.literal('icon'),
    iconSet: nonEmptyStringSchema,
    iconName: nonEmptyStringSchema,
    color: colorSchema,
  })
  .strict();

const placeholderElementSchema = z
  .object({
    ...baseElementShape,
    type: z.literal('placeholder'),
    role: z.enum(['title', 'subtitle', 'body', 'media', 'table', 'footer', 'slide-number']),
    accepts: z.array(z.enum(['text', 'image', 'table', 'shape', 'icon'])).min(1),
    prompt: z.string().max(DOCUMENT_LIMITS.maxTextRunLength),
    defaultTextStyle: textStyleOverridesSchema.optional(),
  })
  .strict();

export const elementSchema: z.ZodType<Element> = z.lazy(() =>
  z.discriminatedUnion('type', [
    textElementSchema,
    imageElementSchema,
    tableElementSchema,
    shapeElementSchema,
    connectorElementSchema,
    iconElementSchema,
    placeholderElementSchema,
    z
      .object({
        ...baseElementShape,
        type: z.literal('group'),
        coordinateSpace: z
          .object({
            widthPt: positiveFiniteSchema,
            heightPt: positiveFiniteSchema,
          })
          .strict(),
        children: z.array(elementSchema).min(2).max(DOCUMENT_LIMITS.maxElementsPerContainer),
      })
      .strict(),
  ]),
);

const guideSchema = z
  .object({
    id: identifierSchema,
    orientation: z.enum(['horizontal', 'vertical']),
    positionPt: z.number().finite(),
  })
  .strict();

const backgroundStyleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('theme') }).strict(),
  z.object({ type: z.literal('solid'), color: colorSchema }).strict(),
  z
    .object({
      type: z.literal('image'),
      assetId: identifierSchema,
      fit: z.enum(['contain', 'cover', 'fill']),
      opacity: z.number().finite().min(0).max(1),
    })
    .strict(),
]);

const themeSchema = z
  .object({
    id: identifierSchema,
    name: nonEmptyStringSchema,
    colors: z
      .object({
        background: colorSchema,
        surface: colorSchema,
        text: colorSchema,
        mutedText: colorSchema,
        accent: colorSchema,
      })
      .strict(),
    headingFontFamily: boundedFontFamilySchema,
    bodyFontFamily: boundedFontFamilySchema,
    textStyles: z
      .array(
        z
          .object({
            id: identifierSchema,
            role: textStyleRoleSchema,
            fontFamily: boundedFontFamilySchema,
            fontSizePt: positiveFiniteSchema,
            fontWeight: z.number().int().min(1).max(1000),
            italic: z.boolean(),
            color: colorSchema,
            alignment: textAlignmentSchema,
            lineHeight: positiveFiniteSchema,
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();

const masterSchema = z
  .object({
    id: identifierSchema,
    name: nonEmptyStringSchema,
    themeId: identifierSchema,
    elements: z.array(elementSchema).max(DOCUMENT_LIMITS.maxElementsPerContainer),
    guides: z.array(guideSchema).max(DOCUMENT_LIMITS.maxGuidesPerContainer),
    background: backgroundStyleSchema.optional(),
  })
  .strict();

const layoutSchema = z
  .object({
    id: identifierSchema,
    name: nonEmptyStringSchema,
    masterId: identifierSchema,
    elements: z.array(elementSchema).max(DOCUMENT_LIMITS.maxElementsPerContainer),
    guides: z.array(guideSchema).max(DOCUMENT_LIMITS.maxGuidesPerContainer),
    background: backgroundStyleSchema.optional(),
  })
  .strict();

export const slideSchema: z.ZodType<Slide> = z
  .object({
    id: identifierSchema,
    name: nonEmptyStringSchema,
    layoutId: identifierSchema,
    hidden: z.boolean(),
    background: backgroundStyleSchema.optional(),
    elements: z.array(elementSchema).max(DOCUMENT_LIMITS.maxElementsPerContainer),
  })
  .strict();

const assetSchema = z
  .object({
    id: identifierSchema,
    kind: z.enum(['image', 'font']),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    mediaType: nonEmptyStringSchema,
    fileName: nonEmptyStringSchema,
    byteLength: z.number().int().positive().max(DOCUMENT_LIMITS.maxAssetByteLength).optional(),
    widthPx: z.number().int().positive().max(DOCUMENT_LIMITS.maxImageDimensionPx).optional(),
    heightPx: z.number().int().positive().max(DOCUMENT_LIMITS.maxImageDimensionPx).optional(),
  })
  .strict()
  .superRefine((asset, context) => {
    if (asset.kind !== 'image') return;
    if (asset.widthPx !== undefined && asset.heightPx !== undefined) {
      if (asset.widthPx * asset.heightPx > DOCUMENT_LIMITS.maxImagePixels) {
        context.addIssue({ code: 'custom', message: 'Image pixel count exceeds the limit.' });
      }
    }
  });

const pageSchema = z
  .object({
    widthPt: positiveFiniteSchema.max(DOCUMENT_LIMITS.maxPageDimensionPt),
    heightPt: positiveFiniteSchema.max(DOCUMENT_LIMITS.maxPageDimensionPt),
  })
  .strict();

const deckBaseShape = {
  id: identifierSchema,
  name: nonEmptyStringSchema,
  page: pageSchema,
  themes: z.array(themeSchema).min(1).max(DOCUMENT_LIMITS.maxThemes),
  masters: z.array(masterSchema).min(1).max(DOCUMENT_LIMITS.maxMasters),
  layouts: z.array(layoutSchema).min(1).max(DOCUMENT_LIMITS.maxLayouts),
  slides: z.array(slideSchema).min(1).max(DOCUMENT_LIMITS.maxSlides),
  assets: z.array(assetSchema).max(DOCUMENT_LIMITS.maxAssets),
} as const;

export const deckDocumentV1Schema: z.ZodType<DeckDocumentV1> = z
  .object({
    schemaVersion: z.literal(1),
    ...deckBaseShape,
  })
  .strict();

export const deckDocumentSchema: z.ZodType<DeckDocument> = z
  .object({
    schemaVersion: z.literal(2),
    ...deckBaseShape,
    metadata: z
      .object({
        createdAt: z.string().datetime({ offset: true }),
        modifiedAt: z.string().datetime({ offset: true }),
        locale: z.string().trim().min(1).max(DOCUMENT_LIMITS.maxLocaleLength),
        creator: z.string().trim().min(1).max(DOCUMENT_LIMITS.maxNameLength).optional(),
        iconCatalogVersion: z.string().trim().min(1).max(DOCUMENT_LIMITS.maxCatalogVersionLength),
        flagCatalogVersion: z.string().trim().min(1).max(DOCUMENT_LIMITS.maxCatalogVersionLength),
      })
      .strict(),
    settings: z
      .object({
        grid: z
          .object({
            enabled: z.boolean(),
            spacingPt: positiveFiniteSchema.max(1_000),
            snapToGrid: z.boolean(),
            snapToObjects: z.boolean(),
          })
          .strict(),
        defaultBackground: backgroundStyleSchema,
        includeHiddenSlidesInExport: z.boolean(),
      })
      .strict(),
  })
  .strict();

export {
  assetSchema,
  backgroundStyleSchema,
  colorSchema,
  guideSchema,
  identifierSchema,
  layoutSchema,
  masterSchema,
  richTextDocumentSchema,
  tableCellSchema,
  textStyleOverridesSchema,
  themeSchema,
};
