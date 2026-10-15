import type { StoredEvent } from './events/types.js';
import { type HygieneCounts } from './pr-hygiene.js';
export type TaskStatus = 'triage' | 'ready' | 'claimed' | 'reproducing' | 'building' | 'verifying' | 'evaluating' | 'awaiting_decision' | 'queued' | 'in_review' | 'landed' | 'done' | 'blocked' | 'released';
export declare const STATUS_ORDER: TaskStatus[];
export interface Verdict {
    patch_correct: boolean;
    test_correct: boolean;
    confidence: string;
    advice: string;
}
export interface Task {
    issue: number;
    title: string;
    labels: string[];
    author: string;
    owner: string | null;
    delegate: {
        instance: string;
        role: string;
    } | null;
    status: TaskStatus;
    actionable: boolean;
    why: string;
    level: string | null;
    levelReasons: string[];
    doneWhen: Record<string, unknown>[];
    verdict: Verdict | null;
    costUsd: number;
    attempts: number;
    head: string | null;
    landed: string | null;
    deployed: string | null;
    repro: string | null;
    openDecision: string | null;
    blockedReason: string | null;
    lastActivity: string;
    firstSeen: string;
    eventIds: number[];
}
export interface Decision {
    id: string;
    kind: string;
    issue: number | null;
    owner: string;
    question: string;
    options: string[];
    recommendation: string;
    receipts: string[];
    askedAt: string;
    answer: {
        by: string;
        answer: string;
        at: string;
    } | null;
}
export interface Projection {
    lastId: number;
    tasks: Task[];
    decisions: Decision[];
    /** Estimated (Claude Code's per-run cost estimate, not billed money), today only. */
    spendToday: number;
    /** Same estimate, today only, split by role. */
    spendByRole: Record<string, number>;
    landedToday: number;
    baseline: {
        sha: string;
        failing: string[];
        at: string;
    } | null;
    deploys: {
        env: string;
        sha: string;
        status: 'requested' | 'verified' | 'failed';
        why?: string;
        at: string;
    }[];
    coordinator: {
        instance: string;
        startedAt: string;
        lastTick: string | null;
    } | null;
    /**
     * The coordinator's errors still current, newest first, one per place and message: how many times, first and last
     * (`at` is the last). An error is current until a later tick ends with no error from the same place, or the
     * coordinator starts again after a tick (CoordinatorErrors).
     */
    errors: CoordinatorError[];
    /** Errors that are no longer current (a later tick or a restart cleared them), newest first: history only. */
    earlierErrors: CoordinatorError[];
    activity: {
        id: number;
        ts: string;
        type: string;
        actor: string;
        issue: number | null;
        summary: string;
    }[];
    /** Agent runs in flight (started, not finished), and the most recent finished ones. */
    runs: {
        active: Run[];
        recent: Run[];
    };
    /**
     * Changes waiting to land, oldest first, and recent batches, newest first: direct landing's (`land`), and PR mode's
     * (`pr`: `prs` its PRs, `outcome` its status, src/coordinator/pr-batch.ts batchSummaries).
     */
    landQueue: {
        issue: number;
        title: string;
        head: string;
        level: string;
        queuedAt: string;
        deferred: string | null;
    }[];
    batches: {
        id: string;
        kind: 'land' | 'pr';
        issues: number[];
        prs: number[];
        tip: string;
        outcome: string;
        detail: string;
        at: string;
    }[];
    governor: {
        held: boolean;
        reason: string | null;
        load: number | null;
        freeDiskPct: number | null;
        at: string;
    } | null;
    /** This coordinator's own record of emergency stops: the last time it halted for one, and the last time it resumed. */
    emergency: {
        lastStop: {
            at: string;
            by: string;
            reason: string;
            running: number;
        } | null;
        lastResume: string | null;
    };
    reports: {
        day: string;
        slot: string;
        issue: number | null;
        at: string;
    }[];
}
/** Errors the coordinator records, grouped by where and message. */
export interface CoordinatorError {
    where: string;
    message: string;
    kind: string;
    count: number;
    first: string;
    last: string;
    /** The last time (the same as `last`). */
    at: string;
}
export interface Run {
    issue: number;
    role: string;
    model: string;
    pid: number;
    attempt: number;
    startedAt: string;
    lastHeartbeat: string | null;
    note: string | null;
    finishedAt: string | null;
    reason: string | null;
    costUsd: number;
}
/** A setting's value as one short line: run windows as from-to pairs, the rest as written. */
export declare function settingText(v: unknown): string;
export declare function summarize(e: StoredEvent): string;
/** `today`: the day (YYYY-MM-DD) "today" counts, in this machine's local time (src/local-day.ts). */
export declare function project(events: StoredEvent[], today?: string): Projection;
/** What needs this person: their open decisions, their blocked tasks, and recent L2 landings to look over. */
export declare function inbox(p: Projection, user: string): {
    decisions: Decision[];
    blocked: Task[];
    notify: Task[];
};
/** One run of the coordinator's own checks on an issue, as the issue page shows it. */
export interface CheckRunView {
    id: number;
    at: string;
    /** verify, land, ... or "no change" for a no-change finding checked on the unchanged base. */
    stage: string;
    head: string;
    checks: {
        check: string;
        status: string;
        exitCode: number | null;
        tail: string | null;
    }[];
}
/** An issue's check results, newest first: every check the coordinator ran itself, with each failure's output. */
export declare function checkResults(events: StoredEvent[], issue: number): CheckRunView[];
/** One pull request the harness opened, as the PR page shows it: from its pr.*, ci_fix.* and merge.* events. */
export interface PrView {
    number: number;
    issue: number;
    title: string;
    url: string;
    openedAt: string;
    /** The commit the PR is at now: as opened, the last fix pushed, or what the watch last saw (a person's push). */
    head: string;
    /** open, merged (by the harness or a person), or closed unmerged. */
    state: 'open' | 'merged' | 'closed';
    /** Draft until the harness marks it ready (required checks green on the evaluated commit). */
    draft: boolean;
    /** The watch's last look at the current head: each required check's outcome, and why it isn't ready yet. */
    status: {
        head: string;
        at: string;
        ready: boolean;
        reasons: string[];
        checks: {
            name: string;
            outcome: string;
        }[];
    } | null;
    /** The last time it was marked not ready, and why. */
    unready: {
        at: string;
        why: string;
    } | null;
    fixes: {
        attempt: number;
        at: string;
        checks: string[];
        outcome: 'running' | 'pushed' | 'no_push' | 'interrupted';
        detail: string;
    }[];
    /** No more fix runs; the owner was asked to look. */
    gaveUp: {
        at: string;
        reason: string;
    } | null;
    /** The merge policy's last call: merged automatically, or waiting for a person, with its reasons. */
    decision: {
        at: string;
        head: string;
        auto: boolean;
        reasons: string[];
    } | null;
    /** The merge policy's "wait for a person" reasons, while that call stands (the PR is still at the head it was made on). */
    waitReasons: string[];
    merged: {
        at: string;
        sha: string;
        url: string;
        auto: boolean;
    } | null;
    mergeFailed: {
        at: string;
        why: string;
    } | null;
    /** After an auto-merge: the default branch's required checks on the merge commit. */
    mainResult: {
        at: string;
        outcome: 'green' | 'red' | 'timed_out';
        failed: string[];
    } | null;
    /**
     * The last conflict with main and its fix: detected, being resolved (a merge of main, attempt n), or done with
     * its outcome, the files it touched, and whether the result waits for a person (and why).
     */
    conflict: {
        state: 'detected' | 'running' | 'done';
        at: string;
        attempt: number;
        outcome: string | null;
        files: string[];
        waitsOwner: boolean;
        reasons: string[];
        detail: string;
    } | null;
    /** The last light check (the PR combined with main's latest before it merges): running since `at`, or its outcome and wait. */
    lightCheck: {
        state: 'running' | 'done';
        at: string;
        mainSha: string;
        overlap: string[];
        outcome: string | null;
        waitMs: number | null;
        detail: string;
    } | null;
    /** Where it stands, for grouping: waiting for a person, being fixed, a conflict being resolved, a light check running, checks running, gave up, auto-merged, merged, closed. */
    phase: 'waiting' | 'fixing' | 'resolving' | 'light_check' | 'gave_up' | 'checks' | 'ready' | 'auto_merged' | 'merged' | 'closed';
}
export interface PrsView {
    prs: PrView[];
    /** Pushes the harness refused before they left (size, protected paths, ...), newest first. */
    refused: {
        at: string;
        issue: number;
        title: string;
        head: string;
        stage: string;
        reasons: string[];
    }[];
    /** This instance's auto-merge stops and resumes, newest first. */
    stops: {
        at: string;
        kind: 'stopped' | 'resumed';
        reason: string;
        number: number | null;
        revert: string | null;
    }[];
    /** Tasks held because another task is changing the same hotspot files, newest first: still held (until null), or released after waitedMs. */
    holds: {
        issue: number;
        title: string;
        by: number;
        files: string[];
        reason: string;
        since: string;
        until: string | null;
        waitedMs: number | null;
        kind?: 'files' | 'dependency';
    }[];
    /** The latest stale-PR pass (src/pr-hygiene.ts): when, its counts and their line; null before the first. */
    hygiene: (HygieneCounts & {
        at: string;
        line: string;
    }) | null;
}
/** Every PR the harness opened, newest first, with what happened to it; plus refused pushes and auto-merge stops. */
export declare function prsView(events: StoredEvent[]): PrsView;
/** Whether the last conflict fix left the PR to a person: it gave up, or what it pushed waits for review. */
export declare const conflictNeedsOwner: (pr: Pick<PrView, "conflict">) => boolean;
