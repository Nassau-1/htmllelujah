import {
  DOCUMENT_LIMITS,
  type ConnectorElement,
  type DeckDocument,
  type Element,
  type IconElement,
  type ImageElement,
  type RichTextDocument,
  type ShapeElement,
  type ShapeKind,
  type Slide,
  type TableCell,
  type TableElement,
  type TextAlignment,
  type TextElement,
  type TextMarks,
  type TextRun,
  type TextStyleRole,
} from '@htmllelujah/document-core';

const id = (): string => crypto.randomUUID();

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export const emptyMarks = (): TextMarks => ({
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
});

const safeChunkEnd = (text: string, start: number): number => {
  let end = Math.min(text.length, start + DOCUMENT_LIMITS.maxTextRunLength);
  if (
    end < text.length &&
    end > start &&
    /[\uD800-\uDBFF]/u.test(text[end - 1] ?? '') &&
    /[\uDC00-\uDFFF]/u.test(text[end] ?? '')
  ) {
    end -= 1;
  }
  return end;
};

export const boundedTextRuns = (
  text: string,
  marks: TextMarks = emptyMarks(),
): readonly TextRun[] => {
  if (text.length === 0) return [{ text: '', marks: { ...marks } }];
  const runs: TextRun[] = [];
  let start = 0;
  while (start < text.length) {
    const end = safeChunkEnd(text, start);
    runs.push({ text: text.slice(start, end), marks: { ...marks } });
    start = end;
  }
  return runs;
};

export const plainParagraph = (
  text: string,
  alignment: TextAlignment = 'left',
  marks: TextMarks = emptyMarks(),
): RichTextDocument => ({
  blocks: [
    {
      id: id(),
      type: 'paragraph',
      alignment,
      runs: boundedTextRuns(text, marks),
    },
  ],
});

export const contentToPlainText = (content: RichTextDocument): string =>
  content.blocks
    .flatMap((block) =>
      block.type === 'list'
        ? block.items.map((item) => item.runs.map((run) => run.text).join(''))
        : [block.runs.map((run) => run.text).join('')],
    )
    .join('\n');

export const headingLevelOf = (content: RichTextDocument): HeadingLevel => {
  const heading = content.blocks.find((block) => block.type === 'heading');
  return heading?.type === 'heading' ? heading.level : 1;
};

export const updateHeadingLevel = (
  content: RichTextDocument,
  level: HeadingLevel,
): RichTextDocument => ({
  blocks: content.blocks.map((block) => (block.type === 'heading' ? { ...block, level } : block)),
});

const boundedPlainTextLines = (text: string): readonly string[] => {
  const rawLines = text.replace(/\r\n?/g, '\n').split('\n');
  if (rawLines.length <= DOCUMENT_LIMITS.maxRichTextBlocks) return rawLines;
  return [
    ...rawLines.slice(0, DOCUMENT_LIMITS.maxRichTextBlocks - 1),
    rawLines.slice(DOCUMENT_LIMITS.maxRichTextBlocks - 1).join('\n'),
  ];
};

const marksEqual = (left: TextMarks, right: TextMarks): boolean =>
  left.bold === right.bold &&
  left.italic === right.italic &&
  left.underline === right.underline &&
  left.strikethrough === right.strikethrough &&
  left.color === right.color &&
  left.fontFamily === right.fontFamily &&
  left.fontSizePt === right.fontSizePt &&
  left.fontWeight === right.fontWeight;

const mergeAdjacentRuns = (runs: readonly TextRun[]): readonly TextRun[] => {
  const merged: TextRun[] = [];
  for (const run of runs) {
    for (const chunk of boundedTextRuns(run.text, run.marks)) {
      const previous = merged.at(-1);
      if (
        previous !== undefined &&
        marksEqual(previous.marks, chunk.marks) &&
        previous.text.length + chunk.text.length <= DOCUMENT_LIMITS.maxTextRunLength
      ) {
        merged[merged.length - 1] = { ...previous, text: previous.text + chunk.text };
      } else {
        merged.push({ text: chunk.text, marks: { ...chunk.marks } });
      }
    }
  }
  return merged.length > 0 ? merged : [{ text: '', marks: emptyMarks() }];
};

/** Preserves marks on unchanged text and gives inserted text its nearest neighbouring marks. */
const replaceRunsText = (runs: readonly TextRun[], nextText: string): readonly TextRun[] => {
  const previousText = runs.map((run) => run.text).join('');
  if (previousText === nextText) return runs.map((run) => ({ ...run, marks: { ...run.marks } }));
  if (runs.length <= 1) {
    return boundedTextRuns(nextText, runs[0]?.marks ?? emptyMarks());
  }

  const boundaries = [0];
  let mappedStart = 0;
  let previousEnd = 0;
  for (let index = 1; index < runs.length; index += 1) {
    const previousRun = runs[index - 1]!;
    const nextRun = runs[index]!;
    previousEnd += previousRun.text.length;
    const nextExact = nextRun.text.length === 0 ? -1 : nextText.indexOf(nextRun.text, mappedStart);
    const previousExact =
      previousRun.text.length === 0 ? -1 : nextText.indexOf(previousRun.text, mappedStart);
    const proportional = Math.round(
      (previousEnd / Math.max(1, previousText.length)) * nextText.length,
    );
    const mappedBoundary =
      nextExact >= mappedStart
        ? nextExact
        : previousExact >= mappedStart
          ? previousExact + previousRun.text.length
          : proportional;
    mappedStart = Math.min(nextText.length, Math.max(mappedStart, mappedBoundary));
    boundaries.push(mappedStart);
  }
  boundaries.push(nextText.length);
  return mergeAdjacentRuns(
    runs
      .map((run, index) => ({
        text: nextText.slice(boundaries[index], boundaries[index + 1]),
        marks: { ...run.marks },
      }))
      .filter((run) => run.text.length > 0),
  );
};

/** Edits plain text without flattening existing list/heading structure or mixed inline marks. */
export const replacePlainTextPreservingStyles = (
  content: RichTextDocument,
  text: string,
): RichTextDocument => {
  const lines = boundedPlainTextLines(text);
  type LineTemplate =
    | Readonly<{
        kind: 'list';
        block: Extract<RichTextDocument['blocks'][number], { type: 'list' }>;
        item: Extract<RichTextDocument['blocks'][number], { type: 'list' }>['items'][number];
      }>
    | Readonly<{
        kind: 'text';
        block: Exclude<RichTextDocument['blocks'][number], { type: 'list' }>;
      }>;
  const templates: LineTemplate[] = [];
  for (const block of content.blocks) {
    if (block.type === 'list') {
      for (const item of block.items) templates.push({ kind: 'list', block, item });
    } else {
      templates.push({ kind: 'text', block });
    }
  }
  const fallback = templates.at(-1);
  if (fallback === undefined) {
    return contentFromPlainText(text, {
      kind: 'paragraph',
      alignment: 'left',
      marks: firstRunMarks(content),
    });
  }

  const blocks: RichTextDocument['blocks'][number][] = [];
  let previousListSourceId: string | undefined;
  lines.forEach((line, index) => {
    const template = templates[index] ?? fallback;
    const existing = templates[index];
    if (template.kind === 'list') {
      const item = {
        ...(existing?.kind === 'list' ? existing.item : template.item),
        ...(existing === undefined ? { id: id() } : {}),
        runs: replaceRunsText(template.item.runs, line),
      };
      const previous = blocks.at(-1);
      if (previous?.type === 'list' && previousListSourceId === template.block.id) {
        blocks[blocks.length - 1] = { ...previous, items: [...previous.items, item] };
      } else {
        blocks.push({
          ...template.block,
          ...(existing === undefined ? { id: id() } : {}),
          items: [item],
        });
      }
      previousListSourceId = template.block.id;
      return;
    }
    blocks.push({
      ...template.block,
      ...(existing === undefined ? { id: id() } : {}),
      runs: replaceRunsText(template.block.runs, line),
    });
    previousListSourceId = undefined;
  });
  return { blocks };
};

const firstRunMarks = (content: RichTextDocument): TextMarks => {
  const block = content.blocks[0];
  return (block?.type === 'list' ? block.items[0]?.runs[0] : block?.runs[0])?.marks ?? emptyMarks();
};

export const updateRichTextPresentation = (
  content: RichTextDocument,
  options: {
    readonly alignment?: TextAlignment | undefined;
    readonly marks?: Partial<TextMarks> | undefined;
  },
): RichTextDocument => {
  const updateRuns = (runs: readonly TextRun[]): readonly TextRun[] =>
    runs.map((run) => ({ ...run, marks: { ...run.marks, ...options.marks } }));
  return {
    blocks: content.blocks.map((block) =>
      block.type === 'list'
        ? {
            ...block,
            items: block.items.map((item) => ({ ...item, runs: updateRuns(item.runs) })),
          }
        : {
            ...block,
            ...(options.alignment === undefined ? {} : { alignment: options.alignment }),
            runs: updateRuns(block.runs),
          },
    ),
  };
};

export const contentFromPlainText = (
  text: string,
  options: {
    readonly kind: 'paragraph' | 'heading' | 'bullets' | 'numbered';
    readonly alignment: TextAlignment;
    readonly marks: TextMarks;
    readonly headingLevel?: HeadingLevel;
  },
): RichTextDocument => {
  const lines = boundedPlainTextLines(text);
  if (options.kind === 'bullets' || options.kind === 'numbered') {
    return {
      blocks: [
        {
          id: id(),
          type: 'list',
          ordered: options.kind === 'numbered',
          items: lines.map((line) => ({
            id: id(),
            level: 0,
            runs: boundedTextRuns(line, options.marks),
          })),
        },
      ],
    };
  }
  return {
    blocks: lines.map((line) =>
      options.kind === 'heading'
        ? {
            id: id(),
            type: 'heading' as const,
            level: options.headingLevel ?? 1,
            alignment: options.alignment,
            runs: boundedTextRuns(line, options.marks),
          }
        : {
            id: id(),
            type: 'paragraph' as const,
            alignment: options.alignment,
            runs: boundedTextRuns(line, options.marks),
          },
    ),
  };
};

const base = (name: string, xPt: number, yPt: number, widthPt: number, heightPt: number) => ({
  id: id(),
  name,
  frame: { xPt, yPt, widthPt, heightPt, rotationDeg: 0 },
  opacity: 1,
  visible: true,
  locked: false,
});

export const createTextElement = (
  role: TextStyleRole = 'body',
  text = 'Type your text',
): TextElement => ({
  ...base(
    role === 'title' ? 'Title' : 'Text',
    96,
    role === 'title' ? 72 : 150,
    520,
    role === 'title' ? 72 : 140,
  ),
  type: 'text',
  styleRole: role,
  verticalAlignment: 'top',
  content: plainParagraph(text),
  style: { alignment: 'left' },
});

export const createShapeElement = (shape: ShapeKind = 'rounded-rectangle'): ShapeElement => ({
  ...base('Shape', 120, 150, 220, 120),
  type: 'shape',
  shape,
  fill: '#DCE8FF',
  stroke: { color: '#295BC7', widthPt: 1.5, dash: 'solid' },
  cornerRadiusPt: shape === 'rounded-rectangle' ? 12 : 0,
});

export const createImageElement = (
  assetId: string,
  widthPx?: number,
  heightPx?: number,
): ImageElement => {
  const ratio =
    widthPx !== undefined && heightPx !== undefined && heightPx > 0 ? widthPx / heightPx : 16 / 9;
  const widthPt = Math.min(480, ratio >= 1 ? 420 : 300);
  const heightPt = Math.min(300, widthPt / Math.max(0.2, ratio));
  return {
    ...base('Image', 150, 120, widthPt, heightPt),
    type: 'image',
    assetId,
    altText: 'Presentation image',
    fit: 'cover',
    crop: { top: 0, right: 0, bottom: 0, left: 0 },
  };
};

const tableCell = (row: number, column: number, text: string): TableCell => ({
  id: id(),
  row,
  column,
  rowSpan: 1,
  columnSpan: 1,
  content: plainParagraph(text),
  style: {
    fill: row === 0 ? '#E8EEFF' : null,
    textColor: '#172033',
    horizontalAlignment: 'left',
    verticalAlignment: 'middle',
    paddingPt: 8,
  },
});

export const createTableElement = (rows = 3, columns = 3): TableElement => {
  const widthPt = 500;
  const heightPt = 190;
  return {
    ...base('Table', 100, 140, widthPt, heightPt),
    type: 'table',
    rowCount: rows,
    columnCount: columns,
    rowHeightsPt: Array.from({ length: rows }, () => heightPt / rows),
    columnWidthsPt: Array.from({ length: columns }, () => widthPt / columns),
    cells: Array.from({ length: rows * columns }, (_, index) => {
      const row = Math.floor(index / columns);
      const column = index % columns;
      return tableCell(row, column, row === 0 ? `Column ${column + 1}` : '');
    }),
    border: { color: '#AAB4C7', widthPt: 1 },
    style: { bandedRows: true, headerFill: '#E8EEFF', fill: '#FFFFFF', cellPaddingPt: 8 },
  };
};

export const createIconElement = (iconName = 'star'): IconElement => ({
  ...base('Icon', 150, 150, 72, 72),
  type: 'icon',
  iconSet: 'htmllelujah-local',
  iconName,
  color: '#295BC7',
});

export const createFlagElement = (countryCode = 'FR'): IconElement => ({
  ...base(`${countryCode.toUpperCase()} flag`, 150, 150, 72, 72),
  type: 'icon',
  iconSet: 'flags',
  iconName: countryCode.toUpperCase(),
  color: '#172033',
});

export const createConnectorElement = (): ConnectorElement => ({
  ...base('Connector', 180, 200, 260, 100),
  type: 'connector',
  geometryVersion: 2,
  start: { xPt: 180, yPt: 250, binding: {} },
  end: { xPt: 440, yPt: 250, binding: {} },
  routing: 'straight',
  stroke: { color: '#295BC7', widthPt: 2, dash: 'solid' },
  startCap: 'none',
  endCap: 'arrow',
});

const textRoleForPlaceholder = (
  role: 'title' | 'subtitle' | 'body' | 'media' | 'table' | 'footer' | 'slide-number',
): TextStyleRole => {
  if (role === 'title' || role === 'subtitle' || role === 'body') return role;
  return 'caption';
};

const initialPlaceholderText = (
  role: 'title' | 'subtitle' | 'body' | 'media' | 'table' | 'footer' | 'slide-number',
  prompt: string,
  document: DeckDocument,
  index: number,
): string => {
  if (role === 'title') return 'New slide';
  if (role === 'body') return 'Add your content';
  if (role === 'footer') return document.name;
  if (role === 'slide-number') return String(index + 1);
  return prompt;
};

const textPlaceholdersForLayout = (
  document: DeckDocument,
  layoutId: string,
): readonly Extract<Element, { readonly type: 'placeholder' }>[] => {
  const layout = document.layouts.find((candidate) => candidate.id === layoutId);
  if (layout === undefined)
    throw new Error(`Cannot create a slide: layout ${layoutId} is missing.`);
  const master = document.masters.find((candidate) => candidate.id === layout.masterId);
  const placeholders: Extract<Element, { readonly type: 'placeholder' }>[] = [];
  const visit = (elements: readonly Element[]): void => {
    for (const element of elements) {
      if (element.type === 'placeholder' && element.accepts.includes('text')) {
        placeholders.push(element);
      }
      if (element.type === 'group') visit(element.children);
    }
  };
  if (master !== undefined) visit(master.elements);
  visit(layout.elements);
  return placeholders;
};

/** Creates a slide by instantiating every text-compatible placeholder in its layout/master. */
export const createSlide = (document: DeckDocument, layoutId: string, index: number): Slide => ({
  id: id(),
  name: `Slide ${index + 1}`,
  layoutId,
  hidden: false,
  elements: textPlaceholdersForLayout(document, layoutId).map((placeholder) => ({
    ...createTextElement(
      textRoleForPlaceholder(placeholder.role),
      initialPlaceholderText(placeholder.role, placeholder.prompt, document, index),
    ),
    name: placeholder.name.replace(/\s+placeholder$/iu, '') || placeholder.name,
    frame: { ...placeholder.frame },
    visible: placeholder.visible,
    opacity: placeholder.opacity,
    placeholderBinding: { placeholderId: placeholder.id, overrides: [] },
    verticalAlignment:
      placeholder.role === 'body' || placeholder.role === 'table' || placeholder.role === 'media'
        ? 'top'
        : 'middle',
  })),
});

const cloneContent = (content: RichTextDocument): RichTextDocument => ({
  blocks: content.blocks.map((block) =>
    block.type === 'list'
      ? {
          ...structuredClone(block),
          id: id(),
          items: block.items.map((item) => ({ ...structuredClone(item), id: id() })),
        }
      : { ...structuredClone(block), id: id() },
  ),
});

const collectElementIds = (
  elements: readonly Element[],
  output = new Map<string, string>(),
): Map<string, string> => {
  for (const element of elements) {
    output.set(element.id, id());
    if (element.type === 'group') collectElementIds(element.children, output);
  }
  return output;
};

const cloneElementValue = (element: Element, preservePlaceholderBinding: boolean): Element => {
  const cloned = structuredClone(element);
  if (preservePlaceholderBinding || cloned.placeholderBinding === undefined) return cloned;
  const { placeholderBinding: _placeholderBinding, ...detached } = cloned;
  return detached as Element;
};

const cloneElement = (
  element: Element,
  ids: ReadonlyMap<string, string>,
  preserveGeometryAndName: boolean,
): Element => {
  const nextId = ids.get(element.id);
  if (nextId === undefined) throw new Error('Could not duplicate an object identifier.');
  const cloned = cloneElementValue(element, preserveGeometryAndName);
  const common = {
    id: nextId,
    name: preserveGeometryAndName ? cloned.name : `${cloned.name} copy`,
    frame: preserveGeometryAndName
      ? { ...cloned.frame }
      : { ...cloned.frame, xPt: cloned.frame.xPt + 18, yPt: cloned.frame.yPt + 18 },
  };
  switch (cloned.type) {
    case 'text':
      return { ...cloned, ...common, content: cloneContent(cloned.content) };
    case 'table':
      return {
        ...cloned,
        ...common,
        cells: cloned.cells.map((cell) => ({
          ...structuredClone(cell),
          id: id(),
          content: cloneContent(cell.content),
        })),
      };
    case 'connector': {
      const rebind = (elementId: string | undefined): string | undefined =>
        elementId === undefined ? undefined : (ids.get(elementId) ?? elementId);
      return {
        ...cloned,
        ...common,
        start: {
          ...cloned.start,
          binding: { ...cloned.start.binding, elementId: rebind(cloned.start.binding.elementId) },
        },
        end: {
          ...cloned.end,
          binding: { ...cloned.end.binding, elementId: rebind(cloned.end.binding.elementId) },
        },
      };
    }
    case 'group':
      return {
        ...cloned,
        ...common,
        children: cloned.children.map((child) => cloneElement(child, ids, preserveGeometryAndName)),
      };
    case 'image':
    case 'shape':
    case 'icon':
    case 'placeholder':
      return { ...cloned, ...common };
  }
};

/**
 * Clones ordinary authored objects for duplication or paste. Placeholder-bound
 * content is deliberately detached because one slide cannot bind two local
 * objects to the same inherited placeholder.
 */
export const duplicateElements = (elements: readonly Element[]): readonly Element[] => {
  const ids = collectElementIds(elements);
  return elements.map((element) => cloneElement(element, ids, false));
};

/** Deep-clones reusable master/layout objects without visually moving or renaming them. */
export const duplicateTemplateElements = (elements: readonly Element[]): readonly Element[] => {
  const ids = collectElementIds(elements);
  return elements.map((element) => cloneElement(element, ids, true));
};
