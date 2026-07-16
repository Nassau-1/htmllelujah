# ADR-009: Keep Connector Endpoints in Immediate-Container Coordinates

- Status: Accepted
- Date: 2026-07-16
- Last reviewed: 2026-07-16

## Context

Connectors must paint identically in the editor, thumbnails, presentation, HTML, and
PDF while also supporting bindings, hit testing, alignment, distribution, grouping,
undo, and older V2 archives. A connector has both an editing frame and two endpoint
fallbacks. Treating the frame rotation as an additional paint transform after endpoint
coordinates have already been transformed rotates the line twice. Using the stored
frame as its visual bounds also becomes incorrect as soon as a bound target moves.

## Decision

Store each connector fallback endpoint as a final absolute point in the connector's
immediate container coordinate space. The frame is its affine editing basis; its
rotation has already been applied to persisted endpoint coordinates and is never
applied again by a renderer. Pre-marker V2 documents already use this representation.
Opening them may stamp `geometryVersion: 2`, but must not alter either endpoint.

Resolve a bound endpoint from the target's effective rotated anchor in document space,
then transform that point back into the connector's immediate container. Document
commands and the shared renderer use equivalent resolvers, with cross-package parity
tests for nested, scaled, and rotated groups. Hitboxes, alignment, distribution, and
group bounds use resolved painted endpoints rather than a stale connector frame.

An intentional whole-connector move, resize, rotation, alignment, or distribution
first materializes both painted endpoints, releases their bindings atomically, and
then applies the requested affine transform. This makes the visible result match the
command and its preview. Moving or rotating a target object does not transform the
connector itself, so its binding remains live. Manually releasing an endpoint or
deleting its target materializes that endpoint before the binding is removed.

Grouping and ungrouping are coordinate-space changes, not connector relocation. They
preserve bindings and transform fallback endpoints exactly once. Groups do not clip
connector paths that legitimately extend beyond another child's frame.

Generic whole-element replacement cannot mutate a group's child array. Child inserts,
updates, and deletes must target that group through the dedicated element or connector
commands and `containerId`, so binding materialization and deletion semantics cannot be
bypassed by replacing an ancestor.

## Consequences

- A direct connector relocation intentionally converts attached endpoints to free
  endpoints; the inspector can attach them again explicitly.
- Moving a connected shape continues to move the painted endpoint without rewriting
  the connector fallback on every target gesture.
- Undo restores the exact prior bindings, frames, and endpoint coordinates because the
  materialization and transform occur in one document transaction.
- Compatibility readers and renderers must treat a missing geometry marker as the same
  final-point representation, not as permission to rotate endpoints.

## Rejected options

- Applying `frame.rotationDeg` while painting: existing transformed endpoints would be
  rotated twice.
- Using only stored frames for connector bounds: bound targets can move independently,
  making alignment, grouping, and hit testing visibly wrong.
- Keeping bindings during direct whole-connector relocation: a fully bound connector
  cannot satisfy the requested visual transform and would appear to ignore the user.
- Releasing bindings during group or ungroup: reparenting alone should not change the
  diagram's semantic connections.
