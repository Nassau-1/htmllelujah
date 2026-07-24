# HTMLlelujah MCP contract

This reference reflects the local V1 bridge. The connected tool schema is authoritative if it
differs from this summary.

## Read tools

| Tool | Purpose |
| --- | --- |
| `app_status` | Confirm the desktop-backed local service is running. |
| `documents_list` | List visible open decks with document ID, revision, dirty/save state, and collaboration mode. |
| `documents_get_outline` | Read deck name, page size, ordered slide IDs/names, hidden state, element counts, and revision. |
| `slides_get` | Read one canonical slide, including complete structured elements. |
| `documents_get_styles` | Read page, themes, masters, and layouts. |
| `documents_get_design_context` | Read inheritance, provenance, effective locks, placeholders, constraints, assets, and validation with pagination. |
| `documents_validate` | Validate structure, references, assets, and renderability without mutation. |
| `collaboration_status` | Read safe LAN mode, participant count, writer, and connectivity state. |

For `documents_get_design_context`, use `elementScope: "selected-projection"` for one resolved
slide or `"all-authoritative"` for all master, layout, and slide objects. Advance `elementOffset`
and `assetOffset` independently while `hasMore` is true.

## Mutation tools

`documents_propose_commands` accepts:

- `documentId`
- the latest `expectedRevision`
- a concise transaction `label`
- 1–100 commands conforming to the exposed typed command schema

Useful command families include deck rename/export settings; slide create, duplicate, update,
reorder, hide, layout, and placeholder reset; element insert, update, delete, transform, style,
lock, visibility, z-order, align, distribute, group, and ungroup; rich-text replacement; table
row/column/cell/style/TSV operations; connector endpoints; and review comments when present in the
connected schema.

`documents_propose_design_operations` accepts up to 20 operations for:

- `page.set`
- `theme.create`, `theme.update`, `theme.delete`, `theme.enforce-deck`
- `master.create`, `master.update`, `master.delete`
- `layout.create`, `layout.update`, `layout.delete`
- `slide.set-layout`

It expands to no more than 100 canonical commands.

Both proposal tools simulate the complete batch first. The response includes `proposalId`,
`baseRevision`, `expiresAt`, `requiresApproval`, command count, affected slides, warnings, and a
summary. Nothing changes until `documents_commit_proposal` succeeds.

`documents_save` accepts only:

- `documentId`
- the exact latest `expectedRevision`

It persists that revision only to the target already attached by desktop Open or Save As. It
accepts no path, never opens Save As, does not overwrite a different target, and does not consume a
one-time approval. A successful response confirms `saved: true`, `dirty: false`,
`durability: "clean"`, and `target: "existing-authorized-target"`. If the deck has no target, the
user must choose one once through desktop Save As.

## Revisions and errors

- Every proposal is bound to an exact revision and expires quickly.
- On `REVISION_CONFLICT`, `TARGET_CHANGED`, `LOCKED`, `READ_ONLY`, or `TEXT_LOCKED`, reread state
  and reassess. Do not loop blindly.
- A no-effect proposal can return warning `NO_EFFECT`; do not commit it just to advance history.
- A commit returns the transaction ID, previous revision, new revision, and accepted command
  count. Use those values for verification and a possible authorized undo.

## Desktop-controlled actions

Ordinary reversible authoring uses the persistent trusted-client grant. The following remain
desktop-authorized:

- destructive proposal commit when `requiresApproval` is true;
- `documents_undo_agent_transaction`;
- `assets_request_import`;
- `documents_request_export` for `html` or `pdf`.

Approval IDs are purpose-, client-, document-, and revision-bound, short-lived, and single-use.
Do not ask the user to paste one into chat or logs. Let the configured MCP client pass the
desktop-issued capability directly.

## Bounded and closed surface

- MCP frames and encoded results: at most 2 MiB.
- Pending proposals: at most 64.
- Design-context page: at most 500 elements and 250 assets.
- The contract accepts no arbitrary markup, remote URL, shell command, unrestricted bytes, or
  filesystem path.
- `documents_save` accepts no target path and is fenced by document ID, visibility, trusted-client
  edit capability, collaboration mode, attached target, and exact revision.
- Reads work during LAN collaboration; V1 mutations intentionally pause until collaboration ends.
