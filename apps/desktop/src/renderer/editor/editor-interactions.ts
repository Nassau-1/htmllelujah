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

export const claimInlineTextCommit = (gate: InlineTextCommitGate): boolean => {
  if (gate.current) return false;
  gate.current = true;
  return true;
};

export const canAutoCommitInlineText = (hasRemoteConflict: boolean): boolean => !hasRemoteConflict;
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
