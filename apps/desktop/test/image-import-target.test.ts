import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createNeutralDemoDeck,
  type DeckDocument,
  type ImageElement,
  type TransactionMetadata,
} from '@htmllelujah/document-core';
import { DocumentSessionManager } from '@htmllelujah/document-runtime';
import { replayJournal } from '@htmllelujah/hdeck';
import { afterEach, describe, expect, it } from 'vitest';

import {
  imageImportPresetSchema,
  imageImportTargetSchema,
  ImageImportMutationError,
  prepareImageImportMutation,
} from '../src/main/image-import-target.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-image-target-'));
  directories.push(directory);
  return directory;
};

const metadata = (value: number, label: string): TransactionMetadata => ({
  transactionId: `a0000000-0000-4000-8000-${String(value).padStart(12, '0')}`,
  actorId: 'desktop-user',
  origin: 'user',
  label,
  timestamp: `2026-07-23T18:${String(value).padStart(2, '0')}:00.000Z`,
});

const onePixelPng = (): Uint8Array =>
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );

const image = (id: string, assetId: string, locked = false): ImageElement => ({
  id,
  type: 'image',
  name: 'Existing image',
  frame: { xPt: 24, yPt: 36, widthPt: 160, heightPt: 90, rotationDeg: 0 },
  opacity: 0.8,
  visible: true,
  locked,
  assetId,
  altText: 'Existing image',
  fit: 'contain',
  crop: { top: 0.1, right: 0, bottom: 0, left: 0 },
});

const ids = {
  asset: 'b0000000-0000-4000-8000-000000000001',
  element: 'b0000000-0000-4000-8000-000000000002',
  replacementAsset: 'b0000000-0000-4000-8000-000000000003',
  nestedGroup: 'b0000000-0000-4000-8000-000000000004',
  nestedImage: 'b0000000-0000-4000-8000-000000000005',
  missing: 'b0000000-0000-4000-8000-000000000006',
} as const;

describe('typed image-import targets', () => {
  it('accepts only strict, discriminated slide/layout/master targets', () => {
    const deck = createNeutralDemoDeck();
    expect(
      imageImportTargetSchema.parse({ surface: 'slide', slideId: deck.slides[0]!.id }),
    ).toEqual({ surface: 'slide', slideId: deck.slides[0]!.id });
    expect(
      imageImportTargetSchema.parse({ surface: 'layout', layoutId: deck.layouts[0]!.id }),
    ).toEqual({ surface: 'layout', layoutId: deck.layouts[0]!.id });
    expect(
      imageImportTargetSchema.parse({ surface: 'master', masterId: deck.masters[0]!.id }),
    ).toEqual({ surface: 'master', masterId: deck.masters[0]!.id });

    expect(imageImportTargetSchema.safeParse({ slideId: deck.slides[0]!.id }).success).toBe(false);
    expect(
      imageImportTargetSchema.safeParse({
        surface: 'layout',
        layoutId: deck.layouts[0]!.id,
        slideId: deck.slides[0]!.id,
      }).success,
    ).toBe(false);
    expect(
      imageImportTargetSchema.safeParse({
        surface: 'master',
        masterId: 'C:\\private\\deck.hdeck',
      }).success,
    ).toBe(false);
    expect(imageImportPresetSchema.parse('watermark')).toBe('watermark');
    expect(imageImportPresetSchema.safeParse('background').success).toBe(false);
  });

  it('builds one surface-specific typed insertion without mutating the source deck', () => {
    const deck = createNeutralDemoDeck();
    const before = structuredClone(deck);
    const targets = [
      { surface: 'slide' as const, slideId: deck.slides[0]!.id },
      { surface: 'layout' as const, layoutId: deck.layouts[0]!.id },
      { surface: 'master' as const, masterId: deck.masters[0]!.id },
    ];

    expect(
      targets.map((target) =>
        prepareImageImportMutation({
          document: deck,
          target,
          assetId: ids.asset,
          widthPx: 1_600,
          heightPx: 900,
          createElementId: () => ids.element,
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        element: expect.objectContaining({ id: ids.element, assetId: ids.asset }),
        commands: [expect.objectContaining({ type: 'element.insert' })],
      }),
      expect.objectContaining({
        element: expect.objectContaining({ id: ids.element, assetId: ids.asset }),
        commands: [expect.objectContaining({ type: 'layout.update' })],
      }),
      expect.objectContaining({
        element: expect.objectContaining({ id: ids.element, assetId: ids.asset }),
        commands: [expect.objectContaining({ type: 'master.update' })],
      }),
    ]);
    expect(deck).toEqual(before);
  });

  it('replaces nested images, retains their identity and styling, and targets the slide group', () => {
    const deck = createNeutralDemoDeck();
    const nested = image(ids.nestedImage, ids.asset);
    const document: DeckDocument = {
      ...deck,
      slides: deck.slides.map((slide, index) =>
        index === 0
          ? {
              ...slide,
              elements: [
                ...slide.elements,
                {
                  id: ids.nestedGroup,
                  type: 'group',
                  name: 'Image group',
                  frame: { xPt: 0, yPt: 0, widthPt: 300, heightPt: 200, rotationDeg: 0 },
                  opacity: 1,
                  visible: true,
                  locked: false,
                  coordinateSpace: { widthPt: 300, heightPt: 200 },
                  children: [nested],
                },
              ],
            }
          : slide,
      ),
    };

    const prepared = prepareImageImportMutation({
      document,
      target: { surface: 'slide', slideId: document.slides[0]!.id },
      assetId: ids.replacementAsset,
      widthPx: 2,
      heightPx: 2,
      replaceElementId: nested.id,
      createElementId: () => {
        throw new Error('Replacement must not allocate an element ID.');
      },
    });

    expect(prepared.element).toEqual({ ...nested, assetId: ids.replacementAsset });
    expect(prepared.commands).toEqual([
      {
        type: 'element.update',
        slideId: document.slides[0]!.id,
        containerId: ids.nestedGroup,
        elementId: nested.id,
        replacement: { ...nested, assetId: ids.replacementAsset },
      },
    ]);
  });

  it('fails closed for missing destinations, non-images, and locked image trees', () => {
    const deck = createNeutralDemoDeck();
    const prepare = (document: DeckDocument, replaceElementId: string) =>
      prepareImageImportMutation({
        document,
        target: { surface: 'layout', layoutId: document.layouts[0]!.id },
        assetId: ids.replacementAsset,
        widthPx: 1,
        heightPx: 1,
        replaceElementId,
        createElementId: () => ids.element,
      });

    expect(() =>
      prepareImageImportMutation({
        document: deck,
        target: { surface: 'master', masterId: ids.missing },
        assetId: ids.asset,
        widthPx: 1,
        heightPx: 1,
        createElementId: () => ids.element,
      }),
    ).toThrowError(expect.objectContaining<ImageImportMutationError>({ code: 'TARGET_NOT_FOUND' }));
    expect(() => prepare(deck, deck.layouts[0]!.elements[0]!.id)).toThrowError(
      expect.objectContaining<ImageImportMutationError>({ code: 'IMAGE_NOT_FOUND' }),
    );

    const lockedImage = image(ids.nestedImage, ids.asset, true);
    const lockedDocument: DeckDocument = {
      ...deck,
      layouts: deck.layouts.map((layout, index) =>
        index === 0 ? { ...layout, elements: [...layout.elements, lockedImage] } : layout,
      ),
    };
    expect(() => prepare(lockedDocument, lockedImage.id)).toThrowError(
      expect.objectContaining<ImageImportMutationError>({ code: 'IMAGE_LOCKED' }),
    );
  });

  it('builds a deterministic locked watermark only for new master images', () => {
    const deck = createNeutralDemoDeck();
    const master = deck.masters[0]!;
    const prepared = prepareImageImportMutation({
      document: deck,
      target: { surface: 'master', masterId: master.id },
      assetId: ids.asset,
      widthPx: 2_000,
      heightPx: 400,
      preset: 'watermark',
      createElementId: () => ids.element,
    });

    expect(prepared.element).toEqual({
      id: ids.element,
      type: 'image',
      name: 'Image watermark',
      frame: {
        xPt: deck.page.widthPt * 0.15,
        yPt: deck.page.heightPt * 0.15,
        widthPt: deck.page.widthPt * 0.7,
        heightPt: deck.page.heightPt * 0.7,
        rotationDeg: 0,
      },
      opacity: 0.16,
      visible: true,
      locked: true,
      assetId: ids.asset,
      altText: 'Watermark image',
      fit: 'contain',
      crop: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    expect(prepared.commands).toEqual([
      {
        type: 'master.update',
        masterId: master.id,
        replacement: { ...master, elements: [...master.elements, prepared.element] },
      },
    ]);

    expect(() =>
      prepareImageImportMutation({
        document: deck,
        target: { surface: 'slide', slideId: deck.slides[0]!.id },
        assetId: ids.asset,
        widthPx: 1,
        heightPx: 1,
        preset: 'watermark',
        createElementId: () => ids.element,
      }),
    ).toThrowError(expect.objectContaining<ImageImportMutationError>({ code: 'INVALID_PRESET' }));
    expect(() =>
      prepareImageImportMutation({
        document: deck,
        target: { surface: 'master', masterId: master.id },
        assetId: ids.asset,
        widthPx: 1,
        heightPx: 1,
        replaceElementId: ids.missing,
        preset: 'watermark',
        createElementId: () => ids.element,
      }),
    ).toThrowError(expect.objectContaining<ImageImportMutationError>({ code: 'INVALID_PRESET' }));
  });

  it('commits a watermark asset and styled master element in one transaction', async () => {
    const directory = await temporaryDirectory();
    const manager = new DocumentSessionManager({
      recoveryDirectory: directory,
      autosaveDelayMs: 0,
    });
    const session = await manager.createMainOnly();
    const master = session.document.masters[0]!;
    const prepared = prepareImageImportMutation({
      document: session.document,
      target: { surface: 'master', masterId: master.id },
      assetId: ids.asset,
      widthPx: 1,
      heightPx: 1,
      preset: 'watermark',
      createElementId: () => ids.element,
    });
    const imported = await manager.importAssetAndExecute(session.sessionId, {
      id: ids.asset,
      bytes: onePixelPng(),
      mediaType: 'image/png',
      fileName: 'watermark.png',
      widthPx: 1,
      heightPx: 1,
      expectedRevision: session.revision,
      metadata: metadata(4, 'Import image watermark'),
      commands: prepared.commands,
    });

    expect(imported.snapshot.document.assets).toEqual([
      expect.objectContaining({ id: ids.asset, mediaType: 'image/png' }),
    ]);
    expect(
      imported.snapshot.document.masters[0]!.elements.find((element) => element.id === ids.element),
    ).toMatchObject({
      type: 'image',
      assetId: ids.asset,
      name: 'Image watermark',
      opacity: 0.16,
      locked: true,
      fit: 'contain',
    });

    const journal = replayJournal(
      await readFile(path.join(directory, `${session.sessionId}.journal`)),
    );
    expect(journal.records).toHaveLength(1);
    expect(journal.records[0]).toMatchObject({
      metadata: { label: 'Import image watermark' },
      commands: [{ type: 'asset.register' }, { type: 'master.update' }],
    });

    const undone = await manager.undo(session.sessionId, {
      expectedRevision: imported.snapshot.revision,
      metadata: metadata(5, 'Undo image watermark import'),
    });
    expect(undone.document.assets).toEqual([]);
    expect(undone.document.masters[0]!.elements).toEqual(master.elements);
  });

  it('commits asset and template insertion at one audited undo boundary', async () => {
    const directory = await temporaryDirectory();
    const manager = new DocumentSessionManager({
      recoveryDirectory: directory,
      autosaveDelayMs: 0,
    });
    const session = await manager.createMainOnly();
    const layout = session.document.layouts[0]!;
    const prepared = prepareImageImportMutation({
      document: session.document,
      target: { surface: 'layout', layoutId: layout.id },
      assetId: ids.asset,
      widthPx: 1,
      heightPx: 1,
      createElementId: () => ids.element,
    });
    const imported = await manager.importAssetAndExecute(session.sessionId, {
      id: ids.asset,
      bytes: onePixelPng(),
      mediaType: 'image/png',
      fileName: 'local.png',
      widthPx: 1,
      heightPx: 1,
      expectedRevision: session.revision,
      metadata: metadata(1, 'Import image into layout'),
      commands: prepared.commands,
    });

    expect(imported.snapshot.document.assets).toEqual([
      expect.objectContaining({ id: ids.asset, mediaType: 'image/png' }),
    ]);
    expect(
      imported.snapshot.document.layouts[0]!.elements.find((element) => element.id === ids.element),
    ).toMatchObject({ type: 'image', assetId: ids.asset });
    expect(imported.snapshot.canUndo).toBe(true);

    const journal = replayJournal(
      await readFile(path.join(directory, `${session.sessionId}.journal`)),
    );
    expect(journal.records).toHaveLength(1);
    expect(journal.records[0]).toMatchObject({
      metadata: {
        actorId: 'desktop-user',
        origin: 'user',
        label: 'Import image into layout',
      },
      commands: [{ type: 'asset.register' }, { type: 'layout.update' }],
    });

    const undone = await manager.undo(session.sessionId, {
      expectedRevision: imported.snapshot.revision,
      metadata: metadata(2, 'Undo image import'),
    });
    expect(undone.document.assets).toEqual([]);
    expect(undone.document.layouts[0]!.elements).toEqual(layout.elements);
  });

  it('rolls back both asset and master command on a stale revision', async () => {
    const directory = await temporaryDirectory();
    const manager = new DocumentSessionManager({
      recoveryDirectory: directory,
      autosaveDelayMs: 0,
    });
    const session = await manager.createMainOnly();
    const master = session.document.masters[0]!;
    const prepared = prepareImageImportMutation({
      document: session.document,
      target: { surface: 'master', masterId: master.id },
      assetId: ids.asset,
      widthPx: 1,
      heightPx: 1,
      createElementId: () => ids.element,
    });

    await expect(
      manager.importAssetAndExecute(session.sessionId, {
        id: ids.asset,
        bytes: onePixelPng(),
        mediaType: 'image/png',
        fileName: 'local.png',
        widthPx: 1,
        heightPx: 1,
        expectedRevision: 'stale-revision',
        metadata: metadata(3, 'Rejected master image import'),
        commands: prepared.commands,
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });

    const current = manager.getSnapshot(session.sessionId);
    expect(current.revision).toBe(session.revision);
    expect(current.document.assets).toEqual([]);
    expect(current.document.masters[0]!.elements).toEqual(master.elements);
    expect(current.canUndo).toBe(false);
  });
});
