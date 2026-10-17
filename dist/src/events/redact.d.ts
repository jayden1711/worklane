/** The kinds of secret `s` looks like it holds (sorted, each once): names only, never a matched value. */
export declare function secretKinds(s: string): string[];
export declare function redactString(s: string): string;
export declare function redact<T>(value: T): T;
