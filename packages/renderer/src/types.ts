export type RenderMode = 'editor' | 'thumbnail' | 'presentation' | 'html' | 'pdf';

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

export type TextAlignment = 'left' | 'center' | 'right' | 'justify';
export type TextStyleRole = 'title' | 'subtitle' | 'body' | 'caption' | 'label' | 'quote';

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

export interface ParagraphBlock {
  readonly id: string;
  readonly type: 'paragraph';
  readonly alignment: TextAlignment;
  readonly runs: readonly TextRun[];
}

export interface HeadingBlock {
  readonly id: string;
  readonly type: 'heading';
  readonly level: 1 | 2 | 3 | 4 | 5 | 6;
  readonly alignment: TextAlignment;
  readonly runs: readonly TextRun[];
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

export interface TextStyle {
  readonly id?: string | undefined;
  readonly role: TextStyleRole;
  readonly fontFamily: string;
  readonly fontSizePt: number;
  readonly fontWeight: number;
  readonly italic: boolean;
  readonly color: string;
  readonly alignment: TextAlignment;
  readonly lineHeight: number;
  readonly letterSpacingPt?: number | undefined;
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

export interface RenderTheme {
  readonly colors: {
    readonly background: string;
    readonly surface: string;
    readonly text: string;
    readonly mutedText: string;
    readonly accent: string;
  };
  readonly headingFontFamily: string;
  readonly bodyFontFamily: string;
  readonly textStyles: readonly TextStyle[];
}

export type SlideBackground =
  | Readonly<{ type: 'solid'; color: string }>
  | Readonly<{
      type: 'image';
      assetId: string;
      fit: 'contain' | 'cover' | 'fill';
      opacity: number;
    }>;

export type BackgroundInput = SlideBackground | Readonly<{ type: 'theme' }>;

export interface PlaceholderBinding {
  readonly placeholderId: string;
  readonly overrides: readonly ('frame' | 'style' | 'visibility')[];
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

export interface ImageElement extends BaseElement {
  readonly type: 'image';
  readonly assetId: string;
  readonly altText: string;
  readonly fit: 'contain' | 'cover' | 'fill';
  readonly crop: {
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
  };
}

export interface TableCell {
  readonly id: string;
  readonly row: number;
  readonly column: number;
  readonly rowSpan: number;
  readonly columnSpan: number;
  readonly content: RichTextDocument;
  readonly style: {
    readonly fill: string | null;
    readonly textColor: string;
    readonly horizontalAlignment: TextAlignment;
    readonly verticalAlignment: 'top' | 'middle' | 'bottom';
    readonly paddingPt?: number | undefined;
  };
}

export interface TableElement extends BaseElement {
  readonly type: 'table';
  readonly rowCount: number;
  readonly columnCount: number;
  readonly rowHeightsPt: readonly number[];
  readonly columnWidthsPt: readonly number[];
  readonly cells: readonly TableCell[];
  readonly border: { readonly color: string; readonly widthPt: number };
  readonly style?:
    | {
        readonly fill?: string | null | undefined;
        readonly headerFill?: string | null | undefined;
        readonly bandedRows?: boolean | undefined;
        readonly cellPaddingPt?: number | undefined;
      }
    | undefined;
}

export type ShapeKind =
  'rectangle' | 'rounded-rectangle' | 'ellipse' | 'triangle' | 'diamond' | 'line' | 'arrow';

export interface StrokeStyle {
  readonly color: string;
  readonly widthPt: number;
  readonly dash: 'solid' | 'dash' | 'dot';
}

export interface ShapeElement extends BaseElement {
  readonly type: 'shape';
  readonly shape: ShapeKind;
  readonly fill: string | null;
  readonly stroke: StrokeStyle;
  readonly cornerRadiusPt: number;
  readonly shadow?:
    | {
        readonly color: string;
        readonly blurPt: number;
        readonly offsetXPt: number;
        readonly offsetYPt: number;
        readonly opacity: number;
      }
    | undefined;
}

export interface ConnectorElement extends BaseElement {
  readonly type: 'connector';
  /** See document-core: missing is the compatible pre-marker final-point representation. */
  readonly geometryVersion?: 2 | undefined;
  readonly start: {
    readonly xPt: number;
    readonly yPt: number;
    readonly binding: Readonly<{
      elementId?: string | undefined;
      anchor?: 'top' | 'right' | 'bottom' | 'left' | 'center' | undefined;
    }>;
  };
  readonly end: {
    readonly xPt: number;
    readonly yPt: number;
    readonly binding: Readonly<{
      elementId?: string | undefined;
      anchor?: 'top' | 'right' | 'bottom' | 'left' | 'center' | undefined;
    }>;
  };
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

export interface PlaceholderElement extends BaseElement {
  readonly type: 'placeholder';
  readonly role: 'title' | 'subtitle' | 'body' | 'media' | 'table' | 'footer' | 'slide-number';
  readonly accepts: readonly ('text' | 'image' | 'table' | 'shape' | 'icon')[];
  readonly prompt: string;
  readonly defaultTextStyle?: TextStyleOverrides | undefined;
}

export interface GroupElement extends BaseElement {
  readonly type: 'group';
  readonly coordinateSpace: PageSize;
  readonly children: readonly RenderElement[];
}

export type RenderElement =
  | TextElement
  | ImageElement
  | TableElement
  | ShapeElement
  | ConnectorElement
  | IconElement
  | PlaceholderElement
  | GroupElement;

export interface ResolvedSlide {
  readonly id: string;
  readonly name: string;
  readonly page: PageSize;
  readonly background: SlideBackground;
  readonly theme: RenderTheme;
  /** Canonical back-to-front order. */
  readonly elements: readonly RenderElement[];
}

/** Structural view of document-core's richer, source-aware slide projection. */
export interface DocumentResolvedElementProjection {
  readonly source: 'master' | 'layout' | 'slide';
  readonly element: RenderElement;
  readonly resolvedTextStyle?: TextStyleOverrides | undefined;
}

/**
 * Kept structural so the renderer does not introduce a runtime dependency on
 * document-core. A document-core ResolvedSlide is assignable to this shape.
 */
export interface DocumentResolvedSlideProjection {
  readonly documentId: string;
  readonly page: PageSize;
  readonly slide: Readonly<{ id: string; name: string }>;
  readonly theme: RenderTheme;
  readonly background: BackgroundInput;
  readonly elements: readonly DocumentResolvedElementProjection[];
}

export type ResolvedSlideInput = ResolvedSlide | DocumentResolvedSlideProjection;

export type AssetResolver = (assetId: string) => string | null | undefined;

export interface DeckLike {
  readonly page: PageSize;
  readonly themes: readonly (RenderTheme & { readonly id: string })[];
  readonly masters: readonly {
    readonly id: string;
    readonly themeId: string;
    readonly background?: BackgroundInput | undefined;
    readonly elements: readonly RenderElement[];
  }[];
  readonly layouts: readonly {
    readonly id: string;
    readonly masterId: string;
    readonly background?: BackgroundInput | undefined;
    readonly elements: readonly RenderElement[];
  }[];
  readonly slides: readonly {
    readonly id: string;
    readonly name: string;
    readonly layoutId: string;
    readonly background?: BackgroundInput | undefined;
    readonly elements: readonly RenderElement[];
  }[];
  readonly settings?:
    | {
        readonly defaultBackground: BackgroundInput;
      }
    | undefined;
}
