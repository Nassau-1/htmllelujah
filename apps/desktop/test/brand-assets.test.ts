import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const expectedHashes = {
  'htmllelujah-app-icon.svg': '3a89de7aeaf9a693cbc47d08a5402fdf21f10751d006ddb692f50b264994fa92',
  'icon.ico': '7554b438632c7e1767b2d5397f1c1e5afc148bf2e9e87a868e324f9219c602e1',
  'icon.png': '2c0fc4e9872807d366dee86245cd7e03f53a2e8feae0b4c97b2a5b2708e2d4d2',
} as const;

const assetUrl = (name: keyof typeof expectedHashes) =>
  new URL(`../assets/${name}`, import.meta.url);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('official HTMLlelujah identity', () => {
  it('pins the exact owner-provided assets and native Windows icon sizes', async () => {
    const [png, ico, svg, provenance] = await Promise.all([
      readFile(assetUrl('icon.png')),
      readFile(assetUrl('icon.ico')),
      readFile(assetUrl('htmllelujah-app-icon.svg'), 'utf8'),
      readFile(new URL('../../../docs/legal/asset-provenance.md', import.meta.url), 'utf8'),
    ]);

    expect(sha256(png)).toBe(expectedHashes['icon.png']);
    expect(sha256(ico)).toBe(expectedHashes['icon.ico']);
    expect(sha256(Buffer.from(svg))).toBe(expectedHashes['htmllelujah-app-icon.svg']);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.readUInt32BE(16)).toBe(1024);
    expect(png.readUInt32BE(20)).toBe(1024);

    const iconCount = ico.readUInt16LE(4);
    const iconSizes = Array.from({ length: iconCount }, (_, index) => {
      const offset = 6 + index * 16;
      return [ico[offset] || 256, ico[offset + 1] || 256];
    });
    expect(iconSizes).toEqual([
      [16, 16],
      [24, 24],
      [32, 32],
      [48, 48],
      [64, 64],
      [128, 128],
      [256, 256],
    ]);
    expect(svg).toContain('viewBox="0 0 1024 1024"');
    expect(svg).toContain('fill="#2F6FEB"');
    expect(svg).toContain('fill="#171C24"');

    for (const hash of Object.values(expectedHashes)) expect(provenance).toContain(hash);
  });

  it('uses the identity consistently in packaging and rendered application chrome', async () => {
    const [packageSource, appSource, mainSource, htmlSource] = await Promise.all([
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8'),
      readFile(new URL('../index.html', import.meta.url), 'utf8'),
    ]);
    const packageJson = JSON.parse(packageSource) as {
      build?: {
        files?: string[];
        fileAssociations?: Array<{ icon?: string }>;
        win?: { icon?: string };
      };
    };

    expect(packageJson.build?.win?.icon).toBe('assets/icon.ico');
    expect(packageJson.build?.fileAssociations?.[0]?.icon).toBeUndefined();
    expect(packageJson.build?.files).toContain('assets/icon.png');
    expect(
      mainSource.match(/icon: path\.join\(app\.getAppPath\(\), 'assets', 'icon\.png'\)/gu),
    ).toHaveLength(2);
    expect(mainSource).toContain("case '.svg':");
    expect(mainSource).toContain("return 'image/svg+xml';");
    expect(appSource).toContain(
      "import htmllelujahAppIcon from '../../assets/htmllelujah-app-icon.svg'",
    );
    expect(appSource.match(/src=\{htmllelujahAppIcon\}/gu)).toHaveLength(2);
    expect(appSource.match(/draggable=\{false\}/gu)).toHaveLength(2);
    expect(htmlSource).toContain('href="./assets/htmllelujah-app-icon.svg"');
  });
});
