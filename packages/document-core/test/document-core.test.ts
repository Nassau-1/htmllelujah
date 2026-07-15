import { describe, expect, it, vi } from 'vitest';

import {
  applyCommand,
  applyTransaction,
  canonicalSerialize,
  createNeutralDemoDeck,
  createRevisionToken,
  DocumentCommandError,
  DocumentValidationError,
  InMemoryDocumentAdapter,
  undoTransaction,
  validateDeck,
  type DeckDocument,
  type DocumentCommand,
  type Element,
  type ShapeElement,
  type Slide,
  type TransactionOptions,
} from '../src/index.js';

const metadata = (suffix = '1'): TransactionOptions => ({
  metadata: {
    transactionId: `90000000-0000-4000-8000-00000000000${suffix}`,
    actorId: 'test-user',
    origin: 'user',
    label: 'Test transaction',
    timestamp: '2026-07-15T12:00:00.000Z',
  },
});

const requireSlide = (document: DeckDocument, slideId: string): Slide => {
  const slide = document.slides.find((candidate) => candidate.id === slideId);
  if (slide === undefined) throw new Error(`Missing test slide ${slideId}.`);
  return slide;
};

const requireElement = (slide: Slide, elementId: string): Element => {
  const element = slide.elements.find((candidate) => candidate.id === elementId);
  if (element === undefined) throw new Error(`Missing test element ${elementId}.`);
  return element;
};

const shape = (
  id: string,
  xPt: number,
  yPt: number,
  widthPt = 80,
  heightPt = 50,
): ShapeElement => ({
  id,
  type: 'shape',
  name: `Shape ${id.slice(-1)}`,
  frame: { xPt, yPt, widthPt, heightPt, rotationDeg: 0 },
  opacity: 1,
  visible: true,
  locked: false,
  shape: 'rectangle',
  fill: '#EAF0FF',
  stroke: { color: '#2F6BFF', widthPt: 1, dash: 'solid' },
  cornerRadiusPt: 0,
});

describe('model, schema, and revisions', () => {
  it('creates a deterministic and structurally valid neutral demo deck', () => {
    const first = createNeutralDemoDeck();
    const second = createNeutralDemoDeck();

    expect(validateDeck(first)).toMatchObject({ success: true });
    expect(first.page).toEqual({ widthPt: 960, heightPt: 540 });
    expect(first.slides).toHaveLength(3);
    expect(createRevisionToken(first)).toBe(createRevisionToken(second));
  });

  it('canonicalizes object keys without changing meaningful array order', () => {
    expect(canonicalSerialize({ z: 1, a: { d: 2, b: 3 } })).toBe('{"a":{"b":3,"d":2},"z":1}');
    expect(canonicalSerialize({ values: [2, 1] })).not.toBe(canonicalSerialize({ values: [1, 2] }));
  });

  it('reports duplicate identifiers and broken references', () => {
    const source = createNeutralDemoDeck();
    const invalid: DeckDocument = {
      ...source,
      layouts: source.layouts.map((layout, index) =>
        index === 0 ? { ...layout, id: source.masters[0]?.id ?? layout.id } : layout,
      ),
      slides: source.slides.map((slide, index) =>
        index === 0 ? { ...slide, layoutId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' } : slide,
      ),
    };

    const result = validateDeck(invalid);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected validation to fail.');
    expect(result.issues.map((issue) => issue.code)).toContain('DUPLICATE_ID');
    expect(result.issues.map((issue) => issue.code)).toContain('REFERENCE_MISSING');
  });

  it('rejects incomplete tables', () => {
    const source = createNeutralDemoDeck();
    const contentSlide = source.slides[1];
    if (contentSlide === undefined) throw new Error('Missing content slide.');
    const invalidElements = contentSlide.elements.map((element) =>
      element.type === 'table' ? { ...element, cells: element.cells.slice(0, -1) } : element,
    );
    const invalid = {
      ...source,
      slides: source.slides.map((slide) =>
        slide.id === contentSlide.id ? { ...slide, elements: invalidElements } : slide,
      ),
    };

    const result = validateDeck(invalid);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected validation to fail.');
    expect(result.issues.some((issue) => issue.code === 'TABLE_CELL_MISSING')).toBe(true);
  });
});

describe('slide commands and transaction guarantees', () => {
  it('creates, reorders, and deletes slides without mutating the input', () => {
    const original = createNeutralDemoDeck();
    const originalJson = JSON.stringify(original);
    const newSlide: Slide = {
      id: '30000000-0000-4000-8000-000000000001',
      name: 'Inserted',
      layoutId: original.layouts[0]?.id ?? '',
      hidden: false,
      elements: [],
    };
    const commands: readonly DocumentCommand[] = [
      { type: 'slide.create', slide: newSlide, index: 1 },
      { type: 'slide.reorder', slideId: newSlide.id, toIndex: 3 },
      { type: 'slide.delete', slideId: original.slides[0]?.id ?? '' },
    ];

    const result = applyTransaction(original, commands, metadata());
    expect(result.document.slides.map((slide) => slide.id)).toEqual([
      original.slides[1]?.id,
      original.slides[2]?.id,
      newSlide.id,
    ]);
    expect(JSON.stringify(original)).toBe(originalJson);
    expect(result.previousRevision).toBe(createRevisionToken(original));
    expect(result.revision).not.toBe(result.previousRevision);
  });

  it('rolls back the whole batch when its final document is invalid', () => {
    const original = createNeutralDemoDeck();
    const duplicate: Slide = {
      id: original.slides[0]?.id ?? '',
      name: 'Duplicate',
      layoutId: original.layouts[0]?.id ?? '',
      hidden: false,
      elements: [],
    };

    expect(() =>
      applyTransaction(original, [{ type: 'slide.create', slide: duplicate }], metadata()),
    ).toThrow(DocumentValidationError);
    expect(validateDeck(original)).toMatchObject({ success: true });
  });

  it('rejects stale expected revisions', () => {
    const original = createNeutralDemoDeck();
    const options: TransactionOptions = {
      ...metadata(),
      expectedRevision: 'rev1-stale',
    };
    expect(() =>
      applyCommand(
        original,
        { type: 'slide.delete', slideId: original.slides[0]?.id ?? '' },
        options,
      ),
    ).toThrowError(expect.objectContaining({ code: 'REVISION_CONFLICT' }));
  });

  it('restores the exact pre-transaction snapshot and blocks stale undo', () => {
    const original = createNeutralDemoDeck();
    const transaction = applyCommand(
      original,
      { type: 'slide.delete', slideId: original.slides[0]?.id ?? '' },
      metadata(),
    );

    expect(undoTransaction(transaction.document, transaction)).toEqual(original);
    expect(() => undoTransaction(original, transaction)).toThrow(DocumentCommandError);
  });
});

describe('element commands', () => {
  it('inserts, replaces, transforms, and deletes elements atomically', () => {
    const original = createNeutralDemoDeck();
    const slideId = original.slides[2]?.id ?? '';
    const inserted = shape('30000000-0000-4000-8000-000000000010', 100, 120);
    const replacement = { ...inserted, name: 'Updated shape', fill: '#FFFFFF' };
    const result = applyTransaction(
      original,
      [
        { type: 'element.insert', slideId, element: inserted },
        {
          type: 'element.update',
          slideId,
          elementId: inserted.id,
          replacement,
        },
        {
          type: 'element.transform',
          slideId,
          transforms: [
            {
              elementId: inserted.id,
              frame: { xPt: 200, yPt: 180, widthPt: 160, heightPt: 90, rotationDeg: 15 },
            },
          ],
        },
      ],
      metadata(),
    );
    const transformed = requireElement(requireSlide(result.document, slideId), inserted.id);
    expect(transformed.name).toBe('Updated shape');
    expect(transformed.frame).toEqual({
      xPt: 200,
      yPt: 180,
      widthPt: 160,
      heightPt: 90,
      rotationDeg: 15,
    });

    const deleted = applyCommand(
      result.document,
      { type: 'element.delete', slideId, elementIds: [inserted.id] },
      metadata('2'),
    );
    expect(requireSlide(deleted.document, slideId).elements).not.toContainEqual(
      expect.objectContaining({ id: inserted.id }),
    );
  });

  it('honors locked elements', () => {
    const source = createNeutralDemoDeck();
    const slide = source.slides[0];
    const firstElement = slide?.elements[0];
    if (slide === undefined || firstElement === undefined) throw new Error('Missing fixture.');
    const locked: DeckDocument = {
      ...source,
      slides: source.slides.map((candidate) =>
        candidate.id === slide.id
          ? {
              ...candidate,
              elements: candidate.elements.map((element) =>
                element.id === firstElement.id ? { ...element, locked: true } : element,
              ),
            }
          : candidate,
      ),
    };

    expect(() =>
      applyCommand(
        locked,
        { type: 'element.delete', slideId: slide.id, elementIds: [firstElement.id] },
        metadata(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'LOCKED' }));
  });
});

describe('alignment, distribution, and grouping invariants', () => {
  const withGeometrySlide = (): { document: DeckDocument; slideId: string; ids: string[] } => {
    const source = createNeutralDemoDeck();
    const slideId = source.slides[2]?.id ?? '';
    const shapes = [
      shape('40000000-0000-4000-8000-000000000001', 100, 100, 40, 50),
      shape('40000000-0000-4000-8000-000000000002', 320, 180, 80, 70),
      shape('40000000-0000-4000-8000-000000000003', 700, 260, 60, 90),
    ];
    const transaction = applyTransaction(
      source,
      shapes.map((element) => ({ type: 'element.insert', slideId, element })),
      metadata(),
    );
    return { document: transaction.document, slideId, ids: shapes.map(({ id }) => id) };
  };

  it.each([
    ['left', (element: Element) => element.frame.xPt],
    ['horizontal-center', (element: Element) => element.frame.xPt + element.frame.widthPt / 2],
    ['right', (element: Element) => element.frame.xPt + element.frame.widthPt],
    ['top', (element: Element) => element.frame.yPt],
    ['vertical-middle', (element: Element) => element.frame.yPt + element.frame.heightPt / 2],
    ['bottom', (element: Element) => element.frame.yPt + element.frame.heightPt],
  ] as const)('aligns every selected frame on %s', (mode, measure) => {
    const fixture = withGeometrySlide();
    const result = applyCommand(
      fixture.document,
      {
        type: 'element.align',
        slideId: fixture.slideId,
        elementIds: fixture.ids,
        mode,
        relativeTo: 'selection',
      },
      metadata('2'),
    );
    const slide = requireSlide(result.document, fixture.slideId);
    const values = fixture.ids.map((id) => measure(requireElement(slide, id)));
    expect(new Set(values).size).toBe(1);
  });

  it('distributes mixed-width elements with equal horizontal gaps', () => {
    const fixture = withGeometrySlide();
    const result = applyCommand(
      fixture.document,
      {
        type: 'element.distribute',
        slideId: fixture.slideId,
        elementIds: fixture.ids,
        axis: 'horizontal',
        relativeTo: 'selection',
      },
      metadata('2'),
    );
    const elements = fixture.ids
      .map((id) => requireElement(requireSlide(result.document, fixture.slideId), id))
      .sort((left, right) => left.frame.xPt - right.frame.xPt);
    const first = elements[0];
    const second = elements[1];
    const third = elements[2];
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('Missing distributed elements.');
    }
    const firstGap = second.frame.xPt - (first.frame.xPt + first.frame.widthPt);
    const secondGap = third.frame.xPt - (second.frame.xPt + second.frame.widthPt);
    expect(firstGap).toBeCloseTo(secondGap, 10);
  });

  it('groups in stacking order and ungrouping restores child geometry', () => {
    const fixture = withGeometrySlide();
    const groupId = '40000000-0000-4000-8000-000000000010';
    const before = fixture.ids.map(
      (id) => requireElement(requireSlide(fixture.document, fixture.slideId), id).frame,
    );
    const grouped = applyCommand(
      fixture.document,
      {
        type: 'element.group',
        slideId: fixture.slideId,
        elementIds: fixture.ids,
        groupId,
        name: 'Geometry group',
      },
      metadata('2'),
    );
    const group = requireElement(requireSlide(grouped.document, fixture.slideId), groupId);
    expect(group.type).toBe('group');
    if (group.type !== 'group') throw new Error('Expected a group.');
    expect(group.children.map(({ id }) => id)).toEqual(fixture.ids);

    const ungrouped = applyCommand(
      grouped.document,
      { type: 'element.ungroup', slideId: fixture.slideId, groupId },
      metadata('3'),
    );
    const after = fixture.ids.map(
      (id) => requireElement(requireSlide(ungrouped.document, fixture.slideId), id).frame,
    );
    expect(after).toEqual(before);
  });
});

describe('adapter boundary', () => {
  it('publishes isolated snapshots after a committed transaction', () => {
    const adapter = new InMemoryDocumentAdapter(createNeutralDemoDeck());
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    const before = adapter.getSnapshot();
    const result = adapter.transact(
      [{ type: 'slide.delete', slideId: before.document.slides[0]?.id ?? '' }],
      { ...metadata(), expectedRevision: before.revision },
    );

    expect(listener).toHaveBeenCalledOnce();
    expect(adapter.getSnapshot().revision).toBe(result.revision);
    unsubscribe();
  });
});
