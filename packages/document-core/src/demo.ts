import type {
  BaseElement,
  DeckDocument,
  RichTextDocument,
  Slide,
  TableCell,
  TextElement,
} from './model.js';
import { STANDARD_PAGE_SIZES } from './model.js';
import { assertValidDeck } from './validation.js';

const ids = {
  deck: '10000000-0000-4000-8000-000000000001',
  theme: '10000000-0000-4000-8000-000000000002',
  master: '10000000-0000-4000-8000-000000000003',
  layoutTitle: '10000000-0000-4000-8000-000000000004',
  layoutContent: '10000000-0000-4000-8000-000000000005',
  titleStyle: '10000000-0000-4000-8000-000000000006',
  subtitleStyle: '10000000-0000-4000-8000-000000000007',
  bodyStyle: '10000000-0000-4000-8000-000000000008',
  captionStyle: '10000000-0000-4000-8000-000000000009',
  masterGuideVertical: '10000000-0000-4000-8000-00000000000a',
  masterGuideHorizontal: '10000000-0000-4000-8000-00000000000b',
  layoutTitlePlaceholder: '10000000-0000-4000-8000-00000000000c',
  layoutSubtitlePlaceholder: '10000000-0000-4000-8000-00000000000d',
  layoutContentTitlePlaceholder: '10000000-0000-4000-8000-00000000000e',
  layoutBodyPlaceholder: '10000000-0000-4000-8000-00000000000f',
} as const;

const defaultBase = (id: string, name: string, frame: BaseElement['frame']): BaseElement => ({
  id,
  name,
  frame,
  opacity: 1,
  visible: true,
  locked: false,
});

const plainText = (id: string, text: string): RichTextDocument => ({
  blocks: [
    {
      id,
      type: 'paragraph',
      alignment: 'left',
      runs: [
        {
          text,
          marks: {
            bold: false,
            italic: false,
            underline: false,
            strikethrough: false,
          },
        },
      ],
    },
  ],
});

const textElement = (
  id: string,
  blockId: string,
  name: string,
  text: string,
  styleRole: TextElement['styleRole'],
  frame: BaseElement['frame'],
): TextElement => ({
  ...defaultBase(id, name, frame),
  type: 'text',
  styleRole,
  verticalAlignment: 'middle',
  content: plainText(blockId, text),
});

const tableCell = (
  id: string,
  blockId: string,
  row: number,
  column: number,
  value: string,
  fill: string | null,
): TableCell => ({
  id,
  row,
  column,
  rowSpan: 1,
  columnSpan: 1,
  content: plainText(blockId, value),
  style: {
    fill,
    textColor: '#20242B',
    horizontalAlignment: 'left',
    verticalAlignment: 'middle',
  },
});

const createSlides = (): readonly Slide[] => [
  {
    id: '20000000-0000-4000-8000-000000000001',
    name: 'Opening',
    layoutId: ids.layoutTitle,
    hidden: false,
    elements: [
      textElement(
        '21000000-0000-4000-8000-000000000001',
        '21100000-0000-4000-8000-000000000001',
        'Presentation title',
        'A clear story starts here',
        'title',
        { xPt: 80, yPt: 170, widthPt: 800, heightPt: 90, rotationDeg: 0 },
      ),
      textElement(
        '21000000-0000-4000-8000-000000000002',
        '21100000-0000-4000-8000-000000000002',
        'Presentation subtitle',
        'Neutral demonstration deck',
        'subtitle',
        { xPt: 80, yPt: 280, widthPt: 800, heightPt: 48, rotationDeg: 0 },
      ),
    ],
  },
  {
    id: '20000000-0000-4000-8000-000000000002',
    name: 'Building blocks',
    layoutId: ids.layoutContent,
    hidden: false,
    elements: [
      textElement(
        '22000000-0000-4000-8000-000000000001',
        '22100000-0000-4000-8000-000000000001',
        'Slide title',
        'Structured building blocks',
        'title',
        { xPt: 72, yPt: 54, widthPt: 816, heightPt: 56, rotationDeg: 0 },
      ),
      {
        ...defaultBase('22000000-0000-4000-8000-000000000002', 'Accent card', {
          xPt: 72,
          yPt: 150,
          widthPt: 248,
          heightPt: 250,
          rotationDeg: 0,
        }),
        type: 'shape',
        shape: 'rounded-rectangle',
        fill: '#EAF0FF',
        stroke: { color: '#2F6BFF', widthPt: 1, dash: 'solid' },
        cornerRadiusPt: 8,
      },
      textElement(
        '22000000-0000-4000-8000-000000000003',
        '22100000-0000-4000-8000-000000000003',
        'Card copy',
        'Every object remains editable and addressable.',
        'body',
        { xPt: 96, yPt: 190, widthPt: 200, heightPt: 150, rotationDeg: 0 },
      ),
      {
        ...defaultBase('22000000-0000-4000-8000-000000000004', 'Example table', {
          xPt: 376,
          yPt: 150,
          widthPt: 512,
          heightPt: 250,
          rotationDeg: 0,
        }),
        type: 'table',
        rowCount: 3,
        columnCount: 2,
        rowHeightsPt: [50, 100, 100],
        columnWidthsPt: [220, 292],
        cells: [
          tableCell(
            '22200000-0000-4000-8000-000000000001',
            '22300000-0000-4000-8000-000000000001',
            0,
            0,
            'Element',
            '#EAF0FF',
          ),
          tableCell(
            '22200000-0000-4000-8000-000000000002',
            '22300000-0000-4000-8000-000000000002',
            0,
            1,
            'Purpose',
            '#EAF0FF',
          ),
          tableCell(
            '22200000-0000-4000-8000-000000000003',
            '22300000-0000-4000-8000-000000000003',
            1,
            0,
            'Content',
            null,
          ),
          tableCell(
            '22200000-0000-4000-8000-000000000004',
            '22300000-0000-4000-8000-000000000004',
            1,
            1,
            'Tell the story',
            null,
          ),
          tableCell(
            '22200000-0000-4000-8000-000000000005',
            '22300000-0000-4000-8000-000000000005',
            2,
            0,
            'Layout',
            null,
          ),
          tableCell(
            '22200000-0000-4000-8000-000000000006',
            '22300000-0000-4000-8000-000000000006',
            2,
            1,
            'Create hierarchy',
            null,
          ),
        ],
        border: { color: '#CBD2DC', widthPt: 1 },
      },
    ],
  },
  {
    id: '20000000-0000-4000-8000-000000000003',
    name: 'Closing',
    layoutId: ids.layoutContent,
    hidden: false,
    elements: [
      textElement(
        '23000000-0000-4000-8000-000000000001',
        '23100000-0000-4000-8000-000000000001',
        'Closing title',
        'Ready for the next idea',
        'title',
        { xPt: 120, yPt: 200, widthPt: 720, heightPt: 88, rotationDeg: 0 },
      ),
    ],
  },
];

/** Creates a deterministic, neutral deck suitable for examples and golden tests. */
export const createNeutralDemoDeck = (): DeckDocument => {
  const deck: DeckDocument = {
    schemaVersion: 2,
    id: ids.deck,
    name: 'Neutral demonstration',
    page: { ...STANDARD_PAGE_SIZES.widescreen },
    metadata: {
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      locale: 'en-US',
      iconCatalogVersion: 'lucide-v1',
      flagCatalogVersion: 'round-flags-v1',
    },
    settings: {
      grid: { enabled: true, spacingPt: 12, snapToGrid: true, snapToObjects: true },
      defaultBackground: { type: 'theme' },
      includeHiddenSlidesInExport: false,
    },
    themes: [
      {
        id: ids.theme,
        name: 'Neutral light',
        colors: {
          background: '#FFFFFF',
          surface: '#F4F6F8',
          text: '#20242B',
          mutedText: '#697386',
          accent: '#2F6BFF',
        },
        headingFontFamily: 'Arial',
        bodyFontFamily: 'Arial',
        textStyles: [
          {
            id: ids.titleStyle,
            role: 'title',
            fontFamily: 'Arial',
            fontSizePt: 32,
            fontWeight: 650,
            italic: false,
            color: '#20242B',
            alignment: 'left',
            lineHeight: 1.1,
          },
          {
            id: ids.subtitleStyle,
            role: 'subtitle',
            fontFamily: 'Arial',
            fontSizePt: 18,
            fontWeight: 400,
            italic: false,
            color: '#697386',
            alignment: 'left',
            lineHeight: 1.3,
          },
          {
            id: ids.bodyStyle,
            role: 'body',
            fontFamily: 'Arial',
            fontSizePt: 16,
            fontWeight: 400,
            italic: false,
            color: '#20242B',
            alignment: 'left',
            lineHeight: 1.35,
          },
          {
            id: ids.captionStyle,
            role: 'caption',
            fontFamily: 'Arial',
            fontSizePt: 10,
            fontWeight: 400,
            italic: false,
            color: '#697386',
            alignment: 'left',
            lineHeight: 1.25,
          },
        ],
      },
    ],
    masters: [
      {
        id: ids.master,
        name: 'Default master',
        themeId: ids.theme,
        elements: [],
        guides: [
          { id: ids.masterGuideVertical, orientation: 'vertical', positionPt: 72 },
          { id: ids.masterGuideHorizontal, orientation: 'horizontal', positionPt: 54 },
        ],
      },
    ],
    layouts: [
      {
        id: ids.layoutTitle,
        name: 'Title',
        masterId: ids.master,
        elements: [
          {
            ...defaultBase(ids.layoutTitlePlaceholder, 'Title placeholder', {
              xPt: 80,
              yPt: 170,
              widthPt: 800,
              heightPt: 90,
              rotationDeg: 0,
            }),
            type: 'placeholder',
            role: 'title',
            accepts: ['text'],
            prompt: 'Add a title',
          },
          {
            ...defaultBase(ids.layoutSubtitlePlaceholder, 'Subtitle placeholder', {
              xPt: 80,
              yPt: 280,
              widthPt: 800,
              heightPt: 48,
              rotationDeg: 0,
            }),
            type: 'placeholder',
            role: 'subtitle',
            accepts: ['text'],
            prompt: 'Add a subtitle',
          },
        ],
        guides: [],
      },
      {
        id: ids.layoutContent,
        name: 'Title and content',
        masterId: ids.master,
        elements: [
          {
            ...defaultBase(ids.layoutContentTitlePlaceholder, 'Title placeholder', {
              xPt: 72,
              yPt: 54,
              widthPt: 816,
              heightPt: 56,
              rotationDeg: 0,
            }),
            type: 'placeholder',
            role: 'title',
            accepts: ['text'],
            prompt: 'Add a title',
          },
          {
            ...defaultBase(ids.layoutBodyPlaceholder, 'Body placeholder', {
              xPt: 72,
              yPt: 136,
              widthPt: 816,
              heightPt: 330,
              rotationDeg: 0,
            }),
            type: 'placeholder',
            role: 'body',
            accepts: ['text', 'image', 'table', 'shape', 'icon'],
            prompt: 'Add content',
          },
        ],
        guides: [],
      },
    ],
    slides: createSlides(),
    assets: [],
  };

  assertValidDeck(deck);
  return structuredClone(deck);
};
