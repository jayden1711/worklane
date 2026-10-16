export declare const PREVIEW_RELEASE_TAG = "pr-previews";
export interface OpenPr {
    number: number;
    head: string;
    sameRepo: boolean;
}
export interface PreviewGitHub {
    openPrs(): Promise<OpenPr[] | null>;
    comment(pr: number, id: number | null, body: string): Promise<number>;
    attach(name: string, png: Buffer): Promise<string>;
    detach(prefix: string): Promise<void>;
}
export declare function githubPreviews(repo: string, token: () => Promise<string>, f?: typeof fetch, api?: string, uploads?: string): PreviewGitHub;
