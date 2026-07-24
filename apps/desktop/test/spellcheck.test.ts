import { describe, expect, it } from 'vitest';

import {
  editableContextMenuItems,
  normalizeSpellcheckLanguageRequest,
  resolveSupportedSpellcheckLanguages,
  SPELLCHECK_LIMITS,
} from '../src/main/spellcheck.js';

describe('desktop spellchecker policy', () => {
  it('canonicalizes a small unique language request and rejects unbounded input', () => {
    expect(normalizeSpellcheckLanguageRequest(['fr-fr', 'en-gb'])).toEqual(['fr-FR', 'en-GB']);
    expect(() => normalizeSpellcheckLanguageRequest(['fr-FR', 'fr-fr'])).toThrow(TypeError);
    expect(() =>
      normalizeSpellcheckLanguageRequest(
        Array.from({ length: SPELLCHECK_LIMITS.maxLanguages + 1 }, (_, index) => `x-${index}`),
      ),
    ).toThrow(TypeError);
  });

  it('prefers exact installed dictionaries, then a deterministic base-language fallback', () => {
    expect(
      resolveSupportedSpellcheckLanguages(['fr-FR', 'en-AU', 'de-DE'], ['en-US', 'fr-FR', 'en-GB']),
    ).toEqual({
      requestedLanguages: ['fr-FR', 'en-AU', 'de-DE'],
      appliedLanguages: ['fr-FR', 'en-US'],
      unsupportedLanguages: ['de-DE'],
    });
  });

  it('returns no native menu for non-editable targets so the renderer remains authoritative', () => {
    expect(
      editableContextMenuItems({
        isEditable: false,
        misspelledWord: 'object',
        dictionarySuggestions: ['subject'],
        canCut: false,
        canCopy: true,
        canPaste: false,
      }),
    ).toBeNull();
  });

  it('bounds editable suggestions and exposes local dictionary plus edit roles', () => {
    const items = editableContextMenuItems({
      isEditable: true,
      misspelledWord: 'busines',
      dictionarySuggestions: [
        'business',
        'business',
        ...Array.from({ length: 20 }, (_, index) => `business-${index}`),
      ],
      canCut: true,
      canCopy: true,
      canPaste: false,
    });
    expect(items).not.toBeNull();
    expect(items?.filter((item) => item.kind === 'suggestion')).toHaveLength(
      SPELLCHECK_LIMITS.maxSuggestions,
    );
    expect(items).toContainEqual({
      kind: 'add-to-dictionary',
      label: 'Add “busines” to dictionary',
      word: 'busines',
    });
    expect(items).not.toContainEqual(expect.objectContaining({ kind: 'ignore-for-session' }));
    expect(items?.slice(-3)).toEqual([
      { kind: 'role', role: 'cut', enabled: true },
      { kind: 'role', role: 'copy', enabled: true },
      { kind: 'role', role: 'paste', enabled: false },
    ]);
  });

  it('omits spelling actions when Chromium reports no misspelled word', () => {
    expect(
      editableContextMenuItems({
        isEditable: true,
        misspelledWord: '',
        dictionarySuggestions: [],
        canCut: false,
        canCopy: false,
        canPaste: true,
      }),
    ).toEqual([
      { kind: 'role', role: 'cut', enabled: false },
      { kind: 'role', role: 'copy', enabled: false },
      { kind: 'role', role: 'paste', enabled: true },
    ]);
  });
});
