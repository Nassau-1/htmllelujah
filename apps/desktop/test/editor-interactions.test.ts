import {
  applyCommand,
  createDefaultDeck,
  createNeutralDemoDeck,
  resolveSlide,
} from '@htmllelujah/document-core';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  canvasTransformsToCommit,
  canvasKeyboardRotationFrame,
  CanonicalSlideCanvas,
  commitCanvasTransformsWhenAuthorized,
  connectorAfterInteractionFrameTransform,
  MINIMUM_ROTATION_TOUCH_TARGET_PX,
  pointAfterInteractionFrameTransform,
  resolveCanvasEditableElements,
  rotationControlMetrics,
  rotationControlPlacement,
  sameCanvasSelection,
} from '../src/renderer/components/CanonicalSlideCanvas.js';
import {
  createConnectorElement,
  createShapeElement,
} from '../src/renderer/editor/canonical-factories.js';
import {
  activeElementNeedsBlurCommit,
  adjacentSlideIndex,
  BlurCommitBarrier,
  canAutoCommitInlineText,
  claimInlineTextCommit,
  closeExecutionMayStart,
  CorrelatedCloseSeal,
  CloseExecutionBarrier,
  consumeInlineTextBlurSuppression,
  inlineTextCanCloseWithoutApply,
  inlineTextEditorKeyAction,
  renderedTextDraftIsCurrent,
  retainInlineTextEditingTarget,
  rotationFrameForKeyboard,
  runInlineTextCommitOnce,
  shouldPreserveDetachedTextDraft,
  textDraftAutosaveMayAttempt,
  textDraftTargetHasChanged,
} from '../src/renderer/editor/editor-interactions.js';

const frame = (rotationDeg: number) => ({
  xPt: 10,
  yPt: 20,
  widthPt: 100,
  heightPt: 80,
  rotationDeg,
});

describe('accessible editor interactions', () => {
  it('identifies focused controls whose onBlur value must commit before close', () => {
    expect(activeElementNeedsBlurCommit('input', false)).toBe(true);
    expect(activeElementNeedsBlurCommit('TEXTAREA', false)).toBe(true);
    expect(activeElementNeedsBlurCommit('select', false)).toBe(true);
    expect(activeElementNeedsBlurCommit('DIV', true)).toBe(true);
    expect(activeElementNeedsBlurCommit('button', false)).toBe(false);
    expect(activeElementNeedsBlurCommit('body', false)).toBe(false);
  });
  it('seals close-time execution admission before the final drain', () => {
    expect(closeExecutionMayStart(false, false, false, false)).toBe(true);
    expect(closeExecutionMayStart(true, true, false, false)).toBe(true);
    expect(closeExecutionMayStart(true, false, true, false)).toBe(true);
    expect(closeExecutionMayStart(true, false, false, false)).toBe(false);
    expect(closeExecutionMayStart(true, true, false, true)).toBe(false);
    expect(closeExecutionMayStart(true, false, true, true)).toBe(false);
  });

  it('releases only the exact close generation and ignores a stale release', () => {
    const seal = new CorrelatedCloseSeal();
    expect(seal.seal('')).toBe(false);
    expect(seal.seal('request-1')).toBe(true);
    expect(seal.activeRequestId).toBe('request-1');
    expect(seal.release('request-2')).toBe(false);
    expect(seal.activeRequestId).toBe('request-1');
    expect(seal.release('request-1')).toBe(true);
    expect(seal.activeRequestId).toBeNull();
    expect(seal.seal('request-2')).toBe(true);
    expect(seal.release('request-1')).toBe(false);
    expect(seal.activeRequestId).toBe('request-2');
    expect(seal.release('request-2')).toBe(true);
  });

  it('retains rejected blur commits per control until that control explicitly succeeds', async () => {
    const barrier = new BlurCommitBarrier<object>();
    const firstField = {};
    const secondField = {};

    await expect(barrier.attempt(firstField, () => false)).resolves.toBe(false);
    await expect(barrier.settle(Date.now() + 500)).resolves.toBe(false);

    await expect(barrier.attempt(secondField, () => true)).resolves.toBe(true);
    await expect(barrier.settle(Date.now() + 500)).resolves.toBe(false);

    await expect(barrier.attempt(firstField, () => Promise.resolve(true))).resolves.toBe(true);
    await expect(barrier.settle(Date.now() + 500)).resolves.toBe(true);

    await expect(
      barrier.attempt(firstField, () => Promise.reject(new Error('commit rejected'))),
    ).resolves.toBe(false);
    await expect(barrier.settle(Date.now() + 500)).resolves.toBe(false);

    await expect(
      barrier.attempt(firstField, () => {
        throw new Error('commit threw');
      }),
    ).resolves.toBe(false);
    await expect(barrier.settle(Date.now() + 500)).resolves.toBe(false);

    barrier.prune((key) => key !== firstField);
    await expect(barrier.settle(Date.now() + 500)).resolves.toBe(true);
  });

  it('retains a logical draft while pruning a detached control attempt', async () => {
    const barrier = new BlurCommitBarrier<object>();
    const logicalDraft = {};
    const detachedControl = {};

    await expect(barrier.attempt(logicalDraft, () => false)).resolves.toBe(false);
    await expect(barrier.attempt(detachedControl, () => false)).resolves.toBe(false);
    await expect(barrier.settle(Date.now() + 500, (key) => key === logicalDraft)).resolves.toBe(
      false,
    );

    await expect(barrier.attempt(logicalDraft, () => true)).resolves.toBe(true);
    await expect(barrier.settle(Date.now() + 500, (key) => key === logicalDraft)).resolves.toBe(
      true,
    );
  });

  it('lets a newer successful attempt supersede an older stuck attempt immediately', async () => {
    const barrier = new BlurCommitBarrier<object>();
    const field = {};
    let releaseOld: (applied: boolean) => void = () => undefined;
    void barrier.attempt(
      field,
      () =>
        new Promise<boolean>((resolve) => {
          releaseOld = resolve;
        }),
    );

    const settling = barrier.settle(Date.now() + 500);
    await Promise.resolve();
    await expect(barrier.attempt(field, () => true)).resolves.toBe(true);
    await expect(settling).resolves.toBe(true);
    releaseOld(false);
  });

  it('does not let an older late success erase the newest rejected attempt', async () => {
    const barrier = new BlurCommitBarrier<object>();
    const field = {};
    let releaseOld: (applied: boolean) => void = () => undefined;
    void barrier.attempt(
      field,
      () =>
        new Promise<boolean>((resolve) => {
          releaseOld = resolve;
        }),
    );

    await expect(barrier.attempt(field, () => false)).resolves.toBe(false);
    releaseOld(true);
    await Promise.resolve();
    await expect(barrier.settle(Date.now() + 500)).resolves.toBe(false);

    await expect(barrier.attempt(field, () => true)).resolves.toBe(true);
    await expect(barrier.settle(Date.now() + 500)).resolves.toBe(true);
  });

  it('bounds a pending blur attempt by the close deadline', async () => {
    const barrier = new BlurCommitBarrier<object>();
    const field = {};
    void barrier.attempt(field, () => new Promise<boolean>(() => undefined));
    const startedAt = Date.now();
    await expect(barrier.settle(Date.now() + 25)).resolves.toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(500);
    barrier.prune(() => false);
    await expect(barrier.settle(Date.now() + 500)).resolves.toBe(true);
  });

  it('drains commands pending or added during close and reaches a microtask-stable result', async () => {
    const barrier = new CloseExecutionBarrier();
    let releaseFirst: (applied: boolean) => void = () => undefined;
    barrier.track(
      new Promise<boolean>((resolve) => {
        releaseFirst = resolve;
      }),
    );
    const drain = barrier.begin();
    const settled = drain.settle(Date.now() + 500);
    barrier.track(Promise.resolve(false));
    releaseFirst(true);

    await expect(settled).resolves.toBe(false);
    drain.end();

    const microtaskDrain = barrier.begin();
    const microtaskSettled = microtaskDrain.settle(Date.now() + 500);
    queueMicrotask(() => barrier.track(Promise.resolve(false)));
    await expect(microtaskSettled).resolves.toBe(false);
    microtaskDrain.end();

    const rejectedDrain = barrier.begin();
    barrier.track(Promise.reject(new Error('execute failed')));
    await expect(rejectedDrain.settle(Date.now() + 500)).resolves.toBe(false);
    rejectedDrain.end();

    const successfulDrain = barrier.begin();
    barrier.track(Promise.resolve(true));
    await expect(successfulDrain.settle(Date.now() + 500)).resolves.toBe(true);
    successfulDrain.end();
  });

  it('bounds a stuck close command and rejects admission after the final seal', async () => {
    const stuckBarrier = new CloseExecutionBarrier();
    stuckBarrier.track(new Promise<boolean>(() => undefined));
    const stuckDrain = stuckBarrier.begin();
    const startedAt = Date.now();
    await expect(stuckDrain.settle(Date.now() + 25)).resolves.toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(500);
    stuckDrain.end();
    const retryDrain = stuckBarrier.begin();
    retryDrain.end();

    const sealedBarrier = new CloseExecutionBarrier();
    let release: (applied: boolean) => void = () => undefined;
    sealedBarrier.track(
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
    );
    const sealedDrain = sealedBarrier.begin();
    const sealed = sealedDrain.sealAndSettle(Date.now() + 500);
    queueMicrotask(() => sealedBarrier.track(Promise.resolve(true)));
    release(true);
    await expect(sealed).resolves.toBe(false);
    sealedDrain.end();

    const nestedBarrier = new CloseExecutionBarrier();
    const nestedDrain = nestedBarrier.begin();
    const nestedSettled = nestedDrain.sealAndSettle(Date.now() + 500);
    queueMicrotask(() => queueMicrotask(() => nestedBarrier.track(Promise.resolve(false))));
    await expect(nestedSettled).resolves.toBe(true);
    expect(nestedDrain.isSealedStable()).toBe(false);
    await expect(nestedDrain.sealAndSettle(Date.now() + 500)).resolves.toBe(false);
    nestedDrain.end();
  });

  it('authorizes only an exact stable canvas selection', () => {
    expect(sameCanvasSelection(['shape-1'], ['shape-1'])).toBe(true);
    expect(sameCanvasSelection([], [])).toBe(true);
    expect(sameCanvasSelection(['shape-1'], ['shape-1', 'text-1'])).toBe(false);
    expect(sameCanvasSelection(['shape-1', 'text-1'], ['text-1', 'shape-1'])).toBe(false);
  });

  it('consumes inline blur suppression exactly once', () => {
    const suppression = { current: true };
    expect(consumeInlineTextBlurSuppression(suppression)).toBe(true);
    expect(suppression.current).toBe(false);
    expect(consumeInlineTextBlurSuppression(suppression)).toBe(false);
  });

  it('fails closed for stale, externally changed, or detached text drafts', () => {
    const baseline = { id: 'text-1', value: 'revision-a' };
    expect(renderedTextDraftIsCurrent(4, 4)).toBe(true);
    expect(renderedTextDraftIsCurrent(4, 5)).toBe(false);
    expect(textDraftAutosaveMayAttempt(null, 4)).toBe(true);
    expect(textDraftAutosaveMayAttempt(3, 4)).toBe(true);
    expect(textDraftAutosaveMayAttempt(4, 4)).toBe(false);
    expect(textDraftTargetHasChanged(baseline, 'text-1', 'revision-a', false)).toBe(false);
    expect(textDraftTargetHasChanged(baseline, 'text-1', 'revision-b', false)).toBe(true);
    expect(textDraftTargetHasChanged(baseline, 'text-2', 'revision-a', false)).toBe(true);
    expect(textDraftTargetHasChanged(null, 'text-1', 'revision-a', false)).toBe(true);
    expect(textDraftTargetHasChanged(baseline, 'text-1', undefined, false)).toBe(true);
    expect(textDraftTargetHasChanged(baseline, 'text-1', 'revision-a', true)).toBe(true);
    expect(shouldPreserveDetachedTextDraft(true, true, 'text-1', undefined)).toBe(true);
    expect(shouldPreserveDetachedTextDraft(true, true, 'text-1', 'text-2')).toBe(true);
    expect(shouldPreserveDetachedTextDraft(false, true, 'text-1', undefined)).toBe(false);
    expect(shouldPreserveDetachedTextDraft(true, false, 'text-1', undefined)).toBe(false);
  });

  it('commits a drag transform only after selection authorization', async () => {
    const transforms = [{ elementId: 'shape-1', frame: frame(0) }];
    const committed: (typeof transforms)[] = [];
    const onTransform = (next: typeof transforms): void => {
      committed.push(next);
    };

    expect(
      await commitCanvasTransformsWhenAuthorized(Promise.resolve(false), transforms, onTransform),
    ).toBe(false);
    expect(committed).toHaveLength(0);
    expect(
      await commitCanvasTransformsWhenAuthorized(Promise.resolve(true), transforms, onTransform),
    ).toBe(true);
    expect(committed).toEqual([transforms]);
    expect(
      await commitCanvasTransformsWhenAuthorized(
        Promise.reject(new Error('denied')),
        transforms,
        onTransform,
      ),
    ).toBe(false);
    expect(committed).toHaveLength(1);
  });

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
          pending: false,
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
        onSelect: () => true,
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
      frame: { xPt: 400, yPt: 160, widthPt: 100, heightPt: 80, rotationDeg: 90 },
    };
    const connector = {
      ...createConnectorElement(),
      geometryVersion: undefined,
      name: 'Bound connector',
      frame: { xPt: 0, yPt: 0, widthPt: 40, heightPt: 40, rotationDeg: 37 },
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
      yPt: 150,
      widthPt: 350,
      heightPt: 50,
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
    const movedTransforms = canvasTransformsToCommit(
      { [connector.id]: movedInteractionFrame },
      [{ id: connector.id, frame: interactionFrame }],
      new Map([[connector.id, connector]]),
    );
    expect(movedTransforms).toEqual([
      {
        elementId: connector.id,
        frame: { xPt: 30, yPt: 15, widthPt: 40, heightPt: 40, rotationDeg: 37 },
      },
    ]);
    const movedLocalFrame = movedTransforms[0]?.frame;
    if (movedLocalFrame === undefined) throw new Error('Missing moved connector transform.');

    const preview = connectorAfterInteractionFrameTransform(
      connector,
      {
        startInContainer: { xPt: 100, yPt: 200 },
        endInContainer: { xPt: 450, yPt: 150 },
      },
      connector.frame,
      movedLocalFrame,
    );
    expect(preview.start.xPt).toBeCloseTo(130, 10);
    expect(preview.start.yPt).toBeCloseTo(215, 10);
    expect(preview.end.xPt).toBeCloseTo(480, 10);
    expect(preview.end.yPt).toBeCloseTo(165, 10);
    expect(preview.start.binding).toEqual({});
    expect(preview.end.binding).toEqual({});
    const committed = applyCommand(
      document,
      {
        type: 'element.transform',
        slideId: localSlide.id,
        transforms: [
          {
            elementId: connector.id,
            frame: movedLocalFrame,
          },
        ],
      },
      {
        metadata: {
          transactionId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
          actorId: 'editor-test',
          origin: 'user',
          label: 'Move bound connector',
          timestamp: '2026-07-16T18:00:00.000Z',
        },
      },
    );
    const committedConnector = committed.document.slides[0]!.elements.find(
      (element) => element.id === connector.id,
    );
    expect(committedConnector?.type === 'connector' ? committedConnector.start : undefined).toEqual(
      preview.start,
    );
    expect(committedConnector?.type === 'connector' ? committedConnector.end : undefined).toEqual(
      preview.end,
    );

    const resizedRotatedInteractionFrame = {
      xPt: 80,
      yPt: 120,
      widthPt: 525,
      heightPt: 100,
      rotationDeg: 30,
    };
    const combinedFrame = canvasTransformsToCommit(
      { [connector.id]: resizedRotatedInteractionFrame },
      [{ id: connector.id, frame: interactionFrame }],
      new Map([[connector.id, connector]]),
    )[0]?.frame;
    if (combinedFrame === undefined) throw new Error('Missing combined connector transform.');
    const combinedPreview = connectorAfterInteractionFrameTransform(
      connector,
      {
        startInContainer: { xPt: 100, yPt: 200 },
        endInContainer: { xPt: 450, yPt: 150 },
      },
      connector.frame,
      combinedFrame,
    );
    const combinedCommit = applyCommand(
      document,
      {
        type: 'element.transform',
        slideId: localSlide.id,
        transforms: [{ elementId: connector.id, frame: combinedFrame }],
      },
      {
        metadata: {
          transactionId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002',
          actorId: 'editor-test',
          origin: 'user',
          label: 'Resize and rotate bound connector',
          timestamp: '2026-07-16T18:00:01.000Z',
        },
      },
    );
    const combinedConnector = combinedCommit.document.slides[0]!.elements.find(
      (element) => element.id === connector.id,
    );
    if (combinedConnector?.type !== 'connector') {
      throw new Error('Missing combined committed connector.');
    }
    expect(combinedConnector.start.xPt).toBeCloseTo(combinedPreview.start.xPt, 10);
    expect(combinedConnector.start.yPt).toBeCloseTo(combinedPreview.start.yPt, 10);
    expect(combinedConnector.end.xPt).toBeCloseTo(combinedPreview.end.xPt, 10);
    expect(combinedConnector.end.yPt).toBeCloseTo(combinedPreview.end.yPt, 10);
    expect(combinedConnector.start.binding).toEqual({});
    expect(combinedConnector.end.binding).toEqual({});
  });

  it('maps keyboard rotation from connector hitboxes back to bound and unbound local frames', () => {
    const bound = {
      ...createConnectorElement(),
      frame: { xPt: 0, yPt: 0, widthPt: 40, heightPt: 40, rotationDeg: 7 },
      start: { xPt: 100, yPt: 200, binding: {} },
      end: {
        xPt: 999,
        yPt: 999,
        binding: { elementId: createShapeElement().id, anchor: 'left' as const },
      },
    };
    const unbound = createConnectorElement();
    const fixtures = [
      {
        connector: bound,
        interaction: { xPt: 100, yPt: 194, widthPt: 300, heightPt: 12, rotationDeg: 0 },
      },
      {
        connector: unbound,
        interaction: { xPt: 180, yPt: 244, widthPt: 260, heightPt: 12, rotationDeg: 0 },
      },
    ];

    for (const { connector, interaction } of fixtures) {
      const arrowFrame = canvasKeyboardRotationFrame(connector, interaction, 'ArrowRight', false);
      expect(arrowFrame?.rotationDeg).toBe(1);
      const arrowCommit =
        arrowFrame === null
          ? undefined
          : canvasTransformsToCommit(
              { [connector.id]: arrowFrame },
              [{ id: connector.id, frame: interaction }],
              new Map([[connector.id, connector]]),
            )[0]?.frame;
      expect(arrowCommit?.rotationDeg).toBe(connector.frame.rotationDeg + 1);

      const rotatedInteraction = { ...interaction, rotationDeg: 15 };
      const transforms = canvasTransformsToCommit(
        { [connector.id]: rotatedInteraction },
        [{ id: connector.id, frame: interaction }],
        new Map([[connector.id, connector]]),
      );
      const committed = transforms[0]?.frame;
      expect(committed).toBeDefined();
      if (committed === undefined) throw new Error('Missing keyboard connector transform.');
      const expectedCenter = pointAfterInteractionFrameTransform(
        {
          xPt: connector.frame.xPt + connector.frame.widthPt / 2,
          yPt: connector.frame.yPt + connector.frame.heightPt / 2,
        },
        interaction,
        rotatedInteraction,
      );
      expect(committed.widthPt).toBe(connector.frame.widthPt);
      expect(committed.heightPt).toBe(connector.frame.heightPt);
      expect(committed.rotationDeg).toBe(connector.frame.rotationDeg + 15);
      expect(committed.xPt + committed.widthPt / 2).toBeCloseTo(expectedCenter.xPt, 10);
      expect(committed.yPt + committed.heightPt / 2).toBeCloseTo(expectedCenter.yPt, 10);
      expect(committed).not.toEqual(rotatedInteraction);
    }

    const homeFrame = canvasKeyboardRotationFrame(bound, fixtures[0]!.interaction, 'Home', false);
    expect(homeFrame?.rotationDeg).toBe(-7);
    const homeCommit =
      homeFrame === null
        ? undefined
        : canvasTransformsToCommit(
            { [bound.id]: homeFrame },
            [{ id: bound.id, frame: fixtures[0]!.interaction }],
            new Map([[bound.id, bound]]),
          )[0]?.frame;
    expect(homeCommit?.rotationDeg).toBe(0);
    expect(
      canvasKeyboardRotationFrame(unbound, fixtures[1]!.interaction, 'Home', false),
    ).toBeNull();
    expect(
      canvasKeyboardRotationFrame(bound, fixtures[0]!.interaction, 'ArrowRight', true)?.rotationDeg,
    ).toBe(8);
  });

  it('uses final pre-marker path bounds without double rotation after reopen', () => {
    const deck = createDefaultDeck();
    const slide = deck.slides[0]!;
    const connector = {
      ...createConnectorElement(),
      name: 'Legacy rotated connector',
      frame: { xPt: 10, yPt: 20, widthPt: 100, heightPt: 50, rotationDeg: 90 },
      start: { xPt: 85, yPt: -5, binding: {} },
      end: { xPt: 35, yPt: 95, binding: {} },
    };
    const localSlide = { ...slide, elements: [...slide.elements, connector] };
    const document = { ...deck, slides: [localSlide] };
    const resolved = resolveSlide(document, localSlide.id);
    const editable = resolveCanvasEditableElements(resolved, 'slide', localSlide.elements);
    const projectedConnector = editable.find((entry) => entry.localElement.id === connector.id);
    const interactionFrame = {
      xPt: 35,
      yPt: -5,
      widthPt: 50,
      heightPt: 100,
      rotationDeg: 0,
    };

    expect(projectedConnector?.effectiveElement.frame).toEqual(interactionFrame);
    expect(projectedConnector?.localElement).toBe(connector);
    expect(
      canvasTransformsToCommit(
        {
          [connector.id]: {
            ...interactionFrame,
            xPt: interactionFrame.xPt + 20,
            yPt: interactionFrame.yPt + 10,
          },
        },
        [{ id: connector.id, frame: interactionFrame }],
        new Map([[connector.id, connector]]),
      ),
    ).toEqual([
      {
        elementId: connector.id,
        frame: { xPt: 30, yPt: 30, widthPt: 100, heightPt: 50, rotationDeg: 90 },
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
    expect(inlineTextCanCloseWithoutApply(false, false)).toBe(true);
    expect(inlineTextCanCloseWithoutApply(true, false)).toBe(false);
    expect(inlineTextCanCloseWithoutApply(false, true)).toBe(false);
    expect(retainInlineTextEditingTarget('text-1', 'text-1')).toBe('text-1');
    expect(retainInlineTextEditingTarget('text-1', 'text-2')).toBeNull();
    expect(retainInlineTextEditingTarget('text-1', undefined)).toBeNull();
    expect(retainInlineTextEditingTarget(null, 'text-1')).toBeNull();

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
          pending: false,
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
        onSelect: () => true,
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
