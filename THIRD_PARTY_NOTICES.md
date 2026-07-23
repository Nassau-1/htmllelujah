# Third-Party Notices

Last reviewed: 2026-07-23.

HTMLlelujah's original source and official compiled distributions are governed by
[`LICENSE`](LICENSE). [`COMMERCIAL-LICENSING.md`](COMMERCIAL-LICENSING.md) provides
a contact path but does not alter any third-party terms. Third-party components remain
governed by their own licenses. This notice identifies every direct external
dependency declared by the workspace at the reviewed versions; the locked transitive
graph is recorded separately in the release SBOM.

Workspace packages under the `@htmllelujah` scope are original project components,
not third-party dependencies.

## Direct application and runtime components

| Component                   | Version | License                  | Use in the distributed application                     |
| --------------------------- | ------: | ------------------------ | ------------------------------------------------------ |
| Electron                    |  43.1.1 | MIT plus bundled notices | Windows runtime; includes Chromium and `ffmpeg.dll`    |
| `@modelcontextprotocol/sdk` |  1.29.0 | MIT                      | Local stdio agent protocol                             |
| `bonjour-service`           |   1.4.3 | MIT                      | Optional private-LAN discovery                         |
| `lucide-react`              |  1.24.0 | ISC and MIT              | Desktop interface icons                                |
| `react`                     |  19.2.7 | MIT                      | Desktop and slide rendering                            |
| `react-dom`                 |  19.2.7 | MIT                      | Desktop, export, and presentation DOM rendering        |
| `selfsigned`                |   5.5.0 | MIT                      | Ephemeral collaboration-session certificate generation |
| `tslib`                     |  1.14.1 | 0BSD                     | TypeScript runtime helpers                             |
| `ws`                        |  8.21.1 | MIT                      | Authenticated local-network collaboration transport    |
| `zod`                       |   4.4.3 | MIT                      | Runtime validation at document and process boundaries  |

Electron's own source is MIT-licensed. Its Windows distribution also contains
third-party components under additional licenses. In particular, the Electron
distribution contains a separate `ffmpeg.dll`, and Electron's bundled Chromium
notice classifies the applicable FFmpeg files as LGPL-2.1-or-later unless optional
GPL parts are enabled. The engineering review, obligations, and release gate are
recorded in
[`docs/legal/electron-runtime-license-review.md`](docs/legal/electron-runtime-license-review.md).

The installed application must preserve Electron's complete `LICENSE.electron.txt`
and `LICENSES.chromium.html` files. Those files contain the authoritative notices and
license texts for Chromium, FFmpeg, and the rest of Electron's embedded third-party
runtime.

## Direct development and packaging components

The components below are used to type-check, test, format, bundle, inspect licenses,
or package HTMLlelujah. They are not application features and must not be copied into
the application runtime unless a later release review explicitly reclassifies them.

| Component              | Version | License    |
| ---------------------- | ------: | ---------- |
| `@electron/fuses`      |   2.1.3 | MIT        |
| `@types/node`          | 24.13.3 | MIT        |
| `@types/react`         | 19.2.17 | MIT        |
| `@types/react-dom`     |  19.2.3 | MIT        |
| `@types/ws`            |  8.18.1 | MIT        |
| `@vitejs/plugin-react` |   6.0.3 | MIT        |
| `electron-builder`     | 26.15.3 | MIT        |
| `prettier`             |   3.9.5 | MIT        |
| `tsx`                  |  4.23.1 | MIT        |
| `typescript`           |   7.0.2 | Apache-2.0 |
| `vite`                 |   8.1.4 | MIT        |
| `vite-plugin-electron` |   1.1.0 | MIT        |
| `vitest`               |  4.1.10 | MIT        |

The build graph also reaches packages licensed under BlueOak-1.0.0, CC-BY-3.0,
MPL-2.0, Python-2.0, and WTFPL. They are reviewed build-only exceptions in
[`policy/licenses.json`](policy/licenses.json). The Python-2.0 item is
`argparse@2.0.1`, reached only through `electron-builder -> js-yaml`; it is absent
from the production dependency graph. The WTFPL item is
`truncate-utf8-bytes@1.0.2`, reached only through
`electron-builder -> builder-util -> sanitize-filename`; it is also absent from the
production dependency graph. These exceptions do not relax the runtime allowlist.

## Direct-component copyright notices

The following notices are retained from the installed license files:

- Electron: Copyright Electron contributors; Copyright 2013-2020 GitHub Inc.
- Model Context Protocol SDK: Copyright 2024 Anthropic, PBC.
- bonjour-service: Copyright 2021 ON LX Limited; portions copyright 2015-2016
  Thomas Watson Steen.
- Lucide: Copyright 2026 Lucide Icons and Contributors. The Lucide license also
  identifies icons derived from Feather, copyright 2013-present Cole Bemis.
- React and React DOM: Copyright Meta Platforms, Inc. and affiliates.
- selfsigned: Copyright 2013 Jose F. Romaniello.
- tslib: Copyright Microsoft Corporation.
- ws: Copyright 2011 Einar Otto Stangvik; 2013 Arnout Kazemier and contributors;
  2016 Luigi Pinca and contributors.
- Zod: Copyright 2025 Colin McDonnell.

## License texts for direct runtime components

### MIT License

The following text applies to the MIT-licensed direct components above, together
with their respective copyright notices:

> Permission is hereby granted, free of charge, to any person obtaining a copy of
> this software and associated documentation files (the "Software"), to deal in the
> Software without restriction, including without limitation the rights to use,
> copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
> Software, and to permit persons to whom the Software is furnished to do so,
> subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
> FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
> COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN
> AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
> WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

### ISC License (Lucide)

> Permission to use, copy, modify, and/or distribute this software for any purpose
> with or without fee is hereby granted, provided that the above copyright notice
> and this permission notice appear in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
> REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
> FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT,
> OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE,
> DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS
> ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS
> SOFTWARE.

### 0BSD License (tslib)

> Permission to use, copy, modify, and/or distribute this software for any purpose
> with or without fee is hereby granted.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
> REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
> FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT,
> OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE,
> DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS
> ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS
> SOFTWARE.

## Release compliance contract

Every distributed Windows build must include this file, the canonical project
`LICENSE.txt`, `COMMERCIAL-LICENSING.md`, Electron's complete license files, and the
release SBOM. A release review must compare the packaged contents to the locked
dependency graph, confirm that no build-only exception entered the runtime, and
update this inventory when a dependency or bundled asset changes.

Bundled visual-asset provenance is recorded in
[`docs/legal/asset-provenance.md`](docs/legal/asset-provenance.md).
