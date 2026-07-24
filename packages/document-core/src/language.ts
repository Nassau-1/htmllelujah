import { DOCUMENT_LIMITS } from './limits.js';

/**
 * Returns the canonical BCP-47 spelling used by the document model.
 *
 * `Intl.getCanonicalLocales` is available in every supported Node/Electron
 * runtime and avoids maintaining a permissive, incomplete language-tag regex.
 */
export const canonicalizeLanguageTag = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > DOCUMENT_LIMITS.maxLocaleLength) {
    throw new TypeError('Language tag is outside the document limits.');
  }
  try {
    const canonical = Intl.getCanonicalLocales(trimmed);
    if (canonical.length !== 1 || canonical[0] === undefined) {
      throw new TypeError('A single BCP-47 language tag is required.');
    }
    return canonical[0];
  } catch (error) {
    if (
      error instanceof TypeError &&
      error.message === 'Language tag is outside the document limits.'
    ) {
      throw error;
    }
    throw new TypeError('Language tag is not valid BCP-47.', { cause: error });
  }
};

export const isCanonicalLanguageTag = (value: string): boolean => {
  try {
    return canonicalizeLanguageTag(value) === value;
  } catch {
    return false;
  }
};
