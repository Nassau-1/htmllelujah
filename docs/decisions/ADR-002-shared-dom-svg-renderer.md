# ADR-002: Use One Shared DOM/SVG Renderer

- Status: Accepted
- Date: 2026-07-15

## Context

An editor, presentation view, thumbnails, standalone HTML output, and PDF output can
drift when each uses a separate layout engine. Text metrics and line wrapping are
particularly sensitive to differences in fonts, resource readiness, and geometry.

## Decision

Use one renderer contract for every visual surface. Semantic text, images, and
tables render in the DOM. Shapes, connectors, icons, and guides render as inline
SVG. Editor-only interactions occupy a separate overlay that is disabled outside
editing mode.

The renderer receives canonical point geometry, an explicit mode, scale, and a
read-only slide projection. It exposes `renderReady` only after fonts, images, and
layout have settled. PDF generation uses the desktop runtime's print surface with
the same renderer and exact page dimensions.

## Consequences

- Visual corrections benefit all surfaces.
- Golden fixtures can compare editor, presentation, HTML, and rasterized PDF.
- Platform-fidelity work must be completed before broad editing features.
- Interaction code must not mutate or compensate for renderer geometry.
- Canvas-only scene graphs are not the canonical rendering path.
