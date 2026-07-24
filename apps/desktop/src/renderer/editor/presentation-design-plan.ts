import {
  DEFAULT_STYLE_CATALOG,
  DOCUMENT_LIMITS,
  createThemeFromCatalog,
  type BackgroundStyle,
  type DeckDocument,
  type DocumentCommand,
  type Frame,
  type Layout,
  type Master,
  type PlaceholderElement,
  type RichTextDocument,
  type TextElement,
  type TextStyleRole,
  type Theme,
} from '@htmllelujah/document-core';
import type {
  ImportBackground,
  ImportColor,
  ImportPageFurniture,
  ImportPlaceholder,
  ImportTheme,
  PresentationImportPreview,
} from '@htmllelujah/pptx-importer';

const FURNITURE_PLACEHOLDER_TYPES = new Set(['dt', 'ftr', 'hdr', 'sldNum']);
const MAX_NATIVE_NAME_LENGTH = 120;
/** Matches the desktop transaction envelope so the import remains one undoable commit. */
export const MAX_PRESENTATION_DESIGN_IMPORT_COMMANDS = 100;

export class PresentationDesignPlanError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PresentationDesignPlanError';
  }
}

export interface PresentationDesignImportPlan {
  readonly sourceSha256: string;
  readonly page: Readonly<{ widthPt: number; heightPt: number }>;
  readonly themes: readonly Theme[];
  readonly masters: readonly Master[];
  readonly layouts: readonly Layout[];
  readonly commands: readonly DocumentCommand[];
  readonly importedItemCount: number;
  readonly warningCount: number;
}

export interface PresentationDesignPlanOptions {
  readonly idFactory: () => string;
}

const boundedName = (value: string, fallback: string): string => {
  const name = value.trim() || fallback;
  return name.slice(0, MAX_NATIVE_NAME_LENGTH);
};

const normalizeHex = (value: string): string | undefined => {
  const normalized = value.trim().replace(/^#/u, '');
  return /^[0-9a-f]{6}$/iu.test(normalized) ? `#${normalized.toUpperCase()}` : undefined;
};

const concreteThemeColors = (theme: ImportTheme): ReadonlyMap<string, string> => {
  const colors = new Map<string, string>();
  for (const candidate of theme.colors) {
    if (candidate.color.kind === 'scheme') continue;
    const color = normalizeHex(candidate.color.value);
    if (color !== undefined) colors.set(candidate.role, color);
  }
  return colors;
};

const importedColor = (
  color: ImportColor,
  scheme: ReadonlyMap<string, string>,
  fallback: string,
): string => {
  if (color.kind === 'scheme') return scheme.get(color.value) ?? fallback;
  return normalizeHex(color.value) ?? fallback;
};

const themeTokens = (theme: ImportTheme): Theme['colors'] => {
  const scheme = concreteThemeColors(theme);
  const background = scheme.get('lt1') ?? scheme.get('bg1') ?? '#FFFFFF';
  const text = scheme.get('dk1') ?? scheme.get('tx1') ?? '#172033';
  return {
    background,
    surface: scheme.get('lt2') ?? '#F6F8FB',
    text,
    mutedText: scheme.get('dk2') ?? '#697386',
    accent: scheme.get('accent1') ?? '#2F6BFF',
  };
};

const nativeTheme = (theme: ImportTheme, idFactory: () => string): Theme => {
  const colors = themeTokens(theme);
  const headingFontFamily = boundedName(theme.majorLatinFont ?? '', 'Arial');
  const bodyFontFamily = boundedName(theme.minorLatinFont ?? '', headingFontFamily);
  return createThemeFromCatalog(idFactory, {
    ...DEFAULT_STYLE_CATALOG,
    id: `presentationml-${theme.id}`,
    name: boundedName(theme.name, 'Imported theme'),
    colors,
    headingFontFamily,
    bodyFontFamily,
    textStyles: DEFAULT_STYLE_CATALOG.textStyles.map((style) => {
      const heading = style.role === 'title' || style.role === 'subtitle';
      const muted = style.role === 'subtitle' || style.role === 'caption';
      return {
        ...style,
        fontFamily: heading ? headingFontFamily : bodyFontFamily,
        color: muted ? colors.mutedText : colors.text,
      };
    }),
  });
};

const nativeBackground = (
  background: ImportBackground,
  importedTheme: ImportTheme,
  nativeThemeValue: Theme,
  inheritFromMaster: boolean,
): BackgroundStyle | undefined => {
  if (background.kind === 'inherit') {
    return inheritFromMaster ? undefined : { type: 'theme' };
  }
  const scheme = concreteThemeColors(importedTheme);
  if (background.kind === 'solid') {
    return {
      type: 'solid',
      color: importedColor(background.color, scheme, nativeThemeValue.colors.background),
    };
  }
  if (background.color === undefined) return { type: 'theme' };
  return {
    type: 'solid',
    color: importedColor(background.color, scheme, nativeThemeValue.colors.background),
  };
};

const placeholderRole = (value: string): PlaceholderElement['role'] => {
  switch (value) {
    case 'title':
    case 'ctrTitle':
      return 'title';
    case 'subTitle':
      return 'subtitle';
    case 'pic':
    case 'clipArt':
    case 'media':
      return 'media';
    case 'tbl':
      return 'table';
    case 'sldNum':
      return 'slide-number';
    case 'dt':
    case 'ftr':
    case 'hdr':
      return 'footer';
    default:
      return 'body';
  }
};

const placeholderAccepts = (role: PlaceholderElement['role']): PlaceholderElement['accepts'] => {
  switch (role) {
    case 'title':
    case 'subtitle':
    case 'footer':
    case 'slide-number':
      return ['text'];
    case 'media':
      return ['image', 'shape', 'path', 'icon'];
    case 'table':
      return ['table'];
    case 'body':
      return ['text', 'image', 'table', 'shape', 'path', 'icon'];
  }
};

const defaultFrame = (
  role: PlaceholderElement['role'],
  page: Readonly<{ widthPt: number; heightPt: number }>,
): Frame => {
  const margin = Math.min(72, page.widthPt * 0.075);
  const widthPt = Math.max(1, page.widthPt - margin * 2);
  switch (role) {
    case 'title':
      return { xPt: margin, yPt: margin, widthPt, heightPt: 64, rotationDeg: 0 };
    case 'subtitle':
      return { xPt: margin, yPt: margin + 72, widthPt, heightPt: 48, rotationDeg: 0 };
    case 'footer':
    case 'slide-number':
      return {
        xPt: margin,
        yPt: Math.max(0, page.heightPt - 36),
        widthPt,
        heightPt: 18,
        rotationDeg: 0,
      };
    default:
      return {
        xPt: margin,
        yPt: Math.min(page.heightPt - 1, margin + 112),
        widthPt,
        heightPt: Math.max(1, page.heightPt - margin * 2 - 112),
        rotationDeg: 0,
      };
  }
};

const placeholderFrame = (
  placeholder: ImportPlaceholder,
  page: Readonly<{ widthPt: number; heightPt: number }>,
): Frame => {
  const fallback = defaultFrame(placeholderRole(placeholder.type), page);
  if (placeholder.geometry === undefined) return fallback;
  return {
    xPt: Math.max(0, placeholder.geometry.xPt),
    yPt: Math.max(0, placeholder.geometry.yPt),
    widthPt: Math.max(1, placeholder.geometry.widthPt),
    heightPt: Math.max(1, placeholder.geometry.heightPt),
    rotationDeg: 0,
  };
};

const nativePlaceholder = (
  placeholder: ImportPlaceholder,
  page: Readonly<{ widthPt: number; heightPt: number }>,
  idFactory: () => string,
): PlaceholderElement => {
  const role = placeholderRole(placeholder.type);
  return {
    id: idFactory(),
    name: boundedName(placeholder.name, `${role} placeholder`),
    type: 'placeholder',
    frame: placeholderFrame(placeholder, page),
    opacity: 1,
    visible: true,
    locked: false,
    role,
    accepts: placeholderAccepts(role),
    prompt:
      placeholder.text?.trim() ||
      (role === 'title' ? 'Add a title' : role === 'subtitle' ? 'Add a subtitle' : 'Add content'),
  };
};

const textContent = (idFactory: () => string, value: string): RichTextDocument => ({
  blocks: [
    {
      id: idFactory(),
      type: 'paragraph',
      alignment: 'left',
      runs: [
        {
          text: value,
          marks: { bold: false, italic: false, underline: false, strikethrough: false },
        },
      ],
    },
  ],
});

const furnitureText = (furniture: ImportPageFurniture): string => {
  const source = furniture.text?.trim();
  if (furniture.kind === 'page-number') return source || '{{page}}';
  if (furniture.kind === 'date') return source || '{{date}}';
  return source || '';
};

const furnitureElement = (
  furniture: ImportPageFurniture,
  placeholder: ImportPlaceholder | undefined,
  page: Readonly<{ widthPt: number; heightPt: number }>,
  idFactory: () => string,
): TextElement => {
  const role: TextStyleRole = 'caption';
  const frame =
    placeholder === undefined ? defaultFrame('footer', page) : placeholderFrame(placeholder, page);
  return {
    id: idFactory(),
    name: boundedName(
      placeholder?.name ?? '',
      furniture.kind === 'page-number' ? 'Page number' : `Imported ${furniture.kind}`,
    ),
    type: 'text',
    frame,
    opacity: 1,
    visible: true,
    locked: true,
    styleRole: role,
    verticalAlignment: 'middle',
    content: textContent(idFactory, furnitureText(furniture)),
    style: {
      alignment: furniture.kind === 'page-number' ? 'right' : 'left',
    },
  };
};

const nativeDesignElements = (
  placeholders: readonly ImportPlaceholder[],
  furniture: readonly ImportPageFurniture[],
  page: Readonly<{ widthPt: number; heightPt: number }>,
  includePlaceholders: boolean,
  idFactory: () => string,
): readonly (PlaceholderElement | TextElement)[] => {
  const byId = new Map(placeholders.map((placeholder) => [placeholder.id, placeholder]));
  const elements: (PlaceholderElement | TextElement)[] = [];
  if (includePlaceholders) {
    elements.push(
      ...placeholders
        .filter((placeholder) => !FURNITURE_PLACEHOLDER_TYPES.has(placeholder.type))
        .map((placeholder) => nativePlaceholder(placeholder, page, idFactory)),
    );
  }
  elements.push(
    ...furniture.map((item) =>
      furnitureElement(item, byId.get(item.placeholderId), page, idFactory),
    ),
  );
  return elements;
};

const assertCapacity = (document: DeckDocument, preview: PresentationImportPreview): void => {
  if (document.themes.length + preview.themes.length > DOCUMENT_LIMITS.maxThemes) {
    throw new PresentationDesignPlanError('The imported themes exceed the deck theme limit.');
  }
  if (document.masters.length + preview.masters.length > DOCUMENT_LIMITS.maxMasters) {
    throw new PresentationDesignPlanError('The imported masters exceed the deck master limit.');
  }
  if (document.layouts.length + preview.layouts.length > DOCUMENT_LIMITS.maxLayouts) {
    throw new PresentationDesignPlanError('The imported layouts exceed the deck layout limit.');
  }
};

export const planPresentationDesignImport = (
  document: DeckDocument,
  preview: PresentationImportPreview,
  options: PresentationDesignPlanOptions,
): PresentationDesignImportPlan => {
  assertCapacity(document, preview);
  if (preview.themes.length === 0 || preview.masters.length === 0 || preview.layouts.length === 0) {
    throw new PresentationDesignPlanError(
      'The source does not contain a complete theme, master, and layout design.',
    );
  }
  if (
    !Number.isFinite(preview.pageSize.widthPt) ||
    !Number.isFinite(preview.pageSize.heightPt) ||
    preview.pageSize.widthPt <= 0 ||
    preview.pageSize.heightPt <= 0 ||
    preview.pageSize.widthPt > DOCUMENT_LIMITS.maxPageDimensionPt ||
    preview.pageSize.heightPt > DOCUMENT_LIMITS.maxPageDimensionPt
  ) {
    throw new PresentationDesignPlanError('The imported page size exceeds the editor limits.');
  }
  const commandCount = 1 + preview.themes.length + preview.masters.length + preview.layouts.length;
  if (commandCount > MAX_PRESENTATION_DESIGN_IMPORT_COMMANDS) {
    throw new PresentationDesignPlanError(
      `This design has ${commandCount - 1} theme, master, and layout records; the atomic import limit is ${MAX_PRESENTATION_DESIGN_IMPORT_COMMANDS - 1}.`,
    );
  }
  const page = {
    widthPt: preview.pageSize.widthPt,
    heightPt: preview.pageSize.heightPt,
  };
  const importedThemesById = new Map(preview.themes.map((theme) => [theme.id, theme]));
  const themes = preview.themes.map((theme) => nativeTheme(theme, options.idFactory));
  const nativeThemeByImportedId = new Map(
    preview.themes.map((theme, index) => [theme.id, themes[index]!]),
  );
  const fallbackImportedTheme = preview.themes[0]!;
  const fallbackNativeTheme = themes[0]!;
  const masterIdByImportedId = new Map(
    preview.masters.map((master) => [master.id, options.idFactory()]),
  );
  const masters: Master[] = preview.masters.map((master) => {
    const importedTheme =
      (master.themeId === undefined ? undefined : importedThemesById.get(master.themeId)) ??
      fallbackImportedTheme;
    const theme =
      (master.themeId === undefined ? undefined : nativeThemeByImportedId.get(master.themeId)) ??
      fallbackNativeTheme;
    return {
      id: masterIdByImportedId.get(master.id)!,
      name: boundedName(master.name, 'Imported master'),
      themeId: theme.id,
      elements: nativeDesignElements(
        master.placeholders,
        master.pageFurniture,
        page,
        false,
        options.idFactory,
      ),
      guides: [],
      background: nativeBackground(master.background, importedTheme, theme, false),
    };
  });
  const masterByImportedId = new Map(
    preview.masters.map((master, index) => [master.id, masters[index]!]),
  );
  const layouts: Layout[] = preview.layouts.map((layout) => {
    const master = masterByImportedId.get(layout.masterId);
    const importedMaster = preview.masters.find((candidate) => candidate.id === layout.masterId);
    if (master === undefined || importedMaster === undefined) {
      throw new PresentationDesignPlanError(`Layout ${layout.name} has no imported master.`);
    }
    const importedTheme =
      (importedMaster.themeId === undefined
        ? undefined
        : importedThemesById.get(importedMaster.themeId)) ?? fallbackImportedTheme;
    const theme =
      (importedMaster.themeId === undefined
        ? undefined
        : nativeThemeByImportedId.get(importedMaster.themeId)) ?? fallbackNativeTheme;
    return {
      id: options.idFactory(),
      name: boundedName(layout.name, 'Imported layout'),
      masterId: master.id,
      elements: nativeDesignElements(
        layout.placeholders,
        layout.pageFurniture,
        page,
        true,
        options.idFactory,
      ),
      guides: [],
      background: nativeBackground(layout.background, importedTheme, theme, true),
    };
  });
  const commands: DocumentCommand[] = [
    { type: 'deck.set-page', page },
    ...themes.map((theme) => ({ type: 'theme.create' as const, theme })),
    ...masters.map((master) => ({ type: 'master.create' as const, master })),
    ...layouts.map((layout) => ({ type: 'layout.create' as const, layout })),
  ];
  return {
    sourceSha256: preview.source.sha256,
    page,
    themes,
    masters,
    layouts,
    commands,
    importedItemCount: preview.fidelity.filter(({ status }) => status === 'imported').length,
    warningCount: preview.warnings.length,
  };
};
