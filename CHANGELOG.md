# Changelog

All notable changes to HTMLlelujah are recorded in this file. Dates use ISO format
and releases use semantic versions.

## [Unreleased]

No user-facing change is queued after the V1 release candidate.

## [1.0.0] - 2026-07-17

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
  reconnect handling, expiring soft text locks with an owner/read-only editor state,
  detached guest recovery, and one shared-file writer.
- Local stdio MCP launcher and authenticated desktop RPC with bounded typed tools,
  revision-aware proposal and commit, agent attribution, grouped undo, one-time
  approvals, bounded pending-state quotas, asset import, export, and redacted
  collaboration status.
- Per-user Windows x64 NSIS packaging, application icon, `.hdeck` file association,
  second-instance file-open handling, hardened Electron fuses, and a console MCP
  launcher.
- Windows Electron accessibility and display-scaling smoke coverage for semantic
  controls, keyboard focus, reduced motion, compact layout, and 100% through 200%
  scaling. Manual Narrator or NVDA validation remains a release-record item.
- Candidate-bound Windows validation with opened packaged and installed UI, HTML/PDF
  exports, packaged MCP, scaling, two-process text locks, installer lifecycle,
  performance limits, a continuous 30-minute collaboration soak, and a deterministic
  public evidence bundle.
- Source-visible proprietary notice, separate V1 binary terms, direct-dependency
  notices, an engineering Electron/FFmpeg license review, and bundled-asset
  provenance ledger. The review does not replace qualified legal approval for
  commercial distribution.

### Security

- Made image registration plus insertion or replacement one durable, undoable transaction;
  bounded image headers are inspected before pixel decoding.
- Retained the editor session and recovery journal after failed close/save operations, and
  destroyed half-created hidden windows after failed archive open or renderer load.
- Added bounded recovery-blob garbage collection and proactive TTL/cap enforcement for pending
  runtime agent proposals.
- Bounded local MCP proposals to 100 commands, 2 MiB frames/results, 64 pending
  proposals and a one-minute desktop expiry; bounded desktop approvals to 32 pending,
  two minutes, one use, and 64 short-lived consumed receipts.
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
- Made release publication require a canonical functional manifest and ZIP bound to
  the exact clean source tree, lockfile, complete artifact inventory, Windows
  platform/architecture/build, Node runtime, pnpm version, local and remote annotated
  tag objects, and re-downloaded asset hashes.
- Made clean-source provenance hash canonical Git blob contents so safe LF/CRLF
  checkout policies cannot split one commit identity, while refusing replacement
  refs, grafts, hidden index flags, and content-transforming checkout attributes.
- Bounded detached release-worktree names so locked pnpm and NSIS include paths stay
  within the legacy Windows path budget used by the unsigned V1 builder.

### Known V1 boundaries

- Authenticode is applied only when a release certificate is configured; otherwise
  artifacts are explicitly labelled unsigned.
- MCP mutations are paused during a live LAN session; read tools remain available.
- Collaboration has no internet relay, automatic writer election, disconnected edit
  merge, or simultaneous editing of one text element.
- Writer leases are enforceable across machines only on a coherent shared filesystem;
  consumer cloud-sync replicas transport snapshots and still require one designated
  LAN host.
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
