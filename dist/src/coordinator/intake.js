// Work intake (docs/intake.md): pulling the sources, triage, filing or asking, replies, and recovery after a restart.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mayAnswer } from '../backlog/types.js';
import { ownerOnlyDir, writeOwnerOnly } from '../os/index.js';
import { loadMoneyPaths } from '../review.js';
import { intakeCaps, researchRepoAccess } from '../settings.js';
import { isAllowed, isTrusted } from '../intake/report.js';
import { redactPii } from '../intake/redact.js';
import { IntakeMeter, purgeRaw, purgeSeen, rawIds, readRaw, reportId, seen, storeRaw } from '../intake/store.js';
import { candidates as intakeCandidates } from '../intake/dedupe.js';
import { acceptTriage } from '../intake/triage.js';
import { decide as intakeDecide, excerpt, NEEDS_INFO_REPLY, statusReply } from '../intake/decide.js';
import { checkReply, REPLIER_ROLE, replierDir, replierRun } from '../intake/replier.js';
import { INTAKE_ROLE, intakeRun, writeIntakeBundle } from '../intake/run.js';
import { QuickReplies } from './quick-replies.js';
import { runRoute } from './model-routing.js';
/** How often intake sources are pulled, by default. */
const INTAKE_PULL_MS = 30_000;
/** The labels intake puts on what it files, by triage kind; also where it looks for open issues a report may repeat. */
const INTAKE_KIND_LABEL = { bug: 'bug', feature: 'enhancement' };
/** Events that end a report's handling (with an intake.replied at stage info, for a report answered by a reply). */
const INTAKE_OUTCOMES = ['intake.filed', 'intake.awaiting', 'intake.commented', 'intake.grouped', 'intake.asked', 'intake.dropped'];
/** What a sender is told when a restart cut off their report. */
const INTERRUPTED_REPLY = "Sorry, we couldn't finish handling your message. Could you send it again?";
// WHY: a github report is never taken twice (the seen ledger), so asking for it again would go nowhere.
const GITHUB_INTERRUPTED_REPLY = "Sorry, we couldn't finish triaging this issue; it stays here for a maintainer.";
const GITHUB_AWAITING_REPLY = 'Thanks. A maintainer approves this before it is taken on as work; until then it stays in triage.';
const GITHUB_REJECTED_REPLY = 'A maintainer decided not to take this on as work for now; it stays in triage.';
const ownIssue = (r) => (r?.source === 'github' && /^\d+$/.test(r.sourceId) ? Number(r.sourceId) : null);
export class Intake extends QuickReplies {
    // ---------------------------------------------------------------- intake
    /**
     * Work intake (docs/intake.md), on the short timer: pull each enabled source (at most every `pullMs`), take each
     * new report through redaction, the caps, a read-only triage run and the policy (intake/decide.ts), then act on
     * the owner's answers and send status replies. Report text is data: nothing in it, and nothing the triage run
     * returns, can file `ready`, answer a decision or change config. One pass at a time; returns the pass in flight.
     */
    checkIntake() {
        // Replies a person waits on are woken by their arrival; the timer is the fallback for one that was missed.
        void this.wakeQuick();
        const it = this.d.intake;
        if (!it || this.intakeRunning || this.halt.signal.aborted || this.stopped)
            return this.intakeQueue;
        const now = (this.d.now?.() ?? new Date()).getTime();
        if (now - this.intakePulledAt < (it.pullMs ?? INTAKE_PULL_MS))
            return this.intakeQueue;
        this.intakePulledAt = now;
        this.intakeRunning = true;
        this.intakeQueue = this.intakePass(it)
            .catch((e) => {
            this.emit('coordinator.error', { instance: this.d.instance, where: 'intake', kind: e.kind ?? 'error', message: e.message.slice(0, 500) });
        })
            .finally(() => {
            this.intakeRunning = false;
        });
        return this.intakeQueue;
    }
    /**
     * At start-up, before any pass: end what a restart cut off, exactly once and without running any agent again.
     * A reply recorded as being sent but never as sent is marked unknown (not resent). A report taken but without an
     * outcome is filed if its issue exists (found by its marker), else dropped as interrupted, and its sender asked
     * once to send it again. Each writes an outcome, so a second restart finds nothing to do.
     */
    async recoverIntake() {
        const it = this.d.intake;
        if (!it)
            return;
        // The chat channel's posts cut off by a restart, and its threads, taken again.
        this.channelRecover();
        this.channelRewatch();
        const sent = new Set(this.d.log.read(0, ['intake.replied']).map((e) => `${e.payload.id}\0${e.payload.stage}`));
        for (const e of this.d.log.read(0, ['intake.replying'])) {
            const p = e.payload;
            if (sent.has(`${p.id}\0${p.stage}`))
                continue;
            this.emit('intake.replied', { id: p.id, stage: p.stage, ok: false, unknown: true });
            sent.add(`${p.id}\0${p.stage}`);
        }
        const ended = new Set();
        for (const e of this.d.log.read(0, [...INTAKE_OUTCOMES, 'intake.replied'])) {
            const p = e.payload;
            // A reply is an outcome only for a report whose action was the reply (asking for details).
            if (e.type !== 'intake.replied' || p.stage === 'info' || p.stage === 'interrupted')
                ended.add(p.id);
        }
        const received = new Set(this.d.log.read(0, ['intake.received']).map((e) => e.payload.id));
        const cfg = it.config();
        // Stored but never recorded as received (a crash between the two): recorded now, so it can be ended.
        for (const id of rawIds(this.d.stateDir)) {
            if (received.has(id))
                continue;
            const raw = readRaw(this.d.stateDir, id);
            if (!raw)
                continue;
            const redacted = redactPii(raw.text, { names: [...(raw.sender.name ? [raw.sender.name] : []), ...(cfg?.redact.names ?? [])], patterns: cfg?.redact.patterns ?? [] });
            this.emit('intake.received', { id, source: raw.source, sender: createHash('sha256').update(`${raw.sender.source}\0${raw.sender.id}`).digest('hex').slice(0, 12), excerpt: excerpt(redacted) });
            received.add(id);
        }
        for (const id of received) {
            if (ended.has(id))
                continue;
            const raw = readRaw(this.d.stateDir, id);
            const own = ownIssue(raw);
            const issue = own !== null ? ((await this.intakeLabelled(own, id).catch(() => false)) ? own : null) : await this.intakeIssueFor(id, ['ready', ...Object.values(INTAKE_KIND_LABEL)]).catch(() => null);
            if (issue !== null) {
                const ready = (await this.d.backlog.get(issue)).labels.includes('ready');
                this.emit('intake.filed', { id, issue, ready });
                if (!sent.has(`${id}\0filed`))
                    await this.intakeReply(id, raw, 'filed', statusReply('filed', raw && cfg ? isTrusted(raw.sender, cfg) : false));
                continue;
            }
            this.emit('intake.dropped', { id, reason: 'interrupted' });
            await this.intakeReply(id, raw, 'interrupted', own !== null ? GITHUB_INTERRUPTED_REPLY : INTERRUPTED_REPLY);
        }
    }
    async intakePass(it) {
        const cfg = it.config();
        if (!cfg)
            return;
        purgeRaw(this.d.stateDir, cfg.raw_retention_days);
        purgeSeen(this.d.stateDir);
        const error = (where, e) => this.emit('coordinator.error', { instance: this.d.instance, where, kind: e.kind ?? 'error', message: e.message.slice(0, 500) });
        for (const src of it.sources) {
            if (!cfg[src.name].enabled)
                continue;
            let got;
            try {
                // Replies a person waits on aren't taken here: src/coordinator/quick-replies.ts answers them as they arrive.
                got = await this.intakeTake(src);
            }
            catch (e) {
                error(`intake ${src.name}`, e);
                continue;
            }
            // An adapter speaks only for its own source: trust is looked up per source. Each conversation in arrival order.
            const mine = got.filter((x) => x.source === src.name);
            // Only allowed senders, on the sender id alone: anyone else's message is never stored or replied to, only counted.
            const notAllowed = mine.filter((r) => !isAllowed(r.sender, cfg));
            if (notAllowed.length) {
                const meter = new IntakeMeter(this.d.stateDir, intakeCaps(this.d.settings?.().settings ?? {}, cfg.caps), () => (this.d.now?.() ?? new Date()).getTime());
                for (const _ of notAllowed)
                    meter.countDrop('not_allowed');
            }
            const sorted = mine.filter((r) => isAllowed(r.sender, cfg)).sort((a, b) => (a.thread?.id ?? '').localeCompare(b.thread?.id ?? '') || a.receivedAt.localeCompare(b.receivedAt) || a.sourceId.localeCompare(b.sourceId));
            // The chat channel first (src/coordinator/channel.ts): replies in its threads, and anyone unmapped ignored.
            const { rest: inbound, ignored } = src.name === 'discord' ? await this.channelInbound(cfg, sorted) : { rest: sorted, ignored: [] };
            // Only a message in an ideas channel (or a source with no threads) is ever a report: never a chat-channel one.
            const batch = inbound.filter((r) => !r.thread || r.thread.kind === 'channel');
            for (const r of batch) {
                // Paused on the usage limit: the report isn't taken (so not acknowledged); it comes again after the reset.
                if (this.halt.signal.aborted || this.stopped || this.usagePause() || this.diskHeld())
                    break;
                try {
                    await this.intakeReport(cfg, r);
                }
                catch (e) {
                    error(`intake ${src.name} report`, e);
                }
            }
            // Only what is recorded (its id in the seen ledger), or dropped by rule, is acknowledged; the rest comes again.
            const recorded = [...sorted.filter((r) => seen(this.d.stateDir, r)), ...notAllowed, ...ignored].map((r) => r.sourceId);
            if (recorded.length && src.ack)
                await src.ack(recorded).catch((e) => error(`intake ${src.name} ack`, e));
            if (this.halt.signal.aborted || this.stopped)
                return;
        }
        await this.intakeDecisions(cfg);
        await this.intakeStatus(cfg);
        this.channelRewatch();
        await this.channelOutbound(cfg);
    }
    /** One new report, from its raw text to its action. A report already stored is never taken again. */
    async intakeReport(cfg, r) {
        if (!storeRaw(this.d.stateDir, r))
            return;
        const id = reportId(r);
        const sender = createHash('sha256').update(`${r.sender.source}\0${r.sender.id}`).digest('hex').slice(0, 12);
        const redacted = redactPii(r.text, { names: [...(r.sender.name ? [r.sender.name] : []), ...cfg.redact.names], patterns: cfg.redact.patterns });
        this.emit('intake.received', { id, source: r.source, sender, excerpt: excerpt(redacted) });
        const drop = (reason) => this.intakeDrop(r, id, reason);
        const settings = this.d.settings?.().settings ?? {};
        const caps = intakeCaps(settings, cfg.caps);
        const meter = new IntakeMeter(this.d.stateDir, caps, () => (this.d.now?.() ?? new Date()).getTime());
        const admit = meter.admit(sender, redacted);
        if (!admit.ok)
            return drop(admit.reason);
        const can = meter.canDraft();
        if (!can.ok)
            return drop(can.reason);
        const left = this.d.cfg.agents.daily_budget_usd - this.spentToday();
        if (left <= 0)
            return drop('budget');
        const recent = this.intakeRecent(id);
        // INVARIANT: a github report's own issue is never a candidate, so it can't be judged a duplicate of itself.
        const own = ownIssue(r);
        const shown = intakeCandidates(redacted, (await this.intakeOpenIssues()).filter((i) => i.number !== own), recent);
        const bundleDir = writeIntakeBundle({ instanceRoot: dirname(this.d.repo), gid: this.d.agentTasks?.gid ?? statSync(this.d.repo).gid, id, redacted, source: r.source, candidates: shown, recent: recent.map(({ id: rid, text }) => ({ id: rid, text })) });
        const spec = intakeRun({ bundleDir, repoAccess: researchRepoAccess(settings), repo: this.d.repo });
        const role = this.d.cfg.agents.roles.researcher ?? this.d.cfg.agents.roles.workers;
        // From here until its outcome is recorded, a restart finds this report started and ends it (recoverIntake).
        this.emit('intake.started', { id });
        const run = await this.d.runner.run({
            ...spec,
            stateDir: this.d.stateDir,
            ...runRoute(this.d.cfg, 'intake_triage'),
            maxTurns: 30,
            maxBudgetUsd: Math.max(0.05, Math.min(role.budget_usd ?? 1, caps.max_usd_per_day, left)),
            stallMs: 10 * 60_000,
            timeoutMs: 30 * 60_000,
        });
        this.cost(null, INTAKE_ROLE, run);
        meter.recordDraft(run.costUsd);
        if (run.reason !== 'succeeded')
            return drop(`triage run ended: ${run.reason}`);
        const got = acceptTriage(run.structured);
        if (!got.ok)
            return drop(`triage not accepted: ${got.why}`);
        const trusted = isTrusted(r.sender, cfg);
        const action = intakeDecide({ report: r, redacted, triage: got.triage, trusted, shown, moneyPaths: this.intakeMoneyPaths() });
        // A refused draft makes it needs_info, whatever kind the agent chose (decide.ts).
        const refused = action.action === 'reply' ? action.refused : undefined;
        this.emit('intake.triaged', { id, kind: refused ? 'needs_info' : got.triage.kind, reproduction: got.triage.reproduction?.result ?? null, ignored: got.dropped, ...(refused ? { draft_refused: refused.slice(0, 500) } : {}) });
        await this.intakeAct(r, id, trusted, action);
    }
    /** The project's money paths, for marking a draft that names one high-risk; none when unset or unreadable. */
    intakeMoneyPaths() {
        try {
            return loadMoneyPaths(this.d.repo, this.d.cfg.review?.money_path_source);
        }
        catch {
            return [];
        }
    }
    async intakeAct(r, id, trusted, a) {
        const owner = this.d.cfg.project.owners.default;
        switch (a.action) {
            case 'file': {
                const own = ownIssue(r);
                const n = own !== null ? await this.intakeLabelOnce(own, id, a.body, a.labels) : await this.intakeFileOnce(id, a.title, a.body, a.labels);
                this.emit('intake.filed', { id, issue: n, ready: a.labels.includes('ready') });
                return this.intakeReply(id, r, 'filed', statusReply('filed', trusted));
            }
            case 'decision': {
                // The draft waits in the coordinator's private state; the decision names only its report.
                ownerOnlyDir(join(this.d.stateDir, 'intake'));
                ownerOnlyDir(join(this.d.stateDir, 'intake', 'drafts'));
                // WHY: the issue number is kept with the draft: the raw report may be purged before anyone answers.
                const own = ownIssue(r);
                writeOwnerOnly(join(this.d.stateDir, 'intake', 'drafts', `${id}.json`), JSON.stringify({ title: a.title, body: a.body, labels: a.labels, ...(own !== null ? { issue: own } : {}) }));
                const decision = await this.ask('intake', null, owner, `File this report (via ${r.source}) as an issue: "${a.title.slice(0, 150)}"?`, a.options, 'approve', [`intake:${id}`, 'sender not trusted: approve files it ready, edit files it without ready, reject drops it']);
                this.emit('intake.awaiting', { id, decision });
                if (own !== null)
                    await this.intakeReply(id, r, 'awaiting', GITHUB_AWAITING_REPLY);
                return;
            }
            case 'comment':
                await this.d.backlog.comment(a.issue, a.body);
                this.emit('intake.commented', { id, issue: a.issue });
                return this.intakeReply(id, r, 'filed', statusReply('filed', trusted));
            case 'group':
                this.emit('intake.grouped', { id, with: a.with });
                return this.intakeReply(id, r, 'filed', statusReply('filed', trusted));
            case 'reply':
                return this.intakeReply(id, r, 'info', a.text);
            case 'ask_owner': {
                const decision = await this.ask('intake', null, owner, `A question via ${r.source}: ${a.text.slice(0, 500)}`, ['answered'], 'answered', [`intake:${id}`]);
                this.emit('intake.asked', { id, decision });
                return this.intakeReply(id, r, 'question', a.reply);
            }
            case 'drop':
                return this.intakeDrop(r, id, a.reason);
        }
    }
    /**
     * A reply into the report's thread, sent at most once: the intent is recorded first, so a crash between sending
     * and recording is found at start-up and marked unknown, never sent again (a person's phone gets at most one).
     * Its text is the engine's own, never the agent's.
     */
    async intakeReply(id, r, stage, text) {
        this.emit('intake.replying', { id, stage });
        const src = r ? this.d.intake?.sources.find((x) => x.name === r.source) : undefined;
        let ok = false;
        if (src && r?.thread) {
            try {
                ok = await src.reply(r.thread, await this.casualReply(id, r, stage, text));
            }
            catch {
                ok = false;
            }
        }
        this.emit('intake.replied', { id, stage, ok });
    }
    /**
     * The reply's text: the casual replier's when casual replies are on and its reply passes every check in code,
     * else the engine's fixed `fixed`. Its inputs are the redacted message and the facts only; one run, no tools,
     * within intake's daily spend cap. Which text was used, and why, is recorded.
     */
    async casualReply(id, r, stage, fixed) {
        const cfg = this.d.intake?.config();
        const facts = stage === 'filed' || stage === 'merged' || stage === 'deployed' || stage === 'question' ? stage : stage === 'info' && fixed === NEEDS_INFO_REPLY ? 'needs_info' : null;
        if (!cfg?.casual_replies || !facts)
            return fixed;
        const use = (text, why) => {
            this.emit('intake.reply_checked', { id, stage, used: why === null ? 'casual' : 'fixed', why });
            return text;
        };
        const meter = new IntakeMeter(this.d.stateDir, intakeCaps(this.d.settings?.().settings ?? {}, cfg.caps), () => (this.d.now?.() ?? new Date()).getTime());
        const can = meter.canDraft();
        if (!can.ok && can.reason === 'spend_cap')
            return use(fixed, 'spend_cap');
        const trusted = isTrusted(r.sender, cfg);
        const issue = trusted ? this.intakeIssues().get(id) : undefined;
        const f = { stage: facts, trusted, ...(issue !== undefined ? { issue } : {}) };
        const redacted = redactPii(r.text, { names: [...(r.sender.name ? [r.sender.name] : []), ...cfg.redact.names], patterns: cfg.redact.patterns });
        const cwd = replierDir(dirname(this.d.repo), this.d.agentTasks?.gid ?? statSync(this.d.repo).gid, id, stage);
        const run = await this.d.runner.run({ ...replierRun({ cwd, redacted, facts: f }), stateDir: this.d.stateDir, ...runRoute(this.d.cfg, 'intake_replier'), maxBudgetUsd: 0.25, stallMs: 2 * 60_000, timeoutMs: 5 * 60_000 });
        this.cost(null, REPLIER_ROLE, run);
        meter.recordSpend(run.costUsd);
        if (run.reason !== 'succeeded')
            return use(fixed, `the run ended: ${run.reason}`);
        const checked = checkReply(run.structured?.reply, { redacted, facts: f });
        return checked.ok ? use(checked.text, null) : use(fixed, checked.why.slice(0, 300));
    }
    /** Open issues a report may repeat: those with the labels intake files under, and ready work. */
    async intakeOpenIssues() {
        const out = new Map();
        for (const label of [...Object.values(INTAKE_KIND_LABEL), 'ready']) {
            try {
                for (const i of await this.d.backlog.list(label))
                    out.set(i.number, { number: i.number, title: i.title, body: i.body });
            }
            catch {
                // a tracker hiccup: fewer candidates, never a failed report
            }
        }
        return [...out.values()];
    }
    /** The last week's reports (redacted excerpts, from the log), with the issue each joined. */
    intakeRecent(except) {
        const since = (this.d.now?.() ?? new Date()).getTime() - 7 * 86_400_000;
        const issueOf = this.intakeIssues();
        return this.d.log
            .read(0, ['intake.received'])
            .filter((e) => Date.parse(e.ts) >= since && e.payload.id !== except)
            .slice(-50)
            .map((e) => {
            const p = e.payload;
            const n = issueOf.get(p.id);
            return { id: p.id, text: p.excerpt, ...(n !== undefined ? { issue: n } : {}) };
        });
    }
    /** The issue each report was filed as or joined. */
    intakeIssues() {
        const out = new Map();
        for (const e of this.d.log.read(0, ['intake.filed', 'intake.commented', 'intake.decided'])) {
            const p = e.payload;
            if (typeof p.issue === 'number')
                out.set(p.id, p.issue);
        }
        return out;
    }
    /**
     * Answers on intake decisions, each acted on once: approve files the draft `ready`, edit files it without `ready`
     * (to fix up first), reject drops it. A question's answer is only recorded. The owner or any of the project's
     * writers may answer (or the instance's own CLI, run on its machine); anyone else's answer is ignored. Who
     * answered is recorded on intake.decided.
     */
    async intakeDecisions(cfg) {
        const done = new Set(this.d.log.read(0, ['intake.decided']).map((e) => e.payload.decision));
        const answers = this.d.log.read(0, ['decision.answered']).map((e) => e.payload);
        for (const e of this.d.log.read(0, ['decision.asked'])) {
            const q = e.payload;
            if (q.kind !== 'intake' || done.has(q.id))
                continue;
            // A role on the answer: the instance's own dashboard read the person as an owner or writer of its repo.
            const a = answers.find((x) => x.id === q.id && (x.by === this.d.instance || x.role !== undefined || mayAnswer(q.owner, x.by, this.d.cfg.project.owners)));
            const rid = q.receipts.find((x) => x.startsWith('intake:'))?.slice('intake:'.length);
            if (!a || !rid || !/^[0-9a-f]{20}$/.test(rid))
                continue;
            const file = join(this.d.stateDir, 'intake', 'drafts', `${rid}.json`);
            let issue = null;
            if (existsSync(file) && (a.answer === 'approve' || a.answer === 'edit')) {
                const d = JSON.parse(readFileSync(file, 'utf8'));
                const labels = a.answer === 'approve' ? ['ready', ...d.labels] : d.labels;
                issue = typeof d.issue === 'number' ? await this.intakeLabelOnce(d.issue, rid, d.body, labels) : await this.intakeFileOnce(rid, d.title, d.body, labels);
            }
            this.emit('intake.decided', { id: rid, decision: q.id, answer: a.answer, by: a.by, issue });
            rmSync(file, { force: true });
            const raw = readRaw(this.d.stateDir, rid);
            if (issue !== null)
                await this.intakeReply(rid, raw, 'filed', statusReply('filed', raw ? isTrusted(raw.sender, cfg) : false));
            else if (ownIssue(raw) !== null && a.answer === 'reject')
                await this.intakeReply(rid, raw, 'rejected', GITHUB_REJECTED_REPLY);
        }
    }
    // WHY: a github report left in triage says why on its issue; other sources' drops stay silent as before.
    async intakeDrop(r, id, reason) {
        this.emit('intake.dropped', { id, reason: reason.slice(0, 500) });
        if (ownIssue(r) === null)
            return;
        // INVARIANT: only the engine's reason code is posted, never text after it (a run's or a refusal's detail).
        const code = reason.split(':')[0].replace(/[^a-z_ ]/gi, '').trim().slice(0, 60) || 'not taken';
        await this.intakeReply(id, r, 'dropped', `Not taken on as work automatically (${code}); it stays in triage for a maintainer.`);
    }
    /** "Fixed" and "live" replies: once the report's issue merges, and once a verified deploy includes that merge. */
    async intakeStatus(cfg) {
        const issueOf = this.intakeIssues();
        if (!issueOf.size)
            return;
        const merged = new Map();
        for (const e of this.d.log.read(0, ['merge.done', 'land.result', 'pr.closed'])) {
            const p = e.payload;
            if (e.type === 'merge.done')
                merged.set(p.issue, p.sha);
            else if (e.type === 'land.result' && p.outcome === 'landed')
                merged.set(p.issue, p.landed ?? null);
            else if (e.type === 'pr.closed' && p.merged && !merged.has(p.issue))
                merged.set(p.issue, null);
        }
        const deployed = this.d.log.read(0, ['deploy.verified']).map((e) => e.payload.sha);
        const replied = new Set(this.d.log.read(0, ['intake.replying', 'intake.replied']).map((e) => {
            const p = e.payload;
            return `${p.id}\0${p.stage}`;
        }));
        // A deploy includes a merge when it is that commit or a later one on top of it.
        const includes = (deploy, sha) => {
            if (deploy === sha)
                return true;
            try {
                execFileSync('git', ['merge-base', '--is-ancestor', sha, deploy], { cwd: this.d.repo, stdio: 'ignore' });
                return true;
            }
            catch {
                return false;
            }
        };
        for (const [rid, n] of issueOf) {
            if (!merged.has(n))
                continue;
            const sha = merged.get(n);
            const needMerged = !replied.has(`${rid}\0merged`);
            const needDeployed = !replied.has(`${rid}\0deployed`) && sha !== null && deployed.some((d) => includes(d, sha));
            if (!needMerged && !needDeployed)
                continue;
            const raw = readRaw(this.d.stateDir, rid);
            const trusted = raw ? isTrusted(raw.sender, cfg) : false;
            if (needMerged)
                await this.intakeReply(rid, raw, 'merged', statusReply('merged', trusted));
            if (needDeployed)
                await this.intakeReply(rid, raw, 'deployed', statusReply('deployed', trusted));
        }
    }
}
//# sourceMappingURL=intake.js.map