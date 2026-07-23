# HTMLlelujah Agent Guide

This repository is a public, source-available project. Treat every tracked file,
commit message, workflow log, fixture, and screenshot as public.

## Non-negotiable boundaries

- Do not mention private employers, clients, or competing commercial products in tracked files.
- Keep original HTMLlelujah code under PolyForm Noncommercial 1.0.0 unless the
  licensor explicitly records a different decision.
- Do not call the project Open Source or copyleft: the public license restricts
  commercial purposes and does not require publication of modified source.
- Do not accept external code, documentation, design, asset, or translation
  contributions until a contributor agreement that preserves separate commercial
  licensing has been adopted.
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
