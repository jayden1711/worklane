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
}
export declare function summarize(e: StoredEvent): string;
export declare function project(events: StoredEvent[], today?: string): Projection;
/** What needs this person: their open decisions, their blocked tasks, and recent L2 landings to look over. */
export declare function inbox(p: Projection, user: string): {
    decisions: Decision[];
    blocked: Task[];
    notify: Task[];
};
