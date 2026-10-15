import { type Server } from 'node:http';
import { type SessionOf, type SignInConfig } from './dashboard-auth.js';
import { type AuditSink, type Exec, type SpawnPty } from './console/terminal.js';
export interface HubInstance {
    name: string;
    /** The instance's own dashboard server, on loopback. */
    port: number;
    /** The instance's dashboard-token file. */
    tokenFile: string;
}
export interface HubOptions {
    instances: HubInstance[];
    /** The hub's own state (its token, its sessions), in the viewer user's home. */
    stateDir: string;
    /** The sign-in port (the one tailscale serve forwards). */
    port?: number;
    /** The break-glass port (loopback only; never forwarded). */
    breakGlassPort?: number;
    /** Loopback only; anything else is refused. */
    host?: string;
    webDir?: string;
    /** Sign-in with GitHub; without it, the hub's port refuses every API call and only the break-glass works. */
    signIn?: SignInConfig | null;
    /**
     * The owner terminal (the setup console) reads who is asking on the hub's port through a SessionOf: the hub's
     * own (`session` on what startHub returns) unless one is given here; it runs as consoleUser (console_user; none: it
     * never opens). The rest is for tests.
     */
    /**
     * devices: the Tailscale tags and node names the terminal may be opened from (console_devices; none: it never
     * opens); whois and peerUid identify the device (src/console/terminal-devices.ts) and are injected in tests.
     */
    terminal?: {
        consoleUser?: string | null;
        devices?: string[];
        whois?: (ip: string) => string;
        peerUid?: (clientPort: number, serverPort: number) => number | null;
        session?: SessionOf;
        audit?: AuditSink;
        spawnPty?: SpawnPty;
        exec?: Exec;
        now?: () => number;
        idleMs?: number;
        hubUser?: string;
    };
    /**
     * GitHub Apps made through the manifest flow (src/setup/app-manifest.ts): who is a machine owner, and GitHub's
     * bases (a fake GitHub in tests; the sign-in's, else GitHub's, by default).
     */
    appManifest?: {
        isMachineOwner?: (login: string) => boolean;
        api?: string;
        web?: string;
        fetch?: typeof fetch;
    };
    now?: () => number;
}
/** The hub's port: next to the instances' range (4400-4899). */
export declare const HUB_PORT = 4399;
/** The break-glass port: the token, on this machine only. */
export declare const HUB_BREAK_GLASS_PORT = 4398;
/** `--hub -`: a hub with no instance yet (a machine's first project: dashboards.sh --no-instances). */
export declare const NO_INSTANCES = "-";
/**
 * `a=/state/a,b=/state/b`: each instance's name and state dir (its token file is there). `-` alone: none yet, said
 * outright, so a list that came out empty by mistake is still refused.
 */
export declare function parseHubArg(arg: string, port: (name: string) => number): HubInstance[];
/**
 * The sign-in settings from the files `credentials.sh dashboard-signin` installs (client-secret and session-secret,
 * 0400, the viewer's), the App's client id and the hub's public URL (https, as browsers reach it).
 */
export declare function signInFromFiles(o: {
    clientId: string;
    publicUrl: string;
    dir: string;
}): SignInConfig;
export declare function startHub(opts: HubOptions): Promise<{
    server: Server;
    breakGlass: Server;
    url: string;
    breakGlassUrl: string;
    keyFile: string;
    token: string;
    session: SessionOf;
    close: () => Promise<void>;
}>;
