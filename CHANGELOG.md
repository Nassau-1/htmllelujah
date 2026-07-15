# Changelog

All notable changes to HTMLlelujah will be recorded in this file.

The project uses semantic versions while it is in Alpha. Until `1.0.0`, minor
versions may include document or integration changes that require migration.

## [Unreleased]

### Added

- Sandboxed Electron shell with context isolation, blocked navigation, denied
  permission requests, and a minimal preload surface.
- Isolated in-memory editor interaction prototype with direct text editing,
  selection, drag, resize, snapping, alignment, slide thumbnails, and synthetic
  text, shape, image, and table objects.
- Structured document-core foundation with runtime validation, deterministic
  revisions, immutable transaction commands, grouping, alignment, distribution,
  snapshot undo, and an adapter boundary.
- Unit coverage for document validation, revision conflicts, atomic rollback, slide
  and element commands, geometry operations, grouping, undo, and subscriptions.

### Planned

- Complete the platform-fidelity spike with a shared DOM/SVG renderer, presentation
  surface, PDF proof, Windows visual baselines, and integration evidence.
- Structured, versioned `.hdeck` document format.
- Integrate the document core and editor before supporting real authoring files.
- Presentation, standalone HTML export, and PDF export.
- Local MCP automation and local-network collaboration.

## [0.1.0] - 2026-07-15

### Added

- Initial monorepo and Spec Kit foundation.
- Public project governance, security policy, architecture overview, operations
  guide, and architecture decision records.
- `001-platform-fidelity` specification, implementation plan, and ordered task list.

### Security

- Established sandboxing, safe-document, validated-IPC, and public-data hygiene as
  constitutional requirements.

[Unreleased]: https://github.com/Nassau-1/htmllelujah/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Nassau-1/htmllelujah/releases/tag/v0.1.0
