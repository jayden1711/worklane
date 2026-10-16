// Corrections become durable rules: record each correction a writer makes (from the event log, the chat's
// history, and the harness's PRs on GitHub), then one read-only corrections run at a time proposes the strongest
// durable fix, filed as an issue the pipeline builds into a reviewed PR. See src/corrections.ts.
import { BRAND } from '../brand.js';
import { chatHistory } from '../chat.js';
import { chatCorrections, CORRECTION_LABEL, correctionBrief, correctionMarker, correctionsFromEvents, CORRECTIONS_SCHEMA, fingerprint, fixFiled, prRejection, readProposal, reviewCorrections } from '../corrections.js';
import { rolePrompt } from '../roles.js';
import { MergeFlow } from './merge-flow.js';
/** How often the harness's PRs are checked for reviews that request changes and for unmerged closes. */
export const REVIEW_POLL_MS = 5 * 60_000;
/** A PR closed longer ago than this (by its pr.closed event) is not looked at again after a restart. */
const CLOSED_LOOKBACK_MS = 30 * 24 * 3600_000;
/** The corrections run reads, never writes. */
export const CORRECTIONS_TOOLS = ['Read', 'Glob', 'Grep', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git grep:*)'];
export const CORRECTIONS_DISALLOWED = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
export class Corrections extends MergeFlow {
    /** The corrections run in flight (one at a time). */
    correctionsRun = Promise.resolve();
    correctionsBusy = false;
    reviewsPolledAt = -Infinity;
    /** Closed PRs already looked at by this process. */
    closedSeen = new Set();
    /** Record new corrections, then start the next corrections run if none is running. Returns the run in flight. */
    async checkCorrections() {
        const cfg = this.d.cfg.project.corrections;
        if (!cfg.enabled)
            return;
        const writers = this.d.cfg.project.owners.writers;
        const found = [
            ...correctionsFromEvents(this.d.log.read(0, ['plan.posted', 'plan.decided', 'decision.asked', 'decision.answered']), writers),
            ...chatCorrections(chatHistory(this.d.stateDir, 1000), writers),
        ];
        if (Date.now() - this.reviewsPolledAt >= REVIEW_POLL_MS) {
            this.reviewsPolledAt = Date.now();
            found.push(...(await this.prCorrections(writers)));
        }
        const recorded = new Set(this.d.log.read(0, ['correction.recorded']).map((e) => e.payload.key));
        for (const c of found) {
            if (recorded.has(c.key))
                continue;
            recorded.add(c.key);
            this.emit('correction.recorded', { key: c.key, kind: c.kind, issue: c.issue, pr: c.pr, by: c.by, text: c.text });
        }
        if (!this.correctionsBusy && !this.halt.signal.aborted && !this.stopped && !this.usagePause() && !this.authHeld() && !this.diskHeld()) {
            this.correctionsBusy = true;
            this.correctionsRun = this.nextCorrection()
                .catch((e) => void this.emit('coordinator.error', { instance: this.d.instance, where: 'corrections', kind: 'error', message: e.message.slice(0, 500) }))
                .finally(() => {
                this.correctionsBusy = false;
            });
        }
    }
    /** Reviews requesting changes on the harness's open PRs, and its PRs a writer closed without merging. */
    async prCorrections(writers) {
        const out = [];
        const opened = new Map(this.d.log.read(0, ['pr.opened']).map((e) => [e.payload.number, e.payload]));
        const closed = new Map(this.d.log.read(0, ['pr.closed']).map((e) => [e.payload.number, { ...e.payload, ts: e.ts }]));
        for (const [n, o] of opened) {
            const c = closed.get(n);
            if (c && (this.closedSeen.has(n) || Date.now() - Date.parse(c.ts) > CLOSED_LOOKBACK_MS))
                continue;
            const title = (await this.d.backlog.get(o.issue).catch(() => null))?.title ?? '';
            out.push(...reviewCorrections({ pr: n, issue: o.issue, title, reviews: await this.d.backlog.reviews(n), writers }));
            if (!c)
                continue;
            this.closedSeen.add(n);
            if (c.merged)
                continue;
            const by = await this.d.backlog.closedBy(n);
            const r = by ? prRejection({ pr: n, issue: o.issue, title, by, comments: await this.d.backlog.comments(n), writers, at: c.ts }) : null;
            if (r)
                out.push(r);
        }
        return out;
    }
    /** Corrections recorded and not yet acted on, oldest first. */
    pendingCorrections() {
        const done = new Set(this.d.log.read(0, ['correction.proposed', 'correction.grouped', 'correction.no_fix']).map((e) => e.payload.key));
        return this.d.log
            .read(0, ['correction.recorded'])
            .filter((e) => !done.has(e.payload.key))
            .map((e) => ({ ...e.payload, at: e.ts, id: e.id }));
    }
    /** Agent runs on corrections today (each outcome it produced). */
    correctionRunsToday() {
        const day = new Date().toISOString().slice(0, 10);
        return this.d.log.read(0, ['correction.proposed', 'correction.grouped', 'correction.no_fix']).filter((e) => e.ts.startsWith(day) && e.payload.how !== 'same words').length;
    }
    async nextCorrection() {
        const c = this.pendingCorrections()[0];
        if (!c)
            return;
        const all = this.d.log.read(0, ['correction.recorded']).map((e) => ({ ...e.payload, at: e.ts }));
        // Which earlier corrections got a fix filed (their own, or the one they were grouped with).
        const filing = {
            grouped: new Map(this.d.log.read(0, ['correction.grouped']).map((e) => [e.payload.key, e.payload.same_as])),
            filed: new Set(this.d.log.read(0, ['correction.proposed']).map((e) => e.payload.key)),
        };
        // The same words as an earlier correction whose fix was filed: the same correction, grouped without a run. One
        // with no fix filed is the owner correcting the same thing twice: it goes to the agent for the structural fix.
        const twin = all.find((x) => x.key !== c.key && fingerprint(x) === fingerprint(c) && all.indexOf(x) < all.findIndex((y) => y.key === c.key));
        if (twin && fixFiled(twin.key, filing)) {
            this.emit('correction.grouped', { key: c.key, same_as: twin.key, how: 'same words' });
            return this.noteRepeat(twin.key, c);
        }
        if (this.correctionRunsToday() >= this.d.cfg.project.corrections.max_per_day)
            return;
        const left = this.d.cfg.agents.daily_budget_usd - this.spentToday();
        if (left <= 0)
            return;
        const outcomes = new Map();
        for (const e of this.d.log.read(0, ['correction.proposed', 'correction.grouped', 'correction.no_fix'])) {
            const p = e.payload;
            outcomes.set(p.key, e.type === 'correction.proposed' ? `fix filed as #${p.issue}` : e.type === 'correction.grouped' ? `grouped with ${p.same_as}` : `no durable fix (${p.why ?? ''})`);
        }
        const earlier = all.filter((x) => x.key !== c.key && outcomes.has(x.key)).map((x) => ({ key: x.key, kind: x.kind, text: x.text, outcome: outcomes.get(x.key), fixed: fixFiled(x.key, filing) }));
        const role = this.d.cfg.agents.roles.corrections ?? this.d.cfg.agents.roles.workers;
        const r = await this.d.runner.run({
            env: this.projectEnv(),
            role: 'corrections',
            stateDir: this.d.stateDir,
            ...(c.issue !== null ? { issue: c.issue } : {}),
            prompt: correctionBrief(c, earlier),
            appendSystemPrompt: rolePrompt(this.d.cfg, 'corrections'),
            cwd: this.d.repo,
            model: role.model,
            allowedTools: CORRECTIONS_TOOLS,
            disallowedTools: CORRECTIONS_DISALLOWED,
            maxTurns: 60,
            maxBudgetUsd: Math.min(role.budget_usd ?? 3, Math.max(0.1, left)),
            jsonSchema: CORRECTIONS_SCHEMA,
            stallMs: 20 * 60_000,
            timeoutMs: this.commandTimeoutMs,
        });
        this.emit('run.cost', { issue: c.issue, role: 'corrections', model: r.model, usd: r.costUsd, turns: r.turns });
        if (r.reason !== 'succeeded')
            return void this.emit('correction.no_fix', { key: c.key, why: `the corrections run ended: ${r.reason} (${r.detail.slice(0, 300)})`, failed: true });
        // A repeat may only be grouped with a correction whose fix was filed.
        const p = readProposal(r.structured, earlier.filter((e) => e.fixed).map((e) => e.key));
        if (p.act === 'invalid')
            return void this.emit('correction.no_fix', { key: c.key, why: p.why.slice(0, 1000), failed: true });
        if (p.act === 'none')
            return void this.emit('correction.no_fix', { key: c.key, why: p.why.slice(0, 1000), failed: false });
        if (p.act === 'group') {
            this.emit('correction.grouped', { key: c.key, same_as: p.sameAs, how: 'the agent' });
            return this.noteRepeat(p.sameAs, c);
        }
        const n = await this.d.backlog.createIssue(p.title, `${p.body}\n\n_From @${c.by}'s correction (${c.kind.replace('_', ' ')}${c.pr ? `, PR #${c.pr}` : c.issue ? `, #${c.issue}` : ''}). Strongest durable fix: ${p.fixKind}. ${p.why}_\n\n${correctionMarker(c.key)}`, ['ready', CORRECTION_LABEL]);
        this.emit('correction.proposed', { key: c.key, fix_kind: p.fixKind, issue: n, title: p.title.slice(0, 300), why: p.why.slice(0, 1000) });
    }
    /** A repeat of a correction whose fix was filed: say so on the fix's issue, so the owner sees it came up again. */
    async noteRepeat(rootKey, c) {
        let root = rootKey;
        for (let i = 0; i < 20; i++) {
            const up = this.d.log.read(0, ['correction.grouped']).map((e) => e.payload).find((g) => g.key === root);
            if (!up)
                break;
            root = up.same_as;
        }
        const filed = this.d.log.read(0, ['correction.proposed']).map((e) => e.payload).find((x) => x.key === root);
        if (filed)
            await this.d.backlog.comment(filed.issue, `[${BRAND.cli}] The same correction came up again (${c.kind.replace('_', ' ')} by @${c.by}${c.pr ? ` on PR #${c.pr}` : c.issue ? ` on #${c.issue}` : ''}); grouped with this fix, not proposed again.`);
    }
}
//# sourceMappingURL=corrections.js.map