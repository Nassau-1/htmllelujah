import type {
  BaseElement,
  ConnectorElement,
  GroupElement,
  IconElement,
  ImageElement,
  PlaceholderElement,
  RenderElement,
  RenderMode,
  ResolvedSlide,
  RichTextDocument,
  ShapeElement,
  TableElement,
  TextElement,
  TextMarks,
} from '../src/index.js';

export const MODES: readonly RenderMode[] = ['editor', 'thumbnail', 'presentation', 'html', 'pdf'];

const marks = (overrides: Partial<TextMarks> = {}): TextMarks => ({
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  ...overrides,
});

export const paragraph = (text: string): RichTextDocument => ({
  blocks: [
    {
      id: `paragraph-${text.length}`,
      type: 'paragraph',
      alignment: 'left',
      runs: [{ text, marks: marks() }],
    },
  ],
});

const base = (
  id: string,
  xPt: number,
  yPt: number,
  widthPt: number,
  heightPt: number,
): BaseElement => ({
  id,
  name: `Element ${id}`,
  frame: { xPt, yPt, widthPt, heightPt, rotationDeg: id === 'shape-diamond' ? 12.5 : 0 },
  opacity: id === 'shape-ellipse' ? 0.42 : 1,
  visible: true,
  locked: id === 'text-main',
});

const textElement: TextElement = {
  ...base('text-main', 18, 14, 330, 180),
  type: 'text',
  styleRole: 'body',
  verticalAlignment: 'middle',
  style: {
    fontFamily: 'Inter, sans-serif',
    fontSizePt: 15.25,
    fontWeight: 450,
    color: '#123456',
    lineHeight: 1.3,
    letterSpacingPt: 0.125,
  },
  content: {
    blocks: [
      ...([1, 2, 3, 4, 5, 6] as const).map((level) => ({
        id: `heading-${level}`,
        type: 'heading' as const,
        level,
        alignment: 'left' as const,
        runs: [{ text: `Heading ${level}`, marks: marks(level === 1 ? { bold: true } : {}) }],
      })),
      {
        id: 'paragraph-danger',
        type: 'paragraph',
        alignment: 'justify',
        runs: [
          {
            text: '<script>globalThis.compromised = true</script> & safe',
            marks: marks({
              bold: true,
              italic: true,
              underline: true,
              strikethrough: true,
              color: '#ff00aa',
            }),
          },
        ],
      },
      {
        id: 'unordered',
        type: 'list',
        ordered: false,
        items: [
          { id: 'u-1', level: 0, runs: [{ text: 'First bullet', marks: marks() }] },
          { id: 'u-2', level: 2, runs: [{ text: 'Nested bullet', marks: marks() }] },
        ],
      },
      {
        id: 'ordered',
        type: 'list',
        ordered: true,
        items: [{ id: 'o-1', level: 0, runs: [{ text: 'First step', marks: marks() }] }],
      },
    ],
  },
};

const safeImage: ImageElement = {
  ...base('image-safe', 360, 14, 140, 90),
  type: 'image',
  assetId: 'safe-image',
  altText: 'A quote: " onerror="globalThis.compromised=true',
  fit: 'cover',
  crop: { top: 0.1, right: 0.2, bottom: 0.1, left: 0.2 },
};

const blockedImage: ImageElement = {
  ...base('image-blocked', 510, 14, 140, 90),
  type: 'image',
  assetId: 'blocked-image',
  altText: 'Blocked',
  fit: 'contain',
  crop: { top: 0, right: 0, bottom: 0, left: 0 },
};

const table: TableElement = {
  ...base('table-main', 360, 116, 292, 110),
  type: 'table',
  rowCount: 2,
  columnCount: 3,
  rowHeightsPt: [30, 40],
  columnWidthsPt: [80, 100, 100],
  border: { color: '#203040', widthPt: 0.75 },
  style: { headerFill: '#dce8ff', bandedRows: true, cellPaddingPt: 5 },
  cells: [
    {
      id: 'cell-header',
      row: 0,
      column: 0,
      rowSpan: 1,
      columnSpan: 2,
      content: paragraph('Merged <header>'),
      style: {
        fill: null,
        textColor: '#112233',
        horizontalAlignment: 'center',
        verticalAlignment: 'middle',
      },
    },
    {
      id: 'cell-header-3',
      row: 0,
      column: 2,
      rowSpan: 2,
      columnSpan: 1,
      content: paragraph('Tall'),
      style: {
        fill: '#ffeecc',
        textColor: '#112233',
        horizontalAlignment: 'right',
        verticalAlignment: 'bottom',
        paddingPt: 2,
      },
    },
    {
      id: 'cell-body',
      row: 1,
      column: 0,
      rowSpan: 1,
      columnSpan: 2,
      content: paragraph('Body & details'),
      style: {
        fill: null,
        textColor: '#112233',
        horizontalAlignment: 'left',
        verticalAlignment: 'top',
      },
    },
  ],
};

const shapeKinds = [
  'rectangle',
  'rounded-rectangle',
  'ellipse',
  'triangle',
  'diamond',
  'line',
  'arrow',
] as const;

const shapes: readonly ShapeElement[] = shapeKinds.map((shape, index) => ({
  ...base(`shape-${shape}`, 18 + index * 52, 244, 42, 42),
  type: 'shape',
  shape,
  fill: shape === 'line' || shape === 'arrow' ? null : '#cce2ff',
  stroke: { color: '#2859a9', widthPt: 1.25, dash: index % 2 === 0 ? 'solid' : 'dash' },
  cornerRadiusPt: 7,
  ...(shape === 'diamond'
    ? {
        shadow: {
          color: '#000000',
          blurPt: 3,
          offsetXPt: 1,
          offsetYPt: 2,
          opacity: 0.25,
        },
      }
    : {}),
}));

const connector = (
  id: string,
  routing: ConnectorElement['routing'],
  yPt: number,
): ConnectorElement => ({
  ...base(id, 0, 0, 720, 405),
  type: 'connector',
  start: { xPt: 400, yPt, binding: {} },
  end: { xPt: 650, yPt: yPt + 35, binding: { elementId: 'table-main', anchor: 'left' } },
  routing,
  stroke: { color: '#d42a87', widthPt: 1.5, dash: routing === 'elbow' ? 'dot' : 'solid' },
  startCap: routing === 'elbow' ? 'arrow' : 'none',
  endCap: 'arrow',
});

const icon = (id: string, iconSet: string, iconName: string, xPt: number): IconElement => ({
  ...base(id, xPt, 304, 42, 42),
  type: 'icon',
  iconSet,
  iconName,
  color: '#193d73',
});

const nestedGroup: GroupElement = {
  ...base('group-outer', 390, 292, 180, 82),
  type: 'group',
  coordinateSpace: { widthPt: 180, heightPt: 82 },
  children: [
    {
      ...base('group-inner', 4, 4, 172, 72),
      type: 'group',
      coordinateSpace: { widthPt: 172, heightPt: 72 },
      children: [
        {
          ...base('nested-text', 8, 8, 116, 28),
          type: 'text',
          styleRole: 'caption',
          verticalAlignment: 'top',
          content: paragraph('Nested group content'),
        },
        {
          ...base('nested-shape', 130, 8, 28, 28),
          type: 'shape',
          shape: 'ellipse',
          fill: '#55aa77',
          stroke: { color: '#164f2c', widthPt: 1, dash: 'solid' },
          cornerRadiusPt: 0,
        },
      ],
    },
  ],
};

const placeholder: PlaceholderElement = {
  ...base('placeholder-main', 584, 292, 118, 82),
  type: 'placeholder',
  role: 'media',
  accepts: ['image', 'shape', 'icon'],
  prompt: 'Drop media <here>',
};

const hiddenElement: TextElement = {
  ...base('hidden-element', 0, 0, 10, 10),
  visible: false,
  type: 'text',
  styleRole: 'body',
  verticalAlignment: 'top',
  content: paragraph('MUST_NOT_RENDER'),
};

const elements: readonly RenderElement[] = [
  textElement,
  safeImage,
  blockedImage,
  table,
  ...shapes,
  connector('connector-straight', 'straight', 240),
  connector('connector-elbow', 'elbow', 270),
  icon('icon-check', 'local', 'check', 18),
  icon('icon-flag', 'flags', 'fr', 72),
  icon('icon-unknown', 'local', 'remote-logo', 126),
  icon('icon-twemoji', 'twemoji', '1f600', 180),
  nestedGroup,
  placeholder,
  hiddenElement,
];

export const fixtureSlide: ResolvedSlide = {
  id: 'slide-<unsafe>',
  name: 'Slide "unsafe" <name>',
  page: { widthPt: 720, heightPt: 405 },
  background: { type: 'image', assetId: 'background-image', fit: 'cover', opacity: 0.65 },
  theme: {
    colors: {
      background: '#fafafa',
      surface: '#ffffff',
      text: '#172033',
      mutedText: '#68768d',
      accent: '#2864dc',
    },
    headingFontFamily: 'Arial, sans-serif',
    bodyFontFamily: 'Inter, sans-serif',
    textStyles: [
      {
        id: 'body',
        role: 'body',
        fontFamily: 'Inter, sans-serif',
        fontSizePt: 16,
        fontWeight: 400,
        italic: false,
        color: '#172033',
        alignment: 'left',
        lineHeight: 1.2,
      },
    ],
  },
  elements,
};

export const assetResolver = (assetId: string): string | null => {
  if (assetId === 'safe-image') return 'htmllelujah-asset://deck/images/safe.png';
  if (assetId === 'background-image') return 'data:image/png;base64,iVBORw0KGgo=';
  if (assetId === 'blocked-image') return 'https://tracking.invalid/secret.png';
  return null;
};
