import type {
  DeckDocument,
  Element,
  Frame,
  Layout,
  Master,
  Slide,
  TextStyle,
  TextStyleRole,
  Theme,
} from '@htmllelujah/document-core';
import { DEFAULT_STYLE_CATALOG } from '@htmllelujah/document-core';

export type DesignSurface = 'slide' | 'layout' | 'master';

export type DesignCanvasContext = Readonly<{
  document: DeckDocument;
  slide: Slide;
  editableElements?: readonly Element[] | undefined;
  editableSource: DesignSurface;
  label: string;
}>;

/**
 * Keeps selections that still exist on any editable top-level canvas. Session
 * updates arrive for slide, layout, and master commands alike, so filtering only
 * against slide elements would make a just-transformed template object disappear
 * from the selection immediately after its revision is accepted.
 */
export const retainExistingCanvasSelection = (
  document: DeckDocument,
  selectedIds: readonly string[],
): readonly string[] => {
  const existing = new Set(
    [...document.slides, ...document.layouts, ...document.masters].flatMap((container) =>
      container.elements.map((element) => element.id),
    ),
  );
  return selectedIds.filter((identifier) => existing.has(identifier));
};

export const duplicateThemeWithFreshIds = (source: Theme, id: () => string): Theme => ({
  ...source,
  id: id(),
  name: `${source.name} copy`,
  colors: { ...source.colors },
  textStyles: source.textStyles.map((style) => ({ ...style, id: id() })),
});

export const replaceElementFrames = (
  elements: readonly Element[],
  frames: readonly { readonly elementId: string; readonly frame: Frame }[],
): readonly Element[] => {
  const replacements = new Map(frames.map((entry) => [entry.elementId, entry.frame]));
  return elements.map((element) => {
    const frame = replacements.get(element.id);
    return frame === undefined ? element : { ...element, frame: { ...frame } };
  });
};

export const updateThemeFontFamily = (
  theme: Theme,
  kind: 'heading' | 'body',
  fontFamily: string,
): Theme => {
  const heading = kind === 'heading';
  return {
    ...theme,
    ...(heading ? { headingFontFamily: fontFamily } : { bodyFontFamily: fontFamily }),
    textStyles: theme.textStyles.map((style) =>
      (
        heading
          ? style.role === 'title' || style.role === 'subtitle'
          : style.role !== 'title' && style.role !== 'subtitle'
      )
        ? { ...style, fontFamily }
        : style,
    ),
  };
};

export const updateThemeRoleStyle = (
  theme: Theme,
  role: TextStyleRole,
  patch: Partial<Omit<TextStyle, 'id' | 'role'>>,
): Theme => {
  const existing = theme.textStyles.find((style) => style.role === role);
  if (existing === undefined) {
    return {
      ...theme,
      textStyles: [
        ...theme.textStyles,
        { ...themeRoleStyle(theme, role), id: crypto.randomUUID(), ...patch },
      ],
    };
  }
  return {
    ...theme,
    textStyles: theme.textStyles.map((style) =>
      style.role === role ? { ...style, ...patch } : style,
    ),
  };
};

export const themeRoleStyle = (theme: Theme, role: TextStyleRole): TextStyle => {
  const existing = theme.textStyles.find((style) => style.role === role);
  if (existing !== undefined) return existing;
  const fallback = DEFAULT_STYLE_CATALOG.textStyles.find((style) => style.role === role);
  if (fallback === undefined) throw new Error(`No default text style for ${role}.`);
  const muted = role === 'subtitle' || role === 'caption';
  return {
    id: `missing-${theme.id}-${role}`,
    ...fallback,
    fontFamily:
      role === 'title' || role === 'subtitle' ? theme.headingFontFamily : theme.bodyFontFamily,
    color: muted ? theme.colors.mutedText : theme.colors.text,
  };
};

export const themeForSlide = (document: DeckDocument, slide: Slide): Theme | undefined => {
  const layout = document.layouts.find((candidate) => candidate.id === slide.layoutId);
  const master = document.masters.find((candidate) => candidate.id === layout?.masterId);
  return (
    document.themes.find((candidate) => candidate.id === master?.themeId) ?? document.themes[0]
  );
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const structurallyEqual = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/** Replays only the fields changed by a stale UI replacement over the latest entity. */
export const rebaseEntityReplacement = <T>(baseline: T, requested: T, latest: T): T => {
  const merge = (before: unknown, after: unknown, current: unknown): unknown => {
    if (structurallyEqual(before, after)) return current;
    if (Array.isArray(before) && Array.isArray(after) && Array.isArray(current)) {
      const hasStableIds = [...before, ...after, ...current].every(
        (entry) => isPlainRecord(entry) && typeof entry.id === 'string',
      );
      if (!hasStableIds) return after;
      const baselineById = new Map(before.map((entry) => [String(entry.id), entry]));
      const requestedById = new Map(after.map((entry) => [String(entry.id), entry]));
      const removedIds = new Set(
        [...baselineById.keys()].filter((identifier) => !requestedById.has(identifier)),
      );
      const merged = current
        .filter((entry) => !removedIds.has(String(entry.id)))
        .map((entry) => {
          const identifier = String(entry.id);
          const prior = baselineById.get(identifier);
          const requestedEntry = requestedById.get(identifier);
          return prior === undefined || requestedEntry === undefined
            ? entry
            : merge(prior, requestedEntry, entry);
        });
      const currentIds = new Set(merged.map((entry) => String(entry.id)));
      for (const entry of after) {
        const identifier = String(entry.id);
        if (!baselineById.has(identifier) && !currentIds.has(identifier)) {
          merged.push(entry);
          currentIds.add(identifier);
        }
      }
      return merged;
    }
    if (!isPlainRecord(before) || !isPlainRecord(after) || !isPlainRecord(current)) return after;
    const merged: Record<string, unknown> = { ...current };
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!(key in after)) delete merged[key];
      else if (!(key in before)) merged[key] = after[key];
      else merged[key] = merge(before[key], after[key], current[key]);
    }
    return merged;
  };
  return merge(baseline, requested, latest) as T;
};

export const createDesignCanvasContext = (
  document: DeckDocument,
  activeSlide: Slide,
  surface: DesignSurface,
  designLayout: Layout | undefined,
  designMaster: Master | undefined,
): DesignCanvasContext => {
  if (surface === 'layout' && designLayout !== undefined) {
    const { background: _slideBackground, ...slideWithoutBackground } = activeSlide;
    const slide: Slide = { ...slideWithoutBackground, layoutId: designLayout.id, elements: [] };
    return {
      document: { ...document, slides: [slide] },
      slide,
      editableElements: designLayout.elements,
      editableSource: 'layout',
      label: `Layout: ${designLayout.name}`,
    };
  }
  if (surface === 'master' && designMaster !== undefined) {
    const baseLayout =
      document.layouts.find((layout) => layout.masterId === designMaster.id) ??
      designLayout ??
      document.layouts[0];
    if (baseLayout !== undefined) {
      const { background: _layoutBackground, ...layoutWithoutBackground } = baseLayout;
      const previewLayout: Layout = {
        ...layoutWithoutBackground,
        masterId: designMaster.id,
        elements: [],
        guides: [],
      };
      const { background: _slideBackground, ...slideWithoutBackground } = activeSlide;
      const slide: Slide = { ...slideWithoutBackground, layoutId: previewLayout.id, elements: [] };
      return {
        document: { ...document, layouts: [previewLayout], slides: [slide] },
        slide,
        editableElements: designMaster.elements,
        editableSource: 'master',
        label: `Master: ${designMaster.name}`,
      };
    }
  }
  return {
    document,
    slide: activeSlide,
    editableSource: 'slide',
    label: `Slide: ${activeSlide.name}`,
  };
};
