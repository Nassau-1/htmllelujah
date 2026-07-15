import { z } from 'zod';

import type { DeckDocument, Element, Frame, Slide } from './model.js';

const identifierSchema = z.string().uuid();
const nonEmptyStringSchema = z.string().trim().min(1);
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/);
const nonNegativeFiniteSchema = z.number().finite().min(0);
const positiveFiniteSchema = z.number().finite().positive();

export const frameSchema: z.ZodType<Frame> = z
  .object({
    xPt: z.number().finite(),
    yPt: z.number().finite(),
    widthPt: positiveFiniteSchema,
    heightPt: positiveFiniteSchema,
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
  })
  .strict();

const textRunSchema = z
  .object({
    text: z.string(),
    marks: textMarksSchema,
  })
  .strict();

const paragraphBlockSchema = z
  .object({
    id: identifierSchema,
    type: z.literal('paragraph'),
    alignment: textAlignmentSchema,
    runs: z.array(textRunSchema),
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
    runs: z.array(textRunSchema),
  })
  .strict();

const listItemSchema = z
  .object({
    id: identifierSchema,
    level: z.number().int().min(0).max(8),
    runs: z.array(textRunSchema),
  })
  .strict();

const listBlockSchema = z
  .object({
    id: identifierSchema,
    type: z.literal('list'),
    ordered: z.boolean(),
    items: z.array(listItemSchema).min(1),
  })
  .strict();

const richTextDocumentSchema = z
  .object({
    blocks: z.array(
      z.discriminatedUnion('type', [paragraphBlockSchema, headingBlockSchema, listBlockSchema]),
    ),
  })
  .strict();

const baseElementShape = {
  id: identifierSchema,
  name: nonEmptyStringSchema,
  frame: frameSchema,
  opacity: z.number().finite().min(0).max(1),
  visible: z.boolean(),
  locked: z.boolean(),
} as const;

const textElementSchema = z
  .object({
    ...baseElementShape,
    type: z.literal('text'),
    styleRole: textStyleRoleSchema,
    verticalAlignment: z.enum(['top', 'middle', 'bottom']),
    content: richTextDocumentSchema,
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
    rowCount: z.number().int().positive(),
    columnCount: z.number().int().positive(),
    rowHeightsPt: z.array(positiveFiniteSchema).min(1),
    columnWidthsPt: z.array(positiveFiniteSchema).min(1),
    cells: z.array(tableCellSchema).min(1),
    border: z
      .object({
        color: colorSchema,
        widthPt: nonNegativeFiniteSchema,
      })
      .strict(),
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
    prompt: z.string(),
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
        children: z.array(elementSchema).min(2),
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
    headingFontFamily: nonEmptyStringSchema,
    bodyFontFamily: nonEmptyStringSchema,
    textStyles: z
      .array(
        z
          .object({
            id: identifierSchema,
            role: textStyleRoleSchema,
            fontFamily: nonEmptyStringSchema,
            fontSizePt: positiveFiniteSchema,
            fontWeight: z.number().int().min(1).max(1000),
            italic: z.boolean(),
            color: colorSchema,
            alignment: textAlignmentSchema,
            lineHeight: positiveFiniteSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const masterSchema = z
  .object({
    id: identifierSchema,
    name: nonEmptyStringSchema,
    themeId: identifierSchema,
    elements: z.array(elementSchema),
    guides: z.array(guideSchema),
  })
  .strict();

const layoutSchema = z
  .object({
    id: identifierSchema,
    name: nonEmptyStringSchema,
    masterId: identifierSchema,
    elements: z.array(elementSchema),
    guides: z.array(guideSchema),
  })
  .strict();

export const slideSchema: z.ZodType<Slide> = z
  .object({
    id: identifierSchema,
    name: nonEmptyStringSchema,
    layoutId: identifierSchema,
    hidden: z.boolean(),
    elements: z.array(elementSchema),
  })
  .strict();

const assetSchema = z
  .object({
    id: identifierSchema,
    kind: z.enum(['image', 'font']),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    mediaType: nonEmptyStringSchema,
    fileName: nonEmptyStringSchema,
  })
  .strict();

export const deckDocumentSchema: z.ZodType<DeckDocument> = z
  .object({
    schemaVersion: z.literal(1),
    id: identifierSchema,
    name: nonEmptyStringSchema,
    page: z
      .object({
        widthPt: positiveFiniteSchema,
        heightPt: positiveFiniteSchema,
      })
      .strict(),
    themes: z.array(themeSchema).min(1),
    masters: z.array(masterSchema).min(1),
    layouts: z.array(layoutSchema).min(1),
    slides: z.array(slideSchema).min(1),
    assets: z.array(assetSchema),
  })
  .strict();

export { colorSchema, identifierSchema, richTextDocumentSchema };
