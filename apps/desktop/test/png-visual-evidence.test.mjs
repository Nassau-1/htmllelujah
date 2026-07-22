import { strict as assert } from 'node:assert';

import { describe, it } from 'vitest';

import { analyzeRgbVisual } from '../scripts/png-visual-evidence.mjs';

describe('PNG visual evidence metrics', () => {
  it('rejects a stable uniform frame regardless of its byte representation', () => {
    const width = 320;
    const height = 200;
    const pixels = Buffer.alloc(width * height * 3, 230);
    const result = analyzeRgbVisual({ width, height, channels: 3, pixels });
    assert.equal(result.passed, false);
    assert.equal(result.quantizedColorCount, 1);
    assert.equal(result.dominantColorRatio, 1);
    assert.equal(result.luminanceStandardDeviation, 0);
    assert.equal(result.edgeRatio, 0);
  });

  it('accepts a varied light slide with dark content and stable edges', () => {
    const width = 320;
    const height = 200;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 3;
        const stripe = x % 40 < 4 || y % 50 < 3;
        pixels[offset] = stripe ? 20 : 215 + ((x * 3) % 41);
        pixels[offset + 1] = stripe ? 25 : 210 + ((y * 5) % 46);
        pixels[offset + 2] = stripe ? 35 : 220 + (((x + y) * 7) % 36);
      }
    }
    const result = analyzeRgbVisual({ width, height, channels: 3, pixels });
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.ok(result.quantizedColorCount >= 16);
    assert.ok(result.darkPixelRatio > 0.001);
    assert.ok(result.lightPixelRatio > 0.1);
    assert.ok(result.edgeRatio > 0.001);
  });

  it('rejects varied RGB values when every pixel is fully transparent', () => {
    const width = 320;
    const height = 200;
    const pixels = Buffer.alloc(width * height * 4);
    for (let index = 0; index < width * height; index += 1) {
      const offset = index * 4;
      pixels[offset] = index % 256;
      pixels[offset + 1] = (index * 3) % 256;
      pixels[offset + 2] = (index * 7) % 256;
      pixels[offset + 3] = 0;
    }
    const result = analyzeRgbVisual({ width, height, channels: 4, pixels });
    assert.equal(result.passed, false);
    assert.equal(result.quantizedColorCount, 1);
    assert.equal(result.dominantColorRatio, 1);
  });
});
