import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  SlideSurface,
  type PathElement,
  type RenderElement,
  type RenderMode,
  type ShapeElement,
  type ShapeKind,
} from '../src/index.js';
import { fixtureSlide } from './fixtures.js';

const newShapeKinds: readonly ShapeKind[] = [
  'right-triangle',
  'parallelogram',
  'trapezoid',
  'pentagon',
  'hexagon',
  'octagon',
  'chevron',
  'cross',
  'donut',
  'left-bracket',
  'right-bracket',
  'arc',
];

const shape = (kind: ShapeKind, index: number): ShapeElement => ({
  id: `business-${kind}`,
  name: kind,
  type: 'shape',
  frame: { xPt: index * 105, yPt: 0, widthPt: 100, heightPt: 60, rotationDeg: 0 },
  opacity: 1,
  visible: true,
  locked: false,
  shape: kind,
  fill: '#DDEEFF',
  stroke: { color: '#225588', widthPt: 2, dash: 'solid' },
  cornerRadiusPt: 0,
});

const path: PathElement = {
  id: 'freeform-path',
  name: 'Freeform path',
  type: 'path',
  frame: { xPt: 0, yPt: 80, widthPt: 100, heightPt: 60, rotationDeg: 0 },
  opacity: 1,
  visible: true,
  locked: false,
  commands: [
    { type: 'move', xPt: 0, yPt: 30 },
    {
      type: 'cubic',
      control1XPt: 10,
      control1YPt: 0,
      control2XPt: 90,
      control2YPt: 60,
      xPt: 100,
      yPt: 30,
    },
    { type: 'line', xPt: 50, yPt: 60 },
    { type: 'close' },
  ],
  fill: '#DDEEFF',
  fillRule: 'evenodd',
  stroke: { color: '#225588', widthPt: 2, dash: 'dash' },
  shadow: {
    color: '#000000',
    blurPt: 4,
    offsetXPt: 2,
    offsetYPt: 3,
    opacity: 0.25,
  },
};

const renderVectors = (mode: RenderMode, elements: readonly RenderElement[]): string =>
  renderToStaticMarkup(<SlideSurface slide={{ ...fixtureSlide, elements }} mode={mode} />);

describe('business shape and freeform SVG rendering', () => {
  it.each(['editor', 'thumbnail', 'presentation', 'html'] as const)(
    'uses the same deterministic bounded SVG geometry in %s mode',
    (mode) => {
      const elements = [...newShapeKinds.map(shape), path];
      const first = renderVectors(mode, elements);
      const second = renderVectors(mode, elements);

      expect(first).toBe(second);
      expect(first.match(/data-element-type="shape"/g) ?? []).toHaveLength(newShapeKinds.length);
      expect(first).toContain('data-element-type="path"');
      expect(first).toContain('points="0,0 100,60 0,60"');
      expect(first).toContain('points="20,0 100,0 80,60 0,60"');
      expect(first).toContain('points="20,0 80,0 100,60 0,60"');
      expect(first).toContain(
        'd="M 100 30 A 50 30 0 1 1 0 30 A 50 30 0 1 1 100 30 Z M 75 30 A 25 15 0 1 0 25 30 A 25 15 0 1 0 75 30 Z"',
      );
      expect(first).toContain('d="M 100 0 L 0 0 L 0 60 L 100 60"');
      expect(first).toContain('d="M 0 0 L 100 0 L 100 60 L 0 60"');
      expect(first).toContain('d="M 0 60 A 50 60 0 0 1 100 60"');
      expect(first).toContain('d="M 0 30 C 10 0 90 60 100 30 L 50 60 Z"');
      expect(first).toContain('fill-rule="evenodd"');
      expect(first).toContain('drop-shadow(2pt 3pt 4pt #00000040)');
    },
  );

  it('defensively clamps untrusted direct-render coordinates and command count', () => {
    const unsafe: PathElement = {
      ...path,
      id: 'unsafe-path',
      commands: [
        { type: 'move', xPt: -50, yPt: Number.NaN },
        { type: 'line', xPt: 999, yPt: 999 },
        ...Array.from({ length: 4_100 }, () => ({ type: 'close' as const })),
      ],
    };
    const html = renderVectors('presentation', [unsafe]);

    expect(html).toContain('d="M 0 0 L 100 60');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('999');
    expect((html.match(/ Z/g) ?? []).length).toBe(4_094);
  });
});
