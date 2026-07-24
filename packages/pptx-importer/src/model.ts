export type PresentationImportMode = 'design-only';

export interface PresentationImportOptions {
  readonly mode: PresentationImportMode;
}

export type ImportFidelityStatus = 'imported' | 'substituted' | 'rasterized' | 'unsupported';

export interface ImportFidelityRecord {
  readonly id: string;
  readonly sourcePart: string;
  readonly itemKind: string;
  readonly status: ImportFidelityStatus;
  readonly detail: string;
}

export interface ImportWarning {
  readonly code: string;
  readonly message: string;
  readonly sourcePart?: string | undefined;
}

export interface ImportPageSize {
  readonly widthEmu: number;
  readonly heightEmu: number;
  readonly widthPt: number;
  readonly heightPt: number;
}

export interface ImportGeometry {
  readonly xEmu: number;
  readonly yEmu: number;
  readonly widthEmu: number;
  readonly heightEmu: number;
  readonly xPt: number;
  readonly yPt: number;
  readonly widthPt: number;
  readonly heightPt: number;
}

export type ImportColor =
  | { readonly kind: 'rgb'; readonly value: string }
  | { readonly kind: 'scheme'; readonly value: string }
  | { readonly kind: 'system'; readonly value: string };

export type ImportBackground =
  | { readonly kind: 'inherit' }
  | { readonly kind: 'solid'; readonly color: ImportColor }
  | {
      readonly kind: 'theme-reference';
      readonly index: number;
      readonly color: ImportColor | undefined;
    };

export interface ImportThemeColor {
  readonly role: string;
  readonly color: ImportColor;
}

export interface ImportTheme {
  readonly id: string;
  readonly sourcePart: string;
  readonly name: string;
  readonly colors: readonly ImportThemeColor[];
  readonly majorLatinFont: string | undefined;
  readonly minorLatinFont: string | undefined;
}

export interface ImportPlaceholder {
  readonly id: string;
  readonly sourcePart: string;
  readonly name: string;
  readonly type: string;
  readonly index: number | undefined;
  readonly orientation: string | undefined;
  readonly size: string | undefined;
  readonly geometry: ImportGeometry | undefined;
  readonly text: string | undefined;
}

export type ImportPageFurnitureKind = 'date' | 'footer' | 'page-number' | 'header';

export interface ImportPageFurniture {
  readonly id: string;
  readonly kind: ImportPageFurnitureKind;
  readonly placeholderId: string;
  readonly text: string | undefined;
}

export interface ImportMaster {
  readonly id: string;
  readonly sourcePart: string;
  readonly name: string;
  readonly themeId: string | undefined;
  readonly layoutIds: readonly string[];
  readonly background: ImportBackground;
  readonly placeholders: readonly ImportPlaceholder[];
  readonly pageFurniture: readonly ImportPageFurniture[];
}

export interface ImportLayout {
  readonly id: string;
  readonly sourcePart: string;
  readonly masterId: string;
  readonly name: string;
  readonly type: string | undefined;
  readonly background: ImportBackground;
  readonly placeholders: readonly ImportPlaceholder[];
  readonly pageFurniture: readonly ImportPageFurniture[];
}

export interface PresentationImportSourceInventory {
  readonly sha256: string;
  readonly archiveBytes: number;
  readonly expandedBytes: number;
  readonly entryCount: number;
  readonly presentationPart: string;
  readonly masterPartCount: number;
  readonly layoutPartCount: number;
  readonly themePartCount: number;
  readonly slidePartCount: number;
  readonly mediaPartCount: number;
  readonly unsupportedPartCount: number;
}

export interface PresentationImportPreview {
  readonly schemaVersion: 1;
  readonly mode: 'design-only';
  readonly source: PresentationImportSourceInventory;
  readonly pageSize: ImportPageSize;
  readonly themes: readonly ImportTheme[];
  readonly masters: readonly ImportMaster[];
  readonly layouts: readonly ImportLayout[];
  readonly fidelity: readonly ImportFidelityRecord[];
  readonly warnings: readonly ImportWarning[];
}
