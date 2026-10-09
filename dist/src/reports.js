// Twice-daily reports, built only from the event log: what landed, what's
// in review, decisions waiting (with owner), what's blocked and why, spend,
// and the scorecard with changes since the last report. Short, no padding.
import { BRAND } from './brand.js';
import { project } from './projection.js';
import { scorecard } from './scorecard.js';
const fmtH = (h) => (h < 1 ? `${Math.round(h * 60)}m` : `${h.toFixed(h < 10 ? 1 : 0)}h`);
const money = (n) => `$${n.toFixed(2)}`;
const CARD_ROWS = [
    ['tasksDone', 'tasks done (7d)', 'up-good'],
    ['evaluatorPassRate', 'evaluator pass rate', 'up-good'],
    ['unverifiedClaimRate', 'unverified claims', 'down-good'],
    ['reverts', 'reverts', 'down-good'],
    ['baselineGrowth', 'new reds on main', 'down-good'],
    ['costPerDoneUsd', 'cost per done task', 'down-good'],
    ['readyToDoneHours', 'ready to done (median h)', 'down-good'],
    ['idleHours', 'idle hours (work waiting, nothing running)', 'down-good'],
    ['decisionWaitHours', 'hours decisions waited on owners', 'down-good'],
    ['blockedHours', 'hours tasks sat blocked', 'down-good'],
];
export function buildReport(events, cfg, opts) {
    const now = opts.now ?? new Date();
    const since = opts.since.getTime();
    const after = (e) => Date.parse(e.ts) > since;
    const p = project(events, now.toISOString().slice(0, 10));
    const title = (n) => p.tasks.find((t) => t.issue === n)?.title ?? `#${n}`;
    const owner = (n) => p.tasks.find((t) => t.issue === n)?.owner;
    const lines = [];
    const day = now.toLocaleDateString('en-CA');
    lines.push(`## ${BRAND.name} report: ${cfg.project.project.name}, ${day}${opts.slot ? ` ${opts.slot}` : ''}`);
    const landed = events.filter((e) => after(e) && e.type === 'land.result' && e.payload.outcome === 'landed');
    const deployed = new Map(events.filter((e) => e.type === 'deploy.verified').map((e) => [e.payload.sha, e.payload.env]));
    lines.push('', `**Landed** (${landed.length})`);
    if (!landed.length)
        lines.push('- nothing');
    for (const e of landed) {
        const { issue, landed: sha } = e.payload;
        const env = deployed.get(sha);
        lines.push(`- #${issue} ${title(issue)} (@${owner(issue) ?? '?'}) \`${sha.slice(0, 8)}\`${env ? `, serving on ${env}` : cfg.deploy?.environments.some((x) => !x.production) ? ', **not yet verified on staging**' : ''}`);
    }
    const review = p.tasks.filter((t) => ['verifying', 'evaluating', 'queued'].includes(t.status));
    lines.push('', `**In review** (${review.length})`);
    if (!review.length)
        lines.push('- nothing');
    for (const t of review)
        lines.push(`- #${t.issue} ${t.title}: ${t.status}${t.level ? `, ${t.level}` : ''} (@${t.owner ?? '?'})`);
    const open = p.decisions.filter((d) => !d.answer);
    lines.push('', `**Decisions needed** (${open.length})`);
    if (!open.length)
        lines.push('- none');
    for (const d of open)
        lines.push(`- @${d.owner}: ${d.issue !== null ? `#${d.issue} ` : ''}${d.question} (waiting ${fmtH((now.getTime() - Date.parse(d.askedAt)) / 3_600_000)}; recommended: ${d.recommendation})`);
    const blocked = p.tasks.filter((t) => t.status === 'blocked');
    lines.push('', `**Blocked** (${blocked.length})`);
    if (!blocked.length)
        lines.push('- nothing');
    for (const t of blocked)
        lines.push(`- #${t.issue} ${t.title} (@${t.owner ?? '?'}): ${(t.blockedReason ?? '').split('\n')[0].slice(0, 200)}`);
    const spendSince = events.filter((e) => after(e) && e.type === 'run.cost').reduce((s, e) => s + e.payload.usd, 0);
    lines.push('', `**Spend**: ${money(spendSince)} since the last report; ${money(p.spendToday)} today of ${money(cfg.agents.daily_budget_usd)}.`);
    const holds = events.filter((e) => after(e) && e.type === 'governor.hold').map((e) => e.payload.reason);
    if (holds.length)
        lines.push('', `**Machine**: dispatch held ${holds.length} time(s): ${[...new Set(holds)].slice(0, 3).join('; ')}.`);
    const card = scorecard(events, { from: new Date(now.getTime() - 7 * 86_400_000), to: now });
    lines.push('', '**Scorecard (7 days)**', '', '| metric | now | change |', '|---|---|---|');
    for (const [k, label, dir] of CARD_ROWS) {
        const v = card[k];
        const prev = opts.previous ? opts.previous[k] : null;
        let change = '';
        if (v !== null && prev !== null && v !== prev) {
            const better = dir === 'up-good' ? v > prev : v < prev;
            change = `${v > prev ? '+' : ''}${Math.round((v - prev) * 100) / 100} ${better ? '(better)' : '(worse)'}`;
        }
        lines.push(`| ${label} | ${v === null ? '-' : v} | ${change} |`);
    }
    return { markdown: lines.join('\n'), card };
}
/** The report slot due now (latest configured time already passed today), or null. */
export function dueSlot(times, now = new Date()) {
    const mins = now.getHours() * 60 + now.getMinutes();
    const passed = times.filter((t) => {
        const [h, m] = t.split(':').map(Number);
        return h * 60 + m <= mins;
    });
    return passed.sort().at(-1) ?? null;
}
//# sourceMappingURL=reports.js.map