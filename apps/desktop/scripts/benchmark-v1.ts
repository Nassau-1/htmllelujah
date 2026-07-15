import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createDefaultDeck,
  createDuplicateSlide,
  parseDeck,
  type DeckDocument,
} from '@htmllelujah/document-core';
import { DocumentSessionManager } from '@htmllelujah/document-runtime';
import { moveItemsWithSnapping, type GeometryItem } from '@htmllelujah/geometry';

const percentile = (samples: readonly number[], quantile: number): number => {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index] ?? 0;
};

const rounded = (value: number): number => Math.round(value * 100) / 100;

const deterministicIdFactory = (): (() => string) => {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`;
  };
};

const buildSupportedLimitDeck = (): DeckDocument => {
  const idFactory = deterministicIdFactory();
  const initial = createDefaultDeck({
    idFactory,
    now: () => '2026-07-15T00:00:00.000Z',
    name: '500 slide performance fixture',
  });
  const sourceId = initial.slides[0]!.id;
  const slides = [...initial.slides];
  for (let index = 1; index < 500; index += 1) {
    slides.push(createDuplicateSlide(initial, sourceId, idFactory, `Slide ${index + 1}`));
  }
  return { ...initial, slides };
};

const benchmarkValidation = (): {
  readonly durationMs: number;
  readonly slides: number;
  readonly elements: number;
} => {
  const fixture = buildSupportedLimitDeck();
  const startedAt = performance.now();
  const parsed = parseDeck(fixture);
  const durationMs = performance.now() - startedAt;
  return {
    durationMs: rounded(durationMs),
    slides: parsed.slides.length,
    elements: parsed.slides.reduce((sum, slide) => sum + slide.elements.length, 0),
  };
};

const benchmarkGesture = (): { readonly p95Ms: number; readonly samples: number } => {
  const objects: GeometryItem[] = Array.from({ length: 2_000 }, (_, index) => ({
    id: `item-${index}`,
    frame: {
      xPt: (index % 50) * 18,
      yPt: Math.floor(index / 50) * 12,
      widthPt: 14,
      heightPt: 8,
      rotationDeg: index % 7 === 0 ? 5 : 0,
    },
  }));
  const moving = [objects[0]!];
  const samples: number[] = [];
  for (let index = 0; index < 250; index += 1) {
    const startedAt = performance.now();
    moveItemsWithSnapping(
      moving,
      { dxPt: index / 10, dyPt: index / 20 },
      {
        objects,
        grid: { enabled: true, spacingPt: 12, tolerancePt: 4 },
        tolerancePt: 4,
      },
    );
    samples.push(performance.now() - startedAt);
  }
  return { p95Ms: rounded(percentile(samples.slice(25), 0.95)), samples: samples.length - 25 };
};

const benchmarkRuntime = async (
  directory: string,
): Promise<{
  readonly commandP95Ms: number;
  readonly commandSamples: number;
  readonly saveMs: number;
  readonly reopenMs: number;
  readonly reopenedSlides: number;
}> => {
  const manager = new DocumentSessionManager({
    recoveryDirectory: path.join(directory, 'recovery'),
    autosaveDelayMs: 0,
  });
  const verifier = new DocumentSessionManager({
    recoveryDirectory: path.join(directory, 'verifier-recovery'),
    autosaveDelayMs: 0,
  });
  try {
    let snapshot = await manager.createMainOnly({
      document: createDefaultDeck({ name: 'Command latency fixture' }),
    });
    const samples: number[] = [];
    for (let index = 0; index < 200; index += 1) {
      const startedAt = performance.now();
      snapshot = await manager.execute(snapshot.sessionId, {
        expectedRevision: snapshot.revision,
        commands: [{ type: 'deck.rename', name: `Performance fixture ${index % 2}` }],
        metadata: {
          transactionId: randomUUID(),
          actorId: 'release-benchmark',
          origin: 'system',
          label: 'Measure durable local command',
          timestamp: new Date().toISOString(),
        },
      });
      samples.push(performance.now() - startedAt);
    }

    await manager.close(snapshot.sessionId, { discardUnsaved: true });
    snapshot = await manager.createMainOnly({ document: buildSupportedLimitDeck() });
    const targetPath = path.join(directory, 'supported-limit.hdeck');
    const saveStartedAt = performance.now();
    await manager.saveAsMainOnly(snapshot.sessionId, {
      targetPath,
      expectedFingerprint: null,
      allowOverwrite: true,
    });
    const saveMs = performance.now() - saveStartedAt;

    const reopenStartedAt = performance.now();
    const reopened = await verifier.openMainOnly({ targetPath });
    const reopenMs = performance.now() - reopenStartedAt;
    if (reopened.document.slides.length !== 500) {
      throw new Error('The supported-limit deck did not round-trip all 500 slides.');
    }
    return {
      commandP95Ms: rounded(percentile(samples.slice(20), 0.95)),
      commandSamples: samples.length - 20,
      saveMs: rounded(saveMs),
      reopenMs: rounded(reopenMs),
      reopenedSlides: reopened.document.slides.length,
    };
  } finally {
    await Promise.allSettled(
      [...manager.listSessions(), ...verifier.listSessions()].map((session) =>
        (manager.listSessions().some((candidate) => candidate.sessionId === session.sessionId)
          ? manager
          : verifier
        ).close(session.sessionId, { discardUnsaved: true }),
      ),
    );
  }
};

const outputIndex = process.argv.indexOf('--output');
const outputPath = outputIndex < 0 ? undefined : process.argv[outputIndex + 1];
const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-benchmark-'));
try {
  const validation = benchmarkValidation();
  const gesture = benchmarkGesture();
  const runtime = await benchmarkRuntime(directory);
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    validation,
    gesture: { ...gesture, thresholdMs: 16.7, passed: gesture.p95Ms < 16.7 },
    runtime: {
      ...runtime,
      commandThresholdMs: 100,
      commandPassed: runtime.commandP95Ms < 100,
    },
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath !== undefined) {
    const absoluteOutput = path.resolve(outputPath);
    await mkdir(path.dirname(absoluteOutput), { recursive: true });
    await writeFile(absoluteOutput, serialized, { encoding: 'utf8', flag: 'w' });
  }
  process.stdout.write(serialized);
  if (!result.gesture.passed || !result.runtime.commandPassed) process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
