import { z } from 'zod';
export declare const EventSchemas: {
    readonly 'issue.seen': z.ZodObject<{
        issue: z.ZodNumber;
        title: z.ZodString;
        labels: z.ZodArray<z.ZodString>;
        author: z.ZodString;
        owner: z.ZodNullable<z.ZodString>;
        actionable: z.ZodBoolean;
        why: z.ZodString;
    }, z.core.$strict>;
    readonly 'contract.agreed': z.ZodObject<{
        issue: z.ZodNumber;
        done_when: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        by: z.ZodString;
    }, z.core.$strict>;
    readonly 'contract.missing': z.ZodObject<{
        issue: z.ZodNumber;
        why: z.ZodString;
    }, z.core.$strict>;
    readonly 'issue.claimed': z.ZodObject<{
        issue: z.ZodNumber;
        instance: z.ZodString;
        lease: z.ZodString;
        base: z.ZodString;
        owner: z.ZodString;
    }, z.core.$strict>;
    readonly 'issue.claim_lost': z.ZodObject<{
        issue: z.ZodNumber;
        instance: z.ZodString;
        holder: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    readonly 'issue.released': z.ZodObject<{
        issue: z.ZodNumber;
        instance: z.ZodString;
        why: z.ZodString;
    }, z.core.$strict>;
    readonly 'issue.blocked': z.ZodObject<{
        issue: z.ZodNumber;
        owner: z.ZodString;
        why: z.ZodString;
    }, z.core.$strict>;
    readonly 'run.started': z.ZodObject<{
        issue: z.ZodNumber;
        role: z.ZodString;
        model: z.ZodString;
        worktree: z.ZodString;
        pid: z.ZodNumber;
        pgid: z.ZodNullable<z.ZodNumber>;
        attempt: z.ZodNumber;
    }, z.core.$strict>;
    readonly 'run.heartbeat': z.ZodObject<{
        issue: z.ZodNumber;
        role: z.ZodString;
        note: z.ZodString;
    }, z.core.$strict>;
    readonly 'run.finished': z.ZodObject<{
        issue: z.ZodNumber;
        role: z.ZodString;
        reason: z.ZodEnum<{
            succeeded: "succeeded";
            failed: "failed";
            timed_out: "timed_out";
            stalled: "stalled";
            rate_limited: "rate_limited";
            canceled_by_reconciliation: "canceled_by_reconciliation";
            budget_exhausted: "budget_exhausted";
            auth_mismatch: "auth_mismatch";
        }>;
        detail: z.ZodString;
    }, z.core.$strict>;
    readonly 'run.cost': z.ZodObject<{
        issue: z.ZodNullable<z.ZodNumber>;
        role: z.ZodString;
        model: z.ZodString;
        usd: z.ZodNumber;
        turns: z.ZodNumber;
    }, z.core.$strict>;
    readonly 'repro.frozen': z.ZodObject<{
        issue: z.ZodNumber;
        path: z.ZodString;
        hash: z.ZodString;
        fails_on_base: z.ZodLiteral<true>;
    }, z.core.$strict>;
    readonly 'repro.unavailable': z.ZodObject<{
        issue: z.ZodNumber;
        why: z.ZodString;
    }, z.core.$strict>;
    readonly 'change.proposed': z.ZodObject<{
        issue: z.ZodNumber;
        branch: z.ZodString;
        base: z.ZodString;
        head: z.ZodString;
        files: z.ZodArray<z.ZodString>;
        lines: z.ZodNumber;
        patch_hash: z.ZodString;
    }, z.core.$strict>;
    readonly 'change.rejected': z.ZodObject<{
        issue: z.ZodNumber;
        why: z.ZodString;
    }, z.core.$strict>;
    readonly 'check.result': z.ZodObject<{
        issue: z.ZodNumber;
        head: z.ZodString;
        stage: z.ZodString;
        checks: z.ZodArray<z.ZodObject<{
            check: z.ZodString;
            status: z.ZodEnum<{
                pass: "pass";
                fail: "fail";
                unavailable: "unavailable";
            }>;
            exitCode: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    readonly 'eval.verdict': z.ZodObject<{
        issue: z.ZodNumber;
        head: z.ZodString;
        patch_hash: z.ZodString;
        patch_correct: z.ZodBoolean;
        test_correct: z.ZodBoolean;
        confidence: z.ZodEnum<{
            high: "high";
            medium: "medium";
            low: "low";
        }>;
        advice: z.ZodString;
    }, z.core.$strict>;
    readonly 'review.level_set': z.ZodObject<{
        issue: z.ZodNumber;
        head: z.ZodString;
        level: z.ZodEnum<{
            L0: "L0";
            L1: "L1";
            L2: "L2";
            L3: "L3";
        }>;
        reasons: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    readonly 'decision.asked': z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodEnum<{
            stage: "stage";
            land: "land";
            question: "question";
        }>;
        issue: z.ZodNullable<z.ZodNumber>;
        owner: z.ZodString;
        question: z.ZodString;
        options: z.ZodArray<z.ZodString>;
        recommendation: z.ZodString;
        receipts: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    readonly 'decision.answered': z.ZodObject<{
        id: z.ZodString;
        by: z.ZodString;
        answer: z.ZodString;
    }, z.core.$strict>;
    readonly 'land.queued': z.ZodObject<{
        issue: z.ZodNumber;
        head: z.ZodString;
        level: z.ZodEnum<{
            L0: "L0";
            L1: "L1";
            L2: "L2";
            L3: "L3";
        }>;
    }, z.core.$strict>;
    readonly 'land.result': z.ZodObject<{
        issue: z.ZodNumber;
        outcome: z.ZodEnum<{
            error: "error";
            landed: "landed";
            conflict: "conflict";
            red: "red";
            rejected: "rejected";
            deferred: "deferred";
        }>;
        landed: z.ZodNullable<z.ZodString>;
        detail: z.ZodString;
    }, z.core.$strict>;
    readonly 'land.batch': z.ZodObject<{
        id: z.ZodString;
        issues: z.ZodArray<z.ZodNumber>;
        tip: z.ZodString;
        outcome: z.ZodEnum<{
            landed: "landed";
            red: "red";
            deferred: "deferred";
            started: "started";
            split: "split";
        }>;
        detail: z.ZodString;
    }, z.core.$strict>;
    readonly 'deploy.requested': z.ZodObject<{
        env: z.ZodString;
        sha: z.ZodString;
    }, z.core.$strict>;
    readonly 'deploy.verified': z.ZodObject<{
        env: z.ZodString;
        sha: z.ZodString;
    }, z.core.$strict>;
    readonly 'deploy.failed': z.ZodObject<{
        env: z.ZodString;
        sha: z.ZodString;
        why: z.ZodString;
    }, z.core.$strict>;
    readonly 'baseline.recorded': z.ZodObject<{
        sha: z.ZodString;
        failing: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    readonly 'guardrail.decision': z.ZodObject<{
        decision: z.ZodEnum<{
            deny: "deny";
            ask: "ask";
        }>;
        rule: z.ZodString;
        agent: z.ZodBoolean;
    }, z.core.$strict>;
    readonly 'secret.detected': z.ZodObject<{
        source: z.ZodString;
        findings: z.ZodNumber;
    }, z.core.$strict>;
    readonly 'coordinator.started': z.ZodObject<{
        instance: z.ZodString;
        pid: z.ZodNumber;
        version: z.ZodString;
    }, z.core.$strict>;
    readonly 'coordinator.tick': z.ZodObject<{
        instance: z.ZodString;
        dispatched: z.ZodNumber;
        reconciled: z.ZodNumber;
        active: z.ZodOptional<z.ZodNumber>;
        ready: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
    readonly 'trust.evaluated': z.ZodObject<{
        day: z.ZodString;
        stage: z.ZodNumber;
        healthy: z.ZodBoolean;
        why: z.ZodArray<z.ZodString>;
        card: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodNumber, z.ZodString, z.ZodNull]>>;
    }, z.core.$strict>;
    readonly 'stage.changed': z.ZodObject<{
        from: z.ZodNumber;
        to: z.ZodNumber;
        by: z.ZodString;
        reason: z.ZodString;
    }, z.core.$strict>;
    readonly 'report.posted': z.ZodObject<{
        day: z.ZodString;
        slot: z.ZodString;
        issue: z.ZodNullable<z.ZodNumber>;
        card: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodNumber, z.ZodString, z.ZodNull]>>;
    }, z.core.$strict>;
    readonly 'lessons.pr': z.ZodObject<{
        day: z.ZodString;
        branch: z.ZodString;
        count: z.ZodNumber;
        url: z.ZodString;
    }, z.core.$strict>;
    /** An optional role ran on a trigger; key de-duplicates (one run per trigger). */
    readonly 'extra.run': z.ZodObject<{
        role: z.ZodString;
        key: z.ZodString;
        reason: z.ZodString;
        summary: z.ZodString;
        actions: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    readonly 'security.review': z.ZodObject<{
        issue: z.ZodNumber;
        head: z.ZodString;
        verdict: z.ZodEnum<{
            clear: "clear";
            concerns: "concerns";
            block: "block";
        }>;
        findings: z.ZodArray<z.ZodObject<{
            severity: z.ZodEnum<{
                high: "high";
                medium: "medium";
                low: "low";
                critical: "critical";
            }>;
            file: z.ZodString;
            issue: z.ZodString;
            evidence: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    readonly 'nightly.queued': z.ZodObject<{
        day: z.ZodString;
        jobs: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    readonly 'governor.hold': z.ZodObject<{
        reason: z.ZodString;
        load: z.ZodNullable<z.ZodNumber>;
        free_disk_pct: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strict>;
    readonly 'governor.release': z.ZodObject<{
        load: z.ZodNullable<z.ZodNumber>;
        free_disk_pct: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strict>;
    readonly 'coordinator.error': z.ZodObject<{
        instance: z.ZodString;
        where: z.ZodString;
        kind: z.ZodString;
        message: z.ZodString;
    }, z.core.$strict>;
    readonly 'lesson.proposed': z.ZodObject<{
        issue: z.ZodNumber;
        worked: z.ZodString;
        failed: z.ZodString;
        fix: z.ZodString;
    }, z.core.$strict>;
};
export type EventType = keyof typeof EventSchemas;
export type EventPayload<T extends EventType> = z.infer<(typeof EventSchemas)[T]>;
export interface StoredEvent<T extends EventType = EventType> {
    id: number;
    ts: string;
    type: T;
    actor: string;
    source: 'coordinator' | 'github' | 'agent' | 'human';
    payload: EventPayload<T>;
}
