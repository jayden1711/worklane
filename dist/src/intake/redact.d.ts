export interface RedactOptions {
    /** Names to remove wherever they appear: the sender's display name, plus project-configured names. */
    names?: string[];
    /** Project-configured patterns, e.g. account or bet ids: each match becomes [custom:<label>]. */
    patterns?: {
        label: string;
        regex: string;
    }[];
}
/** Luhn check, for telling card numbers from other long digit runs. */
export declare function luhn(digits: string): boolean;
export declare function redactPii(text: string, o?: RedactOptions): string;
