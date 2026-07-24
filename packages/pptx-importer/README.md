# `@htmllelujah/pptx-importer`

Bounded, preview-first parsing of PresentationML (`.pptx` and `.potx`) design data.

```ts
import { parsePresentationImportPreview } from '@htmllelujah/pptx-importer';

const preview = parsePresentationImportPreview(fileBytes, {
  mode: 'design-only',
});
```

The returned preview is immutable. It inventories page size, themes, masters, layouts,
placeholders, basic backgrounds, and supported header/footer furniture. Its fidelity
records identify substitutions and unsupported constructs before a caller asks the
document layer to import anything.

This package deliberately does not mutate a deck, automate Office, access the filesystem,
or fetch relationship targets. It accepts stored and deflated ZIP members under fixed
budgets, validates CRC and member ownership, uses a narrow namespace-aware XML parser,
and rejects encrypted/streaming archives, macros, embedded packages, external
relationships, DTDs, and declared entities.

Slide content import, `.pptx` export, round-trip editing, and raster fallback are not
implemented by this phase.
