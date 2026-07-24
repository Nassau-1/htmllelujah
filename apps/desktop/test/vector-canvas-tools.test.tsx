import {
  applyTransaction,
  createDefaultDeck,
  elementSchema,
  undoTransaction,
  type PathElement,
} from '@htmllelujah/document-core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CanonicalSlideCanvas } from '../src/renderer/components/CanonicalSlideCanvas.js';
import {
  createConnectorElement,
  createShapeElement,
} from '../src/renderer/editor/canonical-factories.js';
import {
  appendDistinctCanvasPoint,
  canFinishFreeform,
  connectorAnchorCandidates,
  createPathElementFromCanvasPoints,
  directConnectorEndpointCommands,
  frameLocalPointToSlide,
  pathPointHandles,
  slidePointToFrameLocal,
  snapConnectorEndpoint,
  updatePathPoint,
} from '../src/renderer/editor/vector-canvas-tools.js';

describe('freeform canvas tools', () => {
  it('creates bounded open and closed canonical paths from slide points', () => {
    const points = [
      { xPt: 120, yPt: 80 },
      { xPt: 280, yPt: 100 },
      { xPt: 210, yPt: 260 },
    ];
    const open = createPathElementFromCanvasPoints(
      points,
      false,
      'c0000000-0000-4000-8000-000000000001',
    );
    const closed = createPathElementFromCanvasPoints(
      points,
      true,
      'c0000000-0000-4000-8000-000000000002',
    );

    expect(open.frame).toEqual({
      xPt: 120,
      yPt: 80,
      widthPt: 160,
      heightPt: 180,
      rotationDeg: 0,
    });
    expect(open.commands).toEqual([
      { type: 'move', xPt: 0, yPt: 0 },
      { type: 'line', xPt: 160, yPt: 20 },
      { type: 'line', xPt: 90, yPt: 180 },
    ]);
    expect(open.fill).toBeNull();
    expect(closed.commands.at(-1)).toEqual({ type: 'close' });
    expect(closed.fill).toBe('#DCE8FF');
    expect(elementSchema.safeParse(open).success).toBe(true);
    expect(elementSchema.safeParse(closed).success).toBe(true);
  });

  it('deduplicates double-click points and enforces the open/closed minimum', () => {
    const first = appendDistinctCanvasPoint([], { xPt: 10, yPt: 10 });
    const duplicate = appendDistinctCanvasPoint(first, { xPt: 10.4, yPt: 10.4 }, 1);
    const second = appendDistinctCanvasPoint(duplicate, { xPt: 40, yPt: 10 }, 1);

    expect(duplicate).toBe(first);
    expect(second).toHaveLength(2);
    expect(canFinishFreeform(second, false)).toBe(true);
    expect(canFinishFreeform(second, true)).toBe(false);
    expect(() =>
      createPathElementFromCanvasPoints(second, true, 'c0000000-0000-4000-8000-000000000003'),
    ).toThrow('at least three');
  });

  it('edits anchors and cubic controls within the local frame', () => {
    const element: PathElement = {
      ...createPathElementFromCanvasPoints(
        [
          { xPt: 100, yPt: 100 },
          { xPt: 300, yPt: 200 },
        ],
        false,
        'c0000000-0000-4000-8000-000000000004',
      ),
      commands: [
        { type: 'move', xPt: 0, yPt: 0 },
        {
          type: 'cubic',
          control1XPt: 40,
          control1YPt: 10,
          control2XPt: 160,
          control2YPt: 80,
          xPt: 200,
          yPt: 100,
        },
      ],
    };
    const handles = pathPointHandles(element);
    expect(handles.map((handle) => handle.role)).toEqual([
      'anchor',
      'control1',
      'control2',
      'anchor',
    ]);

    const commands = updatePathPoint(element, 1, 'control1', {
      xPt: -100,
      yPt: 999,
    });
    expect(commands[1]).toMatchObject({ control1XPt: 0, control1YPt: 100 });
    expect(element.commands[1]).toMatchObject({ control1XPt: 40, control1YPt: 10 });
  });

  it('round-trips rotated frame points between slide and local coordinates', () => {
    const frame = {
      xPt: 100,
      yPt: 80,
      widthPt: 200,
      heightPt: 100,
      rotationDeg: 37,
    };
    const local = { xPt: 35, yPt: 72 };
    const slide = frameLocalPointToSlide(local, frame);
    const restored = slidePointToFrameLocal(slide, frame);

    expect(restored.xPt).toBeCloseTo(local.xPt, 10);
    expect(restored.yPt).toBeCloseTo(local.yPt, 10);
  });
});

describe('direct connector handles', () => {
  it('discovers all five rotated anchors and snaps or detaches by distance', () => {
    const target = {
      ...createShapeElement(),
      id: 'c0000000-0000-4000-8000-000000000005',
      name: 'Rotated target',
      frame: { xPt: 100, yPt: 100, widthPt: 100, heightPt: 50, rotationDeg: 90 },
    };
    const connector = {
      ...createConnectorElement(),
      id: 'c0000000-0000-4000-8000-000000000006',
    };
    const candidates = connectorAnchorCandidates([target, connector], connector.id);

    expect(candidates).toHaveLength(5);
    expect(candidates.find((candidate) => candidate.anchor === 'top')?.point).toEqual({
      xPt: 175,
      yPt: 125,
    });
    const right = candidates.find((candidate) => candidate.anchor === 'right');
    if (right === undefined) throw new Error('Missing right anchor.');
    const snapped = snapConnectorEndpoint(
      { xPt: right.point.xPt + 2, yPt: right.point.yPt - 1 },
      candidates,
      5,
    );
    expect(snapped.endpoint.binding).toEqual({
      elementId: target.id,
      anchor: 'right',
    });
    expect(snapped.endpoint.xPt).toBe(right.point.xPt);
    const detached = snapConnectorEndpoint({ xPt: 10, yPt: 10 }, candidates, 5);
    expect(detached.endpoint).toEqual({ xPt: 10, yPt: 10, binding: {} });
  });

  it('detaches and relocates a bound endpoint atomically instead of leaving it at the old anchor', () => {
    const deck = createDefaultDeck();
    const sourceSlide = deck.slides[0]!;
    const target = {
      ...createShapeElement(),
      id: 'c0000000-0000-4000-8000-000000000009',
      frame: { xPt: 300, yPt: 140, widthPt: 120, heightPt: 80, rotationDeg: 0 },
    };
    const connector = {
      ...createConnectorElement(),
      id: 'c0000000-0000-4000-8000-000000000010',
      start: {
        xPt: 0,
        yPt: 0,
        binding: { elementId: target.id, anchor: 'right' as const },
      },
    };
    const slide = { ...sourceSlide, elements: [...sourceSlide.elements, target, connector] };
    const document = { ...deck, slides: [slide] };
    const requested = { xPt: 72, yPt: 88, binding: {} };
    const commands = directConnectorEndpointCommands(slide.id, connector, 'start', requested);

    expect(commands).toHaveLength(2);
    const result = applyTransaction(document, commands, {
      metadata: {
        transactionId: 'c0000000-0000-4000-8000-000000000011',
        actorId: 'vector-test',
        origin: 'user',
        label: 'Detach and move',
        timestamp: '2026-07-24T12:00:00.000Z',
      },
    });
    const updated = result.document.slides[0]?.elements.find(
      (element) => element.id === connector.id,
    );
    expect(updated?.type === 'connector' ? updated.start : undefined).toEqual(requested);
    const restored = undoTransaction(result.document, result).slides[0]?.elements.find(
      (element) => element.id === connector.id,
    );
    expect(restored?.type === 'connector' ? restored.start.binding : undefined).toEqual(
      connector.start.binding,
    );
  });

  it('renders point-edit and endpoint overlays only for the active primary object', () => {
    const deck = createDefaultDeck();
    const baseSlide = deck.slides[0]!;
    const path = createPathElementFromCanvasPoints(
      [
        { xPt: 80, yPt: 90 },
        { xPt: 240, yPt: 180 },
        { xPt: 300, yPt: 120 },
      ],
      true,
      'c0000000-0000-4000-8000-000000000007',
    );
    const connector = {
      ...createConnectorElement(),
      id: 'c0000000-0000-4000-8000-000000000008',
    };
    const slide = { ...baseSlide, elements: [...baseSlide.elements, path, connector] };
    const document = { ...deck, slides: [slide] };
    const common = {
      document,
      slide,
      assetUrls: {},
      scale: 1,
      gridEnabled: false,
      onSelect: () => true,
      onTransform: () => undefined,
      onEditText: () => undefined,
    };
    const pathMarkup = renderToStaticMarkup(
      createElement(CanonicalSlideCanvas, {
        ...common,
        selectedIds: [path.id],
        vectorTool: { kind: 'edit-path', elementId: path.id },
      }),
    );
    const connectorMarkup = renderToStaticMarkup(
      createElement(CanonicalSlideCanvas, {
        ...common,
        selectedIds: [connector.id],
      }),
    );
    const drawingMarkup = renderToStaticMarkup(
      createElement(CanonicalSlideCanvas, {
        ...common,
        selectedIds: [connector.id],
        vectorTool: { kind: 'freeform', closed: true },
      }),
    );

    expect(pathMarkup).toContain(`data-path-editing-id="${path.id}"`);
    expect(pathMarkup.match(/class="path-point-handle role-anchor"/gu)).toHaveLength(3);
    expect(pathMarkup).not.toContain('connector-endpoint-handle');
    expect(connectorMarkup).toContain('connector-endpoint-handle endpoint-start');
    expect(connectorMarkup).toContain('connector-endpoint-handle endpoint-end');
    expect(drawingMarkup).toContain('canvas-hit-layer is-drawing-freeform');
    expect(drawingMarkup).toContain('Enter or double-click to finish');
    expect(drawingMarkup).not.toContain('connector-endpoint-handle');
  });
});
