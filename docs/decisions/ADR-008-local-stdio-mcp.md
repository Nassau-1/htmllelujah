# ADR-008: Expose Agent Tools through a Local stdio MCP Server

- Status: Accepted
- Date: 2026-07-15

## Context

Agents need a stable way to inspect and modify presentations while preserving the same
revisions, validation, attribution, approvals, undo, persistence, and recovery used by
the human editor. Embedding a hosted chat or granting an agent filesystem, shell, raw
HTML, or internal IPC access would expand scope and bypass these controls. A V1 user may
also work entirely offline and should not need an API account or hosted service.

## Decision

Ship a separate local MCP executable that communicates with its client over stdio. It
uses protocol frames only on stdout; redacted diagnostics go to stderr. Frame size,
request concurrency, initialization, shutdown, and malformed-input behavior are
bounded and tested.

The MCP process authenticates to the running desktop application through a current-
user-only local channel using a per-launch nonce delivered through a protected launch
mechanism. The nonce expires, is not reusable after restart, and grants no filesystem
or document permission by itself.

Read tools list open documents, inspect bounded outlines/slides/elements, obtain the
current revision, validate, and render previews. Mutation tools submit typed document
command batches with document ID, expected revision, actor identity, and transaction
label to the main-owned `DocumentSessionManager`.

Destructive deletion, import, save overwrite, standalone HTML export, and PDF export
require a visible desktop-issued approval capability that is purpose-bound, document-
bound, expiring, and single-use. Tool results expose IDs, revisions, counts, dimensions,
warnings, and stable safe error codes rather than paths or unrestricted bytes.

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

## Failure and containment

Invalid framing, authentication, schema, revision, approval, or command closes or
rejects only the MCP request/session and never partially mutates a document. Desktop or
MCP process exit revokes all launch nonces and outstanding MCP approvals. Stdout
contamination, arbitrary capability exposure, or redaction failure blocks release.
