import { ZodError } from 'zod';

import type { DeckDocument, Element, RichTextDocument, TableElement } from './model.js';
import { deckDocumentSchema } from './schemas.js';

export type ValidationIssueCode =
  | 'SCHEMA_INVALID'
  | 'DUPLICATE_ID'
  | 'REFERENCE_MISSING'
  | 'DUPLICATE_STYLE_ROLE'
  | 'TABLE_DIMENSION_MISMATCH'
  | 'TABLE_CELL_OUT_OF_BOUNDS'
  | 'TABLE_CELL_OVERLAP'
  | 'TABLE_CELL_MISSING';

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

const pathFromZod = (path: readonly PropertyKey[]): string =>
  path.length === 0 ? '$' : `$.${path.map(String).join('.')}`;

const zodIssues = (error: ZodError): readonly ValidationIssue[] =>
  error.issues.map((issue) => ({
    code: 'SCHEMA_INVALID',
    path: pathFromZod(issue.path),
    message: issue.message,
  }));

interface StructuralValidationContext {
  readonly issues: ValidationIssue[];
  readonly ids: Map<string, string>;
}

const registerId = (context: StructuralValidationContext, id: string, path: string): void => {
  const previousPath = context.ids.get(id);
  if (previousPath !== undefined) {
    context.issues.push({
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
    context.issues.push({
      code: 'TABLE_DIMENSION_MISMATCH',
      path: `${path}.rowHeightsPt`,
      message: 'rowHeightsPt must contain exactly rowCount entries.',
    });
  }
  if (table.columnWidthsPt.length !== table.columnCount) {
    context.issues.push({
      code: 'TABLE_DIMENSION_MISMATCH',
      path: `${path}.columnWidthsPt`,
      message: 'columnWidthsPt must contain exactly columnCount entries.',
    });
  }

  const occupied = new Set<string>();
  table.cells.forEach((cell, cellIndex) => {
    const cellPath = `${path}.cells.${cellIndex}`;
    registerId(context, cell.id, `${cellPath}.id`);
    registerRichTextIds(context, cell.content, `${cellPath}.content`);

    const lastRow = cell.row + cell.rowSpan;
    const lastColumn = cell.column + cell.columnSpan;
    if (lastRow > table.rowCount || lastColumn > table.columnCount) {
      context.issues.push({
        code: 'TABLE_CELL_OUT_OF_BOUNDS',
        path: cellPath,
        message: 'Cell span extends beyond the table dimensions.',
      });
      return;
    }

    for (let row = cell.row; row < lastRow; row += 1) {
      for (let column = cell.column; column < lastColumn; column += 1) {
        const coordinate = `${row}:${column}`;
        if (occupied.has(coordinate)) {
          context.issues.push({
            code: 'TABLE_CELL_OVERLAP',
            path: cellPath,
            message: `Cell overlaps the occupied coordinate ${coordinate}.`,
          });
        }
        occupied.add(coordinate);
      }
    }
  });

  if (occupied.size !== table.rowCount * table.columnCount) {
    context.issues.push({
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

  const visit = (element: Element, elementPath: string): void => {
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
          visit(child, `${elementPath}.children.${childIndex}`),
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

  elements.forEach((element, index) => visit(element, `${path}.${index}`));
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
          context.issues.push({
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
      context.issues.push({
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

const structuralIssues = (document: DeckDocument): readonly ValidationIssue[] => {
  const context: StructuralValidationContext = { issues: [], ids: new Map() };
  registerId(context, document.id, '$.id');

  const themeIds = new Set<string>();
  document.themes.forEach((theme, themeIndex) => {
    const themePath = `$.themes.${themeIndex}`;
    registerId(context, theme.id, `${themePath}.id`);
    themeIds.add(theme.id);
    const roles = new Set<string>();
    theme.textStyles.forEach((style, styleIndex) => {
      registerId(context, style.id, `${themePath}.textStyles.${styleIndex}.id`);
      if (roles.has(style.role)) {
        context.issues.push({
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
      context.issues.push({
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
  });

  const layoutIds = new Set<string>();
  document.layouts.forEach((layout, layoutIndex) => {
    const layoutPath = `$.layouts.${layoutIndex}`;
    registerId(context, layout.id, `${layoutPath}.id`);
    layoutIds.add(layout.id);
    if (!masterIds.has(layout.masterId)) {
      context.issues.push({
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
  });

  const imageAssetIds = new Set<string>();
  document.assets.forEach((asset, assetIndex) => {
    registerId(context, asset.id, `$.assets.${assetIndex}.id`);
    if (asset.kind === 'image') imageAssetIds.add(asset.id);
  });

  document.slides.forEach((slide, slideIndex) => {
    const slidePath = `$.slides.${slideIndex}`;
    registerId(context, slide.id, `${slidePath}.id`);
    if (!layoutIds.has(slide.layoutId)) {
      context.issues.push({
        code: 'REFERENCE_MISSING',
        path: `${slidePath}.layoutId`,
        message: `Layout ${slide.layoutId} does not exist.`,
      });
    }
    const elementIds = registerElements(context, slide.elements, `${slidePath}.elements`);
    validateConnectorReferences(context, slide.elements, elementIds, `${slidePath}.elements`);
    validateImageReferences(context, slide.elements, imageAssetIds, `${slidePath}.elements`);
  });

  return context.issues;
};

export const validateDeck = (input: unknown): ValidationResult => {
  const parsed = deckDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, issues: zodIssues(parsed.error) };
  }

  const issues = structuralIssues(parsed.data);
  if (issues.length > 0) return { success: false, issues };
  return { success: true, document: parsed.data, issues: [] };
};

export class DocumentValidationError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(issues: readonly ValidationIssue[]) {
    super(`Document validation failed with ${issues.length} issue(s).`);
    this.name = 'DocumentValidationError';
    this.issues = issues;
  }
}

export function assertValidDeck(input: unknown): asserts input is DeckDocument {
  const result = validateDeck(input);
  if (!result.success) throw new DocumentValidationError(result.issues);
}

export const parseDeck = (input: unknown): DeckDocument => {
  const result = validateDeck(input);
  if (!result.success) throw new DocumentValidationError(result.issues);
  return result.document;
};
