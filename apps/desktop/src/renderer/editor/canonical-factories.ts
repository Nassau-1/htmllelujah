import type {
  ConnectorElement,
  Element,
  IconElement,
  ImageElement,
  RichTextDocument,
  ShapeElement,
  ShapeKind,
  Slide,
  TableCell,
  TableElement,
  TextAlignment,
  TextElement,
  TextMarks,
  TextRun,
  TextStyleRole,
} from '@htmllelujah/document-core';

const id = (): string => crypto.randomUUID();

export const emptyMarks = (): TextMarks => ({
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
});

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
      runs: [{ text, marks }],
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
    const previous = merged.at(-1);
    if (previous !== undefined && marksEqual(previous.marks, run.marks)) {
      merged[merged.length - 1] = { ...previous, text: previous.text + run.text };
    } else {
      merged.push({ text: run.text, marks: { ...run.marks } });
    }
  }
  return merged.length > 0 ? merged : [{ text: '', marks: emptyMarks() }];
};

/** Preserves marks on unchanged text and gives inserted text its nearest neighbouring marks. */
const replaceRunsText = (runs: readonly TextRun[], nextText: string): readonly TextRun[] => {
  const previousText = runs.map((run) => run.text).join('');
  if (previousText === nextText) return runs.map((run) => ({ ...run, marks: { ...run.marks } }));
  if (runs.length <= 1) {
    return [{ text: nextText, marks: { ...(runs[0]?.marks ?? emptyMarks()) } }];
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
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const onlyBlock = content.blocks.length === 1 ? content.blocks[0] : undefined;
  if (onlyBlock?.type === 'list') {
    const fallback = onlyBlock.items.at(-1);
    return {
      blocks: [
        {
          ...onlyBlock,
          items: lines.map((line, index) => {
            const existing = onlyBlock.items[index];
            return existing === undefined
              ? {
                  id: id(),
                  level: fallback?.level ?? 0,
                  runs: replaceRunsText(fallback?.runs ?? [], line),
                }
              : { ...existing, runs: replaceRunsText(existing.runs, line) };
          }),
        },
      ],
    };
  }

  const textBlocks = content.blocks.filter((block) => block.type !== 'list');
  const fallback = textBlocks.at(-1);
  if (textBlocks.length !== content.blocks.length || fallback === undefined) {
    return contentFromPlainText(text, {
      kind: 'paragraph',
      alignment: 'left',
      marks: firstRunMarks(content),
    });
  }
  return {
    blocks: lines.map((line, index) => {
      const existing = textBlocks[index];
      if (existing !== undefined) {
        return { ...existing, runs: replaceRunsText(existing.runs, line) };
      }
      return fallback.type === 'heading'
        ? {
            id: id(),
            type: 'heading' as const,
            level: fallback.level,
            alignment: fallback.alignment,
            runs: replaceRunsText(fallback.runs, line),
          }
        : {
            id: id(),
            type: 'paragraph' as const,
            alignment: fallback.alignment,
            runs: replaceRunsText(fallback.runs, line),
          };
    }),
  };
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
    readonly headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  },
): RichTextDocument => {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
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
            runs: [{ text: line, marks: options.marks }],
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
            runs: [{ text: line, marks: options.marks }],
          }
        : {
            id: id(),
            type: 'paragraph' as const,
            alignment: options.alignment,
            runs: [{ text: line, marks: options.marks }],
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
  start: { xPt: 180, yPt: 250, binding: {} },
  end: { xPt: 440, yPt: 250, binding: {} },
  routing: 'straight',
  stroke: { color: '#295BC7', widthPt: 2, dash: 'solid' },
  startCap: 'none',
  endCap: 'arrow',
});

export const createSlide = (layoutId: string, index: number): Slide => ({
  id: id(),
  name: `Slide ${index + 1}`,
  layoutId,
  hidden: false,
  elements: [
    createTextElement('title', 'New slide'),
    createTextElement('body', 'Add your content'),
  ],
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

const cloneElement = (element: Element, ids: ReadonlyMap<string, string>): Element => {
  const nextId = ids.get(element.id);
  if (nextId === undefined) throw new Error('Could not duplicate an object identifier.');
  const common = {
    id: nextId,
    name: `${element.name} copy`,
    frame: { ...element.frame, xPt: element.frame.xPt + 18, yPt: element.frame.yPt + 18 },
  };
  switch (element.type) {
    case 'text':
      return { ...structuredClone(element), ...common, content: cloneContent(element.content) };
    case 'table':
      return {
        ...structuredClone(element),
        ...common,
        cells: element.cells.map((cell) => ({
          ...structuredClone(cell),
          id: id(),
          content: cloneContent(cell.content),
        })),
      };
    case 'connector': {
      const rebind = (elementId: string | undefined): string | undefined =>
        elementId === undefined ? undefined : (ids.get(elementId) ?? elementId);
      return {
        ...structuredClone(element),
        ...common,
        start: {
          ...element.start,
          binding: { ...element.start.binding, elementId: rebind(element.start.binding.elementId) },
        },
        end: {
          ...element.end,
          binding: { ...element.end.binding, elementId: rebind(element.end.binding.elementId) },
        },
      };
    }
    case 'group':
      return {
        ...structuredClone(element),
        ...common,
        children: element.children.map((child) => cloneElement(child, ids)),
      };
    case 'image':
    case 'shape':
    case 'icon':
    case 'placeholder':
      return { ...structuredClone(element), ...common };
  }
};

export const duplicateElements = (elements: readonly Element[]): readonly Element[] => {
  const ids = collectElementIds(elements);
  return elements.map((element) => cloneElement(element, ids));
};
