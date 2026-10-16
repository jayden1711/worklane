export declare const NPM_NAME: RegExp;
export declare const NPM_VERSION: RegExp;
export interface NpmResult {
    package: string;
    version: string;
    integrity: string;
    lockfile: string;
    argv: string[];
    refusals: string[];
}
/** The one command the package's bin names: its only bin, or the one named like the package. */
export declare function binOf(pkg: string, bin: unknown): string | null;
export declare function fetchNpmServer(pkg: string, version: string, dest: string, registry?: string): NpmResult;
