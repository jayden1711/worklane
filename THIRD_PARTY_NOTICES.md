# Third-party notices

Code reused from other open-source projects is listed here with its license. Runtime dependencies installed from npm carry their own licenses and are not repeated here.

| Source | License | What we reused | Where |
|---|---|---|---|
| [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) | CC BY 4.0 | Code of Conduct text | `CODE_OF_CONDUCT.md` |
| [shadcn/ui](https://github.com/shadcn-ui/ui) | MIT | Design tokens (neutral palette, light and dark) and component styling patterns for the dashboard; components were written for this project in that style | `web/src/styles.css`, `web/src/components/ui.tsx` |

## Bundled in the dashboard

The built dashboard (`dist/web`) bundles React, cmdk, Radix UI and lucide-react, plus their dependencies. All are MIT or ISC licensed. Each package's full license text ships next to the bundle in `dist/web/licenses.txt`, generated at build time by `scripts/web-licenses.mjs`.

Build-only tools (Vite, Tailwind CSS, TypeScript) aren't distributed.

## Desktop window

The optional desktop window (`desktop/`) is built with [Tauri](https://github.com/tauri-apps/tauri) 2 (Apache-2.0 OR MIT) and its Rust dependencies, pinned in `desktop/Cargo.lock`. It is built from source on the user's machine (`npm run build:desktop`) and not shipped in the npm package; no Tauri code is copied into this repository.
