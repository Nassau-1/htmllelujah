import { describe, expect, it } from 'vitest';

import {
  applyTransaction,
  canonicalizeLanguageTag,
  createDefaultDeck,
  createDuplicateSlide,
  deckDocumentSchema,
  documentCommandSchema,
  migrateDeckV1ToV2,
  type DeckDocumentV1,
} from '../src/index.js';

let idSequence = 1;
const testId = (): string => `b0000000-0000-4000-8000-${String(idSequence++).padStart(12, '0')}`;

const metadata = () => ({
  transactionId: testId(),
  actorId: 'language-test',
  origin: 'user' as const,
  label: 'Set language',
  timestamp: new Date().toISOString(),
});

describe('canonical document languages', () => {
  it('canonicalizes valid BCP-47 tags and rejects invalid input', () => {
    expect(canonicalizeLanguageTag(' fr-fr ')).toBe('fr-FR');
    expect(canonicalizeLanguageTag('zh-hant-tw')).toBe('zh-Hant-TW');
    expect(() => canonicalizeLanguageTag('not_a_locale')).toThrow(TypeError);
  });

  it('canonicalizes default and migrated deck locales', () => {
    const current = createDefaultDeck({ locale: 'fr-fr' });
    expect(current.metadata.locale).toBe('fr-FR');

    const { metadata: _metadata, settings: _settings, ...legacyBase } = current;
    const legacy: DeckDocumentV1 = { ...legacyBase, schemaVersion: 1 };
    expect(migrateDeckV1ToV2(legacy, { locale: 'en-gb' }).metadata.locale).toBe('en-GB');
  });

  it('parses optional text overrides without introducing them into old text elements', () => {
    const deck = createDefaultDeck();
    const text = deck.slides[0]!.elements.find((element) => element.type === 'text')!;
    expect(text.type).toBe('text');
    const parsed = deckDocumentSchema.parse({
      ...deck,
      metadata: { ...deck.metadata, locale: 'fr-fr' },
      slides: [
        {
          ...deck.slides[0]!,
          elements: deck.slides[0]!.elements.map((element) =>
            element.id === text.id ? { ...element, locale: 'en-gb' } : element,
          ),
        },
      ],
    });
    const parsedText = parsed.slides[0]!.elements.find((element) => element.id === text.id)!;
    expect(parsed.metadata.locale).toBe('fr-FR');
    expect(parsedText.type === 'text' ? parsedText.locale : undefined).toBe('en-GB');
    expect(deckDocumentSchema.parse(deck).slides[0]!.elements[0]).not.toHaveProperty('locale');
  });

  it('updates deck and text locales through bounded undoable typed commands', () => {
    const deck = createDefaultDeck();
    const slide = deck.slides[0]!;
    const text = slide.elements.find((element) => element.type === 'text')!;
    const updated = applyTransaction(
      deck,
      [
        { type: 'deck.set-locale', locale: 'fr-fr' },
        { type: 'text.set-locale', slideId: slide.id, textId: text.id, locale: 'en-gb' },
      ],
      { metadata: metadata() },
    );
    const updatedText = updated.document.slides[0]!.elements.find(
      (element) => element.id === text.id,
    )!;
    expect(updated.document.metadata.locale).toBe('fr-FR');
    expect(updatedText.type === 'text' ? updatedText.locale : undefined).toBe('en-GB');

    const inherited = applyTransaction(
      updated.document,
      [{ type: 'text.set-locale', slideId: slide.id, textId: text.id, locale: null }],
      { metadata: metadata() },
    );
    expect(
      inherited.document.slides[0]!.elements.find((element) => element.id === text.id),
    ).not.toHaveProperty('locale');
    expect(
      documentCommandSchema.safeParse({ type: 'deck.set-locale', locale: 'bad_tag' }).success,
    ).toBe(false);
  });

  it('preserves a text override when cloning a slide', () => {
    const deck = createDefaultDeck();
    const slide = deck.slides[0]!;
    const text = slide.elements.find((element) => element.type === 'text')!;
    const source = deckDocumentSchema.parse({
      ...deck,
      slides: [
        {
          ...slide,
          elements: slide.elements.map((element) =>
            element.id === text.id ? { ...element, locale: 'de-DE' } : element,
          ),
        },
      ],
    });
    const duplicate = createDuplicateSlide(source, slide.id, testId);
    const clonedText = duplicate.elements.find((element) => element.type === 'text');
    expect(clonedText?.type === 'text' ? clonedText.locale : undefined).toBe('de-DE');
  });
});
