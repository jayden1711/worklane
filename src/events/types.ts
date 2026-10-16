// Every action is a typed event. Projections (task state, dashboard,
// reports) are folds over these; nothing keeps private state.
import { z } from 'zod';
import { STAGES } from '../stage-label.js';
import { HOLD_KINDS } from '../governor-holds.js';

const issue = z.number().int().positive();
const sha = z.string().regex(/^[0-9a-f]{7,40}$/);

const CheckRunSchema = z.strictObject({
  check: z.string(),
  /** skipped: not run, because an earlier check already failed. */
  status: z.enum(['pass', 'fail', 'unavailable', 'skipped']),
  exitCode: z.number().nullable(),
  /** The end of a failing check's output: why it failed. */
  tail: z.string().max(2000).optional(),
  /** How long the check ran (absent for one that didn't run, and in older events). */
  duration_ms: z.number().int().nonnegative().optional(),
  /** A browser check (src/browser/check.ts), not a command: what backs a claim about the browser. */
  kind: z.literal('browser').optional(),
});

/**
 * What a decision rests on, recorded where it is asked so the dashboard's detail view (src/decision-detail.ts) shows
 * it whole: the change (its commits, files, review level and why, the review categories it falls in), the
 * evaluator's verdict and the checks at the head asked about, and an investigation's or a worker's own findings
 * and summary. Every field is optional: a kind records what it has, an older event has none, and the view says
 * plainly what was not recorded. Never sent to a viewer (src/viewer-events.ts lists the fields a viewer gets).
 */
export const DecisionContextSchema = z.strictObject({
  base: sha.optional(),
  head: sha.optional(),
  files: z.array(z.strictObject({ path: z.string().max(500), added: z.number().int().nonnegative(), removed: z.number().int().nonnegative() })).max(300).optional(),
  /** More files changed than `files` lists. */
  files_more: z.number().int().positive().optional(),
  level: z.enum(['L0', 'L1', 'L2', 'L3']).optional(),
  level_reasons: z.array(z.string().max(1000)).max(50).optional(),
  /** The review categories the change falls in (src/review.ts computeLevel): money-path, auth, secrets and the like, each with its files. */
  categories: z.record(z.string().max(100), z.array(z.string().max(500)).max(50)).optional(),
  verdict: z
    .strictObject({
      patch_correct: z.boolean(),
      test_correct: z.boolean(),
      confidence: z.enum(['high', 'medium', 'low']),
      advice: z.string().max(4000),
      /** Why the evaluator gave that confidence, when its verdict says (absent: it gave none). */
      confidence_reason: z.string().max(2000).optional(),
      unread: z.array(z.string().max(500)).max(100).optional(),
      unverified_claims: z.array(z.string().max(1000)).max(50).optional(),
      design_change: z.boolean().optional(),
      design_reason: z.string().max(2000).optional(),
    })
    .optional(),
  checks: z.array(z.strictObject({ check: z.string().max(300), status: z.enum(['pass', 'fail', 'unavailable', 'skipped']), duration_ms: z.number().int().nonnegative().optional(), tail: z.string().max(2000).optional() })).max(100).optional(),
  /** The tamper guard's flags on the change. */
  tampered: z.array(z.string().max(1000)).max(50).optional(),
  /** The asking agent's own summary (an investigation's answer, a worker's summary), whole. */
  summary: z.string().max(8000).optional(),
  /** Each finding as the agent gave it, with the file and line its evidence names (read from the evidence, when it names one). */
  findings: z
    .array(
      z.strictObject({
        claim: z.string().max(4000),
        evidence: z.string().max(4000),
        file: z.string().max(500).optional(),
        line: z.number().int().positive().optional(),
        severity: z.string().max(40).optional(),
        confidence: z.enum(['high', 'medium', 'low']).optional(),
      }),
    )
    .max(100)
    .optional(),
  /** The agent's overall confidence in its findings. */
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  /** What the agent could not confirm. */
  unverified: z.array(z.string().max(1000)).max(50).optional(),
});

export const EventSchemas = {
  // backlog and ownership
  'issue.seen': z.strictObject({ issue, title: z.string(), labels: z.array(z.string()), author: z.string(), owner: z.string().nullable(), actionable: z.boolean(), why: z.string() }),
  'contract.agreed': z.strictObject({ issue, done_when: z.array(z.record(z.string(), z.unknown())), by: z.string() }),
  /** A worker run that failed before doing any work: blocked at once with claude's own report. */
  'run.startup_failed': z.strictObject({ issue, role: z.string(), attempt: z.number().int(), seconds: z.number().int(), turns: z.number().int(), detail: z.string() }),
  /** block_hash: the done_when block judged (contractKey), so an edit to it is checked again. Older events have none. */
  'contract.missing': z.strictObject({ issue, why: z.string(), block_hash: z.string().optional() }),
  'issue.claimed': z.strictObject({ issue, instance: z.string(), lease: sha, base: sha, owner: z.string() }),
  'issue.claim_lost': z.strictObject({ issue, instance: z.string(), holder: z.string().nullable() }),
  'issue.released': z.strictObject({ issue, instance: z.string(), why: z.string() }),
  /** The issue was closed on GitHub by someone, outside the loop (seen by reconcile): nothing it held waits on anyone now. */
  'issue.closed': z.strictObject({ issue }),
  /** `retry_after`: a rate-limit or budget block retries on its own after then (up to a cap); absent: it waits for a relabel. */
  'issue.blocked': z.strictObject({ issue, owner: z.string(), why: z.string(), retry_after: z.string().optional(), retry_kind: z.enum(['rate_limit', 'budget']).optional() }),
  /** A held block retried on its own (relabelled ready), or, at the cap, left blocked (`gave_up`). */
  'issue.retry': z.strictObject({ issue, attempt: z.number().int().positive(), kind: z.enum(['rate_limit', 'budget']), gave_up: z.boolean() }),
  /** The worker found nothing to change, and the coordinator's own checks pass on the unchanged base. */
  'issue.no_change': z.strictObject({ issue, owner: z.string(), base: sha, why: z.string(), checks: z.array(CheckRunSchema) }),
  // runs
  /** `resumed`: the run continues the same attempt after research it asked for (it doesn't count as an attempt). */
  'run.started': z.strictObject({ issue, role: z.string(), model: z.string(), worktree: z.string(), pid: z.number().int(), pgid: z.number().int().nullable(), attempt: z.number().int(), resumed: z.literal('research').optional() }),
  'run.heartbeat': z.strictObject({ issue, role: z.string(), note: z.string() }),
  // loop control (src/coordinator/loop-control.ts)
  /** A worker attempt failed: how (`kind`), and its failure reduced to a fingerprint (failure-modes normalizeCause) that reads the same each time it recurs. */
  'attempt.failed': z.strictObject({ issue, attempt: z.number().int().positive(), kind: z.enum(['stuck', 'rejected', 'checks', 'evaluator']), fingerprint: z.string().max(200) }),
  /** The read-only reflection run before attempt `attempt`: `ok` when its what-failed / what-to-change reached that attempt's brief; else `why` not. */
  'attempt.reflected': z.strictObject({ issue, attempt: z.number().int().positive(), model: z.string(), ok: z.boolean(), why: z.string().max(500).optional() }),
  /** The same failure `repeats` times in a row: the attempts start again in a fresh worktree, on the escalated model. */
  'task.reassigned': z.strictObject({ issue, attempt: z.number().int().positive(), fingerprint: z.string().max(200), repeats: z.number().int().positive(), model: z.string() }),
  /** The issue's runs reached `share` of its agents.yaml budget: `warn` at 85% (an incident), `over` at 100% (the task is stopped). */
  'task.budget': z.strictObject({ issue, level: z.enum(['warn', 'over']), share: z.number().nonnegative(), tokens: z.number().int().nonnegative(), minutes: z.number().nonnegative(), detail: z.string().max(500) }),
  'run.finished': z.strictObject({
    issue,
    role: z.string(),
    reason: z.enum(['succeeded', 'failed', 'timed_out', 'stalled', 'rate_limited', 'canceled_by_reconciliation', 'budget_exhausted', 'auth_mismatch', 'auth_failed', 'stopped', 'stuck']),
    /** Why it ended: Claude's error text or its stderr's tail for a failure (redacted on write, like every payload). */
    detail: z.string(),
    /** The claude session the run was: a fix run on the issue's PR resumes the latest one (src/coordinator/fix-runs.ts). */
    session: z.string().max(200).optional(),
    /**
     * A fix run's session: `resumed` the session that wrote the change (`session`), or `fresh` (a new session; `why`:
     * none was stored, or resuming `session` failed, e.g. it is gone).
     */
    resume: z.strictObject({ outcome: z.enum(['resumed', 'fresh']), session: z.string().max(200).nullable(), why: z.string() }).optional(),
  }),
  /** A run waited at least a second for its Claude login (one claude per login at a time). `issue` null: not an issue's run. */
  'run.lock_waited': z.strictObject({ issue: issue.nullable(), role: z.string(), model: z.string(), wait_ms: z.number().int().nonnegative() }),
  /** A run's try failed on a transient error and is retried after `wait_ms`; `cause` is the classified kind. */
  'run.transient_retry': z.strictObject({
    issue: issue.nullable(),
    role: z.string(),
    model: z.string(),
    attempt: z.number().int().positive(),
    cause: z.enum(['token_refresh', 'rate_limit', 'overloaded', 'server_error', 'network', 'other']),
    wait_ms: z.number().int().nonnegative(),
    detail: z.string(),
  }),
  /**
   * The stuck-run guard's verdict on a run: `flag` at 5 identical calls (or failures) in a row, `stop` at 8 identical
   * failures. `action` is what was done: `log` only (dry-run, or a flag), or `stop` (mode on). `run` is the run record's id.
   */
  'run.stuck': z.strictObject({
    issue: issue.nullable(),
    role: z.string(),
    run: z.string().nullable(),
    kind: z.enum(['flag', 'stop']),
    mode: z.enum(['dry-run', 'on']),
    action: z.enum(['log', 'stop']),
    tool: z.string(),
    input: z.string(),
    repeats: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
  }),
  /**
   * A write made on the dashboard: who (their GitHub login, and the role the instance read from its repo, or the
   * owner's break-glass), on which instance, and what was done.
   */
  'dashboard.audit': z.strictObject({ login: z.string(), role: z.enum(['owner', 'writer', 'viewer']), via: z.enum(['session', 'break-glass', 'discord', 'siri']), instance: z.string().nullable(), action: z.string(), detail: z.record(z.string(), z.unknown()) }),
  /** The owner changed an instance setting (policy.yaml) from the dashboard. */
  'settings.changed': z.strictObject({ key: z.string(), from: z.unknown(), to: z.unknown(), by: z.string(), at: z.string() }),
  /** The coordinator picked up the instance's settings (policy.yaml changed); `error`: they were refused and the repo's values apply. */
  'settings.applied': z.strictObject({ settings: z.record(z.string(), z.unknown()), error: z.string().nullable() }),
  /**
   * The default branch's config (read from git at `sha`, src/config/live.ts) replaced the running one; `changed`: the
   * sections that differ. `restart_needed`: settings read only at start, kept at their running value until a restart.
   */
  'config.applied': z.strictObject({ sha: z.string(), changed: z.array(z.string()), restart_needed: z.array(z.strictObject({ path: z.string(), running: z.unknown(), wanted: z.unknown() })) }),
  /** The default branch's config at `sha` failed validation: never applied, the last good one stays; `errors`: why. */
  'config.invalid': z.strictObject({ sha: z.string(), errors: z.array(z.string()) }),
  /** The default branch's config is valid again (fixed, or reverted to the running one) after an invalid one. */
  'config.recovered': z.strictObject({ sha: z.string().nullable() }),
  /** A dashboard chat turn: who asked, whether they got a read-only answer, what it carried, what it cost; or why it was refused. */
  'chat.turn': z.strictObject({
    id: z.string(),
    by: z.string(),
    read_only: z.boolean(),
    citations: z.number().int().nonnegative(),
    draft: z.enum(['none', 'valid', 'refused']),
    actions: z.number().int().nonnegative(),
    cost_usd: z.number().nonnegative(),
    refused: z.string().nullable(),
  }),
  /** The console: the owner messaged a live run (held until its current turn ends). */
  'console.message_queued': z.strictObject({ run: z.string(), issue: issue.nullable(), role: z.string(), id: z.string(), by: z.string(), text: z.string() }),
  'console.message_delivered': z.strictObject({ run: z.string(), issue: issue.nullable(), role: z.string(), id: z.string() }),
  /** The run ended before the message's turn came. */
  'console.message_dropped': z.strictObject({ run: z.string(), issue: issue.nullable(), role: z.string(), id: z.string() }),
  /** A research run searched the web (WebSearch), from its stream. `run`: its run record and live feed. */
  'research.searched': z.strictObject({ issue: issue.nullable(), run: z.string().nullable(), query: z.string() }),
  /** A research run fetched a page (WebFetch), or was refused it (`refused`: why). */
  'research.fetched': z.strictObject({ issue: issue.nullable(), run: z.string().nullable(), url: z.string(), host: z.string(), refused: z.string().nullable() }),
  /** A research run was held or stopped by a daily cap (searches, fetches or spend). */
  'research.capped': z.strictObject({ issue: issue.nullable(), run: z.string().nullable(), why: z.string() }),
  /** A worker or evaluator asked for research instead of guessing; `held`: why it wasn't answered (a cap, the per-task limit, a refused request). */
  'research.requested': z.strictObject({ issue, role: z.enum(['worker', 'evaluator']), question: z.string(), why: z.string(), held: z.string().nullable() }),
  /** A research report was accepted and posted: its sources, the fields it returned that were dropped, and the report. */
  'research.reported': z.strictObject({ issue, run: z.string().nullable(), sources: z.number().int(), ignored: z.array(z.string()), report: z.string() }),
  // work intake (docs/intake.md): ids are report ids; senders only as a short hash; text only redacted
  /** A new report from a source: `sender` is a hash of the source's sender id, `excerpt` the redacted text's start. */
  'intake.received': z.strictObject({ id: z.string(), source: z.string(), sender: z.string(), excerpt: z.string() }),
  /** A report taken no further: a cap (sender_cap, flood, drafts_cap, spend_cap, budget), a failed run or a refused draft. */
  'intake.dropped': z.strictObject({ id: z.string(), reason: z.string() }),
  /** The intake agent's triage as accepted: `ignored`, fields it returned that were dropped; `draft_refused`, why its draft failed (then the kind is needs_info). */
  'intake.triaged': z.strictObject({ id: z.string(), kind: z.string(), reproduction: z.string().nullable(), ignored: z.array(z.string()), draft_refused: z.string().optional() }),
  'intake.filed': z.strictObject({ id: z.string(), issue, ready: z.boolean() }),
  /** An untrusted sender's draft, waiting on the owner's decision. */
  'intake.awaiting': z.strictObject({ id: z.string(), decision: z.string() }),
  /** A question passed to the owner. */
  'intake.asked': z.strictObject({ id: z.string(), decision: z.string() }),
  /** The owner's answer on an intake decision; `issue`: what approve or edit filed. */
  'intake.decided': z.strictObject({ id: z.string(), decision: z.string(), answer: z.string(), by: z.string(), issue: issue.nullable() }),
  /** Same as an open issue: a comment there. */
  'intake.commented': z.strictObject({ id: z.string(), issue }),
  /** Same as a recent report with no issue yet. */
  'intake.grouped': z.strictObject({ id: z.string(), with: z.string() }),
  /** The triage run for a report is about to start: until its outcome, a restart ends it as interrupted. */
  'intake.started': z.strictObject({ id: z.string() }),
  /**
   * Which text a reply used: the casual replier's (`casual`, it passed the checks) or the engine's fixed one, with
   * `why` (the check it failed, the cap, or the run's end). Only when casual replies are on.
   */
  'intake.reply_checked': z.strictObject({ id: z.string(), stage: z.string(), used: z.enum(['casual', 'fixed']), why: z.string().nullable() }),
  /** A reply is about to be sent (recorded first, so a crash can't send it twice). */
  'intake.replying': z.strictObject({ id: z.string(), stage: z.string() }),
  /**
   * A reply to the reporter at a stage (filed, info, question, merged, deployed, interrupted), once each; `ok`: the
   * source took it; `unknown`: a restart cut it off mid-send, so whether it went out is unknown (it isn't resent).
   */
  'intake.replied': z.strictObject({ id: z.string(), stage: z.string(), ok: z.boolean(), unknown: z.boolean().optional() }),
  /** A chat post is about to be sent (recorded first, so a crash can't send it twice). `key`: what it is for. */
  'discord.posting': z.strictObject({ key: z.string() }),
  /**
   * A chat post, once per key: a decision's or ask's thread (`thread`: its id), a notice (no thread), or a reply in a
   * thread. `unknown`: a restart cut it off mid-send, so whether it went out is unknown (it isn't resent).
   */
  'discord.posted': z.strictObject({ key: z.string(), thread: z.string().nullable(), ok: z.boolean(), unknown: z.boolean().optional() }),
  /**
   * A reply in one of the bot's threads, from a mapped person: what it did to its target (a decision or ask).
   * answered; comment (they may not answer it: kept, redacted, as a comment); ambiguous (no single option: asked
   * back); already (decided before: refused, naming who); refused (never answered from chat); question (a question
   * about it, answered from the record: never an answer); confirm (a plain-language pick, asked back to confirm).
   */
  /**
   * An idea's conversation (src/coordinator/conversation.ts), by its opening message's report id: opened (its
   * thread), said (a person's message, `msg`: its report id; the text stays in the raw store), asked (the bot's
   * questions, redacted, in `detail`), drafted (the draft waits in the private store; its title in `detail`),
   * filed (`issue`, `by`), dropped, failed (a run that ended without a usable result, why in `detail`).
   */
  'discord.idea': z.strictObject({ id: z.string(), stage: z.enum(['opened', 'said', 'asked', 'drafted', 'filed', 'dropped', 'failed']), by: z.string().nullable(), msg: z.string().nullable(), issue: issue.nullable(), detail: z.string().nullable() }),
  'discord.reply': z.strictObject({ id: z.string(), thread: z.string(), target: z.string(), by: z.string(), outcome: z.enum(['answered', 'comment', 'ambiguous', 'already', 'refused', 'question', 'confirm', 'link']), answer: z.string().nullable(), excerpt: z.string().nullable() }),
  /**
   * A plain-language pick in a thread (src/intake/explain.ts): asked (the bot asked `by` to confirm `option`),
   * confirmed (their next message was yes: the answer is recorded through the decide path), dropped (their next
   * message was something else). Only the same person's yes confirms.
   */
  /**
   * A setup step's one-time dashboard link (src/console/links.ts), sent by DM to an owner who asked for it in the
   * step's thread: for that ask and that GitHub login only, until `expires_at`, once. Only the token's hash is kept.
   */
  'setup_link.issued': z.strictObject({ ask: z.string(), login: z.string(), hash: z.string().regex(/^[0-9a-f]{64}$/), expires_at: z.string() }),
  /** A one-time link was presented on the dashboard: opened (it pointed the owner to its ask), or refused and burnt. */
  'setup_link.used': z.strictObject({ hash: z.string().regex(/^[0-9a-f]{64}$/), by: z.string(), outcome: z.enum(['opened', 'expired', 'wrong_login', 'not_owner', 'closed']) }),
  'discord.confirm': z.strictObject({ thread: z.string(), target: z.string(), by: z.string(), option: z.string(), stage: z.enum(['asked', 'confirmed', 'dropped']), msg: z.string() }),
  /**
   * A thread's plain-language summary, once per thread: `summary` (it passed the facts check) or `template` (the
   * fixed template and the dashboard link, `why`: the check it failed, the cap or the run's end).
   */
  'discord.explained': z.strictObject({ target: z.string(), thread: z.string(), used: z.enum(['summary', 'template']), why: z.string().nullable() }),
  /**
   * A message in a chat channel (src/coordinator/channel-chat.ts), by its report id, from a mapped admin or writer:
   * answered (posted in `messages` parts), refused (the reply failed a code check, `why`; a fixed line was posted),
   * failed (the run ended without a reply), capped (over discord.chat_max_usd_per_day or the daily budget). The text
   * stays in the coordinator's private store, never here.
   */
  'discord.chat': z.strictObject({ id: z.string(), channel: z.string(), by: z.string(), outcome: z.enum(['answered', 'refused', 'failed', 'capped']), messages: z.number().int().nonnegative(), why: z.string().nullable() }),
  'console.run_stopped': z.strictObject({ run: z.string(), issue: issue.nullable(), role: z.string(), by: z.string() }),
  'console.request_refused': z.strictObject({ request: z.string(), kind: z.string(), run: z.string(), by: z.string(), why: z.string() }),
  /** `provider`: the open-model provider it ran on (local runs cost 0); tokens and seconds, when claude reported them. */
  'run.cost': z.strictObject({ issue: issue.nullable(), role: z.string(), model: z.string(), usd: z.number().nonnegative(), turns: z.number().int().nonnegative(), provider: z.string().optional(), tokens_in: z.number().int().nonnegative().optional(), tokens_out: z.number().int().nonnegative().optional(), secs: z.number().nonnegative().optional(), conversation: z.string().max(64).optional(), by: z.string().max(100).optional() }),
  /** A run meant for an open-model provider ran on its normal model instead, and why (not opted in, no passing eval, down, slow, the GPU lock held, refused for the work). */
  'provider.fallback': z.strictObject({ issue: issue.nullable(), role: z.string(), provider: z.string(), reason: z.string(), model: z.string() }),
  /**
   * A run hit a usage or rate limit (src/usage-limit.ts): on Anthropic (`provider` null), the instance pauses until
   * `reset_at`; on an open-model provider, that provider is skipped until then and the run is redone on its fallback.
   * `source`: claude: the reset time came from claude's message; default: it gave none.
   */
  'usage.limit_hit': z.strictObject({ issue: issue.nullable(), role: z.string(), model: z.string(), provider: z.string().nullable(), reset_at: z.string(), source: z.enum(['claude', 'default']), kind: z.string().nullable(), detail: z.string() }),
  /** The instance paused on the Claude usage limit: no run starts until `reset_at`; the run's task (if any) was requeued. */
  'usage.paused': z.strictObject({ reset_at: z.string(), source: z.enum(['claude', 'default']), kind: z.string().nullable(), issue: issue.nullable(), role: z.string(), detail: z.string() }),
  /** The pause ended: its reset time passed. */
  'usage.resumed': z.strictObject({ reset_at: z.string(), paused_ms: z.number().int().nonnegative(), reason: z.enum(['reset', 'account switched']).optional() }),
  /**
   * A run's Claude login was refused by the API (401/403, an invalid or expired key or token; src/claude-auth-failure.ts):
   * no new Claude run starts on the login (`key`, its config dir) until a call on it succeeds. `login` is the account as
   * claude auth status names it, never a token; `detail` is Claude's message, redacted.
   */
  'claude_auth.failed': z.strictObject({ key: z.string().max(500), login: z.string().max(300), lane: z.string().max(100), issue: issue.nullable(), role: z.string(), detail: z.string().max(1000) }),
  /** A minimal real call on a held login: `by` the periodic check, the owner's re-check, or an account switch. */
  'claude_auth.checked': z.strictObject({ key: z.string().max(500), login: z.string().max(300), ok: z.boolean(), by: z.enum(['timer', 'owner', 'account_switch']), detail: z.string().max(1000), cost_usd: z.number().nonnegative() }),
  /**
   * An instance's Claude account profile switch, as the root script recorded it (src/claude-profiles.ts, issue #464):
   * `op` its id, `to` the profile asked for, `from` each instance's profile before, `by` who asked (a GitHub login, or
   * `terminal`), `ok` whether every agent user's real call on it was answered (if not, nothing changed). Never a token.
   */
  'account.switched': z.strictObject({ op: z.string().max(80), to: z.string().max(40), from: z.record(z.string().max(40), z.string().max(40)), instances: z.array(z.string().max(40)).max(200), by: z.string().max(100), ok: z.boolean(), detail: z.string().max(1000) }),
  /**
   * A Claude account profile request the dashboard refused before it knew who asked (no session, or no role here):
   * the path, the login the hub named if any, and why. Nothing was read from the body or started.
   */
  'claude_account.refused': z.strictObject({ path: z.string().max(100), login: z.string().max(100).nullable(), status: z.number().int(), why: z.string().max(300) }),
  /**
   * Auto-failover between account profiles on a usage limit (src/claude-failover.ts): asked (a move, proven by a
   * real call before it happens), switched, refused, none (no free account in the order), and the move back after
   * the reset (back-asked, back, back-refused). Never on an auth failure. Never a token.
   */
  'account.failover': z.strictObject({ stage: z.enum(['asked', 'switched', 'refused', 'none', 'back-asked', 'back', 'back-refused']), from: z.string().max(40), to: z.string().max(40), reset_at: z.string().max(40).nullable(), detail: z.string().max(1000) }),
  /** A call on a held login succeeded (`via` a run or a check): the hold ends and runs start again. */
  'claude_auth.recovered': z.strictObject({ key: z.string().max(500), login: z.string().max(300), via: z.enum(['run', 'check']), role: z.string(), held_ms: z.number().int().nonnegative(), hold_id: z.number().int().nonnegative() }),
  /**
   * A failed worker run's earliest failed stage (stage-label.ts), for the weekly report. `by` code: set from the
   * run's events and record, no model asked; judge: one capped judge call. A label changes nothing by itself.
   */
  'run.stage_labeled': z.strictObject({
    run: z.string(),
    issue: issue.nullable(),
    role: z.string(),
    instance: z.string(),
    /** plan and review: set by code from the run's trace (src/stage-label.ts traceStage); absent from older events, which still read. */
    stage: z.enum(STAGES),
    reason: z.string(),
    by: z.enum(['code', 'judge']),
  }),
  // verification
  'repro.frozen': z.strictObject({ issue, path: z.string(), hash: z.string().describe('git blob id of the committed test'), fails_on_base: z.literal(true) }),
  'repro.unavailable': z.strictObject({ issue, why: z.string() }),
  /** `added`/`removed`: the lines added and removed (the board's diff +/−); absent in older events, which have only `lines`. */
  'change.proposed': z.strictObject({ issue, branch: z.string(), base: sha, head: sha, files: z.array(z.string()), lines: z.number().int().nonnegative(), added: z.number().int().nonnegative().optional(), removed: z.number().int().nonnegative().optional(), patch_hash: z.string() }),
  'change.rejected': z.strictObject({ issue, why: z.string() }),
  /** A change hit the push limits: at stage 'change' (before verifying; the worker is told) or 'push' (refused at the push). */
  'push.refused': z.strictObject({ issue, head: sha, stage: z.enum(['change', 'push']), reasons: z.array(z.string()) }),
  /**
   * A push to the default branch, refused (push-guard.ts): by the coordinator's push code, or by the pre-push hook
   * (`via` hook: whoever pushed from the checkout, or the coordinator's git). `head`: what it would have pushed.
   */
  'push.blocked': z.strictObject({ ref: z.string(), head: z.string().nullable(), via: z.enum(['coordinator', 'hook']) }),
  'check.result': z.strictObject({ issue, head: sha, stage: z.string(), checks: z.array(CheckRunSchema) }),
  /** The browser checks a verify ran (src/coordinator/browser.ts): the PR description's BROWSER CHECKS section. */
  'browser.evidence': z.strictObject({ issue, head: sha, lines: z.array(z.string().max(1000)).max(300) }),
  /**
   * The sentences of a worker's summary that claim verification (src/receipts.ts), for the PR's receipts; and the
   * worker's intent paragraph and risk class for the top of the PR body (src/pr-rules.ts; the class can only raise
   * the one computed from the paths). Both absent in older events.
   */
  'worker.claims': z.strictObject({
    issue,
    claims: z.array(z.string()),
    intent: z.string().max(4000).optional(),
    risk_class: z.enum(['docs-only', 'logic', 'protected']).optional(),
    /** The worker's claims as it labeled them (src/claim-labels.ts), and what was wrong with its labels. */
    labeled: z.array(z.strictObject({ claim: z.string().max(500), label: z.enum(['measured', 'inferred', 'guess']), basis: z.string().max(500) })).max(50).optional(),
    label_problems: z.array(z.string().max(600)).max(10).optional(),
    /** Sentences that hand the reader a check the worker could run itself: each a doubt on the change. */
    handoffs: z.array(z.string().max(300)).max(5).optional(),
  }),
  'eval.verdict': z.strictObject({
    issue,
    head: sha,
    patch_hash: z.string(),
    patch_correct: z.boolean(),
    test_correct: z.boolean(),
    confidence: z.enum(['high', 'medium', 'low']),
    /** Why the confidence isn't high (src/verdict-confidence.ts): always set when it isn't; absent on high and on older verdicts. */
    confidence_reason: z.string().max(2000).optional(),
    advice: z.string(),
    /** The worker's claims no recorded command or check backs: never evidence; `confidence` was lowered for them. */
    unverified_claims: z.array(z.string()).optional(),
    /** Changed files the evaluator didn't read; any means the change goes to a human. */
    unread: z.array(z.string()).optional(),
    /** The evaluator's binding design-level flag; absent (an older or failed verdict) counts as doubt. */
    design_change: z.boolean().optional(),
    design_reason: z.string().optional(),
    /** The model whose verdict this is (tiered evaluation), and the cheap model it was escalated from, if it was. */
    model: z.string().optional(),
    escalated_from: z.string().optional(),
    /** The claims the verdict rests on, as the evaluator labeled them (src/claim-labels.ts). */
    claims: z.array(z.strictObject({ claim: z.string().max(500), label: z.enum(['measured', 'inferred', 'guess']), basis: z.string().max(500) })).max(50).optional(),
  }),
  'review.level_set': z.strictObject({ issue, head: sha, level: z.enum(['L0', 'L1', 'L2', 'L3']), reasons: z.array(z.string()) }),
  // decisions
  'decision.asked': z.strictObject({ id: z.string(), kind: z.enum(['land', 'question', 'domain', 'plan', 'intake', 'delegation']), issue: issue.nullable(), owner: z.string(), question: z.string(), options: z.array(z.string()), recommendation: z.string(), receipts: z.array(z.string()), context: DecisionContextSchema.optional() }),
  /** An agent's request to a host outside its allowlist was refused: once per issue and host, with the decision it raised. */
  'network.domain_requested': z.strictObject({ issue, host: z.string(), role: z.string(), run: z.string().nullable(), tool: z.string(), what: z.string(), decision: z.string() }),
  /** The owner's answer on a refused host: allow-repo (pr: the config change proposed), allow-once (the task's next run), or deny. */
  'network.domain_decided': z.strictObject({ issue, host: z.string(), decision: z.string(), answer: z.enum(['allow-repo', 'allow-once', 'deny']), by: z.string(), pr: z.string().nullable(), detail: z.string() }),
  /** A size:M/L task's plan, posted on the issue: held for the owner's approval (decision) or built at once. */
  'plan.posted': z.strictObject({ issue, plan: z.record(z.string(), z.unknown()), held: z.boolean(), reasons: z.array(z.string()), comments_at: z.number().int().nonnegative(), decision: z.string().nullable() }),
  /** The owner's answer on a held plan: approve builds it, revise plans again with the note, reject stops the task. */
  'plan.decided': z.strictObject({ issue, decision: z.string(), answer: z.enum(['approve', 'revise', 'reject']), by: z.string(), note: z.string() }),
  /** Plan review: the recorded decisions the plan contradicts without arguing against them (empty: it passed). */
  'plan.reviewed': z.strictObject({ issue, contradictions: z.array(z.strictObject({ ref: z.string(), why: z.string() })) }),
  /** A plan sent back to the planner: refused by the plan contract check, or by plan review. */
  'plan.sent_back': z.strictObject({ issue, by: z.enum(['contract', 'review']), why: z.string(), round: z.number().int().positive() }),
  /** The owner (or a writer) objected to a plan that was built at once: the task stopped. */
  'plan.objected': z.strictObject({ issue, by: z.string(), why: z.string() }),
  /** A writer corrected the harness (a rejected PR or landing, a revised or rejected plan, a review asking for changes, a chat correction): recorded once per source. */
  'correction.recorded': z.strictObject({ key: z.string(), kind: z.enum(['pr_rejected', 'land_rejected', 'plan_revised', 'plan_rejected', 'review_changes', 'chat']), issue: issue.nullable(), pr: z.number().int().positive().nullable(), by: z.string(), text: z.string() }),
  /** The corrections agent's durable fix, filed as an issue the pipeline builds into a reviewed PR. */
  'correction.proposed': z.strictObject({ key: z.string(), fix_kind: z.enum(['impossible', 'check', 'rule', 'style']), issue, title: z.string(), why: z.string() }),
  /** A correction that repeats an earlier one: grouped with it, never proposed twice. `how`: same words, or the agent. */
  'correction.grouped': z.strictObject({ key: z.string(), same_as: z.string(), how: z.enum(['same words', 'the agent']) }),
  /** No durable fix: the agent found none (why), or the run failed (failed: true; it isn't retried). */
  'correction.no_fix': z.strictObject({ key: z.string(), why: z.string(), failed: z.boolean() }),
  /** WHY: item 33 (src/learnings.ts). `stage` null: code couldn't tell; the weekly judge's label joins by `run`. */
  'learning.noted': z.strictObject({
    key: z.string(),
    issue,
    role: z.string(),
    attempt: z.number().int().nullable(),
    run: z.string().nullable(),
    outcome: z.string(),
    stage: z.enum(['wrong files', 'right files, wrong place', 'wrong or incomplete change', 'verification', 'environment/harness']).nullable(),
    cause: z.string(),
    fingerprint: z.string(),
    same_as: z.string().nullable(),
  }),
  'learning.promote_requested': z.strictObject({ fingerprint: z.string(), line: z.string(), by: z.string() }),
  /** WHY: `pr` null: nothing was filed, and `detail` says why (the owner may promote again). */
  'learning.promoted': z.strictObject({ fingerprint: z.string(), line: z.string(), by: z.string(), pr: z.string().nullable(), number: z.number().int().positive().nullable(), detail: z.string() }),
  /** Gradual delegation: a harness PR merged; its review categories and whether it merged as proposed (no writer correction on it, no one else's push). */
  'delegation.observed': z.strictObject({ pr: z.number().int().positive(), issue, categories: z.array(z.string()), unchanged: z.boolean() }),
  /** A category put to the owner: loosen (a clean record) or tighten (loosened, then a revert, red main or later fix). */
  'delegation.suggested': z.strictObject({ category: z.string(), direction: z.enum(['loosen', 'tighten']), decision: z.string(), receipts: z.array(z.string()) }),
  /** The owner's answer; loosen or tighten files the review.yaml change as an issue (built into a PR they review). */
  'delegation.decided': z.strictObject({ category: z.string(), decision: z.string(), answer: z.string(), by: z.string(), issue: issue.nullable() }),
  /** A constraint seen min_sightings+ times got its proposal: a draft PR (a check), or an issue (a protected area). `keys`: its sightings then. */
  'feedback_check.proposed': z.strictObject({ constraint: z.string(), keys: z.array(z.string()), kind: z.enum(['pr', 'issue']), number: z.number().int().positive(), url: z.string(), mode: z.enum(['ast-grep', 'test', 'issue']), why: z.string() }),
  /** No proposal for it: no check fits (failed: false), or the drafting run or its draft failed (failed: true). Tried again only on a new sighting. */
  'feedback_check.dropped': z.strictObject({ constraint: z.string(), keys: z.array(z.string()), why: z.string(), failed: z.boolean() }),
  /**
   * One weekly optimization pass (src/coordinator/optimize.ts; started_at by the coordinator's clock): the target it
   * picked, main's numbers (baseline), and the task it filed; outcome: `filed`, or why it stopped.
   */
  'optimize.pass': z.strictObject({
    started_at: z.string(),
    target: z.string().max(400).nullable(),
    unit: z.string().max(20).default(''),
    lower_is_better: z.boolean().default(true),
    issue: issue.nullable(),
    baseline: z.strictObject({ sha, runs: z.array(z.number()).max(30), median: z.number(), mad: z.number() }).nullable(),
    outcome: z.string().max(1000),
  }),
  /**
   * An optimization task measured on its change (head): `improved` becomes the PR (its numbers in the body);
   * `discarded` is closed with why (no improvement, within the noise, the benchmark failed, or the week's budget).
   */
  'optimize.result': z.strictObject({
    issue,
    target: z.string().max(400),
    head: sha.nullable(),
    outcome: z.enum(['improved', 'discarded']),
    why: z.string().max(1000),
    before: z.strictObject({ sha, runs: z.array(z.number()).max(30), median: z.number(), mad: z.number() }).nullable(),
    after: z.strictObject({ sha, runs: z.array(z.number()).max(30), median: z.number(), mad: z.number() }).nullable(),
    gain: z.number().nullable(),
    pct: z.number().nullable(),
    noise: z.number().nullable(),
  }),
  /** A gardener finding: a pattern and the places it was seen (from the run or the event log's signals). */
  'gardener.finding': z.strictObject({ pattern: z.string(), kind: z.enum(['dead_code', 'duplication', 'rule_violation', 'hotspot', 'slow_check', 'flaky_check']), where: z.array(z.string()), detail: z.string() }),
  /** A gardener fix filed (an issue the pipeline builds into a reviewed PR): once per pattern. */
  'gardener.filed': z.strictObject({ pattern: z.string(), issue }),
  /** One gardener run (started_at: by the coordinator's clock): what it found and filed, what it cost, its log issue; outcome: done, or why it stopped. */
  'gardener.run': z.strictObject({ started_at: z.string(), findings: z.number().int().nonnegative(), filed: z.array(issue), cost_usd: z.number().nonnegative(), log_issue: issue.nullable(), outcome: z.string() }),
  /** An automation's definition changed (src/automations/store.ts): who, how, and each changed field (never a secret). system: the engine paused it. */
  'automation.changed': z.strictObject({ id: z.string(), action: z.enum(['create', 'edit', 'delete', 'pause', 'resume']), by: z.string(), role: z.enum(['owner', 'writer', 'system']), changes: z.array(z.string()), why: z.string().optional() }),
  /** A person asked the dashboard to run an automation now; the coordinator takes it on its next pass. */
  'automation.run_requested': z.strictObject({ id: z.string(), by: z.string(), role: z.enum(['owner', 'writer', 'viewer']) }),
  /**
   * An automation fired: its run id, what started it (kind, its reference: an issue or PR number, a slot, a chat
   * message's id; who), and its place in a chain (depth 0: a person, a schedule or a chat command; ancestors: the
   * automations whose output led here, oldest first).
   */
  'automation.fired': z.strictObject({ id: z.string(), run: z.string(), mode: z.enum(['task', 'report']), trigger: z.strictObject({ kind: z.enum(['schedule', 'github', 'discord', 'manual']), ref: z.string().nullable(), by: z.string().nullable() }), depth: z.number().int().nonnegative(), ancestors: z.array(z.string()) }),
  /** A trigger that didn't fire its automation, and why (a cap, the chain rules, a role, paused, off). */
  'automation.refused': z.strictObject({ id: z.string(), trigger: z.enum(['schedule', 'github', 'discord', 'manual']), ref: z.string().nullable(), why: z.string() }),
  /** What a run made: the issue it filed (task), or the issue or PR it commented on (report). Chains are traced through these, never through text on GitHub. */
  'automation.output': z.strictObject({ id: z.string(), run: z.string(), kind: z.enum(['issue', 'comment']), number: issue }),
  /** A run finished (a report's run; a task's filing): its outcome and what it cost (a task's builds are booked to its issue). */
  'automation.done': z.strictObject({ id: z.string(), run: z.string(), outcome: z.string(), cost_usd: z.number().nonnegative() }),
  /** The GitHub poller is holding off (the rate limit is under its floor, or GitHub said to wait), once per hold. */
  'automation.poll_held': z.strictObject({ why: z.string(), until: z.string() }),
  /** One superfan pass (src/superfan/): the instance's or the machine's; what it read, what it did, what it cost, today's spend. Notes: what it couldn't read. */
  'superfan.pass': z.strictObject({ scope: z.enum(['instance', 'machine']), outcome: z.enum(['quiet', 'nothing', 'posted', 'duplicate', 'budget', 'instance_budget', 'failed']), items: z.number().int().nonnegative(), cost_usd: z.number().nonnegative(), spent_usd: z.number().nonnegative(), filed: issue.nullable(), notes: z.array(z.string()) }),
  /** `role`: answered on the dashboard by someone it read as an owner or writer of the instance's repo. */
  'decision.answered': z.strictObject({ id: z.string(), by: z.string(), answer: z.string(), role: z.enum(['owner', 'writer']).optional() }),
  // the setup console's asks (src/console/asks.ts): what the harness needs from the owner and can't do itself
  /** An ask, as created. A paste_secret ask names the credential only; its value is never in any event. */
  'ask.created': z.strictObject({
    id: z.string(),
    instance: z.string(),
    title: z.string(),
    detail: z.string(),
    created_by: z.string(),
    spec: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('paste_secret'), credential: z.string(), where: z.string() }),
      z.strictObject({ kind: z.literal('approve_link'), url: z.string() }),
      z.strictObject({ kind: z.literal('question'), options: z.array(z.string()), writers_may_answer: z.boolean() }),
      z.strictObject({ kind: z.literal('root_step'), command: z.string(), args: z.array(z.string()) }),
    ]),
  }),
  /** An ask's one answer: who (and in what role), and the outcome; for a secret only that it was stored. */
  'ask.answered': z.strictObject({ id: z.string(), by: z.string(), role: z.enum(['owner', 'writer']), answer: z.string(), detail: z.string() }),
  /** An ask withdrawn before it was answered (by whatever created it, or the owner). */
  'ask.cancelled': z.strictObject({ id: z.string(), by: z.string(), why: z.string() }),
  // machine changes (src/machine-requests.ts): the dashboard asks, the coordinator runs the machine helper
  /** A machine helper command the owner asked for from the dashboard (Settings, or a root-step ask), for the coordinator to run. */
  'machine.requested': z.strictObject({ id: z.string(), args: z.array(z.string()), by: z.string(), via: z.enum(['settings', 'ask', 'add-project', 'claude-account', 'tailscale']), ask: z.string().nullable(), breakGlass: z.boolean().optional() }),
  /** The coordinator took a request (once: claimed in a write transaction). */
  'machine.started': z.strictObject({ id: z.string(), instance: z.string() }),
  /** How it ended: done (detail: the helper's output), failed, refused (off the allowlist), interrupted (not re-run). */
  'machine.finished': z.strictObject({ id: z.string(), outcome: z.enum(['done', 'failed', 'refused', 'interrupted']), detail: z.string() }),
  /**
   * One step of add-project.sh, as the coordinator relays its line (src/console/add-project.ts): the machine
   * request it belongs to, the step (instance, app, claude-token, checkout, policy, service, test-user,
   * machine-helper, dashboards) and how it stands: started, done (or skipped as done already), failed (detail: why,
   * and the retry), or ask (waiting on the owner). Never a key or a token: the script prints none.
   */
  'add_project.step': z.strictObject({
    request_id: z.string(),
    name: z.string(),
    repo: z.string(),
    step: z.enum(['instance', 'app', 'claude-token', 'checkout', 'policy', 'service', 'test-user', 'machine-helper', 'dashboards']),
    /** waiting: the step waits for what only time or someone else settles (the service: its setup PR's merge). */
    state: z.enum(['started', 'done', 'failed', 'ask', 'waiting']),
    detail: z.string(),
    /** An ask line: the setup-console ask the coordinator made of it. */
    ask: z.string().optional(),
    /** A failed line: how to try again. */
    retry: z.string().optional(),
  }),
  // landing and deploys
  'land.queued': z.strictObject({ issue, head: sha, level: z.enum(['L0', 'L1', 'L2', 'L3']) }),
  'land.result': z.strictObject({ issue, outcome: z.enum(['landed', 'pr_opened', 'conflict', 'red', 'rejected', 'error', 'deferred']), landed: sha.nullable(), detail: z.string() }),
  /** PR mode: a pull request the harness opened, and its watch. */
  'pr.opened': z.strictObject({ issue, number: z.number().int().positive(), url: z.string(), head: sha, draft: z.boolean() }),
  'pr.status': z.strictObject({
    issue,
    number: z.number().int().positive(),
    head: sha,
    ready: z.boolean(),
    reasons: z.array(z.string()),
    checks: z.array(z.strictObject({ name: z.string(), outcome: z.enum(['pass', 'fail', 'pending', 'cancelled', 'skipped', 'missing']) })),
  }),
  /** The PR's size and conversation as GitHub reports them at `head` (lines added and removed, files, comments and review comments), recorded when they change. */
  'pr.stats': z.strictObject({ issue, number: z.number().int().positive(), head: sha, additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(), files: z.number().int().nonnegative(), comments: z.number().int().nonnegative() }),
  'pr.ready': z.strictObject({ issue, number: z.number().int().positive(), head: sha }),
  'pr.unready': z.strictObject({ issue, number: z.number().int().positive(), head: sha, why: z.string() }),
  'pr.closed': z.strictObject({ issue, number: z.number().int().positive(), merged: z.boolean() }),
  /**
   * A fix run on a PR at `head`: a required check failed, or (`reviews`, their ids) a writer's review asked for
   * changes or commented. Both count toward roles.ci_repair.max_fixes_per_pr. `lease` is its claim.
   */
  'ci_fix.started': z.strictObject({ issue, number: z.number().int().positive(), head: sha, checks: z.array(z.string()), attempt: z.number().int().positive(), lease: sha, reviews: z.array(z.number().int().positive()).optional() }),
  /** Writers' reviews on a harness PR that get no fix run (the cap, runs off, someone else's push): recorded once, the owner told why. */
  'review_fix.declined': z.strictObject({ issue, number: z.number().int().positive(), reviews: z.array(z.number().int().positive()), reason: z.string() }),
  /** pushed: a fix is on the branch at `head`; no_push: it ended without one (ci_fix.gave_up says why); interrupted: the coordinator restarted. */
  'ci_fix.finished': z.strictObject({ issue, number: z.number().int().positive(), outcome: z.enum(['pushed', 'no_push', 'interrupted', 'claim_lost']), head: sha.nullable(), detail: z.string() }),
  /** An eval of instructions the change touches, base vs head (base null: new instructions). `error`: it couldn't run. */
  'instructions.eval': z.strictObject({
    issue,
    head: sha,
    target: z.string(),
    base: z.strictObject({ passed: z.number().int(), total: z.number().int() }).nullable(),
    result: z.strictObject({ passed: z.number().int(), total: z.number().int() }).nullable(),
    dropped: z.boolean(),
    incomplete: z.boolean(),
    changes: z.array(z.strictObject({ id: z.string(), title: z.string(), base: z.string(), head: z.string() })),
    cost_usd: z.number().nonnegative(),
    error: z.string().optional(),
    /** Samples per case. Scores (`base`, `result`, and held-out's) are rubric items met, of all items. */
    samples: z.number().int().positive().optional(),
    /** A role's held-out comparison, which decides; null: the role has no held-out cases (it can't pass). Absent: not a role. */
    held_out: z
      .strictObject({
        base: z.strictObject({ passed: z.number().int(), total: z.number().int() }).nullable(),
        result: z.strictObject({ passed: z.number().int(), total: z.number().int() }),
        dropped: z.boolean(),
        incomplete: z.boolean(),
        changes: z.array(z.strictObject({ id: z.string(), title: z.string(), base: z.string(), head: z.string() })),
      })
      .nullable()
      .optional(),
    held_out_error: z.string().optional(),
  }),
  /** The merge policy's call on a ready PR at `head`: merge it (auto) or wait for a human, and why. */
  'merge.decided': z.strictObject({ issue, number: z.number().int().positive(), head: sha, auto: z.boolean(), reasons: z.array(z.string()), why: z.array(z.strictObject({ category: z.string(), text: z.string() })).optional() }),
  /** Auto-merged: a merge commit `sha` of the evaluated `head`. */
  /**
   * An owner approved a PR the merge policy left to them, at this head (from a Discord thread: `via`): it merges on
   * the PR watch's next pass through the normal merge path, if its checks are still green on this head and
   * auto-merge isn't stopped. The first approval at a head stands.
   */
  'merge.approved': z.strictObject({ issue, number: z.number().int().positive(), head: sha, by: z.string(), via: z.enum(['discord']) }),
  'merge.done': z.strictObject({ issue, number: z.number().int().positive(), head: sha, sha, url: z.string(), title: z.string() }),
  'merge.failed': z.strictObject({ issue, number: z.number().int().positive(), head: sha, why: z.string() }),
  /**
   * The merge train (src/merge-policy-train.ts) put off merging PR `number` at `head` until `retry_at`: GitHub requires
   * it up to date with its base (strict protection), or its base moved under the merge. Not a failure and not the
   * owner's call; tried again then, with a growing backoff.
   */
  'merge.deferred': z.strictObject({ issue, number: z.number().int().positive(), head: sha, why: z.string(), retry_at: z.string() }),
  /** The default branch's required checks on an auto-merge's commit. */
  /** timed_out: some required check never reported on the merge commit (`failed` names them); the owner is told. */
  /**
   * The default branch's required checks on an auto-merge's commit. `flaky`: failed, then passed on a re-run of the
   * same commit; `quarantined`: failed, but quarantined as flaky (src/flaky.ts). Neither turns it red for the harness.
   */
  'merge.main_result': z.strictObject({ issue, number: z.number().int().positive(), sha, outcome: z.enum(['green', 'red', 'timed_out']), failed: z.array(z.string()), flaky: z.array(z.string()).optional(), quarantined: z.array(z.string()).optional() }),
  /** A wait reached its cap (coordinator/wait-caps.ts): recorded, the owner told, and it waits for them. `number`: the PR, if any. */
  'wait.capped': z.strictObject({ issue, number: z.number().int().positive().nullable(), kind: z.enum(['deferred_landing', 'mergeable_recheck', 'light_check_pending', 'main_checks']), detail: z.string() }),
  /** Auto-merge stopped for this instance (until the operator clears it); `revert` is the revert PR, if one was opened. */
  'merge.stopped': z.strictObject({ reason: z.string(), number: z.number().int().positive().nullable(), sha: sha.nullable(), revert: z.string().nullable() }),
  'merge.resumed': z.strictObject({ detail: z.string() }),
  /**
   * Main watch (src/main-watch.ts): how the default branch is guarded. github: GitHub enforces its protection;
   * main_watch: GitHub doesn't, and the watch checks every new commit; off: neither (`detail` says why).
   */
  'main_watch.mode': z.strictObject({ mode: z.enum(['github', 'main_watch', 'off']), detail: z.string() }),
  /** A commit on the default branch, accounted for: the harness's merge, or a mapped admin's or writer's, green at merge time. */
  'main_watch.checked': z.strictObject({ sha, how: z.enum(['harness', 'person']), number: z.number().int().positive() }),
  /**
   * A commit on the default branch an admin accepted as a bootstrap merge before the watch judged it (by its sha, or
   * by its PR's number and head; src/main-watch.ts acceptMerge): accounted, with no stop, alert or revert PR.
   */
  'main_watch.accepted': z.strictObject({ sha, how: z.literal('accepted'), number: z.number().int().positive().nullable(), id: z.string(), by: z.string(), reason: z.string() }),
  /**
   * A commit on the default branch nothing accounts for (a direct push, a merge with checks not green, an unknown
   * actor, a rewritten history): auto-merge is stopped, the owner alerted, and `revert` is the revert PR, if any.
   */
  'main_watch.unaccounted': z.strictObject({ sha, url: z.string(), reason: z.string(), number: z.number().int().positive().nullable(), revert: z.string().nullable() }),
  /**
   * An unaccounted commit that landed without a PR (src/direct-push-alert.ts): `direct`, GitHub's commit-to-PR link
   * has no merged PR for it; `rewrite`, a force-push. `pusher`: a GitHub login only (`pusher_from`: the push's actor,
   * or the commit's author when the push's isn't known). `alert`: whether it is posted to the ops channel
   * (config.yaml main_watch.direct_push_alert as committed before it).
   */
  'main_watch.direct_push': z.strictObject({ sha, url: z.string(), kind: z.enum(['direct', 'rewrite']), pusher: z.string().nullable(), pusher_from: z.enum(['activity', 'commit']).nullable(), subject: z.string(), alert: z.boolean() }),
  /** Its ops-channel post: sent (`ok`), how many owners it mentioned, and `note`: why nobody was, or why it wasn't sent. */
  'main_watch.direct_push_alert': z.strictObject({ sha, ok: z.boolean(), mentioned: z.number().int().nonnegative(), note: z.string().nullable() }),
  /** No more fix runs on this PR; the owner is asked to look. */
  /** The combined-state check started: the default branch moved and touched what this PR touches (overlap). */
  'light_check.started': z.strictObject({ issue, number: z.number().int().positive(), head: sha, main_sha: sha, overlap: z.array(z.string()) }),
  /** merge: the fast tier passed on the combination; hold: it failed (a human decides); conflict: they don't merge. */
  'light_check.finished': z.strictObject({ issue, number: z.number().int().positive(), head: sha, main_sha: sha, overlap: z.array(z.string()), outcome: z.enum(['merge', 'hold', 'conflict']), wait_ms: z.number().int().nonnegative(), detail: z.string() }),
  /** GitHub reports a harness PR as conflicting with its base (recorded once per head). */
  'conflict_fix.detected': z.strictObject({ issue, number: z.number().int().positive(), head: sha, base_sha: sha }),
  'conflict_fix.started': z.strictObject({ issue, number: z.number().int().positive(), head: sha, base_sha: sha, strategy: z.literal('merge'), attempt: z.number().int().positive(), lease: sha }),
  /**
   * How a conflict fix ended. pushed: the resolved branch is on the PR (head); waits_owner and reasons: why it
   * then waits for a human. gave_up: no (more) fixes, the owner is asked. interrupted: a restart cut it short.
   */
  'conflict_fix.finished': z.strictObject({
    issue,
    number: z.number().int().positive(),
    base_sha: sha.nullable(),
    strategy: z.literal('merge'),
    outcome: z.enum(['pushed', 'no_push', 'gave_up', 'interrupted', 'claim_lost']),
    head: sha.nullable(),
    files: z.array(z.string()),
    waits_owner: z.boolean(),
    reasons: z.array(z.string()),
    detail: z.string(),
  }),
  'ci_fix.gave_up': z.strictObject({ issue, number: z.number().int().positive(), head: sha, reason: z.string() }),
  // stale PR hygiene (src/pr-hygiene.ts): the harness's own PRs whose base is older than pr_hygiene.stale_after_days
  /** The default branch (base_sha) merged into a stale PR and pushed to its branch: `from` the head before, `head` the merge commit. */
  'pr_hygiene.merged_in': z.strictObject({ issue, number: z.number().int().positive(), from: sha, head: sha, base_sha: sha, base_days: z.number().int().nonnegative() }),
  /** An abandoned PR closed with a comment (its branch kept): its task closed or superseded, and no activity for a while. */
  'pr_hygiene.closed': z.strictObject({ issue, number: z.number().int().positive(), head: sha, why: z.string() }),
  /** One pass: how many PRs got the default branch merged in, conflict, were closed, were held for an owner, or skipped; each PR's result. */
  'pr_hygiene.pass': z.strictObject({
    merged_in: z.number().int().nonnegative(),
    conflicting: z.number().int().nonnegative(),
    closed: z.number().int().nonnegative(),
    held: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    prs: z.array(z.strictObject({ number: z.number().int().positive(), outcome: z.enum(['merged_in', 'conflicting', 'closed', 'held', 'skipped']), why: z.string().max(500) })),
  }),
  'land.batch': z.strictObject({ id: z.string(), issues: z.array(issue), tip: sha, outcome: z.enum(['started', 'landed', 'red', 'split', 'deferred']), detail: z.string() }),
  /**
   * PR mode with batching (coordinator/pr-batch.ts): a PR ready on its fast checks waits, at this head, for a batch.
   * `by`: a person's PR (a mapped admin or writer opened it, not the harness): `issue` is then the PR's own number,
   * and the harness never merges it.
   */
  'pr_batch.queued': z.strictObject({ issue, number: z.number().int().positive(), head: sha, by: z.string().optional() }),
  /**
   * One step of a PR batch. built: the batch's merge commit (`sha`, on `base`) of `prs`, in queue order; green/red: its
   * full run (`run`); checks_posted: the passing full check posted on that PR's head; culprit: the PR the bisection
   * found, returned with the failing `tier`; dropped: a PR whose head changed (or that closed) left the batch; conflict:
   * it does not merge onto the base; requeued: back in the queue for the next batch; abandoned: cut off by a restart
   * before its run ended; resumed: a green batch's checks finished after a restart; error: the batch could not be
   * built or run; finished: nothing more to do; stale: after the batch passed, main is no longer what it tested for
   * these PRs (something else landed, a PR ahead of them didn't merge, or merged as another tree), so they are tested
   * again. `parent`: the batch a bisection step tests a prefix of. `trees` (built): the tree after each PR's merge.
   */
  'pr_batch.step': z.strictObject({
    id: z.string(),
    step: z.enum(['built', 'green', 'red', 'checks_posted', 'culprit', 'dropped', 'conflict', 'requeued', 'abandoned', 'resumed', 'error', 'finished', 'stale', 'gpu_held']),
    prs: z.array(z.strictObject({ issue, number: z.number().int().positive(), head: sha, by: z.string().optional() })),
    sha: sha.nullable(),
    base: sha.nullable(),
    parent: z.string().nullable(),
    tier: z.string().nullable(),
    run: z
      .strictObject({
        id: z.string(),
        ok: z.boolean(),
        tiers: z.array(z.strictObject({ tier: z.string(), ok: z.boolean(), durationMs: z.number().nonnegative(), summary: z.string(), logRef: z.string() })),
      })
      .nullable(),
    detail: z.string(),
    trees: z.array(sha).optional(),
  }),
  /** `issue`: the issue whose landing triggered it (absent on older events and manual deploys). */
  'deploy.requested': z.strictObject({ env: z.string(), sha, issue: issue.optional() }),
  'deploy.verified': z.strictObject({ env: z.string(), sha, issue: issue.optional() }),
  'deploy.failed': z.strictObject({ env: z.string(), sha, why: z.string(), issue: issue.optional() }),
  'baseline.recorded': z.strictObject({ sha, failing: z.array(z.string()) }),
  // guardrails and system
  'guardrail.decision': z.strictObject({ decision: z.enum(['deny', 'ask']), rule: z.string(), agent: z.boolean() }),
  'secret.detected': z.strictObject({ source: z.string(), findings: z.number().int().nonnegative() }),
  'coordinator.started': z.strictObject({ instance: z.string(), pid: z.number().int(), version: z.string() }),
  /** A task started in a worktree from the pool (worktree-pool.ts), not a fresh one: this claim's worktree is `name`. */
  'worktree.pooled': z.strictObject({ issue, name: z.string() }),
  /** The worktree pool brought to main's tip: what was made, moved to it with its install kept (setup_key), removed, and setups that failed. */
  'worktree.pool_refilled': z.strictObject({ base: sha, created: z.array(z.string()), moved: z.array(z.string()).default([]), removed: z.array(z.string()), errors: z.array(z.string()) }),
  /** At start: state/ closed to other users (paths tightened, first 20 named) and old task files removed. */
  'state.tidied': z.strictObject({ tightened: z.number().int(), paths: z.array(z.string()), removed_tasks: z.number().int() }),
  /** A shutdown began (SIGTERM, SIGINT): runs in flight are aborted and their tasks requeued; `pending` is what was in flight. */
  'coordinator.stopping': z.strictObject({ instance: z.string(), signal: z.string(), pending: z.array(z.string()) }),
  /** The shutdown ended: `clean` when everything stopped in time; otherwise `pending` names what was left when it exited anyway. */
  'coordinator.stopped': z.strictObject({ instance: z.string(), clean: z.boolean(), ms: z.number().int().nonnegative(), pending: z.array(z.string()) }),
  'coordinator.tick': z.strictObject({ instance: z.string(), dispatched: z.number().int(), reconciled: z.number().int() }),
  'report.posted': z.strictObject({ day: z.string(), slot: z.string(), issue: z.number().int().nullable() }),
  /** The daily "waiting on you" digest was posted (`items` waiting, `merged` on their own since the last one). */
  'digest.posted': z.strictObject({ day: z.string(), issue: z.number().int(), items: z.number().int().nonnegative(), merged: z.number().int().nonnegative() }),
  'emergency.stop': z.strictObject({ by: z.string(), reason: z.string(), running: z.number().int() }),
  'emergency.resume': z.strictObject({ instance: z.string() }),
  'nightly.queued': z.strictObject({ day: z.string(), jobs: z.array(z.string()) }),
  /** Dispatch holds: `kind` and `facts` (the numbers when it began) say why, for the Board's banner (src/governor-holds.ts); absent on older events. */
  'governor.hold': z.strictObject({
    reason: z.string(),
    load: z.number().nullable(),
    free_disk_pct: z.number().nullable(),
    kind: z.enum(HOLD_KINDS).optional(),
    facts: z
      .strictObject({
        free_gb: z.number(),
        total_gb: z.number(),
        floor_gb: z.number(),
        floor_min_gb: z.number(),
        floor_pct: z.number(),
        est_gb: z.number(),
        load: z.number(),
        max_load: z.number(),
        spent_usd: z.number(),
        budget_usd: z.number(),
        until: z.string(),
        cap: z.number(),
        running: z.number(),
        windows: z.string(),
      })
      .partial()
      .optional(),
  }),
  'governor.release': z.strictObject({ load: z.number().nullable(), free_disk_pct: z.number().nullable() }),
  /** A ready task waits: it would change a hotspot file a running task changes too (`by`). Recorded once per wait. */
  'hotspot.held': z.strictObject({ issue, by: issue, files: z.array(z.string()), reason: z.string() }),
  /** A held task started (or stopped being ready): how long it waited, on which files. */
  'hotspot.released': z.strictObject({ issue, waited_ms: z.number().int().nonnegative(), files: z.array(z.string()), started: z.boolean() }),
  /** WHY: a ready task whose "Depends on" issues are open (`on`) must not start; recorded once per change of `on` (src/task-graph.ts). */
  'dependency.held': z.strictObject({ issue, on: z.array(issue), reason: z.string() }),
  /** INVARIANT: ends every dependency.held: its dependencies closed (`closed`), or it stopped being ready (`not_ready`). */
  'dependency.unblocked': z.strictObject({ issue, on: z.array(issue), waited_ms: z.number().int().nonnegative(), why: z.enum(['closed', 'not_ready']) }),
  /** WHY: a cycle never unblocks; reported once per cycle so the owner removes an edge. */
  'dependency.cycle': z.strictObject({ issue, cycle: z.array(issue) }),
  /** WHY: running tasks waiting on each other's files; `proceeds` goes ahead so neither waits forever (src/ownership.ts). */
  'ownership.deadlock': z.strictObject({ issue, cycle: z.array(issue), files: z.array(z.string()), proceeds: issue }),
  /** WHY: a file claim outlived its task; dropped so no task waits on it forever. */
  'ownership.stale': z.strictObject({ issue, files: z.array(z.string()) }),
  /** WHY: a goal split into child issues (src/goal-split.ts); `body_hash` lets dispatch trust a child only while its body is as filed. */
  'goal.split': z.strictObject({ issue, summary: z.string(), children: z.array(z.strictObject({ number: issue, key: z.string(), depends_on: z.array(issue), body_hash: z.string() })) }),
  'coordinator.error': z.strictObject({ instance: z.string(), where: z.string(), kind: z.string(), message: z.string() }),
  // test runs (src/testrun/): a project's CI run by the coordinator, as the sandboxed test user
  'testrun.queued': z.strictObject({ id: z.string(), sha, kind: z.enum(['fast', 'full']), prs: z.array(z.number().int().positive()), shard: z.strictObject({ index: z.number().int().positive(), total: z.number().int().positive() }).nullable() }),
  /**
   * It has a slot and the full-run lock (shared); `lock_wait_ms`: how long an exclusive holder kept it waiting. `gpu`:
   * planned when a tier of it asks for the GPU and root's file lists the instance (or can't be read): recorded before
   * any GPU command, so a run cut off by a hung machine is never run again by itself (src/testrun/gpu.ts).
   */
  'testrun.started': z.strictObject({ id: z.string(), slot: z.string(), lock_wait_ms: z.number().int().nonnegative(), gpu: z.literal('planned').optional() }),
  /** One tier's outcome. `summary`: the end of its output; `log_ref`: its full log in the instance's state (never a viewer's). */
  // `gpu`: only for a tier that asked for the GPU: whether the sandbox helper granted it, the nodes, and its line.
  'testrun.tier': z.strictObject({ id: z.string(), tier: z.string(), ok: z.boolean(), duration_ms: z.number().int().nonnegative(), summary: z.string().max(2000), log_ref: z.string(), cpu_s: z.number().nonnegative().nullable(), mem_peak_mb: z.number().nonnegative().nullable(), gpu: z.strictObject({ granted: z.boolean(), devices: z.array(z.string()), detail: z.string().max(300) }).optional() }),
  /** `results`: each tier's pass or fail, all a viewer sees of a run. */
  'testrun.finished': z.strictObject({
    id: z.string(),
    sha,
    kind: z.enum(['fast', 'full']),
    prs: z.array(z.number().int().positive()),
    ok: z.boolean(),
    outcome: z.enum(['done', 'cancelled', 'error', 'interrupted']),
    results: z.array(z.strictObject({ tier: z.string(), ok: z.boolean() })),
    detail: z.string().max(2000),
    /** A granted GPU command of it timed out or was killed: the run is never run again by itself (src/testrun/gpu.ts). */
    gpu_stopped: z.boolean().optional(),
  }),
  /**
   * One tier's per-test durations, read from its output (src/test-durations.ts): its slowest tests (at most 100) and
   * how many it printed durations for in all (0: its runner prints none this reads). For the metrics' slow tests.
   */
  'testrun.durations': z.strictObject({ id: z.string(), tier: z.string(), tests: z.array(z.strictObject({ name: z.string().max(300), ms: z.number().nonnegative() })).max(100), parsed: z.number().int().nonnegative() }),
  'testrun.wipe_failed': z.strictObject({ id: z.string(), left: z.array(z.string()) }),
  'testrun.checks_posted': z.strictObject({ id: z.string(), sha, checks: z.array(z.strictObject({ name: z.string(), conclusion: z.enum(['success', 'failure', 'cancelled']) })) }),
  /** no_permission: the App lacks Checks: write (the owner adds it); the checks were not posted. */
  'testrun.checks_failed': z.strictObject({ id: z.string(), sha, reason: z.enum(['no_permission', 'error']), detail: z.string().max(1000) }),
  /** The App's Checks permission on the repo, as GitHub reports it. */
  'testrun.checks_permission': z.strictObject({ level: z.enum(['write', 'read', 'none', 'unknown']), detail: z.string().max(500) }),
  /** The sandbox's own check (the helper's `check`): no run starts until it passed. */
  'testrun.sandbox': z.strictObject({ ok: z.boolean(), detail: z.string().max(2000) }),
  /**
   * WHY: `<cli> testrun measure` (src/testrun/measure.ts), one tests.yaml test_run env value per sandboxed run. Its own
   * type, never testrun.queued/started/finished: the PR runs, the batcher and the test-run view never read it.
   */
  'testrun.measure': z.strictObject({
    id: z.string(),
    sha,
    key: z.string(),
    phase: z.enum(['started', 'run_started', 'run_finished', 'recovered', 'stopped', 'finished']),
    value: z.string().nullable(),
    run_id: z.string().nullable(),
    ok: z.boolean().nullable(),
    wall_ms: z.number().int().nonnegative().nullable(),
    tiers: z.array(z.strictObject({ tier: z.string(), status: z.enum(['passed', 'failed', 'timed out', 'not run']), duration_ms: z.number().int().nonnegative(), cpu_s: z.number().nonnegative().nullable(), mem_peak_mb: z.number().nonnegative().nullable() })),
    detail: z.string().max(2000),
  }),
  // the pre-deploy gate (src/deploy-gate/): a branch fast-forwarded only to default-branch commits green on every gate tier
  /** The gate's tiers ran on a default-branch commit: ok only when every one passed; `failed` names the rest. */
  'deploy_gate.verdict': z.strictObject({ sha, ok: z.boolean(), failed: z.array(z.string()), reason: z.string().max(2000), run: z.string().nullable() }),
  /** The deploy branch was fast-forwarded (never forced): by the gate, or by an owner's override (`gate`: its state then). */
  'deploy_gate.moved': z.strictObject({ branch: z.string(), from: sha.nullable(), to: sha, by: z.string(), override: z.boolean(), gate: z.string().max(200) }),
  /** A default-branch commit the gate didn't pass: the deploy branch stays at `deployed`. */
  'deploy_gate.held': z.strictObject({ branch: z.string(), sha, deployed: sha.nullable(), reason: z.string().max(2000) }),
  /** The deploy branch isn't where the gate put it, or not on the default branch's line: nothing moved; an incident is raised. */
  'deploy_gate.refused': z.strictObject({ branch: z.string(), deploy: sha.nullable(), main: sha, target: sha.nullable(), reason: z.string().max(2000) }),
  /** An owner's `deploy <sha>` from Discord: asked (waiting on their confirm), confirmed, cancelled or refused. */
  'deploy_gate.override': z.strictObject({ id: z.string(), thread: z.string().nullable(), sha: z.string().max(64), by: z.string(), stage: z.enum(['asked', 'confirmed', 'cancelled', 'refused']), detail: z.string().max(1000) }),
  /**
   * The post-deploy check of a commit the deploy branch moved to: passed; failed (a smoke check failed: `rollback` says
   * what was rolled back); timed_out (the host didn't deploy it in time); deploy_failed (the host's deploy of it failed).
   * `snippet` is a redacted piece of a failing response's body; no header or cookie is ever kept. `token`: whether the
   * host's token was stored.
   */
  'deploy_gate.post_deploy': z.strictObject({
    sha,
    prev: sha.nullable(),
    outcome: z.enum(['passed', 'failed', 'timed_out', 'deploy_failed']),
    detail: z.string().max(2000),
    checks: z.array(z.strictObject({ name: z.string().max(40), ok: z.boolean(), status: z.number().int().nullable(), ms: z.number().int().nonnegative(), error: z.string().max(300).nullable(), snippet: z.string().max(300) })).max(20),
    rollback: z
      .strictObject({
        attempted: z.boolean(),
        ok: z.boolean(),
        detail: z.string().max(2000),
        services: z.array(z.strictObject({ service: z.string().max(40), to: z.string().max(100).nullable(), via: z.enum(['rollback', 'redeploy']).nullable(), ok: z.boolean(), detail: z.string().max(500) })).max(20),
      })
      .nullable(),
    github: z.strictObject({ total: z.number().int().nonnegative(), success: z.number().int().nonnegative() }).nullable(),
    token: z.boolean(),
  }),
  // docs/previews.md: a host environment per open PR, deleted when it closes
  'preview.created': z.strictObject({ pr: z.number().int().positive(), head: sha, environment: z.string().max(100) }),
  'preview.ready': z.strictObject({ pr: z.number().int().positive(), head: sha, url: z.string().max(300), flows: z.array(z.strictObject({ flow: z.string().max(60), status: z.enum(['pass', 'fail', 'unavailable']), detail: z.string().max(500) })).max(20) }),
  'preview.failed': z.strictObject({ pr: z.number().int().positive(), head: sha, outcome: z.enum(['deploy_failed', 'timed_out', 'error']), detail: z.string().max(1000) }),
  'preview.removed': z.strictObject({ pr: z.number().int().positive(), environment: z.string().max(100), reason: z.enum(['closed', 'expired', 'failed']), ok: z.boolean() }),
  'preview.waiting': z.strictObject({ pr: z.number().int().positive(), head: sha, active: z.number().int().nonnegative(), max: z.number().int().positive() }),
  'preview.error': z.strictObject({ detail: z.string().max(1000) }),
  /** The sandbox helper's protocol version, asked at coordinator start (testrun/helper.ts): no run starts unless ok. */
  'testrun.helper': z.strictObject({ ok: z.boolean(), have: z.number().int().nullable(), need: z.number().int(), detail: z.string().max(1000) }),
  // CI timings read from GitHub for the metrics (src/ci-metrics.ts): each recorded once, so each is asked once.
  /**
   * A merged PR's CI wall-clock on its head: from the first check run starting to the last required check
   * (config.yaml required_checks; every check when none) completing. `wall_ms` null: not measurable (`why`).
   */
  'ci.pr_timing': z.strictObject({ number: z.number().int().positive(), head: sha, wall_ms: z.number().int().nonnegative().nullable(), first_started: z.string().nullable(), last_completed: z.string().nullable(), why: z.string().max(500).nullable() }),
  /** One GitHub Actions job's per-test durations on a default-branch commit, from its log (src/test-durations.ts). */
  'ci.test_durations': z.strictObject({ sha, job: z.string().max(200), tests: z.array(z.strictObject({ name: z.string().max(300), ms: z.number().nonnegative() })).max(100), parsed: z.number().int().nonnegative(), error: z.string().max(500).nullable() }),
  // flaky tests (src/flaky.ts, coordinator/flaky.ts): before the default branch counts as red, its failing checks re-run on the same commit
  /**
   * The default branch's required checks failed on `sha` (a red run): each failing check (`failed`) is re-run there.
   * `via`: how each was: `actions` (its workflow run's failed jobs), `test_run` (the test run's tiers), or `none`
   * (it can't be: `why`); `id` is the failing check run, so its re-run is told apart.
   */
  'flaky.rerun_requested': z.strictObject({
    sha,
    number: z.number().int().positive().nullable(),
    failed: z.array(z.string()),
    via: z.array(z.strictObject({ check: z.string(), how: z.enum(['actions', 'test_run', 'none']), id: z.number().int().nullable(), why: z.string().nullable() })),
    /** When the re-run was asked for, by the coordinator's clock: rerun_timeout_min counts from it. */
    at: z.string(),
  }),
  /** The re-run's verdict on `sha`: `flaky` passed on the re-run, `real` failed again (or couldn't re-run, or `timed_out`). */
  'flaky.rerun_result': z.strictObject({ sha, number: z.number().int().positive().nullable(), flaky: z.array(z.string()), real: z.array(z.string()), timed_out: z.array(z.string()) }),
  /** A test (a check: an Actions job or a test-run tier) put in quarantine: it still runs and reports, but no longer turns the branch red for the harness. `again`: it had been released. */
  'flaky.quarantined': z.strictObject({ test: z.string(), sha, issue: z.number().int().positive().nullable(), url: z.string().nullable(), again: z.boolean() }),
  /** A quarantined test was seen flaky again: `sightings` in all. */
  'flaky.sighted': z.strictObject({ test: z.string(), sha, sightings: z.number().int().positive() }),
  /** A quarantined test's result on a default-branch commit: `passes`, the passes in a row now. */
  'flaky.observed': z.strictObject({ test: z.string(), sha, ok: z.boolean(), passes: z.number().int().nonnegative() }),
  /** A test left quarantine (it blocks again): after `passes` passes in a row, or an owner cleared it. */
  'flaky.released': z.strictObject({ test: z.string(), how: z.enum(['passes', 'owner']), by: z.string(), passes: z.number().int().nonnegative() }),
  // fix-forward (src/fix-forward.ts, coordinator/fix-forward.ts): a real red default branch, its culprit, fix tasks, and the revert only if they fail
  /**
   * The default branch went red on `sha` (after the flaky re-run said real): `failed` checks; `last_green` the last
   * commit known green before it; `candidates` the first-parent commits after it up to `sha`, oldest first, each with
   * the PR it merged (when its subject names one).
   */
  'fix_forward.started': z.strictObject({
    sha,
    number: z.number().int().positive().nullable(),
    failed: z.array(z.string()),
    last_green: sha.nullable(),
    candidates: z.array(z.strictObject({ sha, number: z.number().int().positive().nullable(), title: z.string() })).max(50),
  }),
  /** One candidate of red `sha` tested on its own commit: asked for (`verdict` pending, `via` how), then its verdict. */
  'fix_forward.tested': z.strictObject({ sha, candidate: sha, verdict: z.enum(['pending', 'good', 'bad', 'skip']), via: z.enum(['checks', 'test_run', 'actions', 'none']), ids: z.array(z.number().int()), detail: z.string() }),
  /** The culprit of red `sha`: `how` only (one candidate), bisect, or range (untestable commits left: `culprit` null, from..to). `revert_first`: why it is reverted at once. */
  'fix_forward.culprit': z.strictObject({
    sha,
    culprit: sha.nullable(),
    number: z.number().int().positive().nullable(),
    title: z.string(),
    how: z.enum(['only', 'bisect', 'range']),
    range: z.strictObject({ from: sha, to: sha }).nullable(),
    revert_first: z.array(z.string()),
  }),
  /** Fix task `attempt` for red `sha`: issue `issue`, worked like any task; its PR goes through the normal gates. */
  'fix_forward.attempt': z.strictObject({ sha, attempt: z.number().int().positive(), issue, culprit: z.number().int().positive().nullable() }),
  /** Fix task `attempt` didn't make the default branch green: why. */
  'fix_forward.attempt_failed': z.strictObject({ sha, attempt: z.number().int().positive(), issue, why: z.string() }),
  /**
   * Fix-forward's outcome for red `sha` (the delivery metrics read it): fixed (green again by fix PR `by`, or by
   * another merge), reverted (the culprit's revert PR opened), gave_up (no culprit to revert, or the revert failed).
   */
  'fix_forward.finished': z.strictObject({
    sha,
    outcome: z.enum(['fixed', 'reverted', 'gave_up']),
    attempts: z.number().int().nonnegative(),
    culprit: z.number().int().positive().nullable(),
    by: z.number().int().positive().nullable(),
    revert: z.strictObject({ url: z.string(), number: z.number().int().positive() }).nullable(),
    detail: z.string(),
  }),
  /** The default branch is green again on `tip` after red `sha`: by a fix PR (`fixed_by`), the revert of `reverted`, or neither. */
  'fix_forward.green': z.strictObject({ sha, tip: sha, fixed_by: z.number().int().positive().nullable(), reverted: z.number().int().positive().nullable() }),
  /** An off-machine backup attempt: ok only after the remote copy was read back, decrypted and matched (offsite-backup.ts). */
  'backup.offsite': z.strictObject({ ok: z.boolean(), destination: z.string(), key: z.string(), last_id: z.number().int().nonnegative(), error: z.string().optional() }),
  /**
   * One replay of a fixed past task through the real coordinator path (src/harness-evals/): success is its done_when
   * checks passing and the evaluator approving; cost from its run.cost events; human interventions are the decisions
   * it asked and the times it waited for the owner. `held_out`: a task from the private store (never named in a PR).
   */
  'harness_eval.task': z.strictObject({
    run: z.string(),
    task: z.string(),
    held_out: z.boolean(),
    sample: z.number().int().positive(),
    success: z.boolean(),
    done_when: z.boolean().nullable(),
    verdict: z.boolean().nullable(),
    outcome: z.enum(['queued', 'asked', 'blocked', 'budget', 'unfinished', 'error']),
    cost_usd: z.number().nonnegative(),
    wall_ms: z.number().int().nonnegative(),
    interventions: z.number().int().nonnegative(),
    detail: z.string(),
  }),
  /**
   * A harness eval run: every task replayed `samples` times within `budget_usd`. `trigger`: weekly, a change to the
   * engine's src/ (`engine`, and `pr`, the PR whose merge it is), or by hand. `stopped`: the budget ran out first.
   */
  'harness_eval.run': z.strictObject({
    id: z.string(),
    trigger: z.enum(['weekly', 'change', 'manual']),
    engine: z.string().nullable(),
    pr: z.number().int().positive().nullable(),
    tasks: z.number().int().nonnegative(),
    samples: z.number().int().positive(),
    runs: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    cost_usd: z.number().nonnegative(),
    wall_ms: z.number().int().nonnegative(),
    interventions: z.number().int().nonnegative(),
    budget_usd: z.number().positive(),
    stopped: z.enum(['budget']).nullable(),
    error: z.string().optional(),
  }),
  /** The run's results posted on the PR whose merge triggered it, against the last baseline. */
  'harness_eval.commented': z.strictObject({ run: z.string(), pr: z.number().int().positive(), baseline: z.string().nullable() }),
} as const;

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
