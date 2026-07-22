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

const normalizedCommitResult = (result: Promise<boolean>): Promise<boolean> =>
  result.then(
    (applied) => applied === true,
    () => false,
  );

export const settleBooleanBeforeDeadline = async (
  result: Promise<boolean>,
  deadlineAtMs: number,
): Promise<boolean> => {
  const remainingMs = deadlineAtMs - Date.now();
  if (!Number.isFinite(deadlineAtMs) || remainingMs <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      normalizedCommitResult(result),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), remainingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
export const closeExecutionMayStart = (
  closePreparationInFlight: boolean,
  allowDuringCloseBlur: boolean,
  preserveInlineTextDraft: boolean,
  admissionSealed: boolean,
): boolean =>
  !closePreparationInFlight ||
  (!admissionSealed && (allowDuringCloseBlur || preserveInlineTextDraft));

/**
 * Owns the request generation that sealed editor mutations during native-close preparation.
 * A delayed release or watchdog from an older generation can never unlock the active one.
 */
export class CorrelatedCloseSeal {
  #activeRequestId: string | null = null;

  public get activeRequestId(): string | null {
    return this.#activeRequestId;
  }

  public seal(requestId: string): boolean {
    if (requestId.length === 0) return false;
    if (this.#activeRequestId !== null) return this.#activeRequestId === requestId;
    this.#activeRequestId = requestId;
    return true;
  }

  public release(requestId: string): boolean {
    if (this.#activeRequestId !== requestId) return false;
    this.#activeRequestId = null;
    return true;
  }
}

type BlurCommitAttempt = {
  readonly result: Promise<boolean>;
  readonly superseded: Promise<void>;
  supersede(): void;
};

/**
 * Retains the latest explicit blur-commit attempt per control. Windows can move focus before the
 * native close event reaches the renderer, so failed attempts remain until that control explicitly
 * succeeds or is deliberately pruned.
 */
export class BlurCommitBarrier<Key extends object> {
  readonly #latestByKey = new Map<Key, BlurCommitAttempt>();
  #version = 0;

  public attempt(key: Key, action: () => boolean | Promise<boolean>): Promise<boolean> {
    let supersede = (): void => undefined;
    const result = normalizedCommitResult(Promise.resolve().then(action));
    const attempt: BlurCommitAttempt = {
      result,
      superseded: new Promise<void>((resolve) => {
        supersede = resolve;
      }),
      supersede: () => supersede(),
    };
    this.#latestByKey.get(key)?.supersede();
    this.#latestByKey.set(key, attempt);
    this.#version += 1;
    void result.then((applied) => {
      if (applied && this.#latestByKey.get(key) === attempt) {
        this.#latestByKey.delete(key);
        attempt.supersede();
        this.#version += 1;
      }
    });
    return result;
  }

  public prune(retain: (key: Key) => boolean): void {
    for (const [key, attempt] of this.#latestByKey) {
      if (!retain(key) && this.#latestByKey.delete(key)) {
        attempt.supersede();
        this.#version += 1;
      }
    }
  }

  public async settle(
    deadlineAtMs: number,
    retain: (key: Key) => boolean = () => true,
  ): Promise<boolean> {
    settle: for (;;) {
      await Promise.resolve();
      await Promise.resolve();
      if (Date.now() >= deadlineAtMs) return false;
      for (const [key, attempt] of [...this.#latestByKey]) {
        if (!retain(key)) {
          if (this.#latestByKey.get(key) === attempt && this.#latestByKey.delete(key)) {
            attempt.supersede();
            this.#version += 1;
          }
          continue;
        }
        const remainingMs = deadlineAtMs - Date.now();
        if (!Number.isFinite(deadlineAtMs) || remainingMs <= 0) return false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([
          attempt.result.then((applied) => ({ kind: 'result' as const, applied })),
          attempt.superseded.then(() => ({ kind: 'superseded' as const })),
          new Promise<{ readonly kind: 'timeout' }>((resolve) => {
            timer = setTimeout(() => resolve({ kind: 'timeout' }), remainingMs);
          }),
        ]).finally(() => {
          if (timer !== undefined) clearTimeout(timer);
        });
        if (outcome.kind === 'superseded' || this.#latestByKey.get(key) !== attempt)
          continue settle;
        if (outcome.kind === 'timeout' || !outcome.applied) return false;
        if (this.#latestByKey.delete(key)) {
          attempt.supersede();
          this.#version += 1;
        }
      }
      const version = this.#version;
      await Promise.resolve();
      await Promise.resolve();
      if (Date.now() >= deadlineAtMs) return false;
      if (version === this.#version) return true;
    }
  }
}

export interface CloseExecutionDrain {
  isSealedStable(): boolean;
  settle(deadlineAtMs: number): Promise<boolean>;
  sealAndSettle(deadlineAtMs: number): Promise<boolean>;
  end(): void;
}

type CloseExecutionBatch = {
  readonly results: Promise<boolean>[];
  version: number;
  sealed: boolean;
};

/** Tracks already-running and newly-started commands for one fail-closed close preparation. */
export class CloseExecutionBarrier {
  readonly #pending = new Set<Promise<boolean>>();
  #active: CloseExecutionBatch | null = null;

  public track(result: Promise<boolean>): Promise<boolean> {
    const normalized = normalizedCommitResult(result);
    this.#pending.add(normalized);
    if (this.#active !== null) {
      this.#active.results.push(this.#active.sealed ? Promise.resolve(false) : normalized);
      this.#active.version += 1;
    }
    void normalized.then(() => this.#pending.delete(normalized));
    return normalized;
  }

  public begin(): CloseExecutionDrain {
    if (this.#active !== null) throw new Error('A close execution drain is already active.');
    const batch: CloseExecutionBatch = {
      results: [...this.#pending],
      version: 0,
      sealed: false,
    };
    this.#active = batch;
    let ended = false;
    let sealedSettledVersion: number | null = null;
    let sealedSettledLength = -1;
    const settle = async (deadlineAtMs: number, seal: boolean): Promise<boolean> => {
      if (seal) {
        batch.sealed = true;
        sealedSettledVersion = null;
      }
      let index = 0;
      for (;;) {
        while (index < batch.results.length) {
          const result = batch.results[index++];
          if (result === undefined || !(await settleBooleanBeforeDeadline(result, deadlineAtMs)))
            return false;
        }
        const version = batch.version;
        await Promise.resolve();
        await Promise.resolve();
        if (Date.now() >= deadlineAtMs) return false;
        if (index === batch.results.length && version === batch.version) {
          if (seal) {
            sealedSettledVersion = version;
            sealedSettledLength = index;
          }
          return true;
        }
      }
    };
    return {
      isSealedStable: (): boolean =>
        !ended &&
        batch.sealed &&
        sealedSettledVersion !== null &&
        batch.version === sealedSettledVersion &&
        batch.results.length === sealedSettledLength,
      settle: (deadlineAtMs): Promise<boolean> => settle(deadlineAtMs, false),
      sealAndSettle: (deadlineAtMs): Promise<boolean> => settle(deadlineAtMs, true),
      end: (): void => {
        if (ended) return;
        ended = true;
        if (this.#active === batch) this.#active = null;
      },
    };
  }
}

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
