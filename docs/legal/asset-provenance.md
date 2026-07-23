# Bundled Asset Provenance

Last reviewed: 2026-07-23.

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

Slide-content icons in
`packages/renderer/src/catalog/local-icon-paths.ts` are a small set of original,
locally authored geometric path definitions. The reviewed source file has SHA-256
`7d99771b55d0ec3795d4061401d961c5b991d641a35f61a96315908c631cd0df`.
Changes to that catalog require provenance review in the same commit.

## Offline content catalogs

The renderer includes compiled, deterministic Twemoji artwork, circular country
flags, and English/French search metadata. Source packages are development-only;
their reviewed content is transformed into TypeScript lookup tables so editor,
thumbnail, presentation, standalone HTML, and PDF surfaces use the same offline
artwork.

| Generated file                                                   | SHA-256                                                            | Entries | Provenance                                                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ | ------: | -------------------------------------------------------------------------------------------------------------------- |
| `packages/renderer/src/catalog/generated/twemoji-assets.ts`      | `1dcb798c6eae75ce363a317915fd796af4f575066f23d073359c445f86127f9b` |   3,720 | Twemoji artwork from pinned `@twemoji/svg@15.0.0`; graphics attributed under CC-BY-4.0 and package wrapper under MIT |
| `packages/renderer/src/catalog/generated/twemoji-catalog.ts`     | `d881bf49b8a39d1d13882a065fe080dc2a953996b3bc27291f3f7d1d758133b7` |   3,720 | Search labels and tags from pinned `emojibase-data@17.0.0` under MIT, intersected with bundled artwork               |
| `packages/renderer/src/catalog/generated/circle-flag-assets.ts`  | `c670cf81dae30b28a0ad287ac22d3c23abd1a645820efe1b7e14f829c5b72e2f` |     265 | Two-letter circular SVG entries from pinned `circle-flags@2.8.3` under MIT                                           |
| `packages/renderer/src/catalog/generated/circle-flag-catalog.ts` | `79374cc1f43ce7c147e4c5304ef8cb1bae09fd45907a68d0559246799efa0ffa` |     265 | English/French search metadata from Emojibase, joined to the Circle Flags identities                                 |

Twemoji identities use normalized lowercase Unicode code points separated by `-`
(for example `twemoji:1f600`). Circular flag identities use lowercase two-letter
codes (for example `circle-flags:fr`). Existing `flag` and `flags` identities remain
read-compatible aliases. Documents store only `iconSet` and `iconName`; they never
store SVG markup, local paths, or remote URLs.

The generator accepts only reviewed SVG tags and attributes, rejects executable or
external content, prefixes internal identifiers, and emits the complete source and
output integrity ledger at
`packages/renderer/src/catalog/generated/catalog-integrity.json`. The release
`catalogs:check` gate must pass before packaging. License and attribution text is
retained in [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md).

## Fonts and other media

No font, stock photograph, or demo media file is bundled in the repository as of
this review. The editor uses CSS font stacks and fonts available on the user's
system. Product identity media and the reviewed offline content catalogs above are
the tracked visual assets.

## Release gate

Before publishing a binary, enumerate packaged image, icon, font, audio, and video
files and compare them with this ledger. An unlisted asset, a changed hash, or a
missing license basis blocks the release until reviewed.
