export type RenderReadyWarningCode =
  | 'FONT_LOAD_FAILED'
  | 'GEOMETRY_MISMATCH'
  | 'IMAGE_DECODE_FAILED'
  | 'RENDER_FAILED'
  | 'RENDER_TIMEOUT'
  | 'ABORTED';

export interface RenderReadyWarning {
  readonly code: RenderReadyWarningCode;
}

export interface RenderReadyResult {
  readonly ready: boolean;
  readonly durationMs: number;
  readonly imageCount: number;
  readonly decodedImageCount: number;
  readonly geometryMeasured: boolean;
  /** Deliberately contains stable codes only, never asset URLs or document content. */
  readonly warnings: readonly RenderReadyWarning[];
}

export interface RenderReadyOptions {
  readonly deadlineMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly now?: (() => number) | undefined;
  readonly requestAnimationFrame?: ((callback: FrameRequestCallback) => number) | undefined;
  readonly fontReady?: Promise<unknown> | undefined;
  readonly expectedGeometry?:
    | Readonly<{
        widthPx: number;
        heightPx: number;
        tolerancePx?: number | undefined;
      }>
    | undefined;
}

interface ReadinessState {
  decodedImageCount: number;
  fontFailed: boolean;
  geometryFailed: boolean;
  geometryMeasured: boolean;
  imageFailed: boolean;
}

type Completion = 'complete' | 'failed' | 'timeout' | 'aborted';

const defaultNow = (): number =>
  typeof performance === 'undefined' ? Date.now() : performance.now();

const nextFrame = (requestFrame: (callback: FrameRequestCallback) => number): Promise<void> =>
  new Promise((resolve) => {
    requestFrame(() => resolve());
  });

const loadImages = async (
  images: readonly HTMLImageElement[],
  state: ReadinessState,
): Promise<void> => {
  await Promise.all(
    images.map(async (image) => {
      try {
        if (typeof image.decode === 'function') await image.decode();
        else if (!image.complete) throw new Error('decode unavailable');
        state.decodedImageCount += 1;
      } catch {
        state.imageFailed = true;
      }
    }),
  );
};

const loadFonts = async (fontReady: Promise<unknown>, state: ReadinessState): Promise<void> => {
  try {
    await fontReady;
  } catch {
    state.fontFailed = true;
  }
};

const defaultFrameRequest = (callback: FrameRequestCallback): number => {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
  return setTimeout(() => callback(defaultNow()), 0) as unknown as number;
};

const documentFontReady = (root: ParentNode): Promise<unknown> => {
  try {
    const isDocument = typeof Document !== 'undefined' && root instanceof Document;
    const ownerDocument = isDocument ? root : root.ownerDocument;
    const fonts = ownerDocument?.fonts;
    return fonts === undefined ? Promise.resolve() : Promise.resolve(fonts.ready);
  } catch (error: unknown) {
    return Promise.reject(error);
  }
};

interface MeasurableNode {
  getBoundingClientRect(): Readonly<{ width: number; height: number }>;
  getAttribute?(name: string): string | null;
}

const measurableNode = (root: ParentNode): MeasurableNode | null => {
  const direct = root as unknown as Partial<MeasurableNode>;
  if (
    typeof direct.getBoundingClientRect === 'function' &&
    (direct.getAttribute === undefined || direct.getAttribute('data-page-width-pt') !== null)
  ) {
    return direct as MeasurableNode;
  }
  const slide = root.querySelector('[data-page-width-pt][data-page-height-pt]');
  if (slide !== null && typeof slide.getBoundingClientRect === 'function') return slide;
  return typeof direct.getBoundingClientRect === 'function' ? (direct as MeasurableNode) : null;
};

const measureGeometry = (
  root: ParentNode,
  expected: RenderReadyOptions['expectedGeometry'],
  state: ReadinessState,
): void => {
  try {
    const node = measurableNode(root);
    if (node === null) {
      state.geometryFailed = true;
      return;
    }
    const rectangle = node.getBoundingClientRect();
    state.geometryMeasured = true;
    if (
      !Number.isFinite(rectangle.width) ||
      !Number.isFinite(rectangle.height) ||
      rectangle.width <= 0 ||
      rectangle.height <= 0
    ) {
      state.geometryFailed = true;
      return;
    }
    if (expected !== undefined) {
      const requestedTolerance = expected.tolerancePx ?? 0.5;
      const tolerance = Math.max(0, Number.isFinite(requestedTolerance) ? requestedTolerance : 0.5);
      state.geometryFailed =
        !Number.isFinite(expected.widthPx) ||
        !Number.isFinite(expected.heightPx) ||
        Math.abs(rectangle.width - expected.widthPx) > tolerance ||
        Math.abs(rectangle.height - expected.heightPx) > tolerance;
      return;
    }
    const widthPt = Number(node.getAttribute?.('data-page-width-pt'));
    const heightPt = Number(node.getAttribute?.('data-page-height-pt'));
    if (widthPt > 0 && heightPt > 0) {
      const horizontalScale = rectangle.width / widthPt;
      const verticalScale = rectangle.height / heightPt;
      state.geometryFailed = Math.abs(horizontalScale - verticalScale) > 0.001;
    }
  } catch {
    state.geometryFailed = true;
  }
};

export const waitForRenderReady = async (
  root: ParentNode,
  options: RenderReadyOptions = {},
): Promise<RenderReadyResult> => {
  const now = options.now ?? defaultNow;
  const startedAt = now();
  const requestedDeadline = options.deadlineMs ?? 5_000;
  const deadlineMs = Math.min(
    60_000,
    Math.max(0, Number.isFinite(requestedDeadline) ? requestedDeadline : 5_000),
  );
  const images = Array.from(root.querySelectorAll('img'));
  const state: ReadinessState = {
    decodedImageCount: 0,
    fontFailed: false,
    geometryFailed: false,
    geometryMeasured: false,
    imageFailed: false,
  };
  const requestFrame = options.requestAnimationFrame ?? defaultFrameRequest;

  if (options.signal?.aborted === true) {
    return {
      ready: false,
      durationMs: Math.max(0, now() - startedAt),
      imageCount: images.length,
      decodedImageCount: 0,
      geometryMeasured: false,
      warnings: [{ code: 'ABORTED' }],
    };
  }

  const work = Promise.all([
    loadFonts(options.fontReady ?? documentFontReady(root), state),
    loadImages(images, state),
  ])
    .then(async () => {
      await nextFrame(requestFrame);
      await nextFrame(requestFrame);
      measureGeometry(root, options.expectedGeometry, state);
      return 'complete' as const;
    })
    .catch(() => 'failed' as const);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const boundary = new Promise<Completion>((resolve) => {
    timeoutId = setTimeout(() => resolve('timeout'), deadlineMs);
    abortHandler = () => resolve('aborted');
    options.signal?.addEventListener('abort', abortHandler, { once: true });
  });

  const completion = await Promise.race<Completion>([work, boundary]);
  if (timeoutId !== undefined) clearTimeout(timeoutId);
  if (abortHandler !== undefined) options.signal?.removeEventListener('abort', abortHandler);

  const warnings: RenderReadyWarning[] = [];
  if (state.fontFailed) warnings.push({ code: 'FONT_LOAD_FAILED' });
  if (completion === 'complete' && state.geometryFailed) {
    warnings.push({ code: 'GEOMETRY_MISMATCH' });
  }
  if (state.imageFailed) warnings.push({ code: 'IMAGE_DECODE_FAILED' });
  if (completion === 'failed') warnings.push({ code: 'RENDER_FAILED' });
  if (completion === 'timeout') warnings.push({ code: 'RENDER_TIMEOUT' });
  if (completion === 'aborted') warnings.push({ code: 'ABORTED' });

  return {
    ready:
      completion === 'complete' &&
      !state.fontFailed &&
      state.geometryMeasured &&
      !state.geometryFailed &&
      !state.imageFailed,
    durationMs: Math.max(0, now() - startedAt),
    imageCount: images.length,
    decodedImageCount: state.decodedImageCount,
    geometryMeasured: state.geometryMeasured,
    warnings,
  };
};
