import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';

import { describe, it } from 'vitest';

const smokePath = new URL('../scripts/smoke-system-exports-windows.mjs', import.meta.url);

describe('system export visual evidence policy', () => {
  it('requires rendered pixels, exact local navigation, offline isolation, and cleanup receipts', async () => {
    const source = await readFile(smokePath, 'utf8');

    assert.match(source, /import \{ analyzePngVisual, visualThresholds \}/u);
    assert.match(source, /visualMetrics\.passed/u);
    assert.match(source, /stablePdfFramesRequired: 2/u);
    assert.match(source, /frameHash === previousAcceptedHash/u);
    assert.match(source, /'Browser\.getVersion'/u);
    assert.match(source, /'Network\.emulateNetworkConditions'/u);
    assert.match(source, /offline: true/u);
    assert.match(source, /--host-resolver-rules=MAP \* ~NOTFOUND/u);
    assert.match(source, /location\.result\?\.value === targetUrl/u);
    assert.match(source, /exactLocalUrlVerified/u);
    assert.match(source, /navigatedUrlSha256/u);
    assert.match(source, /browser\.once\('error'/u);
    assert.match(source, /runWithCleanup\(\{/u);
    assert.match(source, /pdfVisualBrowserProcessTreeClosed/u);
    assert.match(source, /await rm\(evidencePath, \{ force: true \}\)/u);
    assert.doesNotMatch(source, /local file and browser extension only/u);
    assert.doesNotMatch(source, /const pngDimensions/u);
  });
});
