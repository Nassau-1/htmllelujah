# Implementation Plan: Platform Fidelity

**Branch**: `001-platform-fidelity` | **Date**: 2026-07-15 | **Spec**: [spec.md](spec.md)

## Summary

Build a secure Electron desktop skeleton and a pure shared DOM/SVG renderer around
immutable synthetic fixtures. Use the same renderer in the editor canvas,
presentation window, and hidden PDF print window. Establish exact point geometry,
resource readiness, offline operation, accessibility, process isolation, and visual
comparison before authoring foundations are integrated. Parallel document-core and
desktop-interaction prototypes remain isolated and cannot satisfy this feature's
acceptance criteria.

## Technical Context

- **Language**: TypeScript 7 in strict mode.
- **Runtime**: Node.js 24 in trusted desktop processes; sandboxed Chromium renderer.
- **Desktop**: Electron with isolated main, preload, and renderer entry points.
- **UI**: React with locally bundled assets and CSS design tokens.
- **Build**: Vite-based desktop and package builds in the existing pnpm workspace.
- **Testing**: Vitest for pure contracts and Playwright for Electron, screenshots,
  security boundaries, and PDF workflows.
- **Target**: Windows 11 x64; offline after dependencies are installed.
- **Performance**: packaged warm interactive start at or below a 4,000 ms blocking
  ceiling on the reference pilot machine, with a separately reported 3,000 ms
  optimization target.
- **Constraints**: no arbitrary HTML, remote assets, persistence, document mutations,
  MCP, or collaboration in this feature.

## Constitution Check

| Principle                    | Plan evidence                                                              | Result |
| ---------------------------- | -------------------------------------------------------------------------- | ------ |
| Structured source            | Immutable typed fixtures are explicitly temporary; no HTML authoring path  | Pass   |
| Local-first and safe         | Bundled resources, sandbox, narrow validated preload, network-denied tests | Pass   |
| Human and agent parity       | No mutation surface is introduced; future command bus is not bypassed      | Pass   |
| Verifiable fidelity          | One renderer, render-ready handshake, geometry and visual comparisons      | Pass   |
| Public hygiene and licensing | Synthetic fixtures, approved dependencies only, no private assets          | Pass   |

Re-run this check if implementation introduces a new IPC method, dependency,
renderer path, output format, or fixture source.

## Project Structure

### Documentation for this feature

```text
specs/001-platform-fidelity/
├── spec.md
├── plan.md
├── research.md
└── tasks.md
```

### Intended source surfaces

```text
apps/desktop/
├── src/main/             # lifecycle, policy, presentation, PDF export
├── src/preload/          # validated versioned bridge
├── src/renderer/         # workspace shell and view composition
└── tests/e2e/            # desktop, security, presentation, and export flows

packages/renderer/
├── src/contracts.ts      # RenderRequest, RenderResult, render modes
├── src/fixtures.ts       # immutable public-safe fidelity fixtures
├── src/SlideRenderer.tsx # shared DOM/SVG content root
├── src/readiness.ts      # fonts/images/layout readiness
└── tests/                # unit, geometry, and component coverage

tests/visual/
├── baselines/            # reviewed Windows reference images
└── pdf/                  # page-box and raster comparison helpers
```

No persistent schema or editing package is created as a deliverable of this feature.
Existing parallel foundations remain outside this feature path until a later spec
defines their integration with the shared renderer.

## Implementation approach

### 1. Establish the renderer contract

Define immutable fixture, page, object, render-mode, readiness, and result types in
`packages/renderer`. Use point geometry throughout the projection. Implement a pure
slide root whose DOM/SVG children depend only on its request. Add invariant tests for
object bounds and input immutability.

### 2. Build the approved workspace

Implement the title/menu row, contextual toolbar, thumbnail rail, pasteboard, slide,
inspector, and status bar with layered CSS tokens. Preserve the restrained white,
cool-gray, charcoal, and cobalt visual language. Use CSS grid for application chrome
and a single transform for slide zoom. At narrow supported sizes, collapse the
inspector before the thumbnail rail.

### 3. Harden the process boundary

Create main, preload, and renderer entry points with production-equivalent security
settings in development. Define runtime schemas for bridge calls. Deny navigation,
popups, permissions, remote requests, unsafe protocols, and undeclared IPC. Keep
target paths entirely in the main process and return content-free result metadata.

### 4. Reuse the renderer for presentation and PDF

Create a presentation window that receives a serialized immutable render request and
letterboxes the shared slide root. Create a hidden print window that loads the same
root, waits for a bounded `renderReady`, applies exact `@page` geometry, generates
the PDF, and commits it through a temporary sibling file plus atomic rename.

### 5. Lock verification before feature expansion

Add geometry assertions, desktop security tests, network-denied startup, keyboard
smoke tests, presentation comparisons, PDF page-box inspection, raster comparisons,
and repeated-export cleanup checks. Capture baselines only on the designated Windows
environment and require review before committing changes.

## Interfaces introduced

```ts
type RenderMode = 'editor' | 'thumbnail' | 'presentation' | 'pdf';

type RenderRequest = Readonly<{
  fixtureId: string;
  page: Readonly<{ widthPt: number; heightPt: number }>;
  mode: RenderMode;
  scale: number;
  readinessDeadlineMs: number;
}>;

type RenderResult = Readonly<{
  rendererVersion: 1;
  ready: boolean;
  page: Readonly<{ widthPt: number; heightPt: number }>;
  warnings: readonly string[];
  durationMs: number;
}>;

type DesktopBridgeV1 = Readonly<{
  getAppInfo(): Promise<{ version: string; platform: 'win32' }>;
  openPresentation(request: RenderRequest): Promise<{ windowId: string }>;
  closePresentation(windowId: string): Promise<void>;
  choosePdfTarget(): Promise<{ targetToken: string } | null>;
  exportPdf(input: {
    targetToken: string;
    request: RenderRequest;
    overwriteApproved: boolean;
  }): Promise<{ pageCount: 1; widthPt: number; heightPt: number; durationMs: number }>;
}>;
```

`targetToken` is an opaque, short-lived main-process capability. The renderer never
receives or submits an arbitrary output path.

## Error and recovery behavior

- Readiness timeout returns `RENDER_NOT_READY`; no print call occurs.
- Resource validation failure returns `RESOURCE_INVALID`; the failed resource is not
  replaced by remote content.
- A vanished or read-only target returns `TARGET_UNAVAILABLE`; the temporary file is
  removed.
- Existing target without approval returns `OVERWRITE_REQUIRES_APPROVAL`.
- Presentation process failure closes only that window and keeps editor state alive.
- Any rejected bridge payload returns `INVALID_REQUEST` without exposing internals.

## Verification plan

- Unit: type guards, fixtures, point geometry, scale invariance, input immutability,
  readiness success/timeout, diagnostic redaction.
- Component: DOM/SVG split, overlay exclusion, page presets, narrow layout, accessible
  controls.
- Desktop integration: security preferences, blocked navigation/popup/permission,
  undeclared IPC, offline startup, presentation lifecycle, output cancellation and
  atomic commit.
- Fidelity: bounds within 0.25 points; reviewed Windows image diffs under 1.5%; PDF
  page boxes within 0.1 points.
- Reliability: twenty sequential exports with no partial file, hidden window, or
  orphaned process.
- Gate: `pnpm verify` plus the Windows desktop and visual suites.

## Rollback and containment

This feature introduces no authoring data and therefore needs no data rollback.
Presentation and PDF entry points remain independently disableable while the editor
fixture shell is tested. If process isolation, remote-request denial, geometry, or
resource readiness fails, document-core and editor-prototype integration remains
blocked.

## Definition of done

- All functional requirements and success criteria have automated evidence or a
  documented manual Windows check.
- Visual baselines use the HTMLlelujah name and synthetic public-safe content.
- The constitution check still passes after implementation.
- Architecture, operations, changelog, roadmap, and third-party notices reflect the
  actual implementation.
- No persistence, editing, MCP, or collaboration behavior has leaked into this
  spike; parallel isolated prototypes do not count as spike acceptance evidence.
