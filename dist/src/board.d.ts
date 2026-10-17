import type { StoredEvent } from './events/types.js';
import { type PrView, type Task, type TaskStatus } from './projection.js';
import { type WaitKind } from './digest.js';
import { type Role } from './dashboard-auth.js';
import type { LiveRun } from './console.js';
import type { ProcessGroupUsage } from './os/stats.js';
import { type BatchStatus } from './coordinator/pr-batch.js';
import { type HoldBanner } from './governor-holds.js';
export declare const BOARD_COLUMNS: readonly ["planning", "building", "verifying", "waiting", "landing"];
export type BoardColumn = (typeof BOARD_COLUMNS)[number];
export declare const COLUMN_LABEL: Record<BoardColumn, string>;
export type CheckState = 'failing' | 'pending' | 'passing' | 'none';
export interface BoardCard {
    instance: string;
    issue: number;
    title: string;
    column: BoardColumn;
    status: TaskStatus;
    /** The PR the harness opened for it (the open one, else the latest), with GitHub's link. */
    pr: {
        number: number;
        url: string;
        phase: PrView['phase'];
    } | null;
    /** Lines added and removed: the PR's as GitHub last reported them, else the last change the coordinator proposed. */
    diff: {
        added: number | null;
        removed: number | null;
        lines: number;
        files: number;
        source: 'pr' | 'change';
    } | null;
    /** Comments and review comments on the PR, as the watch last recorded them; null before a PR (or before it was recorded). */
    comments: number | null;
    /** When work on it began (its claim; for a task not started, when it was first seen), and since when it is in this column's state. */
    startedAt: string;
    since: string;
    /** failing, pending or passing: the PR's required checks at its head, else the coordinator's last check run on it. */
    checks: {
        state: CheckState;
        source: 'pr' | 'coordinator' | null;
        items: {
            name: string;
            outcome: string;
        }[];
    };
    /** The agent running on it now: which, since when, its last heartbeat, its live run (for Watch and Steer) and what its processes use. */
    run: {
        role: string;
        model: string;
        startedAt: string;
        lastHeartbeat: string | null;
        note: string | null;
        live: string | null;
        usage: ProcessGroupUsage | null;
    } | null;
    /**
     * Why it waits on the owner (the digest's), when it does; `detail`, and `reasons` (each of a PR hold's reasons whole,
     * one chip each), only for those who may read the digest.
     */
    waiting: {
        kind: WaitKind;
        label: string;
        detail: string | null;
        reasons: string[] | null;
        since: string;
    } | null;
    /** The open decision on it. */
    decision: {
        id: string;
        kind: string;
        question: string;
        options: string[];
        recommendation: string;
    } | null;
    level: string | null;
    /** Its PR's head with the PR batches (PR mode with batching): queued, being tested, passed or returned; null when not in them. */
    batch: {
        status: 'queued' | 'testing' | 'passed' | 'returned';
        id: string | null;
    } | null;
    /** A high-risk change that waits for the owner: an L3 review level, or a landing decision (direct mode). */
    highRisk: boolean;
    /**
     * What this asker may do from the card. watch: the run's live feed (the owner and writers, the runs gate).
     * steer: a console message to the run (the owner and writers, the console's rule). answer: the open decision,
     * where the decision rules let this role answer it (plans and landings are the owner's). approve: a high-risk
     * change waiting for the owner, the owner's alone: its landing decision, or the PR to merge on GitHub.
     */
    actions: {
        watch: 'feed' | null;
        steer: boolean;
        answer: boolean;
        approve: {
            decision: string;
            options: string[];
        } | {
            merge: string;
        } | null;
    };
}
export interface BoardView {
    instance: string;
    role: Role;
    at: string;
    columns: {
        id: BoardColumn;
        label: string;
    }[];
    cards: BoardCard[];
    /** The machine's agent slots (every instance and harness on it). */
    slots: {
        cap: number;
        running: number;
    };
    /** The Landing column's PR batches: those running, then the last few, newest first; `detail` not for viewers. */
    batches: BoardBatch[];
    /** Why dispatch holds now (the last `governor.hold`, until its release), with its numbers and fix; null when it doesn't. */
    hold: HoldBanner | null;
}
export interface BoardBatch {
    id: string;
    status: BatchStatus;
    prs: number[];
    issues: number[];
    at: string;
    detail: string;
}
export interface BoardInput {
    events: StoredEvent[];
    instance: string;
    role: Role;
    /** Whether this role may read what waits on the owner (the digest): the wait's detail is shown only then. */
    canReadDigest: boolean;
    /** The coordinator's live runs (console/live.json). */
    live: LiveRun[];
    slots: {
        cap: number;
        running: number;
    };
    /** What each process group uses now (os/stats processGroupUsage); nothing measured when unset. */
    usage?: (pgids: number[]) => Map<number, ProcessGroupUsage>;
    now?: Date;
}
/** The overall state of a set of check outcomes: any failure fails it, then anything not finished is pending. */
export declare function checkState(outcomes: string[]): CheckState;
/** Which column a task is in: waiting on the owner first, else by its status (and, in review, its PR's phase). Null: not on the board. */
export declare function columnOf(t: Pick<Task, 'status'>, o: {
    waits: boolean;
    pr: Pick<PrView, 'phase' | 'state'> | null;
    runRole: string | null;
}): BoardColumn | null;
/** The Board for one instance, as this role sees it. */
export declare function boardView(i: BoardInput): BoardView;
/**
 * A card as a viewer (read on the repo) may have it: an allowlist of its fields, as src/viewer-events.ts allows a
 * viewer only some events and fields. A viewer sees the task's progress, its PR, its decision and why it waits
 * (not the digest's reason): never the agent running on it (its live run, what it uses), the change's size or the
 * checks' outcomes, which come from events viewers don't get; and they may do nothing from it. A field added to
 * cards later stays hidden from viewers until it is put here.
 */
export declare const VIEWER_CARD_FIELDS: readonly string[];
export declare const VIEWER_BOARD_KEYS: readonly string[];
/** The board as a viewer may have it: only the allowlisted keys, each card only its allowlisted fields, and no actions. */
export declare function boardForViewer(b: BoardView): Record<string, unknown>;
