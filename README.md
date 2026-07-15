# HTMLlelujah

HTMLlelujah is a local-first desktop presentation editor for structured, editable
slides rendered with web technologies. It is designed so people and AI agents can
work on the same presentation without making generated HTML the source of truth.

> **Status: Alpha — 2026-07-15.** The repository contains an early development
> foundation. It is not ready for production work, and no supported binary release
> is available yet.

## Product direction

HTMLlelujah aims to provide:

- a familiar visual editor with direct text editing, selection, alignment, guides,
  snapping, layers, tables, images, shapes, connectors, and reusable layouts;
- a structured and versioned document model that remains safe to inspect, migrate,
  edit, and automate;
- one shared DOM/SVG renderer for the editor, presentation mode, thumbnails, HTML
  output, and PDF output;
- offline editing and export on Windows;
- a local MCP surface where agent actions are typed, attributable, transactional,
  previewable, and undoable;
- local-network collaboration while one participant safely owns the shared file
  snapshot.

The authoring file, not exported HTML, is the canonical source. Arbitrary scripts,
remote resources, and executable document content are outside the product model.

## Alpha scope

The repository currently contains two deliberately isolated foundations:

- `apps/desktop` is a sandboxed desktop shell with an in-memory interaction
  prototype for direct text editing, selection, drag and resize, snapping, alignment,
  layers, and inserting synthetic text, shape, image, and table objects;
- `packages/document-core` is a tested structured-model foundation with runtime
  validation, deterministic revisions, immutable transactional commands, grouping,
  alignment, distribution, undo snapshots, and an in-memory adapter boundary.

These foundations are not yet integrated. The desktop prototype uses its own
synthetic fixture model, does not save authoring files, and is not evidence that the
targeted beta is complete.

The active implementation milestone is the platform-fidelity spike described in
[`specs/001-platform-fidelity`](specs/001-platform-fidelity/spec.md). It still needs
to establish the shared renderer, presentation surface, PDF fidelity, Windows visual
baselines, and associated security evidence. Its acceptance tasks remain open even
where the isolated desktop prototype resembles the intended workspace.

The broader targeted beta includes rich text, themes and masters, images, native
tables, basic vector objects, alignment tooling, presentation mode, offline HTML
and PDF export, a local MCP server, crash recovery, and local-network collaboration.

Not implemented yet: `.hdeck` persistence, migrations, autosave and recovery, the
shared editor/presentation/export renderer, standalone HTML or PDF export, MCP, LAN
collaboration, packaging, and a supported Windows binary.

The following are intentionally deferred: presentation-file interchange, linked
data charts, advanced path operations, speaker notes, transitions, cloud accounts,
internet relay collaboration, and an embedded AI chat interface.

## Repository map

| Path                     | Purpose                                                      |
| ------------------------ | ------------------------------------------------------------ |
| `apps/desktop/`          | Sandboxed shell and isolated in-memory interaction prototype |
| `packages/document-core` | Structured model and transactional command foundation        |
| `specs/`                 | Spec Kit feature specifications, plans, and task lists       |
| `docs/architecture.md`   | Current boundaries and target architecture                   |
| `docs/operations.md`     | Development, verification, packaging, and recovery guidance  |
| `docs/decisions/`        | Architecture decision records                                |
| `.specify/`              | Spec Kit configuration, constitution, scripts, and templates |

Some paths are planned and will appear as their associated specs are implemented.

## Development

### Requirements

- Windows 11 x64 for desktop validation
- Node.js 24 or later
- pnpm 11.13.0 through Corepack
- Git

### Bootstrap

```powershell
corepack enable
pnpm install
pnpm verify
```

Common commands:

```powershell
pnpm dev
pnpm test
pnpm typecheck
pnpm build
pnpm format:check
```

The complete workflow and expected artifacts are documented in
[`docs/operations.md`](docs/operations.md).

## Specification workflow

Material work starts with a feature directory under `specs/` containing at least:

- `spec.md` for user outcomes and acceptance criteria;
- `plan.md` for architecture, risks, and verification;
- `tasks.md` for ordered implementation work.

The repository constitution at
[`.specify/memory/constitution.md`](.specify/memory/constitution.md) governs every
spec and implementation change. Architecture decisions with long-lived impact are
recorded under [`docs/decisions`](docs/decisions/ADR-001-structured-document-source.md).

## Security and privacy

The current prototypes use synthetic local fixture data and expose no collaboration
session. Future document handling must keep deck content local unless a user
explicitly starts or joins a collaboration session. The editor must not execute
document-provided code or fetch document-provided remote resources. Security reports
should follow [`SECURITY.md`](SECURITY.md).

## Licensing

HTMLlelujah is **source-visible proprietary software**, not open-source software.
The source is published for inspection, but no permission to use, copy, modify, or
redistribute the original code is granted. See [`LICENSE`](LICENSE).

Third-party components remain under their own licenses. Current notices are listed
in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
