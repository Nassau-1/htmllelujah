# Tasks: Professional Authoring and Persistent Agent Access

## Interaction foundation

- [x] **AUT-001** Add object clipboard serialization with fresh IDs and safe fallbacks.
- [x] **AUT-002** Implement `Ctrl+C`, `Ctrl+X`, `Ctrl+V` and focused paste routing.
- [ ] **AUT-003** Add the complete object context menu and keyboard-accessible
      equivalent.
  - [x] Checkpoint 2026-07-23: open object actions from pointer right-click and the
        keyboard context-menu gesture; expose copy, cut, paste, duplicate, layer, lock,
        and delete.
  - [x] Add visibility, grouping, focus entry, arrow-key traversal, and focus return.
  - [ ] Add optional contextual insertion shortcuts.
- [x] **AUT-004** Fix duplicate for placeholder-bound text and prevent phantom selection.
- [x] **AUT-005** Consolidate application menus and toolbar responsibilities.

## Slide, layout, and master parity

- [x] **AUT-010** Add an active authoring-container adapter.
- [x] **AUT-011** Enable text, shape, table, connector, local-icon, Twemoji, and Circle
      Flag insertion on all supported surfaces.
- [x] **AUT-012** Enable atomic user-image insertion/replacement on all surfaces.
- [x] **AUT-013** Enable transform, arrange, duplicate, delete, visibility, and lock on
      layouts and masters.
  - [x] Checkpoint 2026-07-23: route shared transform, arrange, duplicate, visibility,
        and lock actions through the active authoring-container adapter.
  - [x] Apply effective-lock rejection to every direct layout/master mutation and
        deletion entry point.
- [x] **AUT-014** Verify authoritative inheritance and effective-lock projection.
- [x] **AUT-015** Route the full text, shape, table, connector, image, and icon
      properties editor through the active slide/layout/master adapter.

## Themes and page furniture

- [x] **AUT-020** Add explicit blank and derived theme creation.
- [x] **AUT-021** Add one-transaction deck-wide theme enforcement.
  - [x] Keep the operation atomic and undoable beyond 100 styled objects through one
        canonical `theme.enforce-deck` command.
- [x] **AUT-022** Expose managed/inherited/local style state and reset controls.
  - [x] Checkpoint 2026-07-23: add a deterministic canonical helper that removes only
        theme-managed font/color overrides while preserving content, geometry,
        identifiers, bindings, and unrelated styling.
  - [x] Wire provenance labels plus reset-to-theme/layout actions into the properties
        panel for every supported authoring surface.
- [x] **AUT-023** Enable bounded custom page width and height.
- [x] **AUT-024** Add dynamic page/title/date/time fields.
- [x] **AUT-025** Add aligned page-number controls on masters.
- [x] **AUT-026** Add text/image watermark controls on masters.
  - [x] Import image assets and create the final locked watermark in one transaction
        and one undo step.

## Content catalogs

- [x] **AUT-030** Add a visual shape chooser before insertion.
- [x] **AUT-031** Add a searchable local-icon chooser.
- [x] **AUT-032** Bundle and expose a searchable offline Twemoji catalog.
- [x] **AUT-033** Bundle and expose searchable offline Circle Flags.
- [x] **AUT-034** Preserve catalog identity across save, reopen, HTML, PDF, presentation,
      and collaboration.
- [x] **AUT-035** Complete asset provenance, attribution, notice, and integrity checks.

## Persistent local agents

- [ ] **AUT-040** Define persistent trusted-client identities and scoped grant profiles.
  - [x] Checkpoint 2026-07-23: add stable Ed25519 identity, server-derived actor, and
        closed read/edit capability identifiers for the packaged compatibility client.
  - [ ] Add explicit user-approved named-profile enrollment and profile management.
- [ ] **AUT-041** Persist, list, and revoke current-user grants outside deck files.
  - [x] Checkpoint 2026-07-23: add bounded atomic registry/credential storage plus
        backend list and persistent revoke; visible enrollment/revocation UI remains.
- [x] **AUT-042** Exempt ordinary reversible trusted edits from one-time approval.
  - [x] Checkpoint 2026-07-23: allow ordinary commands and simulated non-removing
        theme/master/layout/element replacements without a receipt.
- [x] **AUT-043** Retain explicit approval for sensitive/external operations.
  - [x] Checkpoint 2026-07-23: bind destructive, undo, import, and export approval
        grants and receipts to the authenticated client.
- [x] **AUT-044** Add authoritative design-context inspection.
  - [x] Checkpoint 2026-07-23: expose paginated canonical inheritance, provenance,
        locks, placeholders, semantic themes, assets, constraints, and validation.
- [x] **AUT-045** Add design-aware typed theme/master/layout/page operations.
  - [x] Checkpoint 2026-07-23: translate a strict semantic operation union, bounded to
        20 operations per request, into at most 100 canonical commands with revision
        checks and effect-aware approval.
- [ ] **AUT-046** Add audit visibility, attribution, revision, revocation, and abuse tests.
  - [x] Checkpoint 2026-07-23: cover unknown/mismatched clients, actor injection,
        cross-client proposal/approval denial, persisted revocation, and safe design
        replacement classification; in-app audit visibility remains.

## Verification and delivery

- [x] **AUT-050** Run targeted unit and integration tests at each checkpoint.
  - [x] Target renderer catalogs, editor clipboard/factories/picker/image import,
        document design authority/dynamic fields, and MCP trusted-client/design
        operations in code-level tests.
- [ ] **AUT-051** Run one focused opened-Electron smoke for all reported user flows.
- [ ] **AUT-052** Run one final `pnpm verify` after implementation converges.
- [ ] **AUT-053** Update product, architecture, operations, decisions, changelog, TODO,
      and continuity documentation.
- [ ] **AUT-054** Commit and push coherent checkpoints to `main`.
  - [x] Checkpoint 2026-07-23: commit and push the remediation scope/specification.
  - [ ] Commit and push the converged implementation and verification evidence.
- [ ] **AUT-055** Build, package, and durably install the refreshed Windows x64
      candidate on this machine after AUT-051 and AUT-052 pass.
