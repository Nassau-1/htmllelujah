# HTMLlelujah Agent Guide

This repository is a public, source-visible proprietary project. Treat every tracked file,
commit message, workflow log, fixture, and screenshot as public.

## Non-negotiable boundaries

- Do not mention private employers, clients, or competing commercial products in tracked files.
- Do not add an open-source license for original HTMLlelujah code.
- Only add runtime dependencies covered by the repository license allowlist.
- Never expose arbitrary HTML, JavaScript, shell access, filesystem paths, or remote URL fetching
  through the document model or MCP surface.
- Keep `document-core` authoritative; HTML/CSS/SVG are derived render formats.
- Keep Electron renderers sandboxed with context isolation and no Node integration.
- Every document mutation must be typed, transactional, attributable, and undoable.

## Development workflow

- Follow the Spec Kit artifacts under `specs/` before broad implementation.
- Add or update tests with every schema, command, geometry, export, or collaboration change.
- Run `pnpm verify` before claiming a change is complete.
- Update `CHANGELOG.md`, `TODO.md`, and the relevant ADR for material decisions.
- Preserve the approved visual language through the three-layer token system in
  `apps/desktop/src/styles/tokens.css`.
