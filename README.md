# HTMLlelujah

HTMLlelujah is a Windows presentation editor where people edit visually and local AI
agents edit the same safe, structured document. Slides render with web technologies,
but generated HTML is never the authoring source.

**Current version: 1.0.0. Supported target: Windows 11 x64.** The application is
offline-first: creating, editing, saving, recovering, presenting, and exporting a
local deck require no account, API key, or internet connection. Official release
artifacts are published on the repository's Releases page with SHA-256 checksums. An
installer built without an Authenticode certificate is explicitly labelled unsigned.

## What V1 includes

- direct slide and object editing with selection, multi-selection, drag, resize,
  rotation, keyboard nudging, snapping, smart guides, alignment, distribution,
  grouping, layers, lock, visibility, duplicate, delete, undo, and redo;
- typed rich text, headings and lists, font controls, colors, and paragraph alignment;
- themes, masters, layouts, placeholders, page presets, backgrounds, hidden slides,
  and reusable style roles;
- embedded images, editable native tables with TSV paste, shapes, connectors, local
  vector icons, and round Unicode flags;
- one shared DOM/SVG renderer for editor canvas, thumbnails, presentation,
  standalone HTML, and PDF;
- versioned `.hdeck` files with bounded archive validation, content-addressed assets,
  atomic explicit saves, external-change detection, and a durable local recovery
  journal;
- a permissioned local stdio MCP bridge for inspect, validate, propose, edit, undo,
  import, and export tools;
- encrypted authenticated collaboration on a trusted private LAN with one
  authoritative host and one shared-file writer; and
- per-user Windows installation, `.hdeck` file association, offline presentation,
  HTML export, and exact-page PDF export.

Every persistent human, agent, import, recovery, and peer operation goes through the
same validated command engine. The editor, exporter, and collaboration transport do
not receive a second mutable copy of the presentation.

## First run

1. Install the Windows x64 release. Administrator privileges are not required.
2. Start HTMLlelujah and create a deck, or open a `.hdeck` from the File menu or
   Windows Explorer.
3. Edit directly on the canvas and use the right inspector for object, slide, theme,
   table, master, and collaboration controls.
4. Save with `Ctrl+S`. Use Save As when you want an independent file.
5. Present from the toolbar, or export a standalone HTML file or PDF from File.

The recovery journal is written as edits commit. V1 does not silently replace a
shared `.hdeck` in the background: explicit Save creates and verifies the file
snapshot. After an interrupted session, choose **File > Recover local work**, inspect
the candidate, and save it as a new file before replacing an existing deck.

## Work with a local AI agent

The installed `HTMLlelujah-MCP.cmd` is a stdio MCP launcher. Add that command as a
local MCP server in Codex or another compatible local client, then keep the desktop
application running with the target deck visible.

Read tools can inspect only documents currently visible in the app. Edits are typed,
revision-checked, attributable, previewed as proposals, and committed as one undoable
transaction. Destructive commits, agent undo, imports, and exports require a
single-use approval issued in the desktop **Codex** panel. Approvals are bound to the
document, action, and revision and expire after two minutes.

The MCP process receives no arbitrary shell, URL-fetch, HTML-injection, or filesystem
tool. Reads remain available during LAN collaboration, but V1 pauses MCP mutations
while a collaboration session is active so the host's command sequence remains
authoritative. Authentication to the model or agent client is outside HTMLlelujah;
the application itself requires no model API credential.

## Collaborate from a synchronized folder

A synchronized folder may carry the `.hdeck` snapshot between devices, but it is not
used as the live-edit protocol.

1. Each participant installs HTMLlelujah and opens the locally synchronized copy of
   the same `.hdeck`.
2. One participant opens the collaboration panel, starts a host session, and shares
   the endpoint, session code, and displayed certificate fingerprint through
   a trusted channel.
3. Other participants join from the same private LAN and verify the fingerprint.
4. Edit independent objects normally. A direct text edit uses a soft lock so two
   people do not edit the same text element simultaneously.
5. The host is the only participant that writes the shared `.hdeck`. A guest can
   leave and explicitly save an independent copy.

If the host disappears, guests stop editing rather than electing a new file writer or
overwriting the shared file. Their acknowledged local recovery records remain
available. Internet relay, remote collaboration outside the private LAN, and offline
merge are not part of V1.

## Format and security model

`.hdeck` is a deterministic, STORE-only ZIP container with a versioned manifest,
canonical structured document JSON, and content-addressed embedded assets. Importers
reject traversal, undeclared entries, unsupported compression, invalid checksums,
oversized content, unknown model fields, active remote resources, and executable
document content.

The Electron renderer is sandboxed, context-isolated, and has no Node.js integration.
Navigation, popups, permissions, and document-provided remote resources are blocked.
Only the main process can open approved dialogs, write files, print to PDF, host a LAN
session, or expose the authenticated local MCP bridge. See
[`SECURITY.md`](SECURITY.md) and [`docs/architecture.md`](docs/architecture.md).

## Deliberate V1 boundaries

- Windows 11 x64 is the supported desktop target.
- Exported HTML is a standalone view, not an editable source format.
- There is no import or export of third-party presentation formats.
- There are no transitions, animations, speaker notes, comments, linked charts,
  formulas, cloud accounts, hosted templates, or embedded chatbot.
- Collaboration is private-LAN only, uses one host and one shared-file writer, and
  does not merge edits made while disconnected.
- Advanced freeform paths, boolean vector operations, and simultaneous editing of one
  text range are outside V1.

## Repository map

| Path                        | Responsibility                                                   |
| --------------------------- | ---------------------------------------------------------------- |
| `apps/desktop`              | Electron lifecycle, validated IPC, visual editor, packaging      |
| `packages/document-core`    | Canonical schema, commands, revisions, validation, undo          |
| `packages/document-runtime` | Main-process sessions, proposals, durable recovery, asset access |
| `packages/hdeck`            | Bounded archive, journal, fingerprints, atomic persistence       |
| `packages/geometry`         | Deterministic snapping, alignment, distribution, transforms      |
| `packages/renderer`         | Shared DOM/SVG slide projection and readiness                    |
| `packages/exporter`         | Offline standalone HTML and print/PDF surfaces                   |
| `packages/mcp-server`       | Typed MCP tools and authenticated desktop RPC                    |
| `packages/collaboration`    | Private-LAN discovery, authentication, host ordering, replicas   |
| `specs`                     | Product specifications, contracts, task lists, test matrix       |
| `docs/decisions`            | Accepted architecture decisions                                  |

## Develop and verify

Requirements:

- Windows 11 x64 for desktop and installer validation;
- Node.js 24 or later;
- pnpm 11.13.0 through Corepack; and
- Git.

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

Common commands:

```powershell
pnpm dev
pnpm test
pnpm typecheck
pnpm build
pnpm licenses:check
pnpm package:win
pnpm make:win
```

The release process and artifact checks are documented in
[`docs/operations.md`](docs/operations.md). Material changes follow the specification
under [`specs/002-v1-release`](specs/002-v1-release/spec.md) and the repository
constitution at [`.specify/memory/constitution.md`](.specify/memory/constitution.md).

## Licensing

The repository is **source-visible proprietary software**, not open-source software.
Viewing the public source does not grant permission to use, copy, modify, or
redistribute it. See [`LICENSE`](LICENSE).

Official compiled applications are available under the separate binary terms in
[`EULA.txt`](EULA.txt), which permit personal and internal business use and sharing
of user-created exported presentations. Third-party licenses and asset provenance
are recorded in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and
[`docs/legal`](docs/legal/asset-provenance.md).
