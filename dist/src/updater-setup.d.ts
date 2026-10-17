import { type UpdateChannelName } from './machine.js';
/** The signers file the updater reads (what a new updates.json names): written only by updates.sh, at a root shell. */
export declare const ALLOWED_SIGNERS: string;
/** The helper's pending list (scripts/machine/, the helper's source; a test keeps the path, the limit and the 24 hours equal). */
export declare const PENDING_SIGNERS: string;
export declare const PENDING_MAX = 4;
export declare const PENDING_TTL_MS: number;
export interface ListedSigner {
    principal: string;
    /** Anything between the principal and the key (namespaces="git", valid-before=...), as written. */
    options: string;
    keyType: string;
    key: string;
    /** ssh-keygen's SHA256 fingerprint; null for a key that isn't base64. */
    fingerprint: string | null;
}
/** The signers a file lists, in its order (comments and blank lines left out); null when there is no file. */
export declare function listedSigners(path?: string): ListedSigner[] | null;
/** The command an admin runs, as root on the machine, to make the staged signer with this fingerprint a signer. */
export declare const confirmCommand: (fingerprint: string) => string;
export interface PendingSigner {
    principal: string;
    key: string;
    fingerprint: string;
    /** The coordinator user that staged it (the helper's SUDO_USER), and so the instance whose dashboard asked. */
    by: string;
    instance: string | null;
    at: string;
    expiresAt: string;
    /** What confirms it: the only way it becomes a signer. */
    confirm: string;
}
/** The signers staged and still waiting (well-formed, under 24 hours old), as the helper itself reads its list. */
export declare function pendingSigners(path?: string, now?: number): PendingSigner[];
export interface SignerToStage {
    principal: string;
    key: string;
    fingerprint: string;
    /** The line the confirming command will add, exactly. */
    line: string;
    /** The root command that confirms it. */
    confirm: string;
}
/**
 * The signer an owner typed: a principal, and a public key as `ssh-ed25519 AAAA... [comment]` (a .pub file's line) or
 * the key alone. The comment is dropped; nothing else is changed. Or why it can't be staged from the page.
 */
export declare function signerInput(principal: unknown, key: unknown): SignerToStage | {
    error: string;
};
export declare const CHANNEL_WHAT: Record<UpdateChannelName, string>;
export interface UpdaterSetup {
    installed: boolean;
    enabled: boolean | null;
    channel: UpdateChannelName | null;
    /** What the channel it is on follows. */
    channelWhat: string | null;
    /** The file the updater's signers are listed in. */
    signersFile: string;
    /** The file this machine's updates.json tells the updater to read, when it isn't that one (an admin's own setup). */
    updaterReads: string | null;
    /** null: no signers file yet. */
    signers: ListedSigner[] | null;
    /** Staged from a dashboard, waiting for an admin's confirming command; each is trusted for nothing until then. */
    pending: PendingSigner[];
    pendingMax: number;
    /** The same steps without the page: as root, from the engine's checkout. */
    script: {
        install: string;
        signer: string;
        confirm: string;
        release: string;
        main: string;
        releaseHold: string;
    };
}
/** The updater's setup as the page shows it. */
export declare function updaterSetup(o?: {
    updatesConfigPath?: string;
    signersPath?: string;
    pendingPath?: string;
    now?: number;
}): UpdaterSetup;
export type UpdaterStep = 'install' | 'release' | 'stage' | 'discard';
export interface UpdaterPlan {
    step: UpdaterStep;
    /** The helper's arguments, exactly as the coordinator will run them. */
    args: string[];
    /** The whole command, for the page. */
    command: string;
    /** What it changes, and what it leaves alone. */
    changes: string[];
    /** The same without the page. */
    script: string;
    /** For a signer to stage: exactly what is staged, and the root command that would then confirm it. */
    signer?: SignerToStage & {
        file: string;
    };
}
/** What one step of the setup would run and change, from what an owner entered; or why it can't. Changes nothing. */
export declare function updaterPlan(body: {
    step?: unknown;
    principal?: unknown;
    key?: unknown;
}, now: UpdaterSetup): UpdaterPlan | {
    error: string;
    status?: 400 | 409;
};
