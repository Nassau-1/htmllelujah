# Changelog

All notable changes to HTMLlelujah are recorded in this file. Dates use ISO format
and releases use semantic versions.

## [Unreleased]

No user-facing change is queued after the V1 release candidate.

## [1.0.0] - 2026-07-15

### Added

- Integrated Windows presentation editor backed by the canonical document runtime,
  with slide thumbnails, direct manipulation, snapping, smart guides, alignment,
  distribution, grouping, layers, lock, visibility, keyboard control, and undo/redo.
- Typed rich text, themes, masters, layouts, placeholders, page formats,
  backgrounds, images, native tables with TSV paste, shapes, connectors, local vector
  icons, and round Unicode flags.
- One shared DOM/SVG renderer for the editor, thumbnails, full-screen presentation,
  standalone HTML, and PDF print surfaces.
- Versioned deterministic `.hdeck` files with strict archive bounds,
  content-addressed assets, external-change detection, verified atomic explicit save,
  durable recovery journals, and a recovery-candidate UI.
- Offline standalone HTML export with restrictive content policy and exact-page PDF
  export through the desktop print surface.
- Authenticated private-LAN collaboration with WSS, certificate fingerprint,
  document-scoped credentials, optional discovery, host-ordered transactions,
  reconnect handling, soft text locks, detached guest recovery, and one shared-file
  writer.
- Local stdio MCP launcher and authenticated desktop RPC with bounded typed tools,
  revision-aware proposal and commit, agent attribution, grouped undo, one-time
  approvals, asset import, export, and redacted collaboration status.
- Per-user Windows x64 NSIS packaging, application icon, `.hdeck` file association,
  second-instance file-open handling, hardened Electron fuses, and a console MCP
  launcher.
- Source-visible proprietary notice, separate V1 binary terms, direct-dependency
  notices, Electron/FFmpeg license review, and bundled-asset provenance ledger.

### Security

- Kept renderer processes sandboxed and context-isolated with no Node.js integration,
  generic IPC, navigation, popup, permission, or active remote-content capability.
- Added bounded validation for documents, commands, `.hdeck` ZIP structures,
  journals, assets, IPC, local RPC, MCP messages, and LAN frames.
- Bound MCP reads to visible documents and destructive operations to single-use,
  document-, action-, revision-, and time-bound desktop approvals.
- Kept LAN collaboration on authenticated encrypted private-network channels and
  prevented guests or disconnected peers from silently replacing the shared file.
- Enabled Electron `RunAsNode` only for the packaged MCP console entrypoint while
  disabling `NODE_OPTIONS` and CLI inspection and retaining ASAR integrity and
  ASAR-only loading. The tradeoff is recorded in ADR-008 and the security policy.

### Known V1 boundaries

- Authenticode is applied only when a release certificate is configured; otherwise
  artifacts are explicitly labelled unsigned.
- MCP mutations are paused during a live LAN session; read tools remain available.
- Collaboration has no internet relay, automatic writer election, disconnected edit
  merge, or simultaneous editing of one text element.
- Exported HTML is output only. Third-party presentation-file interchange,
  transitions, animations, notes, comments, cloud accounts, and an embedded chatbot
  are not included.

## 0.1.0 - 2026-07-15

### Added

- Initial monorepo, Spec Kit foundation, public project governance, security policy,
  architecture overview, operations guide, and architecture decision records.
- Initial platform-fidelity specification and isolated desktop and document-core
  prototypes.

### Security

- Established sandboxing, safe-document, validated-IPC, and public-data hygiene as
  constitutional requirements.

[Unreleased]: https://github.com/Nassau-1/htmllelujah/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Nassau-1/htmllelujah/releases/tag/v1.0.0
