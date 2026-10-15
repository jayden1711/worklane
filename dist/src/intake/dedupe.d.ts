export declare function tokens(s: string): Set<string>;
export declare function similarity(a: string, b: string): number;
export interface Candidate {
    issue?: number;
    report?: string;
    title: string;
    text: string;
    score: number;
}
/** The closest open issues and recent reports, best first, above `min`. */
export declare function candidates(text: string, open: {
    number: number;
    title: string;
    body: string;
}[], recent: {
    id: string;
    text: string;
    issue?: number;
}[], min?: number, max?: number): Candidate[];
