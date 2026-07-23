import type { ReactElement } from 'react';

import { getContentCatalogEntry, normalizeCatalogIconIdentity } from './catalog/catalog.js';
import { LOCAL_ICON_PATHS } from './catalog/local-icon-paths.js';
import { resolveTrustedCatalogVector } from './catalog/trusted-assets.js';
import { safeColor } from './utils.js';

export interface LocalIconProps {
  readonly iconSet: string;
  readonly iconName: string;
  readonly color: string;
}

export const LocalIcon = ({ iconSet, iconName, color }: LocalIconProps): ReactElement => {
  const identity = normalizeCatalogIconIdentity(iconSet, iconName);
  const catalogEntry = getContentCatalogEntry(iconSet, iconName);
  const vector = resolveTrustedCatalogVector(iconSet, iconName);
  if (identity !== null && vector !== null) {
    return (
      <svg
        className={
          vector.iconSet === 'circle-flags'
            ? 'hl-catalog-vector hl-circle-flag'
            : 'hl-catalog-vector hl-twemoji'
        }
        viewBox={vector.viewBox}
        role="img"
        aria-label={catalogEntry?.label ?? vector.iconName}
        data-catalog-icon={`${vector.iconSet}:${vector.iconName}`}
        // This string is generated from pinned packages through the closed SVG
        // tag/attribute allowlist. No document or agent input reaches this sink.
        dangerouslySetInnerHTML={{ __html: vector.markup }}
      />
    );
  }
  if (identity?.iconSet !== 'htmllelujah-local') {
    return (
      <span
        className="hl-missing-asset"
        data-render-warning="ICON_UNKNOWN"
        aria-label="Unknown icon"
      >
        ?
      </span>
    );
  }
  const paths = LOCAL_ICON_PATHS[identity.iconName];
  if (paths === undefined) {
    return (
      <span
        className="hl-missing-asset"
        data-render-warning="ICON_UNKNOWN"
        aria-label="Unknown icon"
      >
        ?
      </span>
    );
  }
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-label={catalogEntry?.label ?? iconName}
      data-catalog-icon={`htmllelujah-local:${identity.iconName}`}
    >
      {paths.map((path, index) => (
        <path
          key={`${identity.iconName}-${index}`}
          d={path}
          fill="none"
          stroke={safeColor(color, '#172033')}
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
};
