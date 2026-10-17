import { type Issue } from './backlog/types.js';
import type { StoredEvent } from './events/types.js';
export declare class FirstTaskError extends Error {
}
/** One done_when check the form builds: a test (by file or name), or a command and, optionally, text its output must hold. */
export type DoneWhenPick = {
    test: string;
} | {
    command: string;
    expect?: string;
};
export interface FirstTaskInput {
    title: string;
    outcome: string;
    done_when: DoneWhenPick[];
    context?: string;
}
/**
 * The issue body for these answers: the Outcome, the done_when block (each test as `- test:`, each command as a YAML
 * block scalar; an expected output becomes `<command> | grep -qF -- '<text>'`), and any context. Checked with
 * parseContract, the coordinator's own parser: a body it would refuse is never returned. `footer`: its last line (an
 * automation's issue names the automation there).
 */
export declare function firstTaskBody(given: Partial<Record<keyof FirstTaskInput, unknown>>, footer?: string): {
    title: string;
    body: string;
};
/** The shape to copy by hand: the label to add, and a body with the fenced done_when block. */
export declare const FIRST_TASK_TEMPLATE: {
    label: string;
    body: string;
};
/** The `ready` label as the CLI's `labels` command creates it. */
export declare const READY_LABEL: {
    readonly name: "ready";
    readonly color: "0e8a16";
    readonly description: "Approved by a writer; has a done_when contract";
};
export type IgnoreKind = 'no-ready' | 'contract' | 'not-writer' | 'waiting' | 'blocked' | 'held';
export interface IgnoreReason {
    kind: IgnoreKind;
    text: string;
    /** A one-click fix where safe: add the `ready` label (a writer's, as the coordinator counts it). */
    fix: 'add-ready' | 'edit' | null;
}
export interface IgnoredIssue {
    issue: number;
    title: string;
    url: string;
    author: string;
    labels: string[];
    reasons: IgnoreReason[];
}
/**
 * Why each open issue isn't being worked on, as the coordinator decided it (its events), or, for one it never lists
 * (no `ready`), that. An issue the coordinator is working on (claimed, not released or blocked since) has none and is
 * left out, as is one with no reason found.
 */
export declare function ignoredIssues(open: Issue[], events: StoredEvent[], o: {
    repo: string;
}): IgnoredIssue[];
