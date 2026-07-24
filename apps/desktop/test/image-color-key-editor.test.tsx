import { createDefaultDeck, type ImageElement } from '@htmllelujah/document-core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ImageColorKeyEditor } from '../src/renderer/components/ImageColorKeyEditor.js';
import {
  clampImageColorKeyTolerance,
  normalizeImageColorKey,
  normalizeImageColorKeyColor,
  pickImageColorKeyFromScreen,
  previewImageColorKey,
  supportsImageEyeDropper,
  type EyeDropperHost,
} from '../src/renderer/editor/image-color-key.js';

describe('image color-key helpers', () => {
  it('normalizes the document-safe color and 0-255 tolerance range', () => {
    expect(normalizeImageColorKeyColor('#AbC')).toBe('#aabbcc');
    expect(normalizeImageColorKeyColor('not-a-color')).toBe('#ffffff');
    expect(clampImageColorKeyTolerance(-1)).toBe(0);
    expect(clampImageColorKeyTolerance(18.6)).toBe(19);
    expect(clampImageColorKeyTolerance(999)).toBe(255);
    expect(clampImageColorKeyTolerance(Number.NaN)).toBe(24);
    expect(normalizeImageColorKey({ color: '#000', tolerance: 300 })).toEqual({
      color: '#000000',
      tolerance: 255,
    });
  });

  it('uses the Chromium eyedropper when available and treats AbortError as cancel', async () => {
    const available: EyeDropperHost = {
      EyeDropper: class {
        public async open(): Promise<{ readonly sRGBHex: string }> {
          return { sRGBHex: '#12ABef' };
        }
      },
    };
    expect(supportsImageEyeDropper(available)).toBe(true);
    await expect(pickImageColorKeyFromScreen(available)).resolves.toBe('#12abef');
    await expect(pickImageColorKeyFromScreen(undefined)).resolves.toBeNull();

    const abort = new Error('cancelled');
    abort.name = 'AbortError';
    await expect(
      pickImageColorKeyFromScreen({
        EyeDropper: class {
          public async open(): Promise<never> {
            throw abort;
          }
        },
      }),
    ).resolves.toBeNull();
  });

  it('creates an immutable renderer-only preview on the requested authoring surface', () => {
    const deck = createDefaultDeck();
    const slide = deck.slides[0]!;
    const image: ImageElement = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Clipboard image',
      type: 'image',
      frame: { xPt: 10, yPt: 20, widthPt: 100, heightPt: 80, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      assetId: '22222222-2222-4222-8222-222222222222',
      altText: '',
      fit: 'contain',
      crop: { top: 0, right: 0, bottom: 0, left: 0 },
    };
    const source = { ...deck, slides: [{ ...slide, elements: [...slide.elements, image] }] };
    const preview = previewImageColorKey(source, { surface: 'slide', id: slide.id }, image.id, {
      color: '#ffffff',
      tolerance: 42,
    });

    expect(preview).not.toBe(source);
    expect(source.slides[0]?.elements.at(-1)).toEqual(image);
    expect(preview.slides[0]?.elements.at(-1)).toEqual({
      ...image,
      colorKey: { color: '#ffffff', tolerance: 42 },
    });
    expect(
      previewImageColorKey(
        preview,
        { surface: 'slide', id: slide.id },
        image.id,
        undefined,
      ).slides[0]?.elements.at(-1),
    ).toEqual(image);
    expect(
      previewImageColorKey(source, { surface: 'slide', id: 'missing' }, image.id, undefined),
    ).toBe(source);
  });
});

describe('ImageColorKeyEditor', () => {
  it('renders explicit white/black presets, eyedropper, bounded tolerance, Apply and Reset', () => {
    const markup = renderToStaticMarkup(
      <ImageColorKeyEditor
        value={{ color: '#000000', tolerance: 255 }}
        onPreview={vi.fn()}
        onApply={vi.fn()}
        onReset={vi.fn()}
        eyeDropperHost={undefined}
      />,
    );

    expect(markup).toContain('aria-label="Remove image background"');
    expect(markup).toMatch(/aria-pressed="true"[^>]*>.*Black/su);
    expect(markup).toContain('type="color"');
    expect(markup).toContain('aria-label="Pick a color from the screen"');
    expect(markup).toContain('Screen color picker is unavailable');
    expect(markup).toContain('type="range"');
    expect(markup).toContain('min="0"');
    expect(markup).toContain('max="255"');
    expect(markup).toContain('value="255"');
    expect(markup).toContain('>Reset<');
    expect(markup).toContain('>Apply<');
    expect(markup).toContain('Preview is non-destructive');
    expect(markup).not.toMatch(/(?:href|src)="https?:\/\//u);
  });
});
