import type { DeckDocument, ImageColorKey, ImageElement } from '@htmllelujah/document-core';

export const DEFAULT_IMAGE_COLOR_KEY: ImageColorKey = Object.freeze({
  color: '#ffffff',
  tolerance: 24,
});

export const clampImageColorKeyTolerance = (value: number): number => {
  if (!Number.isFinite(value)) return DEFAULT_IMAGE_COLOR_KEY.tolerance;
  return Math.min(255, Math.max(0, Math.round(value)));
};

export const normalizeImageColorKeyColor = (
  value: string,
  fallback = DEFAULT_IMAGE_COLOR_KEY.color,
): string => {
  const normalized = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/u.test(normalized)) return normalized;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/u.exec(normalized);
  if (short !== null) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return /^#[0-9a-f]{6}$/u.test(fallback.toLowerCase())
    ? fallback.toLowerCase()
    : DEFAULT_IMAGE_COLOR_KEY.color;
};

export const normalizeImageColorKey = (value: ImageColorKey | undefined): ImageColorKey =>
  value === undefined
    ? DEFAULT_IMAGE_COLOR_KEY
    : {
        color: normalizeImageColorKeyColor(value.color),
        tolerance: clampImageColorKeyTolerance(value.tolerance),
      };

export type ImageColorKeyPreviewTarget =
  | Readonly<{ surface: 'slide'; id: string }>
  | Readonly<{ surface: 'layout'; id: string }>
  | Readonly<{ surface: 'master'; id: string }>;

const imageWithColorKeyPreview = (
  element: ImageElement,
  colorKey: ImageColorKey | undefined,
): ImageElement => {
  if (colorKey !== undefined) return { ...element, colorKey };
  const { colorKey: _discarded, ...withoutColorKey } = element;
  return withoutColorKey;
};

/**
 * Produces a renderer-only document projection for the selected image. It never mutates
 * the authoritative session snapshot and changes no other object or container.
 */
export const previewImageColorKey = (
  document: DeckDocument,
  target: ImageColorKeyPreviewTarget,
  elementId: string,
  colorKey: ImageColorKey | undefined,
): DeckDocument => {
  let changed = false;
  const replace = (elements: readonly import('@htmllelujah/document-core').Element[]) =>
    elements.map((element) => {
      if (element.id !== elementId || element.type !== 'image') return element;
      changed = true;
      return imageWithColorKeyPreview(element, colorKey);
    });

  let projected = document;
  if (target.surface === 'slide') {
    projected = {
      ...document,
      slides: document.slides.map((slide) =>
        slide.id === target.id ? { ...slide, elements: replace(slide.elements) } : slide,
      ),
    };
  } else if (target.surface === 'layout') {
    projected = {
      ...document,
      layouts: document.layouts.map((layout) =>
        layout.id === target.id ? { ...layout, elements: replace(layout.elements) } : layout,
      ),
    };
  } else {
    projected = {
      ...document,
      masters: document.masters.map((master) =>
        master.id === target.id ? { ...master, elements: replace(master.elements) } : master,
      ),
    };
  }
  return changed ? projected : document;
};

export interface EyeDropperResult {
  readonly sRGBHex: string;
}

export interface EyeDropperInstance {
  open(): Promise<EyeDropperResult>;
}

export interface EyeDropperHost {
  readonly EyeDropper?: (new () => EyeDropperInstance) | undefined;
}

export const supportsImageEyeDropper = (host: EyeDropperHost | undefined): boolean =>
  typeof host?.EyeDropper === 'function';

/**
 * Chromium rejects with AbortError when the user presses Escape. That is an ordinary cancel,
 * while decoder/browser failures remain visible to the caller.
 */
export const pickImageColorKeyFromScreen = async (
  host: EyeDropperHost | undefined,
): Promise<string | null> => {
  const Constructor = host?.EyeDropper;
  if (typeof Constructor !== 'function') return null;
  try {
    const result = await new Constructor().open();
    return normalizeImageColorKeyColor(result.sRGBHex);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      error.name === 'AbortError'
    ) {
      return null;
    }
    throw error;
  }
};
