import type {
  Element,
  ImageColorKey,
  ImageElement,
  PathElement,
  RichTextDocument,
  ShadowStyle,
  ShapeElement,
  ShapeText,
  StrokeStyle,
  TableBorder,
  TableCellStyle,
  TableElement,
  TableStyle,
  TextAlignment,
  TextElement,
  TextMarks,
  TextStyleOverrides,
  TextStyleRole,
} from '@htmllelujah/document-core';

export const ELEMENT_FORMAT_VERSION = 1 as const;

export type PaintableElement =
  TextElement | ShapeElement | PathElement | ImageElement | TableElement;

export type FormatPainterFailureCode =
  'UNSUPPORTED_SOURCE' | 'INCOMPATIBLE_TARGET' | 'LOCKED_TARGET' | 'TABLE_STRUCTURE_MISMATCH';

export type FormatPainterField =
  | 'opacity'
  | 'text-style-role'
  | 'text-style-overrides'
  | 'text-vertical-alignment'
  | 'rich-text-marks'
  | 'paragraph-alignment'
  | 'vector-fill'
  | 'vector-stroke'
  | 'vector-shadow'
  | 'shape-text'
  | 'image-color-key'
  | 'table-border'
  | 'table-style'
  | 'table-cell-styles';

/**
 * Representative rich-text presentation copied by the painter.
 *
 * Rich text can contain mixed formatting. The painter intentionally captures
 * the first available run and the first paragraph/heading alignment, then
 * applies those values uniformly while retaining every target character,
 * block kind and canonical identifier.
 */
export interface RepresentativeRichTextFormat {
  readonly marks: TextMarks | null;
  readonly alignment: TextAlignment | null;
}

export interface TextBoxFormat {
  readonly styleRole: TextStyleRole;
  readonly verticalAlignment: TextElement['verticalAlignment'];
  readonly style: TextStyleOverrides | null;
  readonly richText: RepresentativeRichTextFormat;
}

export interface ShapeHostedTextFormat {
  readonly styleRole: TextStyleRole;
  readonly verticalAlignment: ShapeText['verticalAlignment'];
  readonly style: TextStyleOverrides | null;
  readonly richText: RepresentativeRichTextFormat;
}

export interface TextElementFormat {
  readonly version: typeof ELEMENT_FORMAT_VERSION;
  readonly kind: 'text';
  readonly opacity: number;
  readonly text: TextBoxFormat;
}

export interface VectorElementFormat {
  readonly version: typeof ELEMENT_FORMAT_VERSION;
  readonly kind: 'vector';
  readonly opacity: number;
  readonly fill: string | null;
  readonly stroke: StrokeStyle;
  readonly shadow: ShadowStyle | null;
  /**
   * Shape-hosted text formatting is optional and never includes its content,
   * margins, locale or identifiers. It is skipped when the target cannot host
   * text instead of manufacturing or deleting content.
   */
  readonly hostedText: ShapeHostedTextFormat | null;
}

export interface ImageElementFormat {
  readonly version: typeof ELEMENT_FORMAT_VERSION;
  readonly kind: 'image';
  readonly opacity: number;
  /**
   * The non-destructive color-key effect is presentation state. Asset identity,
   * fit and crop are intentionally not paintable because they are content or
   * composition geometry.
   */
  readonly colorKey: ImageColorKey | null;
}

export interface TableCellFormat {
  readonly row: number;
  readonly column: number;
  readonly style: TableCellStyle;
}

export interface TableElementFormat {
  readonly version: typeof ELEMENT_FORMAT_VERSION;
  readonly kind: 'table';
  readonly opacity: number;
  readonly border: TableBorder;
  readonly style: TableStyle | null;
  /**
   * Styles are keyed only by logical cell coordinate. Cell content, IDs,
   * dimensions, spans and row/column sizes are never captured.
   */
  readonly cellStyles: readonly TableCellFormat[];
}

export type ElementFormat =
  TextElementFormat | VectorElementFormat | ImageElementFormat | TableElementFormat;

export type ElementFormatCaptureResult =
  | Readonly<{ ok: true; format: ElementFormat }>
  | Readonly<{
      ok: false;
      code: 'UNSUPPORTED_SOURCE';
      message: string;
    }>;

export type ElementFormatCompatibility =
  | Readonly<{ compatible: true }>
  | Readonly<{
      compatible: false;
      code: Exclude<FormatPainterFailureCode, 'UNSUPPORTED_SOURCE'>;
      message: string;
    }>;

export type ElementFormatApplicationResult =
  | Readonly<{
      ok: true;
      element: PaintableElement;
      appliedFields: readonly FormatPainterField[];
      skippedFields: readonly FormatPainterField[];
    }>
  | Readonly<{
      ok: false;
      code: Exclude<FormatPainterFailureCode, 'UNSUPPORTED_SOURCE'>;
      message: string;
    }>;

const cloneTextMarks = (marks: TextMarks): TextMarks => ({ ...marks });

const cloneTextStyle = (style: TextStyleOverrides): TextStyleOverrides => ({ ...style });

const cloneStroke = (stroke: StrokeStyle): StrokeStyle => ({ ...stroke });

const cloneShadow = (shadow: ShadowStyle): ShadowStyle => ({ ...shadow });

const cloneImageColorKey = (colorKey: ImageColorKey): ImageColorKey => ({ ...colorKey });

const cloneTableBorder = (border: TableBorder): TableBorder => ({ ...border });

const cloneTableStyle = (style: TableStyle): TableStyle => ({ ...style });

const cloneTableCellStyle = (style: TableCellStyle): TableCellStyle => ({ ...style });

const firstRunMarks = (content: RichTextDocument): TextMarks | null => {
  for (const block of content.blocks) {
    const run =
      block.type === 'list'
        ? block.items.find((item) => item.runs.length > 0)?.runs[0]
        : block.runs[0];
    if (run !== undefined) return cloneTextMarks(run.marks);
  }
  return null;
};

const firstBlockAlignment = (content: RichTextDocument): TextAlignment | null => {
  const block = content.blocks.find((candidate) => candidate.type !== 'list');
  return block?.alignment ?? null;
};

const captureRichTextFormat = (content: RichTextDocument): RepresentativeRichTextFormat => ({
  marks: firstRunMarks(content),
  alignment: firstBlockAlignment(content),
});

const captureTextBoxFormat = (element: TextElement): TextBoxFormat => ({
  styleRole: element.styleRole,
  verticalAlignment: element.verticalAlignment,
  style: element.style === undefined ? null : cloneTextStyle(element.style),
  richText: captureRichTextFormat(element.content),
});

const captureShapeHostedTextFormat = (text: ShapeText): ShapeHostedTextFormat => ({
  styleRole: text.styleRole,
  verticalAlignment: text.verticalAlignment,
  style: text.style === undefined ? null : cloneTextStyle(text.style),
  richText: captureRichTextFormat(text.content),
});

const captureVectorFormat = (element: ShapeElement | PathElement): VectorElementFormat => ({
  version: ELEMENT_FORMAT_VERSION,
  kind: 'vector',
  opacity: element.opacity,
  fill: element.fill,
  stroke: cloneStroke(element.stroke),
  shadow: element.shadow === undefined ? null : cloneShadow(element.shadow),
  hostedText:
    element.type === 'shape' && element.text !== undefined
      ? captureShapeHostedTextFormat(element.text)
      : null,
});

export const isPaintableElement = (element: Element): element is PaintableElement =>
  element.type === 'text' ||
  element.type === 'shape' ||
  element.type === 'path' ||
  element.type === 'image' ||
  element.type === 'table';

/**
 * Captures presentation-only state. The returned discriminated union contains
 * no element/content identifiers, names, asset IDs, frames, crop, path
 * commands, table dimensions or text/cell content.
 */
export const captureElementFormat = (element: Element): ElementFormatCaptureResult => {
  switch (element.type) {
    case 'text':
      return {
        ok: true,
        format: {
          version: ELEMENT_FORMAT_VERSION,
          kind: 'text',
          opacity: element.opacity,
          text: captureTextBoxFormat(element),
        },
      };
    case 'shape':
    case 'path':
      return { ok: true, format: captureVectorFormat(element) };
    case 'image':
      return {
        ok: true,
        format: {
          version: ELEMENT_FORMAT_VERSION,
          kind: 'image',
          opacity: element.opacity,
          colorKey: element.colorKey === undefined ? null : cloneImageColorKey(element.colorKey),
        },
      };
    case 'table':
      return {
        ok: true,
        format: {
          version: ELEMENT_FORMAT_VERSION,
          kind: 'table',
          opacity: element.opacity,
          border: cloneTableBorder(element.border),
          style: element.style === undefined ? null : cloneTableStyle(element.style),
          cellStyles: element.cells.map((cell) => ({
            row: cell.row,
            column: cell.column,
            style: cloneTableCellStyle(cell.style),
          })),
        },
      };
    default:
      return {
        ok: false,
        code: 'UNSUPPORTED_SOURCE',
        message: `Format painter does not support ${element.type} objects.`,
      };
  }
};

const cellCoordinateKey = (row: number, column: number): string => `${row}:${column}`;

const tableStructuresMatch = (format: TableElementFormat, target: TableElement): boolean => {
  if (format.cellStyles.length !== target.cells.length) return false;
  const sourceCoordinates = new Set(
    format.cellStyles.map((cell) => cellCoordinateKey(cell.row, cell.column)),
  );
  if (sourceCoordinates.size !== format.cellStyles.length) return false;
  return target.cells.every((cell) =>
    sourceCoordinates.has(cellCoordinateKey(cell.row, cell.column)),
  );
};

/**
 * Read-only compatibility check for disabling UI actions before application.
 */
export const inspectElementFormatCompatibility = (
  format: ElementFormat,
  target: Element,
): ElementFormatCompatibility => {
  if (!isPaintableElement(target)) {
    return {
      compatible: false,
      code: 'INCOMPATIBLE_TARGET',
      message: `A ${format.kind} format cannot be applied to a ${target.type} object.`,
    };
  }
  if (target.locked) {
    return {
      compatible: false,
      code: 'LOCKED_TARGET',
      message: 'Unlock the target object before applying formatting.',
    };
  }
  const categoryMatches =
    (format.kind === 'text' && target.type === 'text') ||
    (format.kind === 'vector' && (target.type === 'shape' || target.type === 'path')) ||
    (format.kind === 'image' && target.type === 'image') ||
    (format.kind === 'table' && target.type === 'table');
  if (!categoryMatches) {
    return {
      compatible: false,
      code: 'INCOMPATIBLE_TARGET',
      message: `A ${format.kind} format cannot be applied to a ${target.type} object.`,
    };
  }
  if (format.kind === 'table' && target.type === 'table' && !tableStructuresMatch(format, target)) {
    return {
      compatible: false,
      code: 'TABLE_STRUCTURE_MISMATCH',
      message: 'Table cell formatting requires the same logical cell coordinates.',
    };
  }
  return { compatible: true };
};

const applyRichTextFormat = (
  content: RichTextDocument,
  format: RepresentativeRichTextFormat,
): RichTextDocument => ({
  blocks: content.blocks.map((block) => {
    if (block.type === 'list') {
      return {
        ...block,
        items: block.items.map((item) => ({
          ...item,
          runs: item.runs.map((run) => ({
            ...run,
            marks: format.marks === null ? { ...run.marks } : cloneTextMarks(format.marks),
          })),
        })),
      };
    }
    return {
      ...block,
      alignment: format.alignment ?? block.alignment,
      runs: block.runs.map((run) => ({
        ...run,
        marks: format.marks === null ? { ...run.marks } : cloneTextMarks(format.marks),
      })),
    };
  }),
});

const richTextAppliedFields = (
  format: RepresentativeRichTextFormat,
): readonly FormatPainterField[] => [
  ...(format.marks === null ? [] : (['rich-text-marks'] as const)),
  ...(format.alignment === null ? [] : (['paragraph-alignment'] as const)),
];

const applyTextFormat = (
  format: TextElementFormat,
  target: TextElement,
): ElementFormatApplicationResult => ({
  ok: true,
  element: {
    ...target,
    opacity: format.opacity,
    styleRole: format.text.styleRole,
    verticalAlignment: format.text.verticalAlignment,
    style: format.text.style === null ? undefined : cloneTextStyle(format.text.style),
    content: applyRichTextFormat(target.content, format.text.richText),
  },
  appliedFields: [
    'opacity',
    'text-style-role',
    'text-style-overrides',
    'text-vertical-alignment',
    ...richTextAppliedFields(format.text.richText),
  ],
  skippedFields: [],
});

const applyHostedTextFormat = (format: ShapeHostedTextFormat, target: ShapeText): ShapeText => ({
  ...target,
  styleRole: format.styleRole,
  verticalAlignment: format.verticalAlignment,
  style: format.style === null ? undefined : cloneTextStyle(format.style),
  content: applyRichTextFormat(target.content, format.richText),
});

const applyVectorFormat = (
  format: VectorElementFormat,
  target: ShapeElement | PathElement,
): ElementFormatApplicationResult => {
  if (target.type === 'shape') {
    const canApplyHostedText = format.hostedText !== null && target.text !== undefined;
    const element: ShapeElement = {
      ...target,
      opacity: format.opacity,
      fill: format.fill,
      stroke: cloneStroke(format.stroke),
      shadow: format.shadow === null ? undefined : cloneShadow(format.shadow),
      text:
        canApplyHostedText && format.hostedText !== null && target.text !== undefined
          ? applyHostedTextFormat(format.hostedText, target.text)
          : target.text,
    };
    return {
      ok: true,
      element,
      appliedFields: [
        'opacity',
        'vector-fill',
        'vector-stroke',
        'vector-shadow',
        ...(canApplyHostedText ? (['shape-text'] as const) : []),
      ],
      skippedFields:
        format.hostedText !== null && !canApplyHostedText ? (['shape-text'] as const) : [],
    };
  }
  const element: PathElement = {
    ...target,
    opacity: format.opacity,
    fill: format.fill,
    stroke: cloneStroke(format.stroke),
    shadow: format.shadow === null ? undefined : cloneShadow(format.shadow),
  };
  return {
    ok: true,
    element,
    appliedFields: ['opacity', 'vector-fill', 'vector-stroke', 'vector-shadow'],
    skippedFields: format.hostedText === null ? [] : ['shape-text'],
  };
};

const applyImageFormat = (
  format: ImageElementFormat,
  target: ImageElement,
): ElementFormatApplicationResult => ({
  ok: true,
  element: {
    ...target,
    opacity: format.opacity,
    colorKey: format.colorKey === null ? undefined : cloneImageColorKey(format.colorKey),
  },
  appliedFields: ['opacity', 'image-color-key'],
  skippedFields: [],
});

const applyTableFormat = (
  format: TableElementFormat,
  target: TableElement,
): ElementFormatApplicationResult => {
  const styleByCoordinate = new Map(
    format.cellStyles.map((cell) => [cellCoordinateKey(cell.row, cell.column), cell.style]),
  );
  return {
    ok: true,
    element: {
      ...target,
      opacity: format.opacity,
      border: cloneTableBorder(format.border),
      style: format.style === null ? undefined : cloneTableStyle(format.style),
      cells: target.cells.map((cell) => ({
        ...cell,
        style: cloneTableCellStyle(
          styleByCoordinate.get(cellCoordinateKey(cell.row, cell.column)) ?? cell.style,
        ),
      })),
    },
    appliedFields: ['opacity', 'table-border', 'table-style', 'table-cell-styles'],
    skippedFields: [],
  };
};

/**
 * Applies a captured format without mutating either input. Compatibility is
 * checked before any output object is constructed.
 */
export const applyElementFormat = (
  format: ElementFormat,
  target: Element,
): ElementFormatApplicationResult => {
  const compatibility = inspectElementFormatCompatibility(format, target);
  if (!compatibility.compatible) {
    return {
      ok: false,
      code: compatibility.code,
      message: compatibility.message,
    };
  }
  if (format.kind === 'text' && target.type === 'text') {
    return applyTextFormat(format, target);
  }
  if (format.kind === 'vector' && (target.type === 'shape' || target.type === 'path')) {
    return applyVectorFormat(format, target);
  }
  if (format.kind === 'image' && target.type === 'image') {
    return applyImageFormat(format, target);
  }
  if (format.kind === 'table' && target.type === 'table') {
    return applyTableFormat(format, target);
  }
  return {
    ok: false,
    code: 'INCOMPATIBLE_TARGET',
    message: `A ${format.kind} format cannot be applied to a ${target.type} object.`,
  };
};
