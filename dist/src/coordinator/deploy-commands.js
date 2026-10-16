// The pre-deploy gate in Discord (docs/deploy-gate.md): its posts to the ops channel when the deploy branch moves
// and when it is held, and an owner's override, `deploy <sha>`.
//
// The override: an owner listed in discord.owners whose login is an admin now (the high-risk approvals' rule,
// mayApproveHighRisk) types `deploy <sha>` in a channel the bot reads. The sha must be on the default branch's
// first-parent line. The bot opens a thread asking for an explicit confirm; nothing moves until the same owner
// replies `confirm` there (`cancel` drops it). Then the deploy branch is fast-forwarded by the gate's own path (never
// forced, only to a commit descending from where it is), posted to ops, and audited with the gate's state then.
//
// While tests.yaml has deploy_gate but not `enabled: true`, the gate is off: `deploy <sha>` is refused, saying so.
import { auditWrite } from '../decide.js';
import { mayApproveHighRisk, personOf } from '../intake/people.js';
import { markSeen, reportId } from '../intake/store.js';
import { ChannelChat } from './channel-chat.js';
import { DEPLOY_GATE_OFF } from '../deploy-gate/config.js';
import { postDeployMessage } from '../deploy-gate/post-deploy.js';
/** `deploy <sha>`: the sha (7 to 40 hex), or null for anything else. */
export function parseDeployCommand(text) {
    const m = text
        .trim()
        .toLowerCase()
        .replace(/^\/\S+\s+/, '')
        .match(/^deploy\s+([0-9a-f]{7,40})[\s.!]*$/);
    return m ? m[1] : null;
}
/** A reply in an override's thread: confirm, cancel, or neither. */
export function parseDeployReply(text) {
    const t = text.trim().toLowerCase().replace(/[\s.!]+$/, '');
    return t === 'confirm' ? 'confirm' : t === 'cancel' ? 'cancel' : null;
}
const short = (sha) => sha.slice(0, 8);
export class DeployCommands extends ChannelChat {
    /** The override threads' targets start with this. */
    static TARGET = 'deploy:';
    /** The gate is configured (on, or off and refusing). */
    deployOn(cfg) {
        return (!!this.liveDeployGate || this.gateOff()) && this.channelOn(cfg);
    }
    /** tests.yaml has deploy_gate, switched off (no `enabled: true`). */
    gateOff() {
        const g = this.d.cfg.tests.deploy_gate;
        return !!g && !g.enabled;
    }
    /** Overrides first: `deploy <sha>` in a channel the bot reads, and replies in an override's thread. */
    async channelInbound(cfg, reports) {
        if (!this.deployOn(cfg))
            return super.channelInbound(cfg, reports);
        const threads = this.channelThreads();
        const isMine = (r) => (r.thread?.kind === 'thread' && (threads.get(r.thread.id) ?? '').startsWith(DeployCommands.TARGET)) || ((r.thread?.kind === 'channel' || r.thread?.kind === 'chat') && parseDeployCommand(r.text) !== null);
        const mine = reports.filter(isMine);
        const out = await super.channelInbound(cfg, reports.filter((r) => !isMine(r)));
        const src = this.chatSource();
        for (const r of mine) {
            const person = await personOf(cfg, r.sender.id, this.d.intake?.roleOf);
            // Unmapped: ignored entirely, before anything of the message is stored.
            if (!person) {
                out.ignored.push(r);
                continue;
            }
            // Each message is taken once, however often the gateway delivers it.
            if (!markSeen(this.d.stateDir, r))
                continue;
            if (r.thread.kind === 'thread')
                await this.deployReply(cfg, src, r, person, r.thread.id, threads.get(r.thread.id));
            else
                await this.deployCommand(cfg, src, r, person);
        }
        return out;
    }
    /** The override thread's ask, if it is still waiting: the latest record for it is `asked`. */
    pendingOverride(id) {
        const last = this.d.log
            .read(0, ['deploy_gate.override'])
            .map((e) => e.payload)
            .filter((p) => p.id === id)
            .at(-1);
        return last?.stage === 'asked' ? last : null;
    }
    async deployCommand(cfg, src, r, who) {
        const gate = this.liveDeployGate;
        const id = reportId(r);
        const ref = parseDeployCommand(r.text);
        const where = { channel: r.thread.id };
        const refuse = (detail) => {
            this.emit('deploy_gate.override', { id, thread: null, sha: ref, by: who.login, stage: 'refused', detail: detail.slice(0, 1000) });
            return this.channelSend(src, `deploy-refused:${id}`, where, { kind: 'notice', text: `Not deployed: ${detail}`.slice(0, 1900) });
        };
        if (!gate || this.gateOff())
            return refuse(`${DEPLOY_GATE_OFF}.`);
        if (!mayApproveHighRisk(cfg, r.sender.id, who.role))
            return refuse(`only an owner listed for Discord approvals, who is an admin of the repo, may deploy from chat (@${who.login} isn't).`);
        const c = gate.checkOverride(ref);
        if (!c.ok)
            return refuse(`${c.reason}.`);
        this.emit('deploy_gate.override', { id, thread: null, sha: c.sha, by: who.login, stage: 'asked', detail: `gate: ${c.gate}` });
        const state = c.gate === 'green' ? 'green on every gate tier' : c.gate === 'red' ? '**red**: a gate tier failed on it' : c.gate === 'running' ? 'still running the gate tiers' : 'not checked by the gate';
        const text = `Deploy \`${short(c.sha)}\` to production by fast-forwarding \`${gate.branch}\` to it? The gate: ${state}. Only @${who.login} can answer: reply **confirm** to move it, or **cancel**. It is never forced: it moves only if \`${gate.branch}\` is behind this commit.`;
        const thread = await this.channelSend(src, `${DeployCommands.TARGET}${id}`, { channel: r.thread.id, from: r.sourceId }, { kind: 'thread', name: `deploy ${short(c.sha)}`, text });
        if (thread)
            src.watch?.(thread);
    }
    async deployReply(cfg, src, r, who, thread, target) {
        const id = target.slice(DeployCommands.TARGET.length);
        const msg = reportId(r);
        const say = (text) => this.say(src, thread, `reply:${msg}`, text.slice(0, 1900));
        const asked = this.pendingOverride(id);
        if (!asked)
            return say('This was answered already; your reply changes nothing.');
        if (!this.liveDeployGate || this.gateOff())
            return say(`Nothing moved: ${DEPLOY_GATE_OFF}.`);
        const answer = parseDeployReply(r.text);
        if (!mayApproveHighRisk(cfg, r.sender.id, who.role) || who.login.toLowerCase() !== asked.by.toLowerCase())
            return say(`Only @${asked.by}, who asked, can confirm or cancel this; nothing moved.`);
        if (answer === null)
            return say('Nothing moved. Reply exactly **confirm** to deploy it, or **cancel**.');
        if (answer === 'cancel') {
            this.emit('deploy_gate.override', { ...asked, thread, stage: 'cancelled', detail: 'cancelled by the owner' });
            return say(`Cancelled: \`${this.liveDeployGate.branch}\` stays where it is.`);
        }
        const got = await this.liveDeployGate.override(asked.sha, who.login);
        const gate = got.gate === null ? 'unknown' : got.gate === 'green' ? 'override while green' : `override while ${got.gate}`;
        auditWrite(this.d.log, { login: who.login, role: who.role, via: 'discord' }, this.d.instance, 'deploy_gate.override', { sha: asked.sha, ok: got.ok, gate, ...(got.ok ? { from: got.from } : { reason: got.reason }) });
        this.emit('deploy_gate.override', { ...asked, thread, stage: got.ok ? 'confirmed' : 'refused', detail: got.ok ? gate : got.reason.slice(0, 1000) });
        return say(got.ok ? `Moved: \`${this.liveDeployGate.branch}\` is at \`${short(asked.sha)}\` (${gate}); the host deploys it next.` : `Not moved: ${got.reason}.`);
    }
    /**
     * Every pass: the gate's moves and holds (tests.yaml deploy_gate.notify: ops), and every post-deploy check that
     * didn't pass (always, while there is an ops channel), once each, in the ops channel.
     */
    async channelOutbound(cfg) {
        await super.channelOutbound(cfg);
        const gate = this.d.cfg.tests.deploy_gate;
        const channel = cfg.discord.ops_channel;
        const src = this.chatSource();
        if (!this.liveDeployGate || !gate || !cfg.discord.enabled || !channel || !src)
            return;
        const repo = this.d.cfg.project.project.repo;
        const link = (sha) => `https://github.com/${repo}/commit/${sha}`;
        const types = gate.notify === 'ops' ? ['deploy_gate.moved', 'deploy_gate.held', 'deploy_gate.post_deploy'] : ['deploy_gate.post_deploy'];
        for (const e of this.d.log.read(0, [...types])) {
            if (e.type === 'deploy_gate.post_deploy') {
                const text = postDeployMessage(e.payload, repo, gate.branch);
                if (text)
                    await this.channelSend(src, `deploy-gate:post:${e.id}`, { channel }, { kind: 'notice', text });
            }
            else if (e.type === 'deploy_gate.moved') {
                const p = e.payload;
                const text = p.override
                    ? `**Deploy override** by @${p.by}: \`${p.branch}\` moved to \`${short(p.to)}\` (${p.gate}), from ${p.from ? `\`${short(p.from)}\`` : 'nothing'}. ${link(p.to)}`
                    : `**Deploy**: \`${p.branch}\` moved to \`${short(p.to)}\`, green on every gate tier, from ${p.from ? `\`${short(p.from)}\`` : 'nothing'}. ${link(p.to)}`;
                await this.channelSend(src, `deploy-gate:moved:${e.id}`, { channel }, { kind: 'notice', text: text.slice(0, 1900) });
            }
            else {
                const p = e.payload;
                const text = `**Deploy held**: \`${short(p.sha)}\` on the default branch didn't pass the gate (${p.reason}). \`${p.branch}\` stays at ${p.deployed ? `\`${short(p.deployed)}\`` : 'nothing'}. ${link(p.sha)}`;
                await this.channelSend(src, `deploy-gate:held:${e.id}`, { channel }, { kind: 'notice', text: text.slice(0, 1900) });
            }
        }
    }
}
//# sourceMappingURL=deploy-commands.js.map