import { describe, expect, it } from 'vitest';

import { isTrustedRendererUrl, resolveRendererEntryUrl } from '../src/main/renderer-entry.js';

describe('renderer entry boundary', () => {
  it('ignores every development renderer override in a packaged application', () => {
    expect(
      resolveRendererEntryUrl({
        packaged: true,
        devServerUrl: 'https://renderer.invalid/hostile',
      }),
    ).toBe('htmllelujah-app://app/index.html');
  });

  it('accepts only the exact pinned loopback Vite base during development', () => {
    expect(
      resolveRendererEntryUrl({
        packaged: false,
        devServerUrl: 'http://127.0.0.1:5173/',
      }),
    ).toBe('http://127.0.0.1:5173/');
    for (const devServerUrl of [
      'https://127.0.0.1:5173/',
      'http://localhost:5173/',
      'http://127.0.0.1:5174/',
      'http://127.0.0.1:5173.evil.invalid/',
      'http://user@127.0.0.1:5173/',
      'http://127.0.0.1:5173/other',
      'not a URL',
    ]) {
      expect(() => resolveRendererEntryUrl({ packaged: false, devServerUrl })).toThrow(
        /pinned loopback/u,
      );
    }
  });

  it('adds presentation parameters without allowing a base URL to replace them', () => {
    const query = new URLSearchParams({
      mode: 'presentation',
      startSlideId: 'slide & one',
    });
    expect(
      resolveRendererEntryUrl({
        packaged: true,
        devServerUrl: 'https://renderer.invalid/?mode=editor',
        query,
      }),
    ).toBe('htmllelujah-app://app/index.html?mode=presentation&startSlideId=slide+%26+one');
  });

  it('trusts the application scheme in production and loopback only in development', () => {
    expect(isTrustedRendererUrl('htmllelujah-app://app/index.html', true)).toBe(true);
    expect(isTrustedRendererUrl('htmllelujah-app://other/index.html', true)).toBe(false);
    expect(isTrustedRendererUrl('https://renderer.invalid/', true)).toBe(false);
    expect(isTrustedRendererUrl('http://127.0.0.1:5173/src/main.tsx', false)).toBe(true);
    expect(isTrustedRendererUrl('http://127.0.0.1:5173.evil.invalid/', false)).toBe(false);
    expect(isTrustedRendererUrl('http://127.0.0.1:5173/', true)).toBe(false);
  });
});
