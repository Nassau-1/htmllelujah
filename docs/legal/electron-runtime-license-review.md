# Electron Runtime License Review

Status: engineering compliance review; corresponding-source mechanism and qualified
approval required before public binary distribution.

Reviewed: 2026-07-15.

## Scope and deployment model

This review covers the unmodified Electron 43.1.1 Windows x64 runtime distributed
with the HTMLlelujah desktop binary. HTMLlelujah's first-party code is distributed
under a source-available noncommercial license, while bundled runtime licenses and
weak-copyleft distribution obligations continue to apply independently even though
the application works locally and offline.

This document is an engineering record, not a legal opinion. Any conclusion that
depends on linking doctrine, source-offer sufficiency, or a particular jurisdiction
must be confirmed by qualified counsel before public binary distribution.

## Evidence reviewed

The pinned package contains the following upstream files:

| Evidence                                        | SHA-256                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| Electron `dist/LICENSE`                         | `5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d` |
| Electron `dist/LICENSES.chromium.html`          | `b911161e6594ec76b872498b423c54406168f2974e0d407a847f7de1e5ff94dd` |
| Electron Windows x64 `dist/ffmpeg.dll`          | `eaeb2203f72d89615ffbf6a38bb96860cc78a9095126b790e36fc91c8f1fef3d` |
| Upstream `electron-v43.1.1-win32-x64.zip` entry | `b4e9995cd3f65785eb8818276aa9020f3165ab11da41b3c762616d4a0ad8c7ad` |
| Upstream `ffmpeg-v43.1.1-win32-x64.zip` entry   | `9204459f35c7ab1815ee8cab01fe9103b1516cdc50c30c5a8501ba20edf4d883` |

The two upstream archive hashes are taken from Electron 43.1.1's installed
`checksums.json`. The file hashes identify this dependency snapshot only; the release
record must hash the final packaged copies again.

Electron's own `LICENSE` is MIT. Its complete Chromium notice states that most FFmpeg
files are under LGPL-2.1-or-later and that enabling optional GPL portions changes the
FFmpeg license to GPL-2.0-or-later. The reviewed binary exposes FFmpeg as the separate
`ffmpeg.dll` supplied by the official Electron distribution. HTMLlelujah does not
modify that DLL, statically link original application code into it, or call a private
FFmpeg interface directly.

## Classification

- Electron's original code: permissive, MIT.
- FFmpeg within the reviewed Electron runtime: weak copyleft,
  LGPL-2.1-or-later, subject to confirmation that the official binary did not enable
  optional GPL components.
- Other Chromium runtime components: mixed licenses listed individually in
  `LICENSES.chromium.html`; that complete file is the authoritative bundled notice.

This is a narrow binary-runtime exception to the repository's default block on LGPL
dependencies. It does not add LGPL to the npm runtime allowlist and does not approve
another LGPL package, a modified Electron build, an FFmpeg replacement, or a build
with optional GPL components.

## Engineering conclusion

The reviewed relationship is a separable, unmodified shared library shipped as part
of Electron. On that technical record, bundling `ffmpeg.dll` does not by itself make
HTMLlelujah's original source LGPL-licensed. That conclusion remains subject to legal
review of the exact distribution and applicable law.

The release is blocked if the exact Electron build enables GPL FFmpeg parts, if the
DLL or its build configuration is modified without a new review, or if the required
license and source-availability steps below are absent.

## Distribution obligations and release checks

- Preserve Electron's `LICENSE.electron.txt` and full `LICENSES.chromium.html` beside
  the installed application. Do not replace the full Chromium notice with a summary.
- Include [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) with the installer
  and installed application.
- Keep `ffmpeg.dll` separable. Do not statically combine HTMLlelujah source with it,
  rename it to conceal its identity, or prevent a lawful compatible replacement.
- Do not impose first-party terms that prohibit reverse engineering needed to debug
  lawful modifications to an LGPL component. The canonical project
  [`LICENSE`](../../LICENSE) contains no contrary restriction, and mandatory
  third-party rights continue to control.
- Preserve a reproducible reference to the exact Electron 43.1.1 source and build
  inputs. The release evidence must identify the upstream tag and checksums and retain
  the exact dependency lockfile.
- Before any public binary distribution, have counsel choose and approve the
  mechanism for satisfying corresponding-source availability for the exact FFmpeg
  binary. A bare project homepage is not treated here as a completed source offer.
- Confirm the packaged `ffmpeg.dll` hash and the two Electron license-file hashes in
  the final artifact. Treat a mismatch as a new binary requiring review.
- Scan the packaged binary contents, not only npm metadata, because npm license
  checks do not enumerate Chromium, FFmpeg, or the installer runtime.
- Re-run this review whenever Electron changes version, platform, architecture,
  distribution channel, codec configuration, or vendor build.

## Approval state

Engineering review: documented.

Public-distribution legal approval: pending. The release owner must record the
decision and source-availability mechanism in the private or public release record
before the first public binary distribution.
