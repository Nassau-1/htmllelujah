# Tasks: Usable V1 Release

**Input**: [spec.md](spec.md), [plan.md](plan.md), [contracts.md](contracts.md),
[test-matrix.md](test-matrix.md), and ADR-005 through ADR-008.

**Status rule**: A task is checked only after its acceptance evidence exists. Source
code that resembles a requirement does not count. `001-platform-fidelity` remains open
until its own tasks and evidence are complete.

Each task names its primary surface, observable acceptance, required edge coverage,
and containment point. `[P]` means it may proceed in parallel after dependencies.

## Phase 0: Authority, evidence, and release controls

- [ ] **V1-000 Ratify V1 contracts and ADRs** in `specs/002-v1-release/` and
      `docs/decisions/ADR-005` through `ADR-008`.
  - **Acceptance**: Constitution check passes; all persistent/process/network contracts
    have one owner; no requirement contradicts another.
  - **Edges**: Confirm authoritative-host, no disconnected merge, stdio MCP, and one
    shared-file writer explicitly.
  - **Containment**: Documentation-only rollback before code depends on the contract.

- [ ] **V1-001 Reconcile but do not close `001-platform-fidelity`** in its spec,
      task, and future result records.
  - **Acceptance**: Every V1 fidelity dependency links to an actual `001` task/evidence;
    unchecked work stays unchecked.
  - **Edges**: Existing desktop prototype is never counted as shared-renderer proof.
  - **Containment**: Block dependent release gates rather than editing history.

- [ ] **V1-002 Establish release flags and safe defaults** in the desktop runtime.
  - **Acceptance**: LAN hosting, MCP mutations, HTML export, and PDF export can be
    independently disabled; core local save cannot be presented as complete if false.
  - **Edges**: Flags default off in tests that have no explicit fixture configuration.
  - **Containment**: Disable the affected subsystem without creating a second data path.

- [ ] **V1-003 Add public-safe canonical and adversarial fixture policy** under
      `tests/fixtures/`.
  - **Acceptance**: Fixtures are synthetic, versioned, licensed, bounded, and mapped to
    requirements; generation is deterministic where applicable.
  - **Edges**: Unicode, RTL, IME, corrupt archives, image signatures, TSV, MCP, and LAN.
  - **Containment**: Quarantine any fixture with uncertain provenance.

**Checkpoint 0**: Contracts are frozen enough for parallel implementation. No code
claim may weaken a hard release blocker.

## Phase 1: Document schema V2 and migration

- [ ] **V1-010 Extend the canonical model** in `packages/document-core/src/model.ts`
      with bounded rich-text overrides, placeholder bindings, catalog identity, and
      explicit V2 types.
  - **Acceptance**: Every V1 content and inheritance concept has a typed representation;
    no arbitrary HTML/CSS/URL/path field exists.
  - **Edges**: Empty blocks, nested groups, bound/unbound connectors, local overrides.
  - **Containment**: Keep V1 reader available; do not write V2 until migration passes.

- [ ] **V1-011 Add strict V2 runtime schemas and structural limits** in
      `packages/document-core/src/schemas.ts` and `validation.ts`.
  - **Acceptance**: Unknown keys, excessive lists/text/depth/counts, broken references,
    duplicate roles, and unsupported catalog IDs return stable issues.
  - **Edges**: Images in master/layout, placeholder refs, connector target deletion,
    table coverage, case and Unicode limits.
  - **Containment**: Reject before session creation; never coerce hostile input.

- [ ] **V1-012 Implement pure migration registry** under
      `packages/document-core/src/migrations/`.
  - **Acceptance**: V1 → V2 is deterministic, immutable, reported step-by-step, and
    validated after each step; newer versions return read-only compatibility status.
  - **Edges**: Interrupted/repeated migration, missing optional legacy fields, future
    container and document versions.
  - **Containment**: Preserve original and return migrated copy only after full validity.

- [ ] **V1-013 Add domain-specific V1 commands** in
      `packages/document-core/src/commands/`.
  - **Acceptance**: Deck, page, theme, master, layout, slide, z-order, styles, rich text,
    table, asset, connector, group, lock, and visibility operations are typed and atomic.
  - **Edges**: Last dependency deletion, stale IDs, locked containers, mixed valid/
    invalid batch, duplicate elements.
  - **Containment**: Reject whole transaction; retain legacy general update only for
    migration/internal use, not ordinary UI or MCP calls.

- [ ] **V1-014 Harden revisions and validation reporting** in `document-core`.
  - **Acceptance**: Adapter revision remains opaque; security hashes use SHA-256 at
    persistence boundaries; errors expose safe codes and structured paths.
  - **Edges**: Equivalent content, array-order changes, large documents, collision test
    harness, and redacted diagnostics.
  - **Containment**: Treat revision mismatch as conflict, never as an overwrite hint.

- [ ] **V1-015 Add schema, migration, command, and property tests** under
      `packages/document-core/test/`.
  - **Acceptance**: DOC-001 through DOC-008 and CMD-001 through CMD-003 pass with stored
    replay seeds for generated failures.
  - **Edges**: Maximum supported model, one-over-limit inputs, arbitrary valid sequences.
  - **Containment**: Do not enable V2 writes while any migration/property test fails.

**Checkpoint 1 — hard**: Every supported document is bounded, migratable, reference-
closed, and command-mutated. No V2 file is written before this checkpoint.

## Phase 2: Projection, masters, and deterministic geometry

- [ ] **V1-020 Implement theme/master/layout resolution** under
      `packages/document-core/src/projection/`.
  - **Acceptance**: Resolver emits immutable `ResolvedSlide` in the normative stacking
    and style order with content-free warnings.
  - **Edges**: Missing style role, hidden/locked inherited elements, multiple local
    overrides, unresolved optional catalog item.
  - **Containment**: Projection failure blocks render; UI cannot invent fallback geometry.

- [ ] **V1-021 Implement layout mapping and reset semantics** in document commands and
      projection.
  - **Acceptance**: Compatible placeholder content survives layout change; unmatched
    content becomes local; reset removes overrides and keeps content.
  - **Edges**: Duplicate roles, ordinal ambiguity, deleted layout, bound table/image.
  - **Containment**: Preview and atomic transaction; undo restores exact prior mapping.

- [ ] **V1-022 [P] Extract deterministic geometry** into `packages/geometry/`.
  - **Acceptance**: Move, resize, rotate, snap, align, distribute, group, and ungroup
    operate on canonical point frames without React/Electron imports.
  - **Edges**: Rotations, negative coordinates, partial off-page objects, mixed sizes,
    nested non-uniform groups, equal snap candidates.
  - **Containment**: Existing UI geometry remains behind a development-only comparison
    until parity tests pass.

- [ ] **V1-023 Add projection and geometry property suites**.
  - **Acceptance**: MST-001 through MST-006 and GEO-001 through GEO-006 pass; inputs are
    immutable and outputs never contain non-finite or non-positive dimensions.
  - **Edges**: Generated group nesting and selection deltas at supported limits.
  - **Containment**: Do not connect failing operations to UI or MCP.

**Checkpoint 2**: A canonical document deterministically produces render-ready slide
projections and geometry operations.

## Phase 3: Shared renderer and platform fidelity

- [ ] **V1-030 Complete `packages/renderer` contracts and object implementations**.
  - **Acceptance**: Semantic DOM renders text/images/tables; inline SVG renders shapes,
    connectors, icons, and flags; every mode consumes `ResolvedSlide`.
  - **Edges**: Every page preset, all shapes, hidden elements, opacity, crop, group,
    missing-but-valid optional resource warning.
  - **Containment**: No independent surface renderer; failing object type blocks release.

- [ ] **V1-031 Implement render readiness and asset capability loading**.
  - **Acceptance**: Ready requires bundled fonts, decoded images, two stable frames, and
    measured page geometry before its deadline.
  - **Edges**: Slow/decode-failed image, missing font, expired/cross-session asset URL,
    deadline and window close.
  - **Containment**: Typed `RENDER_NOT_READY`; never export partial output.

- [ ] **V1-032 Separate interaction overlay from slide content root**.
  - **Acceptance**: Selection, handles, guides, caret, locks, and presence are absent in
    thumbnail, presentation, HTML, and PDF DOM trees.
  - **Edges**: Active rich-text editor, multi-selection, remote pointer, text lock.
  - **Containment**: Disable affected non-editor mode until exclusion tests pass.

- [ ] **V1-033 Complete inherited `001` editor/presentation/PDF evidence**.
  - **Acceptance**: Relevant T001–T035 tasks receive real Windows results without
    marking unrelated work complete.
  - **Edges**: 1024 × 640, display scaling, portrait/ultrawide, offline resources.
  - **Containment**: `001` failure blocks V1 rendering claims.

- [ ] **V1-034 Add renderer component, visual, and security tests**.
  - **Acceptance**: RND-001 through RND-004 and applicable `001` thresholds pass.
  - **Edges**: All modes and elements; network/navigate/popup attempts.
  - **Containment**: Baseline changes require review and rationale, never auto-update.

**Checkpoint 3 — hard**: One renderer passes security, readiness, geometry, overlay,
and visual gates on Windows.

## Phase 4: Document runtime, history, and desktop bridge

- [ ] **V1-040 Create `packages/document-runtime` session and adapter ports**.
  - **Acceptance**: One session owns document, revision, history, durability, journal
    port, asset port, file fingerprint, and collaboration mode.
  - **Edges**: Multiple documents, same document in independent copies, session close,
    read-only newer document.
  - **Containment**: In-memory adapter first; no disk write until persistence checkpoint.

- [ ] **V1-041 Implement actor-aware bounded undo/redo and grouping**.
  - **Acceptance**: One gesture/edit/paste/MCP batch equals one history item; count and
    memory caps evict complete oldest groups.
  - **Edges**: Undo after remote/human interleave, asset delete, layout mapping, active
    text edit, stale undo.
  - **Containment**: Refuse incompatible undo instead of rewriting a later revision.

- [ ] **V1-042 Create versioned Zod-validated preload contracts** in desktop main and
      preload surfaces.
  - **Acceptance**: The `DesktopDocumentsV1` contract works end-to-end; undeclared IPC,
    unknown fields, oversized messages, and arbitrary paths are rejected.
  - **Edges**: Renderer reload, destroyed window, duplicate subscription, stale session.
  - **Containment**: Revoke session capabilities on window/process close.

- [ ] **V1-043 Host authoritative sessions in the Electron main process**.
  - **Acceptance**: Renderers receive snapshots/events and cannot mutate authoritative
    state except through validated commands.
  - **Edges**: Two renderer windows, presentation window, MCP client, remote command.
  - **Containment**: A crashed renderer leaves session and recovery state intact.

- [ ] **V1-044 Add session/history/IPC integration tests**.
  - **Acceptance**: CMD-004 through CMD-008 and SEC-003 through SEC-005 pass in packaged
    Electron, not a mocked browser alone.
  - **Edges**: Teardown races, invalid event order, large but allowed snapshot.
  - **Containment**: No UI cutover until contract suite passes.

**Checkpoint 4 — hard**: The main process is the only document authority and every
persistent edit route shares its revision-aware command bus.

## Phase 5: `.hdeck`, assets, save, autosave, and recovery

- [ ] **V1-050 Implement bounded `.hdeck` codec** under `packages/hdeck/`.
  - **Acceptance**: Manifest/document/assets round-trip with deterministic entry order,
    SHA-256 verification, supported limits, and typed newer-version result.
  - **Edges**: Traversal, absolute/NUL/backslash, symlink, duplicate/case collision,
    bomb, undeclared/missing entry, corrupt CRC/hash.
  - **Containment**: Reject before authoritative session creation.

- [ ] **V1-051 Implement image import and asset store** in desktop main/runtime.
  - **Acceptance**: PNG/JPEG/WebP signature, byte, dimension, decode, and hash validation;
    duplicates reuse content; original path is forgotten.
  - **Edges**: Wrong extension, extreme dimension, alpha, color profile, truncated data,
    cross-session capability.
  - **Containment**: Failed import creates neither asset ref nor element.

- [ ] **V1-052 Implement checksummed recovery journal** in `document-runtime`.
  - **Acceptance**: Accepted transactions append in bounded framed records; replay
    preserves a valid prefix and reports invalid tail.
  - **Edges**: Truncate every byte of final record, duplicate/out-of-order sequence,
    document/base mismatch, disk full.
  - **Containment**: Mismatch opens recovered independent copy, never source overwrite.

- [ ] **V1-053 Implement verified atomic save and fingerprint conflict handling** in
      desktop main.
  - **Acceptance**: Temp sibling is flushed, reopened, validated, destination fingerprint
    checked, and atomically replaced; target remains valid on every injected failure.
  - **Edges**: Read-only/vanished/full target, transient Windows lock, same timestamp but
    changed hash, user cancellation, existing target.
  - **Containment**: Keep target and journal; return conflict or retryable safe error.

- [ ] **V1-054 Implement autosave, compaction, recovery UX, and close decisions**.
  - **Acceptance**: Idle and max interval saves, durability labels, recovery candidate
    selection, Save/Discard/Cancel, and compaction-after-verified-snapshot work.
  - **Edges**: Continuous typing, presentation, active collaboration peer, crash during
    compaction, multiple candidates.
  - **Containment**: Autosave pauses in conflict/read-only; journal remains recoverable.

- [ ] **V1-055 Add archive, save, and recovery adversarial suites**.
  - **Acceptance**: ARC-001–005, SAV-001–005, and REC-001–004 pass, including 100 saves
    and 25 forced terminations.
  - **Edges**: Every failure injection point and supported limit boundary.
  - **Containment**: No pilot build until every hard case passes.

**Checkpoint 5 — hard**: Opening, migration, asset import, saving, conflict, crash, and
recovery cannot silently lose or overwrite supported user work.

## Phase 6: Approved editor cutover

- [ ] **V1-060 Freeze approved editor baselines and canonicalize the demo deck**.
  - **Acceptance**: Canonical UUID fixture reproduces reviewed chrome/content visuals;
    screenshots and DOM/accessibility baselines are recorded.
  - **Edges**: Supported window sizes and display scaling.
  - **Containment**: No visual redesign in the cutover change.

- [ ] **V1-061 Introduce renderer session provider and selectors**.
  - **Acceptance**: App reads immutable main-owned snapshots; selection, zoom, inspector,
    scroll, caret, and gesture draft remain local.
  - **Edges**: Active slide deletion, external revision, read-only state, reconnect.
  - **Containment**: Temporary projection may bridge canonical types to existing UI only.

- [ ] **V1-062 Convert every toolbar, inspector, menu, keyboard, and slide-list mutation
      to typed commands**.
  - **Acceptance**: Runtime spy proves all persistent UI changes call `execute`; Save,
    Undo, Redo, Present, and status state are real.
  - **Edges**: Locked selection, multi-selection, stale revision, empty deck protections.
  - **Containment**: Disable unsupported control rather than mutate locally.

- [ ] **V1-063 Convert canvas gestures to ephemeral drafts and one final commit**.
  - **Acceptance**: Pointermove does not change revision; pointerup/cancel commits or
    discards exactly one grouped transform.
  - **Edges**: Lost pointer capture, Escape, renderer revision during gesture, multi-
    selection edge clamp, rotated resize.
  - **Containment**: Revision conflict discards draft and refreshes snapshot visibly.

- [ ] **V1-064 Replace canvas and thumbnail content with shared renderer**.
  - **Acceptance**: Existing wrappers/chrome remain; content uses shared renderer modes;
    visual differences stay within approved thresholds.
  - **Edges**: Active editing overlay and missing asset warning.
  - **Containment**: Revert integration change, not renderer duplication.

- [ ] **V1-065 Remove fixture model and direct mutation paths**.
  - **Acceptance**: No release import of desktop fixture/model/private geometry; UI-003
    static and runtime checks pass.
  - **Edges**: Development startup and new-document template still work offline.
  - **Containment**: A fixture may remain only in test source, never release runtime.

**Checkpoint 6 — hard**: The approved UI is preserved, but the fixture is no longer a
source of truth and pointer previews never bypass transactions.

## Phase 7: Rich text and native content tools

- [ ] **V1-070 Integrate bounded headless rich-text editing** in the canvas overlay.
  - **Acceptance**: Paragraphs, H1–H6, lists, marks, bundled fonts, sizes, weights,
    alignment, and line spacing map losslessly to canonical rich text.
  - **Edges**: IME, emoji, RTL, long unbroken text, nested lists, active external update.
  - **Containment**: Cancel invalid local state; preserve last committed content.

- [ ] **V1-071 Implement safe clipboard normalization**.
  - **Acceptance**: Plain/rich text and supported list semantics import; scripts, remote
    resources, arbitrary styles, and unknown nodes are dropped.
  - **Edges**: Malformed HTML, oversized paste, mixed line endings, embedded data.
  - **Containment**: Fallback to bounded plain text or reject atomically.

- [ ] **V1-072 Implement native table editor and TSV paste**.
  - **Acceptance**: Rows, columns, cells, headers, fills, borders, alignment, and literal
    TSV persist, undo, save, and export.
  - **Edges**: Uneven rows, quoted newline, empty cell, formula prefix, max dimensions,
    row/column deletion with spans.
  - **Containment**: Invalid TSV/table operation changes nothing.

- [ ] **V1-073 Implement image controls**.
  - **Acceptance**: Import, replace, crop, fit, alt text, opacity, lock, layer, undo, save,
    presentation, HTML, and PDF agree.
  - **Edges**: Extreme aspect, crop leaving no content, duplicate asset, deleted asset.
  - **Containment**: Preserve old asset until replacement commits.

- [ ] **V1-074 Implement shapes, connectors, groups, layers, icons, and flags**.
  - **Acceptance**: Every V1 vector/catalog object inserts, edits, binds, reorders,
    groups, saves, and renders identically across modes.
  - **Edges**: Target delete/hide/group/rotate, missing catalog item, nested group.
  - **Containment**: Missing built-in becomes typed warning, never remote fallback.

- [ ] **V1-075 Implement theme, master, and layout editing modes**.
  - **Acceptance**: Users create/edit/apply themes, masters, layouts, placeholders,
    switch layouts, and reset overrides with visible mode/breadcrumb.
  - **Edges**: Attempt to delete last dependency, inherited locks, unmatched content.
  - **Containment**: Destructive dependency changes require preview and atomic remap.

- [ ] **V1-076 Complete content, accessibility, and visual suites**.
  - **Acceptance**: TXT, MST, AST, TBL, VEC, UI, and A11Y matrix rows pass.
  - **Edges**: Full keyboard and screen-reader smoke with every critical content type.
  - **Containment**: A content type does not ship if its round-trip/export gate fails.

**Checkpoint 7 — hard**: Every promised authoring feature works without code editing,
round-trips through `.hdeck`, and is keyboard-operable.

## Phase 8: Presentation, standalone HTML, and PDF

- [ ] **V1-080 Implement presentation lifecycle** in desktop main and presentation
      renderer.
  - **Acceptance**: Full-screen/target-display start, navigation, letterbox, hidden-slide
    policy, Escape, and editor-state restoration pass.
  - **Edges**: Portrait/ultrawide, missing display, zero eligible slides, host/peer mode.
  - **Containment**: Presentation failure closes only presentation window.

- [ ] **V1-081 Implement offline standalone HTML export** in `packages/export`.
  - **Acceptance**: Static output includes shared renderer, projection, local assets,
    restrictive CSP, and no authoring/filesystem/network capability.
  - **Edges**: Unicode, all assets, hidden slides, target conflict, cancellation.
  - **Containment**: Temp output removed; no partial directory/archive remains.

- [ ] **V1-082 Implement exact-page PDF export**.
  - **Acceptance**: Hidden print workflow waits for readiness, produces correct page
    boxes/backgrounds, and commits atomically with user-approved overwrite.
  - **Edges**: Render timeout, read-only/full/locked target, cancellation, mixed page
    presets at deck conversion boundary.
  - **Containment**: Remove temp and hidden window; return safe typed error.

- [ ] **V1-083 Run cross-surface fidelity and reliability suites**.
  - **Acceptance**: PRE, HTML, PDF, and EXP rows pass; 50 alternating exports leak no
    temp, process, handle, or hidden window.
  - **Edges**: Network disabled and all display scale factors.
  - **Containment**: Disable failing export mode; never fork rendering code.

**Checkpoint 8 — hard**: Presentation, HTML, and PDF are offline, secure, faithful,
ready-gated, and failure-clean.

## Phase 9: Local stdio MCP

- [ ] **V1-090 Define and generate MCP runtime schemas** in `packages/mcp-contracts`.
  - **Acceptance**: Read/mutation/output tools match `contracts.md`, have size limits,
    safe results, and no raw path/URL/HTML/shell/state capability.
  - **Edges**: Unknown tools/fields, oversized batches, closed/read-only document.
  - **Containment**: Schema mismatch fails before desktop connection or mutation.

- [ ] **V1-091 Implement packaged stdio server** in `apps/mcp`.
  - **Acceptance**: Initialize/list/call/shutdown works; stdout is protocol-only; stderr
    is redacted; partial and invalid frames do not desynchronize subsequent requests.
  - **Edges**: Client termination, concurrent calls, oversized/invalid JSON-RPC.
  - **Containment**: Terminate the client session without affecting desktop documents.

- [ ] **V1-092 Implement current-user desktop authentication and lifecycle**.
  - **Acceptance**: Per-launch nonce, current-user local channel, expiry, replay denial,
    and desktop absence errors pass.
  - **Edges**: Wrong user, reused nonce, app restart, multiple desktop instances blocked.
  - **Containment**: Revoke nonce and close channel on either process exit.

- [ ] **V1-093 Implement typed read and mutation tools through DocumentSession**.
  - **Acceptance**: Tools inspect, validate, preview, apply command batches, and create
    attributable undo history with expected revisions.
  - **Edges**: Stale conflict, invalid middle command, large outline, hidden slide.
  - **Containment**: Atomic rejection; no alternate patch path.

- [ ] **V1-094 Implement desktop approval capabilities**.
  - **Acceptance**: Delete, overwrite, import, save, HTML, and PDF approvals are purpose-
    bound, document-bound, expiring, single-use, and visible to the user.
  - **Edges**: Reuse, operation mismatch, app close, revision change after approval.
  - **Containment**: Default deny and revoke all outstanding approvals on restart.

- [ ] **V1-095 Complete MCP protocol, security, undo, and redaction tests**.
  - **Acceptance**: MCP-001 through MCP-008 pass against packaged binaries.
  - **Edges**: Fuzz framing and schemas; assert stdout and diagnostics content.
  - **Containment**: MCP mutations remain release-disabled until hard cases pass.

**Checkpoint 9 — hard**: MCP provides human-parity typed automation without arbitrary
machine or document internals access.

## Phase 10: Authoritative-host LAN collaboration

- [ ] **V1-100 Implement private-network discovery and session capabilities** in
      `packages/collaboration`.
  - **Acceptance**: Discovery is ephemeral and content-free; hosting defaults off on
    public/unknown networks; join requires expiring document-scoped proof.
  - **Edges**: Clock skew, replay, duplicate advertisement, network-class change.
  - **Containment**: Stop advertisement/session and keep local authoring available.

- [ ] **V1-101 Implement authenticated encrypted host/peer transport**.
  - **Acceptance**: Mutual session proof, bounded frames, rate/concurrency limits,
    heartbeat, safe errors, and actor confirmation pass.
  - **Edges**: Malformed frame, slow peer, oversized message, disconnect during join.
  - **Containment**: Drop only offending peer; never parse into document before validation.

- [ ] **V1-102 Implement authoritative host ordering and peer resync**.
  - **Acceptance**: Host validates expected revision, allocates monotonic sequence,
    journals, applies, then broadcasts; peers apply strictly in order.
  - **Edges**: Simultaneous independent commands, stale command, gap, duplicate, reorder.
  - **Containment**: Reject/resync peer; host document remains authoritative.

- [ ] **V1-103 Implement presence and direct-text soft locks**.
  - **Acceptance**: Presence is ephemeral/rate-limited; one actor owns a text edit lease;
    lock owner/expiry is visible; conflicting editor is read-only.
  - **Edges**: Simultaneous lock request, lease renewal, host/peer sleep, clock skew.
  - **Containment**: Expire lock and discard unaccepted draft, never merge same text.

- [ ] **V1-104 Implement reconnect, host-loss, and independent-copy behavior**.
  - **Acceptance**: Bounded reconnect resumes acknowledged sequence; expiry or host loss
    makes peer read-only; explicit independent copy gets a new document ID.
  - **Edges**: Local active draft, missing sequence, host killed during save, Drive lock.
  - **Containment**: No host election, queued offline edit, or shared overwrite.

- [ ] **V1-105 Enforce the single shared-file writer**.
  - **Acceptance**: Only host can save shared target; peer save requires leave/copy;
    fingerprint conflict still blocks host overwrite.
  - **Edges**: Peer invokes Ctrl+S/MCP save, host disappears, two hosts attempt same doc.
  - **Containment**: Read-only/copy decision, never dual writer.

- [ ] **V1-106 Complete LAN adversarial, multi-process, and soak tests**.
  - **Acceptance**: LAN-001 through LAN-012 and thirty-minute three-participant soak pass
    with identical accepted sequence/final hash and correct host snapshot.
  - **Edges**: Network loss, malformed peer, text contention, asset insertion, reconnect,
    host termination, public-network transition.
  - **Containment**: LAN hosting remains disabled in release until every hard row passes.

**Checkpoint 10 — hard**: Trusted peers collaborate on one ordered host state; there is
no disconnected merge, automatic failover, dual writer, or content-bearing discovery.

## Phase 11: Windows packaging and supported operation

- [ ] **V1-110 Add verified per-user Windows x64 packaging**.
  - **Acceptance**: Standard user installs without administrator rights; artifact
    provenance and SHA-256 hashes are recorded; Authenticode signatures verify when a
    release certificate is configured, otherwise the build is explicitly labelled
    unsigned and its Windows reputation warning is documented.
  - **Edges**: Unicode profile, long path, low disk, invalid/tampered signature.
  - **Containment**: Retain prior verified installer; never present an unsigned artifact
    as signed or weaken runtime security to suppress reputation warnings.

- [ ] **V1-111 Add single-instance `.hdeck` association**.
  - **Acceptance**: Explorer open routes an opaque capability to existing instance;
    malformed command lines/protocols are rejected.
  - **Edges**: Missing file, app starting concurrently, multiple files, future version.
  - **Containment**: Open dialog remains available; do not pass raw input to renderer.

- [ ] **V1-112 Implement explicit upgrade, rollback, repair, and uninstall behavior**.
  - **Acceptance**: Upgrade preserves decks/recovery/settings; rollback follows migration
    compatibility; uninstall preserves decks and separately confirms cache deletion.
  - **Edges**: Running app, open documents, pending recovery, locked binaries.
  - **Containment**: Cancel upgrade or restore prior verified binary; retain recovery.

- [ ] **V1-113 Run clean-machine Windows system matrix**.
  - **Acceptance**: PKG-001–007, SEC, A11Y, offline, display-scaling, and file association
    rows pass on recorded clean VM snapshots.
  - **Edges**: Non-admin, 100/125/150/200% scale, network disabled, reboot.
  - **Containment**: No supported binary release until exact artifact passes.

**Checkpoint 11 — hard**: The exact verified artifact installs, operates offline, opens
files safely, upgrades, rolls back when compatible, and uninstalls without user-data loss.

## Phase 12: Release hardening and ship

- [ ] **V1-120 Meet performance and capacity budgets**.
  - **Acceptance**: Warm start, command, gesture, LAN, presentation, 500-slide, 10,000-
    element, and 500 MiB supported-limit measurements meet `test-matrix.md`.
  - **Edges**: Long-running session, repeated save/export, memory pressure.
  - **Containment**: Reduce supported documented limit only through spec review before RC;
    never silently truncate.

- [ ] **V1-121 Complete license, asset provenance, notices, and SBOM review**.
  - **Acceptance**: Locked runtime/build graphs pass policy; every font/icon/round flag
    has license, provenance, notice, version, and SHA-256; CycloneDX matches distribution.
  - **Edges**: Generated code, optional binary, transitive license, duplicate asset.
  - **Containment**: Remove or replace unapproved component before release.

- [ ] **V1-122 Complete diagnostics, secret, and public-hygiene review**.
  - **Acceptance**: Source, fixtures, screenshots, logs, symbols, exports, installer, and
    crash diagnostics contain no secret/private context or deck/environment data.
  - **Edges**: Errors from archive, save, MCP, LAN, signing, and installer.
  - **Containment**: Redact/regenerate artifact; revoke any exposed capability/secret.

- [ ] **V1-123 Run full release matrix against the packaged candidate**.
  - **Acceptance**: Every hard row in `test-matrix.md`, `pnpm verify`, Windows visual,
    PDF, archive, recovery, MCP, LAN, installer, license, SBOM, and soak gate passes.
  - **Edges**: Re-run stored property/fuzz seeds and all prior release-blocking defects.
  - **Containment**: Any hard failure returns release to the owning phase; no waiver.

- [ ] **V1-124 Publish evidence and user documentation**.
  - **Acceptance**: README, security, architecture, operations, recovery, collaboration,
    MCP, installer, shortcuts, accessibility, changelog, roadmap, and notices describe
    actual shipped behavior and limitations.
  - **Edges**: Offline docs bundled; no private or competitive narrative.
  - **Containment**: Do not publish claims without recorded evidence.

- [ ] **V1-125 Tag and publish the verified V1 release**.
  - **Acceptance**: Repository tag, artifact hashes and signing status, release notes,
    SBOM, notices, known limitations, and rollback installer are available and match the
    tested build.
  - **Edges**: Download/hash verification and signature verification when configured
    from a clean machine.
  - **Containment**: Withdraw artifact and restore prior release if post-publish integrity
    differs; user decks and recovery remain compatible/read-only safe.

## Global hard release gates

The release is blocked if any of the following is true:

- direct fixture/renderer mutation survives in production;
- more than one slide renderer exists;
- document schema, archive, image, clipboard, IPC, MCP, or LAN input can exceed limits;
- save/recovery can remove the last valid state or silently overwrite external change;
- any renderer, document, peer, or tool can access arbitrary filesystem, shell, URL,
  script, raw HTML authoring, or remote asset capability;
- a peer edits while disconnected, same-text contention is merged, host election occurs,
  or more than one writer can replace the shared file;
- packaged Windows, visual/PDF, archive, fault-injection, MCP, LAN soak, accessibility,
  installer, license, SBOM, provenance, or public-hygiene evidence is absent or failing;
- a claimed V1 renderer/presentation/PDF capability depends on unfinished `001`
  acceptance evidence.

No V1 hard-gate waiver is permitted.
