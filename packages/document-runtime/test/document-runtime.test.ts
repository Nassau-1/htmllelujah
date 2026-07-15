import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createHdeckArchive, parseHdeckArchive, replayJournal, sha256 } from '@htmllelujah/hdeck';
import type { TransactionMetadata } from '@htmllelujah/document-core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  defaultJournalDurability,
  DocumentRuntimeError,
  DocumentSessionManager,
  type JournalDurabilityCapability,
  type RuntimeEvent,
} from '../src/index.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-runtime-'));
  directories.push(directory);
  return directory;
};

const ids = (): (() => string) => {
  let value = 0;
  return () => {
    value += 1;
    return `dddddddd-dddd-4ddd-8ddd-${value.toString(16).padStart(12, '0')}`;
  };
};

const metadata = (
  value: number,
  origin: TransactionMetadata['origin'] = 'user',
  label = 'Runtime test',
): TransactionMetadata => ({
  transactionId: `eeeeeeee-eeee-4eee-8eee-${value.toString(16).padStart(12, '0')}`,
  actorId: origin === 'agent' ? 'test-agent' : 'test-user',
  origin,
  label,
  timestamp: `2026-07-15T12:${String(value).padStart(2, '0')}:00.000Z`,
});

const onePixelPng = (): Uint8Array =>
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );

const managerFor = (
  recoveryDirectory: string,
  options: Partial<ConstructorParameters<typeof DocumentSessionManager>[0]> = {},
): DocumentSessionManager =>
  new DocumentSessionManager({
    recoveryDirectory,
    idFactory: ids(),
    now: () => '2026-07-15T12:00:00.000Z',
    autosaveDelayMs: 0,
    ...options,
  });

describe('document session authority', () => {
  it('returns immutable snapshots and isolates multiple documents', async () => {
    const directory = await temporaryDirectory();
    const manager = managerFor(directory);
    const first = await manager.createMainOnly();
    const second = await manager.createMainOnly();
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.document)).toBe(true);

    await manager.execute(first.sessionId, {
      expectedRevision: first.revision,
      commands: [{ type: 'deck.rename', name: 'First only' }],
      metadata: metadata(1),
    });
    expect(manager.getSnapshot(first.sessionId).document.name).toBe('First only');
    expect(manager.getSnapshot(second.sessionId).document.name).toBe('Untitled presentation');
    expect(manager.listSessions()).toHaveLength(2);
  });

  it('rejects stale revisions before journaling', async () => {
    const directory = await temporaryDirectory();
    const manager = managerFor(directory);
    const session = await manager.createMainOnly();
    await expect(
      manager.execute(session.sessionId, {
        expectedRevision: 'rev1-stale',
        commands: [{ type: 'deck.rename', name: 'No' }],
        metadata: metadata(1),
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(manager.getSnapshot(session.sessionId).document.name).toBe('Untitled presentation');
  });

  it('does not acknowledge or mutate until the durable journal append completes', async () => {
    const directory = await temporaryDirectory();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let appendEntered = false;
    const journal: JournalDurabilityCapability = {
      ...defaultJournalDurability,
      append: async (target, record) => {
        appendEntered = true;
        await gate;
        await defaultJournalDurability.append(target, record);
      },
    };
    const manager = managerFor(directory, { journal });
    const session = await manager.createMainOnly();
    let acknowledged = false;
    const pending = manager
      .execute(session.sessionId, {
        expectedRevision: session.revision,
        commands: [{ type: 'deck.rename', name: 'Durable' }],
        metadata: metadata(1),
      })
      .then((snapshot) => {
        acknowledged = true;
        return snapshot;
      });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(appendEntered).toBe(true);
    expect(acknowledged).toBe(false);
    expect(manager.getSnapshot(session.sessionId).document.name).toBe('Untitled presentation');
    release?.();
    const committed = await pending;
    expect(committed.document.name).toBe('Durable');
    const journalBytes = await readFile(path.join(directory, `${session.sessionId}.journal`));
    expect(replayJournal(journalBytes).records).toHaveLength(1);
  });

  it('keeps the session atomic when a journal append fails', async () => {
    const directory = await temporaryDirectory();
    let fail = true;
    const journal: JournalDurabilityCapability = {
      ...defaultJournalDurability,
      append: async (target, record) => {
        if (fail) throw new Error('injected append failure');
        await defaultJournalDurability.append(target, record);
      },
    };
    const manager = managerFor(directory, { journal });
    const session = await manager.createMainOnly();
    await expect(
      manager.execute(session.sessionId, {
        expectedRevision: session.revision,
        commands: [{ type: 'deck.rename', name: 'Not committed' }],
        metadata: metadata(1),
      }),
    ).rejects.toMatchObject({ code: 'JOURNAL_FAILED' });
    expect(manager.getSnapshot(session.sessionId).revision).toBe(session.revision);
    fail = false;
    const committed = await manager.execute(session.sessionId, {
      expectedRevision: session.revision,
      commands: [{ type: 'deck.rename', name: 'Committed later' }],
      metadata: metadata(2),
    });
    expect(committed.document.name).toBe('Committed later');
  });

  it('undoes and redoes grouped transactions as one durable history entry', async () => {
    const directory = await temporaryDirectory();
    const manager = managerFor(directory);
    const session = await manager.createMainOnly();
    const first = await manager.execute(session.sessionId, {
      expectedRevision: session.revision,
      commands: [{ type: 'deck.rename', name: 'Grouped one' }],
      metadata: metadata(1),
      historyGroupId: 'typing-name',
    });
    const second = await manager.execute(session.sessionId, {
      expectedRevision: first.revision,
      commands: [{ type: 'deck.rename', name: 'Grouped two' }],
      metadata: metadata(2),
      historyGroupId: 'typing-name',
    });
    const undone = await manager.undo(session.sessionId, {
      expectedRevision: second.revision,
      metadata: metadata(3),
    });
    expect(undone.document.name).toBe('Untitled presentation');
    expect(undone.canUndo).toBe(false);
    expect(undone.canRedo).toBe(true);
    const redone = await manager.redo(session.sessionId, {
      expectedRevision: undone.revision,
      metadata: metadata(4),
    });
    expect(redone.document.name).toBe('Grouped two');
  });

  it('guards dirty close and allows an explicit discard', async () => {
    const directory = await temporaryDirectory();
    const manager = managerFor(directory);
    const session = await manager.createMainOnly();
    await expect(manager.close(session.sessionId)).rejects.toMatchObject({
      code: 'DIRTY_DOCUMENT',
    });
    expect(manager.getSnapshot(session.sessionId).dirty).toBe(true);
    await manager.close(session.sessionId, { discardUnsaved: true });
    expect(() => manager.getSnapshot(session.sessionId)).toThrow(DocumentRuntimeError);
  });
});

describe('save, reopen, assets, and conflicts', () => {
  it('saves atomically, flushes, closes cleanly, and reopens the same document', async () => {
    const directory = await temporaryDirectory();
    const recovery = path.join(directory, 'recovery');
    const target = path.join(directory, 'Deck V1.hdeck');
    const manager = managerFor(recovery);
    const session = await manager.createMainOnly();
    const changed = await manager.execute(session.sessionId, {
      expectedRevision: session.revision,
      commands: [{ type: 'deck.rename', name: 'Persisted name' }],
      metadata: metadata(1),
    });
    const saved = await manager.saveAsMainOnly(session.sessionId, {
      targetPath: target,
      expectedFingerprint: null,
    });
    expect(saved.dirty).toBe(false);
    expect(saved.durability).toBe('clean');
    expect((await manager.flush(session.sessionId)).revision).toBe(changed.revision);
    await manager.close(session.sessionId);

    const reopened = await manager.openMainOnly({ targetPath: target });
    expect(reopened.document.name).toBe('Persisted name');
    expect(reopened.dirty).toBe(false);
  });

  it('writes a detached authoritative copy without enabling background target writes', async () => {
    const directory = await temporaryDirectory();
    const target = path.join(directory, 'shared-authoritative.hdeck');
    const manager = managerFor(path.join(directory, 'recovery'), { autosaveDelayMs: 10 });
    const session = await manager.createMainOnly();
    const changed = await manager.execute(session.sessionId, {
      expectedRevision: session.revision,
      commands: [{ type: 'deck.rename', name: 'Host snapshot' }],
      metadata: metadata(1),
    });
    const saved = await manager.saveDetachedMainOnly(session.sessionId, {
      targetPath: target,
      expectedFingerprint: null,
      allowOverwrite: true,
    });
    expect(saved).toMatchObject({ dirty: false, hasSaveTarget: false, durability: 'clean' });
    const edited = await manager.execute(session.sessionId, {
      expectedRevision: saved.revision,
      commands: [{ type: 'deck.rename', name: 'Not automatically shared' }],
      metadata: metadata(2),
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(manager.getSnapshot(session.sessionId).dirty).toBe(true);
    expect(manager.getSnapshot(session.sessionId).revision).toBe(edited.revision);
    expect(parseHdeckArchive(await readFile(target)).document.name).toBe(changed.document.name);
  });

  it('detects a target changed outside the runtime', async () => {
    const directory = await temporaryDirectory();
    const target = path.join(directory, 'conflict.hdeck');
    const manager = managerFor(path.join(directory, 'recovery'));
    const session = await manager.createMainOnly();
    const saved = await manager.saveAsMainOnly(session.sessionId, {
      targetPath: target,
      expectedFingerprint: null,
    });
    const changed = await manager.execute(session.sessionId, {
      expectedRevision: saved.revision,
      commands: [{ type: 'deck.rename', name: 'Local edit' }],
      metadata: metadata(1),
    });
    const external = {
      ...changed.document,
      name: 'External edit',
      metadata: {
        ...changed.document.metadata,
        modifiedAt: '2026-07-15T13:00:00.000Z',
      },
    };
    await writeFile(target, createHdeckArchive({ document: external }));
    await expect(manager.save(session.sessionId)).rejects.toMatchObject({
      code: 'TARGET_CHANGED',
    });
    expect(manager.getSnapshot(session.sessionId).document.name).toBe('Local edit');
  });

  it('stores asset bytes by content hash and round-trips them through .hdeck', async () => {
    const directory = await temporaryDirectory();
    const target = path.join(directory, 'assets.hdeck');
    const manager = managerFor(path.join(directory, 'recovery'));
    const session = await manager.createMainOnly();
    const bytes = onePixelPng();
    const stored = await manager.storeAsset(session.sessionId, {
      id: 'ffffffff-ffff-4fff-8fff-000000000001',
      bytes,
      mediaType: 'image/png',
      fileName: 'chart.png',
      widthPx: 1,
      heightPx: 1,
      expectedRevision: session.revision,
      metadata: metadata(1),
    });
    await manager.saveAsMainOnly(session.sessionId, {
      targetPath: target,
      expectedFingerprint: null,
    });
    const parsed = parseHdeckArchive(await readFile(target));
    expect(Array.from(parsed.assets.get('ffffffff-ffff-4fff-8fff-000000000001') ?? [])).toEqual(
      Array.from(bytes),
    );
    expect(stored.document.assets[0]?.hash).toBe(parsed.manifest.assets[0]?.sha256);
  });

  it('registers, inserts, and replaces an image with one undo step per user action', async () => {
    const directory = await temporaryDirectory();
    const manager = managerFor(directory);
    const session = await manager.createMainOnly();
    const slideId = session.document.slides[0]!.id;
    const assetId = 'ffffffff-ffff-4fff-8fff-000000000011';
    const elementId = 'ffffffff-ffff-4fff-8fff-000000000012';
    const inserted = await manager.storeAssetAndExecute(session.sessionId, {
      id: assetId,
      bytes: onePixelPng(),
      mediaType: 'image/png',
      fileName: 'atomic.png',
      widthPx: 1,
      heightPx: 1,
      expectedRevision: session.revision,
      metadata: metadata(11),
      commands: [
        {
          type: 'element.insert',
          slideId,
          element: {
            id: elementId,
            type: 'image',
            name: 'Atomic image',
            frame: { xPt: 10, yPt: 10, widthPt: 100, heightPt: 100, rotationDeg: 0 },
            opacity: 1,
            visible: true,
            locked: false,
            assetId,
            altText: 'Atomic image',
            fit: 'contain',
            crop: { top: 0, right: 0, bottom: 0, left: 0 },
          },
        },
      ],
    });
    expect(inserted.document.assets.map((asset) => asset.id)).toEqual([assetId]);
    expect(inserted.document.slides[0]!.elements.some((element) => element.id === elementId)).toBe(
      true,
    );

    const originalElement = inserted.document.slides[0]!.elements.find(
      (element) => element.id === elementId,
    );
    if (originalElement?.type !== 'image') throw new Error('Inserted image fixture is missing.');
    const replacementAssetId = 'ffffffff-ffff-4fff-8fff-000000000013';
    const replaced = await manager.storeAssetAndExecute(session.sessionId, {
      id: replacementAssetId,
      bytes: onePixelPng(),
      mediaType: 'image/png',
      fileName: 'replacement.png',
      widthPx: 1,
      heightPx: 1,
      expectedRevision: inserted.revision,
      metadata: metadata(12),
      commands: [
        {
          type: 'element.update',
          slideId,
          elementId,
          replacement: { ...originalElement, assetId: replacementAssetId },
        },
      ],
    });
    expect(
      (
        replaced.document.slides[0]!.elements.find((element) => element.id === elementId) as {
          assetId?: string;
        }
      ).assetId,
    ).toBe(replacementAssetId);

    const replacementUndone = await manager.undo(session.sessionId, {
      expectedRevision: replaced.revision,
      metadata: metadata(13),
    });
    expect(
      (
        replacementUndone.document.slides[0]!.elements.find(
          (element) => element.id === elementId,
        ) as { assetId?: string }
      ).assetId,
    ).toBe(assetId);
    expect(replacementUndone.document.assets.map((asset) => asset.id)).toEqual([assetId]);

    const undone = await manager.undo(session.sessionId, {
      expectedRevision: replacementUndone.revision,
      metadata: metadata(14),
    });
    expect(undone.document.assets).toHaveLength(0);
    expect(undone.document.slides[0]!.elements.some((element) => element.id === elementId)).toBe(
      false,
    );
  });

  it('does not stage a blob or mutate the document for stale or invalid image placement', async () => {
    const directory = await temporaryDirectory();
    const manager = managerFor(directory, { recoveryBlobGcMinAgeMs: 0 });
    const session = await manager.createMainOnly();
    const bytes = onePixelPng();
    const hash = sha256(bytes);
    const request = {
      id: 'ffffffff-ffff-4fff-8fff-000000000021',
      bytes,
      mediaType: 'image/png' as const,
      fileName: 'rejected.png',
      widthPx: 1,
      heightPx: 1,
      expectedRevision: 'stale-revision',
      metadata: metadata(21),
      commands: [
        {
          type: 'element.insert' as const,
          slideId: 'ffffffff-ffff-4fff-8fff-000000000099',
          element: {
            id: 'ffffffff-ffff-4fff-8fff-000000000022',
            type: 'image' as const,
            name: 'Rejected image',
            frame: { xPt: 10, yPt: 10, widthPt: 100, heightPt: 100, rotationDeg: 0 },
            opacity: 1,
            visible: true,
            locked: false,
            assetId: 'ffffffff-ffff-4fff-8fff-000000000021',
            altText: 'Rejected',
            fit: 'contain' as const,
            crop: { top: 0, right: 0, bottom: 0, left: 0 },
          },
        },
      ],
    };
    await expect(manager.storeAssetAndExecute(session.sessionId, request)).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    await expect(readFile(path.join(directory, 'blobs', hash))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await expect(
      manager.storeAssetAndExecute(session.sessionId, {
        ...request,
        expectedRevision: session.revision,
      }),
    ).rejects.toBeDefined();
    expect(manager.getSnapshot(session.sessionId).document.assets).toHaveLength(0);
    await expect(readFile(path.join(directory, 'blobs', hash))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps a failed asset journal append out of the document and collects its staged blob', async () => {
    const directory = await temporaryDirectory();
    const journal: JournalDurabilityCapability = {
      ...defaultJournalDurability,
      append: async () => Promise.reject(new Error('injected asset append failure')),
    };
    const manager = managerFor(directory, { journal, recoveryBlobGcMinAgeMs: 0 });
    const session = await manager.createMainOnly();
    const assetId = 'ffffffff-ffff-4fff-8fff-000000000025';
    const bytes = onePixelPng();
    const hash = sha256(bytes);
    await expect(
      manager.storeAssetAndExecute(session.sessionId, {
        id: assetId,
        bytes,
        mediaType: 'image/png',
        fileName: 'journal-failure.png',
        widthPx: 1,
        heightPx: 1,
        expectedRevision: session.revision,
        metadata: metadata(25),
        commands: [
          {
            type: 'element.insert',
            slideId: session.document.slides[0]!.id,
            element: {
              id: 'ffffffff-ffff-4fff-8fff-000000000026',
              type: 'image',
              name: 'Rejected journal image',
              frame: { xPt: 10, yPt: 10, widthPt: 100, heightPt: 100, rotationDeg: 0 },
              opacity: 1,
              visible: true,
              locked: false,
              assetId,
              altText: 'Rejected journal image',
              fit: 'contain',
              crop: { top: 0, right: 0, bottom: 0, left: 0 },
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'JOURNAL_FAILED' });
    expect(manager.getSnapshot(session.sessionId).document.assets).toHaveLength(0);
    expect(Array.from(await readFile(path.join(directory, 'blobs', hash)))).toEqual(
      Array.from(bytes),
    );
    expect((await manager.collectRecoveryGarbageMainOnly()).deleted).toBe(1);
    await expect(readFile(path.join(directory, 'blobs', hash))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('collects only unreferenced recovery blobs and removes an imported blob after close', async () => {
    const directory = await temporaryDirectory();
    const manager = managerFor(directory, { recoveryBlobGcMinAgeMs: 0 });
    const session = await manager.createMainOnly();
    const slideId = session.document.slides[0]!.id;
    const assetId = 'ffffffff-ffff-4fff-8fff-000000000031';
    const elementId = 'ffffffff-ffff-4fff-8fff-000000000032';
    const bytes = onePixelPng();
    const imported = await manager.storeAssetAndExecute(session.sessionId, {
      id: assetId,
      bytes,
      mediaType: 'image/png',
      fileName: 'collect.png',
      widthPx: 1,
      heightPx: 1,
      expectedRevision: session.revision,
      metadata: metadata(31),
      commands: [
        {
          type: 'element.insert',
          slideId,
          element: {
            id: elementId,
            type: 'image',
            name: 'Collected image',
            frame: { xPt: 10, yPt: 10, widthPt: 100, heightPt: 100, rotationDeg: 0 },
            opacity: 1,
            visible: true,
            locked: false,
            assetId,
            altText: 'Collected',
            fit: 'contain',
            crop: { top: 0, right: 0, bottom: 0, left: 0 },
          },
        },
      ],
    });
    const assetHash = imported.document.assets[0]!.hash;
    const removed = await manager.execute(session.sessionId, {
      expectedRevision: imported.revision,
      metadata: metadata(32),
      commands: [
        { type: 'element.delete', slideId, elementIds: [elementId] },
        { type: 'asset.remove', assetId },
      ],
    });
    const orphanBytes = Buffer.from('old orphan recovery blob', 'utf8');
    const orphanHash = sha256(orphanBytes);
    await writeFile(path.join(directory, 'blobs', orphanHash), orphanBytes);

    const swept = await manager.collectRecoveryGarbageMainOnly();
    expect(swept.deleted).toBe(1);
    await expect(readFile(path.join(directory, 'blobs', orphanHash))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(path.join(directory, 'blobs', assetHash))).toEqual(bytes);

    await manager.close(session.sessionId, { discardUnsaved: true });
    await expect(readFile(path.join(directory, 'blobs', assetHash))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(removed.document.assets).toHaveLength(0);
  });

  it('autosaves a bound target and flush observes the durable result', async () => {
    const directory = await temporaryDirectory();
    const target = path.join(directory, 'autosave.hdeck');
    const manager = managerFor(path.join(directory, 'recovery'), { autosaveDelayMs: 10 });
    const session = await manager.createMainOnly();
    const saved = await manager.saveAsMainOnly(session.sessionId, {
      targetPath: target,
      expectedFingerprint: null,
    });
    await manager.execute(session.sessionId, {
      expectedRevision: saved.revision,
      commands: [{ type: 'deck.rename', name: 'Autosaved' }],
      metadata: metadata(1),
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const flushed = await manager.flush(session.sessionId);
    expect(flushed.dirty).toBe(false);
    expect(parseHdeckArchive(await readFile(target)).document.name).toBe('Autosaved');
  });
});

describe('recovery and agent proposals', () => {
  it('hides zero-record persisted sessions but keeps a never-saved new deck recoverable', async () => {
    const directory = await temporaryDirectory();
    const manager = managerFor(directory);
    const persisted = await manager.createMainOnly();
    const target = path.join(directory, 'persisted.hdeck');
    await manager.saveAsMainOnly(persisted.sessionId, {
      targetPath: target,
      expectedFingerprint: null,
    });
    const neverSaved = await manager.createMainOnly();

    const afterCrash = managerFor(directory);
    const candidates = await afterCrash.listRecoveryCandidatesMainOnly();
    expect(candidates.map((candidate) => candidate.candidateId)).toEqual([neverSaved.sessionId]);
    expect(candidates[0]?.recordCount).toBe(0);
  });

  it('surfaces and replays the longest valid prefix of a truncated journal', async () => {
    const directory = await temporaryDirectory();
    const manager = managerFor(directory);
    const session = await manager.createMainOnly();
    const first = await manager.execute(session.sessionId, {
      expectedRevision: session.revision,
      commands: [{ type: 'deck.rename', name: 'Recovered prefix' }],
      metadata: metadata(1),
    });
    await manager.execute(session.sessionId, {
      expectedRevision: first.revision,
      commands: [{ type: 'deck.set-page', page: { widthPt: 720, heightPt: 540 } }],
      metadata: metadata(2),
    });
    const journalPath = path.join(directory, `${session.sessionId}.journal`);
    const size = (await readFile(journalPath)).byteLength;
    await truncate(journalPath, size - 8);

    const afterCrash = managerFor(directory);
    const candidates = await afterCrash.listRecoveryCandidatesMainOnly();
    expect(candidates).toEqual([
      expect.objectContaining({
        candidateId: session.sessionId,
        recordCount: 1,
        complete: false,
        stoppedReason: 'truncated',
      }),
    ]);
    const recovered = await afterCrash.recoverMainOnly(session.sessionId);
    expect(recovered.document.name).toBe('Recovered prefix');
    expect(recovered.document.page.widthPt).toBe(960);
    expect(recovered.durability).toBe('recovered');
    expect(replayJournal(await readFile(journalPath)).complete).toBe(true);
    const continued = await afterCrash.execute(recovered.sessionId, {
      expectedRevision: recovered.revision,
      commands: [{ type: 'deck.rename', name: 'Continued safely' }],
      metadata: metadata(3),
    });
    expect(continued.document.name).toBe('Continued safely');
    expect(replayJournal(await readFile(journalPath)).records).toHaveLength(2);
  });

  it('replays durable undo records after a crash', async () => {
    const directory = await temporaryDirectory();
    const manager = managerFor(directory);
    const session = await manager.createMainOnly();
    const changed = await manager.execute(session.sessionId, {
      expectedRevision: session.revision,
      commands: [{ type: 'deck.rename', name: 'Temporary edit' }],
      metadata: metadata(1),
    });
    const undone = await manager.undo(session.sessionId, {
      expectedRevision: changed.revision,
      metadata: metadata(2),
    });
    expect(undone.document.name).toBe('Untitled presentation');

    const afterCrash = managerFor(directory);
    const recovered = await afterCrash.recoverMainOnly(session.sessionId);
    expect(recovered.document.name).toBe('Untitled presentation');
    expect(recovered.revision).toBe(undone.revision);
  });

  it('expires proposals and rejects proposals whose base revision changed', async () => {
    const directory = await temporaryDirectory();
    let now = Date.parse('2026-07-15T12:00:00.000Z');
    const manager = managerFor(directory, { now: () => new Date(now).toISOString() });
    const session = await manager.createMainOnly();
    const expired = manager.propose(session.sessionId, {
      expectedRevision: session.revision,
      commands: [{ type: 'deck.rename', name: 'Never committed' }],
      metadata: metadata(1, 'agent'),
      ttlMs: 1_000,
    });
    now += 1_001;
    await expect(
      manager.commitProposal(session.sessionId, expired.proposalId),
    ).rejects.toMatchObject({
      code: 'PROPOSAL_EXPIRED',
    });

    const current = manager.getSnapshot(session.sessionId);
    const stale = manager.propose(session.sessionId, {
      expectedRevision: current.revision,
      commands: [{ type: 'deck.rename', name: 'Stale proposal' }],
      metadata: metadata(2, 'agent'),
    });
    await manager.execute(session.sessionId, {
      expectedRevision: current.revision,
      commands: [{ type: 'deck.rename', name: 'Human edit' }],
      metadata: metadata(3),
    });
    await expect(manager.commitProposal(session.sessionId, stale.proposalId)).rejects.toMatchObject(
      {
        code: 'PROPOSAL_STALE',
      },
    );
  });

  it('caps pending proposals and proactively frees expired capacity', async () => {
    const directory = await temporaryDirectory();
    let now = Date.parse('2026-07-15T12:00:00.000Z');
    const manager = managerFor(directory, { now: () => new Date(now).toISOString() });
    const session = await manager.createMainOnly();
    const request = {
      expectedRevision: session.revision,
      commands: [{ type: 'deck.rename' as const, name: 'Capacity proposal' }],
      metadata: metadata(40, 'agent'),
      ttlMs: 1_000,
    };
    for (let index = 0; index < 256; index += 1) manager.propose(session.sessionId, request);
    expect(() => manager.propose(session.sessionId, request)).toThrowError(
      /Pending proposal capacity/,
    );

    now += 1_001;
    expect(manager.propose(session.sessionId, request).proposalId).toBeDefined();
  });

  it('simulates safely, commits, audits, and undoes the latest agent transaction', async () => {
    const directory = await temporaryDirectory();
    const manager = managerFor(directory);
    const session = await manager.createMainOnly();
    const request = {
      expectedRevision: session.revision,
      commands: [{ type: 'deck.rename' as const, name: 'Agent content' }],
      metadata: metadata(1, 'agent'),
    };
    const diff = manager.simulate(session.sessionId, request);
    expect(diff).toMatchObject({ commandTypes: ['deck.rename'], changed: true });
    expect(JSON.stringify(diff)).not.toContain('Agent content');
    const proposal = manager.propose(session.sessionId, request);
    const committed = await manager.commitProposal(session.sessionId, proposal.proposalId);
    expect(committed.document.name).toBe('Agent content');
    expect(manager.getAgentAudit(session.sessionId)).toEqual([
      expect.objectContaining({ transactionId: request.metadata.transactionId }),
    ]);
    const undone = await manager.undoAgentTransaction(
      session.sessionId,
      request.metadata.transactionId,
      { expectedRevision: committed.revision, metadata: metadata(2) },
    );
    expect(undone.document.name).toBe('Untitled presentation');
    expect(manager.getAgentAudit(session.sessionId)[0]?.undoneAt).toBeDefined();
  });
});

describe('redacted events and permission-neutral reads', () => {
  it('never emits document text or filesystem paths', async () => {
    const directory = await temporaryDirectory();
    const secretPath = path.join(directory, 'top-secret-client.hdeck');
    const secretText = 'Highly confidential acquisition';
    const events: RuntimeEvent[] = [];
    const manager = managerFor(path.join(directory, 'recovery'));
    manager.subscribe((event) => events.push(event));
    const session = await manager.createMainOnly();
    const changed = await manager.execute(session.sessionId, {
      expectedRevision: session.revision,
      commands: [{ type: 'deck.rename', name: secretText }],
      metadata: metadata(1, 'user', secretText),
    });
    await manager.saveAsMainOnly(session.sessionId, {
      targetPath: secretPath,
      expectedFingerprint: null,
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(secretText);
    expect(serialized).not.toContain(secretPath);
    expect(serialized).not.toContain(path.basename(secretPath));
    expect(manager.outline(session.sessionId)).toHaveLength(changed.document.slides.length);
    expect(manager.slide(session.sessionId, changed.document.slides[0]!.id).id).toBe(
      changed.document.slides[0]!.id,
    );
    expect(manager.styles(session.sessionId)).toHaveLength(1);
    expect(manager.validate(session.sessionId)).toEqual({ valid: true, issues: [] });
  });
});
