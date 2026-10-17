export declare const PROOF_PATH = "/api/prove";
/** 32 random bytes, hex: what the asker sends, and the only shape the dashboard answers. */
export declare const NONCE: RegExp;
export declare const newNonce: () => string;
/** HMAC-SHA256 under the key, over a fixed label, the port and the nonce (hex). The label keeps it to this use. */
export declare function dashboardProof(key: string, port: number, nonce: string): string;
/** Whether `proof` is the key's proof for this port and nonce, compared in constant time. */
export declare function proofMatches(key: string, port: number, nonce: string, proof: unknown): boolean;
