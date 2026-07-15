import type {
  BackgroundInput,
  DeckLike,
  DocumentResolvedSlideProjection,
  PlaceholderElement,
  RenderElement,
  ResolvedSlide,
  ResolvedSlideInput,
  SlideBackground,
  TextElement,
  TextStyleOverrides,
} from './types.js';

export class SlideProjectionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SlideProjectionError';
  }
}

const resolveBackground = (
  candidates: readonly (BackgroundInput | undefined)[],
  themeColor: string,
): SlideBackground => {
  const background = candidates.find((candidate) => candidate !== undefined);
  if (background?.type === 'solid') return { ...background };
  if (background?.type === 'image') return { ...background };
  return { type: 'solid', color: themeColor };
};

const collectPlaceholders = (
  elements: readonly RenderElement[],
  output = new Map<string, PlaceholderElement>(),
): ReadonlyMap<string, PlaceholderElement> => {
  for (const element of elements) {
    if (element.type === 'placeholder') output.set(element.id, element);
    if (element.type === 'group') collectPlaceholders(element.children, output);
  }
  return output;
};

const projectBoundElement = (
  element: RenderElement,
  placeholders: ReadonlyMap<string, PlaceholderElement>,
): RenderElement => {
  if (element.placeholderBinding === undefined) return element;
  const placeholder = placeholders.get(element.placeholderBinding.placeholderId);
  if (placeholder === undefined) return element;
  const overrides = new Set(element.placeholderBinding.overrides);
  const common = {
    ...(overrides.has('frame') ? {} : { frame: placeholder.frame }),
    ...(overrides.has('visibility')
      ? {}
      : { visible: placeholder.visible, opacity: placeholder.opacity }),
  };
  if (element.type !== 'text') return { ...element, ...common };
  const { style: localStyle, ...textWithoutStyle } = element;
  const style = overrides.has('style')
    ? { ...placeholder.defaultTextStyle, ...localStyle }
    : placeholder.defaultTextStyle;
  return {
    ...textWithoutStyle,
    ...common,
    ...(style === undefined ? {} : { style }),
  };
};

const suppressBoundPlaceholders = (
  inherited: readonly RenderElement[],
  slideElements: readonly RenderElement[],
): readonly RenderElement[] => {
  const boundIds = new Set(
    slideElements.flatMap((element) =>
      element.placeholderBinding === undefined ? [] : [element.placeholderBinding.placeholderId],
    ),
  );
  return [...inherited.filter((element) => !boundIds.has(element.id)), ...slideElements];
};

const isDocumentProjection = (
  slide: ResolvedSlideInput,
): slide is DocumentResolvedSlideProjection => 'slide' in slide;

const flattenProjectedElement = (
  element: RenderElement,
  resolvedTextStyle: TextStyleOverrides | undefined,
): RenderElement => {
  if (element.type !== 'text' || resolvedTextStyle === undefined) return element;
  const text: TextElement = {
    ...element,
    style: { ...element.style, ...resolvedTextStyle },
  };
  return text;
};

/** Converts document-core's source-aware projection into the renderer paint list. */
export const normalizeResolvedSlide = (input: ResolvedSlideInput): ResolvedSlide => {
  if (!isDocumentProjection(input)) return input;
  return {
    id: input.slide.id,
    name: input.slide.name,
    page: input.page,
    background:
      input.background.type === 'theme'
        ? { type: 'solid', color: input.theme.colors.background }
        : input.background,
    theme: input.theme,
    elements: input.elements.map((entry) =>
      flattenProjectedElement(entry.element, entry.resolvedTextStyle),
    ),
  };
};

/**
 * Structural adapter for the canonical deck model. It deliberately performs no
 * mutation and keeps array order as the back-to-front z-order.
 */
export const resolveSlideFromDeck = (deck: DeckLike, slideId: string): ResolvedSlide => {
  const slide = deck.slides.find((candidate) => candidate.id === slideId);
  if (slide === undefined) throw new SlideProjectionError(`Slide ${slideId} was not found.`);
  const layout = deck.layouts.find((candidate) => candidate.id === slide.layoutId);
  if (layout === undefined) throw new SlideProjectionError('The slide layout was not found.');
  const master = deck.masters.find((candidate) => candidate.id === layout.masterId);
  if (master === undefined) throw new SlideProjectionError('The layout master was not found.');
  const theme = deck.themes.find((candidate) => candidate.id === master.themeId);
  if (theme === undefined) throw new SlideProjectionError('The master theme was not found.');
  const inherited = [...master.elements, ...layout.elements];
  const placeholders = collectPlaceholders(inherited);
  const projectedSlideElements = slide.elements.map((element) =>
    projectBoundElement(element, placeholders),
  );
  return {
    id: slide.id,
    name: slide.name,
    page: { ...deck.page },
    background: resolveBackground(
      [slide.background, layout.background, master.background, deck.settings?.defaultBackground],
      theme.colors.background,
    ),
    theme,
    elements: suppressBoundPlaceholders(inherited, projectedSlideElements),
  };
};
