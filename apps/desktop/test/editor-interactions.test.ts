import { createDefaultDeck, createNeutralDemoDeck, resolveSlide } from '@htmllelujah/document-core';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  canvasTransformsToCommit,
  CanonicalSlideCanvas,
  MINIMUM_ROTATION_TOUCH_TARGET_PX,
  pointAfterInteractionFrameTransform,
  resolveCanvasEditableElements,
  rotationControlMetrics,
  rotationControlPlacement,
} from '../src/renderer/components/CanonicalSlideCanvas.js';
import {
  createConnectorElement,
  createShapeElement,
} from '../src/renderer/editor/canonical-factories.js';
import {
  adjacentSlideIndex,
  canAutoCommitInlineText,
  claimInlineTextCommit,
  inlineTextEditorKeyAction,
  rotationFrameForKeyboard,
  runInlineTextCommitOnce,
} from '../src/renderer/editor/editor-interactions.js';

const frame = (rotationDeg: number) => ({
  xPt: 10,
  yPt: 20,
  widthPt: 100,
  heightPt: 80,
  rotationDeg,
});

describe('accessible editor interactions', () => {
  it('rotates one degree with arrow keys and snaps Shift rotation to 15 degrees', () => {
    expect(rotationFrameForKeyboard(frame(0), 'ArrowRight', false)?.rotationDeg).toBe(1);
    expect(rotationFrameForKeyboard(frame(7), 'ArrowRight', true)?.rotationDeg).toBe(15);
    expect(rotationFrameForKeyboard(frame(-179), 'ArrowLeft', false)?.rotationDeg).toBe(-180);
    expect(rotationFrameForKeyboard(frame(30), 'Home', false)?.rotationDeg).toBe(0);
    expect(rotationFrameForKeyboard(frame(0), 'Home', false)).toBeNull();
    expect(rotationFrameForKeyboard(frame(0), 'ArrowUp', false)).toBeNull();
  });

  it('returns only valid adjacent slide reorder targets', () => {
    expect(adjacentSlideIndex(1, 3, -1)).toBe(0);
    expect(adjacentSlideIndex(1, 3, 1)).toBe(2);
    expect(adjacentSlideIndex(0, 3, -1)).toBeNull();
    expect(adjacentSlideIndex(2, 3, 1)).toBeNull();
    expect(adjacentSlideIndex(Number.NaN, 3, 1)).toBeNull();
  });

  it('maps commit/cancel shortcuts while leaving IME composition untouched', () => {
    const modifiers = (
      overrides: Partial<{ ctrlKey: boolean; metaKey: boolean; isComposing: boolean }> = {},
    ) => ({
      ctrlKey: false,
      metaKey: false,
      isComposing: false,
      ...overrides,
    });

    expect(inlineTextEditorKeyAction('Enter', modifiers({ ctrlKey: true }))).toBe('commit');
    expect(inlineTextEditorKeyAction('Enter', modifiers({ metaKey: true }))).toBe('commit');
    expect(inlineTextEditorKeyAction('Escape', modifiers())).toBe('cancel');
    expect(inlineTextEditorKeyAction('Enter', modifiers())).toBe('none');
    expect(
      inlineTextEditorKeyAction('Enter', modifiers({ ctrlKey: true, isComposing: true })),
    ).toBe('none');
    expect(inlineTextEditorKeyAction('Escape', modifiers({ isComposing: true }))).toBe('none');
  });

  it('uses projected placeholder geometry for hitboxes and inline editing while preserving the local write identity', () => {
    const deck = createDefaultDeck();
    const slide = deck.slides[0]!;
    const localText = slide.elements.find(
      (element) => element.type === 'text' && element.placeholderBinding !== undefined,
    );
    if (
      localText === undefined ||
      localText.type !== 'text' ||
      localText.placeholderBinding === undefined
    ) {
      throw new Error('bound text fixture missing');
    }
    const movedFrame = {
      xPt: 143,
      yPt: 8,
      widthPt: 611,
      heightPt: 83,
      rotationDeg: 19,
    };
    const movedDocument = {
      ...deck,
      layouts: deck.layouts.map((layout) => ({
        ...layout,
        elements: layout.elements.map((element) =>
          element.id === localText.placeholderBinding?.placeholderId
            ? { ...element, frame: movedFrame }
            : element,
        ),
      })),
    };
    const resolved = resolveSlide(movedDocument, slide.id);
    const editable = resolveCanvasEditableElements(resolved, 'slide', slide.elements);
    const target = editable.find((entry) => entry.localElement.id === localText.id);

    expect(target?.localElement).toBe(localText);
    expect(target?.localElement.placeholderBinding?.placeholderId).toBe(
      localText.placeholderBinding.placeholderId,
    );
    expect(target?.effectiveElement.id).toBe(localText.id);
    expect(target?.effectiveElement.frame).toEqual(movedFrame);
    expect(localText.frame).not.toEqual(movedFrame);
    const localById = new Map([[localText.id, localText]]);
    expect(
      canvasTransformsToCommit(
        { [localText.id]: movedFrame },
        [{ id: localText.id, frame: movedFrame }],
        localById,
      ),
    ).toEqual([]);
    expect(
      canvasTransformsToCommit(
        { [localText.id]: { ...movedFrame, xPt: movedFrame.xPt + 12 } },
        [{ id: localText.id, frame: movedFrame }],
        localById,
      ),
    ).toEqual([
      {
        elementId: localText.id,
        frame: { ...movedFrame, xPt: movedFrame.xPt + 12 },
      },
    ]);

    const markup = renderToStaticMarkup(
      createElement(CanonicalSlideCanvas, {
        document: movedDocument,
        slide,
        assetUrls: {},
        scale: 1,
        gridEnabled: false,
        selectedIds: [localText.id],
        inlineTextEditor: {
          elementId: localText.id,
          value: 'Projected draft',
          disabled: false,
          conflict: false,
          maxLength: 500_000,
          fontFamily: 'Arial',
          fontSizePt: 24,
          fontWeight: 700,
          italic: false,
          color: '#172033',
          lineHeight: 1.2,
          letterSpacingPt: 0,
          alignment: 'left',
        },
        onSelect: () => undefined,
        onTransform: () => undefined,
        onEditText: () => undefined,
        onInlineTextChange: () => undefined,
        onInlineTextPaste: () => undefined,
        onInlineTextCommit: () => undefined,
        onInlineTextCancel: () => undefined,
        onInlineTextFocus: () => undefined,
      }),
    );
    const effectiveStyle = 'left:143pt;top:8pt;width:611pt;height:83pt;transform:rotate(19deg)';

    expect(markup).toContain(`class="canonical-hitbox is-selected" style="${effectiveStyle}"`);
    expect(markup).toContain(`data-canvas-element-id="${localText.id}"`);
    expect(markup).toContain(`class="canonical-inline-text-editor" style="${effectiveStyle}"`);
    expect(markup).toContain(`data-inline-text-element-id="${localText.id}"`);
    expect(markup).toContain('data-rotation-placement="inside-top"');
  });

  it('uses live bound connector geometry for its hitbox and maps gestures back to the local frame', () => {
    const deck = createDefaultDeck();
    const slide = deck.slides[0]!;
    const target = {
      ...createShapeElement(),
      name: 'Connector target',
      frame: { xPt: 400, yPt: 160, widthPt: 100, heightPt: 80, rotationDeg: 0 },
    };
    const connector = {
      ...createConnectorElement(),
      name: 'Bound connector',
      frame: { xPt: 0, yPt: 0, widthPt: 40, heightPt: 40, rotationDeg: 0 },
      start: { xPt: 100, yPt: 200, binding: {} },
      end: { xPt: 999, yPt: 999, binding: { elementId: target.id, anchor: 'left' as const } },
    };
    const localSlide = { ...slide, elements: [...slide.elements, target, connector] };
    const document = { ...deck, slides: [localSlide] };
    const resolved = resolveSlide(document, localSlide.id);
    const editable = resolveCanvasEditableElements(resolved, 'slide', localSlide.elements);
    const projectedConnector = editable.find((entry) => entry.localElement.id === connector.id);
    const interactionFrame = {
      xPt: 100,
      yPt: 194,
      widthPt: 300,
      heightPt: 12,
      rotationDeg: 0,
    };

    expect(projectedConnector?.effectiveElement.frame).toEqual(interactionFrame);
    const movedInteractionFrame = {
      ...interactionFrame,
      xPt: interactionFrame.xPt + 30,
      yPt: interactionFrame.yPt + 15,
    };
    expect(
      pointAfterInteractionFrameTransform(
        { xPt: 100, yPt: 200 },
        interactionFrame,
        movedInteractionFrame,
      ),
    ).toEqual({ xPt: 130, yPt: 215 });
    expect(
      canvasTransformsToCommit(
        { [connector.id]: movedInteractionFrame },
        [{ id: connector.id, frame: interactionFrame }],
        new Map([[connector.id, connector]]),
      ),
    ).toEqual([
      {
        elementId: connector.id,
        frame: { xPt: 30, yPt: 15, widthPt: 40, heightPt: 40, rotationDeg: 0 },
      },
    ]);
  });

  it('keeps rotation controls at a 44 px screen target from 25% through Fit and 200% zoom', () => {
    for (const zoom of [0.25, 0.63, 1, 2]) {
      const metrics = rotationControlMetrics(zoom);
      expect(metrics.targetSizeCssPx * metrics.canvasTransformScale).toBeCloseTo(
        MINIMUM_ROTATION_TOUCH_TARGET_PX,
        10,
      );
      expect(metrics.dotSizeCssPx * metrics.canvasTransformScale).toBeCloseTo(10, 10);
      expect(metrics.lineWidthCssPx * metrics.canvasTransformScale).toBeCloseTo(1.5, 10);
    }

    expect(rotationControlPlacement({ ...frame(0), yPt: 0 }, 2)).toBe('inside-top');
    expect(rotationControlPlacement({ ...frame(0), yPt: 199 }, 0.25)).toBe('inside-top');
    expect(rotationControlPlacement({ ...frame(0), yPt: 200 }, 0.25)).toBe('above');

    const css = readFileSync(new URL('../src/styles/editor.css', import.meta.url), 'utf8');
    expect(css).toContain('width: var(--canvas-rotation-target-size);');
    expect(css).toContain('height: var(--canvas-rotation-target-size);');
    expect(css).toContain('.canonical-rotation-handle.placement-inside-top');
    expect(css).toContain('touch-action: none;');
  });

  it('serializes blur and keyboard commits and always tears down the editing session', async () => {
    const gate = { current: false };
    let workCount = 0;
    let teardownCount = 0;
    let finishWork: () => void = () => undefined;
    const blockedWork = new Promise<void>((resolve) => {
      finishWork = resolve;
    });
    const first = runInlineTextCommitOnce(
      gate,
      async () => {
        workCount += 1;
        await blockedWork;
      },
      () => {
        teardownCount += 1;
      },
    );
    const duplicate = await runInlineTextCommitOnce(
      gate,
      async () => {
        workCount += 1;
      },
      () => {
        teardownCount += 1;
      },
    );

    expect(duplicate).toBe(false);
    expect(workCount).toBe(1);
    expect(claimInlineTextCommit(gate)).toBe(false);
    finishWork();
    await expect(first).resolves.toBe(true);
    expect(teardownCount).toBe(1);
    expect(gate.current).toBe(false);

    await expect(
      runInlineTextCommitOnce(
        gate,
        async () => {
          throw new Error('apply failed');
        },
        () => {
          teardownCount += 1;
        },
      ),
    ).rejects.toThrow('apply failed');
    expect(teardownCount).toBe(2);
    expect(gate.current).toBe(false);
  });

  it('blocks automatic remote-conflict overwrite and renders a bounded rotated zoomed overlay', () => {
    expect(canAutoCommitInlineText(true)).toBe(false);
    expect(canAutoCommitInlineText(false)).toBe(true);

    const deck = createNeutralDemoDeck();
    const sourceSlide = deck.slides[0]!;
    const sourceText = sourceSlide.elements.find((element) => element.type === 'text');
    if (sourceText === undefined || sourceText.type !== 'text')
      throw new Error('fixture text missing');
    const text = { ...sourceText, frame: { ...sourceText.frame, rotationDeg: 37 } };
    const slide = {
      ...sourceSlide,
      elements: sourceSlide.elements.map((element) => (element.id === text.id ? text : element)),
    };
    const document = {
      ...deck,
      slides: deck.slides.map((candidate) => (candidate.id === slide.id ? slide : candidate)),
    };
    const markup = renderToStaticMarkup(
      createElement(CanonicalSlideCanvas, {
        document,
        slide,
        assetUrls: {},
        scale: 1.5,
        gridEnabled: true,
        selectedIds: [text.id],
        inlineTextEditor: {
          elementId: text.id,
          value: 'Local draft',
          disabled: false,
          conflict: true,
          maxLength: 500_000,
          fontFamily: 'Arial',
          fontSizePt: 22,
          fontWeight: 700,
          italic: false,
          color: '#172033',
          lineHeight: 1.25,
          letterSpacingPt: 0,
          alignment: 'left',
        },
        onSelect: () => undefined,
        onTransform: () => undefined,
        onEditText: () => undefined,
        onInlineTextChange: () => undefined,
        onInlineTextPaste: () => undefined,
        onInlineTextCommit: () => undefined,
        onInlineTextCancel: () => undefined,
        onInlineTextFocus: () => undefined,
      }),
    );

    expect(markup).toContain(`data-inline-text-element-id="${text.id}"`);
    expect(markup).toContain('maxLength="500000"');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('transform:rotate(37deg)');
    expect(markup).toContain('transform:scale(1.125)');
    expect(markup).toContain('Remote change detected. Your draft is preserved');
    expect(markup).toContain('Press Control Enter to apply. Press Escape to cancel.');
  });
});
