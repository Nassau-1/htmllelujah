# Research: Platform Fidelity

Date: 2026-07-15.

This record captures the implementation decisions already settled for the fidelity
spike. It intentionally excludes unselected alternatives and competitive comparisons
from the public repository.

## Decision 1: Desktop runtime

**Decision**: Use Electron for the Windows desktop shell.

**Rationale**: The same bundled rendering runtime can power the editor, presentation
window, and exact-size print surface. It also supplies a testable process boundary for
offline file and window capabilities.

**Guardrails**: Renderer sandboxing, context isolation, disabled Node.js integration,
blocked navigation and remote content, a strict Content Security Policy, and a narrow
runtime-validated preload API are mandatory from the first executable build.

## Decision 2: Rendering composition

**Decision**: Render text, images, and tables with semantic DOM and render vector
objects with inline SVG. Keep selection and guide overlays outside slide content.

**Rationale**: DOM text supplies native shaping and accessibility, while SVG provides
crisp point-based vector geometry. Separating overlays guarantees that presentation
and export cannot accidentally include editing chrome.

## Decision 3: One renderer contract

**Decision**: Editor canvas, thumbnail, presentation, and PDF surfaces call one pure
renderer with explicit mode and scale parameters.

**Rationale**: Shared layout code reduces drift and makes visual comparison a direct
contract rather than a manual approximation.

**Rejected direction**: Independent renderer implementations per output surface.
That would duplicate text metrics, readiness handling, and geometry behavior.

## Decision 4: Point geometry and page presets

**Decision**: The fidelity fixtures use points: 960 x 540 for 16:9, 720 x 540 for
4:3, and 841.89 x 595.28 for A4 landscape.

**Rationale**: Points map directly to physical PDF dimensions and provide a stable
canonical coordinate space. Screen zoom applies one transform to the complete page.

## Decision 5: Explicit render readiness

**Decision**: A surface becomes printable only after bundled fonts are ready, images
decode, two animation frames complete, and measured page geometry matches the request.

**Rationale**: Window load completion alone does not guarantee stable font metrics or
decoded imagery. A bounded handshake makes partial export a typed failure instead of
an intermittent visual defect.

## Decision 6: Fidelity verification

**Decision**: Combine geometry assertions, reviewed Windows visual baselines, and PDF
page/raster tests.

**Rationale**: Pixel comparison catches visual drift but is sensitive to
anti-aliasing. Point-bound assertions catch geometric drift independently. PDF
page-box inspection proves output dimensions without relying only on screenshots.

**Thresholds**: 0.25 points per object edge, 0.1 points per PDF page dimension, and
1.5% differing pixels after documented anti-aliasing masks on the reference machine.

## Decision 7: Temporary fixture boundary

**Decision**: The spike uses immutable synthetic `FidelityFixture` data and does not
introduce the persistent deck schema.

**Rationale**: It isolates rendering risk from schema and persistence decisions. The
fixture contract is deliberately named and replaced when document core is introduced,
preventing a proof-of-concept shape from becoming an accidental public format.
