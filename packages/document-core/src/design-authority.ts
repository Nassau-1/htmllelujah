import { DOCUMENT_LIMITS } from './limits.js';
import type {
  BackgroundStyle,
  DeckDocument,
  Element,
  PageSize,
  RichTextDocument,
  TextMarks,
  TextStyleOverrides,
  Theme,
} from './model.js';
import { createThemeFromCatalog, DEFAULT_STYLE_CATALOG, type IdFactory } from './styles.js';

export const DEFAULT_BLANK_THEME_NAME = 'Untitled theme';
export const MIN_CUSTOM_PAGE_DIMENSION_PT = 1;

const normalizedThemeName = (name: string): string => {
  const normalized = name.trim().slice(0, DOCUMENT_LIMITS.maxNameLength);
  return normalized.length === 0 ? DEFAULT_BLANK_THEME_NAME : normalized;
};

/**
 * Creates a standalone theme from the neutral built-in design catalog.
 *
 * The generated theme has fresh IDs and does not inherit values from the deck's
 * currently selected theme, which makes it a predictable starting point for a
 * hand-authored theme.
 */
export const createBlankTheme = (idFactory: IdFactory, name = DEFAULT_BLANK_THEME_NAME): Theme => ({
  ...createThemeFromCatalog(idFactory, DEFAULT_STYLE_CATALOG),
  name: normalizedThemeName(name),
});

/**
 * Produces a valid custom page size while keeping both dimensions inside the
 * canonical document bounds. Non-finite input is rejected because silently
 * replacing it would conceal invalid UI or agent input.
 */
export const createBoundedPageSize = (widthPt: number, heightPt: number): PageSize => {
  if (!Number.isFinite(widthPt) || !Number.isFinite(heightPt)) {
    throw new RangeError('Custom page dimensions must be finite numbers.');
  }
  const bound = (value: number): number =>
    Math.min(DOCUMENT_LIMITS.maxPageDimensionPt, Math.max(MIN_CUSTOM_PAGE_DIMENSION_PT, value));
  return { widthPt: bound(widthPt), heightPt: bound(heightPt) };
};

const enforceBackground = (
  background: BackgroundStyle | undefined,
): BackgroundStyle | undefined => {
  if (background === undefined || background.type === 'image') return background;
  return { type: 'theme' };
};

const stripThemeTextOverrides = (
  style: TextStyleOverrides | undefined,
): TextStyleOverrides | undefined => {
  if (style === undefined) return undefined;
  const { color: _color, fontFamily: _fontFamily, ...remaining } = style;
  return Object.keys(remaining).length === 0 ? undefined : remaining;
};

const stripThemeTextMarks = (marks: TextMarks): TextMarks => {
  const { color: _color, fontFamily: _fontFamily, ...remaining } = marks;
  return remaining;
};

const enforceRichText = (content: RichTextDocument): RichTextDocument => ({
  blocks: content.blocks.map((block) =>
    block.type === 'list'
      ? {
          ...block,
          items: block.items.map((item) => ({
            ...item,
            runs: item.runs.map((run) => ({
              ...run,
              marks: stripThemeTextMarks(run.marks),
            })),
          })),
        }
      : {
          ...block,
          runs: block.runs.map((run) => ({
            ...run,
            marks: stripThemeTextMarks(run.marks),
          })),
        },
  ),
});

const enforceElement = (element: Element, theme: Theme): Element => {
  switch (element.type) {
    case 'text':
      return {
        ...element,
        content: enforceRichText(element.content),
        style: stripThemeTextOverrides(element.style),
      };
    case 'image':
      return element;
    case 'table':
      return {
        ...element,
        cells: element.cells.map((cell) => ({
          ...cell,
          content: enforceRichText(cell.content),
          style: {
            ...cell.style,
            fill:
              cell.style.fill === null
                ? null
                : cell.row === 0
                  ? theme.colors.accent
                  : theme.colors.surface,
            textColor: theme.colors.text,
          },
        })),
        border: { ...element.border, color: theme.colors.mutedText },
        ...(element.style === undefined
          ? {}
          : {
              style: {
                ...element.style,
                ...(element.style.fill === undefined
                  ? {}
                  : element.style.fill === null
                    ? { fill: null }
                    : { fill: theme.colors.surface }),
                ...(element.style.headerFill === undefined
                  ? {}
                  : element.style.headerFill === null
                    ? { headerFill: null }
                    : { headerFill: theme.colors.accent }),
              },
            }),
      };
    case 'shape':
      return {
        ...element,
        fill: element.fill === null ? null : theme.colors.surface,
        stroke: { ...element.stroke, color: theme.colors.accent },
        ...(element.shadow === undefined
          ? {}
          : { shadow: { ...element.shadow, color: theme.colors.mutedText } }),
      };
    case 'connector':
      return {
        ...element,
        stroke: { ...element.stroke, color: theme.colors.accent },
      };
    case 'icon':
      return { ...element, color: theme.colors.accent };
    case 'placeholder':
      return {
        ...element,
        defaultTextStyle: stripThemeTextOverrides(element.defaultTextStyle),
      };
    case 'group':
      return {
        ...element,
        children: element.children.map((child) => enforceElement(child, theme)),
      };
  }
};

/**
 * Removes only the font and color overrides managed by a theme from one element.
 *
 * Geometry, content, non-theme styling, transparency, bindings, and identifiers are
 * preserved. This is the element-level counterpart to {@link enforceThemeAcrossDeck}
 * used by the editor's explicit "Reset to theme" action.
 */
export const resetElementThemeStyles = (element: Element, theme: Theme): Element =>
  enforceElement(element, theme);

const enforceElements = (elements: readonly Element[], theme: Theme): readonly Element[] =>
  elements.map((element) => resetElementThemeStyles(element, theme));

/**
 * Applies a theme as an explicit deck-wide transformation.
 *
 * Theme-controlled fonts and colors are reset in masters, layouts and slides;
 * geometry, content, IDs, transparency and image assets are preserved. The
 * operation is immutable, deterministic and idempotent, so a command layer can
 * safely wrap it in one undoable transaction.
 */
export const enforceThemeAcrossDeck = (document: DeckDocument, themeId: string): DeckDocument => {
  const theme = document.themes.find((candidate) => candidate.id === themeId);
  if (theme === undefined) throw new Error(`Theme ${themeId} does not exist.`);

  return {
    ...document,
    settings: {
      ...document.settings,
      defaultBackground:
        enforceBackground(document.settings.defaultBackground) ??
        document.settings.defaultBackground,
    },
    masters: document.masters.map((master) => ({
      ...master,
      themeId,
      background: enforceBackground(master.background),
      elements: enforceElements(master.elements, theme),
    })),
    layouts: document.layouts.map((layout) => ({
      ...layout,
      background: enforceBackground(layout.background),
      elements: enforceElements(layout.elements, theme),
    })),
    slides: document.slides.map((slide) => ({
      ...slide,
      background: enforceBackground(slide.background),
      elements: enforceElements(slide.elements, theme),
    })),
  };
};
