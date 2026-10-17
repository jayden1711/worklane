export type ClaimKind = 'slack' | 'linear';
/** What a claim holds: a hash of what the source takes (Slack: workspace + bot user; Linear: team + label). */
export declare const claimKey: (kind: ClaimKind, ...parts: string[]) => string;
/**
 * Check and claim in one step: the claim's release, or why this instance's source is refused (another live instance
 * on the machine claims the same key).
 */
export declare function claimSource(o: {
    kind: ClaimKind;
    instance: string;
    key: string;
    claimsDir: string;
    alive?: (pid: number) => boolean;
    sleep?: (ms: number) => Promise<void>;
}): Promise<{
    release: () => void;
} | {
    error: string;
}>;
