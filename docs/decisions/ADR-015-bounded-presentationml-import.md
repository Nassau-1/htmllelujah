# ADR-015: Bounded PresentationML import

- Status: Accepted
- Date: 2026-07-24

## Context

HTMLlelujah needs a one-way `.pptx`/`.potx` import path, beginning with page size,
themes, slide masters, layouts, placeholders, backgrounds, and page furniture. Imported
content becomes a native `.hdeck`; round-trip editing and PowerPoint export are outside
this decision.

A PresentationML file is an Open Packaging Conventions ZIP container whose presentation,
theme, master, layout, slide, relationship, and media parts are separate XML or binary
members. Slides reference layouts, layouts reference masters, and masters/layouts can
reference each other. The importer therefore cannot treat a presentation as one
independent XML document.

References:

- [Structure of a PresentationML document](https://learn.microsoft.com/en-us/office/open-xml/presentation/structure-of-a-presentationml-document)
- [Working with presentation slides](https://learn.microsoft.com/en-us/office/open-xml/presentation/working-with-presentation-slides)
- [ECMA-376 Office Open XML](https://ecma-international.org/publications-and-standards/standards/ecma-376/)
- [Node.js zlib](https://nodejs.org/api/zlib.html)

## Decision

Create a standalone `packages/pptx-importer` boundary with no Office automation and no
runtime network access.

The importer will:

1. Accept only explicitly selected `.pptx` and `.potx` bytes.
2. Parse ZIP central-directory and local-member metadata with fixed archive, entry,
   compressed-size, expanded-size, ratio, count, name, and nesting limits.
3. Support stored and deflated members. Deflate uses the Node runtime's bounded
   `inflateRaw`; output is rejected before aggregate budgets can be exceeded.
4. Reject encrypted members, data descriptors whose ownership cannot be proven,
   overlapping ranges, duplicate or case-colliding names, traversal names, unsupported
   compression, macros, ActiveX, embedded packages, OLE objects, external relationships,
   DTDs, entities, processing instructions outside the XML declaration, and remote URLs.
5. Use a narrow, product-owned namespace-aware XML tokenizer. It records only the
   PresentationML/DrawingML/relationship fields in the import contract, bounds element
   depth, attributes, text, and tokens, and rejects malformed or unsupported constructs.
6. Resolve every relationship relative to its owning part and require an internal,
   canonical package target. No relationship triggers filesystem or network access.
7. Build an immutable preview plan containing:
   - source inventory and warnings;
   - native themes, masters, layouts, placeholders, page size, backgrounds, and
     supported page furniture;
   - optional supported slide content;
   - a per-item `imported`, `substituted`, `rasterized`, or `unsupported` fidelity
     record.
8. Convert geometry from English Metric Units using `12,700 EMU = 1 point`, with finite
   coordinate and page limits before creating canonical objects.
9. Create fresh canonical identifiers deterministically inside the preview. The live
   document changes only after explicit acceptance, in one import-attributed
   transaction/session replacement that remains recoverable.
10. Preserve the source bytes unchanged and never silently omit unsupported content.

`Import design only` is the first supported workflow. Slide import is an additional,
explicit option that uses the same preview and fidelity report.

## Consequences

- The parser is smaller than a general Office/XML engine and has a closed attack surface,
  but fidelity expands only when a construct is deliberately modeled and tested.
- No new production dependency or its license is required for ZIP/XML parsing.
- Unsupported charts, diagrams, SmartArt, embedded objects, media, effects, transitions,
  and animations remain visible in the fidelity report. A later bounded raster fallback
  may be offered only with explicit user acceptance.
- Synthetic public fixtures and hostile archive/XML cases are mandatory before the
  desktop import command is enabled.

## Rejected options

- **Automating an installed Office application:** not offline-portable, not sandboxed,
  not deterministic, and introduces external process/trust state.
- **General-purpose HTML conversion:** loses authoritative theme/master/layout semantics
  and introduces arbitrary markup into the document boundary.
- **Silently rasterizing the complete deck:** prevents semantic editing and hides fidelity
  loss.
- **Mutating the current document during parsing:** makes cancellation and hostile-input
  failure unsafe.
