import { ZodError } from 'zod';

import { canonicalizeDeckConnectorGeometry } from './connector-geometry.js';
import { DOCUMENT_LIMITS } from './limits.js';
import { migrateParsedDeckToCurrent } from './migrations/index.js';
import type {
  BackgroundStyle,
  DeckDocument,
  DeckDocumentV1,
  Element,
  PlaceholderElement,
  RichTextDocument,
  TableElement,
} from './model.js';
import { deckDocumentSchema, deckDocumentV1Schema } from './schemas.js';

export type ValidationIssueCode =
  | 'SCHEMA_INVALID'
  | 'DUPLICATE_ID'
  | 'REFERENCE_MISSING'
  | 'DUPLICATE_STYLE_ROLE'
  | 'TABLE_DIMENSION_MISMATCH'
  | 'TABLE_CELL_OUT_OF_BOUNDS'
  | 'TABLE_CELL_OVERLAP'
  | 'TABLE_CELL_MISSING'
  | 'PLACEHOLDER_BINDING_INVALID'
  | 'LIMIT_EXCEEDED'
  | 'ASSET_DIMENSION_INVALID';

export interface ValidationIssue {
  readonly code: ValidationIssueCode;
  readonly path: string;
  readonly message: string;
}

export type ValidationResult =
  | {
      readonly success: true;
      readonly document: DeckDocument;
      readonly issues: readonly [];
    }
  | {
      readonly success: false;
      readonly issues: readonly ValidationIssue[];
    };

export const VALIDATION_LIMITS = Object.freeze({
  maxIssues: 256,
  maxTableCoordinateVisits: DOCUMENT_LIMITS.maxTableRows * DOCUMENT_LIMITS.maxTableColumns,
});

export interface ValidationOptions {
  /** Test-only lowering seam; callers cannot raise production validation work. */
  readonly maxIssues?: number | undefined;
  /** Test-only lowering seam; checked before allocating or visiting table occupancy. */
  readonly maxTableCoordinateVisits?: number | undefined;
}

interface ResolvedValidationLimits {
  readonly maxIssues: number;
  readonly maxTableCoordinateVisits: number;
}

const resolveValidationLimits = (options: ValidationOptions = {}): ResolvedValidationLimits => {
  const maxIssues = options.maxIssues ?? VALIDATION_LIMITS.maxIssues;
  const maxTableCoordinateVisits =
    options.maxTableCoordinateVisits ?? VALIDATION_LIMITS.maxTableCoordinateVisits;
  if (
    !Number.isSafeInteger(maxIssues) ||
    maxIssues < 1 ||
    maxIssues > VALIDATION_LIMITS.maxIssues ||
    !Number.isSafeInteger(maxTableCoordinateVisits) ||
    maxTableCoordinateVisits < 0 ||
    maxTableCoordinateVisits > VALIDATION_LIMITS.maxTableCoordinateVisits
  ) {
    throw new TypeError('Validation limits are invalid.');
  }
  return { maxIssues, maxTableCoordinateVisits };
};

const pathFromZod = (path: readonly PropertyKey[]): string =>
  path.length === 0 ? '$' : `$.${path.map(String).join('.')}`;

const zodIssues = (error: ZodError, maximum: number): readonly ValidationIssue[] =>
  error.issues.slice(0, maximum).map((issue) => ({
    code: 'SCHEMA_INVALID',
    path: pathFromZod(issue.path),
    message: issue.message,
  }));

interface StructuralValidationContext {
  readonly issues: ValidationIssue[];
  readonly ids: Map<string, string>;
  readonly limits: ResolvedValidationLimits;
  elementCount: number;
}

const addIssue = (context: StructuralValidationContext, issue: ValidationIssue): void => {
  if (context.issues.length < context.limits.maxIssues) context.issues.push(issue);
};

const registerId = (context: StructuralValidationContext, id: string, path: string): void => {
  const previousPath = context.ids.get(id);
  if (previousPath !== undefined) {
    addIssue(context, {
      code: 'DUPLICATE_ID',
      path,
      message: `Identifier ${id} is already used at ${previousPath}.`,
    });
    return;
  }

  context.ids.set(id, path);
};

const registerRichTextIds = (
  context: StructuralValidationContext,
  content: RichTextDocument,
  path: string,
): void => {
  content.blocks.forEach((block, blockIndex) => {
    const blockPath = `${path}.blocks.${blockIndex}`;
    registerId(context, block.id, `${blockPath}.id`);
    if (block.type === 'list') {
      block.items.forEach((item, itemIndex) => {
        registerId(context, item.id, `${blockPath}.items.${itemIndex}.id`);
      });
    }
  });
};

const validateTable = (
  context: StructuralValidationContext,
  table: TableElement,
  path: string,
): void => {
  if (table.rowHeightsPt.length !== table.rowCount) {
    addIssue(context, {
      code: 'TABLE_DIMENSION_MISMATCH',
      path: `${path}.rowHeightsPt`,
      message: 'rowHeightsPt must contain exactly rowCount entries.',
    });
  }
  if (table.columnWidthsPt.length !== table.columnCount) {
    addIssue(context, {
      code: 'TABLE_DIMENSION_MISMATCH',
      path: `${path}.columnWidthsPt`,
      message: 'columnWidthsPt must contain exactly columnCount entries.',
    });
  }

  const tableArea = table.rowCount * table.columnCount;
  let declaredArea = 0;
  let hasOutOfBoundsCell = false;
  for (let cellIndex = 0; cellIndex < table.cells.length; cellIndex += 1) {
    const cell = table.cells[cellIndex]!;
    const cellPath = `${path}.cells.${cellIndex}`;
    registerId(context, cell.id, `${cellPath}.id`);
    registerRichTextIds(context, cell.content, `${cellPath}.content`);

    if (
      cell.row >= table.rowCount ||
      cell.column >= table.columnCount ||
      cell.rowSpan > table.rowCount - cell.row ||
      cell.columnSpan > table.columnCount - cell.column
    ) {
      hasOutOfBoundsCell = true;
      addIssue(context, {
        code: 'TABLE_CELL_OUT_OF_BOUNDS',
        path: cellPath,
        message: 'Cell span extends beyond the table dimensions.',
      });
      continue;
    }

    const cellArea = cell.rowSpan * cell.columnSpan;
    if (!Number.isSafeInteger(cellArea) || declaredArea > tableArea - cellArea) {
      addIssue(context, {
        code: 'TABLE_CELL_OVERLAP',
        path: `${path}.cells`,
        message: 'Aggregate cell span area exceeds the table area.',
      });
      return;
    }
    declaredArea += cellArea;
  }

  if (hasOutOfBoundsCell || declaredArea !== tableArea) {
    addIssue(context, {
      code: 'TABLE_CELL_MISSING',
      path: `${path}.cells`,
      message: 'Cell span area must equal the table area.',
    });
    return;
  }

  if (tableArea > context.limits.maxTableCoordinateVisits) {
    addIssue(context, {
      code: 'LIMIT_EXCEEDED',
      path: `${path}.cells`,
      message: 'Table validation work exceeds the configured limit.',
    });
    return;
  }

  const occupied = new Uint8Array(tableArea);
  let occupiedCount = 0;
  let hasOverlap = false;
  for (const cell of table.cells) {
    const lastRow = cell.row + cell.rowSpan;
    const lastColumn = cell.column + cell.columnSpan;
    for (let row = cell.row; row < lastRow; row += 1) {
      for (let column = cell.column; column < lastColumn; column += 1) {
        const coordinate = row * table.columnCount + column;
        if (occupied[coordinate] === 0) occupiedCount += 1;
        else hasOverlap = true;
        occupied[coordinate] = 1;
      }
    }
  }
  if (hasOverlap) {
    addIssue(context, {
      code: 'TABLE_CELL_OVERLAP',
      path: `${path}.cells`,
      message: 'Table cells overlap.',
    });
  }
  if (occupiedCount !== tableArea) {
    addIssue(context, {
      code: 'TABLE_CELL_MISSING',
      path: `${path}.cells`,
      message: 'Cells must cover every table coordinate exactly once.',
    });
  }
};

const registerElements = (
  context: StructuralValidationContext,
  elements: readonly Element[],
  path: string,
): ReadonlySet<string> => {
  const elementIds = new Set<string>();

  const visit = (element: Element, elementPath: string, depth: number): void => {
    context.elementCount += 1;
    if (context.elementCount === DOCUMENT_LIMITS.maxElements + 1) {
      addIssue(context, {
        code: 'LIMIT_EXCEEDED',
        path: elementPath,
        message: `Document contains more than ${DOCUMENT_LIMITS.maxElements} elements.`,
      });
    }
    if (depth > DOCUMENT_LIMITS.maxGroupDepth) {
      addIssue(context, {
        code: 'LIMIT_EXCEEDED',
        path: elementPath,
        message: `Group nesting exceeds ${DOCUMENT_LIMITS.maxGroupDepth}.`,
      });
      return;
    }
    registerId(context, element.id, `${elementPath}.id`);
    elementIds.add(element.id);

    switch (element.type) {
      case 'text':
        registerRichTextIds(context, element.content, `${elementPath}.content`);
        break;
      case 'table':
        validateTable(context, element, elementPath);
        break;
      case 'group':
        element.children.forEach((child, childIndex) =>
          visit(child, `${elementPath}.children.${childIndex}`, depth + 1),
        );
        break;
      case 'image':
      case 'shape':
      case 'connector':
      case 'icon':
      case 'placeholder':
        break;
    }
  };

  elements.forEach((element, index) => visit(element, `${path}.${index}`, 1));
  return elementIds;
};

const validateConnectorReferences = (
  context: StructuralValidationContext,
  elements: readonly Element[],
  elementIds: ReadonlySet<string>,
  path: string,
): void => {
  const visit = (element: Element, elementPath: string): void => {
    if (element.type === 'connector') {
      const endpoints = [
        ['start', element.start],
        ['end', element.end],
      ] as const;
      endpoints.forEach(([key, endpoint]) => {
        const reference = endpoint.binding.elementId;
        if (reference !== undefined && !elementIds.has(reference)) {
          addIssue(context, {
            code: 'REFERENCE_MISSING',
            path: `${elementPath}.${key}.binding.elementId`,
            message: `Connector target ${reference} does not exist in this element collection.`,
          });
        }
      });
    }

    if (element.type === 'group') {
      element.children.forEach((child, childIndex) =>
        visit(child, `${elementPath}.children.${childIndex}`),
      );
    }
  };

  elements.forEach((element, index) => visit(element, `${path}.${index}`));
};

const validateImageReferences = (
  context: StructuralValidationContext,
  elements: readonly Element[],
  imageAssetIds: ReadonlySet<string>,
  path: string,
): void => {
  const visit = (element: Element, elementPath: string): void => {
    if (element.type === 'image' && !imageAssetIds.has(element.assetId)) {
      addIssue(context, {
        code: 'REFERENCE_MISSING',
        path: `${elementPath}.assetId`,
        message: `Image asset ${element.assetId} does not exist or is not an image.`,
      });
    }
    if (element.type === 'group') {
      element.children.forEach((child, childIndex) =>
        visit(child, `${elementPath}.children.${childIndex}`),
      );
    }
  };

  elements.forEach((element, index) => visit(element, `${path}.${index}`));
};

const validateBackgroundReference = (
  context: StructuralValidationContext,
  background: BackgroundStyle | undefined,
  imageAssetIds: ReadonlySet<string>,
  path: string,
): void => {
  if (background?.type === 'image' && !imageAssetIds.has(background.assetId)) {
    addIssue(context, {
      code: 'REFERENCE_MISSING',
      path: `${path}.assetId`,
      message: `Background image asset ${background.assetId} does not exist or is not an image.`,
    });
  }
};

const collectPlaceholders = (
  elements: readonly Element[],
  output = new Map<string, PlaceholderElement>(),
): ReadonlyMap<string, PlaceholderElement> => {
  for (const element of elements) {
    if (element.type === 'placeholder') output.set(element.id, element);
    if (element.type === 'group') collectPlaceholders(element.children, output);
  }
  return output;
};

const validatePlaceholderBindings = (
  context: StructuralValidationContext,
  elements: readonly Element[],
  placeholders: ReadonlyMap<string, PlaceholderElement>,
  path: string,
): void => {
  const bound = new Set<string>();
  const visit = (element: Element, elementPath: string): void => {
    const binding = element.placeholderBinding;
    if (binding !== undefined) {
      const placeholder = placeholders.get(binding.placeholderId);
      if (placeholder === undefined) {
        addIssue(context, {
          code: 'PLACEHOLDER_BINDING_INVALID',
          path: `${elementPath}.placeholderBinding.placeholderId`,
          message: `Placeholder ${binding.placeholderId} is unavailable for this slide.`,
        });
      } else if (
        element.type === 'connector' ||
        element.type === 'group' ||
        element.type === 'placeholder' ||
        !placeholder.accepts.includes(element.type)
      ) {
        addIssue(context, {
          code: 'PLACEHOLDER_BINDING_INVALID',
          path: `${elementPath}.placeholderBinding.placeholderId`,
          message: `Placeholder ${binding.placeholderId} does not accept ${element.type}.`,
        });
      }
      if (bound.has(binding.placeholderId)) {
        addIssue(context, {
          code: 'PLACEHOLDER_BINDING_INVALID',
          path: `${elementPath}.placeholderBinding.placeholderId`,
          message: `Placeholder ${binding.placeholderId} is bound more than once on this slide.`,
        });
      }
      bound.add(binding.placeholderId);
    }
    if (element.type === 'group') {
      element.children.forEach((child, index) => visit(child, `${elementPath}.children.${index}`));
    }
  };
  elements.forEach((element, index) => visit(element, `${path}.${index}`));
};

const structuralIssues = (
  document: DeckDocument,
  limits: ResolvedValidationLimits,
): readonly ValidationIssue[] => {
  const context: StructuralValidationContext = {
    issues: [],
    ids: new Map(),
    limits,
    elementCount: 0,
  };
  registerId(context, document.id, '$.id');

  const imageAssetIds = new Set<string>();
  document.assets.forEach((asset, assetIndex) => {
    const assetPath = `$.assets.${assetIndex}`;
    registerId(context, asset.id, `${assetPath}.id`);
    if (asset.kind === 'image') {
      imageAssetIds.add(asset.id);
      const dimensionsArePaired = (asset.widthPx === undefined) === (asset.heightPx === undefined);
      if (!dimensionsArePaired) {
        addIssue(context, {
          code: 'ASSET_DIMENSION_INVALID',
          path: assetPath,
          message: 'Image widthPx and heightPx must either both be present or both be omitted.',
        });
      }
    } else if (asset.widthPx !== undefined || asset.heightPx !== undefined) {
      addIssue(context, {
        code: 'ASSET_DIMENSION_INVALID',
        path: assetPath,
        message: 'Only image assets may declare pixel dimensions.',
      });
    }
  });
  validateBackgroundReference(
    context,
    document.settings.defaultBackground,
    imageAssetIds,
    '$.settings.defaultBackground',
  );

  const themeIds = new Set<string>();
  document.themes.forEach((theme, themeIndex) => {
    const themePath = `$.themes.${themeIndex}`;
    registerId(context, theme.id, `${themePath}.id`);
    themeIds.add(theme.id);
    const roles = new Set<string>();
    theme.textStyles.forEach((style, styleIndex) => {
      registerId(context, style.id, `${themePath}.textStyles.${styleIndex}.id`);
      if (roles.has(style.role)) {
        addIssue(context, {
          code: 'DUPLICATE_STYLE_ROLE',
          path: `${themePath}.textStyles.${styleIndex}.role`,
          message: `Theme contains more than one ${style.role} style.`,
        });
      }
      roles.add(style.role);
    });
  });

  const masterIds = new Set<string>();
  document.masters.forEach((master, masterIndex) => {
    const masterPath = `$.masters.${masterIndex}`;
    registerId(context, master.id, `${masterPath}.id`);
    masterIds.add(master.id);
    if (!themeIds.has(master.themeId)) {
      addIssue(context, {
        code: 'REFERENCE_MISSING',
        path: `${masterPath}.themeId`,
        message: `Theme ${master.themeId} does not exist.`,
      });
    }
    master.guides.forEach((guide, guideIndex) =>
      registerId(context, guide.id, `${masterPath}.guides.${guideIndex}.id`),
    );
    const elementIds = registerElements(context, master.elements, `${masterPath}.elements`);
    validateConnectorReferences(context, master.elements, elementIds, `${masterPath}.elements`);
    validateImageReferences(context, master.elements, imageAssetIds, `${masterPath}.elements`);
    validateBackgroundReference(
      context,
      master.background,
      imageAssetIds,
      `${masterPath}.background`,
    );
  });

  const layoutIds = new Set<string>();
  document.layouts.forEach((layout, layoutIndex) => {
    const layoutPath = `$.layouts.${layoutIndex}`;
    registerId(context, layout.id, `${layoutPath}.id`);
    layoutIds.add(layout.id);
    if (!masterIds.has(layout.masterId)) {
      addIssue(context, {
        code: 'REFERENCE_MISSING',
        path: `${layoutPath}.masterId`,
        message: `Master ${layout.masterId} does not exist.`,
      });
    }
    layout.guides.forEach((guide, guideIndex) =>
      registerId(context, guide.id, `${layoutPath}.guides.${guideIndex}.id`),
    );
    const elementIds = registerElements(context, layout.elements, `${layoutPath}.elements`);
    validateConnectorReferences(context, layout.elements, elementIds, `${layoutPath}.elements`);
    validateImageReferences(context, layout.elements, imageAssetIds, `${layoutPath}.elements`);
    validateBackgroundReference(
      context,
      layout.background,
      imageAssetIds,
      `${layoutPath}.background`,
    );
  });

  document.slides.forEach((slide, slideIndex) => {
    const slidePath = `$.slides.${slideIndex}`;
    registerId(context, slide.id, `${slidePath}.id`);
    if (!layoutIds.has(slide.layoutId)) {
      addIssue(context, {
        code: 'REFERENCE_MISSING',
        path: `${slidePath}.layoutId`,
        message: `Layout ${slide.layoutId} does not exist.`,
      });
    }
    const elementIds = registerElements(context, slide.elements, `${slidePath}.elements`);
    validateConnectorReferences(context, slide.elements, elementIds, `${slidePath}.elements`);
    validateImageReferences(context, slide.elements, imageAssetIds, `${slidePath}.elements`);
    validateBackgroundReference(
      context,
      slide.background,
      imageAssetIds,
      `${slidePath}.background`,
    );
    const layout = document.layouts.find((candidate) => candidate.id === slide.layoutId);
    const master =
      layout === undefined
        ? undefined
        : document.masters.find((candidate) => candidate.id === layout.masterId);
    if (layout !== undefined) {
      const placeholders = new Map<string, PlaceholderElement>();
      if (master !== undefined) collectPlaceholders(master.elements, placeholders);
      collectPlaceholders(layout.elements, placeholders);
      validatePlaceholderBindings(context, slide.elements, placeholders, `${slidePath}.elements`);
    }
  });

  return context.issues;
};

export const validateDeck = (input: unknown, options: ValidationOptions = {}): ValidationResult => {
  const limits = resolveValidationLimits(options);
  const parsedV2 = deckDocumentSchema.safeParse(input);
  let document: DeckDocument;
  if (parsedV2.success) document = parsedV2.data;
  else {
    const parsedV1 = deckDocumentV1Schema.safeParse(input);
    if (!parsedV1.success) {
      const legacyCandidate =
        typeof input === 'object' && input !== null && 'schemaVersion' in input
          ? (input as { readonly schemaVersion?: unknown }).schemaVersion === 1
          : false;
      return {
        success: false,
        issues: zodIssues(legacyCandidate ? parsedV1.error : parsedV2.error, limits.maxIssues),
      };
    }
    document = migrateParsedDeckToCurrent(parsedV1.data).document;
  }

  document = canonicalizeDeckConnectorGeometry(document);

  const issues = structuralIssues(document, limits);
  if (issues.length > 0) return { success: false, issues };
  return { success: true, document, issues: [] };
};

export class DocumentValidationError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(issues: readonly ValidationIssue[]) {
    super(`Document validation failed with ${issues.length} issue(s).`);
    this.name = 'DocumentValidationError';
    this.issues = issues;
  }
}

export function assertValidDeck(input: unknown): asserts input is DeckDocument | DeckDocumentV1 {
  const result = validateDeck(input);
  if (!result.success) throw new DocumentValidationError(result.issues);
}

export const parseDeck = (input: unknown): DeckDocument => {
  const result = validateDeck(input);
  if (!result.success) throw new DocumentValidationError(result.issues);
  return result.document;
};
