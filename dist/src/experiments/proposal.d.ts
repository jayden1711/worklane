import { type Study } from './study.js';
export declare const TEXT_CAPS: {
    readonly hypothesis: 200;
    readonly variable: 200;
    readonly motivation: 600;
    readonly expected_effect: 200;
};
/** The session's structured output (the runner's jsonSchema): one hypothesis, one config, and nothing else. */
export declare const PROPOSAL_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["hypothesis", "variable", "motivation", "expected_effect", "config"];
    readonly properties: {
        readonly hypothesis: {
            readonly type: "string";
            readonly maxLength: 200;
        };
        readonly variable: {
            readonly type: "string";
            readonly maxLength: 200;
        };
        readonly motivation: {
            readonly type: "string";
            readonly maxLength: 600;
        };
        readonly expected_effect: {
            readonly type: "string";
            readonly maxLength: 200;
        };
        readonly config: {
            readonly type: "object";
        };
    };
};
export interface Proposal {
    hypothesis: string;
    /** The one thing it changes (one knob, or the code), in the session's words. */
    variable: string;
    motivation: string;
    expected_effect: string;
    config: Record<string, string | number>;
}
/** Text from a session as the log keeps it: one paragraph, secrets redacted, cut to its cap. */
export declare const logText: (s: string, cap: number) => string;
/** The session's output as a proposal, or why it is refused. */
export declare function readProposal(raw: unknown, study: Study): Proposal | {
    refused: string;
};
/** One changed path as `git diff --raw -z --no-renames` reports it. */
export interface Change {
    path: string;
    oldMode: string;
    newMode: string;
    status: string;
}
/** `git diff --raw -z --no-renames <parent>` (with or without --cached) as changes. */
export declare function parseRawDiff(z: string): Change[];
/**
 * Whether a session's change may run: non-empty, only plain files (no symlink, no submodule, no mode change, no new
 * executable), every path inside the study's editable globs and none of its eval files. `lockfile`: it changes the
 * environment, which an owner approves first.
 */
export declare function checkChange(changes: readonly Change[], study: Study): {
    ok: true;
    files: string[];
    lockfile: boolean;
} | {
    ok: false;
    why: string;
};
