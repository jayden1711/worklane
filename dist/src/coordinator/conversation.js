// Ideas in conversation (docs/intake.md 2.1.2): a mapped admin or writer posts an idea or an issue in the chat
// channel; the bot opens a thread on it, asks only what it can't settle from the conversation, the decisions
// already made and (with repo access) the code, all in one message per turn; drafts the five-part issue with the
// intake role; shows the draft; and files it `ready` only on an explicit yes from the person who posted it or an
// admin (mayFileReady). Until then the draft is only in the coordinator's private store. Once filed, the thread
// gets the issue's progress from the events: planned, PR opened, merged, live.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { redactString } from '../events/redact.js';
import { ownerOnlyDir, writeOwnerOnly } from '../os/index.js';
import { intakeCaps, researchRepoAccess } from '../settings.js';
import { CONFIRM_TEXT, draftPosts, progressText, questionText, readConfirm, VAGUE_TEXT } from '../intake/channel.js';
import { NEEDS_INFO_REPLY, excerpt } from '../intake/decide.js';
import { candidates as intakeCandidates } from '../intake/dedupe.js';
import { mayAddIdea, mayFileReady, personOf } from '../intake/people.js';
import { redactPii } from '../intake/redact.js';
import { INTAKE_ROLE, intakeRun, writeIntakeBundle } from '../intake/run.js';
import { IntakeMeter, readRaw, reportId, storeRaw } from '../intake/store.js';
import { acceptTriage, checkDraft } from '../intake/triage.js';
import { Channel } from './channel.js';
import { runRoute } from './model-routing.js';
const KIND_LABEL = { bug: 'bug', feature: 'enhancement' };
const OPENED_TEXT = "Thanks. I'll ask only what I can't settle from the code and earlier decisions, then show you a draft to confirm.";
const STUCK_TEXT = "I couldn't turn this into an issue yet. What should change, and how would we know it works?";
export class Conversation extends Channel {
    conversationOn(cfg) {
        return this.channelOn(cfg) && cfg.discord.conversation;
    }
    /** Every idea, from its events: its thread, who posted it, where it stands. */
    ideas() {
        const threads = new Map();
        for (const [t, key] of this.channelThreads())
            if (key.startsWith('idea:'))
                threads.set(key.slice('idea:'.length), t);
        const out = new Map();
        for (const e of this.d.log.read(0, ['discord.idea'])) {
            const p = e.payload;
            if (p.stage === 'opened')
                out.set(p.id, { id: p.id, thread: threads.get(p.id) ?? null, poster: p.by ?? '', stage: 'opened', issue: null, turns: 0 });
            const i = out.get(p.id);
            if (!i || p.stage === 'opened' || p.stage === 'said')
                continue;
            i.stage = p.stage;
            if (p.stage === 'asked' || p.stage === 'drafted' || p.stage === 'failed')
                i.turns++;
            if (p.issue !== null)
                i.issue = p.issue;
        }
        return out;
    }
    draftFile(id) {
        return join(this.d.stateDir, 'intake', 'drafts', `idea-${id}.json`);
    }
    /** Ideas take the chat channel's messages first: new ideas, and replies in their threads. */
    async channelInbound(cfg, reports) {
        if (!this.conversationOn(cfg))
            return super.channelInbound(cfg, reports);
        const byThread = new Map([...this.ideas().values()].filter((i) => i.thread).map((i) => [i.thread, i.id]));
        const mine = reports.filter((r) => r.thread?.kind === 'channel' || (r.thread?.kind === 'thread' && byThread.has(r.thread.id)));
        const out = await super.channelInbound(cfg, reports.filter((r) => !mine.includes(r)));
        const src = this.chatSource();
        const meter = () => new IntakeMeter(this.d.stateDir, intakeCaps(this.d.settings?.().settings ?? {}, cfg.caps), () => (this.d.now?.() ?? new Date()).getTime());
        for (const r of mine) {
            const person = await personOf(cfg, r.sender.id, this.d.intake?.roleOf);
            // Unmapped: ignored entirely, before anything of the message is stored. A viewer opens nothing either.
            if (!person || (r.thread.kind === 'channel' && !mayAddIdea(person.role))) {
                meter().countDrop(person ? 'not_writer' : 'unmapped');
                out.ignored.push(r);
                continue;
            }
            // Each message is taken once (the seen ledger), however often the gateway delivers it.
            if (!storeRaw(this.d.stateDir, r))
                continue;
            if (r.thread.kind === 'channel')
                await this.ideaOpen(cfg, src, r, person);
            else
                await this.ideaReply(cfg, src, r, person, byThread.get(r.thread.id));
        }
        return out;
    }
    async ideaOpen(cfg, src, r, who) {
        const id = reportId(r);
        const name = excerpt(redactPii(r.text, { names: [...(r.sender.name ? [r.sender.name] : []), ...cfg.redact.names], patterns: cfg.redact.patterns }), 80);
        const thread = await this.channelSend(src, `idea:${id}`, { channel: r.thread.id, from: r.sourceId }, { kind: 'thread', name: name || 'idea', text: OPENED_TEXT });
        this.emit('discord.idea', { id, stage: 'opened', by: who.login, msg: id, issue: null, detail: null });
        this.emit('discord.idea', { id, stage: 'said', by: who.login, msg: id, issue: null, detail: null });
        if (!thread) {
            this.emit('discord.idea', { id, stage: 'failed', by: null, msg: null, issue: null, detail: "the thread couldn't be opened" });
            return;
        }
        await this.ideaTurn(cfg, src, this.ideas().get(id));
    }
    async ideaReply(cfg, src, r, who, id) {
        const idea = this.ideas().get(id);
        const thread = idea.thread;
        const msg = reportId(r);
        const say = (text) => this.say(src, thread, `reply:${msg}`, text);
        const isPoster = who.login.toLowerCase() === idea.poster.toLowerCase();
        // Who steers the draft: the person who posted it (an admin or a writer still), or an admin.
        const steers = (isPoster && mayAddIdea(who.role)) || who.role === 'owner';
        const redacted = excerpt(redactPii(r.text, { names: [...(r.sender.name ? [r.sender.name] : []), ...cfg.redact.names], patterns: cfg.redact.patterns }));
        const comment = (why) => {
            this.emit('discord.reply', { id: msg, thread, target: `idea:${id}`, by: who.login, outcome: 'comment', answer: null, excerpt: redacted });
            return say(why);
        };
        if (idea.stage === 'filed' || idea.stage === 'dropped')
            return say(idea.stage === 'filed' ? `This one is filed as #${idea.issue}; follow it there.` : 'This one was dropped; post a new idea to start again.');
        if (idea.stage === 'drafted') {
            const c = readConfirm(r.text);
            if (c === 'yes') {
                if (!mayFileReady(who.role, isPoster))
                    return comment(`Noted, @${who.login}. Only @${idea.poster} or an admin can file this one.`);
                return this.ideaFile(src, idea, who.login);
            }
            if (c === 'vague')
                return say(VAGUE_TEXT);
            if (!steers)
                return comment(`Noted as a comment from @${who.login}. Only @${idea.poster} or an admin can change or file this draft.`);
            if (c === 'no') {
                rmSync(this.draftFile(id), { force: true });
                this.emit('discord.idea', { id, stage: 'dropped', by: who.login, msg, issue: null, detail: null });
                return say('Dropped; nothing was filed.');
            }
        }
        else if (!steers) {
            return comment(`Noted as a comment from @${who.login}. I'm waiting on @${idea.poster} or an admin.`);
        }
        // An answer to the questions, or a change to the draft: another turn with everything said so far.
        this.emit('discord.idea', { id, stage: 'said', by: who.login, msg, issue: null, detail: null });
        await this.ideaTurn(cfg, src, idea);
    }
    /** The conversation so far, redacted, for the agent: what people said, and what the bot asked or drafted. */
    transcript(cfg, id) {
        const lines = [];
        for (const e of this.d.log.read(0, ['discord.idea'])) {
            const p = e.payload;
            if (p.id !== id)
                continue;
            if (p.stage === 'said' && p.msg) {
                const raw = readRaw(this.d.stateDir, p.msg);
                if (raw)
                    lines.push(`**They said:** ${redactPii(raw.text, { names: [...(raw.sender.name ? [raw.sender.name] : []), ...cfg.redact.names], patterns: cfg.redact.patterns })}`);
            }
            else if (p.stage === 'asked' && p.detail)
                lines.push(`**You asked:** ${p.detail}`);
            else if (p.stage === 'drafted') {
                try {
                    const d = JSON.parse(readFileSync(this.draftFile(id), 'utf8'));
                    lines.push(`**You drafted (they have not confirmed it):**\n\n# ${d.title}\n\n${d.body}`);
                }
                catch {
                    lines.push(`**You drafted:** ${p.detail ?? ''}`);
                }
            }
        }
        return lines.join('\n\n');
    }
    /** The decisions made so far (each question and its answer), redacted: what the agent must not ask again. */
    decisionsMade() {
        const asked = new Map(this.d.log.read(0, ['decision.asked']).map((e) => [e.payload.id, e.payload]));
        const lines = this.d.log
            .read(0, ['decision.answered'])
            .map((e) => e.payload)
            .filter((a, i, all) => asked.has(a.id) && all.findIndex((x) => x.id === a.id) === i)
            .slice(-50)
            .map((a) => `- ${redactString(asked.get(a.id).question).slice(0, 300)} -> ${a.answer}${asked.get(a.id).issue !== null ? ` (#${asked.get(a.id).issue})` : ''}`);
        return `# Decisions already made\n\n${lines.length ? lines.join('\n') : '(none yet)'}\n`;
    }
    /** One turn: the intake agent reads the conversation and asks back (one message), or drafts; never files. */
    async ideaTurn(cfg, src, idea) {
        const { id } = idea;
        const thread = idea.thread;
        const turn = idea.turns + 1;
        const fail = (why, text = STUCK_TEXT) => {
            this.emit('discord.idea', { id, stage: 'failed', by: null, msg: null, issue: null, detail: why.slice(0, 500) });
            return this.say(src, thread, `idea:${id}:failed:${turn}`, text);
        };
        const settings = this.d.settings?.().settings ?? {};
        const caps = intakeCaps(settings, cfg.caps);
        const meter = new IntakeMeter(this.d.stateDir, caps, () => (this.d.now?.() ?? new Date()).getTime());
        const can = meter.canDraft();
        if (!can.ok)
            return fail(can.reason, "I've reached today's drafting cap; reply here tomorrow and I'll pick it up.");
        const left = this.d.cfg.agents.daily_budget_usd - this.spentToday();
        if (left <= 0)
            return fail('budget', "Today's budget is spent; reply here tomorrow and I'll pick it up.");
        const talk = this.transcript(cfg, id);
        const open = new Map();
        for (const label of ['ready', ...Object.values(KIND_LABEL)]) {
            try {
                for (const i of await this.d.backlog.list(label))
                    open.set(i.number, { number: i.number, title: i.title, body: i.body });
            }
            catch {
                // a tracker hiccup: fewer candidates
            }
        }
        const shown = intakeCandidates(talk, [...open.values()], []);
        const bundleDir = writeIntakeBundle({ instanceRoot: dirname(this.d.repo), gid: this.d.agentTasks?.gid ?? statSync(this.d.repo).gid, id, name: `idea-${id}-${turn}`, redacted: talk, source: 'discord', candidates: shown, recent: [], decisions: this.decisionsMade() });
        const role = this.d.cfg.agents.roles.researcher ?? this.d.cfg.agents.roles.workers;
        const run = await this.d.runner.run({
            ...intakeRun({ bundleDir, repoAccess: researchRepoAccess(settings), repo: this.d.repo, conversation: true }),
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
            return fail(`the run ended: ${run.reason}`);
        const got = acceptTriage(run.structured);
        if (!got.ok)
            return fail(`not accepted: ${got.why}`);
        const t = got.triage;
        const ask = (text) => {
            this.emit('discord.idea', { id, stage: 'asked', by: null, msg: null, issue: null, detail: text });
            return this.say(src, thread, `idea:${id}:asked:${turn}`, text);
        };
        const dup = t.duplicate_of !== undefined && shown.some((c) => c.issue === t.duplicate_of) ? t.duplicate_of : undefined;
        if (dup !== undefined)
            return ask(`This looks like #${dup}, already open: https://github.com/${this.d.cfg.project.project.repo}/issues/${dup}. Tell me what's different, or reply no to leave it.`);
        if (t.draft && (t.kind === 'bug' || t.kind === 'feature')) {
            const check = checkDraft(t.draft);
            if (!check.ok)
                return ask(questionText(t.reply, NEEDS_INFO_REPLY));
            // Only a draft in the private store until an explicit yes.
            ownerOnlyDir(join(this.d.stateDir, 'intake'));
            ownerOnlyDir(join(this.d.stateDir, 'intake', 'drafts'));
            writeOwnerOnly(this.draftFile(id), JSON.stringify({ title: t.draft.title, body: t.draft.body, labels: KIND_LABEL[t.kind] ? [KIND_LABEL[t.kind]] : [] }));
            this.emit('discord.idea', { id, stage: 'drafted', by: null, msg: null, issue: null, detail: t.draft.title.slice(0, 200) });
            const posts = draftPosts(t.draft);
            for (const [i, text] of posts.entries())
                await this.say(src, thread, `idea:${id}:draft:${turn}:${i}`, text);
            return;
        }
        if (t.kind === 'needs_info')
            return ask(questionText(t.reply, NEEDS_INFO_REPLY));
        return ask(STUCK_TEXT);
    }
    /** File the shown draft `ready`, once (its marker), after an explicit yes from someone mayFileReady allows. */
    async ideaFile(src, idea, by) {
        const file = this.draftFile(idea.id);
        if (!existsSync(file))
            return this.say(src, idea.thread, `idea:${idea.id}:nodraft:${idea.turns}`, `There is no draft to file. ${CONFIRM_TEXT}`);
        const d = JSON.parse(readFileSync(file, 'utf8'));
        const n = await this.intakeFileOnce(idea.id, d.title, `${d.body.trim()}\n\n---\nFrom a chat conversation started by @${idea.poster}; filed on @${by}'s yes.`, ['ready', ...d.labels]);
        this.emit('discord.idea', { id: idea.id, stage: 'filed', by, msg: null, issue: n, detail: null });
        rmSync(file, { force: true });
        await this.say(src, idea.thread, `idea:${idea.id}:filed`, `Filed as ready: #${n} https://github.com/${this.d.cfg.project.project.repo}/issues/${n}. I'll post progress here.`);
    }
    /** Decisions and asks as before, then each filed idea's progress, once per stage: planned, PR opened, merged, live. */
    async channelOutbound(cfg) {
        await super.channelOutbound(cfg);
        if (!this.conversationOn(cfg))
            return;
        const src = this.chatSource();
        const filed = [...this.ideas().values()].filter((i) => i.stage === 'filed' && i.issue !== null && i.thread);
        if (!filed.length)
            return;
        const posted = this.postedKeys();
        const events = this.d.log.read(0, ['plan.posted', 'pr.opened', 'merge.done', 'land.result', 'pr.closed', 'deploy.verified']);
        const repo = this.d.cfg.project.project.repo;
        for (const i of filed) {
            const n = i.issue;
            const mine = events.filter((e) => e.payload.issue === n);
            const plan = mine.find((e) => e.type === 'plan.posted')?.payload;
            const pr = mine.find((e) => e.type === 'pr.opened')?.payload;
            let sha;
            for (const e of mine) {
                const p = e.payload;
                if (e.type === 'merge.done')
                    sha = p.sha;
                else if (e.type === 'land.result' && p.outcome === 'landed')
                    sha ??= p.landed ?? null;
                else if (e.type === 'pr.closed' && p.merged)
                    sha ??= null;
            }
            const live = sha !== undefined ? events.find((e) => e.type === 'deploy.verified' && (e.payload.issue === n || (sha !== null && this.includes(e.payload.sha, sha)))) : undefined;
            const stages = [
                ['planned', plan !== undefined, { issue: n, repo, held: plan?.held ?? false }],
                ['pr', pr !== undefined, { issue: n, repo, ...(pr ? { prUrl: pr.url } : {}) }],
                ['merged', sha !== undefined, { issue: n, repo }],
                ['live', live !== undefined, { issue: n, repo, ...(live ? { env: live.payload.env } : {}) }],
            ];
            for (const [stage, happened, o] of stages) {
                const key = `idea:${i.id}:${stage}`;
                if (happened && !posted.has(key))
                    await this.say(src, i.thread, key, progressText(stage, o));
            }
        }
    }
    /** Does a deploy of `deploy` include the commit `sha` (it, or a later commit on top of it)? */
    includes(deploy, sha) {
        if (deploy === sha)
            return true;
        try {
            execFileSync('git', ['merge-base', '--is-ancestor', sha, deploy], { cwd: this.d.repo, stdio: 'ignore' });
            return true;
        }
        catch {
            return false;
        }
    }
}
//# sourceMappingURL=conversation.js.map