import type { Deck, Slide, SlideElement, TableElement, TextElement } from './model';

let sequence = 100;

export function createId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

const coverElements: SlideElement[] = [
  {
    id: 'cover-kicker',
    kind: 'text',
    x: 72,
    y: 72,
    width: 316,
    height: 26,
    rotation: 0,
    fill: 'none',
    text: 'QUARTERLY STRATEGY',
    fontSize: 14,
    fontWeight: 600,
    align: 'left',
    role: 'caption',
  },
  {
    id: 'cover-title',
    kind: 'text',
    x: 72,
    y: 132,
    width: 538,
    height: 142,
    rotation: 0,
    fill: 'none',
    text: 'Turning momentum into durable growth',
    fontSize: 46,
    fontWeight: 600,
    align: 'left',
    role: 'title',
  },
  {
    id: 'cover-subtitle',
    kind: 'text',
    x: 74,
    y: 298,
    width: 472,
    height: 65,
    rotation: 0,
    fill: 'none',
    text: 'A focused operating plan for the next stage of the journey.',
    fontSize: 20,
    fontWeight: 400,
    align: 'left',
    role: 'subtitle',
  },
  {
    id: 'cover-shape',
    kind: 'shape',
    x: 675,
    y: 78,
    width: 204,
    height: 382,
    rotation: 0,
    fill: 'accent',
    shape: 'rounded',
    label: '',
  },
  {
    id: 'cover-date',
    kind: 'text',
    x: 74,
    y: 444,
    width: 220,
    height: 30,
    rotation: 0,
    fill: 'none',
    text: 'JULY 2026',
    fontSize: 13,
    fontWeight: 500,
    align: 'left',
    role: 'caption',
  },
];

const metricsElements: SlideElement[] = [
  {
    id: 'metrics-title',
    kind: 'text',
    x: 68,
    y: 52,
    width: 620,
    height: 58,
    rotation: 0,
    fill: 'none',
    text: 'Momentum is building',
    fontSize: 35,
    fontWeight: 600,
    align: 'left',
    role: 'title',
  },
  {
    id: 'metrics-subtitle',
    kind: 'text',
    x: 70,
    y: 116,
    width: 650,
    height: 34,
    rotation: 0,
    fill: 'none',
    text: 'Three signals point to a stronger second half.',
    fontSize: 17,
    fontWeight: 400,
    align: 'left',
    role: 'subtitle',
  },
  {
    id: 'metric-one',
    kind: 'shape',
    x: 70,
    y: 198,
    width: 242,
    height: 214,
    rotation: 0,
    fill: 'accent-soft',
    shape: 'rounded',
    label: '+28%\nRevenue growth',
  },
  {
    id: 'metric-two',
    kind: 'shape',
    x: 359,
    y: 198,
    width: 242,
    height: 214,
    rotation: 0,
    fill: 'mint',
    shape: 'rounded',
    label: '91%\nRetention',
  },
  {
    id: 'metric-three',
    kind: 'shape',
    x: 648,
    y: 198,
    width: 242,
    height: 214,
    rotation: 0,
    fill: 'warm',
    shape: 'rounded',
    label: '2.4×\nPipeline coverage',
  },
];

const roadmapElements: SlideElement[] = [
  {
    id: 'roadmap-title',
    kind: 'text',
    x: 68,
    y: 50,
    width: 620,
    height: 56,
    rotation: 0,
    fill: 'none',
    text: 'A simple path to scale',
    fontSize: 35,
    fontWeight: 600,
    align: 'left',
    role: 'title',
  },
  {
    id: 'roadmap-line',
    kind: 'shape',
    x: 112,
    y: 274,
    width: 736,
    height: 4,
    rotation: 0,
    fill: 'accent-soft',
    shape: 'rounded',
    label: '',
  },
  ...['Focus', 'Prove', 'Scale'].flatMap((label, index): SlideElement[] => {
    const x = 126 + index * 332;
    return [
      {
        id: `roadmap-node-${index}`,
        kind: 'shape',
        x,
        y: 232,
        width: 88,
        height: 88,
        rotation: 0,
        fill: index === 1 ? 'accent' : 'ink',
        shape: 'ellipse',
        label: `${index + 1}`,
      },
      {
        id: `roadmap-label-${index}`,
        kind: 'text',
        x: x - 20,
        y: 344,
        width: 128,
        height: 54,
        rotation: 0,
        fill: 'none',
        text: label,
        fontSize: 21,
        fontWeight: 600,
        align: 'center',
        role: 'body',
      },
    ];
  }),
];

const tableElement: TableElement = {
  id: 'plan-table',
  kind: 'table',
  x: 72,
  y: 160,
  width: 816,
  height: 286,
  rotation: 0,
  fill: 'none',
  rows: [
    ['Initiative', 'Owner', 'Timing', 'Impact'],
    ['Segment focus', 'Commercial', 'Q3', 'High'],
    ['Core workflow', 'Product', 'Q3–Q4', 'High'],
    ['Operating cadence', 'Leadership', 'Now', 'Medium'],
  ],
};

export const initialDeck: Deck = {
  id: 'deck-strategy',
  title: 'Growth strategy 2026',
  slides: [
    { id: 'slide-cover', title: 'Cover', section: 'INTRO', elements: coverElements },
    { id: 'slide-metrics', title: 'Momentum', section: 'CONTEXT', elements: metricsElements },
    { id: 'slide-roadmap', title: 'Roadmap', section: 'STRATEGY', elements: roadmapElements },
    {
      id: 'slide-plan',
      title: 'Action plan',
      section: 'EXECUTION',
      elements: [
        {
          id: 'plan-title',
          kind: 'text',
          x: 68,
          y: 50,
          width: 620,
          height: 56,
          rotation: 0,
          fill: 'none',
          text: 'From strategy to action',
          fontSize: 35,
          fontWeight: 600,
          align: 'left',
          role: 'title',
        },
        tableElement,
      ],
    },
  ],
};

export function createTextElement(): TextElement {
  return {
    id: createId('text'),
    kind: 'text',
    x: 96,
    y: 92,
    width: 360,
    height: 70,
    rotation: 0,
    fill: 'none',
    text: 'Type something remarkable',
    fontSize: 28,
    fontWeight: 600,
    align: 'left',
    role: 'title',
  };
}

export function createShapeElement(): SlideElement {
  return {
    id: createId('shape'),
    kind: 'shape',
    x: 164,
    y: 164,
    width: 220,
    height: 124,
    rotation: 0,
    fill: 'accent-soft',
    shape: 'rounded',
    label: 'Shape',
  };
}

export function createImageElement(): SlideElement {
  return {
    id: createId('image'),
    kind: 'image',
    x: 184,
    y: 120,
    width: 420,
    height: 252,
    rotation: 0,
    fill: 'none',
    label: 'Image placeholder',
    caption: 'Drop or replace image',
  };
}

export function createTableElement(): TableElement {
  return {
    id: createId('table'),
    kind: 'table',
    x: 120,
    y: 154,
    width: 620,
    height: 208,
    rotation: 0,
    fill: 'none',
    rows: [
      ['Heading', 'Heading', 'Heading'],
      ['Content', 'Content', 'Content'],
      ['Content', 'Content', 'Content'],
    ],
  };
}

export function createBlankSlide(): Slide {
  const id = createId('slide');
  return {
    id,
    title: 'Untitled slide',
    section: 'NEW',
    elements: [createTextElement()],
  };
}
