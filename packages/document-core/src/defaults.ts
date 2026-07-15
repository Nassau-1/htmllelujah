import type { BaseElement, DeckDocument, Frame, RichTextDocument, TextElement } from './model.js';
import { STANDARD_PAGE_SIZES } from './model.js';
import { createThemeFromCatalog, type IdFactory, type StyleCatalog } from './styles.js';

export interface CreateDefaultDeckOptions {
  readonly idFactory?: IdFactory | undefined;
  readonly now?: (() => string) | undefined;
  readonly name?: string | undefined;
  readonly locale?: string | undefined;
  readonly creator?: string | undefined;
  readonly styleCatalog?: StyleCatalog | undefined;
}

const defaultIdFactory: IdFactory = () => globalThis.crypto.randomUUID();

const baseElement = (id: string, name: string, frame: Frame): BaseElement => ({
  id,
  name,
  frame,
  opacity: 1,
  visible: true,
  locked: false,
});

const paragraph = (id: string, text: string): RichTextDocument => ({
  blocks: [
    {
      id,
      type: 'paragraph',
      alignment: 'left',
      runs: [
        {
          text,
          marks: { bold: false, italic: false, underline: false, strikethrough: false },
        },
      ],
    },
  ],
});

export const createDefaultDeck = (options: CreateDefaultDeckOptions = {}): DeckDocument => {
  const idFactory = options.idFactory ?? defaultIdFactory;
  const timestamp = (options.now ?? (() => new Date().toISOString()))();
  const theme = createThemeFromCatalog(idFactory, options.styleCatalog);
  const masterId = idFactory();
  const layoutId = idFactory();
  const titlePlaceholderId = idFactory();
  const bodyPlaceholderId = idFactory();
  const slideId = idFactory();

  const title: TextElement = {
    ...baseElement(idFactory(), 'Title', {
      xPt: 72,
      yPt: 54,
      widthPt: 816,
      heightPt: 60,
      rotationDeg: 0,
    }),
    type: 'text',
    styleRole: 'title',
    verticalAlignment: 'middle',
    content: paragraph(idFactory(), 'Untitled presentation'),
    placeholderBinding: { placeholderId: titlePlaceholderId, overrides: [] },
  };
  const body: TextElement = {
    ...baseElement(idFactory(), 'Body', {
      xPt: 72,
      yPt: 142,
      widthPt: 816,
      heightPt: 310,
      rotationDeg: 0,
    }),
    type: 'text',
    styleRole: 'body',
    verticalAlignment: 'top',
    content: paragraph(idFactory(), 'Start writing here.'),
    placeholderBinding: { placeholderId: bodyPlaceholderId, overrides: [] },
  };

  return {
    schemaVersion: 2,
    id: idFactory(),
    name: options.name ?? 'Untitled presentation',
    page: { ...STANDARD_PAGE_SIZES.widescreen },
    metadata: {
      createdAt: timestamp,
      modifiedAt: timestamp,
      locale: options.locale ?? 'en-US',
      ...(options.creator === undefined ? {} : { creator: options.creator }),
      iconCatalogVersion: 'lucide-v1',
      flagCatalogVersion: 'round-flags-v1',
    },
    settings: {
      grid: { enabled: true, spacingPt: 12, snapToGrid: true, snapToObjects: true },
      defaultBackground: { type: 'theme' },
      includeHiddenSlidesInExport: false,
    },
    themes: [theme],
    masters: [
      {
        id: masterId,
        name: 'Default master',
        themeId: theme.id,
        background: { type: 'theme' },
        elements: [],
        guides: [],
      },
    ],
    layouts: [
      {
        id: layoutId,
        name: 'Title and content',
        masterId,
        elements: [
          {
            ...baseElement(titlePlaceholderId, 'Title placeholder', {
              xPt: 72,
              yPt: 54,
              widthPt: 816,
              heightPt: 60,
              rotationDeg: 0,
            }),
            type: 'placeholder',
            role: 'title',
            accepts: ['text'],
            prompt: 'Add a title',
          },
          {
            ...baseElement(bodyPlaceholderId, 'Body placeholder', {
              xPt: 72,
              yPt: 142,
              widthPt: 816,
              heightPt: 310,
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
    slides: [
      {
        id: slideId,
        name: 'Slide 1',
        layoutId,
        hidden: false,
        elements: [title, body],
      },
    ],
    assets: [],
  };
};
