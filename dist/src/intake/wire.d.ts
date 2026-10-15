import { type RoleOf } from '../dashboard-auth.js';
import type { Backlog } from '../backlog/types.js';
import type { ReadOnlyQuery } from './bug-store.js';
import { DiscordIntake, type DiscordOptions } from './discord.js';
import type { IntakeConfig, IntakeSource } from './report.js';
export interface IntakeWiring {
    config: () => IntakeConfig | null;
    sources: IntakeSource[];
    roleOf?: RoleOf;
    /** The instance's name (its dashboard links name it). */
    name: string;
    /**
     * Connect Discord, after the start-up checks: no other instance on the machine claims one of its server+channel
     * pairs, and every discord.owners entry maps to an admin of the repo. A refusal leaves Discord off (the source is
     * removed) and says why; null when connected or when there is nothing to connect.
     */
    start: () => Promise<string | null>;
    /** Closes the Discord connection. */
    stop: () => void;
}
/** Why discord.owners can't stand: an entry whose login isn't an admin on the repo (or couldn't be confirmed as one). */
export declare function ownersProblem(cfg: IntakeConfig, repo: string, roleOf: RoleOf | undefined): Promise<string | null>;
/** The Discord bot as the coordinator's chat source: what it takes, how it answers, and its wake-up on arrival. */
export declare function discordSource(bot: DiscordIntake): IntakeSource;
/** The instance's bot token, from the file credentials.yaml intake.discord_token names (the bot and `discord channels` both read it here). */
export declare const readDiscordToken: (tokenFile: string) => string;
/**
 * The intake deps for one instance, or null when it has no intake.yaml (intake off). A config that is refused
 * (unsafe permissions, invalid) is reported and leaves intake off. Discord connects only on start(), when its
 * config enables it, the instance has a token file and the start-up checks pass.
 */
export declare function intakeForInstance(o: {
    home: string;
    repo: string;
    /** The instance's name; default the home's directory name. */
    instance?: string;
    /** credentials.yaml intake.discord_token: the token file's path. */
    tokenFile?: string | undefined;
    /** The instance's own GitHub token (for repo permissions). */
    githubToken: () => Promise<string>;
    githubApi?: string;
    /** Where every instance's home is (the clash check reads their intake.yaml); default the home's parent. */
    instancesDir?: string;
    /** The machine-wide directory for the identify gate and the bots' claims; default the agent slot directory. */
    machineDir?: string;
    /** Tests: the adapter's socket, fetch and timers, the gate's clock, and roles. */
    discord?: Pick<DiscordOptions, 'connect' | 'fetch' | 'setInterval' | 'clearInterval' | 'setTimeout'> & {
        now?: () => number;
        sleep?: (ms: number) => Promise<void>;
        alive?: (pid: number) => boolean;
    };
    roleOf?: RoleOf;
    log?: (line: string) => void;
    /**
     * The production read path (deploy.yaml prod_read, through the owner's platform login and the read-only role on the
     * production service), or undefined when the project has none: then no production source is wired.
     */
    prodRead?: ReadOnlyQuery | undefined;
    /** The instance's state directory (where a production source keeps its cursor); required with prodRead. */
    stateDir?: string;
    issues?: Pick<Backlog, 'list' | 'comment'>;
}): IntakeWiring | null;
