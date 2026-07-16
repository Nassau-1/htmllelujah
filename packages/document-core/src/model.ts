/** All spatial values in the canonical document are expressed in points. */
export interface PageSize {
  readonly widthPt: number;
  readonly heightPt: number;
}

export interface Frame {
  readonly xPt: number;
  readonly yPt: number;
  readonly widthPt: number;
  readonly heightPt: number;
  readonly rotationDeg: number;
}

export interface ColorTokens {
  readonly background: string;
  readonly surface: string;
  readonly text: string;
  readonly mutedText: string;
  readonly accent: string;
}

export type BackgroundStyle =
  | Readonly<{ type: 'theme' }>
  | Readonly<{ type: 'solid'; color: string }>
  | Readonly<{
      type: 'image';
      assetId: string;
      fit: 'contain' | 'cover' | 'fill';
      opacity: number;
    }>;

export type TextStyleRole = 'title' | 'subtitle' | 'body' | 'caption' | 'label' | 'quote';

export type TextAlignment = 'left' | 'center' | 'right' | 'justify';

export interface TextStyle {
  readonly id: string;
  readonly role: TextStyleRole;
  readonly fontFamily: string;
  readonly fontSizePt: number;
  readonly fontWeight: number;
  readonly italic: boolean;
  readonly color: string;
  readonly alignment: TextAlignment;
  readonly lineHeight: number;
}

export interface Theme {
  readonly id: string;
  readonly name: string;
  readonly colors: ColorTokens;
  readonly headingFontFamily: string;
  readonly bodyFontFamily: string;
  readonly textStyles: readonly TextStyle[];
}

export interface Guide {
  readonly id: string;
  readonly orientation: 'horizontal' | 'vertical';
  readonly positionPt: number;
}

export interface TextMarks {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strikethrough: boolean;
  readonly color?: string | undefined;
  readonly fontFamily?: string | undefined;
  readonly fontSizePt?: number | undefined;
  readonly fontWeight?: number | undefined;
}

export interface TextRun {
  readonly text: string;
  readonly marks: TextMarks;
}

interface TextBlockBase {
  readonly id: string;
  readonly alignment: TextAlignment;
  readonly runs: readonly TextRun[];
}

export interface ParagraphBlock extends TextBlockBase {
  readonly type: 'paragraph';
}

export interface HeadingBlock extends TextBlockBase {
  readonly type: 'heading';
  readonly level: 1 | 2 | 3 | 4 | 5 | 6;
}

export interface ListItem {
  readonly id: string;
  readonly level: number;
  readonly runs: readonly TextRun[];
}

export interface ListBlock {
  readonly id: string;
  readonly type: 'list';
  readonly ordered: boolean;
  readonly items: readonly ListItem[];
}

export type TextBlock = ParagraphBlock | HeadingBlock | ListBlock;

export interface RichTextDocument {
  readonly blocks: readonly TextBlock[];
}

export interface TextStyleOverrides {
  readonly fontFamily?: string | undefined;
  readonly fontSizePt?: number | undefined;
  readonly fontWeight?: number | undefined;
  readonly italic?: boolean | undefined;
  readonly color?: string | undefined;
  readonly alignment?: TextAlignment | undefined;
  readonly lineHeight?: number | undefined;
  readonly letterSpacingPt?: number | undefined;
}

export type PlaceholderOverride = 'frame' | 'style' | 'visibility';

export interface PlaceholderBinding {
  readonly placeholderId: string;
  readonly overrides: readonly PlaceholderOverride[];
}

export interface BaseElement {
  readonly id: string;
  readonly name: string;
  readonly frame: Frame;
  readonly opacity: number;
  readonly visible: boolean;
  readonly locked: boolean;
  readonly placeholderBinding?: PlaceholderBinding | undefined;
}

export interface TextElement extends BaseElement {
  readonly type: 'text';
  readonly styleRole: TextStyleRole;
  readonly verticalAlignment: 'top' | 'middle' | 'bottom';
  readonly content: RichTextDocument;
  readonly style?: TextStyleOverrides | undefined;
}

export interface ImageCrop {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface ImageElement extends BaseElement {
  readonly type: 'image';
  readonly assetId: string;
  readonly altText: string;
  readonly fit: 'contain' | 'cover' | 'fill';
  readonly crop: ImageCrop;
}

export interface TableCellStyle {
  readonly fill: string | null;
  readonly textColor: string;
  readonly horizontalAlignment: TextAlignment;
  readonly verticalAlignment: 'top' | 'middle' | 'bottom';
  readonly paddingPt?: number | undefined;
}

export interface TableCell {
  readonly id: string;
  readonly row: number;
  readonly column: number;
  readonly rowSpan: number;
  readonly columnSpan: number;
  readonly content: RichTextDocument;
  readonly style: TableCellStyle;
}

export interface TableBorder {
  readonly color: string;
  readonly widthPt: number;
}

export interface TableStyle {
  readonly fill?: string | null | undefined;
  readonly headerFill?: string | null | undefined;
  readonly bandedRows?: boolean | undefined;
  readonly cellPaddingPt?: number | undefined;
}

export interface TableElement extends BaseElement {
  readonly type: 'table';
  readonly rowCount: number;
  readonly columnCount: number;
  readonly rowHeightsPt: readonly number[];
  readonly columnWidthsPt: readonly number[];
  readonly cells: readonly TableCell[];
  readonly border: TableBorder;
  readonly style?: TableStyle | undefined;
}

export type ShapeKind =
  'rectangle' | 'rounded-rectangle' | 'ellipse' | 'triangle' | 'diamond' | 'line' | 'arrow';

export interface StrokeStyle {
  readonly color: string;
  readonly widthPt: number;
  readonly dash: 'solid' | 'dash' | 'dot';
}

export interface ShadowStyle {
  readonly color: string;
  readonly blurPt: number;
  readonly offsetXPt: number;
  readonly offsetYPt: number;
  readonly opacity: number;
}

export interface ShapeElement extends BaseElement {
  readonly type: 'shape';
  readonly shape: ShapeKind;
  readonly fill: string | null;
  readonly stroke: StrokeStyle;
  readonly cornerRadiusPt: number;
  readonly shadow?: ShadowStyle | undefined;
}

export interface ConnectorBinding {
  readonly elementId?: string | undefined;
  readonly anchor?: 'top' | 'right' | 'bottom' | 'left' | 'center' | undefined;
}

export interface ConnectorEndpoint {
  readonly xPt: number;
  readonly yPt: number;
  readonly binding: ConnectorBinding;
}

export interface ConnectorElement extends BaseElement {
  readonly type: 'connector';
  /**
   * Geometry v2 stores both fallback endpoints as final coordinates in the
   * connector's immediate container.  The frame remains the affine editing
   * basis, but its rotation is already baked into those endpoint coordinates.
   *
   * Missing is the pre-marker V2 representation used by existing files. Its
   * endpoints already have final coordinates too; parsing only stamps the
   * marker and never re-applies frame.rotationDeg.
   */
  readonly geometryVersion?: 2 | undefined;
  readonly start: ConnectorEndpoint;
  readonly end: ConnectorEndpoint;
  readonly routing: 'straight' | 'elbow';
  readonly stroke: StrokeStyle;
  readonly startCap: 'none' | 'arrow';
  readonly endCap: 'none' | 'arrow';
}

export interface IconElement extends BaseElement {
  readonly type: 'icon';
  readonly iconSet: string;
  readonly iconName: string;
  readonly color: string;
}

export type PlaceholderRole =
  'title' | 'subtitle' | 'body' | 'media' | 'table' | 'footer' | 'slide-number';

export interface PlaceholderElement extends BaseElement {
  readonly type: 'placeholder';
  readonly role: PlaceholderRole;
  readonly accepts: readonly ('text' | 'image' | 'table' | 'shape' | 'icon')[];
  readonly prompt: string;
  readonly defaultTextStyle?: TextStyleOverrides | undefined;
}

export interface GroupElement extends BaseElement {
  readonly type: 'group';
  /** The unscaled coordinate space in which child frames are stored. */
  readonly coordinateSpace: {
    readonly widthPt: number;
    readonly heightPt: number;
  };
  readonly children: readonly Element[];
}

export type Element =
  | TextElement
  | ImageElement
  | TableElement
  | ShapeElement
  | ConnectorElement
  | IconElement
  | PlaceholderElement
  | GroupElement;

export interface Master {
  readonly id: string;
  readonly name: string;
  readonly themeId: string;
  readonly elements: readonly Element[];
  readonly guides: readonly Guide[];
  readonly background?: BackgroundStyle | undefined;
}

export interface Layout {
  readonly id: string;
  readonly name: string;
  readonly masterId: string;
  readonly elements: readonly Element[];
  readonly guides: readonly Guide[];
  readonly background?: BackgroundStyle | undefined;
}

export interface Slide {
  readonly id: string;
  readonly name: string;
  readonly layoutId: string;
  readonly hidden: boolean;
  readonly background?: BackgroundStyle | undefined;
  /** Array order is the canonical back-to-front stacking order. */
  readonly elements: readonly Element[];
}

export type AssetKind = 'image' | 'font';

export interface AssetRef {
  readonly id: string;
  readonly kind: AssetKind;
  readonly hash: string;
  readonly mediaType: string;
  readonly fileName: string;
  readonly byteLength?: number | undefined;
  readonly widthPx?: number | undefined;
  readonly heightPx?: number | undefined;
}

export interface DocumentMetadata {
  readonly createdAt: string;
  readonly modifiedAt: string;
  readonly locale: string;
  readonly creator?: string | undefined;
  readonly iconCatalogVersion: string;
  readonly flagCatalogVersion: string;
}

export interface GridSettings {
  readonly enabled: boolean;
  readonly spacingPt: number;
  readonly snapToGrid: boolean;
  readonly snapToObjects: boolean;
}

export interface DocumentSettings {
  readonly grid: GridSettings;
  readonly defaultBackground: BackgroundStyle;
  readonly includeHiddenSlidesInExport: boolean;
}

interface DeckDocumentBase {
  readonly id: string;
  readonly name: string;
  readonly page: PageSize;
  readonly themes: readonly Theme[];
  readonly masters: readonly Master[];
  readonly layouts: readonly Layout[];
  readonly slides: readonly Slide[];
  readonly assets: readonly AssetRef[];
}

export interface DeckDocumentV1 extends DeckDocumentBase {
  readonly schemaVersion: 1;
}

export interface DeckDocument extends DeckDocumentBase {
  readonly schemaVersion: 2;
  readonly metadata: DocumentMetadata;
  readonly settings: DocumentSettings;
}

export type DeckDocumentInput = DeckDocumentV1 | DeckDocument;

export interface CommonElementStylePatch {
  readonly opacity?: number | undefined;
}

export interface TextElementStylePatch extends CommonElementStylePatch {
  readonly kind: 'text';
  readonly style?: TextStyleOverrides | undefined;
  readonly verticalAlignment?: TextElement['verticalAlignment'] | undefined;
  readonly styleRole?: TextStyleRole | undefined;
}

export interface ShapeElementStylePatch extends CommonElementStylePatch {
  readonly kind: 'shape';
  readonly fill?: string | null | undefined;
  readonly stroke?: StrokeStyle | undefined;
  readonly cornerRadiusPt?: number | undefined;
  readonly shadow?: ShadowStyle | null | undefined;
}

export interface TableElementStylePatch extends CommonElementStylePatch {
  readonly kind: 'table';
  readonly border?: TableBorder | undefined;
  readonly style?: TableStyle | undefined;
}

export type ElementStylePatch =
  TextElementStylePatch | ShapeElementStylePatch | TableElementStylePatch;

export const STANDARD_PAGE_SIZES = {
  widescreen: { widthPt: 960, heightPt: 540 },
  standard: { widthPt: 720, heightPt: 540 },
  a4Landscape: { widthPt: 841.89, heightPt: 595.28 },
} as const satisfies Record<string, PageSize>;
