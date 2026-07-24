# Useful PowerPoint Parity — Execution Plan

Status: **In progress**, started 2026-07-24.

This plan implements the approved requirements in bounded checkpoints. Each checkpoint
gets focused tests when it lands. The long Windows candidate and LAN campaigns run once,
after the implementation has converged.

## Checkpoint 1 — Catalogs and truthful chrome

- [x] Add a paged catalog query contract with exact `total`, `offset`, `limit`, and
      `hasMore`, while keeping legacy callers compatible.
- [x] Add explicit `Business` and `All` emoji scopes. The default Business scope excludes
      faces, animals, food, and sport and favors transport, places/buildings, work
      objects, documents, tools, cameras, finance, technology, clocks, signals, arrows,
      operators, and geometric symbols.
- [x] Make all 3,720 Twemoji and 265 circular flags reachable with no silent cap, while
      keeping at most 144 result cards mounted.
- [x] Add accurate range/total copy, page controls, exhaustive normalized search, stable
      ordering, and logical accessibility positions.
- [x] Remove the static marketing badge; replace raw durability enums with tested,
      user-facing save/recovery states.
- [x] Replace prompt-based deck rename with inline rename, separate the initial deck name
      from the first title placeholder, and make recovered sessions require Save As.
- [x] Rename `Codex` to `MCP`/`Agent access` and `Share` to `Collaborate`, with truthful
      availability/connection and LAN-host wording.
- Verification: renderer catalog unit tests, desktop status/rename component tests,
  typecheck for affected workspaces, and one short source-window smoke.

## Checkpoint 2 — Agent-native workflow

- [x] Create and validate the repository-owned `htmllelujah-presentations` skill.
- [x] Add MCP onboarding that exposes persistent client setup, connected clients,
      revocation, design authority, and safe capability boundaries.
- [x] Add bounded save-to-current-authorized-target support or clearly require human Save
      when no safe current-target operation is possible. Save As/import/export/trust
      changes remain desktop-approved.
- [x] Route attributed agent transactions through the authoritative LAN host, or expose a
      clear explicit read-only state instead of silently suspending mutations.
- Verification: skill validation and forward test, MCP contract tests, revision/undo
  tests, and packaged-MCP smoke at the final checkpoint only.

## Checkpoint 3 — Classic editing, vectors, and images

- [x] Expand the useful basic-shape palette without adding novelty catalogs.
- [x] Unify line/arrow creation and expose both endpoint caps, width, dash, and color.
- [x] Add direct connector endpoint handles, five-point anchor discovery/snap, and
      detach while preserving attachment under target move/resize/rotation.
- [x] Add curved connector routing; straight, elbow, and bounded cubic routing now share
      the canonical endpoint/binding model and renderer.
- [x] Add bounded open/closed freeform paths and edit-points mode.
- [x] Add Union, Combine, Fragment, Intersect, and Subtract as one undoable transaction,
      with structured no-loss rejection for unsupported geometry and holes.
- [ ] Evaluate bounded 2.5D extrusion only after vector parity is stable.
- [x] Add direct image crop handles; numeric crop and contain/cover/fill remain available.
- [x] Add non-destructive color-key transparency with
      white/black presets, eyedropper, tolerance, preview, apply, and reset.
- [x] Route safe external clipboard images, including pasted spreadsheet ranges/charts,
      into deterministic embedded assets.
- [x] Add one-transaction `Swap positions` for two objects and `Match size to primary`
      for a multi-selection on slides, layouts, and masters.
- [x] Add lossless vector/path/connector flip and compatible text/vector/image/table
      format painting; unsupported targets fail atomically.
- Verification: geometry/property tests, model migration/save-reopen tests, renderer
  parity snapshots, clipboard budget rejects, and focused interaction smoke.

## Checkpoint 4 — Design authority

- [x] Consolidate theme gallery/creation/enforcement, semantic colors/fonts, page format,
      masters, layouts, placeholders, page furniture, numbers, and watermarks in Design.
- [x] Give each new text box a visible Title, Subtitle, Body, Caption, or Free text role.
- [x] Preserve explicit local overrides while theme-managed values update on theme switch.
- [x] Distinguish inherited, locked, theme-managed, and local objects in every relevant
      surface.
- Verification: theme-switch tests, master/layout inheritance tests, lock/undo tests,
  save-reopen tests, and renderer/export parity checks.

## Checkpoint 5 — Review, spelling, and LAN onboarding

- [x] Add slide- and object-anchored comment threads with replies, resolve/reopen, unread
      state, persistence, and LAN synchronization; exclude them from rendered outputs.
- [x] Add deck/text language and text-edit context-menu suggestions, replace, ignore, and
      local dictionary operations without displacing the object context menu.
- [x] Add versioned copyable LAN invitation data containing only the endpoint, session
      code, and host fingerprint, with strict paste validation and one authoritative
      writer.
- [ ] Evaluate opt-in discovery by shared-file identity; synchronized local replicas must
      never auto-join by path alone.
- Verification: comment migration/collaboration/export-exclusion tests, spellcheck IPC
  tests, and short two-instance collaboration checks.

## Checkpoint 6 — PowerPoint/POTX import

- [x] Add bounded ZIP/XML parsing and a preview-first `.pptx`/`.potx` design inventory
      that rejects active content, external relationships, DTDs, oversized input, and
      unsafe archive structures.
- [x] Build the native Phase 1 import plan for page size, theme colors/fonts, masters,
      layouts, placeholders, backgrounds, page numbers, and supported page furniture.
      Applying that plan is one bounded canonical transaction; final integrated desktop
      acceptance remains part of the converged-app verification.
- [ ] Import the supported slide subset: styled text/lists, basic vectors/connectors,
      images, tables, groups, and z-order.
- [x] Produce an explicit imported/substituted/rasterized/unsupported fidelity report and
      never mutate the source or silently drop unsupported content.
- [ ] Add synthetic public fixtures for multiple masters/layouts and hostile archive/XML
      limits.
- Verification: fixture corpus, cancellation/no-mutation tests, archive/XML adversarial
  tests, fidelity report tests, and save-reopen/render parity.

## Final integrated checkpoint

- [ ] Run formatting, catalog checks, affected package tests/typechecks, then one complete
      `pnpm verify`.
- [ ] Run one consolidated opened-app smoke after all features converge.
- [ ] Build and durably install the refreshed Windows x64 candidate.
- [ ] Run the complete candidate/LAN campaign once, record remaining evidence gaps, update
      changelog/TODO/continuity, then commit and push `main`.
