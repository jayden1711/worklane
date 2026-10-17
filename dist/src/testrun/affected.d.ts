export declare const CODE_EXT: RegExp;
export interface GraphOptions {
    /** Every file in the repo at the commit (repo-relative, `/`-separated). */
    files: readonly string[];
    /** A code file's contents (only code files are read). */
    read: (file: string) => string;
    /**
     * Shared helper modules, described instead of scanned: for each, its exports' names -> the repo paths a file that
     * uses the name reaches (code it imports or runs, paths it reads; '' is the root). Nothing is charged to a file
     * that only imports the module, so the description must cover all the module imports and reads.
     */
    pathModules?: Readonly<Record<string, Readonly<Record<string, string | readonly string[]>>>>;
    /** Where a source file runs from (a build output): src/x.ts -> dist/src/x.js. Default: where it is. */
    runtimePath?: (file: string) => string;
    /** A runtime path back to its source: dist/src/x.js -> src/x.js (resolved as an import after). Default: unchanged. */
    sourcePath?: (path: string) => string;
    /** A bare import that is a package (or a builtin): not part of the repo. */
    isPackage?: (specifier: string) => boolean;
    /**
     * What a read of the whole repo by this file stands for, when less than everything: a module that, at run time,
     * reads the directory it is installed in reads the package's files. Null (the default): the whole repo.
     */
    wholeRead?: (file: string) => readonly string[] | null;
}
export interface FileFacts {
    /** Repo files this one runs or imports. */
    edges: Set<string>;
    /** Paths it reads: a file or a directory prefix. '' is the whole repo. */
    reads: Set<string>;
    /** Imports or requires it makes that this can't resolve: why. */
    opaque: string[];
    /** Every string literal's text (for the "named but not reached" check). */
    strings: string[];
    /** It lists the repo's files (git ls-files in the root): which files exist, not what's in them. */
    lists: boolean;
}
export interface Graph {
    files: Set<string>;
    facts: Map<string, FileFacts>;
}
/** The text inside the parentheses that open at `open` (the index of `(`), balanced, strings skipped; null if unclosed. */
export declare function balanced(text: string, open: number): string | null;
/** Split an argument list at its top-level commas. */
export declare function splitArgs(args: string): string[];
/** A string literal's value; a template literal's text up to its first `${` (with `partial`); null for anything else. */
export declare function literal(expr: string): {
    value: string;
    partial: boolean;
} | null;
/**
 * A JS/TS source's string and template literals (their text, a template's `${…}` parts left out), and the source
 * with everything that isn't code blanked: comments, regular expressions and the insides of strings become spaces
 * (the quotes stay, and a template's `${…}` stays code), so a search of it finds only code. A `/` after an operator
 * or an opening bracket starts a regular expression; after a value it divides.
 */
export declare function lex(text: string): {
    strings: string[];
    masked: string;
};
/** Build the graph: every code file's edges, reads and unresolved imports. */
export declare function buildGraph(o: GraphOptions): Graph;
export interface Plan {
    /** The whole suite: why (the first file that forced it). */
    all: string | null;
    /** The test files to run (every test file when all). */
    tests: string[];
    /** For each selected test, the changed files that selected it ("always" for a test that runs on every change). */
    why: Record<string, string[]>;
}
export interface SelectOptions {
    /** Which files are tests. */
    isTest: (file: string) => boolean;
    /** A changed file that forces the whole suite: why, or null. */
    forceAll?: (file: string) => string | null;
    /** The changed files that are new. Unknown (absent): a test that lists the repo's files runs on every change. */
    added?: ReadonlySet<string>;
}
/** Everything a test reaches: files through edges, and paths read by any of them. */
export declare function reach(g: Graph, test: string): {
    files: Set<string>;
    reads: Set<string>;
    opaque: string[];
    lists: boolean;
};
/**
 * Whether a string literal names `f`: the whole literal, a path (no spaces: a message isn't one), ends in f's name
 * at a segment boundary ('x.md', 'docs/x.md', './x.js'; a code file also without its extension).
 */
export declare function names(s: string, f: string): boolean;
/**
 * The tests a change selects. `changed` are the change's paths; a path not in the graph's files was deleted (or
 * renamed away), and forces the whole suite.
 */
export declare function selectTests(g: Graph, changed: readonly string[], o: SelectOptions): Plan;
