import { type Server } from 'node:http';
export declare const SETUP_TOKEN_FILE = "setup-token";
/** The file whose existence ends setup mode: the sign-in App's client secret (credentials.sh dashboard-signin's too). */
export declare const SIGNIN_SECRET_FILE = "client-secret";
/** __Host-: Secure, Path=/, no Domain: only this origin, only over https. */
export declare const SETUP_COOKIE = "__Host-setup";
/** Loopback mode's session cookie: plain http on loopback has no Secure cookie to give, so no __Host- prefix either. */
export declare const SETUP_LOOPBACK_COOKIE = "setup-loopback";
/** The wizard's screen that gives the machine its https origin: Tailscale and HTTPS. */
export declare const HTTPS_SCREEN = 7;
export declare const SETUP_SESSION_MS: number;
export declare const SETUP_MAX_TRIES = 10;
export interface SetupHubOptions {
    /** The hub's state directory (the viewer user's): the setup token file is here. */
    stateDir: string;
    /** Where the sign-in secrets go (credentials.sh dashboard-signin's directory). */
    signinDir: string;
    /**
     * The hub's https origin, as browsers reach it (tailscale serve): GitHub sends the browser back here. null: loopback
     * mode, before the machine has one (the App step then waits for screen 7).
     */
    publicUrl: string | null;
    /** Loopback mode: the root script for screen 7's steps (scripts/setup/tailscale.sh) and the command to run after them. */
    tailscaleScript?: string;
    rerunCommand?: string;
    port?: number;
    host?: string;
    /** The App's name starts with this (`<name>-<cli>-signin`); this machine's short host name by default. */
    appPrefix?: string;
    /** The command the done page names for starting the real hub. */
    nextCommand?: string;
    /** GitHub's bases and fetch (a fake GitHub in tests). */
    github?: {
        api?: string;
        web?: string;
        fetch?: typeof fetch;
    };
    /** How often it looks for the sign-in secret (someone may install it by hand meanwhile). */
    checkMs?: number;
    now?: () => number;
}
export declare class SetupOver extends Error {
}
/** Whether setup mode is over: the sign-in App's client secret is in place. */
export declare const setupOver: (signinDir: string) => boolean;
/** This machine's short host name as an App name prefix, or `hub`. */
export declare function defaultAppPrefix(host?: string): string;
/**
 * The setup token: the one in the file, or a new one written there (0600) when there is none. Refuses a file anyone
 * but this user may read, or one this user doesn't own. Only its hash is kept.
 */
export declare function setupToken(stateDir: string): {
    file: string;
    hash: Buffer;
};
/** The setup-mode hub. Throws SetupOver when the sign-in secret exists already: there is nothing to set up. */
export declare function startSetupHub(o: SetupHubOptions): Promise<{
    server: Server;
    url: string;
    tokenFile: string;
    closed: Promise<string>;
    close: (why?: string) => Promise<string>;
}>;
