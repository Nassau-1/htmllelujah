# Security Policy

## Project status

HTMLlelujah is in Alpha as of 2026-07-15. Alpha builds are development artifacts,
not supported production releases. Security fixes may require document migrations
or removal of incomplete functionality.

| Version        | Supported                       |
| -------------- | ------------------------------- |
| `main`         | Best-effort security fixes      |
| Alpha binaries | No production support guarantee |

## Reporting a vulnerability

Do not disclose suspected vulnerabilities in public issues, pull requests,
discussions, screenshots, or shared deck files.

Use the repository's private vulnerability-reporting feature. Include only the
minimum information needed to reproduce the issue:

- affected revision or build identifier;
- affected operating-system version;
- concise reproduction steps;
- observed and expected behavior;
- impact and whether untrusted content or a network peer is required;
- a sanitized proof of concept when one is essential.

Do not include real presentation content, credentials, access tokens, private keys,
personal data, or proprietary files. A synthetic `.hdeck` fixture is preferred.

## Response targets

Because the project is pre-release, these targets are goals rather than contractual
service levels:

- acknowledge a complete report within seven calendar days;
- confirm or reject the issue after initial triage;
- contain critical issues before publishing detailed technical information;
- credit the reporter when requested and legally possible.

## Security boundaries

The following invariants are non-negotiable:

- Desktop renderers run sandboxed, with context isolation and without Node.js
  integration.
- The document model does not permit arbitrary HTML, JavaScript, shell commands,
  unrestricted filesystem paths, or active remote URLs.
- Main-process capabilities are exposed only through narrow, validated IPC methods.
- MCP mutations are typed, revision-checked, attributable, transactional, and
  undoable.
- Archive extraction validates paths, entry counts, expanded sizes, and real media
  types before materializing content.
- Imported SVG and rich-text content are sanitized before rendering.
- Local-network collaboration requires an authenticated session and never exposes a
  listener on a public network profile without explicit user consent.
- Logs and crash bundles exclude deck text and embedded assets by default.

## Out-of-scope reports

The following are not vulnerabilities by themselves:

- access by a user who already controls the local operating-system account;
- visual differences caused by unsupported system fonts;
- denial of service requiring a deliberately modified local development build;
- social-engineering claims without a product-level security boundary being crossed;
- issues in unsupported or unmodified third-party tooling with no demonstrated
  impact on HTMLlelujah.
