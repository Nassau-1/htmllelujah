import { createDefaultDeck, type Element } from '@htmllelujah/document-core';
import { describe, expect, it } from 'vitest';

import { matchElementSizes, swapElementPositions } from '../src/renderer/editor/arrange-actions.js';

const element = (
  id: string,
  frame: Element['frame'],
  locked = false,
): Extract<Element, { type: 'shape' }> => ({
  id,
  name: id,
  type: 'shape',
  frame,
  opacity: 1,
  visible: true,
  locked,
  shape: 'rectangle',
  fill: '#ffffff',
  stroke: { color: '#111111', widthPt: 1, dash: 'solid' },
  cornerRadiusPt: 0,
});

describe('swapElementPositions', () => {
  const page = createDefaultDeck().page;

  it('swaps two positions while retaining identity, size, and rotation', () => {
    const first = element('first', {
      xPt: 20,
      yPt: 30,
      widthPt: 100,
      heightPt: 60,
      rotationDeg: 15,
    });
    const second = element('second', {
      xPt: 400,
      yPt: 220,
      widthPt: 160,
      heightPt: 90,
      rotationDeg: -20,
    });

    expect(swapElementPositions([first, second], page)).toEqual([
      {
        elementId: 'first',
        frame: {
          xPt: 400,
          yPt: 220,
          widthPt: 100,
          heightPt: 60,
          rotationDeg: 15,
        },
      },
      {
        elementId: 'second',
        frame: {
          xPt: 20,
          yPt: 30,
          widthPt: 160,
          heightPt: 90,
          rotationDeg: -20,
        },
      },
    ]);
  });

  it('clamps a larger peer inside the page and rejects invalid or locked selections', () => {
    const first = element('first', {
      xPt: 0,
      yPt: 0,
      widthPt: 400,
      heightPt: 300,
      rotationDeg: 0,
    });
    const second = element('second', {
      xPt: page.widthPt - 20,
      yPt: page.heightPt - 10,
      widthPt: 10,
      heightPt: 10,
      rotationDeg: 0,
    });

    expect(swapElementPositions([first, second], page)[0]).toMatchObject({
      elementId: 'first',
      frame: {
        xPt: page.widthPt - first.frame.widthPt,
        yPt: page.heightPt - first.frame.heightPt,
      },
    });
    expect(swapElementPositions([first], page)).toEqual([]);
    expect(swapElementPositions([first, element('locked', second.frame, true)], page)).toEqual([]);
  });

  it('matches preceding objects to the last-selected reference without changing rotation', () => {
    const first = element('first', {
      xPt: page.widthPt - 40,
      yPt: page.heightPt - 30,
      widthPt: 20,
      heightPt: 20,
      rotationDeg: 12,
    });
    const reference = element('reference', {
      xPt: 80,
      yPt: 90,
      widthPt: 140,
      heightPt: 75,
      rotationDeg: -30,
    });

    expect(matchElementSizes([first, reference], page)).toEqual([
      {
        elementId: 'first',
        frame: {
          xPt: page.widthPt - 140,
          yPt: page.heightPt - 75,
          widthPt: 140,
          heightPt: 75,
          rotationDeg: 12,
        },
      },
    ]);
    expect(matchElementSizes([reference], page)).toEqual([]);
  });
});
