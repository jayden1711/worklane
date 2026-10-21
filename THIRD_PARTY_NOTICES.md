# Third-party notices

Code reused from other open-source projects is listed here with its license. Runtime dependencies installed from npm carry their own licenses and are not repeated here.

| Source | License | What we reused | Where |
|---|---|---|---|
| [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) | CC BY 4.0 | Code of Conduct text | `CODE_OF_CONDUCT.md` |
| [shadcn/ui](https://github.com/shadcn-ui/ui) | MIT | Design-token names and the component API shape for the dashboard; components were written for this project in that style | `web/src/styles.css`, `web/src/components/ui.tsx` |
| [Beautiful UI](https://www.beautifului.dev/) | MIT (below) | The dashboard's dark palette, its radii, shadows and motion, and its interface patterns adapted to the dashboard's data: approval and recommendation cards (decisions), task rows and tool chips (agent runs), diff and records tables (checks), sidebar nav (pages and the instance switcher), insight cards, the loading state. Copied from the components and stylesheet published on beautifului.dev; no demo content or animation timelines, and no icons from its third-party icon sets | `web/src/styles.css`, `web/src/components/ui.tsx`, `web/src/components/patterns.tsx`, `web/src/pages/*.tsx`, `web/src/App.tsx` |

### Beautiful UI license

From https://www.beautifului.dev/license:

```
MIT License

Copyright (c) 2026 Shane Levine

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Unicode confusables data

The review levels' look-alike path check (`src/confusables.ts`, #763) uses Unicode's table of confusable characters for [UTS #39](https://www.unicode.org/reports/tr39/) skeletons: Unicode 17.0.0's `confusables.txt`, from https://www.unicode.org/Public/17.0.0/security/confusables.txt, sha256 `091c7f82fc39ef208faf8f94d29c244de99254675e09de163160c810d13ef22a`, 6565 mappings. The file itself isn't in the repository. Its mappings ship in the package as `src/confusables-data.ts` (built to `dist/src/confusables-data.js`), each written as the characters themselves, generated from that file by `scripts/dev/confusables-data.mjs`, which records the version and hash in the table (a test checks them). The data is Copyright © 1991-2026 Unicode, Inc., under the Unicode License v3:

### Unicode License v3

From https://www.unicode.org/license.txt:

```
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2026 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.
```

## Bundled in the dashboard

The built dashboard (`dist/web`) bundles React, cmdk, Radix UI and lucide-react, plus their dependencies. All are MIT or ISC licensed. Each package's full license text ships next to the bundle in `dist/web/licenses.txt`, generated at build time by `scripts/web-licenses.mjs`.

Build-only tools (Vite, Tailwind CSS, TypeScript) aren't distributed.

## Desktop window

The optional desktop window (`desktop/`) is built with [Tauri](https://github.com/tauri-apps/tauri) 2 (Apache-2.0 OR MIT) and its Rust dependencies, pinned in `desktop/Cargo.lock`. It is built from source on the user's machine (`npm run build:desktop`) and not shipped in the npm package; no Tauri code is copied into this repository.
