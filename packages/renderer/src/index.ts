export { EditorOverlay } from './EditorOverlay.js';
export type {
  AxisOverlayGuide,
  DocumentOverlayGuide,
  EditorOverlayProps,
  OverlayGuide,
  OverlaySelection,
} from './EditorOverlay.js';
export { LocalIcon } from './icons.js';
export type { LocalIconProps } from './icons.js';
export { LOCAL_ICON_PATHS } from './catalog/local-icon-paths.js';
export {
  CATALOG_IDS,
  CIRCLE_FLAG_CATALOG,
  CONTENT_CATALOGS,
  getContentCatalogEntries,
  getContentCatalogEntry,
  isKnownCatalogIcon,
  LOCAL_ICON_CATALOG,
  normalizeCatalogIconIdentity,
  searchContentCatalog,
  SHAPE_CATALOG,
  TWEMOJI_CATALOG,
} from './catalog/catalog.js';
export type {
  CatalogIconSet,
  CatalogId,
  CatalogLocale,
  ContentCatalogEntry,
  ContentCatalogInsert,
  IconCatalogInsert,
  NormalizedCatalogIconIdentity,
  SearchContentCatalogOptions,
  ShapeCatalogInsert,
} from './catalog/catalog.js';
export {
  normalizeResolvedSlide,
  resolveSlideFromDeck,
  SlideProjectionError,
} from './projection.js';
export { waitForRenderReady } from './readiness.js';
export type {
  RenderReadyOptions,
  RenderReadyResult,
  RenderReadyWarning,
  RenderReadyWarningCode,
} from './readiness.js';
export {
  resolveConnectorGeometries,
  resolveConnectorGeometry,
  SlideSurface,
} from './SlideSurface.js';
export type { ResolvedConnectorGeometry, SlideSurfaceProps } from './SlideSurface.js';
export { RENDERER_CSS } from './styles.js';
export type * from './types.js';
export {
  elementFrameStyle,
  finiteOr,
  formatNumber,
  formatPoint,
  isoCountryCodeToFlag,
  safeAssetFromResolver,
  safeAssetUrl,
  safeColor,
  safeDomId,
  safeOpacity,
  strokeDashArray,
} from './utils.js';
