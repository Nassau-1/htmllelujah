# Bundled Asset Provenance

Last reviewed: 2026-07-22.

This ledger covers every visual asset file bundled from this repository. User-imported
presentation assets are not part of the application distribution and remain the
user's responsibility.

## Application icon

| File                                           | SHA-256                                                            | Provenance                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `apps/desktop/assets/icon.png`                 | `2c0fc4e9872807d366dee86245cd7e03f53a2e8feae0b4c97b2a5b2708e2d4d2` | Exact `icon.png` entry from the owner-provided HTMLlelujah logo pack |
| `apps/desktop/assets/icon.ico`                 | `7554b438632c7e1767b2d5397f1c1e5afc148bf2e9e87a868e324f9219c602e1` | Exact `icon.ico` entry from the owner-provided HTMLlelujah logo pack |
| `apps/desktop/assets/htmllelujah-app-icon.svg` | `3a89de7aeaf9a693cbc47d08a5402fdf21f10751d006ddb692f50b264994fa92` | Exact vector app-icon entry from the same owner-provided logo pack   |

The repository owner supplied `htmllelujah-logo-pack.zip` on 2026-07-22 for use as
HTMLlelujah's official identity. The received archive has SHA-256
`e6ead9675b2d3d0aa5bb877477ccd55afd7ddaf56b612ebe58f18fcad2eabf09`.
The three bundled files above are exact archive entries; no third-party source asset
or open-source logo dependency was declared in the handoff. The ICO contains native
16, 24, 32, 48, 64, 128, and 256 pixel variants, and the PNG is a transparent
1024-by-1024 source.

Any regeneration or visual replacement requires a new owner source record, license
basis, final-file hash, and packaging review.

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
the user's system. The only tracked product-identity media are the three application
icon files listed above.

## Release gate

Before publishing a binary, enumerate packaged image, icon, font, audio, and video
files and compare them with this ledger. An unlisted asset, a changed hash, or a
missing license basis blocks the release until reviewed.
