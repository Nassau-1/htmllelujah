# Tasks: Professional Authoring and Persistent Agent Access

## Interaction foundation

- [ ] **AUT-001** Add object clipboard serialization with fresh IDs and safe fallbacks.
- [ ] **AUT-002** Implement `Ctrl+C`, `Ctrl+X`, `Ctrl+V` and focused paste routing.
- [ ] **AUT-003** Add the object context menu and keyboard-accessible equivalent.
- [ ] **AUT-004** Fix duplicate for placeholder-bound text and prevent phantom selection.
- [ ] **AUT-005** Consolidate application menus and toolbar responsibilities.

## Slide, layout, and master parity

- [ ] **AUT-010** Add an active authoring-container adapter.
- [ ] **AUT-011** Enable text, shape, table, connector, and local-icon insertion on all
      supported surfaces.
- [ ] **AUT-012** Enable atomic user-image insertion/replacement on all surfaces.
- [ ] **AUT-013** Enable transform, arrange, duplicate, delete, visibility, and lock on
      layouts and masters.
- [ ] **AUT-014** Verify authoritative inheritance and reset behavior.

## Themes and page furniture

- [ ] **AUT-020** Add explicit blank and derived theme creation.
- [ ] **AUT-021** Add one-transaction deck-wide theme enforcement.
- [ ] **AUT-022** Expose managed/inherited/local style state and reset controls.
- [ ] **AUT-023** Enable bounded custom page width and height.
- [ ] **AUT-024** Add dynamic page/title/date/time fields.
- [ ] **AUT-025** Add aligned page-number controls on masters.
- [ ] **AUT-026** Add text/image watermark controls on masters.

## Content catalogs

- [ ] **AUT-030** Add a visual shape chooser before insertion.
- [ ] **AUT-031** Add a searchable local-icon chooser.
- [ ] **AUT-032** Bundle and expose a searchable offline Twemoji catalog.
- [ ] **AUT-033** Bundle and expose searchable offline Circle Flags.
- [ ] **AUT-034** Preserve catalog identity across save, reopen, HTML, PDF, presentation,
      and collaboration.
- [ ] **AUT-035** Complete asset provenance, attribution, notice, and integrity checks.

## Persistent local agents

- [ ] **AUT-040** Define persistent trusted-client identities and scoped grant profiles.
- [ ] **AUT-041** Persist, list, and revoke current-user grants outside deck files.
- [ ] **AUT-042** Exempt ordinary reversible trusted edits from one-time approval.
- [ ] **AUT-043** Retain explicit approval for sensitive/external operations.
- [ ] **AUT-044** Add authoritative design-context inspection.
- [ ] **AUT-045** Add design-aware typed theme/master/layout/page operations.
- [ ] **AUT-046** Add audit visibility, attribution, revision, revocation, and abuse tests.

## Verification and delivery

- [ ] **AUT-050** Run targeted unit and integration tests at each checkpoint.
- [ ] **AUT-051** Run one focused opened-Electron smoke for all reported user flows.
- [ ] **AUT-052** Run one final `pnpm verify` after implementation converges.
- [ ] **AUT-053** Update product, architecture, operations, decisions, changelog, TODO,
      and continuity documentation.
- [ ] **AUT-054** Commit and push coherent checkpoints to `main`.
