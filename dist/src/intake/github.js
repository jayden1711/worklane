// WHY: outsiders' issues "stay in triage" (backlog/types.ts actionable); this source runs them through the same
// triage, dedupe, L3 rule and trust policy (decide.ts) as a chat report. The author is the sender; filing labels the
// issue itself (src/coordinator/intake.ts). An issue template can set the label, so anyone may file one.
import { redactString } from '../events/redact.js';
import { BRAND } from '../brand.js';
import { seen } from './store.js';
export const INTAKE_LABEL = { name: `${BRAND.cli}:intake`, color: 'bfd4f2', description: 'Reported here: triaged by the intake, filed ready only when trusted or approved' };
const MAX_TEXT = 4000;
export class GitHubIssuesIntake {
    o;
    name = 'github';
    nextAt = 0;
    constructor(o) {
        this.o = o;
    }
    // INVARIANT: one listing per poll_minutes at most, and none before a rate limit's retry-after, whatever the
    // intake timer's pace. Ready issues are work already; bots and seen issues are never taken.
    async take() {
        const now = this.o.now?.() ?? Date.now();
        if (now < this.nextAt)
            return [];
        const cfg = this.o.config();
        this.nextAt = now + cfg.poll_minutes * 60_000;
        let issues;
        try {
            issues = await this.o.backlog.list(INTAKE_LABEL.name);
        }
        catch (e) {
            const retry = e.retryAfter;
            if (typeof retry === 'number' && retry > 0)
                this.nextAt = Math.max(this.nextAt, now + retry * 1000);
            throw e;
        }
        const at = new Date(now).toISOString();
        return issues
            .filter((i) => i.state === 'open' && !i.labels.includes('ready') && i.author && !/\[bot\]$/.test(i.author))
            .map((i) => ({
            source: 'github',
            sourceId: String(i.number),
            sender: { source: 'github', id: i.author.toLowerCase() },
            text: redactString(`${i.title}\n\n${i.body}`).slice(0, MAX_TEXT),
            receivedAt: at,
            thread: { kind: 'channel', id: String(i.number) },
        }))
            .filter((r) => !seen(this.o.stateDir, r))
            .sort((a, b) => Number(a.sourceId) - Number(b.sourceId));
    }
    async reply(thread, text) {
        if (!/^\d+$/.test(thread.id))
            return false;
        await this.o.backlog.comment(Number(thread.id), text);
        return true;
    }
    source() {
        return { name: this.name, take: () => this.take(), reply: (t, text) => this.reply(t, text) };
    }
}
//# sourceMappingURL=github.js.map