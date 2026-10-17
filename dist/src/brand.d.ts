export declare const BRAND: {
    /** Display name, e.g. in CLI banners and the dashboard title. */
    readonly name: "Worklane";
    /** CLI command and lowercase identifier. */
    readonly cli: "worklane";
    /** npm package (scoped; bare names are taken). */
    readonly pkg: "@worklane/cli";
    /** Per-project config folder, created by `install`. */
    readonly configDir: ".worklane";
    /** Prefix for environment variables, e.g. WORKLANE_HOME. */
    readonly envPrefix: "WORKLANE";
    readonly tagline: "Know who's on every task.";
};
export type Brand = typeof BRAND;
