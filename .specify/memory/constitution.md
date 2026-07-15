# HTMLlelujah Constitution

## Core Principles

### I. Structured Source of Truth

The versioned document model is the sole authoring source. HTML, CSS, SVG, previews,
and PDF are derived outputs and MUST NOT become independent sources of persistent
state. Every mutable entity MUST have a stable identity, typed shape, explicit
geometry, and deterministic style resolution. Schema changes MUST include migration,
validation, compatibility, and recovery behavior.

### II. Local-First and Safe by Default

Opening, editing, presenting, recovering, and exporting a deck MUST work without an
internet connection. Presentation content is untrusted: it MUST NOT execute code,
request arbitrary remote resources, or obtain unrestricted filesystem access.
Desktop renderers MUST remain sandboxed, context-isolated, and without Node.js
integration. Trusted capabilities MUST pass through a narrow runtime-validated
bridge. Security boundaries MUST be tested, not merely documented.

### III. Human and Agent Parity

Humans, agents, imports, and collaborators MUST modify documents through the same
typed command and transaction layer. Every persistent mutation MUST be attributable,
revision-aware, atomic, and undoable at a user-comprehensible level. Agent tools MUST
expose presentation intent rather than raw HTML, scripts, shell access, arbitrary
paths, or unrestricted URLs. Destructive and overwrite operations MUST preserve a
preview or require explicit approval.

### IV. Fidelity Is a Verifiable Contract

The editor, thumbnails, presentation mode, standalone HTML, and PDF MUST use one
shared DOM/SVG renderer. Text wrapping, object geometry, clipping, fonts, backgrounds,
and page dimensions are product contracts. Renderer changes MUST include golden
fixtures or visual comparison at every affected surface. Editor-only overlays MUST
never leak into presentation or export.

### V. Public Hygiene and License Discipline

Every tracked file, commit, fixture, workflow log, and screenshot MUST be safe for a
public repository. Secrets, real deck content, private organizations, private paths,
and competitive comparisons MUST NOT be committed. Original HTMLlelujah code remains
source-visible proprietary and all rights reserved. Dependencies and assets MUST have
documented provenance, an approved license, required notices, and a release SBOM.
Third-party source MUST NOT be copied or reconstructed to evade license obligations.

## Product and Technical Constraints

- The supported Alpha desktop target is Windows 11 x64.
- TypeScript MUST run in strict mode across first-party packages.
- Persistent geometry uses points and stable UUIDs.
- The element model is a closed discriminated union; arbitrary executable content is
  prohibited.
- `document-core` owns schema, commands, revisions, migrations, and undo semantics.
- Interaction libraries MAY provide handles and gestures, but geometry, snapping,
  alignment, and distribution MUST remain first-party deterministic logic.
- The file writer MUST use atomic replacement and a recovery journal. Collaboration
  MUST separate real-time updates from synchronized-folder snapshot writes.
- Diagnostics MUST exclude slide text, assets, filenames, absolute paths,
  capabilities, tokens, and serialized document state by default.
- Runtime code dependencies are limited by default to MIT, ISC, BSD-2-Clause,
  BSD-3-Clause, Apache-2.0, and Zlib; CC0 assets and OFL fonts are permitted with
  required notices. Other terms require documented approval before use.

## Development Workflow and Quality Gates

Material features MUST begin with `spec.md`, `plan.md`, and `tasks.md` under a
numbered directory in `specs/`. The specification defines observable user outcomes;
the plan records boundaries, risks, verification, and containment; tasks name the
files or surfaces they change and remain checkable.

Before implementation:

1. verify the spec contains objective, non-goals, affected surfaces, constraints,
   risks, success criteria, and recovery behavior;
2. complete the constitution check in the feature plan;
3. create or update an ADR for a durable architectural decision;
4. confirm each proposed dependency passes the license policy.

Before merge:

1. run `pnpm verify`;
2. run the affected integration, visual, security, and recovery suites;
3. review public artifacts for secrets and private context;
4. update `CHANGELOG.md`, `TODO.md`, notices, specs, and ADRs as applicable;
5. ensure a rollback, feature flag, read-only mode, or recovery path contains the
   change when risk warrants it.

Baseline regeneration, skipped tests, and security exceptions require explicit
rationale in the change record. A passing unit suite does not replace Windows desktop
validation for process, rendering, export, packaging, or network behavior.

## Governance

This constitution supersedes feature specs, implementation notes, and convenience
practices when they conflict. Amendments require a documented rationale, impact on
existing specs and code, migration or containment steps, and an explicit version
change.

Constitution versions follow semantic versioning:

- MAJOR removes or materially weakens a principle;
- MINOR adds a principle or materially expands required behavior;
- PATCH clarifies wording without changing obligations.

Every feature plan MUST record a constitution check before implementation and again
after design changes. Non-compliance blocks merge unless the constitution itself is
amended through the process above.

**Version**: 1.0.0 | **Ratified**: 2026-07-15 | **Last Amended**: 2026-07-15
