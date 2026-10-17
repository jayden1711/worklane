export declare const MACHINE_HELPER: string;
export declare const MACHINE_CHANGES: string;
export declare const SLOTS_MIN = 1;
export declare const SLOTS_MAX = 16;
export interface MachineChange {
    at: string;
    by: string;
    what: string;
    from: unknown;
    to: unknown;
}
export type Exec = (file: string, args: string[]) => string;
export type MachineResult = {
    ok: true;
    output: string;
} | {
    ok: false;
    error: string;
};
/** One plugin or MCP step through the helper (src/plugins/steps.ts checked its shape), for the asking coordinator's instance. */
export declare function pluginStep(args: readonly string[], exec?: Exec): MachineResult;
/** Set the machine's agent slot cap (1..16) through the helper. */
export declare function setSlotCap(n: number, exec?: Exec): MachineResult;
export declare const TEST_SLOTS_MIN = 1;
export declare const TEST_SLOTS_MAX = 8;
/** Set how many test runs go at once on the machine (1..8) through the helper. */
export declare function setTestSlotCap(n: number, exec?: Exec): MachineResult;
/** Turn automatic engine updates on or off through the helper. */
export declare function setUpdates(on: boolean, exec?: Exec): MachineResult;
/**
 * The agents' Claude account through the helper (scripts/setup/claude-account.sh, src/claude-account.ts): status
 * refreshes each agent user's account and expiry; switch starts the switch as its own unit, which then takes the token
 * from this instance's dashboard.
 */
export declare function claudeAccount(action: 'status' | 'switch', exec?: Exec): MachineResult;
/**
 * A Claude account profile step through the helper (src/claude-profiles.ts): profile-add|remove|use <profile>, for
 * this coordinator's own instance (the helper takes it from sudo). It starts the step as its own unit and returns at
 * once; the caller checked the shape.
 */
export declare function claudeProfile(args: readonly string[], exec?: Exec): MachineResult;
/** What the engine updater follows (scripts/machine/, the updater): signed release tags, or main's green commits. */
export declare const UPDATE_CHANNELS: readonly ["release", "main"];
export type UpdateChannelName = (typeof UPDATE_CHANNELS)[number];
/** Install the engine updater (off) through the helper: the installed engine's scripts/setup/updates.sh, no arguments. */
export declare function installUpdater(exec?: Exec): MachineResult;
/**
 * Put an installed updater on the release channel (signed release tags), through the helper; nothing else in its
 * config changes. The helper takes no other channel: following main is an admin's, at a root shell.
 */
export declare function followReleases(exec?: Exec): MachineResult;
/**
 * A staged signer's arguments, exactly as the machine helper takes them (scripts/machine/, the helper's source; a
 * test keeps the two equal): one principal of an email's shape (never a pattern, a list or an option) and one ed25519
 * public key in its fixed encoding (the key type's name and 32 bytes: 68 base64 characters).
 */
export declare function signerPrincipalOk(s: unknown): s is string;
export declare function signerKeyOk(s: unknown): s is string;
/** A public key's fingerprint as `ssh-keygen -l` prints it: what an owner checks the key against. */
export declare function signerFingerprint(key: string): string;
/**
 * Stage one release signer through the helper, or take a staged one back out. Staging adds nothing to the keys the
 * updater trusts: the helper only writes its pending list, and an admin confirms a staged signer at a root shell.
 */
export declare function stagedSigner(action: 'stage' | 'discard', principal: string, key: string, exec?: Exec): MachineResult;
/**
 * A Tailscale setup step through the helper (scripts/setup/tailscale.sh, src/tailscale-setup.ts): it starts the step
 * as its own unit and returns at once. The step is one fixed word; nothing else is passed.
 */
export declare function tailscaleStep(action: 'install' | 'up' | 'serve' | 'public-url', exec?: Exec): MachineResult;
/**
 * add-project's arguments, exactly as the machine helper takes them (scripts/machine/, the helper's source; a test
 * keeps the two equal): an instance name (src/instance-name.ts: never one whose users or units are another's) and a
 * GitHub owner/name.
 */
export declare function addProjectNameOk(s: unknown): s is string;
export declare function addProjectRepoOk(s: unknown): s is string;
/** What machine-helper.sh recorded about this machine's sudo rule (scripts/setup/lib.sh HELPER_RULES). */
export declare const HELPER_RULES: string;
/** The root command an owner runs instead, where the helper's add-project rule isn't installed. */
export declare const ADD_PROJECT_SCRIPT: string;
/**
 * The helper's commands this machine's sudo rule leaves out (an older sudo reads their patterns as literal text), and
 * that sudo's version; null when machine-helper.sh hasn't recorded it (a machine set up before it did).
 */
export declare function helperRules(path?: string): {
    sudo: string | null;
    leftOut: string[];
} | null;
/** The root command for one add-project, its name and repo filled in (or placeholders). */
export declare const addProjectCommand: (name?: string, repo?: string) => string;
/** The helper's change log, newest last; unreadable or malformed lines are skipped. */
export declare function machineChanges(path?: string, limit?: number): MachineChange[];
