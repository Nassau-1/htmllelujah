# ADR-004: Separate Real-Time Collaboration from File Synchronization

- Status: Accepted
- Date: 2026-07-15

## Context

Several users may open the same authoring file from a synchronized folder. Treating
independent whole-file writes as real-time collaboration can create duplicated or
silently overwritten snapshots. Users still expect each participant to run the app
and see nearby collaborators automatically when possible.

## Decision

Use a local peer session for real-time document updates and designate one participant
as the shared-file snapshot writer. Other peers persist private recovery journals but
do not replace the shared file while joined.

A signed expiring sidecar communicates writer ownership. Discovery occurs only on a
private local network, and joining requires a document-scoped capability. Writer
transfer is explicit and hash-verified. If no authenticated writer is reachable,
the file opens read-only or as an explicitly independent copy.

## Consequences

- Folder synchronization transports snapshots, not live operations.
- Simultaneous edits converge through the collaborative document state.
- Writer loss preserves peer journals but never triggers an unverified overwrite.
- Conflict copies with the same document ID require detection and explicit merge.
- Internet relay collaboration can later implement the same provider contract
  without changing the authoring format.
