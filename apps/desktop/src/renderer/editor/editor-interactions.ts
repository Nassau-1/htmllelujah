import type { Frame } from '@htmllelujah/document-core';
import { rotateFrameBy } from '@htmllelujah/geometry';

export const rotationFrameForKeyboard = (
  frame: Frame,
  key: string,
  shiftKey: boolean,
): Frame | null => {
  if (key === 'Home') return frame.rotationDeg === 0 ? null : { ...frame, rotationDeg: 0 };
  const direction = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0;
  if (direction === 0) return null;
  return rotateFrameBy(
    frame,
    direction * (shiftKey ? 15 : 1),
    shiftKey ? { snapIncrementDeg: 15 } : {},
  );
};

export const adjacentSlideIndex = (
  currentIndex: number,
  slideCount: number,
  direction: -1 | 1,
): number | null => {
  if (!Number.isInteger(currentIndex) || !Number.isInteger(slideCount) || slideCount < 1)
    return null;
  const next = currentIndex + direction;
  return next < 0 || next >= slideCount ? null : next;
};

export const activeElementNeedsBlurCommit = (
  tagName: string,
  isContentEditable: boolean,
): boolean =>
  isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(tagName.trim().toUpperCase());

export type InlineTextEditorKeyAction = 'commit' | 'cancel' | 'none';

export const inlineTextEditorKeyAction = (
  key: string,
  modifiers: Readonly<{
    ctrlKey: boolean;
    metaKey: boolean;
    isComposing: boolean;
  }>,
): InlineTextEditorKeyAction => {
  if (modifiers.isComposing) return 'none';
  if (key === 'Escape') return 'cancel';
  if (key === 'Enter' && (modifiers.ctrlKey || modifiers.metaKey)) return 'commit';
  return 'none';
};

export type InlineTextCommitGate = { current: boolean };
export type InlineTextBlurSuppression = { current: boolean };

export const consumeInlineTextBlurSuppression = (
  suppression: InlineTextBlurSuppression,
): boolean => {
  if (!suppression.current) return false;
  suppression.current = false;
  return true;
};

export const claimInlineTextCommit = (gate: InlineTextCommitGate): boolean => {
  if (gate.current) return false;
  gate.current = true;
  return true;
};

export const canAutoCommitInlineText = (hasRemoteConflict: boolean): boolean => !hasRemoteConflict;

export const inlineTextCanCloseWithoutApply = (
  draftDirty: boolean,
  hasRemoteConflict: boolean,
): boolean => !draftDirty && !hasRemoteConflict;

export const retainInlineTextEditingTarget = (
  editingElementId: string | null,
  primaryTextElementId: string | undefined,
): string | null =>
  editingElementId !== null && editingElementId === primaryTextElementId ? editingElementId : null;

export type TextDraftBaseline = Readonly<{ id: string; value: string }> | null;

export const textDraftTargetHasChanged = (
  baseline: TextDraftBaseline,
  targetElementId: string,
  currentFingerprint: string | undefined,
  knownConflict: boolean,
): boolean =>
  knownConflict ||
  baseline === null ||
  baseline.id !== targetElementId ||
  currentFingerprint === undefined ||
  baseline.value !== currentFingerprint;

export const shouldPreserveDetachedTextDraft = (
  draftDirty: boolean,
  hasDraft: boolean,
  baselineElementId: string | undefined,
  targetElementId: string | undefined,
): boolean =>
  draftDirty &&
  hasDraft &&
  (baselineElementId === undefined ||
    targetElementId === undefined ||
    baselineElementId !== targetElementId);

export const renderedTextDraftIsCurrent = (
  renderedVersion: number,
  currentVersion: number,
): boolean => renderedVersion === currentVersion;

export const textDraftAutosaveMayAttempt = (
  failedVersion: number | null,
  currentVersion: number,
): boolean => failedVersion === null || failedVersion !== currentVersion;

export const runInlineTextCommitOnce = async (
  gate: InlineTextCommitGate,
  work: () => Promise<void>,
  teardown: () => void,
): Promise<boolean> => {
  if (!claimInlineTextCommit(gate)) return false;
  try {
    await work();
    return true;
  } finally {
    try {
      teardown();
    } finally {
      gate.current = false;
    }
  }
};
