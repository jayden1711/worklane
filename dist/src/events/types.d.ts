import { z } from 'zod';
/**
 * What a decision rests on, recorded where it is asked so the dashboard's detail view (src/decision-detail.ts) shows
 * it whole: the change (its commits, files, review level and why, the review categories it falls in), the
 * evaluator's verdict and the checks at the head asked about, and an investigation's or a worker's own findings
 * and summary. Every field is optional: a kind records what it has, an older event has none, and the view says
 * plainly what was not recorded. Never sent to a viewer (src/viewer-events.ts lists the fields a viewer gets).
 */
export declare const DecisionContextSchema: z.ZodObject<{
    base: z.ZodOptional<z.ZodString>;
    head: z.ZodOptional<z.ZodString>;
    files: z.ZodOptional<z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        added: z.ZodNumber;
        removed: z.ZodNumber;
    }, z.core.$strict>>>;
    files_more: z.ZodOptional<z.ZodNumber>;
    level: z.ZodOptional<z.ZodEnum<{
        L0: "L0";
        L1: "L1";
        L2: "L2";
        L3: "L3";
    }>>;
    level_reasons: z.ZodOptional<z.ZodArray<z.ZodString>>;
    categories: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>>;
    verdict: z.ZodOptional<z.ZodObject<{
        patch_correct: z.ZodBoolean;
        test_correct: z.ZodBoolean;
        confidence: z.ZodEnum<{
            high: "high";
            medium: "medium";
            low: "low";
        }>;
        advice: z.ZodString;
        confidence_reason: z.ZodOptional<z.ZodString>;
        unread: z.ZodOptional<z.ZodArray<z.ZodString>>;
        unverified_claims: z.ZodOptional<z.ZodArray<z.ZodString>>;
        design_change: z.ZodOptional<z.ZodBoolean>;
        design_reason: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    checks: z.ZodOptional<z.ZodArray<z.ZodObject<{
        check: z.ZodString;
        status: z.ZodEnum<{
            pass: "pass";
            fail: "fail";
            unavailable: "unavailable";
            skipped: "skipped";
        }>;
        duration_ms: z.ZodOptional<z.ZodNumber>;
        tail: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
    tampered: z.ZodOptional<z.ZodArray<z.ZodString>>;
    summary: z.ZodOptional<z.ZodString>;
    findings: z.ZodOptional<z.ZodArray<z.ZodObject<{
        claim: z.ZodString;
        evidence: z.ZodString;
        file: z.ZodOptional<z.ZodString>;
        line: z.ZodOptional<z.ZodNumber>;
        severity: z.ZodOptional<z.ZodString>;
        confidence: z.ZodOptional<z.ZodEnum<{
            high: "high";
            medium: "medium";
            low: "low";
        }>>;
    }, z.core.$strict>>>;
    confidence: z.ZodOptional<z.ZodEnum<{
        high: "high";
        medium: "medium";
        low: "low";
    }>>;
    unverified: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
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
    /** A worker run that failed before doing any work: blocked at once with claude's own report. */
    readonly 'run.startup_failed': z.ZodObject<{
        issue: z.ZodNumber;
        role: z.ZodString;
        attempt: z.ZodNumber;
        seconds: z.ZodNumber;
        turns: z.ZodNumber;
        detail: z.ZodString;
    }, z.core.$strict>;
    /** block_hash: the done_when block judged (contractKey), so an edit to it is checked again. Older events have none. */
    readonly 'contract.missing': z.ZodObject<{
        issue: z.ZodNumber;
        why: z.ZodString;
        block_hash: z.ZodOptional<z.ZodString>;
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
    /** The issue was closed on GitHub by someone, outside the loop (seen by reconcile): nothing it held waits on anyone now. */
    readonly 'issue.closed': z.ZodObject<{
        issue: z.ZodNumber;
    }, z.core.$strict>;
    /** `retry_after`: a rate-limit or budget block retries on its own after then (up to a cap); absent: it waits for a relabel. */
    readonly 'issue.blocked': z.ZodObject<{
        issue: z.ZodNumber;
        owner: z.ZodString;
        why: z.ZodString;
        retry_after: z.ZodOptional<z.ZodString>;
        retry_kind: z.ZodOptional<z.ZodEnum<{
            budget: "budget";
            rate_limit: "rate_limit";
        }>>;
    }, z.core.$strict>;
    /** A held block retried on its own (relabelled ready), or, at the cap, left blocked (`gave_up`). */
    readonly 'issue.retry': z.ZodObject<{
        issue: z.ZodNumber;
        attempt: z.ZodNumber;
        kind: z.ZodEnum<{
            budget: "budget";
            rate_limit: "rate_limit";
        }>;
        gave_up: z.ZodBoolean;
    }, z.core.$strict>;
    /** The worker found nothing to change, and the coordinator's own checks pass on the unchanged base. */
    readonly 'issue.no_change': z.ZodObject<{
        issue: z.ZodNumber;
        owner: z.ZodString;
        base: z.ZodString;
        why: z.ZodString;
        checks: z.ZodArray<z.ZodObject<{
            check: z.ZodString;
            status: z.ZodEnum<{
                pass: "pass";
                fail: "fail";
                unavailable: "unavailable";
                skipped: "skipped";
            }>;
            exitCode: z.ZodNullable<z.ZodNumber>;
            tail: z.ZodOptional<z.ZodString>;
            duration_ms: z.ZodOptional<z.ZodNumber>;
            kind: z.ZodOptional<z.ZodLiteral<"browser">>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    /** `resumed`: the run continues the same attempt after research it asked for (it doesn't count as an attempt). */
    readonly 'run.started': z.ZodObject<{
        issue: z.ZodNumber;
        role: z.ZodString;
        model: z.ZodString;
        worktree: z.ZodString;
        pid: z.ZodNumber;
        pgid: z.ZodNullable<z.ZodNumber>;
        attempt: z.ZodNumber;
        resumed: z.ZodOptional<z.ZodLiteral<"research">>;
    }, z.core.$strict>;
    readonly 'run.heartbeat': z.ZodObject<{
        issue: z.ZodNumber;
        role: z.ZodString;
        note: z.ZodString;
    }, z.core.$strict>;
    /** A worker attempt failed: how (`kind`), and its failure reduced to a fingerprint (failure-modes normalizeCause) that reads the same each time it recurs. */
    readonly 'attempt.failed': z.ZodObject<{
        issue: z.ZodNumber;
        attempt: z.ZodNumber;
        kind: z.ZodEnum<{
            checks: "checks";
            stuck: "stuck";
            rejected: "rejected";
            evaluator: "evaluator";
        }>;
        fingerprint: z.ZodString;
    }, z.core.$strict>;
    /** The read-only reflection run before attempt `attempt`: `ok` when its what-failed / what-to-change reached that attempt's brief; else `why` not. */
    readonly 'attempt.reflected': z.ZodObject<{
        issue: z.ZodNumber;
        attempt: z.ZodNumber;
        model: z.ZodString;
        ok: z.ZodBoolean;
        why: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    /** The same failure `repeats` times in a row: the attempts start again in a fresh worktree, on the escalated model. */
    readonly 'task.reassigned': z.ZodObject<{
        issue: z.ZodNumber;
        attempt: z.ZodNumber;
        fingerprint: z.ZodString;
        repeats: z.ZodNumber;
        model: z.ZodString;
    }, z.core.$strict>;
    /** The issue's runs reached `share` of its agents.yaml budget: `warn` at 85% (an incident), `over` at 100% (the task is stopped). */
    readonly 'task.budget': z.ZodObject<{
        issue: z.ZodNumber;
        level: z.ZodEnum<{
            warn: "warn";
            over: "over";
        }>;
        share: z.ZodNumber;
        tokens: z.ZodNumber;
        minutes: z.ZodNumber;
        detail: z.ZodString;
    }, z.core.$strict>;
    readonly 'run.finished': z.ZodObject<{
        issue: z.ZodNumber;
        role: z.ZodString;
        reason: z.ZodEnum<{
            stuck: "stuck";
            succeeded: "succeeded";
            failed: "failed";
            timed_out: "timed_out";
            stalled: "stalled";
            rate_limited: "rate_limited";
            canceled_by_reconciliation: "canceled_by_reconciliation";
            budget_exhausted: "budget_exhausted";
            auth_mismatch: "auth_mismatch";
            auth_failed: "auth_failed";
            stopped: "stopped";
        }>;
        detail: z.ZodString;
        session: z.ZodOptional<z.ZodString>;
        resume: z.ZodOptional<z.ZodObject<{
            outcome: z.ZodEnum<{
                resumed: "resumed";
                fresh: "fresh";
            }>;
            session: z.ZodNullable<z.ZodString>;
            why: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    /** A run waited at least a second for its Claude login (one claude per login at a time). `issue` null: not an issue's run. */
    readonly 'run.lock_waited': z.ZodObject<{
        issue: z.ZodNullable<z.ZodNumber>;
        role: z.ZodString;
        model: z.ZodString;
        wait_ms: z.ZodNumber;
    }, z.core.$strict>;
    /** A run's try failed on a transient error and is retried after `wait_ms`; `cause` is the classified kind. */
    readonly 'run.transient_retry': z.ZodObject<{
        issue: z.ZodNullable<z.ZodNumber>;
        role: z.ZodString;
        model: z.ZodString;
        attempt: z.ZodNumber;
        cause: z.ZodEnum<{
            network: "network";
            rate_limit: "rate_limit";
            token_refresh: "token_refresh";
            overloaded: "overloaded";
            server_error: "server_error";
            other: "other";
        }>;
        wait_ms: z.ZodNumber;
        detail: z.ZodString;
    }, z.core.$strict>;
    /**
     * The stuck-run guard's verdict on a run: `flag` at 5 identical calls (or failures) in a row, `stop` at 8 identical
     * failures. `action` is what was done: `log` only (dry-run, or a flag), or `stop` (mode on). `run` is the run record's id.
     */
    readonly 'run.stuck': z.ZodObject<{
        issue: z.ZodNullable<z.ZodNumber>;
        role: z.ZodString;
        run: z.ZodNullable<z.ZodString>;
        kind: z.ZodEnum<{
            flag: "flag";
            stop: "stop";
        }>;
        mode: z.ZodEnum<{
            on: "on";
            "dry-run": "dry-run";
        }>;
        action: z.ZodEnum<{
            log: "log";
            stop: "stop";
        }>;
        tool: z.ZodString;
        input: z.ZodString;
        repeats: z.ZodNumber;
        failures: z.ZodNumber;
    }, z.core.$strict>;
    /**
     * A write made on the dashboard: who (their GitHub login, and the role the instance read from its repo, or the
     * owner's break-glass), on which instance, and what was done.
     */
    readonly 'dashboard.audit': z.ZodObject<{
        login: z.ZodString;
        role: z.ZodEnum<{
            owner: "owner";
            writer: "writer";
            viewer: "viewer";
        }>;
        via: z.ZodEnum<{
            discord: "discord";
            session: "session";
            "break-glass": "break-glass";
            siri: "siri";
        }>;
        instance: z.ZodNullable<z.ZodString>;
        action: z.ZodString;
        detail: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strict>;
    /** The owner changed an instance setting (policy.yaml) from the dashboard. */
    readonly 'settings.changed': z.ZodObject<{
        key: z.ZodString;
        from: z.ZodUnknown;
        to: z.ZodUnknown;
        by: z.ZodString;
        at: z.ZodString;
    }, z.core.$strict>;
    /** The coordinator picked up the instance's settings (policy.yaml changed); `error`: they were refused and the repo's values apply. */
    readonly 'settings.applied': z.ZodObject<{
        settings: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        error: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    /**
     * The default branch's config (read from git at `sha`, src/config/live.ts) replaced the running one; `changed`: the
     * sections that differ. `restart_needed`: settings read only at start, kept at their running value until a restart.
     */
    readonly 'config.applied': z.ZodObject<{
        sha: z.ZodString;
        changed: z.ZodArray<z.ZodString>;
        restart_needed: z.ZodArray<z.ZodObject<{
            path: z.ZodString;
            running: z.ZodUnknown;
            wanted: z.ZodUnknown;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    /** The default branch's config at `sha` failed validation: never applied, the last good one stays; `errors`: why. */
    readonly 'config.invalid': z.ZodObject<{
        sha: z.ZodString;
        errors: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    /** The default branch's config is valid again (fixed, or reverted to the running one) after an invalid one. */
    readonly 'config.recovered': z.ZodObject<{
        sha: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    /** A dashboard chat turn: who asked, whether they got a read-only answer, what it carried, what it cost; or why it was refused. */
    readonly 'chat.turn': z.ZodObject<{
        id: z.ZodString;
        by: z.ZodString;
        read_only: z.ZodBoolean;
        citations: z.ZodNumber;
        draft: z.ZodEnum<{
            none: "none";
            valid: "valid";
            refused: "refused";
        }>;
        actions: z.ZodNumber;
        cost_usd: z.ZodNumber;
        refused: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    /** The console: the owner messaged a live run (held until its current turn ends). */
    readonly 'console.message_queued': z.ZodObject<{
        run: z.ZodString;
        issue: z.ZodNullable<z.ZodNumber>;
        role: z.ZodString;
        id: z.ZodString;
        by: z.ZodString;
        text: z.ZodString;
    }, z.core.$strict>;
    readonly 'console.message_delivered': z.ZodObject<{
        run: z.ZodString;
        issue: z.ZodNullable<z.ZodNumber>;
        role: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>;
    /** The run ended before the message's turn came. */
    readonly 'console.message_dropped': z.ZodObject<{
        run: z.ZodString;
        issue: z.ZodNullable<z.ZodNumber>;
        role: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>;
    /** A research run searched the web (WebSearch), from its stream. `run`: its run record and live feed. */
    readonly 'research.searched': z.ZodObject<{
        issue: z.ZodNullable<z.ZodNumber>;
        run: z.ZodNullable<z.ZodString>;
        query: z.ZodString;
    }, z.core.$strict>;
    /** A research run fetched a page (WebFetch), or was refused it (`refused`: why). */
    readonly 'research.fetched': z.ZodObject<{
        issue: z.ZodNullable<z.ZodNumber>;
        run: z.ZodNullable<z.ZodString>;
        url: z.ZodString;
        host: z.ZodString;
        refused: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    /** A research run was held or stopped by a daily cap (searches, fetches or spend). */
    readonly 'research.capped': z.ZodObject<{
        issue: z.ZodNullable<z.ZodNumber>;
        run: z.ZodNullable<z.ZodString>;
        why: z.ZodString;
    }, z.core.$strict>;
    /** A worker or evaluator asked for research instead of guessing; `held`: why it wasn't answered (a cap, the per-task limit, a refused request). */
    readonly 'research.requested': z.ZodObject<{
        issue: z.ZodNumber;
        role: z.ZodEnum<{
            worker: "worker";
            evaluator: "evaluator";
        }>;
        question: z.ZodString;
        why: z.ZodString;
        held: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    /** A research report was accepted and posted: its sources, the fields it returned that were dropped, and the report. */
    readonly 'research.reported': z.ZodObject<{
        issue: z.ZodNumber;
        run: z.ZodNullable<z.ZodString>;
        sources: z.ZodNumber;
        ignored: z.ZodArray<z.ZodString>;
        report: z.ZodString;
    }, z.core.$strict>;
    /** A new report from a source: `sender` is a hash of the source's sender id, `excerpt` the redacted text's start. */
    readonly 'intake.received': z.ZodObject<{
        id: z.ZodString;
        source: z.ZodString;
        sender: z.ZodString;
        excerpt: z.ZodString;
    }, z.core.$strict>;
    /** A report taken no further: a cap (sender_cap, flood, drafts_cap, spend_cap, budget), a failed run or a refused draft. */
    readonly 'intake.dropped': z.ZodObject<{
        id: z.ZodString;
        reason: z.ZodString;
    }, z.core.$strict>;
    /** The intake agent's triage as accepted: `ignored`, fields it returned that were dropped; `draft_refused`, why its draft failed (then the kind is needs_info). */
    readonly 'intake.triaged': z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodString;
        reproduction: z.ZodNullable<z.ZodString>;
        ignored: z.ZodArray<z.ZodString>;
        draft_refused: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    readonly 'intake.filed': z.ZodObject<{
        id: z.ZodString;
        issue: z.ZodNumber;
        ready: z.ZodBoolean;
    }, z.core.$strict>;
    /** An untrusted sender's draft, waiting on the owner's decision. */
    readonly 'intake.awaiting': z.ZodObject<{
        id: z.ZodString;
        decision: z.ZodString;
    }, z.core.$strict>;
    /** A question passed to the owner. */
    readonly 'intake.asked': z.ZodObject<{
        id: z.ZodString;
        decision: z.ZodString;
    }, z.core.$strict>;
    /** The owner's answer on an intake decision; `issue`: what approve or edit filed. */
    readonly 'intake.decided': z.ZodObject<{
        id: z.ZodString;
        decision: z.ZodString;
        answer: z.ZodString;
        by: z.ZodString;
        issue: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strict>;
    /** Same as an open issue: a comment there. */
    readonly 'intake.commented': z.ZodObject<{
        id: z.ZodString;
        issue: z.ZodNumber;
    }, z.core.$strict>;
    /** Same as a recent report with no issue yet. */
    readonly 'intake.grouped': z.ZodObject<{
        id: z.ZodString;
        with: z.ZodString;
    }, z.core.$strict>;
    /** The triage run for a report is about to start: until its outcome, a restart ends it as interrupted. */
    readonly 'intake.started': z.ZodObject<{
        id: z.ZodString;
    }, z.core.$strict>;
    /**
     * Which text a reply used: the casual replier's (`casual`, it passed the checks) or the engine's fixed one, with
     * `why` (the check it failed, the cap, or the run's end). Only when casual replies are on.
     */
    readonly 'intake.reply_checked': z.ZodObject<{
        id: z.ZodString;
        stage: z.ZodString;
        used: z.ZodEnum<{
            fixed: "fixed";
            casual: "casual";
        }>;
        why: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    /** A reply is about to be sent (recorded first, so a crash can't send it twice). */
    readonly 'intake.replying': z.ZodObject<{
        id: z.ZodString;
        stage: z.ZodString;
    }, z.core.$strict>;
    /**
     * A reply to the reporter at a stage (filed, info, question, merged, deployed, interrupted), once each; `ok`: the
     * source took it; `unknown`: a restart cut it off mid-send, so whether it went out is unknown (it isn't resent).
     */
    readonly 'intake.replied': z.ZodObject<{
        id: z.ZodString;
        stage: z.ZodString;
        ok: z.ZodBoolean;
        unknown: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>;
    /** A chat post is about to be sent (recorded first, so a crash can't send it twice). `key`: what it is for. */
    readonly 'discord.posting': z.ZodObject<{
        key: z.ZodString;
    }, z.core.$strict>;
    /**
     * A chat post, once per key: a decision's or ask's thread (`thread`: its id), a notice (no thread), or a reply in a
     * thread. `unknown`: a restart cut it off mid-send, so whether it went out is unknown (it isn't resent).
     */
    readonly 'discord.posted': z.ZodObject<{
        key: z.ZodString;
        thread: z.ZodNullable<z.ZodString>;
        ok: z.ZodBoolean;
        unknown: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>;
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
    readonly 'discord.idea': z.ZodObject<{
        id: z.ZodString;
        stage: z.ZodEnum<{
            dropped: "dropped";
            failed: "failed";
            opened: "opened";
            said: "said";
            asked: "asked";
            drafted: "drafted";
            filed: "filed";
        }>;
        by: z.ZodNullable<z.ZodString>;
        msg: z.ZodNullable<z.ZodString>;
        issue: z.ZodNullable<z.ZodNumber>;
        detail: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    readonly 'discord.reply': z.ZodObject<{
        id: z.ZodString;
        thread: z.ZodString;
        target: z.ZodString;
        by: z.ZodString;
        outcome: z.ZodEnum<{
            link: "link";
            comment: "comment";
            refused: "refused";
            question: "question";
            answered: "answered";
            ambiguous: "ambiguous";
            already: "already";
            confirm: "confirm";
        }>;
        answer: z.ZodNullable<z.ZodString>;
        excerpt: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    /**
     * A plain-language pick in a thread (src/intake/explain.ts): asked (the bot asked `by` to confirm `option`),
     * confirmed (their next message was yes: the answer is recorded through the decide path), dropped (their next
     * message was something else). Only the same person's yes confirms.
     */
    /**
     * A setup step's one-time dashboard link (src/console/links.ts), sent by DM to an owner who asked for it in the
     * step's thread: for that ask and that GitHub login only, until `expires_at`, once. Only the token's hash is kept.
     */
    readonly 'setup_link.issued': z.ZodObject<{
        ask: z.ZodString;
        login: z.ZodString;
        hash: z.ZodString;
        expires_at: z.ZodString;
    }, z.core.$strict>;
    /** A one-time link was presented on the dashboard: opened (it pointed the owner to its ask), or refused and burnt. */
    readonly 'setup_link.used': z.ZodObject<{
        hash: z.ZodString;
        by: z.ZodString;
        outcome: z.ZodEnum<{
            closed: "closed";
            opened: "opened";
            expired: "expired";
            wrong_login: "wrong_login";
            not_owner: "not_owner";
        }>;
    }, z.core.$strict>;
    readonly 'discord.confirm': z.ZodObject<{
        thread: z.ZodString;
        target: z.ZodString;
        by: z.ZodString;
        option: z.ZodString;
        stage: z.ZodEnum<{
            dropped: "dropped";
            asked: "asked";
            confirmed: "confirmed";
        }>;
        msg: z.ZodString;
    }, z.core.$strict>;
    /**
     * A thread's plain-language summary, once per thread: `summary` (it passed the facts check) or `template` (the
     * fixed template and the dashboard link, `why`: the check it failed, the cap or the run's end).
     */
    readonly 'discord.explained': z.ZodObject<{
        target: z.ZodString;
        thread: z.ZodString;
        used: z.ZodEnum<{
            template: "template";
            summary: "summary";
        }>;
        why: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    /**
     * A message in a chat channel (src/coordinator/channel-chat.ts), by its report id, from a mapped admin or writer:
     * answered (posted in `messages` parts), refused (the reply failed a code check, `why`; a fixed line was posted),
     * failed (the run ended without a reply), capped (over discord.chat_max_usd_per_day or the daily budget). The text
     * stays in the coordinator's private store, never here.
     */
    readonly 'discord.chat': z.ZodObject<{
        id: z.ZodString;
        channel: z.ZodString;
        by: z.ZodString;
        outcome: z.ZodEnum<{
            failed: "failed";
            refused: "refused";
            answered: "answered";
            capped: "capped";
        }>;
        messages: z.ZodNumber;
        why: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    readonly 'console.run_stopped': z.ZodObject<{
        run: z.ZodString;
        issue: z.ZodNullable<z.ZodNumber>;
        role: z.ZodString;
        by: z.ZodString;
    }, z.core.$strict>;
    readonly 'console.request_refused': z.ZodObject<{
        request: z.ZodString;
        kind: z.ZodString;
        run: z.ZodString;
        by: z.ZodString;
        why: z.ZodString;
    }, z.core.$strict>;
    /** `provider`: the open-model provider it ran on (local runs cost 0); tokens and seconds, when claude reported them. */
    readonly 'run.cost': z.ZodObject<{
        issue: z.ZodNullable<z.ZodNumber>;
        role: z.ZodString;
        model: z.ZodString;
        usd: z.ZodNumber;
        turns: z.ZodNumber;
        provider: z.ZodOptional<z.ZodString>;
        tokens_in: z.ZodOptional<z.ZodNumber>;
        tokens_out: z.ZodOptional<z.ZodNumber>;
        secs: z.ZodOptional<z.ZodNumber>;
        conversation: z.ZodOptional<z.ZodString>;
        by: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    /** A run meant for an open-model provider ran on its normal model instead, and why (not opted in, no passing eval, down, slow, the GPU lock held, refused for the work). */
    readonly 'provider.fallback': z.ZodObject<{
        issue: z.ZodNullable<z.ZodNumber>;
        role: z.ZodString;
        provider: z.ZodString;
        reason: z.ZodString;
        model: z.ZodString;
    }, z.core.$strict>;
    /**
     * A run hit a usage or rate limit (src/usage-limit.ts): on Anthropic (`provider` null), the instance pauses until
     * `reset_at`; on an open-model provider, that provider is skipped until then and the run is redone on its fallback.
     * `source`: claude: the reset time came from claude's message; default: it gave none.
     */
    readonly 'usage.limit_hit': z.ZodObject<{
        issue: z.ZodNullable<z.ZodNumber>;
        role: z.ZodString;
        model: z.ZodString;
        provider: z.ZodNullable<z.ZodString>;
        reset_at: z.ZodString;
        source: z.ZodEnum<{
            default: "default";
            claude: "claude";
        }>;
        kind: z.ZodNullable<z.ZodString>;
        detail: z.ZodString;
    }, z.core.$strict>;
    /** The instance paused on the Claude usage limit: no run starts until `reset_at`; the run's task (if any) was requeued. */
    readonly 'usage.paused': z.ZodObject<{
        reset_at: z.ZodString;
        source: z.ZodEnum<{
            default: "default";
            claude: "claude";
        }>;
        kind: z.ZodNullable<z.ZodString>;
        issue: z.ZodNullable<z.ZodNumber>;
        role: z.ZodString;
        detail: z.ZodString;
    }, z.core.$strict>;
    /** The pause ended: its reset time passed. */
    readonly 'usage.resumed': z.ZodObject<{
        reset_at: z.ZodString;
        paused_ms: z.ZodNumber;
        reason: z.ZodOptional<z.ZodEnum<{
            reset: "reset";
            "account switched": "account switched";
        }>>;
    }, z.core.$strict>;
    /**
     * A run's Claude login was refused by the API (401/403, an invalid or expired key or token; src/claude-auth-failure.ts):
     * no new Claude run starts on the login (`key`, its config dir) until a call on it succeeds. `login` is the account as
     * claude auth status names it, never a token; `detail` is Claude's message, redacted.
     */
    readonly 'claude_auth.failed': z.ZodObject<{
        key: z.ZodString;
        login: z.ZodString;
        lane: z.ZodString;
        issue: z.ZodNullable<z.ZodNumber>;
        role: z.ZodString;
        detail: z.ZodString;
    }, z.core.$strict>;
    /** A minimal real call on a held login: `by` the periodic check, the owner's re-check, or an account switch. */
    readonly 'claude_auth.checked': z.ZodObject<{
        key: z.ZodString;
        login: z.ZodString;
        ok: z.ZodBoolean;
        by: z.ZodEnum<{
            owner: "owner";
            timer: "timer";
            account_switch: "account_switch";
        }>;
        detail: z.ZodString;
        cost_usd: z.ZodNumber;
    }, z.core.$strict>;
    /**
     * An instance's Claude account profile switch, as the root script recorded it (src/claude-profiles.ts, issue #464):
     * `op` its id, `to` the profile asked for, `from` each instance's profile before, `by` who asked (a GitHub login, or
     * `terminal`), `ok` whether every agent user's real call on it was answered (if not, nothing changed). Never a token.
     */
    readonly 'account.switched': z.ZodObject<{
        op: z.ZodString;
        to: z.ZodString;
        from: z.ZodRecord<z.ZodString, z.ZodString>;
        instances: z.ZodArray<z.ZodString>;
        by: z.ZodString;
        ok: z.ZodBoolean;
        detail: z.ZodString;
    }, z.core.$strict>;
    /**
     * A Claude account profile request the dashboard refused before it knew who asked (no session, or no role here):
     * the path, the login the hub named if any, and why. Nothing was read from the body or started.
     */
    readonly 'claude_account.refused': z.ZodObject<{
        path: z.ZodString;
        login: z.ZodNullable<z.ZodString>;
        status: z.ZodNumber;
        why: z.ZodString;
    }, z.core.$strict>;
    /**
     * Auto-failover between account profiles on a usage limit (src/claude-failover.ts): asked (a move, proven by a
     * real call before it happens), switched, refused, none (no free account in the order), and the move back after
     * the reset (back-asked, back, back-refused). Never on an auth failure. Never a token.
     */
    readonly 'account.failover': z.ZodObject<{
        stage: z.ZodEnum<{
            none: "none";
            refused: "refused";
            asked: "asked";
            switched: "switched";
            "back-asked": "back-asked";
            back: "back";
            "back-refused": "back-refused";
        }>;
        from: z.ZodString;
        to: z.ZodString;
        reset_at: z.ZodNullable<z.ZodString>;
        detail: z.ZodString;
    }, z.core.$strict>;
    /** A call on a held login succeeded (`via` a run or a check): the hold ends and runs start again. */
    readonly 'claude_auth.recovered': z.ZodObject<{
        key: z.ZodString;
        login: z.ZodString;
        via: z.ZodEnum<{
            check: "check";
            run: "run";
        }>;
        role: z.ZodString;
        held_ms: z.ZodNumber;
        hold_id: z.ZodNumber;
    }, z.core.$strict>;
    /**
     * A failed worker run's earliest failed stage (stage-label.ts), for the weekly report. `by` code: set from the
     * run's events and record, no model asked; judge: one capped judge call. A label changes nothing by itself.
     */
    readonly 'run.stage_labeled': z.ZodObject<{
        run: z.ZodString;
        issue: z.ZodNullable<z.ZodNumber>;
        role: z.ZodString;
        instance: z.ZodString;
        stage: z.ZodEnum<{
            plan: "plan";
            "wrong files": "wrong files";
            "right files, wrong place": "right files, wrong place";
            "wrong or incomplete change": "wrong or incomplete change";
            verification: "verification";
            review: "review";
            "environment/harness": "environment/harness";
        }>;
        reason: z.ZodString;
        by: z.ZodEnum<{
            code: "code";
            judge: "judge";
        }>;
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
    /** `added`/`removed`: the lines added and removed (the board's diff +/−); absent in older events, which have only `lines`. */
    readonly 'change.proposed': z.ZodObject<{
        issue: z.ZodNumber;
        branch: z.ZodString;
        base: z.ZodString;
        head: z.ZodString;
        files: z.ZodArray<z.ZodString>;
        lines: z.ZodNumber;
        added: z.ZodOptional<z.ZodNumber>;
        removed: z.ZodOptional<z.ZodNumber>;
        patch_hash: z.ZodString;
    }, z.core.$strict>;
    readonly 'change.rejected': z.ZodObject<{
        issue: z.ZodNumber;
        why: z.ZodString;
    }, z.core.$strict>;
    /** A change hit the push limits: at stage 'change' (before verifying; the worker is told) or 'push' (refused at the push). */
    readonly 'push.refused': z.ZodObject<{
        issue: z.ZodNumber;
        head: z.ZodString;
        stage: z.ZodEnum<{
            push: "push";
            change: "change";
        }>;
        reasons: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    /**
     * A push to the default branch, refused (push-guard.ts): by the coordinator's push code, or by the pre-push hook
     * (`via` hook: whoever pushed from the checkout, or the coordinator's git). `head`: what it would have pushed.
     */
    readonly 'push.blocked': z.ZodObject<{
        ref: z.ZodString;
        head: z.ZodNullable<z.ZodString>;
        via: z.ZodEnum<{
            coordinator: "coordinator";
            hook: "hook";
        }>;
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
                skipped: "skipped";
            }>;
            exitCode: z.ZodNullable<z.ZodNumber>;
            tail: z.ZodOptional<z.ZodString>;
            duration_ms: z.ZodOptional<z.ZodNumber>;
            kind: z.ZodOptional<z.ZodLiteral<"browser">>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    /** The browser checks a verify ran (src/coordinator/browser.ts): the PR description's BROWSER CHECKS section. */
    readonly 'browser.evidence': z.ZodObject<{
        issue: z.ZodNumber;
        head: z.ZodString;
        lines: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    /**
     * The sentences of a worker's summary that claim verification (src/receipts.ts), for the PR's receipts; and the
     * worker's intent paragraph and risk class for the top of the PR body (src/pr-rules.ts; the class can only raise
     * the one computed from the paths). Both absent in older events.
     */
    readonly 'worker.claims': z.ZodObject<{
        issue: z.ZodNumber;
        claims: z.ZodArray<z.ZodString>;
        intent: z.ZodOptional<z.ZodString>;
        risk_class: z.ZodOptional<z.ZodEnum<{
            "docs-only": "docs-only";
            logic: "logic";
            protected: "protected";
        }>>;
        labeled: z.ZodOptional<z.ZodArray<z.ZodObject<{
            claim: z.ZodString;
            label: z.ZodEnum<{
                measured: "measured";
                inferred: "inferred";
                guess: "guess";
            }>;
            basis: z.ZodString;
        }, z.core.$strict>>>;
        label_problems: z.ZodOptional<z.ZodArray<z.ZodString>>;
        handoffs: z.ZodOptional<z.ZodArray<z.ZodString>>;
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
        confidence_reason: z.ZodOptional<z.ZodString>;
        advice: z.ZodString;
        unverified_claims: z.ZodOptional<z.ZodArray<z.ZodString>>;
        unread: z.ZodOptional<z.ZodArray<z.ZodString>>;
        design_change: z.ZodOptional<z.ZodBoolean>;
        design_reason: z.ZodOptional<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        escalated_from: z.ZodOptional<z.ZodString>;
        claims: z.ZodOptional<z.ZodArray<z.ZodObject<{
            claim: z.ZodString;
            label: z.ZodEnum<{
                measured: "measured";
                inferred: "inferred";
                guess: "guess";
            }>;
            basis: z.ZodString;
        }, z.core.$strict>>>;
        cross_family: z.ZodOptional<z.ZodObject<{
            provider: z.ZodString;
            outcome: z.ZodEnum<{
                agrees: "agrees";
                disagrees: "disagrees";
                not_run: "not_run";
            }>;
            patch_correct: z.ZodOptional<z.ZodBoolean>;
            confidence: z.ZodOptional<z.ZodEnum<{
                high: "high";
                medium: "medium";
                low: "low";
            }>>;
            reason: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
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
            plan: "plan";
            land: "land";
            automation: "automation";
            delegation: "delegation";
            question: "question";
            domain: "domain";
            intake: "intake";
        }>;
        issue: z.ZodNullable<z.ZodNumber>;
        owner: z.ZodString;
        question: z.ZodString;
        options: z.ZodArray<z.ZodString>;
        recommendation: z.ZodString;
        receipts: z.ZodArray<z.ZodString>;
        context: z.ZodOptional<z.ZodObject<{
            base: z.ZodOptional<z.ZodString>;
            head: z.ZodOptional<z.ZodString>;
            files: z.ZodOptional<z.ZodArray<z.ZodObject<{
                path: z.ZodString;
                added: z.ZodNumber;
                removed: z.ZodNumber;
            }, z.core.$strict>>>;
            files_more: z.ZodOptional<z.ZodNumber>;
            level: z.ZodOptional<z.ZodEnum<{
                L0: "L0";
                L1: "L1";
                L2: "L2";
                L3: "L3";
            }>>;
            level_reasons: z.ZodOptional<z.ZodArray<z.ZodString>>;
            categories: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>>;
            verdict: z.ZodOptional<z.ZodObject<{
                patch_correct: z.ZodBoolean;
                test_correct: z.ZodBoolean;
                confidence: z.ZodEnum<{
                    high: "high";
                    medium: "medium";
                    low: "low";
                }>;
                advice: z.ZodString;
                confidence_reason: z.ZodOptional<z.ZodString>;
                unread: z.ZodOptional<z.ZodArray<z.ZodString>>;
                unverified_claims: z.ZodOptional<z.ZodArray<z.ZodString>>;
                design_change: z.ZodOptional<z.ZodBoolean>;
                design_reason: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            checks: z.ZodOptional<z.ZodArray<z.ZodObject<{
                check: z.ZodString;
                status: z.ZodEnum<{
                    pass: "pass";
                    fail: "fail";
                    unavailable: "unavailable";
                    skipped: "skipped";
                }>;
                duration_ms: z.ZodOptional<z.ZodNumber>;
                tail: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>>;
            tampered: z.ZodOptional<z.ZodArray<z.ZodString>>;
            summary: z.ZodOptional<z.ZodString>;
            findings: z.ZodOptional<z.ZodArray<z.ZodObject<{
                claim: z.ZodString;
                evidence: z.ZodString;
                file: z.ZodOptional<z.ZodString>;
                line: z.ZodOptional<z.ZodNumber>;
                severity: z.ZodOptional<z.ZodString>;
                confidence: z.ZodOptional<z.ZodEnum<{
                    high: "high";
                    medium: "medium";
                    low: "low";
                }>>;
            }, z.core.$strict>>>;
            confidence: z.ZodOptional<z.ZodEnum<{
                high: "high";
                medium: "medium";
                low: "low";
            }>>;
            unverified: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    /** An agent's request to a host outside its allowlist was refused: once per issue and host, with the decision it raised. */
    readonly 'network.domain_requested': z.ZodObject<{
        issue: z.ZodNumber;
        host: z.ZodString;
        role: z.ZodString;
        run: z.ZodNullable<z.ZodString>;
        tool: z.ZodString;
        what: z.ZodString;
        decision: z.ZodString;
    }, z.core.$strict>;
    /** The owner's answer on a refused host: allow-repo (pr: the config change proposed), allow-once (the task's next run), or deny. */
    readonly 'network.domain_decided': z.ZodObject<{
        issue: z.ZodNumber;
        host: z.ZodString;
        decision: z.ZodString;
        answer: z.ZodEnum<{
            deny: "deny";
            "allow-repo": "allow-repo";
            "allow-once": "allow-once";
        }>;
        by: z.ZodString;
        pr: z.ZodNullable<z.ZodString>;
        detail: z.ZodString;
    }, z.core.$strict>;
    /** A size:M/L task's plan, posted on the issue: held for the owner's approval (decision) or built at once. */
    readonly 'plan.posted': z.ZodObject<{
        issue: z.ZodNumber;
        plan: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        held: z.ZodBoolean;
        reasons: z.ZodArray<z.ZodString>;
        comments_at: z.ZodNumber;
        decision: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    /** The owner's answer on a held plan: approve builds it, revise plans again with the note, reject stops the task. */
    readonly 'plan.decided': z.ZodObject<{
        issue: z.ZodNumber;
        decision: z.ZodString;
        answer: z.ZodEnum<{
            approve: "approve";
            revise: "revise";
            reject: "reject";
        }>;
        by: z.ZodString;
        note: z.ZodString;
    }, z.core.$strict>;
    /** Plan review: the recorded decisions the plan contradicts without arguing against them (empty: it passed). */
    readonly 'plan.reviewed': z.ZodObject<{
        issue: z.ZodNumber;
        contradictions: z.ZodArray<z.ZodObject<{
            ref: z.ZodString;
            why: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    /** A plan sent back to the planner: refused by the plan contract check, or by plan review. */
    readonly 'plan.sent_back': z.ZodObject<{
        issue: z.ZodNumber;
        by: z.ZodEnum<{
            review: "review";
            contract: "contract";
        }>;
        why: z.ZodString;
        round: z.ZodNumber;
    }, z.core.$strict>;
    /** The owner (or a writer) objected to a plan that was built at once: the task stopped. */
    readonly 'plan.objected': z.ZodObject<{
        issue: z.ZodNumber;
        by: z.ZodString;
        why: z.ZodString;
    }, z.core.$strict>;
    /** A writer corrected the harness (a rejected PR or landing, a revised or rejected plan, a review asking for changes, a chat correction): recorded once per source. */
    readonly 'correction.recorded': z.ZodObject<{
        key: z.ZodString;
        kind: z.ZodEnum<{
            pr_rejected: "pr_rejected";
            land_rejected: "land_rejected";
            plan_revised: "plan_revised";
            plan_rejected: "plan_rejected";
            review_changes: "review_changes";
            chat: "chat";
        }>;
        issue: z.ZodNullable<z.ZodNumber>;
        pr: z.ZodNullable<z.ZodNumber>;
        by: z.ZodString;
        text: z.ZodString;
    }, z.core.$strict>;
    /** The corrections agent's durable fix, filed as an issue the pipeline builds into a reviewed PR. */
    readonly 'correction.proposed': z.ZodObject<{
        key: z.ZodString;
        fix_kind: z.ZodEnum<{
            check: "check";
            rule: "rule";
            impossible: "impossible";
            style: "style";
        }>;
        issue: z.ZodNumber;
        title: z.ZodString;
        why: z.ZodString;
    }, z.core.$strict>;
    /** A correction that repeats an earlier one: grouped with it, never proposed twice. `how`: same words, or the agent. */
    readonly 'correction.grouped': z.ZodObject<{
        key: z.ZodString;
        same_as: z.ZodString;
        how: z.ZodEnum<{
            "same words": "same words";
            "the agent": "the agent";
        }>;
    }, z.core.$strict>;
    /** No durable fix: the agent found none (why), or the run failed (failed: true; it isn't retried). */
    readonly 'correction.no_fix': z.ZodObject<{
        key: z.ZodString;
        why: z.ZodString;
        failed: z.ZodBoolean;
    }, z.core.$strict>;
    /** WHY: item 33 (src/learnings.ts). `stage` null: code couldn't tell; the weekly judge's label joins by `run`. */
    readonly 'learning.noted': z.ZodObject<{
        key: z.ZodString;
        issue: z.ZodNumber;
        role: z.ZodString;
        attempt: z.ZodNullable<z.ZodNumber>;
        run: z.ZodNullable<z.ZodString>;
        outcome: z.ZodString;
        stage: z.ZodNullable<z.ZodEnum<{
            "wrong files": "wrong files";
            "right files, wrong place": "right files, wrong place";
            "wrong or incomplete change": "wrong or incomplete change";
            verification: "verification";
            "environment/harness": "environment/harness";
        }>>;
        cause: z.ZodString;
        fingerprint: z.ZodString;
        same_as: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    readonly 'learning.promote_requested': z.ZodObject<{
        fingerprint: z.ZodString;
        line: z.ZodString;
        by: z.ZodString;
    }, z.core.$strict>;
    /** WHY: `pr` null: nothing was filed, and `detail` says why (the owner may promote again). */
    readonly 'learning.promoted': z.ZodObject<{
        fingerprint: z.ZodString;
        line: z.ZodString;
        by: z.ZodString;
        pr: z.ZodNullable<z.ZodString>;
        number: z.ZodNullable<z.ZodNumber>;
        detail: z.ZodString;
    }, z.core.$strict>;
    /** Gradual delegation: a harness PR merged; its review categories and whether it merged as proposed (no writer correction on it, no one else's push). */
    readonly 'delegation.observed': z.ZodObject<{
        pr: z.ZodNumber;
        issue: z.ZodNumber;
        categories: z.ZodArray<z.ZodString>;
        unchanged: z.ZodBoolean;
    }, z.core.$strict>;
    /** A category put to the owner: loosen (a clean record) or tighten (loosened, then a revert, red main or later fix). */
    readonly 'delegation.suggested': z.ZodObject<{
        category: z.ZodString;
        direction: z.ZodEnum<{
            loosen: "loosen";
            tighten: "tighten";
        }>;
        decision: z.ZodString;
        receipts: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    /** The owner's answer; loosen or tighten files the review.yaml change as an issue (built into a PR they review). */
    readonly 'delegation.decided': z.ZodObject<{
        category: z.ZodString;
        decision: z.ZodString;
        answer: z.ZodString;
        by: z.ZodString;
        issue: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strict>;
    /** A constraint seen min_sightings+ times got its proposal: a draft PR (a check), or an issue (a protected area). `keys`: its sightings then. */
    readonly 'feedback_check.proposed': z.ZodObject<{
        constraint: z.ZodString;
        keys: z.ZodArray<z.ZodString>;
        kind: z.ZodEnum<{
            pr: "pr";
            issue: "issue";
        }>;
        number: z.ZodNumber;
        url: z.ZodString;
        mode: z.ZodEnum<{
            test: "test";
            issue: "issue";
            "ast-grep": "ast-grep";
        }>;
        why: z.ZodString;
    }, z.core.$strict>;
    /** No proposal for it: no check fits (failed: false), or the drafting run or its draft failed (failed: true). Tried again only on a new sighting. */
    readonly 'feedback_check.dropped': z.ZodObject<{
        constraint: z.ZodString;
        keys: z.ZodArray<z.ZodString>;
        why: z.ZodString;
        failed: z.ZodBoolean;
    }, z.core.$strict>;
    /**
     * One weekly optimization pass (src/coordinator/optimize.ts; started_at by the coordinator's clock): the target it
     * picked, main's numbers (baseline), and the task it filed; outcome: `filed`, or why it stopped.
     */
    readonly 'optimize.pass': z.ZodObject<{
        started_at: z.ZodString;
        target: z.ZodNullable<z.ZodString>;
        unit: z.ZodDefault<z.ZodString>;
        lower_is_better: z.ZodDefault<z.ZodBoolean>;
        issue: z.ZodNullable<z.ZodNumber>;
        baseline: z.ZodNullable<z.ZodObject<{
            sha: z.ZodString;
            runs: z.ZodArray<z.ZodNumber>;
            median: z.ZodNumber;
            mad: z.ZodNumber;
        }, z.core.$strict>>;
        outcome: z.ZodString;
    }, z.core.$strict>;
    /**
     * An optimization task measured on its change (head): `improved` becomes the PR (its numbers in the body);
     * `discarded` is closed with why (no improvement, within the noise, the benchmark failed, or the week's budget).
     */
    readonly 'optimize.result': z.ZodObject<{
        issue: z.ZodNumber;
        target: z.ZodString;
        head: z.ZodNullable<z.ZodString>;
        outcome: z.ZodEnum<{
            improved: "improved";
            discarded: "discarded";
        }>;
        why: z.ZodString;
        before: z.ZodNullable<z.ZodObject<{
            sha: z.ZodString;
            runs: z.ZodArray<z.ZodNumber>;
            median: z.ZodNumber;
            mad: z.ZodNumber;
        }, z.core.$strict>>;
        after: z.ZodNullable<z.ZodObject<{
            sha: z.ZodString;
            runs: z.ZodArray<z.ZodNumber>;
            median: z.ZodNumber;
            mad: z.ZodNumber;
        }, z.core.$strict>>;
        gain: z.ZodNullable<z.ZodNumber>;
        pct: z.ZodNullable<z.ZodNumber>;
        noise: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strict>;
    /** A gardener finding: a pattern and the places it was seen (from the run or the event log's signals). */
    readonly 'gardener.finding': z.ZodObject<{
        pattern: z.ZodString;
        kind: z.ZodEnum<{
            dead_code: "dead_code";
            duplication: "duplication";
            rule_violation: "rule_violation";
            hotspot: "hotspot";
            slow_check: "slow_check";
            flaky_check: "flaky_check";
        }>;
        where: z.ZodArray<z.ZodString>;
        detail: z.ZodString;
    }, z.core.$strict>;
    /** A gardener fix filed (an issue the pipeline builds into a reviewed PR): once per pattern. */
    readonly 'gardener.filed': z.ZodObject<{
        pattern: z.ZodString;
        issue: z.ZodNumber;
    }, z.core.$strict>;
    /** One gardener run (started_at: by the coordinator's clock): what it found and filed, what it cost, its log issue; outcome: done, or why it stopped. */
    readonly 'gardener.run': z.ZodObject<{
        started_at: z.ZodString;
        findings: z.ZodNumber;
        filed: z.ZodArray<z.ZodNumber>;
        cost_usd: z.ZodNumber;
        log_issue: z.ZodNullable<z.ZodNumber>;
        outcome: z.ZodString;
    }, z.core.$strict>;
    /** An automation's definition changed (src/automations/store.ts): who, how, and each changed field (never a secret). system: the engine paused it. */
    readonly 'automation.changed': z.ZodObject<{
        id: z.ZodString;
        action: z.ZodEnum<{
            pause: "pause";
            resume: "resume";
            delete: "delete";
            create: "create";
            edit: "edit";
            rotate: "rotate";
            unbind: "unbind";
        }>;
        by: z.ZodString;
        role: z.ZodEnum<{
            owner: "owner";
            writer: "writer";
            system: "system";
        }>;
        changes: z.ZodArray<z.ZodString>;
        why: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    /** A person asked the dashboard to run an automation now; the coordinator takes it on its next pass. */
    readonly 'automation.run_requested': z.ZodObject<{
        id: z.ZodString;
        by: z.ZodString;
        role: z.ZodEnum<{
            owner: "owner";
            writer: "writer";
            viewer: "viewer";
        }>;
    }, z.core.$strict>;
    /**
     * An automation fired: its run id, what started it (kind, its reference: an issue or PR number, a slot, a chat
     * message's id; who), and its place in a chain (depth 0: a person, a schedule or a chat command; ancestors: the
     * automations whose output led here, oldest first).
     */
    readonly 'automation.fired': z.ZodObject<{
        id: z.ZodString;
        run: z.ZodString;
        mode: z.ZodEnum<{
            report: "report";
            task: "task";
        }>;
        trigger: z.ZodObject<{
            kind: z.ZodEnum<{
                manual: "manual";
                schedule: "schedule";
                github: "github";
                discord: "discord";
                webhook: "webhook";
            }>;
            ref: z.ZodNullable<z.ZodString>;
            by: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>;
        depth: z.ZodNumber;
        ancestors: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    /** A trigger that didn't fire its automation, and why (a cap, the chain rules, a role, paused, off). */
    readonly 'automation.refused': z.ZodObject<{
        id: z.ZodString;
        trigger: z.ZodEnum<{
            manual: "manual";
            schedule: "schedule";
            github: "github";
            discord: "discord";
            webhook: "webhook";
        }>;
        ref: z.ZodNullable<z.ZodString>;
        why: z.ZodString;
    }, z.core.$strict>;
    /** What a run made: the issue it filed (task), or the issue or PR it commented on (report). Chains are traced through these, never through text on GitHub. */
    readonly 'automation.output': z.ZodObject<{
        id: z.ZodString;
        run: z.ZodString;
        kind: z.ZodEnum<{
            issue: "issue";
            comment: "comment";
        }>;
        number: z.ZodNumber;
    }, z.core.$strict>;
    /** A run finished (a report's run; a task's filing): its outcome and what it cost (a task's builds are booked to its issue). */
    readonly 'automation.done': z.ZodObject<{
        id: z.ZodString;
        run: z.ZodString;
        outcome: z.ZodString;
        cost_usd: z.ZodNumber;
    }, z.core.$strict>;
    /**
     * A webhook delivery the instance accepted (src/automations/webhook.ts): signed with the automation's secret, fresh,
     * never seen, from its bound node. `text`: the body, redacted and cut (untrusted data). The coordinator turns it
     * into an approval decision; nothing runs before an owner approves.
     */
    readonly 'automation.webhook': z.ZodObject<{
        id: z.ZodString;
        delivery: z.ZodString;
        node: z.ZodObject<{
            id: z.ZodString;
            name: z.ZodString;
        }, z.core.$strict>;
        text: z.ZodString;
    }, z.core.$strict>;
    /**
     * A fire waiting for its owner's approval (gates.start: approve): the decision asked, and what fires on approve (the
     * trigger, its chain place, its text and target as they were). Resolved once by automation.resolved.
     */
    readonly 'automation.pending': z.ZodObject<{
        id: z.ZodString;
        decision: z.ZodString;
        trigger: z.ZodObject<{
            kind: z.ZodEnum<{
                manual: "manual";
                schedule: "schedule";
                github: "github";
                discord: "discord";
                webhook: "webhook";
            }>;
            ref: z.ZodNullable<z.ZodString>;
            by: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>;
        depth: z.ZodNumber;
        ancestors: z.ZodArray<z.ZodString>;
        source: z.ZodNullable<z.ZodString>;
        text: z.ZodNullable<z.ZodString>;
        target: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strict>;
    /** How a pending fire ended: approved (and then fired or refused by the caps then), rejected, or expired unanswered. */
    readonly 'automation.resolved': z.ZodObject<{
        id: z.ZodString;
        decision: z.ZodString;
        outcome: z.ZodEnum<{
            rejected: "rejected";
            expired: "expired";
            approved: "approved";
        }>;
        by: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    /** The GitHub poller is holding off (the rate limit is under its floor, or GitHub said to wait), once per hold. */
    readonly 'automation.poll_held': z.ZodObject<{
        why: z.ZodString;
        until: z.ZodString;
    }, z.core.$strict>;
    /** One superfan pass (src/superfan/): the instance's or the machine's; what it read, what it did, what it cost, today's spend. Notes: what it couldn't read. */
    readonly 'superfan.pass': z.ZodObject<{
        scope: z.ZodEnum<{
            machine: "machine";
            instance: "instance";
        }>;
        outcome: z.ZodEnum<{
            budget: "budget";
            failed: "failed";
            quiet: "quiet";
            nothing: "nothing";
            posted: "posted";
            duplicate: "duplicate";
            instance_budget: "instance_budget";
        }>;
        items: z.ZodNumber;
        cost_usd: z.ZodNumber;
        spent_usd: z.ZodNumber;
        filed: z.ZodNullable<z.ZodNumber>;
        notes: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    /** `role`: answered on the dashboard by someone it read as an owner or writer of the instance's repo. */
    readonly 'decision.answered': z.ZodObject<{
        id: z.ZodString;
        by: z.ZodString;
        answer: z.ZodString;
        role: z.ZodOptional<z.ZodEnum<{
            owner: "owner";
            writer: "writer";
        }>>;
    }, z.core.$strict>;
    /** An ask, as created. A paste_secret ask names the credential only; its value is never in any event. */
    readonly 'ask.created': z.ZodObject<{
        id: z.ZodString;
        instance: z.ZodString;
        title: z.ZodString;
        detail: z.ZodString;
        created_by: z.ZodString;
        spec: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"paste_secret">;
            credential: z.ZodString;
            where: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"approve_link">;
            url: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"question">;
            options: z.ZodArray<z.ZodString>;
            writers_may_answer: z.ZodBoolean;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"root_step">;
            command: z.ZodString;
            args: z.ZodArray<z.ZodString>;
        }, z.core.$strict>], "kind">;
    }, z.core.$strict>;
    /** An ask's one answer: who (and in what role), and the outcome; for a secret only that it was stored. */
    readonly 'ask.answered': z.ZodObject<{
        id: z.ZodString;
        by: z.ZodString;
        role: z.ZodEnum<{
            owner: "owner";
            writer: "writer";
        }>;
        answer: z.ZodString;
        detail: z.ZodString;
    }, z.core.$strict>;
    /** An ask withdrawn before it was answered (by whatever created it, or the owner). */
    readonly 'ask.cancelled': z.ZodObject<{
        id: z.ZodString;
        by: z.ZodString;
        why: z.ZodString;
    }, z.core.$strict>;
    /** A machine helper command the owner asked for from the dashboard (Settings, or a root-step ask), for the coordinator to run. */
    readonly 'machine.requested': z.ZodObject<{
        id: z.ZodString;
        args: z.ZodArray<z.ZodString>;
        by: z.ZodString;
        via: z.ZodEnum<{
            ask: "ask";
            "add-project": "add-project";
            "claude-account": "claude-account";
            tailscale: "tailscale";
            settings: "settings";
            plugins: "plugins";
        }>;
        ask: z.ZodNullable<z.ZodString>;
        breakGlass: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>;
    /** The coordinator took a request (once: claimed in a write transaction). */
    readonly 'machine.started': z.ZodObject<{
        id: z.ZodString;
        instance: z.ZodString;
    }, z.core.$strict>;
    /** How it ended: done (detail: the helper's output), failed, refused (off the allowlist), interrupted (not re-run). */
    readonly 'machine.finished': z.ZodObject<{
        id: z.ZodString;
        outcome: z.ZodEnum<{
            done: "done";
            failed: "failed";
            refused: "refused";
            interrupted: "interrupted";
        }>;
        detail: z.ZodString;
    }, z.core.$strict>;
    /**
     * One step of add-project.sh, as the coordinator relays its line (src/console/add-project.ts): the machine
     * request it belongs to, the step (instance, app, claude-token, checkout, policy, service, test-user,
     * machine-helper, dashboards) and how it stands: started, done (or skipped as done already), failed (detail: why,
     * and the retry), or ask (waiting on the owner). Never a key or a token: the script prints none.
     */
    readonly 'add_project.step': z.ZodObject<{
        request_id: z.ZodString;
        name: z.ZodString;
        repo: z.ZodString;
        step: z.ZodEnum<{
            instance: "instance";
            app: "app";
            "claude-token": "claude-token";
            checkout: "checkout";
            policy: "policy";
            service: "service";
            "test-user": "test-user";
            "machine-helper": "machine-helper";
            dashboards: "dashboards";
        }>;
        state: z.ZodEnum<{
            ask: "ask";
            done: "done";
            failed: "failed";
            started: "started";
            waiting: "waiting";
        }>;
        detail: z.ZodString;
        ask: z.ZodOptional<z.ZodString>;
        retry: z.ZodOptional<z.ZodString>;
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
            red: "red";
            rejected: "rejected";
            landed: "landed";
            pr_opened: "pr_opened";
            conflict: "conflict";
            deferred: "deferred";
        }>;
        landed: z.ZodNullable<z.ZodString>;
        detail: z.ZodString;
    }, z.core.$strict>;
    /** PR mode: a pull request the harness opened, and its watch. */
    readonly 'pr.opened': z.ZodObject<{
        issue: z.ZodNumber;
        number: z.ZodNumber;
        url: z.ZodString;
        head: z.ZodString;
        draft: z.ZodBoolean;
    }, z.core.$strict>;
    readonly 'pr.status': z.ZodObject<{
        issue: z.ZodNumber;
        number: z.ZodNumber;
        head: z.ZodString;
        ready: z.ZodBoolean;
        reasons: z.ZodArray<z.ZodString>;
        checks: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            outcome: z.ZodEnum<{
                missing: "missing";
                pass: "pass";
                fail: "fail";
                skipped: "skipped";
                pending: "pending";
                cancelled: "cancelled";
            }>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    /** The PR's size and conversation as GitHub reports them at `head` (lines added and removed, files, comments and review comments), recorded when they change. */
    readonly 'pr.stats': z.ZodObject<{
        issue: z.ZodNumber;
        number: z.ZodNumber;
        head: z.ZodString;
        additions: z.ZodNumber;
        deletions: z.ZodNumber;
        files: z.ZodNumber;
        comments: z.ZodNumber;
    }, z.core.$strict>;
    readonly 'pr.ready': z.ZodObject<{
        issue: z.ZodNumber;
        number: z.ZodNumber;
        head: z.ZodString;
    }, z.core.$strict>;
    readonly 'pr.unready': z.ZodObject<{
        issue: z.ZodNumber;
        number: z.ZodNumber;
        head: z.ZodString;
        why: z.ZodString;
    }, z.core.$strict>;
    readonly 'pr.closed': z.ZodObject<{
        issue: z.ZodNumber;
        number: z.ZodNumber;
        merged: z.ZodBoolean;
    }, z.core.$strict>;
    /**
     * A fix run on a PR at `head`: a required check failed, or (`reviews`, their ids) a writer's review asked for
     * changes or commented. Both count toward roles.ci_repair.max_fixes_per_pr. `lease` is its claim.
     */
    readonly 'ci_fix.started': z.ZodObject<{
        issue: z.ZodNumber;
        number: z.ZodNumber;
        head: z.ZodString;
        checks: z.ZodArray<z.ZodString>;
        attempt: z.ZodNumber;
        lease: z.ZodString;
        reviews: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
    }, z.core.$strict>;
    /** Writers' reviews on a harness PR that get no fix run (the cap, runs off, someone else's push): recorded once, the owner told why. */
    readonly 'review_fix.declined': z.ZodObject<{
        issue: z.ZodNumber;
        number: z.ZodNumber;
        reviews: z.ZodArray<z.ZodNumber>;
        reason: z.ZodString;
    }, z.core.$strict>;
    /** pushed: a fix is on the branch at `head`; no_push: it ended without one (ci_fix.gave_up says why); interrupted: the coordinator restarted. */
    readonly 'ci_fix.finished': z.ZodObject<{
        issue: z.ZodNumber;
        number: z.ZodNumber;
        outcome: z.ZodEnum<{
            interrupted: "interrupted";
            pushed: "pushed";
            no_push: "no_push";
            claim_lost: "claim_lost";
        }>;
        head: z.ZodNullable<z.ZodString>;
        detail: z.ZodString;
    }, z.core.$strict>;
    /** An eval of instructions the change touches, base vs head (base null: new instructions). `error`: it couldn't run. */
    readonly 'instructions.eval': z.ZodObject<{
        issue: z.ZodNumber;
        head: z.ZodString;
        target: z.ZodString;
        base: z.ZodNullable<z.ZodObject<{
            passed: z.ZodNumber;
            total: z.ZodNumber;
        }, z.core.$strict>>;
        result: z.ZodNullable<z.ZodObject<{
            passed: z.ZodNumber;
            total: z.ZodNumber;
        }, z.core.$strict>>;
        dropped: z.ZodBoolean;
        incomplete: z.ZodBoolean;
        changes: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            title: z.ZodString;
            base: z.ZodString;
            head: z.ZodString;
        }, z.core.$strict>>;
        cost_usd: z.ZodNumber;
        error: z.ZodOptional<z.ZodString>;
        samples: z.ZodOptional<z.ZodNumber>;
        held_out: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            base: z.ZodNullable<z.ZodObject<{
                passed: z.ZodNumber;
                total: z.ZodNumber;
            }, z.core.$strict>>;
            result: z.ZodObject<{
                passed: z.ZodNumber;
                total: z.ZodNumber;
            }, z.core.$strict>;
            dropped: z.ZodBoolean;
            incomplete: z.ZodBoolean;
            changes: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                title: z.ZodString;
                base: z.ZodString;
                head: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>>>;
        held_out_error: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    /** The merge policy's call on a ready PR at `head`: merge it (auto) or wait for a human, and why. */
    readonly 'merge.decided': z.ZodObject<{
        issue: z.ZodNumber;
        number: z.ZodNumber;
        head: z.ZodString;
        auto: z.ZodBoolean;
        reasons: z.ZodArray<z.ZodString>;
        why: z.ZodOptional<z.ZodArray<z.ZodObject<{
            category: z.ZodString;
            text: z.ZodString;
        }, z.core.$strict>>>;
    }, z.core.$strict>;
    /** Auto-merged: a merge commit `sha` of the evaluated `head`. */
    /**
     * An owner approved a PR the merge policy left to them, at this head (from a Discord thread: `via`): it merges on
     * the PR watch's next pass through the normal merge path, if its checks are still green on this head and
     * auto-merge isn't stopped. The first approval at a head stands.
     */
    readonly 'merge.approved': z.ZodObject<{
        issue: z.ZodNumber;
        number: z.ZodNumber;
        head: z.ZodString;
        by: z.ZodString;
        via: z.ZodEnum<{
            discord: "discord";
        }>;
    }, z.core.$strict>;
    readonly 'merge.done': z.ZodObject<{
        issue: z.ZodNumber;
        number: z.ZodNumber;
        head: z.ZodString;
        sha: z.ZodString;
        url: z.ZodString;
        title: z.ZodString;
    }, z.core.$strict>;
    readonly 'merge.failed': z.ZodObject<{
        issue: z.ZodNumber;
        number: z.ZodNumber;
        head: z.ZodString;
        why: z.ZodString;
    }, z.core.$strict>;
    /**
     * The merge train (src/merge-policy-train.ts) put off merging PR `number` at `head` until `retry_at`: GitHub requires
     * it up to date with its base (strict protection), or its base moved under the merge. Not a failure and not the
     * owner's call; tried again then, with a growing backoff.
     */
    readonly 'merge.deferred': z.ZodObject<{
        issue: z.ZodNumber;
        number: z.ZodNumber;
        head: z.ZodString;
        why: z.ZodString;
        retry_at: z.ZodString;
    }, z.core.$strict>;
    /** The default branch's required checks on an auto-merge's commit. */
    /** timed_out: some required check never reported on the merge commit (`failed` names them); the owner is told. */
    /**
     * The default branch's required checks on an auto-merge's commit. `flaky`: failed, then passed on a re-run of the
     * same commit; `quarantined`: failed, but quarantined as flaky (src/flaky.ts). Neither turns it red for the harness.
     */
    readonly 'merge.main_result': z.ZodObject<{
        issue: z.ZodNumber;
        number: z.ZodNumber;
        sha: z.ZodString;
        outcome: z.ZodEnum<{
            red: "red";
            timed_out: "timed_out";
            green: "green";
        }>;
        failed: z.ZodArray<z.ZodString>;
        flaky: z.ZodOptional<z.ZodArray<z.ZodString>>;
        quarantined: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>;
    /** A wait reached its cap (coordinator/wait-caps.ts): recorded, the owner told, and it waits for them. `number`: the PR, if any. */
    readonly 'wait.capped': z.ZodObject<{
        issue: z.ZodNumber;
        number: z.ZodNullable<z.ZodNumber>;
        kind: z.ZodEnum<{
            deferred_landing: "deferred_landing";
            mergeable_recheck: "mergeable_recheck";
            light_check_pending: "light_check_pending";
            main_checks: "main_checks";
        }>;
        detail: z.ZodString;
    }, z.core.$strict>;
    /** Auto-merge stopped for this instance (until the operator clears it); `revert` is the revert PR, if one was opened. */
    readonly 'merge.stopped': z.ZodObject<{
        reason: z.ZodString;
        number: z.ZodNullable<z.ZodNumber>;
        sha: z.ZodNullable<z.ZodString>;
        revert: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    readonly 'merge.resumed': z.ZodObject<{
        detail: z.ZodString;
    }, z.core.$strict>;
    /**
     * Main watch (src/main-watch.ts): how the default branch is guarded. github: GitHub enforces its protection;
     * main_watch: GitHub doesn't, and the watch checks every new commit; off: neither (`detail` says why).
     */
    readonly 'main_watch.mode': z.ZodObject<{
        mode: z.ZodEnum<{
            off: "off";
            github: "github";
            main_watch: "main_watch";
        }>;
        detail: z.ZodString;
    }, z.core.$strict>;
    /** A commit on the default branch, accounted for: the harness's merge, or a mapped admin's or writer's, green at merge time. */
    readonly 'main_watch.checked': z.ZodObject<{
        sha: z.ZodString;
        how: z.ZodEnum<{
            harness: "harness";
            person: "person";
        }>;
        number: z.ZodNumber;
    }, z.core.$strict>;
    /**
     * A commit on the default branch an admin accepted as a bootstrap merge before the watch judged it (by its sha, or
     * by its PR's number and head; src/main-watch.ts acceptMerge): accounted, with no stop, alert or revert PR.
     */
    readonly 'main_watch.accepted': z.ZodObject<{
        sha: z.ZodString;
        how: z.ZodLiteral<"accepted">;
        number: z.ZodNullable<z.ZodNumber>;
        id: z.ZodString;
        by: z.ZodString;
        reason: z.ZodString;
    }, z.core.$strict>;
    /**
     * A commit on the default branch nothing accounts for (a direct push, a merge with checks not green, an unknown
     * actor, a rewritten history): auto-merge is stopped, the owner alerted, and `revert` is the revert PR, if any.
     */
    readonly 'main_watch.unaccounted': z.ZodObject<{
        sha: z.ZodString;
        url: z.ZodString;
        reason: z.ZodString;
        number: z.ZodNullable<z.ZodNumber>;
        revert: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    /**
     * An unaccounted commit that landed without a PR (src/direct-push-alert.ts): `direct`, GitHub's commit-to-PR link
     * has no merged PR for it; `rewrite`, a force-push. `pusher`: a GitHub login only (`pusher_from`: the push's actor,
     * or the commit's author when the push's isn't known). `alert`: whether it is posted to the ops channel
     * (config.yaml main_watch.direct_push_alert as committed before it).
     */
    readonly 'main_watch.direct_push': z.ZodObject<{
        sha: z.ZodString;
        url: z.ZodString;
        kind: z.ZodEnum<{
            direct: "direct";
            rewrite: "rewrite";
        }>;
        pusher: z.ZodNullable<z.ZodString>;
        pusher_from: z.ZodNullable<z.ZodEnum<{
            commit: "commit";
            activity: "activity";
        }>>;
        subject: z.ZodString;
        alert: z.ZodBoolean;
    }, z.core.$strict>;
    /** Its ops-channel post: sent (`ok`), how many owners it mentioned, and `note`: why nobody was, or why it wasn't sent. */
    readonly 'main_watch.direct_push_alert': z.ZodObject<{
        sha: z.ZodString;
        ok: z.ZodBoolean;
        mentioned: z.ZodNumber;
        note: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    /** No more fix runs on this PR; the owner is asked to look. */
    /** The combined-state check started: the default branch moved and touched what this PR touches (overlap). */
    readonly 'light_check.started': z.ZodObject<{
        issue: z.ZodNumber;
        number: z.ZodNumber;
        head: z.ZodString;
        main_sha: z.ZodString;
        overlap: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    /** merge: the fast tier passed on the combination; hold: it failed (a human decides); conflict: they don't merge. */
    readonly 'light_check.finished': z.ZodObject<{
        issue: z.ZodNumber;
        number: z.ZodNumber;
        head: z.ZodString;
        main_sha: z.ZodString;
        overlap: z.ZodArray<z.ZodString>;
        outcome: z.ZodEnum<{
            merge: "merge";
            conflict: "conflict";
            hold: "hold";
        }>;
        wait_ms: z.ZodNumber;
        detail: z.ZodString;
    }, z.core.$strict>;
    /** GitHub reports a harness PR as conflicting with its base (recorded once per head). */
    readonly 'conflict_fix.detected': z.ZodObject<{
        issue: z.ZodNumber;
        number: z.ZodNumber;
        head: z.ZodString;
        base_sha: z.ZodString;
    }, z.core.$strict>;
    readonly 'conflict_fix.started': z.ZodObject<{
        issue: z.ZodNumber;
        number: z.ZodNumber;
        head: z.ZodString;
        base_sha: z.ZodString;
        strategy: z.ZodLiteral<"merge">;
        attempt: z.ZodNumber;
        lease: z.ZodString;
    }, z.core.$strict>;
    /**
     * How a conflict fix ended. pushed: the resolved branch is on the PR (head); waits_owner and reasons: why it
     * then waits for a human. gave_up: no (more) fixes, the owner is asked. interrupted: a restart cut it short.
     */
    readonly 'conflict_fix.finished': z.ZodObject<{
        issue: z.ZodNumber;
        number: z.ZodNumber;
        base_sha: z.ZodNullable<z.ZodString>;
        strategy: z.ZodLiteral<"merge">;
        outcome: z.ZodEnum<{
            gave_up: "gave_up";
            interrupted: "interrupted";
            pushed: "pushed";
            no_push: "no_push";
            claim_lost: "claim_lost";
        }>;
        head: z.ZodNullable<z.ZodString>;
        files: z.ZodArray<z.ZodString>;
        waits_owner: z.ZodBoolean;
        reasons: z.ZodArray<z.ZodString>;
        detail: z.ZodString;
    }, z.core.$strict>;
    readonly 'ci_fix.gave_up': z.ZodObject<{
        issue: z.ZodNumber;
        number: z.ZodNumber;
        head: z.ZodString;
        reason: z.ZodString;
    }, z.core.$strict>;
    /** The default branch (base_sha) merged into a stale PR and pushed to its branch: `from` the head before, `head` the merge commit. */
    readonly 'pr_hygiene.merged_in': z.ZodObject<{
        issue: z.ZodNumber;
        number: z.ZodNumber;
        from: z.ZodString;
        head: z.ZodString;
        base_sha: z.ZodString;
        base_days: z.ZodNumber;
    }, z.core.$strict>;
    /** An abandoned PR closed with a comment (its branch kept): its task closed or superseded, and no activity for a while. */
    readonly 'pr_hygiene.closed': z.ZodObject<{
        issue: z.ZodNumber;
        number: z.ZodNumber;
        head: z.ZodString;
        why: z.ZodString;
    }, z.core.$strict>;
    /** One pass: how many PRs got the default branch merged in, conflict, were closed, were held for an owner, or skipped; each PR's result. */
    readonly 'pr_hygiene.pass': z.ZodObject<{
        merged_in: z.ZodNumber;
        conflicting: z.ZodNumber;
        closed: z.ZodNumber;
        held: z.ZodNumber;
        skipped: z.ZodNumber;
        prs: z.ZodArray<z.ZodObject<{
            number: z.ZodNumber;
            outcome: z.ZodEnum<{
                closed: "closed";
                held: "held";
                skipped: "skipped";
                merged_in: "merged_in";
                conflicting: "conflicting";
            }>;
            why: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    readonly 'land.batch': z.ZodObject<{
        id: z.ZodString;
        issues: z.ZodArray<z.ZodNumber>;
        tip: z.ZodString;
        outcome: z.ZodEnum<{
            split: "split";
            red: "red";
            started: "started";
            landed: "landed";
            deferred: "deferred";
        }>;
        detail: z.ZodString;
    }, z.core.$strict>;
    /**
     * PR mode with batching (coordinator/pr-batch.ts): a PR ready on its fast checks waits, at this head, for a batch.
     * `by`: a person's PR (a mapped admin or writer opened it, not the harness): `issue` is then the PR's own number,
     * and the harness never merges it.
     */
    readonly 'pr_batch.queued': z.ZodObject<{
        issue: z.ZodNumber;
        number: z.ZodNumber;
        head: z.ZodString;
        by: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
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
    readonly 'pr_batch.step': z.ZodObject<{
        id: z.ZodString;
        step: z.ZodEnum<{
            error: "error";
            red: "red";
            resumed: "resumed";
            dropped: "dropped";
            conflict: "conflict";
            green: "green";
            built: "built";
            checks_posted: "checks_posted";
            culprit: "culprit";
            requeued: "requeued";
            abandoned: "abandoned";
            finished: "finished";
            stale: "stale";
            gpu_held: "gpu_held";
        }>;
        prs: z.ZodArray<z.ZodObject<{
            issue: z.ZodNumber;
            number: z.ZodNumber;
            head: z.ZodString;
            by: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        sha: z.ZodNullable<z.ZodString>;
        base: z.ZodNullable<z.ZodString>;
        parent: z.ZodNullable<z.ZodString>;
        tier: z.ZodNullable<z.ZodString>;
        run: z.ZodNullable<z.ZodObject<{
            id: z.ZodString;
            ok: z.ZodBoolean;
            tiers: z.ZodArray<z.ZodObject<{
                tier: z.ZodString;
                ok: z.ZodBoolean;
                durationMs: z.ZodNumber;
                summary: z.ZodString;
                logRef: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        detail: z.ZodString;
        trees: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>;
    /** `issue`: the issue whose landing triggered it (absent on older events and manual deploys). */
    readonly 'deploy.requested': z.ZodObject<{
        env: z.ZodString;
        sha: z.ZodString;
        issue: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
    readonly 'deploy.verified': z.ZodObject<{
        env: z.ZodString;
        sha: z.ZodString;
        issue: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
    readonly 'deploy.failed': z.ZodObject<{
        env: z.ZodString;
        sha: z.ZodString;
        why: z.ZodString;
        issue: z.ZodOptional<z.ZodNumber>;
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
    /** A task started in a worktree from the pool (worktree-pool.ts), not a fresh one: this claim's worktree is `name`. */
    readonly 'worktree.pooled': z.ZodObject<{
        issue: z.ZodNumber;
        name: z.ZodString;
    }, z.core.$strict>;
    /** The worktree pool brought to main's tip: what was made, moved to it with its install kept (setup_key), removed, and setups that failed. */
    readonly 'worktree.pool_refilled': z.ZodObject<{
        base: z.ZodString;
        created: z.ZodArray<z.ZodString>;
        moved: z.ZodDefault<z.ZodArray<z.ZodString>>;
        removed: z.ZodArray<z.ZodString>;
        errors: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    /** At start: state/ closed to other users (paths tightened, first 20 named) and old task files removed. */
    readonly 'state.tidied': z.ZodObject<{
        tightened: z.ZodNumber;
        paths: z.ZodArray<z.ZodString>;
        removed_tasks: z.ZodNumber;
    }, z.core.$strict>;
    /** A shutdown began (SIGTERM, SIGINT): runs in flight are aborted and their tasks requeued; `pending` is what was in flight. */
    readonly 'coordinator.stopping': z.ZodObject<{
        instance: z.ZodString;
        signal: z.ZodString;
        pending: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    /** The shutdown ended: `clean` when everything stopped in time; otherwise `pending` names what was left when it exited anyway. */
    readonly 'coordinator.stopped': z.ZodObject<{
        instance: z.ZodString;
        clean: z.ZodBoolean;
        ms: z.ZodNumber;
        pending: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    readonly 'coordinator.tick': z.ZodObject<{
        instance: z.ZodString;
        dispatched: z.ZodNumber;
        reconciled: z.ZodNumber;
    }, z.core.$strict>;
    readonly 'report.posted': z.ZodObject<{
        day: z.ZodString;
        slot: z.ZodString;
        issue: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strict>;
    /** The daily "waiting on you" digest was posted (`items` waiting, `merged` on their own since the last one). */
    readonly 'digest.posted': z.ZodObject<{
        day: z.ZodString;
        issue: z.ZodNumber;
        items: z.ZodNumber;
        merged: z.ZodNumber;
    }, z.core.$strict>;
    readonly 'emergency.stop': z.ZodObject<{
        by: z.ZodString;
        reason: z.ZodString;
        running: z.ZodNumber;
    }, z.core.$strict>;
    readonly 'emergency.resume': z.ZodObject<{
        instance: z.ZodString;
    }, z.core.$strict>;
    readonly 'nightly.queued': z.ZodObject<{
        day: z.ZodString;
        jobs: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    /** Dispatch holds: `kind` and `facts` (the numbers when it began) say why, for the Board's banner (src/governor-holds.ts); absent on older events. */
    readonly 'governor.hold': z.ZodObject<{
        reason: z.ZodString;
        load: z.ZodNullable<z.ZodNumber>;
        free_disk_pct: z.ZodNullable<z.ZodNumber>;
        kind: z.ZodOptional<z.ZodEnum<{
            budget: "budget";
            load: "load";
            disk: "disk";
            disk_full: "disk_full";
            slots: "slots";
            update_drain: "update_drain";
            usage_limit: "usage_limit";
            sign_in: "sign_in";
            run_window: "run_window";
        }>>;
        facts: z.ZodOptional<z.ZodObject<{
            free_gb: z.ZodOptional<z.ZodNumber>;
            total_gb: z.ZodOptional<z.ZodNumber>;
            floor_gb: z.ZodOptional<z.ZodNumber>;
            floor_min_gb: z.ZodOptional<z.ZodNumber>;
            floor_pct: z.ZodOptional<z.ZodNumber>;
            est_gb: z.ZodOptional<z.ZodNumber>;
            load: z.ZodOptional<z.ZodNumber>;
            max_load: z.ZodOptional<z.ZodNumber>;
            spent_usd: z.ZodOptional<z.ZodNumber>;
            budget_usd: z.ZodOptional<z.ZodNumber>;
            until: z.ZodOptional<z.ZodString>;
            cap: z.ZodOptional<z.ZodNumber>;
            running: z.ZodOptional<z.ZodNumber>;
            windows: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    readonly 'governor.release': z.ZodObject<{
        load: z.ZodNullable<z.ZodNumber>;
        free_disk_pct: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strict>;
    /** A ready task waits: it would change a hotspot file a running task changes too (`by`). Recorded once per wait. */
    readonly 'hotspot.held': z.ZodObject<{
        issue: z.ZodNumber;
        by: z.ZodNumber;
        files: z.ZodArray<z.ZodString>;
        reason: z.ZodString;
    }, z.core.$strict>;
    /** A held task started (or stopped being ready): how long it waited, on which files. */
    readonly 'hotspot.released': z.ZodObject<{
        issue: z.ZodNumber;
        waited_ms: z.ZodNumber;
        files: z.ZodArray<z.ZodString>;
        started: z.ZodBoolean;
    }, z.core.$strict>;
    /** WHY: a ready task whose "Depends on" issues are open (`on`) must not start; recorded once per change of `on` (src/task-graph.ts). */
    readonly 'dependency.held': z.ZodObject<{
        issue: z.ZodNumber;
        on: z.ZodArray<z.ZodNumber>;
        reason: z.ZodString;
    }, z.core.$strict>;
    /** INVARIANT: ends every dependency.held: its dependencies closed (`closed`), or it stopped being ready (`not_ready`). */
    readonly 'dependency.unblocked': z.ZodObject<{
        issue: z.ZodNumber;
        on: z.ZodArray<z.ZodNumber>;
        waited_ms: z.ZodNumber;
        why: z.ZodEnum<{
            closed: "closed";
            not_ready: "not_ready";
        }>;
    }, z.core.$strict>;
    /** WHY: a cycle never unblocks; reported once per cycle so the owner removes an edge. */
    readonly 'dependency.cycle': z.ZodObject<{
        issue: z.ZodNumber;
        cycle: z.ZodArray<z.ZodNumber>;
    }, z.core.$strict>;
    /** WHY: running tasks waiting on each other's files; `proceeds` goes ahead so neither waits forever (src/ownership.ts). */
    readonly 'ownership.deadlock': z.ZodObject<{
        issue: z.ZodNumber;
        cycle: z.ZodArray<z.ZodNumber>;
        files: z.ZodArray<z.ZodString>;
        proceeds: z.ZodNumber;
    }, z.core.$strict>;
    /** WHY: a file claim outlived its task; dropped so no task waits on it forever. */
    readonly 'ownership.stale': z.ZodObject<{
        issue: z.ZodNumber;
        files: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    /** WHY: a goal split into child issues (src/goal-split.ts); `body_hash` lets dispatch trust a child only while its body is as filed. */
    readonly 'goal.split': z.ZodObject<{
        issue: z.ZodNumber;
        summary: z.ZodString;
        children: z.ZodArray<z.ZodObject<{
            number: z.ZodNumber;
            key: z.ZodString;
            depends_on: z.ZodArray<z.ZodNumber>;
            body_hash: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    readonly 'coordinator.error': z.ZodObject<{
        instance: z.ZodString;
        where: z.ZodString;
        kind: z.ZodString;
        message: z.ZodString;
    }, z.core.$strict>;
    readonly 'testrun.queued': z.ZodObject<{
        id: z.ZodString;
        sha: z.ZodString;
        kind: z.ZodEnum<{
            fast: "fast";
            full: "full";
        }>;
        prs: z.ZodArray<z.ZodNumber>;
        shard: z.ZodNullable<z.ZodObject<{
            index: z.ZodNumber;
            total: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    /**
     * It has a slot and the full-run lock (shared); `lock_wait_ms`: how long an exclusive holder kept it waiting. `gpu`:
     * planned when a tier of it asks for the GPU and root's file lists the instance (or can't be read): recorded before
     * any GPU command, so a run cut off by a hung machine is never run again by itself (src/testrun/gpu.ts).
     */
    readonly 'testrun.started': z.ZodObject<{
        id: z.ZodString;
        slot: z.ZodString;
        lock_wait_ms: z.ZodNumber;
        gpu: z.ZodOptional<z.ZodLiteral<"planned">>;
    }, z.core.$strict>;
    /** One tier's outcome. `summary`: the end of its output; `log_ref`: its full log in the instance's state (never a viewer's). */
    readonly 'testrun.tier': z.ZodObject<{
        id: z.ZodString;
        tier: z.ZodString;
        ok: z.ZodBoolean;
        duration_ms: z.ZodNumber;
        summary: z.ZodString;
        log_ref: z.ZodString;
        cpu_s: z.ZodNullable<z.ZodNumber>;
        mem_peak_mb: z.ZodNullable<z.ZodNumber>;
        gpu: z.ZodOptional<z.ZodObject<{
            granted: z.ZodBoolean;
            devices: z.ZodArray<z.ZodString>;
            detail: z.ZodString;
        }, z.core.$strict>>;
        network: z.ZodOptional<z.ZodEnum<{
            granted: "granted";
            none: "none";
        }>>;
    }, z.core.$strict>;
    /** `results`: each tier's pass or fail, all a viewer sees of a run. */
    readonly 'testrun.finished': z.ZodObject<{
        id: z.ZodString;
        sha: z.ZodString;
        kind: z.ZodEnum<{
            fast: "fast";
            full: "full";
        }>;
        prs: z.ZodArray<z.ZodNumber>;
        ok: z.ZodBoolean;
        outcome: z.ZodEnum<{
            error: "error";
            done: "done";
            interrupted: "interrupted";
            cancelled: "cancelled";
        }>;
        results: z.ZodArray<z.ZodObject<{
            tier: z.ZodString;
            ok: z.ZodBoolean;
        }, z.core.$strict>>;
        detail: z.ZodString;
        gpu_stopped: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>;
    /**
     * One tier's per-test durations, read from its output (src/test-durations.ts): its slowest tests (at most 100) and
     * how many it printed durations for in all (0: its runner prints none this reads). For the metrics' slow tests.
     */
    readonly 'testrun.durations': z.ZodObject<{
        id: z.ZodString;
        tier: z.ZodString;
        tests: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            ms: z.ZodNumber;
        }, z.core.$strict>>;
        parsed: z.ZodNumber;
    }, z.core.$strict>;
    readonly 'testrun.wipe_failed': z.ZodObject<{
        id: z.ZodString;
        left: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    readonly 'testrun.checks_posted': z.ZodObject<{
        id: z.ZodString;
        sha: z.ZodString;
        checks: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            conclusion: z.ZodEnum<{
                success: "success";
                cancelled: "cancelled";
                failure: "failure";
            }>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    /** no_permission: the App lacks Checks: write (the owner adds it); the checks were not posted. */
    readonly 'testrun.checks_failed': z.ZodObject<{
        id: z.ZodString;
        sha: z.ZodString;
        reason: z.ZodEnum<{
            error: "error";
            no_permission: "no_permission";
        }>;
        detail: z.ZodString;
    }, z.core.$strict>;
    /** The App's Checks permission on the repo, as GitHub reports it. */
    readonly 'testrun.checks_permission': z.ZodObject<{
        level: z.ZodEnum<{
            unknown: "unknown";
            none: "none";
            write: "write";
            read: "read";
        }>;
        detail: z.ZodString;
    }, z.core.$strict>;
    /** The sandbox's own check (the helper's `check`): no run starts until it passed. */
    readonly 'testrun.sandbox': z.ZodObject<{
        ok: z.ZodBoolean;
        detail: z.ZodString;
    }, z.core.$strict>;
    /**
     * WHY: `<cli> testrun measure` (src/testrun/measure.ts), one tests.yaml test_run env value per sandboxed run. Its own
     * type, never testrun.queued/started/finished: the PR runs, the batcher and the test-run view never read it.
     */
    readonly 'testrun.measure': z.ZodObject<{
        id: z.ZodString;
        sha: z.ZodString;
        key: z.ZodString;
        phase: z.ZodEnum<{
            stopped: "stopped";
            started: "started";
            finished: "finished";
            run_started: "run_started";
            run_finished: "run_finished";
            recovered: "recovered";
        }>;
        value: z.ZodNullable<z.ZodString>;
        run_id: z.ZodNullable<z.ZodString>;
        ok: z.ZodNullable<z.ZodBoolean>;
        wall_ms: z.ZodNullable<z.ZodNumber>;
        tiers: z.ZodArray<z.ZodObject<{
            tier: z.ZodString;
            status: z.ZodEnum<{
                failed: "failed";
                passed: "passed";
                "timed out": "timed out";
                "not run": "not run";
            }>;
            duration_ms: z.ZodNumber;
            cpu_s: z.ZodNullable<z.ZodNumber>;
            mem_peak_mb: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strict>>;
        detail: z.ZodString;
    }, z.core.$strict>;
    /** The gate's tiers ran on a default-branch commit: ok only when every one passed; `failed` names the rest. */
    readonly 'deploy_gate.verdict': z.ZodObject<{
        sha: z.ZodString;
        ok: z.ZodBoolean;
        failed: z.ZodArray<z.ZodString>;
        reason: z.ZodString;
        run: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    /** The deploy branch was fast-forwarded (never forced): by the gate, or by an owner's override (`gate`: its state then). */
    readonly 'deploy_gate.moved': z.ZodObject<{
        branch: z.ZodString;
        from: z.ZodNullable<z.ZodString>;
        to: z.ZodString;
        by: z.ZodString;
        override: z.ZodBoolean;
        gate: z.ZodString;
    }, z.core.$strict>;
    /** A default-branch commit the gate didn't pass: the deploy branch stays at `deployed`. */
    readonly 'deploy_gate.held': z.ZodObject<{
        branch: z.ZodString;
        sha: z.ZodString;
        deployed: z.ZodNullable<z.ZodString>;
        reason: z.ZodString;
    }, z.core.$strict>;
    /** The deploy branch isn't where the gate put it, or not on the default branch's line: nothing moved; an incident is raised. */
    readonly 'deploy_gate.refused': z.ZodObject<{
        branch: z.ZodString;
        deploy: z.ZodNullable<z.ZodString>;
        main: z.ZodString;
        target: z.ZodNullable<z.ZodString>;
        reason: z.ZodString;
    }, z.core.$strict>;
    /** An owner's `deploy <sha>` from Discord: asked (waiting on their confirm), confirmed, cancelled or refused. */
    readonly 'deploy_gate.override': z.ZodObject<{
        id: z.ZodString;
        thread: z.ZodNullable<z.ZodString>;
        sha: z.ZodString;
        by: z.ZodString;
        stage: z.ZodEnum<{
            refused: "refused";
            asked: "asked";
            confirmed: "confirmed";
            cancelled: "cancelled";
        }>;
        detail: z.ZodString;
    }, z.core.$strict>;
    /**
     * The post-deploy check of a commit the deploy branch moved to: passed; failed (a smoke check failed: `rollback` says
     * what was rolled back); timed_out (the host didn't deploy it in time); deploy_failed (the host's deploy of it failed).
     * `snippet` is a redacted piece of a failing response's body; no header or cookie is ever kept. `token`: whether the
     * host's token was stored.
     */
    readonly 'deploy_gate.post_deploy': z.ZodObject<{
        sha: z.ZodString;
        prev: z.ZodNullable<z.ZodString>;
        outcome: z.ZodEnum<{
            failed: "failed";
            timed_out: "timed_out";
            passed: "passed";
            deploy_failed: "deploy_failed";
        }>;
        detail: z.ZodString;
        checks: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            ok: z.ZodBoolean;
            status: z.ZodNullable<z.ZodNumber>;
            ms: z.ZodNumber;
            error: z.ZodNullable<z.ZodString>;
            snippet: z.ZodString;
        }, z.core.$strict>>;
        rollback: z.ZodNullable<z.ZodObject<{
            attempted: z.ZodBoolean;
            ok: z.ZodBoolean;
            detail: z.ZodString;
            services: z.ZodArray<z.ZodObject<{
                service: z.ZodString;
                to: z.ZodNullable<z.ZodString>;
                via: z.ZodNullable<z.ZodEnum<{
                    rollback: "rollback";
                    redeploy: "redeploy";
                }>>;
                ok: z.ZodBoolean;
                detail: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        github: z.ZodNullable<z.ZodObject<{
            total: z.ZodNumber;
            success: z.ZodNumber;
        }, z.core.$strict>>;
        token: z.ZodBoolean;
    }, z.core.$strict>;
    readonly 'preview.created': z.ZodObject<{
        pr: z.ZodNumber;
        head: z.ZodString;
        environment: z.ZodString;
    }, z.core.$strict>;
    readonly 'preview.ready': z.ZodObject<{
        pr: z.ZodNumber;
        head: z.ZodString;
        url: z.ZodString;
        flows: z.ZodArray<z.ZodObject<{
            flow: z.ZodString;
            status: z.ZodEnum<{
                pass: "pass";
                fail: "fail";
                unavailable: "unavailable";
            }>;
            detail: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    readonly 'preview.failed': z.ZodObject<{
        pr: z.ZodNumber;
        head: z.ZodString;
        outcome: z.ZodEnum<{
            error: "error";
            timed_out: "timed_out";
            deploy_failed: "deploy_failed";
        }>;
        detail: z.ZodString;
    }, z.core.$strict>;
    readonly 'preview.removed': z.ZodObject<{
        pr: z.ZodNumber;
        environment: z.ZodString;
        reason: z.ZodEnum<{
            closed: "closed";
            failed: "failed";
            expired: "expired";
        }>;
        ok: z.ZodBoolean;
    }, z.core.$strict>;
    readonly 'preview.waiting': z.ZodObject<{
        pr: z.ZodNumber;
        head: z.ZodString;
        active: z.ZodNumber;
        max: z.ZodNumber;
    }, z.core.$strict>;
    readonly 'preview.error': z.ZodObject<{
        detail: z.ZodString;
    }, z.core.$strict>;
    /** The sandbox helper's protocol version, asked at coordinator start (testrun/helper.ts): no run starts unless ok. */
    readonly 'testrun.helper': z.ZodObject<{
        ok: z.ZodBoolean;
        have: z.ZodNullable<z.ZodNumber>;
        need: z.ZodNumber;
        detail: z.ZodString;
    }, z.core.$strict>;
    /**
     * A merged PR's CI wall-clock on its head: from the first check run starting to the last required check
     * (config.yaml required_checks; every check when none) completing. `wall_ms` null: not measurable (`why`).
     */
    readonly 'ci.pr_timing': z.ZodObject<{
        number: z.ZodNumber;
        head: z.ZodString;
        wall_ms: z.ZodNullable<z.ZodNumber>;
        first_started: z.ZodNullable<z.ZodString>;
        last_completed: z.ZodNullable<z.ZodString>;
        why: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    /** One GitHub Actions job's per-test durations on a default-branch commit, from its log (src/test-durations.ts). */
    readonly 'ci.test_durations': z.ZodObject<{
        sha: z.ZodString;
        job: z.ZodString;
        tests: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            ms: z.ZodNumber;
        }, z.core.$strict>>;
        parsed: z.ZodNumber;
        error: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    /**
     * The default branch's required checks failed on `sha` (a red run): each failing check (`failed`) is re-run there.
     * `via`: how each was: `actions` (its workflow run's failed jobs), `test_run` (the test run's tiers), or `none`
     * (it can't be: `why`); `id` is the failing check run, so its re-run is told apart.
     */
    readonly 'flaky.rerun_requested': z.ZodObject<{
        sha: z.ZodString;
        number: z.ZodNullable<z.ZodNumber>;
        failed: z.ZodArray<z.ZodString>;
        via: z.ZodArray<z.ZodObject<{
            check: z.ZodString;
            how: z.ZodEnum<{
                none: "none";
                actions: "actions";
                test_run: "test_run";
            }>;
            id: z.ZodNullable<z.ZodNumber>;
            why: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>;
        at: z.ZodString;
    }, z.core.$strict>;
    /** The re-run's verdict on `sha`: `flaky` passed on the re-run, `real` failed again (or couldn't re-run, or `timed_out`). */
    readonly 'flaky.rerun_result': z.ZodObject<{
        sha: z.ZodString;
        number: z.ZodNullable<z.ZodNumber>;
        flaky: z.ZodArray<z.ZodString>;
        real: z.ZodArray<z.ZodString>;
        timed_out: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    /** A test (a check: an Actions job or a test-run tier) put in quarantine: it still runs and reports, but no longer turns the branch red for the harness. `again`: it had been released. */
    readonly 'flaky.quarantined': z.ZodObject<{
        test: z.ZodString;
        sha: z.ZodString;
        issue: z.ZodNullable<z.ZodNumber>;
        url: z.ZodNullable<z.ZodString>;
        again: z.ZodBoolean;
    }, z.core.$strict>;
    /** A quarantined test was seen flaky again: `sightings` in all. */
    readonly 'flaky.sighted': z.ZodObject<{
        test: z.ZodString;
        sha: z.ZodString;
        sightings: z.ZodNumber;
    }, z.core.$strict>;
    /** A quarantined test's result on a default-branch commit: `passes`, the passes in a row now. */
    readonly 'flaky.observed': z.ZodObject<{
        test: z.ZodString;
        sha: z.ZodString;
        ok: z.ZodBoolean;
        passes: z.ZodNumber;
    }, z.core.$strict>;
    /** A test left quarantine (it blocks again): after `passes` passes in a row, or an owner cleared it. */
    readonly 'flaky.released': z.ZodObject<{
        test: z.ZodString;
        how: z.ZodEnum<{
            owner: "owner";
            passes: "passes";
        }>;
        by: z.ZodString;
        passes: z.ZodNumber;
    }, z.core.$strict>;
    /**
     * The default branch went red on `sha` (after the flaky re-run said real): `failed` checks; `last_green` the last
     * commit known green before it; `candidates` the first-parent commits after it up to `sha`, oldest first, each with
     * the PR it merged (when its subject names one).
     */
    readonly 'fix_forward.started': z.ZodObject<{
        sha: z.ZodString;
        number: z.ZodNullable<z.ZodNumber>;
        failed: z.ZodArray<z.ZodString>;
        last_green: z.ZodNullable<z.ZodString>;
        candidates: z.ZodArray<z.ZodObject<{
            sha: z.ZodString;
            number: z.ZodNullable<z.ZodNumber>;
            title: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    /** One candidate of red `sha` tested on its own commit: asked for (`verdict` pending, `via` how), then its verdict. */
    readonly 'fix_forward.tested': z.ZodObject<{
        sha: z.ZodString;
        candidate: z.ZodString;
        verdict: z.ZodEnum<{
            pending: "pending";
            good: "good";
            bad: "bad";
            skip: "skip";
        }>;
        via: z.ZodEnum<{
            checks: "checks";
            none: "none";
            actions: "actions";
            test_run: "test_run";
        }>;
        ids: z.ZodArray<z.ZodNumber>;
        detail: z.ZodString;
    }, z.core.$strict>;
    /** The culprit of red `sha`: `how` only (one candidate), bisect, or range (untestable commits left: `culprit` null, from..to). `revert_first`: why it is reverted at once. */
    readonly 'fix_forward.culprit': z.ZodObject<{
        sha: z.ZodString;
        culprit: z.ZodNullable<z.ZodString>;
        number: z.ZodNullable<z.ZodNumber>;
        title: z.ZodString;
        how: z.ZodEnum<{
            only: "only";
            bisect: "bisect";
            range: "range";
        }>;
        range: z.ZodNullable<z.ZodObject<{
            from: z.ZodString;
            to: z.ZodString;
        }, z.core.$strict>>;
        revert_first: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    /** Fix task `attempt` for red `sha`: issue `issue`, worked like any task; its PR goes through the normal gates. */
    readonly 'fix_forward.attempt': z.ZodObject<{
        sha: z.ZodString;
        attempt: z.ZodNumber;
        issue: z.ZodNumber;
        culprit: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strict>;
    /** Fix task `attempt` didn't make the default branch green: why. */
    readonly 'fix_forward.attempt_failed': z.ZodObject<{
        sha: z.ZodString;
        attempt: z.ZodNumber;
        issue: z.ZodNumber;
        why: z.ZodString;
    }, z.core.$strict>;
    /**
     * Fix-forward's outcome for red `sha` (the delivery metrics read it): fixed (green again by fix PR `by`, or by
     * another merge), reverted (the culprit's revert PR opened), gave_up (no culprit to revert, or the revert failed).
     */
    readonly 'fix_forward.finished': z.ZodObject<{
        sha: z.ZodString;
        outcome: z.ZodEnum<{
            fixed: "fixed";
            reverted: "reverted";
            gave_up: "gave_up";
        }>;
        attempts: z.ZodNumber;
        culprit: z.ZodNullable<z.ZodNumber>;
        by: z.ZodNullable<z.ZodNumber>;
        revert: z.ZodNullable<z.ZodObject<{
            url: z.ZodString;
            number: z.ZodNumber;
        }, z.core.$strict>>;
        detail: z.ZodString;
    }, z.core.$strict>;
    /** The default branch is green again on `tip` after red `sha`: by a fix PR (`fixed_by`), the revert of `reverted`, or neither. */
    readonly 'fix_forward.green': z.ZodObject<{
        sha: z.ZodString;
        tip: z.ZodString;
        fixed_by: z.ZodNullable<z.ZodNumber>;
        reverted: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strict>;
    /** An off-machine backup attempt: ok only after the remote copy was read back, decrypted and matched (offsite-backup.ts). */
    readonly 'backup.offsite': z.ZodObject<{
        ok: z.ZodBoolean;
        destination: z.ZodString;
        key: z.ZodString;
        last_id: z.ZodNumber;
        error: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    /**
     * One replay of a fixed past task through the real coordinator path (src/harness-evals/): success is its done_when
     * checks passing and the evaluator approving; cost from its run.cost events; human interventions are the decisions
     * it asked and the times it waited for the owner. `held_out`: a task from the private store (never named in a PR).
     */
    readonly 'harness_eval.task': z.ZodObject<{
        run: z.ZodString;
        task: z.ZodString;
        held_out: z.ZodBoolean;
        sample: z.ZodNumber;
        success: z.ZodBoolean;
        done_when: z.ZodNullable<z.ZodBoolean>;
        verdict: z.ZodNullable<z.ZodBoolean>;
        outcome: z.ZodEnum<{
            error: "error";
            blocked: "blocked";
            budget: "budget";
            queued: "queued";
            asked: "asked";
            unfinished: "unfinished";
        }>;
        cost_usd: z.ZodNumber;
        wall_ms: z.ZodNumber;
        interventions: z.ZodNumber;
        detail: z.ZodString;
    }, z.core.$strict>;
    /**
     * A harness eval run: every task replayed `samples` times within `budget_usd`. `trigger`: weekly, a change to the
     * engine's src/ (`engine`, and `pr`, the PR whose merge it is), or by hand. `stopped`: the budget ran out first.
     */
    /** A session (or a confirm run) begins entry `n` of `study` at `version`, from `parent` (null: the study's own commit). */
    readonly 'experiment.session': z.ZodObject<{
        study: z.ZodString;
        version: z.ZodString;
        session: z.ZodString;
        n: z.ZodNumber;
        kind: z.ZodEnum<{
            baseline: "baseline";
            exploit: "exploit";
            explore: "explore";
            combine: "combine";
            seed: "seed";
        }>;
        parent: z.ZodNullable<z.ZodNumber>;
        of: z.ZodOptional<z.ZodNumber>;
        arm: z.ZodOptional<z.ZodEnum<{
            candidate: "candidate";
            best: "best";
        }>>;
        size: z.ZodDefault<z.ZodNumber>;
        seed: z.ZodDefault<z.ZodNumber>;
        combines: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
    /** The session's one proposal, checked: its change committed at `commit` (a local ref, never pushed). `approval`: why an owner approves it first (empty: none). */
    readonly 'experiment.proposed': z.ZodObject<{
        study: z.ZodString;
        version: z.ZodString;
        session: z.ZodString;
        n: z.ZodNumber;
        job: z.ZodString;
        hypothesis: z.ZodString;
        variable: z.ZodDefault<z.ZodString>;
        motivation: z.ZodString;
        expected_effect: z.ZodString;
        config: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
        commit: z.ZodString;
        files: z.ZodArray<z.ZodString>;
        lockfile: z.ZodBoolean;
        approval: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    /** The session's output was refused before any job: why, in the code's words. */
    readonly 'experiment.refused': z.ZodObject<{
        study: z.ZodString;
        version: z.ZodString;
        session: z.ZodString;
        n: z.ZodNumber;
        why: z.ZodString;
    }, z.core.$strict>;
    /** An owner's answer to a job waiting for approval. */
    readonly 'experiment.approval': z.ZodObject<{
        study: z.ZodString;
        job: z.ZodString;
        answer: z.ZodEnum<{
            approve: "approve";
            decline: "decline";
        }>;
        by: z.ZodString;
    }, z.core.$strict>;
    /** The helper was asked to run the job; `gpu: planned` before any GPU command, so a cut-off job is never run again by itself. */
    readonly 'experiment.job_started': z.ZodObject<{
        study: z.ZodString;
        job: z.ZodString;
        n: z.ZodNumber;
        gpu: z.ZodLiteral<"planned">;
    }, z.core.$strict>;
    /** The job's run record, and the decision judged from it. */
    readonly 'experiment.recorded': z.ZodObject<{
        study: z.ZodString;
        version: z.ZodString;
        job: z.ZodString;
        n: z.ZodNumber;
        outcome: z.ZodEnum<{
            stopped: "stopped";
            scored: "scored";
            crashed: "crashed";
        }>;
        score: z.ZodNullable<z.ZodNumber>;
        step: z.ZodNullable<z.ZodString>;
        gpu_minutes: z.ZodNumber;
        waited_s: z.ZodNumber;
        tail: z.ZodString;
        decision: z.ZodEnum<{
            keep: "keep";
            stopped: "stopped";
            seed: "seed";
            screened_out: "screened_out";
            stage2: "stage2";
            crash: "crash";
        }>;
        value: z.ZodNullable<z.ZodNumber>;
        vs: z.ZodOptional<z.ZodNumber>;
        why: z.ZodString;
        timings: z.ZodOptional<z.ZodObject<{
            train_ms: z.ZodNumber;
            predict_ms: z.ZodNumber;
            score_ms: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    /** A candidate's stage-2 judgment at one size: mean ± spread of both arms, the budget each used, and what follows. */
    readonly 'experiment.judged': z.ZodObject<{
        study: z.ZodString;
        version: z.ZodString;
        n: z.ZodNumber;
        decision: z.ZodEnum<{
            keep: "keep";
            held: "held";
            discard: "discard";
            ladder: "ladder";
            winner: "winner";
        }>;
        why: z.ZodString;
        stage2: z.ZodObject<{
            size: z.ZodNumber;
            meanCandidate: z.ZodNullable<z.ZodNumber>;
            meanBest: z.ZodNullable<z.ZodNumber>;
            spread: z.ZodNullable<z.ZodNumber>;
            seeds: z.ZodNumber;
            minutesCandidate: z.ZodNumber;
            minutesBest: z.ZodNumber;
        }, z.core.$strict>;
        value: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        after: z.ZodOptional<z.ZodEnum<{
            keep: "keep";
            winner: "winner";
        }>>;
    }, z.core.$strict>;
    /** An owner's verdict on a held result: accept (it counts) or reject (discarded). */
    readonly 'experiment.verdict': z.ZodObject<{
        study: z.ZodString;
        n: z.ZodNumber;
        answer: z.ZodEnum<{
            accept: "accept";
            reject: "reject";
        }>;
        by: z.ZodString;
    }, z.core.$strict>;
    /**
     * The tampering monitor's reading of one session's whole transcript (a cheaper model, on the coordinator's side).
     * Its findings go to the owner and the hold, never to any session.
     */
    readonly 'experiment.monitor': z.ZodObject<{
        study: z.ZodString;
        version: z.ZodString;
        session: z.ZodString;
        n: z.ZodNumber;
        flagged: z.ZodBoolean;
        findings: z.ZodArray<z.ZodString>;
        cost_usd: z.ZodNumber;
    }, z.core.$strict>;
    /** What one experimenter session cost (real money): the study's spend counts these, on the local day. */
    readonly 'experiment.cost': z.ZodObject<{
        study: z.ZodString;
        session: z.ZodString;
        usd: z.ZodNumber;
    }, z.core.$strict>;
    /** A person's change to a study through the dashboard's Review -> Confirm. */
    readonly 'experiment.changed': z.ZodObject<{
        study: z.ZodString;
        action: z.ZodEnum<{
            pause: "pause";
            resume: "resume";
            start: "start";
            stop_job: "stop_job";
            caps: "caps";
            archive: "archive";
            promote: "promote";
            prune: "prune";
        }>;
        by: z.ZodString;
        role: z.ZodString;
        detail: z.ZodString;
    }, z.core.$strict>;
    readonly 'harness_eval.run': z.ZodObject<{
        id: z.ZodString;
        trigger: z.ZodEnum<{
            manual: "manual";
            change: "change";
            weekly: "weekly";
        }>;
        engine: z.ZodNullable<z.ZodString>;
        pr: z.ZodNullable<z.ZodNumber>;
        tasks: z.ZodNumber;
        samples: z.ZodNumber;
        runs: z.ZodNumber;
        passed: z.ZodNumber;
        cost_usd: z.ZodNumber;
        wall_ms: z.ZodNumber;
        interventions: z.ZodNumber;
        budget_usd: z.ZodNumber;
        stopped: z.ZodNullable<z.ZodEnum<{
            budget: "budget";
        }>>;
        error: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    /** The run's results posted on the PR whose merge triggered it, against the last baseline. */
    readonly 'harness_eval.commented': z.ZodObject<{
        run: z.ZodString;
        pr: z.ZodNumber;
        baseline: z.ZodNullable<z.ZodString>;
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
