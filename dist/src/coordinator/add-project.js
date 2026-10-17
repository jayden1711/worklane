// The coordinator's side of an add-project request (the machine helper's add-project, which runs
// scripts/setup/add-project.sh as root): it runs for minutes and waits on the owner on the way, so it is streamed,
// not run like the helper's one-shot settings. Each JSON line the script prints becomes an `add_project.step` event
// in this instance's log (the audit of every step); an ask line becomes a setup-console ask:
// - the GitHub App's clicks, an approve_link each, answered (approved) once the App step is done, withdrawn if it fails;
// - the agents' Claude token, a paste_secret: the dashboard stores what the owner pastes in this user's secrets
//   directory (src/console/secrets.ts); this hands it to the script's stdin, once, and deletes the file. The token is
//   never in an event, a log line or an argument.
// The script's end is the request's machine.finished: done, or failed with the step and its retry.
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { asks } from '../console/asks.js';
import { secretsDir } from '../console/secrets.js';
import { addProjectCommand, MACHINE_HELPER } from '../machine.js';
export const ADD_PROJECT_STEPS = ['instance', 'app', 'claude-token', 'checkout', 'policy', 'service', 'test-user', 'machine-helper', 'dashboards'];
const STATES = ['started', 'done', 'failed', 'ask', 'waiting'];
/** The paste_secret ask's credential name: the file the dashboard writes it to, in secretsDir(<new instance>). */
export const CLAUDE_TOKEN_CREDENTIAL = 'claude-token';
/** How long the Claude token ask stays open before the step gives up (the script then fails, naming the retry). */
export const SECRET_WAIT_MS = 30 * 60_000;
/** add-project requests this process is running, by request id: their claims are live, never "interrupted". */
export const runningAddProjects = new Map();
/** A progress line, or null when it isn't one (anything else the script wrote to stdout is ignored). */
export function parseStepLine(text) {
    let j;
    try {
        j = JSON.parse(text);
    }
    catch {
        return null;
    }
    if (!j || typeof j !== 'object' || !ADD_PROJECT_STEPS.includes(j.step) || !STATES.includes(j.state))
        return null;
    return {
        step: j.step,
        state: j.state,
        detail: typeof j.detail === 'string' ? j.detail.slice(0, 1000) : '',
        ...(j.ask && typeof j.ask === 'object' ? { ask: j.ask } : {}),
        ...(typeof j.retry === 'string' ? { retry: j.retry.slice(0, 1000) } : {}),
    };
}
const defaultSpawn = (file, args) => spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
/**
 * Run one claimed add-project request to its end, relaying its steps. Resolves once machine.finished is recorded.
 * The caller has checked it (the requester, the allowlist) and claimed it.
 */
export function runAddProject(d, r) {
    const [, name, repo] = r.args;
    const pollMs = d.pollMs ?? 2_000;
    const now = d.now ?? Date.now;
    const a = asks(d.log);
    const appAsks = [];
    let secretAsk = null;
    let lastFailed = null;
    let stderrTail = '';
    const step = (l, extra = {}) => d.log.append('add_project.step', { request_id: r.id, name, repo, step: l.step, state: l.state, detail: l.detail, ...extra, ...(l.retry ? { retry: l.retry } : {}) }, d.instance, 'coordinator');
    const settleAppAsks = (ok, why) => {
        for (const id of appAsks.splice(0)) {
            try {
                if (ok)
                    a.answer(id, { by: r.by, role: 'owner', answer: 'approved' });
                else
                    a.cancel(id, 'coordinator', why);
            }
            catch {
                // answered or withdrawn in the console meanwhile
            }
        }
    };
    return new Promise((done) => {
        let child;
        let finished = false;
        let timer = null;
        const finish = (outcome, detail) => {
            if (finished)
                return;
            finished = true;
            if (timer)
                clearInterval(timer);
            settleAppAsks(false, `add-project ${outcome === 'done' ? 'ended' : 'failed'}`);
            if (secretAsk) {
                try {
                    a.cancel(secretAsk.id, 'coordinator', 'add-project ended before the token was pasted');
                }
                catch {
                    // answered meanwhile
                }
                rmSync(join(secretsDir(name, d.home ?? homedir()), CLAUDE_TOKEN_CREDENTIAL), { force: true });
            }
            d.log.append('machine.finished', { id: r.id, outcome, detail: detail.slice(0, 1000) }, d.instance, 'coordinator');
            done();
        };
        try {
            child = (d.spawn ?? defaultSpawn)('sudo', ['-n', MACHINE_HELPER, 'add-project', name, repo]);
        }
        catch (e) {
            finish('failed', `couldn't start ${MACHINE_HELPER} add-project: ${e.message}`);
            return;
        }
        child.on('error', (e) => finish('failed', `couldn't start ${MACHINE_HELPER} add-project: ${e.message}`));
        child.stdin.on('error', () => {
            // the script exited before reading: its own line says why
        });
        child.stderr.on('data', (c) => (stderrTail = (stderrTail + c.toString('utf8')).slice(-2000)));
        // The pasted token: handed to the script once, then deleted. A withdrawn or expired ask ends stdin empty, and
        // the script fails that step, naming the retry.
        const pollSecret = () => {
            if (!secretAsk)
                return;
            const s = a.get(secretAsk.id);
            const file = join(secretsDir(name, d.home ?? homedir()), CLAUDE_TOKEN_CREDENTIAL);
            if (s?.status === 'answered') {
                secretAsk = null;
                let value = '';
                try {
                    value = readFileSync(file, 'utf8').trim();
                }
                catch {
                    // stored nowhere this user can read: the script gets nothing and says so
                }
                rmSync(file, { force: true });
                child.stdin.end(value ? `${value}\n` : '\n');
                value = '';
            }
            else if (s?.status === 'cancelled' || now() > secretAsk.until) {
                if (s?.status === 'open') {
                    try {
                        a.cancel(secretAsk.id, 'coordinator', 'nobody pasted the token in time');
                    }
                    catch {
                        // answered at the last moment: the next poll would have taken it; the script fails safe either way
                    }
                }
                secretAsk = null;
                child.stdin.end('\n');
            }
        };
        timer = setInterval(pollSecret, pollMs);
        timer.unref?.();
        createInterface({ input: child.stdout }).on('line', (text) => {
            const l = parseStepLine(text);
            if (!l)
                return;
            if (l.state === 'ask') {
                let id;
                try {
                    if (l.ask?.kind === 'approve_link') {
                        id = a.create({ kind: 'approve_link', instance: name, title: str(l.ask.title, 200) || `GitHub, for ${name}`, detail: str(l.ask.detail, 4000) || 'Open the link and approve it on GitHub.', url: str(l.ask.url, 2000) }, 'add-project').id;
                        appAsks.push(id);
                    }
                    else if (l.ask?.kind === 'paste_secret' && l.step === 'claude-token') {
                        rmSync(join(secretsDir(name, d.home ?? homedir()), CLAUDE_TOKEN_CREDENTIAL), { force: true });
                        id = a.create({ kind: 'paste_secret', instance: name, title: str(l.ask.title, 200) || `The Claude login for ${name}'s agents`, detail: str(l.ask.detail, 4000) || 'Paste the token claude setup-token prints.', credential: CLAUDE_TOKEN_CREDENTIAL, where: `wl-${name}-agent's Claude login` }, 'add-project').id;
                        secretAsk = { id, until: now() + SECRET_WAIT_MS };
                    }
                }
                catch (e) {
                    step({ ...l, detail: `${l.detail} (not shown as an ask: ${e.message})` });
                    return;
                }
                step(l, id ? { ask: id } : {});
                return;
            }
            if (l.step === 'app' && (l.state === 'done' || l.state === 'failed'))
                settleAppAsks(l.state === 'done', l.detail);
            // A waiting step (service: the setup PR not merged yet) ends the run too, saying what it waits for.
            if (l.state === 'failed' || l.state === 'waiting')
                lastFailed = l;
            step(l);
        });
        child.on('close', (code) => {
            const f = lastFailed;
            if (code === 0)
                finish('done', `added ${name} (${repo})`);
            else if (f)
                finish('failed', `${f.step}: ${f.detail}${f.retry ? `; retry: ${f.retry}` : ''}`);
            else {
                const said = stderrTail.trim().split('\n').at(-1) ?? '';
                // sudo refused (no rule for it here: an older sudo, or machine-helper.sh not run since): never just a failure; the root command instead.
                const instead = /password is required|not allowed to execute|may not run sudo|not in the sudoers/i.test(stderrTail) ? `; sudo won't run the machine helper's add-project here, so run it at a root shell on the machine: ${addProjectCommand(name, repo)}` : '';
                finish('failed', `${MACHINE_HELPER} add-project exited ${code}: ${said}${instead}`);
            }
        });
    });
}
//# sourceMappingURL=add-project.js.map