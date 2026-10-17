export declare const BUNDLE_FORMAT: string;
export interface BundleFile {
    /** state/<path> or config/<path>, with forward slashes. */
    path: string;
    data: string;
}
export interface Bundle {
    format: typeof BUNDLE_FORMAT;
    version: 1;
    createdAt: string;
    from: {
        repo: string | null;
        host: string;
    };
    files: BundleFile[];
}
export declare function exportBundle(o: {
    stateDir: string;
    root: string | null;
    repo: string | null;
    host: string;
    out: string;
    now?: Date;
}): {
    file: string;
    files: string[];
    left: {
        path: string;
        why: string;
    }[];
};
export declare function readBundle(file: string): Bundle;
export interface ImportResult {
    state: string[];
    config: string[];
    /** Config files the target already has, differently: the repo's, to commit in a PR. */
    configDiffers: string[];
    skipped: {
        path: string;
        why: string;
    }[];
}
export declare function importBundle(o: {
    file: string;
    stateDir: string;
    root: string | null;
    instance: boolean;
    force?: boolean;
}): ImportResult;
