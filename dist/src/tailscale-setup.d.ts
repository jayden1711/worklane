import type { EventLog } from './events/log.js';
import type { StoredEvent } from './events/types.js';
import type { Role } from './console/asks.js';
import { type MachineRequester } from './machine-owners.js';
import { type MachineRequest } from './machine-requests.js';
/** Where tailscale.sh writes steps.jsonl (root's, 0644) and, while `up` waits, login-url (0400, this coordinator's user; lib.sh's TAILSCALE_DIR). */
export declare const TAILSCALE_DIR: string;
/** The installed engine's script: its `status --json` is what the screen shows (no root needed). */
export declare const TAILSCALE_SCRIPT: string;
/** The helper's four tailscale commands, in the order the screen walks them (scripts/machine/, the helper's source; a test keeps the two equal). */
export declare const TAILSCALE_ACTIONS: readonly ["install", "up", "serve", "public-url"];
export type TailscaleAction = (typeof TAILSCALE_ACTIONS)[number];
export declare const isTailscaleAction: (s: unknown) => s is TailscaleAction;
/** The login link `tailscale up` prints, strictly (lib.sh's tailscale_login_url_ok): Tailscale's own login host and a short id. */
export declare const TAILSCALE_LOGIN_URL: RegExp;
/** A step with no new line for this long has stopped (its unit ended without a last line): the longest wait is `up`'s 10 minutes. */
export declare const STEP_STALE_MS: number;
/** Where the tailnet's MagicDNS and HTTPS certificates are turned on: Tailscale's own page. */
export declare const TAILSCALE_DNS_ADMIN = "https://login.tailscale.com/admin/dns";
/** What `tailscale.sh status --json` says, each value checked. */
export interface TailscaleStatus {
    installed: boolean;
    version: string | null;
    /** The version the install step would install. */
    pinnedVersion: string | null;
    /** tailscale's BackendState (Running, NeedsLogin, Stopped, ...); null without one. */
    state: string | null;
    /** This machine's tailnet name; null off a tailnet. */
    name: string | null;
    /** The tailnet issues an HTTPS certificate for that name. */
    https: boolean;
    /** tailscale serve forwards https 443 on that name to the hub's sign-in port. */
    serve: boolean;
    other443: boolean;
    breakGlassForwarded: boolean;
    /** Tailscale Funnel (the public internet) is on for something on this machine. Shown, never changed from here. */
    funnel: boolean;
    /** The hub's URL now (its unit's --public-url); null with no hub. */
    hubUrl: string | null;
}
/** The script's status output, parsed strictly; null when it isn't that. */
export declare function parseTailscaleStatus(text: string): TailscaleStatus | null;
/** Ask the installed script (as this user: it reads only); null when it isn't there or doesn't answer. */
export declare function tailscaleStatus(script?: string): Promise<TailscaleStatus | null>;
export type StepState = 'started' | 'running' | 'waiting' | 'done' | 'failed';
export interface StepLine {
    at: string;
    step: TailscaleAction;
    state: StepState;
    detail: string;
}
/** Which version of the progress file this is (its size and change time; '' when there is none): it changes with every line. */
export declare function stepsStamp(dir?: string): string;
/** The progress lines of the last step (steps.jsonl); torn or foreign lines are skipped. */
export declare function readStepLines(dir?: string): StepLine[];
export interface StepRun {
    step: TailscaleAction;
    startedAt: string;
    status: 'running' | 'waiting' | 'done' | 'failed' | 'stalled';
    detail: string;
    lines: StepLine[];
}
/** The last step run on this machine, from its lines; null when there has been none. */
export declare function stepRun(lines: readonly StepLine[], now?: number): StepRun | null;
/**
 * The login link `up` is waiting on: the file the script wrote for this coordinator's user, when it holds exactly
 * Tailscale's login page. Anything else (no file, another host, a key in it) is no link.
 */
export declare function readLoginUrl(dir?: string): string | null;
/** Whether this person sees the screen (and so the login link): a machine owner, or the owner's break-glass. */
export declare const mayViewTailscale: (r: Pick<MachineRequester, "login" | "breakGlass">, file?: string) => boolean;
/** Why this person may not run a step now; null when they may (the same gate as any machine change). */
export declare function tailscaleGate(who: {
    role: Role | null;
    requester: MachineRequester;
}, o?: {
    ownersFile?: string;
}): string | null;
export interface TailscaleStepView {
    id: TailscaleAction;
    title: string;
    done: boolean;
    /** Why it can't be run yet (an earlier step, or something only Tailscale's own pages can change); null when it can. */
    blocked: string | null;
    /** What it changes on the machine, shown before the owner confirms. */
    changes: string[];
    /** The same step without the dashboard, as root. */
    command: string;
    /** A page of Tailscale's own to open for it, when the step needs one. */
    link: {
        url: string;
        label: string;
    } | null;
}
/** The four steps against what the machine says now: which are done, which can run, and what each would change. */
export declare function tailscaleSteps(s: TailscaleStatus | null): TailscaleStepView[];
/** The screen's data: the machine's state, the four steps, the last run, this log's requests, and whether this person may act. */
export declare function tailscaleView(o: {
    status: TailscaleStatus | null;
    dir?: string;
    events: readonly StoredEvent[];
    who: {
        role: Role | null;
        requester: MachineRequester;
    };
    instance: string;
    ownersFile?: string;
    now?: number;
}): {
    machineOwner: boolean;
    machineOwners: string[];
    login: string;
    instance: string;
    /** Whether this person may run a step (the server checks again). */
    allowed: boolean;
    why: string | null;
    busy: string | null;
    /** Null: the installed engine has no tailscale.sh, or it didn't answer (the steps can't be offered). */
    status: TailscaleStatus | null;
    steps: TailscaleStepView[];
    /** The first step not done: the one the screen offers. */
    next: "install" | "up" | "serve" | "public-url" | null;
    run: StepRun | null;
    /** The login link, only while `up` waits on it, and only for the people who see this screen. */
    loginUrl: string | null;
    requests: MachineRequest[];
    /** The same without the dashboard. */
    script: {
        status: string;
        steps: string[];
    };
};
export type TailscaleData = ReturnType<typeof tailscaleView>;
/**
 * What everyone else is sent (not a machine owner, or a local checkout, which has no hub): that there is nothing for
 * them here, and nothing else. No state, no steps, no link. The page renders nothing from it.
 */
export declare function noTailscaleView(login: string, instance: string | null): TailscaleData;
/**
 * Record `tailscale <step>` for the coordinator to run through the machine helper: the same gate as any machine
 * change, one step at a time, and only a step the machine is ready for (the script checks that again, as root).
 * The request is those two words: nothing a person typed is part of it.
 */
export declare function requestTailscale(log: EventLog, r: {
    action: unknown;
    status: TailscaleStatus | null;
    requester: MachineRequester;
    dir?: string;
    ownersFile?: string;
    now?: number;
}): MachineRequest;
