import type { ColorTokens, TextStyle, TextStyleRole, Theme } from './model.js';

export interface StyleCatalogEntry {
  readonly role: TextStyleRole;
  readonly fontFamily: string;
  readonly fontSizePt: number;
  readonly fontWeight: number;
  readonly italic: boolean;
  readonly color: string;
  readonly alignment: TextStyle['alignment'];
  readonly lineHeight: number;
}

export interface StyleCatalog {
  readonly id: string;
  readonly name: string;
  readonly colors: ColorTokens;
  readonly headingFontFamily: string;
  readonly bodyFontFamily: string;
  readonly textStyles: readonly StyleCatalogEntry[];
}

export const DEFAULT_STYLE_CATALOG: StyleCatalog = Object.freeze({
  id: 'htmllelujah-light-v1',
  name: 'HTMLlelujah Light',
  colors: {
    background: '#FFFFFF',
    surface: '#F6F8FB',
    text: '#172033',
    mutedText: '#697386',
    accent: '#2F6BFF',
  },
  headingFontFamily: 'Arial',
  bodyFontFamily: 'Arial',
  textStyles: [
    {
      role: 'title',
      fontFamily: 'Arial',
      fontSizePt: 32,
      fontWeight: 650,
      italic: false,
      color: '#172033',
      alignment: 'left',
      lineHeight: 1.08,
    },
    {
      role: 'subtitle',
      fontFamily: 'Arial',
      fontSizePt: 18,
      fontWeight: 400,
      italic: false,
      color: '#697386',
      alignment: 'left',
      lineHeight: 1.25,
    },
    {
      role: 'body',
      fontFamily: 'Arial',
      fontSizePt: 15,
      fontWeight: 400,
      italic: false,
      color: '#172033',
      alignment: 'left',
      lineHeight: 1.35,
    },
    {
      role: 'caption',
      fontFamily: 'Arial',
      fontSizePt: 10,
      fontWeight: 400,
      italic: false,
      color: '#697386',
      alignment: 'left',
      lineHeight: 1.25,
    },
    {
      role: 'label',
      fontFamily: 'Arial',
      fontSizePt: 11,
      fontWeight: 600,
      italic: false,
      color: '#172033',
      alignment: 'left',
      lineHeight: 1.2,
    },
    {
      role: 'quote',
      fontFamily: 'Arial',
      fontSizePt: 18,
      fontWeight: 400,
      italic: true,
      color: '#172033',
      alignment: 'left',
      lineHeight: 1.35,
    },
  ],
} as const satisfies StyleCatalog);

export type IdFactory = () => string;

export const createThemeFromCatalog = (
  idFactory: IdFactory,
  catalog: StyleCatalog = DEFAULT_STYLE_CATALOG,
): Theme => ({
  id: idFactory(),
  name: catalog.name,
  colors: { ...catalog.colors },
  headingFontFamily: catalog.headingFontFamily,
  bodyFontFamily: catalog.bodyFontFamily,
  textStyles: catalog.textStyles.map((style) => ({
    id: idFactory(),
    ...style,
  })),
});

export const requireTextStyle = (theme: Theme, role: TextStyleRole): TextStyle => {
  const style = theme.textStyles.find((candidate) => candidate.role === role);
  if (style === undefined) {
    throw new Error(`Theme ${theme.id} does not define a ${role} text style.`);
  }
  return style;
};
