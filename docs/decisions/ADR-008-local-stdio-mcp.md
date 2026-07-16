# ADR-008: Expose Agent Tools through a Local stdio MCP Server

- Status: Accepted
- Date: 2026-07-15
- Last reviewed: 2026-07-16

## Context

Agents need a stable way to inspect and modify presentations while preserving the same
revisions, validation, attribution, approvals, undo, persistence, and recovery used by
the human editor. Embedding a hosted chat or granting an agent filesystem, shell, raw
HTML, or internal IPC access would expand scope and bypass these controls. A V1 user may
also work entirely offline and should not need an API account or hosted service.

## Decision

Ship `HTMLlelujah-MCP.cmd` as a console launcher. It invokes the packaged Electron
executable in Node mode with the MCP entrypoint inside the integrity-checked ASAR and
communicates with its client over stdio. Protocol frames are the only stdout content;
a redacted startup failure may go to stderr. Frame size, request rate, authentication
time, service time, initialization, shutdown, and malformed-input behavior are
bounded.

The running desktop application creates a random local named pipe and atomically
writes an expiring endpoint descriptor under the current user's application-data
directory. The descriptor contains a random 256-bit secret. Client and server prove
possession with fresh nonces and HMAC; a client nonce cannot be reused. The secret
authenticates only the local RPC connection and grants no document or filesystem
permission by itself.

Read tools list visible open documents, inspect bounded outlines, slides, elements,
and styles, obtain the current revision, validate the document, and inspect redacted
collaboration status. Mutation tools use a typed propose/commit flow with document ID,
expected revision, actor identity, and transaction label against the main-owned
`DocumentSessionManager`.

Destructive commit, agent undo, import, standalone HTML export, and PDF export require
a visible desktop-issued approval capability that is purpose-bound, document-bound,
revision-bound, expires after two minutes, and is single-use. Tool results expose IDs,
revisions, counts, dimensions, warnings, and stable safe error codes rather than paths
or unrestricted bytes. V1 pauses MCP mutations during live LAN collaboration to avoid
a second command-ordering authority.

The MCP contract accepts at most 100 commands per proposal and 2 MiB frames/results.
The desktop runtime issues one-minute proposals and retains at most 64 pending
proposals. It retains at most 32 unconsumed two-minute approvals and 64 consumed
receipts for 30 seconds. Capacity is reserved before asynchronous proposal work and
expired state is purged before admission or use.

The server exposes no arbitrary path, raw file, shell, URL fetch, raw HTML/CSS/SVG,
script execution, internal document-state replacement, secret retrieval, collaboration
administration, embedded model, hosted inference, or API service.

## Consequences

- MCP actions appear in the same attributable grouped undo history as human actions.
- Stale agent plans fail safely with a revision conflict instead of overwriting newer
  work.
- The desktop app remains the authority for documents, approvals, files, exports, and
  recovery.
- MCP can operate offline and independently of an embedded chat interface.
- The console launcher requires Electron's `RunAsNode` fuse. A user who already
  controls the local account can therefore use the packaged executable as a same-user
  Node runtime. This is not an elevation boundary, but it expands the utility of the
  binary and is accepted as an explicit V1 tradeoff.
- `NODE_OPTIONS` and CLI inspection stay disabled; embedded ASAR integrity validation
  and ASAR-only application loading stay enabled. A later release should evaluate a
  dedicated signed MCP helper so `RunAsNode` can be disabled.
- Stdio purity, local authentication, schema fuzzing, approval expiry/replay, desktop
  absence, process teardown, and diagnostics redaction are hard release gates.
- A future transport may reuse the typed tool contracts only after a new security ADR.

## Rejected options

- **Direct filesystem editing by an agent**: bypasses schema, command, revision,
  history, journal, and approval rules.
- **Raw HTML or internal-state patch tools**: make unvalidated implementation details
  public mutation contracts.
- **Generic desktop IPC exposure**: grants capabilities beyond the declared tools.
- **Embedded hosted chat or API dependency**: breaks offline operation and introduces
  account, network, cost, and privacy scope outside V1.
- **Network-listening MCP endpoint by default**: expands local automation into remote
  service authentication and exposure.
- **Shipping a second general Node runtime**: increases installer size and duplicates
  patching responsibility without removing the need for a narrow desktop RPC.

## Failure and containment

Invalid framing, authentication, schema, revision, approval, or command closes or
rejects only the MCP request/session and never partially mutates a document. Desktop
exit removes the owned descriptor and revokes outstanding approvals; MCP process exit
closes its local connection. The descriptor secret, pipe name, endpoint, document
content, and paths are excluded from diagnostics. Stdout contamination, arbitrary
capability exposure, stale descriptor reuse, or redaction failure blocks release.
