import type { ImageColorKey } from '@htmllelujah/document-core';
import { Pipette, RotateCcw } from 'lucide-react';
import { useEffect, useState, type ChangeEvent, type ReactElement } from 'react';

import {
  clampImageColorKeyTolerance,
  normalizeImageColorKey,
  normalizeImageColorKeyColor,
  pickImageColorKeyFromScreen,
  supportsImageEyeDropper,
  type EyeDropperHost,
} from '../editor/image-color-key.js';
import '../../styles/image-color-key-editor.css';

export interface ImageColorKeyEditorProps {
  readonly value?: ImageColorKey | undefined;
  /** Updates the selected image locally without creating document history. */
  readonly onPreview: (value: ImageColorKey | undefined) => void;
  /** Commits the displayed color key to the authoritative image element. */
  readonly onApply: (value: ImageColorKey) => void | Promise<void>;
  /** Removes the effect and restores the original embedded image. */
  readonly onReset: () => void | Promise<void>;
  readonly disabled?: boolean | undefined;
  /** Injectable for tests; production defaults to the current Chromium window. */
  readonly eyeDropperHost?: EyeDropperHost | undefined;
}

const browserEyeDropperHost = (): EyeDropperHost | undefined =>
  typeof window === 'undefined' ? undefined : (window as unknown as EyeDropperHost);

export function ImageColorKeyEditor({
  value,
  onPreview,
  onApply,
  onReset,
  disabled = false,
  eyeDropperHost = browserEyeDropperHost(),
}: ImageColorKeyEditorProps): ReactElement {
  const [draft, setDraft] = useState<ImageColorKey>(() => normalizeImageColorKey(value));
  const [pending, setPending] = useState<'apply' | 'reset' | 'eyedropper' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const eyedropperAvailable = supportsImageEyeDropper(eyeDropperHost);

  useEffect(() => {
    setDraft(normalizeImageColorKey(value));
  }, [value?.color, value?.tolerance]);

  const preview = (next: ImageColorKey): void => {
    setDraft(next);
    setError(null);
    onPreview(next);
  };

  const setPreset = (color: '#ffffff' | '#000000'): void => {
    preview({ ...draft, color });
  };

  const changeColor = (event: ChangeEvent<HTMLInputElement>): void => {
    preview({ ...draft, color: normalizeImageColorKeyColor(event.currentTarget.value) });
  };

  const changeTolerance = (event: ChangeEvent<HTMLInputElement>): void => {
    preview({
      ...draft,
      tolerance: clampImageColorKeyTolerance(event.currentTarget.valueAsNumber),
    });
  };

  const pickColor = async (): Promise<void> => {
    if (disabled || pending !== null || !eyedropperAvailable) return;
    setPending('eyedropper');
    setError(null);
    try {
      const picked = await pickImageColorKeyFromScreen(eyeDropperHost);
      if (picked !== null) preview({ ...draft, color: picked });
    } catch {
      setError('The screen color could not be sampled.');
    } finally {
      setPending(null);
    }
  };

  const apply = async (): Promise<void> => {
    if (disabled || pending !== null) return;
    setPending('apply');
    setError(null);
    try {
      await onApply(draft);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The color key could not be applied.');
    } finally {
      setPending(null);
    }
  };

  const reset = async (): Promise<void> => {
    if (disabled || pending !== null) return;
    setPending('reset');
    setError(null);
    const previous = draft;
    setDraft(normalizeImageColorKey(undefined));
    try {
      onPreview(undefined);
      await onReset();
    } catch (cause) {
      setDraft(previous);
      try {
        onPreview(previous);
      } catch {
        // The authoritative reset error remains the useful message.
      }
      setError(cause instanceof Error ? cause.message : 'The color key could not be reset.');
    } finally {
      setPending(null);
    }
  };

  const controlsDisabled = disabled || pending !== null;

  return (
    <section className="image-color-key-editor" aria-label="Remove image background">
      <header>
        <div>
          <span className="eyebrow">Image</span>
          <h3>Transparent color</h3>
        </div>
        <span
          className="image-color-key-swatch"
          style={{ backgroundColor: draft.color }}
          aria-label={`Selected color ${draft.color}`}
        />
      </header>

      <div className="image-color-key-presets" role="group" aria-label="Color presets">
        <button
          type="button"
          className="image-color-key-preset"
          aria-pressed={draft.color === '#ffffff'}
          disabled={controlsDisabled}
          onClick={() => setPreset('#ffffff')}
        >
          <span className="is-white" aria-hidden="true" />
          White
        </button>
        <button
          type="button"
          className="image-color-key-preset"
          aria-pressed={draft.color === '#000000'}
          disabled={controlsDisabled}
          onClick={() => setPreset('#000000')}
        >
          <span className="is-black" aria-hidden="true" />
          Black
        </button>
      </div>

      <label className="image-color-key-field">
        <span>Custom color</span>
        <div className="image-color-key-color-row">
          <input
            type="color"
            value={draft.color}
            aria-label="Transparent color"
            disabled={controlsDisabled}
            onChange={changeColor}
          />
          <output>{draft.color.toUpperCase()}</output>
          <button
            type="button"
            className="image-color-key-icon-button"
            aria-label="Pick a color from the screen"
            title={
              eyedropperAvailable
                ? 'Pick a color from the screen'
                : 'Screen color picker is unavailable'
            }
            disabled={controlsDisabled || !eyedropperAvailable}
            onClick={() => void pickColor()}
          >
            <Pipette size={15} aria-hidden="true" />
          </button>
        </div>
      </label>

      <label className="image-color-key-field">
        <span>Tolerance</span>
        <div className="image-color-key-tolerance-row">
          <input
            type="range"
            min={0}
            max={255}
            step={1}
            value={draft.tolerance}
            aria-label="Color tolerance"
            disabled={controlsDisabled}
            onChange={changeTolerance}
          />
          <input
            type="number"
            min={0}
            max={255}
            step={1}
            value={draft.tolerance}
            aria-label="Color tolerance value"
            disabled={controlsDisabled}
            onChange={changeTolerance}
          />
        </div>
      </label>

      <p className="image-color-key-note">
        Preview is non-destructive. Apply writes only the color and tolerance; the embedded image
        stays unchanged.
      </p>

      {error === null ? null : (
        <p className="image-color-key-error" role="alert">
          {error}
        </p>
      )}

      <footer>
        <button
          type="button"
          className="image-color-key-reset"
          disabled={controlsDisabled}
          onClick={() => void reset()}
        >
          <RotateCcw size={14} aria-hidden="true" />
          Reset
        </button>
        <button
          type="button"
          className="image-color-key-apply"
          disabled={controlsDisabled}
          onClick={() => void apply()}
        >
          {pending === 'apply' ? 'Applying…' : 'Apply'}
        </button>
      </footer>
    </section>
  );
}
