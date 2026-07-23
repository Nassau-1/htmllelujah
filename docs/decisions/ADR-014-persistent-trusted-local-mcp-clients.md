# ADR-014: Bind Local MCP Access to Persistent Trusted Client Identities

- Status: Accepted
- Date: 2026-07-23
- Supersedes: the client-authentication and generic actor portions of ADR-008

## Context

ADR-008 authenticated a short-lived desktop endpoint with a rotating descriptor
secret. The packaged helper then asked the desktop permission gate before invoking
tools. That authenticated a same-user process, but it did not identify which local
agent owned a proposal, approval, or transaction. Every transaction used the generic
`mcp-local-agent` actor, and a direct local-RPC caller could bypass helper-side
permission sequencing.

Professional authoring also requires trusted Codex-, Claude-, and other MCP-compatible
clients to make ordinary reversible edits without a human copying a one-time approval
for every change. Persistence must not create a filesystem, HTML, script, URL-fetch,
or ambient machine-wide authoring capability.

## Decision

Use local RPC protocol v2. The rotating `endpoint-v2.json` descriptor continues to
prove the current desktop endpoint with a 256-bit HMAC secret and fresh nonces. A
client additionally signs the complete instance/client/nonce transcript with an
Ed25519 private key. The desktop accepts the connection only when the corresponding
public profile is active in its current-user trusted-client registry.

Trusted-client state is outside every deck under the application-data `mcp/`
directory:

- `trusted-clients-v1.json` contains bounded public profiles and revocation state;
- `client-credentials-v1/<client-id>.json` contains the private launcher credential;
- the credential and registry are atomically written as user-private files; and
- malformed, missing, mismatched, unknown, or revoked state fails closed.

The authenticated client context is immutable at the socket boundary and is injected
by the RPC server. MCP input cannot choose its `clientId` or `actorId`. Transactions
use `mcp-client:<uuid>` attribution. Proposals, approval grants, consumed receipts,
and undo ownership are checked against the authenticated client. Revocation removes
that client's pending state and active RPC connections can be disconnected.

An enrolled client with `documents.read.visible` may inspect only currently visible
open documents. `documents.edit.ordinary` permits typed, bounded, revision-checked,
transactional, attributable, undoable edits without a one-time approval. Complete
theme, master, layout, or element replacements are ordinary only when a validated
simulation proves that they remove no resource, nested element, table structure, or
placeholder binding. Deletes, page geometry changes, layout/reset remapping, undo,
import, and export retain client-, document-, action-, revision-, expiry-, and
single-use approval checks.

The first implementation checkpoint creates one persistent compatibility profile for
the packaged launcher so existing local MCP setup remains usable. Explicit UI
enrollment, read-only profile selection, multiple named clients, and in-app
re-enrollment after revocation remain follow-up work under specification 003. The
compatibility profile is not represented as stronger isolation from other processes
already controlling the same Windows account.

## Consequences

- Ordinary deck and non-removing design edits no longer require per-edit approval.
- Audit and undo records identify the persistent local client instead of a generic
  agent.
- Descriptor possession alone no longer authorizes local-RPC document operations.
- A copied private client credential can impersonate that client until revocation.
  This is contained by the existing same-Windows-user threat boundary; it is not a
  defense against malware already running as that user.
- Revoking the bootstrap profile deliberately makes the launcher fail closed. A
  visible re-enrollment workflow is required before this becomes a complete
  multi-client product experience.
- The bridge still exposes no arbitrary path, raw file, shell, HTML/CSS/SVG,
  JavaScript, URL fetch, secret retrieval, or remote listener.

## Rejected options

- **Keep descriptor-only generic identity**: cannot provide client attribution,
  ownership, or durable revocation.
- **Accept `clientId` or `actorId` in MCP tool input**: allows attribution spoofing.
- **Store a shared bearer secret in the public registry**: makes registry disclosure
  sufficient for impersonation; public-key verification keeps only the public key in
  the registry.
- **Approve all trusted-client operations permanently**: would turn import, export,
  destructive replacement, and external targets into ambient capabilities.
- **Classify every full replacement as destructive forever**: blocks ordinary theme,
  master, and layout maintenance even when simulation proves identity preservation.

## Failure and containment

Authentication failure closes only the local RPC connection. Revocation or
public-key replacement invalidates subsequent requests and may destroy matching
active sockets. A stale revision, invalid command, cross-client proposal, mismatched
approval, or destructive unapproved batch fails before mutation. The desktop remains
usable if trusted-client state cannot be loaded; the MCP bridge reports unavailable
without logging paths, keys, descriptors, signatures, document content, or approval
values.
