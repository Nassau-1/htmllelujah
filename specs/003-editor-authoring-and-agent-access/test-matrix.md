# Test Matrix: Professional Authoring and Persistent Agent Access

| ID      | Surface             | Required evidence                                                                                            |
| ------- | ------------------- | ------------------------------------------------------------------------------------------------------------ |
| INT-001 | Right-click         | Menu targets the clicked/selected object and every enabled command is keyboard reachable.                    |
| INT-002 | Clipboard           | Copy/cut/paste works for every element type and nested groups with fresh identifiers.                        |
| INT-003 | External paste      | Plain text, safe rich text, supported image bytes, and rectangular TSV take the correct bounded path.        |
| INT-004 | Duplicate           | Placeholder-bound text duplicates as a detached local object with no validation error or phantom selection.  |
| SUR-001 | Slide               | Every supported insert, transform, arrange, lock, visibility, and delete action persists.                    |
| SUR-002 | Layout              | The same valid actions update every inheriting slide and survive save/reopen.                                |
| SUR-003 | Master              | The same valid actions update every dependent layout/slide and survive save/reopen.                          |
| THM-001 | Theme creation      | Blank and derived themes validate, apply, undo, redo, save, and reopen.                                      |
| THM-002 | Enforcement         | Switching themes changes all managed fonts/colors across every supported content type.                       |
| THM-003 | Overrides           | Inherited, managed, and local states are visible and reset deterministically.                                |
| PAG-001 | Custom size         | Boundary and valid custom dimensions round-trip through every render/export surface.                         |
| PAG-002 | Dynamic fields      | Page, pages, title, date, and time resolve without mutating canonical token text.                            |
| PAG-003 | Furniture           | Left/center/right page numbers and text/image watermarks inherit, lock, render, and export.                  |
| CAT-001 | Shape picker        | Selection precedes insertion and creates the selected geometry.                                              |
| CAT-002 | Twemoji             | Search and insertion use bundled artwork and stable identity with no network request.                        |
| CAT-003 | Flags               | Search and insertion use bundled circular artwork and stable country code with no network request.           |
| CAT-004 | Integrity           | Catalog versions, hashes, licenses, and generated output are deterministic and attested.                     |
| AGT-001 | Registration        | Unknown client is denied; approved client obtains a persisted scoped grant.                                  |
| AGT-002 | Ordinary edits      | Trusted reversible edit succeeds without per-edit approval and appears as one attributed undo step.          |
| AGT-003 | Sensitive actions   | Import/export/overwrite/bulk destructive operations still require matching explicit approval.                |
| AGT-004 | Design context      | Agent sees current revision, page, themes, masters, layouts, placeholders, locks, constraints, and warnings. |
| AGT-005 | Revocation/conflict | Revoked client and stale revision fail atomically without document change.                                   |
| XSF-001 | Cross-surface       | Editor, thumbnail, presentation, standalone HTML, and PDF agree for new content and fields.                  |
