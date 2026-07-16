import type {
  BackgroundStyle,
  DeckDocument,
  DeckDocumentInput,
  Element,
  Guide,
  Layout,
  Master,
  PlaceholderElement,
  Slide,
  TextElement,
  TextStyle,
  TextStyleOverrides,
  Theme,
} from './model.js';
import { parseDeck } from './validation.js';

export type ResolvedElementSource = 'master' | 'layout' | 'slide';

export interface ResolvedTextStyle extends Omit<TextStyle, 'id' | 'role'> {
  readonly letterSpacingPt?: number | undefined;
}

export interface ResolvedElement {
  readonly source: ResolvedElementSource;
  readonly element: Element;
  readonly placeholder?: PlaceholderElement | undefined;
  readonly resolvedTextStyle?: ResolvedTextStyle | undefined;
}

export interface ResolvedSlide {
  readonly documentId: string;
  readonly page: DeckDocument['page'];
  readonly slide: Slide;
  readonly layout: Layout;
  readonly master: Master;
  readonly theme: Theme;
  readonly background: BackgroundStyle;
  readonly guides: readonly Guide[];
  /** Canonical back-to-front paint order. */
  readonly elements: readonly ResolvedElement[];
}

export interface ResolveSlideOptions {
  /** Include editable template placeholders for master/layout editing surfaces. */
  readonly includePlaceholders?: boolean | undefined;
}

export class SlideResolutionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SlideResolutionError';
  }
}

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

const themeTextStyle = (theme: Theme, element: TextElement): TextStyle => {
  const style =
    theme.textStyles.find((candidate) => candidate.role === element.styleRole) ??
    theme.textStyles.find((candidate) => candidate.role === 'body') ??
    theme.textStyles[0];
  if (style === undefined) {
    throw new SlideResolutionError(`Theme ${theme.id} has no text style.`);
  }
  return style;
};

const mergeTextStyle = (
  theme: Theme,
  element: TextElement,
  placeholder: PlaceholderElement | undefined,
): ResolvedTextStyle => {
  const base = themeTextStyle(theme, element);
  const overrides = new Set(element.placeholderBinding?.overrides ?? []);
  const inherited = placeholder?.defaultTextStyle;
  const local = placeholder === undefined || overrides.has('style') ? element.style : undefined;
  const merged: TextStyleOverrides = { ...inherited, ...local };
  return {
    fontFamily: merged.fontFamily ?? base.fontFamily,
    fontSizePt: merged.fontSizePt ?? base.fontSizePt,
    fontWeight: merged.fontWeight ?? base.fontWeight,
    italic: merged.italic ?? base.italic,
    color: merged.color ?? base.color,
    alignment: merged.alignment ?? base.alignment,
    lineHeight: merged.lineHeight ?? base.lineHeight,
    ...(merged.letterSpacingPt === undefined ? {} : { letterSpacingPt: merged.letterSpacingPt }),
  };
};

const projectLocalElement = (
  element: Element,
  placeholder: PlaceholderElement | undefined,
): Element => {
  if (placeholder === undefined || element.placeholderBinding === undefined) return element;
  const overrides = new Set(element.placeholderBinding.overrides);
  return {
    ...element,
    ...(overrides.has('frame') ? {} : { frame: placeholder.frame }),
    ...(overrides.has('visibility')
      ? {}
      : { visible: placeholder.visible, opacity: placeholder.opacity }),
  };
};

const resolvedBackground = (
  theme: Theme,
  document: DeckDocument,
  master: Master,
  layout: Layout,
  slide: Slide,
): BackgroundStyle => {
  const background =
    slide.background ??
    layout.background ??
    master.background ??
    document.settings.defaultBackground;
  return background.type === 'theme'
    ? { type: 'solid', color: theme.colors.background }
    : background;
};

const stripTemplatePlaceholders = (element: Element): Element | undefined => {
  if (element.type === 'placeholder') return undefined;
  if (element.type !== 'group') return element;
  const children = element.children
    .map(stripTemplatePlaceholders)
    .filter((child): child is Element => child !== undefined);
  return children.length === 0 ? undefined : { ...element, children };
};

const fixedElements = (
  elements: readonly Element[],
  source: 'master' | 'layout',
  theme: Theme,
  includePlaceholders: boolean,
): readonly ResolvedElement[] =>
  elements
    .map((element): Element | undefined => {
      if (includePlaceholders) return element;
      return stripTemplatePlaceholders(element);
    })
    .filter((element): element is Element => element !== undefined)
    .map((element) => ({
      source,
      element,
      ...(element.type === 'text'
        ? { resolvedTextStyle: mergeTextStyle(theme, element, undefined) }
        : {}),
    }));

/**
 * Resolves a current-schema document that was already validated at a trusted boundary.
 *
 * This deliberately skips parsing. Callers that accept files, IPC payloads, or any other
 * untrusted input must use {@link resolveSlide} instead. Runtime snapshots have already
 * passed document validation, so presentation navigation can use this variant without
 * revalidating the entire deck for every slide change.
 */
export const resolveSlideFromValidatedDocument = (
  document: DeckDocument,
  slideId: string,
  options: ResolveSlideOptions = {},
): ResolvedSlide => {
  const slide = document.slides.find((candidate) => candidate.id === slideId);
  if (slide === undefined) throw new SlideResolutionError(`Slide ${slideId} does not exist.`);
  const layout = document.layouts.find((candidate) => candidate.id === slide.layoutId);
  if (layout === undefined)
    throw new SlideResolutionError(`Layout ${slide.layoutId} does not exist.`);
  const master = document.masters.find((candidate) => candidate.id === layout.masterId);
  if (master === undefined)
    throw new SlideResolutionError(`Master ${layout.masterId} does not exist.`);
  const theme = document.themes.find((candidate) => candidate.id === master.themeId);
  if (theme === undefined)
    throw new SlideResolutionError(`Theme ${master.themeId} does not exist.`);

  const placeholders = new Map<string, PlaceholderElement>();
  collectPlaceholders(master.elements, placeholders);
  collectPlaceholders(layout.elements, placeholders);
  const local = slide.elements.map((element): ResolvedElement => {
    const placeholder =
      element.placeholderBinding === undefined
        ? undefined
        : placeholders.get(element.placeholderBinding.placeholderId);
    const projected = projectLocalElement(element, placeholder);
    return {
      source: 'slide',
      element: projected,
      ...(placeholder === undefined ? {} : { placeholder }),
      ...(projected.type === 'text'
        ? { resolvedTextStyle: mergeTextStyle(theme, projected, placeholder) }
        : {}),
    };
  });

  return {
    documentId: document.id,
    page: document.page,
    slide,
    layout,
    master,
    theme,
    background: resolvedBackground(theme, document, master, layout, slide),
    guides: [...master.guides, ...layout.guides],
    elements: [
      ...fixedElements(master.elements, 'master', theme, options.includePlaceholders ?? false),
      ...fixedElements(layout.elements, 'layout', theme, options.includePlaceholders ?? false),
      ...local,
    ],
  };
};

/** Resolves the deterministic render/editor projection: theme → master → layout → bindings → local. */
export const resolveSlide = (
  input: DeckDocumentInput,
  slideId: string,
  options: ResolveSlideOptions = {},
): ResolvedSlide => resolveSlideFromValidatedDocument(parseDeck(input), slideId, options);
