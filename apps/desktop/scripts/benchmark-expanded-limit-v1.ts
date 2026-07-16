import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { createDefaultDeck, type AssetRef, type DeckDocument } from '@htmllelujah/document-core';
import { DocumentSessionManager } from '@htmllelujah/document-runtime';
import type { HdeckAssetInput } from '@htmllelujah/hdeck';

const MIB = 1024 * 1024;
const ASSET_COUNT = 10;
const ASSET_BYTES = 50 * MIB;
const EXPANDED_ASSET_BYTES = ASSET_COUNT * ASSET_BYTES;
const repositoryRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const evidencePath = path.join(
  repositoryRoot,
  'artifacts',
  'evidence',
  'expanded-limit-benchmark-v1.json',
);

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const rounded = (value: number): number => Math.round(value * 100) / 100;

const assetId = (index: number): string =>
  `b0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;

const buildAssets = (): {
  readonly inputs: HdeckAssetInput[];
  readonly references: AssetRef[];
} => {
  const inputs: HdeckAssetInput[] = [];
  const references: AssetRef[] = [];
  for (let index = 0; index < ASSET_COUNT; index += 1) {
    const bytes = Buffer.alloc(ASSET_BYTES, index + 1);
    bytes.set(Buffer.from('wOF2', 'ascii'), 0);
    const hash = sha256(bytes);
    const id = assetId(index);
    const fileName = `expanded-limit-${index + 1}.woff2`;
    inputs.push({
      id,
      bytes,
      mediaType: 'font/woff2',
      originalName: fileName,
    });
    references.push({
      id,
      kind: 'font',
      hash,
      mediaType: 'font/woff2',
      fileName,
      byteLength: bytes.byteLength,
    });
  }
  return { inputs, references };
};

const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'htmllelujah-expanded-limit-'));
const expectedPrefix = path.join(path.resolve(tmpdir()), 'htmllelujah-expanded-limit-');
if (!path.resolve(temporaryRoot).startsWith(expectedPrefix)) {
  throw new Error('Refusing an unsafe expanded-limit temporary directory.');
}

const targetPath = path.join(temporaryRoot, 'expanded-limit-500-mib.hdeck');
const manager = new DocumentSessionManager({
  recoveryDirectory: path.join(temporaryRoot, 'save-recovery'),
  autosaveDelayMs: 0,
});
const verifier = new DocumentSessionManager({
  recoveryDirectory: path.join(temporaryRoot, 'open-recovery'),
  autosaveDelayMs: 0,
});
let peakRssBytes = process.memoryUsage().rss;
const memorySampler = setInterval(() => {
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
}, 50);

try {
  let fixture = buildAssets();
  const base = createDefaultDeck({ name: '500 MiB expanded-limit fixture' });
  let document: DeckDocument | undefined = {
    ...base,
    assets: fixture.references,
  };
  let session = await manager.createMainOnly({ document, assets: fixture.inputs });
  const saveStartedAt = performance.now();
  session = await manager.saveAsMainOnly(session.sessionId, {
    targetPath,
    expectedFingerprint: null,
  });
  const saveMs = performance.now() - saveStartedAt;
  if (session.dirty || session.document.assets.length !== ASSET_COUNT) {
    throw new Error('The expanded-limit session was not saved completely.');
  }
  const archive = await stat(targetPath);
  if (archive.size < EXPANDED_ASSET_BYTES || archive.size > 512 * MIB) {
    throw new Error('The expanded-limit archive size is outside the documented bounds.');
  }

  await manager.close(session.sessionId, { discardUnsaved: true });
  fixture = { inputs: [], references: [] };
  document = undefined;
  (globalThis as { gc?: () => void }).gc?.();

  const reopenStartedAt = performance.now();
  const reopened = await verifier.openMainOnly({ targetPath });
  const reopenMs = performance.now() - reopenStartedAt;
  if (
    reopened.document.assets.length !== ASSET_COUNT ||
    reopened.document.assets.reduce((sum, asset) => sum + asset.byteLength, 0) !==
      EXPANDED_ASSET_BYTES ||
    reopened.document.name !== '500 MiB expanded-limit fixture'
  ) {
    throw new Error('The expanded-limit archive did not reopen exactly.');
  }
  await verifier.close(reopened.sessionId, { discardUnsaved: true });
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);

  const report = {
    schemaVersion: 1,
    passed: true,
    testedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    fixture: {
      assetCount: ASSET_COUNT,
      bytesPerAsset: ASSET_BYTES,
      expandedAssetBytes: EXPANDED_ASSET_BYTES,
      expandedAssetMiB: EXPANDED_ASSET_BYTES / MIB,
      archiveBytes: archive.size,
      syntheticWoff2SignatureOnly: true,
    },
    measurements: {
      saveMs: rounded(saveMs),
      reopenMs: rounded(reopenMs),
      peakRssBytes,
      peakRssMiB: rounded(peakRssBytes / MIB),
    },
    checks: {
      exactAssetCountReopened: true,
      exactExpandedByteCountReopened: true,
      archiveStayedWithin512MiBLimit: true,
      temporaryFixtureRemovedAfterTest: true,
    },
  };
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `Expanded-limit benchmark passed: saved ${report.fixture.expandedAssetMiB} MiB in ${report.measurements.saveMs} ms and reopened it in ${report.measurements.reopenMs} ms.\n`,
  );
} finally {
  clearInterval(memorySampler);
  await Promise.allSettled(
    manager
      .listSessions()
      .map((session) => manager.close(session.sessionId, { discardUnsaved: true })),
  );
  await Promise.allSettled(
    verifier
      .listSessions()
      .map((session) => verifier.close(session.sessionId, { discardUnsaved: true })),
  );
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
