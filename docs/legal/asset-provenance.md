# Bundled Asset Provenance

Last reviewed: 2026-07-15.

This ledger covers every visual asset file bundled from this repository. User-imported
presentation assets are not part of the application distribution and remain the
user's responsibility.

## Application icon

| File                           | SHA-256                                                            | Provenance                                                                           |
| ------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `apps/desktop/assets/icon.png` | `78128f922eff1e8d27fa3e7ec682a100153f295af413091cba4af3d3493786a1` | Generated specifically for HTMLlelujah under project direction, then cleaned locally |
| `apps/desktop/assets/icon.ico` | `6e2b7acb9bc8a7f6e37f98895fd03724755364bb111f7d574afe9cb0e58c6242` | Derived locally from the reviewed PNG for Windows packaging                          |

The generation brief requested a professional application icon combining a
presentation page, code brackets, and a structured grid in midnight navy, violet,
and ivory, with no text and a chroma-green background. The chroma background was
removed locally. The brief named no artist, living or historical, and imported no
third-party logo or source image. The resulting icon is treated as original project
material under [`LICENSE`](../../LICENSE), subject to any mandatory terms of the
generation service.

Any regeneration or visual replacement requires a new source record, prompt or brief,
license basis, and final-file hash before packaging.

## Interface icons

Desktop chrome imports icons from `lucide-react@1.24.0`. Its installed license file
has SHA-256
`b495047bd93a9b06913511076f504daba17d5bbeb3e0650f3bb53a4220329c57`
and contains the Lucide ISC notice plus an MIT notice for identified Feather-derived
icons. Those notices are preserved in [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md).

Slide-content icons in `packages/renderer/src/icons.tsx` are a small set of original,
locally authored geometric path definitions. No third-party SVG file is copied into
the repository. The reviewed source file has SHA-256
`ae1f03caad575c90bc569bc808038f83a984b6847f2744f3d96f3909bc60091f`.
Changes to that catalog require provenance review in the same commit.

## Round flags

HTMLlelujah does not bundle a flag image pack. A flag element converts a validated
two-letter country code into Unicode regional-indicator characters and displays the
operating system's emoji glyph inside a circular application frame. Consequently,
there is no third-party flag artwork in the installer. Appearance may vary with the
Windows emoji font.

## Fonts and other media

No font, stock photograph, illustration, or demo media file is bundled in the
repository as of this review. The editor uses CSS font stacks and fonts available on
the user's system. The only tracked PNG or ICO files are the two application-icon
files listed above.

## Release gate

Before publishing a binary, enumerate packaged image, icon, font, audio, and video
files and compare them with this ledger. An unlisted asset, a changed hash, or a
missing license basis blocks the release until reviewed.
