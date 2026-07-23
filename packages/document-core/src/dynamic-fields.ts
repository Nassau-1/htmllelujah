import type { DeckDocument, Element, RichTextDocument, Slide, TextRun } from './model.js';

export type DynamicFieldToken = 'page' | 'pages' | 'title' | 'date' | 'time';

export type DynamicFieldValues = Readonly<Record<DynamicFieldToken, string>>;

export interface DynamicFieldContext {
  /**
   * Timestamp used by date/time fields. The document modification timestamp is
   * the deterministic fallback when a renderer does not supply one.
   */
  readonly now?: Date | string | undefined;
  readonly locale?: string | undefined;
  readonly timeZone?: string | undefined;
  /** Hidden slides count by default, matching the canonical editor order. */
  readonly includeHiddenSlides?: boolean | undefined;
}

export class DynamicFieldResolutionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DynamicFieldResolutionError';
  }
}

const DYNAMIC_FIELD_PATTERN = /\{\{\s*(page|pages|title|date|time)\s*\}\}/g;
const FALLBACK_TIMESTAMP = '1970-01-01T00:00:00.000Z';
const FALLBACK_LOCALE = 'en-US';
const FALLBACK_TIME_ZONE = 'UTC';

const validDate = (value: Date | string): Date => {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date(FALLBACK_TIMESTAMP);
};

const formatDatePart = (
  date: Date,
  locale: string,
  timeZone: string,
  kind: 'date' | 'time',
): string => {
  const options: Intl.DateTimeFormatOptions =
    kind === 'date'
      ? { dateStyle: 'short', timeZone }
      : { hour: '2-digit', minute: '2-digit', timeZone };
  try {
    return new Intl.DateTimeFormat(locale, options).format(date);
  } catch {
    return new Intl.DateTimeFormat(FALLBACK_LOCALE, {
      ...options,
      timeZone: FALLBACK_TIME_ZONE,
    }).format(date);
  }
};

const slidesInNumbering = (
  document: DeckDocument,
  includeHiddenSlides: boolean,
): readonly Slide[] =>
  includeHiddenSlides ? document.slides : document.slides.filter((slide) => !slide.hidden);

/** Resolves the canonical values available to dynamic text fields for one slide. */
export const createDynamicFieldValues = (
  document: DeckDocument,
  slideId: string,
  context: DynamicFieldContext = {},
): DynamicFieldValues => {
  const slides = slidesInNumbering(document, context.includeHiddenSlides ?? true);
  const pageIndex = slides.findIndex((slide) => slide.id === slideId);
  if (pageIndex < 0) {
    throw new DynamicFieldResolutionError(
      `Slide ${slideId} is not part of the selected page-numbering scope.`,
    );
  }

  const date = validDate(context.now ?? document.metadata.modifiedAt);
  const locale = context.locale ?? document.metadata.locale;
  const timeZone = context.timeZone ?? FALLBACK_TIME_ZONE;

  return {
    page: String(pageIndex + 1),
    pages: String(slides.length),
    title: document.name,
    date: formatDatePart(date, locale, timeZone, 'date'),
    time: formatDatePart(date, locale, timeZone, 'time'),
  };
};

/**
 * Replaces supported `{{token}}` fields and deliberately leaves unknown tokens
 * literal. A token must live in one text run; formatting boundaries remain
 * authoritative and are never merged as a side effect.
 */
export const resolveDynamicFieldText = (text: string, values: DynamicFieldValues): string =>
  text.replace(DYNAMIC_FIELD_PATTERN, (_match, token: DynamicFieldToken) => values[token]);

const resolveRun = (run: TextRun, values: DynamicFieldValues): TextRun => {
  const text = resolveDynamicFieldText(run.text, values);
  return text === run.text ? run : { ...run, text };
};

export const resolveRichTextDynamicFields = (
  content: RichTextDocument,
  values: DynamicFieldValues,
): RichTextDocument => {
  let changed = false;
  const blocks = content.blocks.map((block) => {
    if (block.type === 'list') {
      const items = block.items.map((item) => {
        const runs = item.runs.map((run) => resolveRun(run, values));
        const runsChanged = runs.some((run, index) => run !== item.runs[index]);
        if (runsChanged) changed = true;
        return runsChanged ? { ...item, runs } : item;
      });
      return items.some((item, index) => item !== block.items[index]) ? { ...block, items } : block;
    }

    const runs = block.runs.map((run) => resolveRun(run, values));
    const runsChanged = runs.some((run, index) => run !== block.runs[index]);
    if (runsChanged) changed = true;
    return runsChanged ? { ...block, runs } : block;
  });
  return changed ? { ...content, blocks } : content;
};

/** Resolves fields recursively without mutating the canonical element tree. */
export const resolveElementDynamicFields = (
  element: Element,
  values: DynamicFieldValues,
): Element => {
  switch (element.type) {
    case 'text': {
      const content = resolveRichTextDynamicFields(element.content, values);
      return content === element.content ? element : { ...element, content };
    }
    case 'table': {
      let changed = false;
      const cells = element.cells.map((cell) => {
        const content = resolveRichTextDynamicFields(cell.content, values);
        if (content !== cell.content) changed = true;
        return content === cell.content ? cell : { ...cell, content };
      });
      return changed ? { ...element, cells } : element;
    }
    case 'group': {
      const children = element.children.map((child) => resolveElementDynamicFields(child, values));
      return children.some((child, index) => child !== element.children[index])
        ? { ...element, children }
        : element;
    }
    case 'image':
    case 'shape':
    case 'connector':
    case 'icon':
    case 'placeholder':
      return element;
  }
};
