import type { DeckDocument } from './model.js';

const canonicalize = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);

  const entries = Object.entries(value as Readonly<Record<string, unknown>>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => [key, canonicalize(entryValue)] as const);
  return Object.fromEntries(entries);
};

/** Stable JSON used for revision comparison, fixtures, and adapter hand-off. */
export const canonicalSerialize = (value: unknown): string => JSON.stringify(canonicalize(value));

const MASK_64 = 0xffff_ffff_ffff_ffffn;
const FNV_PRIME_64 = 0x0000_0100_0000_01b3n;

const fnv1a64 = (bytes: Uint8Array, seed: bigint): bigint => {
  let hash = seed;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME_64) & MASK_64;
  }
  return hash;
};

/**
 * Produces a deterministic, renderer-safe content revision without Node APIs.
 * It is a concurrency token, not a security digest.
 */
export const createRevisionToken = (document: DeckDocument): string => {
  const bytes = new TextEncoder().encode(canonicalSerialize(document));
  const first = fnv1a64(bytes, 0xcbf2_9ce4_8422_2325n);
  const second = fnv1a64(bytes, 0x8422_2325_cbf2_9ce4n);
  return `rev1-${first.toString(16).padStart(16, '0')}${second.toString(16).padStart(16, '0')}`;
};
