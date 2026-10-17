import { IntakeConfig } from './report.js';
/** The server and channels an instance's bot acts in: its ideas channels, asks channel and chat channels. Null: Discord off. */
export declare function discordPlaces(cfg: IntakeConfig): {
    guild: string;
    channels: string[];
} | null;
/** One server+channel pair, hashed: what a claim file holds. */
export declare const placeKey: (guild: string, channel: string) => string;
/**
 * Why this instance's Discord may not start (another instance on the machine claims one of its server+channel
 * pairs), or null. `instancesDir`: where the instances' homes are (each `<name>/intake.yaml`); `claimsDir`: the
 * machine-wide directory of running bots' claims.
 */
export declare function discordClash(o: {
    instance: string;
    config: IntakeConfig;
    instancesDir: string;
    claimsDir: string;
    alive?: (pid: number) => boolean;
}): string | null;
/** Record this instance's places while its bot runs; returns the release. */
export declare function writeDiscordClaim(o: {
    instance: string;
    config: IntakeConfig;
    claimsDir: string;
}): () => void;
/**
 * Check and claim in one step, under a machine-wide lock, so two instances starting at once can't both pass the
 * check: the claim's release, or why this instance's Discord is refused.
 */
export declare function claimDiscord(o: {
    instance: string;
    config: IntakeConfig;
    instancesDir: string;
    claimsDir: string;
    alive?: (pid: number) => boolean;
    sleep?: (ms: number) => Promise<void>;
}): Promise<{
    release: () => void;
} | {
    error: string;
}>;
