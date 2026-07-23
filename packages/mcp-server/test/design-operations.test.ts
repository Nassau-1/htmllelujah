import {
  applyTransaction,
  createDefaultDeck,
  createRevisionToken,
  undoTransaction,
  validateDeck,
  type DeckDocument,
  type Element,
} from '@htmllelujah/document-core';
import { describe, expect, it } from 'vitest';

import {
  commandsRequireApproval,
  designOperationSchema,
  designOperationsToCommands,
} from '../src/index.js';

const metadata = {
  transactionId: '10000000-0000-4000-8000-000000000001',
  actorId: 'mcp-client:10000000-0000-4000-8000-000000000002',
  origin: 'agent' as const,
  label: 'Test typed design operations',
  timestamp: '2026-07-23T12:00:00.000Z',
};

describe('typed design operations', () => {
  it('patches a theme without replacing its identity or unspecified semantic tokens', () => {
    const deck = createDefaultDeck();
    const theme = deck.themes[0];
    if (theme === undefined) throw new Error('Missing default theme.');
    const commands = designOperationsToCommands(deck, [
      {
        type: 'theme.update',
        themeId: theme.id,
        patch: { name: 'Agent theme', colors: { accent: '#123456' } },
      },
    ]);
    const updated = applyTransaction(deck, commands, {
      expectedRevision: createRevisionToken(deck),
      metadata,
    }).document;

    expect(commands).toHaveLength(1);
    expect(updated.themes[0]).toMatchObject({
      id: theme.id,
      name: 'Agent theme',
      colors: {
        accent: '#123456',
        background: theme.colors.background,
        surface: theme.colors.surface,
        text: theme.colors.text,
        mutedText: theme.colors.mutedText,
      },
    });
    expect(commandsRequireApproval(commands, { before: deck, after: updated })).toBe(false);
  });

  it('keeps effect-aware approval for page changes and structural removals', () => {
    const deck = createDefaultDeck();
    const layout = deck.layouts[0];
    if (layout === undefined) throw new Error('Missing default layout.');

    const pageCommands = designOperationsToCommands(deck, [
      { type: 'page.set', page: { widthPt: 900, heightPt: 600 } },
    ]);
    const pageUpdated = applyTransaction(deck, pageCommands, {
      expectedRevision: createRevisionToken(deck),
      metadata,
    }).document;
    expect(commandsRequireApproval(pageCommands, { before: deck, after: pageUpdated })).toBe(true);

    const removalCommands = designOperationsToCommands(deck, [
      { type: 'layout.update', layoutId: layout.id, patch: { elements: [] } },
    ]);
    const removed = applyTransaction(deck, removalCommands, {
      expectedRevision: createRevisionToken(deck),
      metadata,
    }).document;
    expect(commandsRequireApproval(removalCommands, { before: deck, after: removed })).toBe(true);
  });

  it('resolves sequential semantic operations against each validated intermediate state', () => {
    const deck = createDefaultDeck();
    const theme = deck.themes[0];
    const master = deck.masters[0];
    if (theme === undefined || master === undefined) throw new Error('Missing default design.');
    const commands = designOperationsToCommands(deck, [
      {
        type: 'theme.update',
        themeId: theme.id,
        patch: { headingFontFamily: 'Aptos Display', bodyFontFamily: 'Aptos' },
      },
      { type: 'theme.enforce-deck', themeId: theme.id },
      {
        type: 'master.update',
        masterId: master.id,
        patch: { name: 'Authoritative master' },
      },
    ]);
    const updated = applyTransaction(deck, commands, {
      expectedRevision: createRevisionToken(deck),
      metadata,
    }).document;

    expect(updated.themes[0]).toMatchObject({
      headingFontFamily: 'Aptos Display',
      bodyFontFamily: 'Aptos',
    });
    expect(updated.masters[0]).toMatchObject({
      name: 'Authoritative master',
      themeId: theme.id,
    });
  });

  it('plans deck-wide enforcement as one ordinary reversible command beyond 100 objects', () => {
    const source = createDefaultDeck();
    const theme = source.themes[0];
    const slide = source.slides[0];
    if (theme === undefined || slide === undefined) throw new Error('Missing default design.');
    const styledObjects = Array.from({ length: 125 }, (_, index): Element => ({
      id: `f3000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
      type: 'shape',
      name: `MCP styled object ${index + 1}`,
      frame: {
        xPt: (index % 10) * 20,
        yPt: Math.floor(index / 10) * 20,
        widthPt: 18,
        heightPt: 18,
        rotationDeg: 0,
      },
      opacity: 1,
      visible: true,
      locked: false,
      shape: 'rectangle',
      fill: '#AABBCC',
      stroke: { color: '#DDEEFF', widthPt: 1, dash: 'solid' },
      cornerRadiusPt: 0,
    }));
    const deck: DeckDocument = {
      ...source,
      slides: source.slides.map((candidate) =>
        candidate.id === slide.id
          ? { ...candidate, elements: [...candidate.elements, ...styledObjects] }
          : candidate,
      ),
    };

    const commands = designOperationsToCommands(deck, [
      { type: 'theme.enforce-deck', themeId: theme.id },
    ]);
    expect(commands).toEqual([{ type: 'theme.enforce-deck', themeId: theme.id }]);

    const transaction = applyTransaction(deck, commands, {
      expectedRevision: createRevisionToken(deck),
      metadata,
    });
    expect(validateDeck(transaction.document)).toMatchObject({ success: true });
    expect(commandsRequireApproval(commands, { before: deck, after: transaction.document })).toBe(
      false,
    );
    expect(transaction.document.themes.map((item) => item.id)).toEqual(
      deck.themes.map((item) => item.id),
    );
    expect(transaction.document.masters.map((item) => item.id)).toEqual(
      deck.masters.map((item) => item.id),
    );
    expect(transaction.document.layouts.map((item) => item.id)).toEqual(
      deck.layouts.map((item) => item.id),
    );
    expect(transaction.document.slides.map((item) => item.id)).toEqual(
      deck.slides.map((item) => item.id),
    );
    expect(transaction.document.assets.map((item) => item.id)).toEqual(
      deck.assets.map((item) => item.id),
    );
    expect(transaction.document.slides[0]!.elements.map((item) => item.id)).toEqual(
      deck.slides[0]!.elements.map((item) => item.id),
    );
    expect(undoTransaction(transaction.document, transaction)).toEqual(deck);
    expect(
      transaction.document.slides[0]!.elements.filter((element) =>
        element.id.startsWith('f3000000-'),
      ).every(
        (element) =>
          element.type === 'shape' &&
          element.fill === theme.colors.surface &&
          element.stroke.color === theme.colors.accent,
      ),
    ).toBe(true);
    expect(() =>
      designOperationsToCommands(deck, [
        {
          type: 'theme.enforce-deck',
          themeId: 'f4000000-0000-4000-8000-000000000001',
        },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('rejects arbitrary markup and unknown design-operation fields at the strict schema boundary', () => {
    expect(
      designOperationSchema.safeParse({
        type: 'theme.update',
        themeId: '10000000-0000-4000-8000-000000000001',
        patch: { name: 'Safe' },
        html: '<script>alert(1)</script>',
      }).success,
    ).toBe(false);
    expect(
      designOperationSchema.safeParse({
        type: 'page.set',
        page: { widthPt: 900, heightPt: 600, url: 'https://example.invalid' },
      }).success,
    ).toBe(false);
  });
});
