# Tasks: Platform Fidelity

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md)

**Required gate**: `pnpm verify` plus Windows desktop and visual suites

## Format

Each task uses `[ID] [P?] [Story?] Description with named surface`. `[P]` indicates
work that can proceed in parallel after its phase dependencies are complete.

## Phase 1: Workspace and contracts

- [ ] T001 Add the desktop and renderer workspace manifests with strict TypeScript,
      explicit Electron entry points, and no production dependency outside the retained
      license policy in `apps/desktop/package.json` and `packages/renderer/package.json`.
- [ ] T002 Define immutable page presets, fidelity fixture objects, `RenderMode`,
      `RenderRequest`, and `RenderResult` in `packages/renderer/src/contracts.ts` and
      `packages/renderer/src/fixtures.ts`.
- [ ] T003 [P] Add fixture immutability, preset-dimension, and public-data tests in
      `packages/renderer/tests/contracts.test.ts`.
- [ ] T004 [P] Add three-layer visual tokens and bundled-font declarations in
      `apps/desktop/src/renderer/styles/tokens.css` with no remote resource reference.

**Checkpoint**: Pure contracts compile, tests prove expected page dimensions, and
fixture content is synthetic and safe to publish.

## Phase 2: Shared renderer foundation

- [ ] T005 Implement the mode-independent page root and point-to-screen scaling in
      `packages/renderer/src/SlideRenderer.tsx` without desktop imports or source-data
      mutation.
- [ ] T006 Implement semantic DOM text/image objects and inline SVG vector objects in
      `packages/renderer/src/objects/`, preserving canonical bounds at every required
      zoom.
- [ ] T007 Implement font, image, two-frame, and geometry readiness checks with a
      bounded deadline in `packages/renderer/src/readiness.ts`.
- [ ] T008 [P] Add geometry, mode, DOM/SVG split, overlay-exclusion, and readiness
      tests in `packages/renderer/tests/`.
- [ ] T009 [P] Add stable test hooks and content-free `RenderResult` timing/warning
      output in `packages/renderer/src/SlideRenderer.tsx`.

**Checkpoint**: One pure renderer displays all three page presets, passes geometry
tests, and exposes a deterministic readiness result.

## Phase 3: User Story 1 — Editor workspace (P1)

- [ ] T010 [US1] Create secure main, preload, and renderer bootstrap entry points in
      `apps/desktop/src/main/`, `apps/desktop/src/preload/`, and
      `apps/desktop/src/renderer/` with sandbox, context isolation, and Node.js integration
      disabled.
- [ ] T011 [US1] Implement runtime-validated `DesktopBridgeV1` application-info
      capability and expose no general IPC method in `apps/desktop/src/preload/bridge.ts`.
- [ ] T012 [US1] Build the title/menu row, contextual toolbar, thumbnail rail,
      pasteboard, slide canvas, inspector, and status bar in
      `apps/desktop/src/renderer/workspace/`.
- [ ] T013 [US1] Implement 25%, 50%, 75%, 100%, 125%, 150%, 200%, and Fit zoom as one
      page transform in `apps/desktop/src/renderer/workspace/SlideViewport.tsx`.
- [ ] T014 [US1] Implement the 1024 x 640 responsive-collapse rule and accessible
      names, landmarks, focus order, and visible focus in the workspace components.
- [ ] T015 [US1] Deny external navigation, popups, permissions, unsafe protocols, and
      remote requests in `apps/desktop/src/main/security-policy.ts` and the application
      Content Security Policy.
- [ ] T016 [P] [US1] Add workspace layout, zoom geometry, narrow-window, accessibility,
      offline-start, and process-isolation tests under `apps/desktop/tests/e2e/`.

**Checkpoint**: User Story 1 runs offline in a sandboxed Windows app and passes its
independent geometry, accessibility, and security tests.

## Phase 4: User Story 2 — Presentation surface (P2)

- [ ] T017 [US2] Add validated presentation open/close contracts and typed error
      mapping in `apps/desktop/src/preload/bridge.ts`.
- [ ] T018 [US2] Implement presentation-window lifecycle and renderer request handoff
      in `apps/desktop/src/main/presentation-window.ts`.
- [ ] T019 [US2] Render the shared slide root without editor overlays and add
      aspect-preserving letterboxing in `apps/desktop/src/renderer/presentation/`.
- [ ] T020 [US2] Restore editor zoom and scroll state after presentation exit in
      `apps/desktop/src/renderer/workspace/`.
- [ ] T021 [P] [US2] Add presentation lifecycle, Escape, letterbox, overlay-exclusion,
      and editor-state restoration tests under `apps/desktop/tests/e2e/presentation/`.

**Checkpoint**: User Story 2 independently opens and exits a presentation window
whose slide pixels and object bounds match the editor canvas.

## Phase 5: User Story 3 — PDF proof (P3)

- [ ] T022 [US3] Add `choosePdfTarget` and `exportPdf` bridge schemas with opaque,
      expiring target tokens in `apps/desktop/src/preload/bridge.ts` and
      `apps/desktop/src/main/export-targets.ts`.
- [ ] T023 [US3] Implement the hidden trusted print window, shared renderer handoff,
      readiness deadline, exact `@page`, print backgrounds, and CSS page-size preference
      in `apps/desktop/src/main/pdf-export.ts`.
- [ ] T024 [US3] Implement temporary sibling output, atomic rename, explicit overwrite
      approval, cancellation, and cleanup in `apps/desktop/src/main/pdf-export.ts`.
- [ ] T025 [US3] Map readiness, resource, target, overwrite, and invalid-request
      failures to content-free error codes in `apps/desktop/src/main/errors.ts`.
- [ ] T026 [P] [US3] Add 16:9, 4:3, and A4-landscape page-box tests plus failure and
      cancellation cleanup tests under `apps/desktop/tests/e2e/pdf/`.
- [ ] T027 [P] [US3] Add a twenty-export reliability test that checks partial files,
      hidden windows, and orphaned processes under `apps/desktop/tests/e2e/pdf/`.

**Checkpoint**: User Story 3 independently exports exact one-page PDFs and leaves no
partial output after success, cancellation, timeout, or failure.

## Phase 6: Cross-surface fidelity and release gate

- [ ] T028 Add Windows-only screenshot and PDF raster helpers in `tests/visual/` with
      explicit anti-aliasing masks and a 1.5% difference threshold.
- [ ] T029 Capture and human-review HTMLlelujah editor, presentation, and PDF baselines
      for every page preset in `tests/visual/baselines/`; do not reuse concept images with
      an obsolete product name.
- [ ] T030 Add measured-bound assertions with 0.25-point edge tolerance and PDF
      page-box assertions with 0.1-point tolerance in `tests/visual/`.
- [ ] T031 Add a network-denied end-to-end test covering launch, presentation, and PDF
      export in `apps/desktop/tests/e2e/security/`.
- [ ] T032 Add diagnostic-redaction tests proving fixture text, paths, and image data
      are excluded in `apps/desktop/tests/e2e/diagnostics.test.ts`.
- [ ] T033 Run `pnpm verify`, the Windows Electron suite, and visual comparison suite;
      record reference-machine measurements in `specs/001-platform-fidelity/results.md`.
- [ ] T034 Update `CHANGELOG.md`, `TODO.md`, `docs/architecture.md`,
      `docs/operations.md`, and `THIRD_PARTY_NOTICES.md` to match the implemented dependency
      graph and verified behavior.
- [ ] T035 Re-run the constitution check in `plan.md` and block document-core/editor
      integration until all unexplained security, geometry, readiness, and fidelity
      failures are resolved.

## Dependencies and execution order

- Phase 1 has no feature dependency.
- Phase 2 depends on the contracts in Phase 1.
- User Story 1 depends on Phase 2 and is the first independently demonstrable slice.
- User Story 2 depends on the secure shell and shared renderer, not on PDF work.
- User Story 3 depends on the secure shell and render-ready contract, not on
  presentation UI.
- Presentation and PDF work may proceed in parallel after User Story 1's process
  boundary is stable.
- Cross-surface baselines begin only after all three stories pass their independent
  checkpoints.

## Parallel opportunities

- T003 and T004 can run in parallel after the manifests and contract locations exist.
- T008 and T009 can run in parallel with renderer composition after contracts settle.
- T016 can be developed alongside workspace components from published acceptance
  hooks.
- T021 can proceed independently from T026 and T027.
- T028 and T031 can start once the presentation and PDF entry points are callable.

## Completion rule

The feature is complete only when T001–T035 are checked, the measurable success
criteria in `spec.md` have evidence, and no editing, persistence, MCP, or collaboration
implementation has been added opportunistically to this feature path. Parallel
isolated foundations do not count as completion evidence.
