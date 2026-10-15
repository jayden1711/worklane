import type { StoredEvent } from './events/types.js';
/** Event type -> the payload fields a viewer sees. Only the task's progress, its decisions, PRs and deploys. */
export declare const VIEWER_EVENTS: Readonly<Record<string, readonly string[]>>;
export declare const viewerMaySee: (type: string) => boolean;
/** An event as a viewer sees it: only allowlisted types, with only their allowlisted fields; null otherwise. */
export declare function forViewer(e: StoredEvent): StoredEvent | null;
export declare const forViewers: (events: StoredEvent[]) => StoredEvent[];
/** The Activity feed as a viewer sees it: the same shape as the projection's, built from the filtered events only. */
export declare function viewerActivity(events: StoredEvent[]): {
    id: number;
    ts: string;
    type: "delegation.observed" | "delegation.decided" | "merge.stopped" | "merge.main_result" | "issue.seen" | "delegation.suggested" | "network.domain_decided" | "run.started" | "contract.agreed" | "run.startup_failed" | "contract.missing" | "issue.claimed" | "issue.claim_lost" | "issue.released" | "issue.closed" | "issue.blocked" | "issue.retry" | "issue.no_change" | "run.heartbeat" | "attempt.failed" | "attempt.reflected" | "task.reassigned" | "task.budget" | "run.finished" | "run.lock_waited" | "run.transient_retry" | "run.stuck" | "dashboard.audit" | "settings.changed" | "settings.applied" | "config.applied" | "config.invalid" | "config.recovered" | "chat.turn" | "console.message_queued" | "console.message_delivered" | "console.message_dropped" | "research.searched" | "research.fetched" | "research.capped" | "research.requested" | "research.reported" | "intake.received" | "intake.dropped" | "intake.triaged" | "intake.filed" | "intake.awaiting" | "intake.asked" | "intake.decided" | "intake.commented" | "intake.grouped" | "intake.started" | "intake.reply_checked" | "intake.replying" | "intake.replied" | "discord.posting" | "discord.posted" | "discord.idea" | "discord.reply" | "setup_link.issued" | "setup_link.used" | "discord.confirm" | "discord.explained" | "discord.chat" | "console.run_stopped" | "console.request_refused" | "run.cost" | "provider.fallback" | "usage.limit_hit" | "usage.paused" | "usage.resumed" | "run.stage_labeled" | "repro.frozen" | "repro.unavailable" | "change.proposed" | "change.rejected" | "push.refused" | "push.blocked" | "check.result" | "browser.evidence" | "worker.claims" | "eval.verdict" | "review.level_set" | "decision.asked" | "network.domain_requested" | "plan.posted" | "plan.decided" | "plan.reviewed" | "plan.sent_back" | "plan.objected" | "correction.recorded" | "correction.proposed" | "correction.grouped" | "correction.no_fix" | "learning.noted" | "learning.promote_requested" | "learning.promoted" | "feedback_check.proposed" | "feedback_check.dropped" | "optimize.pass" | "optimize.result" | "gardener.finding" | "gardener.filed" | "gardener.run" | "superfan.pass" | "decision.answered" | "ask.created" | "ask.answered" | "ask.cancelled" | "machine.requested" | "machine.started" | "machine.finished" | "add_project.step" | "land.queued" | "land.result" | "pr.opened" | "pr.status" | "pr.stats" | "pr.ready" | "pr.unready" | "pr.closed" | "ci_fix.started" | "review_fix.declined" | "ci_fix.finished" | "instructions.eval" | "merge.decided" | "merge.approved" | "merge.done" | "merge.failed" | "merge.deferred" | "wait.capped" | "merge.resumed" | "main_watch.mode" | "main_watch.checked" | "main_watch.accepted" | "main_watch.unaccounted" | "main_watch.direct_push" | "main_watch.direct_push_alert" | "light_check.started" | "light_check.finished" | "conflict_fix.detected" | "conflict_fix.started" | "conflict_fix.finished" | "ci_fix.gave_up" | "pr_hygiene.merged_in" | "pr_hygiene.closed" | "pr_hygiene.pass" | "land.batch" | "pr_batch.queued" | "pr_batch.step" | "deploy.requested" | "deploy.verified" | "deploy.failed" | "baseline.recorded" | "guardrail.decision" | "secret.detected" | "coordinator.started" | "worktree.pooled" | "worktree.pool_refilled" | "state.tidied" | "coordinator.stopping" | "coordinator.stopped" | "coordinator.tick" | "report.posted" | "digest.posted" | "emergency.stop" | "emergency.resume" | "nightly.queued" | "governor.hold" | "governor.release" | "hotspot.held" | "hotspot.released" | "dependency.held" | "dependency.unblocked" | "dependency.cycle" | "ownership.deadlock" | "ownership.stale" | "goal.split" | "coordinator.error" | "testrun.queued" | "testrun.started" | "testrun.tier" | "testrun.finished" | "testrun.durations" | "testrun.wipe_failed" | "testrun.checks_posted" | "testrun.checks_failed" | "testrun.checks_permission" | "testrun.sandbox" | "testrun.measure" | "deploy_gate.verdict" | "deploy_gate.moved" | "deploy_gate.held" | "deploy_gate.refused" | "deploy_gate.override" | "deploy_gate.post_deploy" | "preview.created" | "preview.ready" | "preview.failed" | "preview.removed" | "preview.waiting" | "preview.error" | "testrun.helper" | "ci.pr_timing" | "ci.test_durations" | "flaky.rerun_requested" | "flaky.rerun_result" | "flaky.quarantined" | "flaky.sighted" | "flaky.observed" | "flaky.released" | "fix_forward.started" | "fix_forward.tested" | "fix_forward.culprit" | "fix_forward.attempt" | "fix_forward.attempt_failed" | "fix_forward.finished" | "fix_forward.green" | "backup.offsite" | "harness_eval.task" | "harness_eval.run" | "harness_eval.commented";
    actor: string;
    issue: number | null;
    summary: string;
}[];
/**
 * The dashboard state as a viewer sees it: an allowlist of its keys, and of each task's fields. Costs and spend
 * (tasks' costUsd, spendToday, spendByRole), the budget and agent runs are the owners' and writers' (like
 * /api/runs and /api/throughput), so they are not on it; a key or task field added later stays hidden until allowed.
 */
export declare const VIEWER_STATE_KEYS: readonly string[];
export declare const VIEWER_TASK_FIELDS: readonly string[];
/** A decision's fields a viewer sees: the question and its answer, never its receipts (run and agent detail). */
export declare const VIEWER_DECISION_FIELDS: readonly string[];
/** A batch as a viewer sees it: its status and what is in it, never its detail (test output, culprits' tiers) or commit. */
export declare const VIEWER_BATCH_FIELDS: readonly string[];
/** The default branch's protection as a viewer sees it: GitHub enforced, the main watch, or off. */
export declare const VIEWER_PROTECTION_FIELDS: readonly string[];
/** The machine's slots as a viewer sees them: how many are in use and how many there are, not which agents hold them. */
export declare const VIEWER_SLOT_FIELDS: readonly string[];
/**
 * A watchdog incident as a viewer sees it (GET /api/health/incidents): that something broke, its fixed title, where
 * and since when; never its detail, its key, what was tried or the fix (paths, units, commits, errors).
 */
export declare const VIEWER_INCIDENT_FIELDS: readonly string[];
/** Incidents with only the fields a viewer may see. */
export declare const incidentsForViewer: (xs: unknown) => {
    [k: string]: unknown;
}[];
/**
 * A state as a viewer may have it: only the allowlisted keys; tasks and decisions (also the inbox's) with only
 * their allowlisted fields; the slots as counts; the coordinator's errors as a count, never their text.
 */
export declare function stateForViewer(state: Record<string, unknown>): Record<string, unknown>;
