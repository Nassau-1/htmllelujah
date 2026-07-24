# HTMLlelujah design model

## Authority chain

`theme → master → layout → slide`

- A **theme** owns semantic color tokens, heading/body font families, and text styles.
- A **master** references one theme and owns deck-wide background, guides, and recurring elements.
- A **layout** references one master and owns composition-specific background, guides, and
  placeholders.
- A **slide** references one layout and owns only slide-specific content and intentional overrides.

Design context identifies each projected element's `source`, `containerId`, inheritance,
placeholder binding, and effective lock. Change the reported source container rather than
duplicating inherited content on the slide.

## Canonical element rules

- All positions and dimensions use points. Frames contain `xPt`, `yPt`, `widthPt`, `heightPt`,
  and `rotationDeg`.
- Array order is back-to-front stacking order.
- Elements have a UUID, name, frame, opacity, visibility, and lock state.
- New nested objects such as rich-text blocks, runs' parent items, table cells, and groups need
  unique IDs where required by the current schema.
- Groups use their own coordinate space; child frames are relative to it.

Supported canonical element categories include text, image, table, shape, connector, icon,
placeholder, and group. Inspect the connected command schema and a current `slides_get` object
before constructing one; do not infer required fields from a rendered export.

## Semantic text

Use the theme roles `title`, `subtitle`, `body`, `caption`, `label`, and `quote`. Rich text is a
document of paragraph, heading, or list blocks containing marked runs. Keep font family and color
out of local marks unless a deliberate exception is required, because local values override theme
enforcement.

## Placeholders

Layout placeholders declare:

- role: title, subtitle, body, media, table, footer, or slide-number;
- accepted content types;
- prompt and optional default text style;
- frame, visibility, and lock state.

A slide element can bind to a placeholder by `placeholderId`. Its `overrides` list records only
intentional frame, style, or visibility divergence. Keep this list minimal. Use
`slide.reset-placeholder` to return a bound object to layout authority.

## Locks

An element is effectively locked on a slide when:

- its own `locked` field is true;
- it is inherited from a master or layout; or
- its inherited placeholder is locked.

Set recurring furniture and watermarks locked at their authoritative source. Do not unlock a
slide projection merely to edit it; edit the master or layout.

## Page furniture and fields

Place repeated furniture on the master, or on a layout only when it varies by composition.
Canonical dynamic text fields are case-sensitive:

- `{{page}}`
- `{{pages}}`
- `{{title}}`
- `{{date}}`
- `{{time}}`

The canonical text retains field tokens and the renderer resolves them per slide. Unknown tokens
remain literal. Use a footer or slide-number placeholder when users should be able to control
visibility through layout semantics.

## Theme enforcement

Deck-wide theme enforcement applies one existing theme throughout masters, layouts, and slides.
It resets theme-managed fonts and colors while preserving content, geometry, IDs, transparency,
bindings, and images. It is atomic, deterministic, and undoable. Treat it as an explicit user
choice, not a routine side effect of editing one theme.

## Complete replacements

Theme, master, layout, and generic element updates may require complete replacement objects.
Always:

1. read the latest object;
2. clone it conceptually;
3. change only intended fields;
4. preserve IDs, children, guides, backgrounds, bindings, and unrelated properties;
5. submit against the same observed revision.

Omitting existing nested structure turns a replacement destructive and may require desktop
authorization.
