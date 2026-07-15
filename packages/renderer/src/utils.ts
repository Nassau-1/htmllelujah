import type { CSSProperties } from 'react';

import type { Frame } from './types.js';

const POINT_PRECISION = 1_000_000;

export const finiteOr = (value: number, fallback: number): number =>
  Number.isFinite(value) ? value : fallback;

export const formatPoint = (value: number): string => {
  const rounded = Math.round(finiteOr(value, 0) * POINT_PRECISION) / POINT_PRECISION;
  return `${Object.is(rounded, -0) ? 0 : rounded}pt`;
};

export const formatNumber = (value: number, fallback = 0): string => {
  const rounded = Math.round(finiteOr(value, fallback) * POINT_PRECISION) / POINT_PRECISION;
  return String(Object.is(rounded, -0) ? 0 : rounded);
};

export const safeOpacity = (value: number): number => Math.min(1, Math.max(0, finiteOr(value, 1)));

const SAFE_COLOR =
  /^(?:#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|transparent|currentColor)$/i;

export const safeColor = (value: string | null | undefined, fallback = 'transparent'): string =>
  value !== null && value !== undefined && SAFE_COLOR.test(value.trim()) ? value.trim() : fallback;

export const safeAssetUrl = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (
    /^htmllelujah-asset:\/\/[a-z0-9._~/-]+$/i.test(trimmed) &&
    !/(?:^|\/)\.\.(?:\/|$)/.test(trimmed.slice('htmllelujah-asset://'.length))
  ) {
    return trimmed;
  }
  if (/^blob:(?:(?:https?:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?)|null)\/[a-z0-9._~-]+$/i.test(trimmed)) {
    return trimmed;
  }
  if (/^data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/]+={0,2}$/i.test(trimmed)) {
    return trimmed;
  }
  return null;
};

export const safeAssetFromResolver = (
  resolver: ((assetId: string) => string | null | undefined) | undefined,
  assetId: string,
): string | null => {
  if (resolver === undefined) return null;
  try {
    return safeAssetUrl(resolver(assetId));
  } catch {
    return null;
  }
};

export const elementFrameStyle = (
  frame: Frame,
  opacity: number,
  zIndex: number,
): CSSProperties => ({
  position: 'absolute',
  left: formatPoint(frame.xPt),
  top: formatPoint(frame.yPt),
  width: formatPoint(Math.max(0, finiteOr(frame.widthPt, 0))),
  height: formatPoint(Math.max(0, finiteOr(frame.heightPt, 0))),
  opacity: safeOpacity(opacity),
  transform: `rotate(${formatNumber(frame.rotationDeg)}deg)`,
  transformOrigin: 'center center',
  zIndex,
  boxSizing: 'border-box',
});

export const strokeDashArray = (
  dash: 'solid' | 'dash' | 'dot',
  widthPt: number,
): string | undefined => {
  const width = Math.max(0.1, finiteOr(widthPt, 1));
  if (dash === 'dash') return `${formatNumber(width * 4)} ${formatNumber(width * 2)}`;
  if (dash === 'dot') return `${formatNumber(width)} ${formatNumber(width * 2)}`;
  return undefined;
};

export const safeDomId = (value: string): string => {
  if (/^[a-zA-Z0-9_-]{1,80}$/.test(value)) return value;
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619);
  }
  const prefix = cleaned.length === 0 ? 'element' : cleaned;
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

export const isoCountryCodeToFlag = (value: string): string => {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return String.fromCodePoint(0x1f3f3);
  return String.fromCodePoint(...[...code].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65));
};
