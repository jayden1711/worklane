import { type Ask, type Role } from '../console/asks.js';
import type { SecretRule } from '../console/secrets.js';
import type { EventLog } from '../events/log.js';
import { type IntakeCredentialKey } from '../instance.js';
import { type RunCli } from './discord-setup.js';
import { IntakeConfig } from './report.js';
import type { LinearView, SlackView } from './source-view.js';
export type SourceKind = 'slack' | 'linear';
export declare const SOURCE_KINDS: readonly SourceKind[];
/** What a Slack app-level token looks like (credentials.sh intake-slack checks the same). */
export declare const SLACK_APP_TOKEN_SHAPE: RegExp;
/** What a Slack bot token looks like. */
export declare const SLACK_BOT_TOKEN_SHAPE: RegExp;
/** What a Linear personal API key looks like. */
export declare const LINEAR_KEY_SHAPE: RegExp;
/** The Slack app intake needs, exactly: Socket Mode, the app_mention event, and these bot scopes. Nothing else. */
export declare const SLACK_SCOPES: readonly [{
    readonly scope: "app_mentions:read";
    readonly why: "be told about messages that mention the bot, in channels it is in (and only those)";
}, {
    readonly scope: "chat:write";
    readonly why: "reply in the message's thread";
}, {
    readonly scope: "users:read";
    readonly why: "a sender's display name, only to take it out of their text before anything else sees it; and the people's ids, for you to copy";
}, {
    readonly scope: "channels:read";
    readonly why: "list the public channels, so you can pick them here";
}];
/** The manifest to create the Slack app from: Socket Mode on, one event, the scopes above. */
export declare function slackManifest(name?: string): Record<string, unknown>;
/** The permissions to give the Linear key: the least intake uses. */
export declare const LINEAR_PERMISSIONS: readonly [{
    readonly name: "Read";
    readonly why: "list the team's labelled issues, and read the ones from people you list";
}, {
    readonly name: "Create comments";
    readonly why: "one status comment on each report";
}, {
    readonly name: "Team access: only the one team";
    readonly why: "it reads nothing else";
}];
/** Where each source's secret is made. */
export declare const PORTAL: Record<SourceKind, string>;
interface CredDef {
    /** The paste_secret ask's credential name (the file's name in the instance's secrets directory). */
    credential: string;
    key: IntakeCredentialKey;
    title: string;
    detail: string;
    shape: {
        re: RegExp;
        what: string;
    };
}
/** Each source's secrets, in the order they are pasted. */
export declare const SOURCE_CREDS: Record<SourceKind, readonly CredDef[]>;
export declare const credDef: (credential: string) => (CredDef & {
    kind: SourceKind;
}) | null;
export interface CredState {
    credential: string;
    key: IntakeCredentialKey;
    title: string;
    /** credentials.yaml names a file. */
    configured: boolean;
    file: string | null;
    /** A file is at that path (not read). */
    present: boolean;
    error: string | null;
}
export declare function credStates(credentialsFile: string, kind: SourceKind): CredState[];
/** The setup console's rules for the pasted secrets: each one's shape, then credentials.yaml pointed at its file. */
export declare function sourceSecretRules(o: {
    instance: string;
    credentialsFile: string;
    onStored?: (kind: SourceKind) => void;
}): Record<string, SecretRule>;
/** The open paste box for one of a source's secrets: the one already waiting, or a new ask. Nothing is stored yet. */
export declare function sourceTokenAsk(log: EventLog, instance: string, credential: string, by: string): {
    ask: Ask;
    created: boolean;
};
export type SourceView = ({
    kind: 'slack';
} & SlackView) | ({
    kind: 'linear';
} & LinearView);
/**
 * What the source's secret can see, from `<kind> view --instance <name> --json` run as a child process (the Discord
 * step's runner: this engine's own cli.js, or a stand-in made in code). A failure is the child's own one line.
 */
export declare function sourceView(kind: SourceKind, instance: string, run: RunCli): Promise<SourceView & {
    at: string;
}>;
export type SourceKeyKind = 'boolean' | 'team' | 'ids' | 'label';
export type SourceFormValue = boolean | string | string[] | null;
/** The intake.yaml keys each step writes, and nothing else in the file. */
export declare const SOURCE_FORM: Record<SourceKind, readonly {
    key: string;
    kind: SourceKeyKind;
    what: string;
}[]>;
export declare const sourceFormKeys: (kind: SourceKind) => string[];
export declare const sourceFormValues: (kind: SourceKind, cfg: IntakeConfig) => Record<string, SourceFormValue>;
export interface SourcePlan {
    file: string;
    creates: boolean;
    changes: {
        key: string;
        from: SourceFormValue;
        to: SourceFormValue;
    }[];
    diff: string;
    hash: string;
    warnings: string[];
    text: string;
}
/**
 * The change these values make to intake.yaml, or why it is refused. Nothing is written.
 * - Only the step's own keys; every other key and comment of the file is kept (allowed senders and trust included).
 * - A newly picked workspace, channel, team or label must be one the source's view shows: never typed in.
 * - Slack: the workspace must be the one the bot token belongs to. Linear: the label must be the team's, or a
 *   workspace label.
 * - The result must pass the intake schema.
 */
export declare function planSourceIntake(o: {
    kind: SourceKind;
    path: string;
    values: Record<string, unknown>;
    view: SourceView;
}): SourcePlan;
/** Write a confirmed change: planned again, and written only when it is the very change that was shown (`expect`). */
export declare function applySourceIntake(o: {
    kind: SourceKind;
    path: string;
    values: Record<string, unknown>;
    view: SourceView;
    expect: string;
}): SourcePlan;
export interface SourceSetupView {
    available: true;
    kind: SourceKind;
    instance: string;
    /** Whether this person may act (the instance's owners). */
    canAct: boolean;
    portal: string;
    creds: (CredState & {
        ask: (Ask & {
            canAnswer: boolean;
        }) | null;
    })[];
    intake: {
        file: string;
        exists: boolean;
        error: string | null;
        values: Record<string, SourceFormValue>;
        warnings: string[];
        allowed: number;
        trusted: number;
    };
    form: {
        key: string;
        kind: SourceKeyKind;
        what: string;
    }[];
    /** Slack: the app's manifest and scopes. Linear: the key's permissions. */
    slack?: {
        manifest: string;
        scopes: {
            scope: string;
            why: string;
        }[];
    };
    linear?: {
        permissions: {
            name: string;
            why: string;
        }[];
    };
    automation: {
        token: string;
        view: string;
        file: string;
        keys: string[];
        restart: string;
    };
}
/** The step as the page shows it: all from local files and the event log; no network, nothing written, no secret. */
export declare function sourceSetupView(o: {
    kind: SourceKind;
    instance: string;
    home: string;
    asks: readonly Ask[];
    role: Role | null;
    engineRoot: string;
    user?: string;
}): SourceSetupView;
export interface SourceSummary {
    name: 'discord' | SourceKind;
    /** on: enabled with its secret stored; off: secret stored, not enabled; none: not set up; invalid: intake.yaml refused. */
    state: 'on' | 'off' | 'none' | 'invalid';
    /** Counts only: never an id or a name. */
    detail: string;
}
/** Each chat source's state for the Intake page, from local files only: never a secret, an id or a person. */
export declare function intakeSourcesSummary(home: string): SourceSummary[];
export {};
