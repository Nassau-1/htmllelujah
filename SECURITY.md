# Security Policy

## Supported versions

| Version | Security status                                     |
| ------- | --------------------------------------------------- |
| `1.0.x` | Supported while it is the current published V1 line |
| `main`  | Development branch; not a release artifact          |
| `<1.0`  | Unsupported prototypes                              |

Only installers and checksums attached to an official repository release are release
artifacts. A source build, pull-request artifact, or unpacked development directory is
not covered as a supported binary.

## Report a vulnerability privately

Do not disclose a suspected vulnerability in public issues, pull requests,
discussions, screenshots, exported presentations, or shared `.hdeck` files.

Use the repository's private vulnerability-reporting feature. Include only the
minimum information needed to reproduce the issue:

- affected version, commit, installer hash, and Windows version;
- concise reproduction steps and expected versus observed behavior;
- security impact and whether untrusted document content, a local process, or a LAN
  peer is required;
- a synthetic `.hdeck` or proof of concept when essential; and
- whether the issue is already public or actively exploited.

Do not include real presentation content, credentials, approval IDs, endpoint
descriptors, collaboration codes, certificate fingerprints, private keys, personal
data, or proprietary files. If a secret was exposed, rotate or end the affected
session before reporting it.

## Response targets

These are best-effort goals, not contractual service levels:

- acknowledge a complete report within seven calendar days;
- triage severity and reproduction as soon as practical;
- contain critical issues before publishing technical detail; and
- credit the reporter when requested and legally possible.

Coordinated disclosure timing depends on impact, remediation, release availability,
and affected third-party components.

## Security architecture

### Desktop isolation

- Renderer processes are sandboxed and context-isolated, with Node.js integration
  disabled.
- The preload bridge exposes only versioned, capability-specific, runtime-validated
  methods. It exposes no generic IPC, shell, filesystem, or unrestricted network API.
- Navigation, unapproved windows, permission prompts, and document-provided remote
  resources are denied.
- File dialogs, atomic writes, PDF printing, recovery storage, LAN listeners, and the
  local MCP endpoint remain in the privileged main process.

### Documents and assets

- `.hdeck` import treats every byte as untrusted. Archive names, entry counts, sizes,
  ZIP records, checksums, hashes, media types, schema fields, references, and model
  depth are bounded and validated.
- The document model permits no arbitrary HTML, JavaScript, shell commands,
  unrestricted CSS, active remote URLs, or executable embedded objects.
- Rich text, TSV, images, SVG-like vector data, and IPC payloads are normalized into
  typed structures before a transaction commits.
- Imported asset bytes are content-addressed and exposed to renderers only through
  opaque session-scoped URLs.
- Every persistent mutation is typed, revision-checked, attributable, transactional,
  journaled, and undoable.

### Local MCP

- The MCP-facing process communicates with its client over stdio and with the desktop
  over an authenticated random local named pipe. It does not create a LAN listener.
- A random expiring descriptor secret under the current user's application-data
  directory is proven with fresh HMAC nonces. Replay and oversized or malformed
  frames fail closed.
- Only visible open documents are readable. Tools expose no arbitrary path, raw file,
  URL fetch, shell, raw HTML, internal state replacement, or secret-retrieval surface.
- Destructive commit, undo, import, and export use desktop-issued approvals bound to
  action, document, revision, expiry, and single use.
- V1 pauses MCP mutations while LAN collaboration is active so the collaboration host
  remains the only command-ordering authority.

The packaged console launcher requires Electron's `RunAsNode` fuse. A person who
already controls the same Windows account can use that packaged executable as a
same-user Node runtime. It does not confer elevation or bypass the desktop document
permissions. `NODE_OPTIONS` and CLI inspection are disabled, and the application
loads only its integrity-checked ASAR. A way to turn this same-user runtime into
elevated execution, cross-user access, persistence outside normal user permissions,
or a bypass of the typed MCP boundary is in scope and should be reported.

### LAN collaboration

- Hosting is limited to private-network addresses and uses WSS, an ephemeral session
  certificate, an explicitly verified fingerprint, document-scoped credentials, and
  authenticated bounded frames.
- Discovery advertises no title, filename, path, deck text, asset, actor identity, or
  reusable secret. Discovery does not replace join authentication.
- The host validates and totally orders commands. Only the host writes the shared
  `.hdeck`; guests keep detached recovery state.
- Same-text edits use a soft lock. Disconnected edits are not queued or merged, and
  writer takeover is never automatic.

### Diagnostics and releases

- Diagnostics omit deck content, filenames, absolute paths, asset bytes, endpoint
  descriptors, pipe names, capabilities, join codes, fingerprints, and serialized
  document state by default.
- Release review covers the exact installer and installed files, including native
  runtime components, notices, SBOM, checksums, and signature state.
- Builds without an Authenticode certificate are labelled unsigned. A Windows
  reputation warning on an honestly labelled unsigned build is not itself a product
  vulnerability, but a mismatched hash, false signature claim, or substituted
  artifact is.

## Issues that are generally out of scope

The following are not vulnerabilities by themselves:

- a user who already controls the local operating-system account reading that user's
  decks or application data;
- use of the packaged Electron binary as a same-user Node runtime without a privilege
  or product-boundary bypass;
- visual differences caused by unavailable or unsupported system fonts;
- denial of service requiring a deliberately modified local development build;
- social-engineering claims without a product-level boundary being crossed;
- the expected reputation prompt for a correctly identified unsigned build; or
- an issue in unmodified third-party tooling with no demonstrated impact on the
  packaged HTMLlelujah application.

These exclusions do not apply when an issue crosses Windows-user boundaries, escapes
the renderer sandbox, executes document-provided code, overwrites a protected deck,
bypasses MCP approval, authenticates without the session secret, or lets an untrusted
LAN peer obtain unauthorized data or mutation rights.
