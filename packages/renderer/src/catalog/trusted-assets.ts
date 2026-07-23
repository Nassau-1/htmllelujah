import { normalizeCatalogIconIdentity } from './catalog.js';
import { CIRCLE_FLAG_ASSET_DATA } from './generated/circle-flag-assets.js';
import { TWEMOJI_ASSET_DATA } from './generated/twemoji-assets.js';

export interface TrustedCatalogVector {
  readonly iconSet: 'twemoji' | 'circle-flags';
  readonly iconName: string;
  readonly viewBox: string;
  readonly markup: string;
}

export const resolveTrustedCatalogVector = (
  iconSet: string,
  iconName: string,
): TrustedCatalogVector | null => {
  const identity = normalizeCatalogIconIdentity(iconSet, iconName);
  if (identity === null || identity.iconSet === 'htmllelujah-local') return null;
  const asset =
    identity.iconSet === 'twemoji'
      ? TWEMOJI_ASSET_DATA[identity.iconName]
      : CIRCLE_FLAG_ASSET_DATA[identity.iconName];
  if (asset === undefined) return null;
  return Object.freeze({
    iconSet: identity.iconSet,
    iconName: identity.iconName,
    viewBox: asset[0],
    markup: asset[1],
  });
};
