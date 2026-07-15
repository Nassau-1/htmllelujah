import { describe, expect, it } from 'vitest';

import { waitForRenderReady } from '../src/index.js';

interface FakeImage {
  readonly complete: boolean;
  readonly decode?: (() => Promise<void>) | undefined;
}

const fakeRoot = (
  images: readonly FakeImage[],
  fontReady: Promise<unknown> = Promise.resolve(),
  geometry: Readonly<{ width: number; height: number }> = { width: 960, height: 540 },
): ParentNode =>
  ({
    ownerDocument: { fonts: { ready: fontReady } },
    querySelectorAll: (selector: string) => (selector === 'img' ? images : []),
    getBoundingClientRect: () => geometry,
  }) as unknown as ParentNode;

describe('waitForRenderReady', () => {
  it('waits for fonts, every image and exactly two frames', async () => {
    const calls: string[] = [];
    let clock = 100;
    const result = await waitForRenderReady(
      fakeRoot([
        {
          complete: false,
          decode: async () => {
            calls.push('image-1');
          },
        },
        {
          complete: true,
          decode: async () => {
            calls.push('image-2');
          },
        },
      ]),
      {
        deadlineMs: 500,
        expectedGeometry: { widthPx: 960, heightPx: 540, tolerancePx: 0 },
        now: () => clock,
        requestAnimationFrame: (callback) => {
          calls.push('frame');
          clock += 16;
          callback(clock);
          return calls.length;
        },
      },
    );

    expect(result).toEqual({
      ready: true,
      durationMs: 32,
      imageCount: 2,
      decodedImageCount: 2,
      geometryMeasured: true,
      warnings: [],
    });
    expect(calls.filter((entry) => entry === 'frame')).toHaveLength(2);
    expect(calls).toEqual(expect.arrayContaining(['image-1', 'image-2']));
  });

  it('returns generic warning codes without leaking failed image details', async () => {
    const secret = 'file:///Users/private/client-secret.png';
    const result = await waitForRenderReady(
      fakeRoot([
        {
          complete: false,
          decode: () => Promise.reject(new Error(secret)),
        },
      ]),
      {
        deadlineMs: 500,
        fontReady: Promise.reject(new Error('private font family')),
        requestAnimationFrame: (callback) => {
          callback(0);
          return 1;
        },
      },
    );

    expect(result.ready).toBe(false);
    expect(result.decodedImageCount).toBe(0);
    expect(result.warnings).toEqual([
      { code: 'FONT_LOAD_FAILED' },
      { code: 'IMAGE_DECODE_FAILED' },
    ]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('private font family');
  });

  it('is bounded when a resource never settles', async () => {
    const startedAt = performance.now();
    const result = await waitForRenderReady(fakeRoot([], new Promise(() => undefined)), {
      deadlineMs: 10,
    });
    const elapsed = performance.now() - startedAt;

    expect(result.ready).toBe(false);
    expect(result.warnings).toEqual([{ code: 'RENDER_TIMEOUT' }]);
    expect(elapsed).toBeLessThan(250);
  });

  it('supports pre-aborted and in-flight abort signals', async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const first = await waitForRenderReady(fakeRoot([]), { signal: preAborted.signal });
    expect(first.ready).toBe(false);
    expect(first.warnings).toEqual([{ code: 'ABORTED' }]);

    const inFlight = new AbortController();
    const pending = waitForRenderReady(fakeRoot([], new Promise(() => undefined)), {
      deadlineMs: 500,
      signal: inFlight.signal,
    });
    inFlight.abort();
    const second = await pending;
    expect(second.ready).toBe(false);
    expect(second.warnings).toEqual([{ code: 'ABORTED' }]);
  });

  it('contains frame scheduling failures behind a stable warning code', async () => {
    const result = await waitForRenderReady(fakeRoot([]), {
      requestAnimationFrame: () => {
        throw new Error('sensitive scheduler details');
      },
    });

    expect(result.ready).toBe(false);
    expect(result.warnings).toEqual([{ code: 'RENDER_FAILED' }]);
    expect(JSON.stringify(result)).not.toContain('sensitive scheduler details');
  });

  it('rejects zero or unexpected measured page geometry', async () => {
    const requestFrame = (callback: FrameRequestCallback): number => {
      callback(0);
      return 1;
    };
    const zero = await waitForRenderReady(
      fakeRoot([], Promise.resolve(), { width: 0, height: 0 }),
      {
        requestAnimationFrame: requestFrame,
      },
    );
    expect(zero.ready).toBe(false);
    expect(zero.geometryMeasured).toBe(true);
    expect(zero.warnings).toEqual([{ code: 'GEOMETRY_MISMATCH' }]);

    const mismatch = await waitForRenderReady(fakeRoot([]), {
      expectedGeometry: { widthPx: 1_280, heightPx: 720, tolerancePx: 0.25 },
      requestAnimationFrame: requestFrame,
    });
    expect(mismatch.ready).toBe(false);
    expect(mismatch.geometryMeasured).toBe(true);
    expect(mismatch.warnings).toEqual([{ code: 'GEOMETRY_MISMATCH' }]);
  });
});
