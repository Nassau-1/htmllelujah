# ADR-001: Use a Structured Document as the Authoring Source

- Status: Accepted
- Date: 2026-07-15

## Context

Presentations must be editable by people, automatable by agents, recoverable after a
crash, and renderable consistently across editor, presentation, HTML, and PDF
surfaces. Arbitrary HTML and CSS do not provide stable object identities, bounded
capabilities, deterministic style inheritance, or a safe transactional mutation
model.

## Decision

The canonical authoring state is a typed, versioned document with stable UUIDs,
explicit geometry, a closed element union, and deterministic theme-to-element style
resolution. All persistent edits pass through a validated command bus and atomic
transactions.

DOM, SVG, standalone HTML, and PDF are derived projections. Exported HTML is not a
supported authoring input. Imported Markdown, rich text, SVG, and images are parsed
or sanitized into the structured model before persistence.

## Consequences

- Human and agent edits use the same validation, revision, attribution, and undo
  rules.
- Schema migrations and typed safe refusal of newer versions are mandatory. A
  preview-only reader for future unknown schemas is a post-V1 compatibility feature.
- The renderer cannot rely on arbitrary document-provided scripts or CSS.
- Direct editing of exported HTML may change the output but cannot round-trip into
  the authoring file.
- A text-based inspection representation may exist, but it does not replace the
  serialized canonical state.
