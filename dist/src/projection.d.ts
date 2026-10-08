import type { StoredEvent } from './events/types.js';
export type TaskStatus = 'triage' | 'ready' | 'claimed' | 'reproducing' | 'building' | 'verifying' | 'evaluating' | 'awaiting_decision' | 'queued' | 'landed' | 'done' | 'blocked' | 'released';
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
    spendToday: number;
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
    errors: {
        at: string;
        where: string;
        message: string;
    }[];
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
    /** Changes waiting to land, oldest first, and recent landing batches. */
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
        issues: number[];
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
    trust: {
        stage: number | null;
        evaluations: {
            day: string;
            stage: number;
            healthy: boolean;
            why: string[];
        }[];
        changes: {
            from: number;
            to: number;
            by: string;
            reason: string;
            at: string;
        }[];
    };
    reports: {
        day: string;
        slot: string;
        issue: number | null;
        at: string;
    }[];
    lessonPrs: {
        day: string;
        count: number;
        url: string;
        at: string;
    }[];
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
export declare function summarize(e: StoredEvent): string;
export declare function project(events: StoredEvent[], today?: string): Projection;
/** What needs this person: their open decisions, their blocked tasks, and recent L2 landings to look over. */
export declare function inbox(p: Projection, user: string): {
    decisions: Decision[];
    blocked: Task[];
    notify: Task[];
};
