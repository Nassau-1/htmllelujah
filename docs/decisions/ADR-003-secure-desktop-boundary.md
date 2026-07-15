# ADR-003: Adopt a Sandboxed Desktop Boundary

- Status: Accepted
- Date: 2026-07-15

## Context

Offline file access, PDF generation, installation, and local-network collaboration
need trusted operating-system capabilities. Presentation content and imported assets
remain untrusted and must not inherit those capabilities.

## Decision

Use an Electron desktop shell with a privileged main process, a narrow validated
preload bridge, and sandboxed context-isolated renderers with Node.js integration
disabled.

Only the main process may open approved dialogs, perform atomic file operations,
create print surfaces, or manage collaboration listeners. The preload API is
versioned and capability-specific. It never exposes general IPC, shell execution,
arbitrary paths, or unrestricted network requests.

## Consequences

- Main/preload/renderer contracts require runtime schemas and contract tests.
- Navigation, popups, permissions, and remote resource loading are denied by
  default.
- Development conveniences may not weaken production security settings.
- Renderer compromise is contained from general local-system access.
- Desktop security checks are release gates, not optional hardening work.
