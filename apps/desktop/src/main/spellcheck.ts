import { canonicalizeLanguageTag, DOCUMENT_LIMITS } from '@htmllelujah/document-core';

export const SPELLCHECK_LIMITS = Object.freeze({
  maxLanguages: 4,
  maxAvailableLanguages: 512,
  maxSuggestions: 8,
  maxWordLength: 256,
});

export interface SpellcheckLanguageResolution {
  readonly requestedLanguages: readonly string[];
  readonly appliedLanguages: readonly string[];
  readonly unsupportedLanguages: readonly string[];
}

const canonicalLanguageOrUndefined = (value: string): string | undefined => {
  try {
    return canonicalizeLanguageTag(value);
  } catch {
    return undefined;
  }
};

export const normalizeSpellcheckLanguageRequest = (
  languages: readonly string[],
): readonly string[] => {
  if (languages.length < 1 || languages.length > SPELLCHECK_LIMITS.maxLanguages) {
    throw new TypeError('Spellchecker language count is outside the desktop limits.');
  }
  const canonical = languages.map(canonicalizeLanguageTag);
  if (new Set(canonical).size !== canonical.length) {
    throw new TypeError('Spellchecker languages must be unique.');
  }
  return canonical;
};

/**
 * Maps canonical document locales to Chromium's installed spellchecker packs.
 * Exact tags win; otherwise the first available tag with the same base language
 * is selected. No dictionary is downloaded here.
 */
export const resolveSupportedSpellcheckLanguages = (
  languages: readonly string[],
  availableLanguages: readonly string[],
): SpellcheckLanguageResolution => {
  const requestedLanguages = normalizeSpellcheckLanguageRequest(languages);
  const available = availableLanguages
    .slice(0, SPELLCHECK_LIMITS.maxAvailableLanguages)
    .map(canonicalLanguageOrUndefined)
    .filter((language): language is string => language !== undefined);
  const availableSet = new Set(available);
  const appliedLanguages: string[] = [];
  const unsupportedLanguages: string[] = [];

  for (const requested of requestedLanguages) {
    const baseLanguage = new Intl.Locale(requested).language;
    const selected =
      (availableSet.has(requested) ? requested : undefined) ??
      available.find((candidate) => new Intl.Locale(candidate).language === baseLanguage);
    if (selected === undefined) {
      unsupportedLanguages.push(requested);
    } else if (!appliedLanguages.includes(selected)) {
      appliedLanguages.push(selected);
    }
  }

  return { requestedLanguages, appliedLanguages, unsupportedLanguages };
};

export interface EditableContextMenuInput {
  readonly isEditable: boolean;
  readonly misspelledWord: string;
  readonly dictionarySuggestions: readonly string[];
  readonly canCut: boolean;
  readonly canCopy: boolean;
  readonly canPaste: boolean;
  /**
   * Electron currently exposes no non-persistent "ignore for session" method.
   * Keep the capability explicit so a future runtime can add it without
   * pretending that the persistent user dictionary is session-scoped.
   */
  readonly canIgnoreForSession?: boolean | undefined;
}

export type EditableContextMenuItem =
  | Readonly<{ kind: 'suggestion'; label: string; replacement: string }>
  | Readonly<{ kind: 'separator' }>
  | Readonly<{ kind: 'add-to-dictionary'; label: string; word: string }>
  | Readonly<{ kind: 'ignore-for-session'; label: string; word: string }>
  | Readonly<{ kind: 'role'; role: 'cut' | 'copy' | 'paste'; enabled: boolean }>;

const boundedWord = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed.length > 0 &&
    trimmed.length <= SPELLCHECK_LIMITS.maxWordLength &&
    !/[\p{Cc}\p{Cf}]/u.test(trimmed)
    ? trimmed
    : undefined;
};

/**
 * Returns null for every non-editable target so the renderer's object menu
 * remains authoritative outside actual text editing.
 */
export const editableContextMenuItems = (
  input: EditableContextMenuInput,
): readonly EditableContextMenuItem[] | null => {
  if (!input.isEditable) return null;
  const word = boundedWord(input.misspelledWord);
  const suggestions =
    word === undefined
      ? []
      : input.dictionarySuggestions
          .map(boundedWord)
          .filter((suggestion): suggestion is string => suggestion !== undefined)
          .filter((suggestion, index, values) => values.indexOf(suggestion) === index)
          .slice(0, SPELLCHECK_LIMITS.maxSuggestions);
  const spellingItems: EditableContextMenuItem[] = suggestions.map((suggestion) => ({
    kind: 'suggestion',
    label: suggestion,
    replacement: suggestion,
  }));
  if (word !== undefined) {
    if (spellingItems.length > 0) spellingItems.push({ kind: 'separator' });
    spellingItems.push({
      kind: 'add-to-dictionary',
      label: `Add “${word}” to dictionary`,
      word,
    });
    if (input.canIgnoreForSession === true) {
      spellingItems.push({
        kind: 'ignore-for-session',
        label: `Ignore “${word}” for this session`,
        word,
      });
    }
    spellingItems.push({ kind: 'separator' });
  }

  return [
    ...spellingItems,
    { kind: 'role', role: 'cut', enabled: input.canCut },
    { kind: 'role', role: 'copy', enabled: input.canCopy },
    { kind: 'role', role: 'paste', enabled: input.canPaste },
  ];
};

export const isBoundedSpellcheckLanguage = (value: string): boolean =>
  value.length <= DOCUMENT_LIMITS.maxLocaleLength &&
  canonicalLanguageOrUndefined(value) !== undefined;
