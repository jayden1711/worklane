// The product name lives here and nowhere else in code. If it ever changes,
// `npm run rename -- <new>` rewrites every occurrence (code, docs, config)
// in one pass. Do not hardcode the name elsewhere in src/.

export const BRAND = {
  /** Display name, e.g. in CLI banners and the dashboard title. */
  name: 'Worklane',
  /** CLI command and lowercase identifier. */
  cli: 'worklane',
  /** npm package (scoped; bare names are taken). */
  pkg: '@worklane/cli',
  /** Per-project config folder, created by `install`. */
  configDir: '.worklane',
  /** Prefix for environment variables, e.g. WORKLANE_HOME. */
  envPrefix: 'WORKLANE',
  tagline: "Know who's on every task.",
} as const;

export type Brand = typeof BRAND;
