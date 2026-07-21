# Changelog

All notable changes to HTMLlelujah are recorded in this file. Dates use ISO format
and releases use semantic versions.

## [Unreleased]

### Fixed

- Gave the complete Windows source-verification gate a measured one-hour ceiling,
  preserved the timeout diagnosis across process termination, and failed closed when
  its validation process tree cannot be drained.
- Scoped Windows file and message-box automation to exact visible Win32
  process/HWND/class/control identities, supported both native filename-control variants,
  made clicks synchronous and bounded, fingerprinted deferred consent generations, and
  verified automation process-tree drainage without traversing Chromium accessibility
  trees.
- Calibrated the packaged V1 warm-start envelope to four seconds for the unsigned Windows
  executable plus evidence-only DevTools endpoint after repeated three-sample medians near
  3.3 seconds; the three-second optimization target, every raw sample, and every outlier
  remain recorded and validated, with the requirement change documented in ADR-012.
- Refused publication from an existing write-once release record after its bound
  security receipt expires or is recollected, while preserving any GitHub draft and
  directing operators to a new versioned candidate, tag, and release.
- Serialized Save and Save As within each document session, made the runtime's target
  path authoritative at commit time, serialized complete host/join handoffs against
  retargeting, rechecked destination and temporary-file identity immediately before
  replacement, and required explicit confirmation before taking over an expired writer
  reservation.
- Serialized writer-sidecar mutation across processes without an intentionally
  absent-path window, made partial creation and release cleanup identity/exact-byte
  safe and retryable, treated an orphaned mutation lock as an explicit-recovery
  condition, and limited abandoned mutation-lock recovery to the stable
  expired-writer takeover flow.
- Made LAN admission reserve bounded capacity before asynchronous work, bound listeners
  to an explicitly selected named private-network adapter, authenticated that exact
  address in discovery, retained lossless join state, bounded idempotency and history
  storage, drained admitted host submissions before the final save, cleaned up failed
  join clones, and fenced shared-file commits with current host writer authority.
- Reused identical imported image bytes under one canonical content-addressed asset,
  remapped dependent insert and replacement commands atomically, and cached an opaque
  immutable validation proof so ordinary edits, undo, redo, and autosave do not
  repeatedly hash every existing asset.
- Enforced complete canonical-document, archive, export-projection, asset-decoding, and
  rich-clipboard budgets before mutation or expensive work.
- Excluded the packager's unused installed elevation helper from V1; the per-user
  installer retains its independent NSIS UAC flow.

### Security

- Hardened the release gate around the actual pnpm 11 audit format, signed on-demand
  Microsoft Defender scans, stable scanner/platform identity, zero-open-alert CodeQL
  evidence, and stable one-link evidence reads.

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

### Fixed

- Made the Windows warm-start release gate close every probe through the real native
  close handshake, reject residual recovery state, retain three phase-level samples,
  and enforce the unchanged three-second budget against their deterministic median.
- Made release evidence inventory exactly five native runtime components
  (Electron, Chromium, embedded Node.js, FFmpeg, and NSIS), bind their versions and
  hashes to the packaged executable or installer, attest every packaged Electron
  fuse against the V1 policy, and fail readiness when any component, version, hash,
  fuse, or binding is absent, unknown, or malformed.

### Security

- Added a fresh fail-closed V1 publication gate that binds the exact candidate to
  zero-vulnerability production and full pnpm audits, its successful CodeQL analysis
  and zero open alerts, clean no-remediation scans by an Authenticode-validated
  Microsoft Defender scanner whose engine and definitions remain stable during both
  scans, the unsigned installer and application executable, and a lockfile-bound
  production dependency SBOM.
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
- Chained installer-cancellation association rollback through MUI2's supported abort
  hook so the assisted NSIS installer compiles without redefining its native callback.
- Compared release-inventory confirmation paths in the same global order as their
  hashes, avoiding false mutation alarms for sibling files and prefixed directories.
- Pinned release-child debug namespaces off and CI mode on so the locked Electron
  Builder cannot emit internal diagnostic sidecars into the public candidate directory.
- Serialized inline-text commits before document, history, selection, and design-surface
  transitions so a single keyboard or assistive activation cannot be discarded.
- Kept the newest inline-text payload in a synchronous, target-checked draft snapshot so an
  immediate native close cannot observe an older React render or apply text to another object.
- Made close and session replacement revision-bound, drained queued mutations before teardown,
  preserved recovery artifacts during rollback, and removed every late presentation window before
  remapping an editor session.
- Reserved each recovery candidate before asynchronous replay, rechecked native-window ownership
  before replacement cleanup, and made renderer close authorization single-dispatch so concurrent
  recovery or a failed native close cannot invalidate a visible session.
- Blurred focused form editors during the close handshake and required every resulting mutation to
  succeed before teardown, keeping the window open when any uncontrolled-field or inline-text commit
  is rejected.
- Allowed the capability-scoped local asset protocol only on the renderer image CSP surface and made
  the Windows smoke require successful image decoding in both editor and presentation windows.
- Opened the measured Windows smoke window visibly and exercised real pointer input, parented
  native dialogs, and `WM_CLOSE`; the suite now proves Cancel retention and rejects a stale
  Discard after a concurrent authenticated MCP edit.

### Known V1 boundaries

- The official no-charge public V1 pipeline deliberately produces and verifies
  exactly unsigned artifacts and refuses signing credentials. Any later signed or
  commercial distribution requires a separately reviewed candidate and release gate.
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
