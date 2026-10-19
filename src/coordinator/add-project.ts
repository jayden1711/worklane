// The coordinator's side of an add-project request (the machine helper's add-project, which runs
// scripts/setup/add-project.sh as root): it runs for minutes and waits on the owner on the way, so it is streamed,
// not run like the helper's one-shot settings. Each JSON line the script prints becomes an `add_project.step` event
// in this instance's log (the audit of every step); an ask line becomes a setup-console ask:
// - the GitHub App's clicks, an approve_link each, answered (approved) once the App step is done, withdrawn if it fails.
// Nothing else: the agents' Claude login is never asked for here (issue #711). A dashboard never takes a Claude
// credential, so the script's claude-token step waits for root to install it on the machine (credentials.sh), and
// this sends the script nothing: its stdin is closed at once.
// The script's end is the request's machine.finished: done, or failed with the step and its retry.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { EventLog } from '../events/log.js';
import { asks } from '../console/asks.js';
import { addProjectCommand, MACHINE_HELPER } from '../machine.js';
import type { MachineRequest } from '../machine-requests.js';

export const ADD_PROJECT_STEPS = ['instance', 'app', 'claude-token', 'checkout', 'policy', 'service', 'test-user', 'machine-helper', 'dashboards'] as const;
export type AddProjectStep = (typeof ADD_PROJECT_STEPS)[number];
const STATES = ['started', 'done', 'failed', 'ask', 'waiting'] as const;

export type SpawnHelper = (file: string, args: string[]) => ChildProcessWithoutNullStreams;

export interface AddProjectDeps {
  log: EventLog;
  /** This coordinator's instance (it took the request). */
  instance: string;
  /** How the helper starts: sudo -n <helper> add-project <name> <repo> by default. */
  spawn?: SpawnHelper;
}

/** add-project requests this process is running, by request id: their claims are live, never "interrupted". */
export const runningAddProjects = new Map<string, Promise<void>>();

interface StepAsk {
  kind?: unknown;
  title?: unknown;
  detail?: unknown;
  url?: unknown;
}

interface Line {
  step: AddProjectStep;
  state: (typeof STATES)[number];
  detail: string;
  ask?: StepAsk;
  retry?: string;
}

/** A progress line, or null when it isn't one (anything else the script wrote to stdout is ignored). */
export function parseStepLine(text: string): Line | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || !(ADD_PROJECT_STEPS as readonly unknown[]).includes(j.step) || !(STATES as readonly unknown[]).includes(j.state)) return null;
  return {
    step: j.step as AddProjectStep,
    state: j.state as Line['state'],
    detail: typeof j.detail === 'string' ? j.detail.slice(0, 1000) : '',
    ...(j.ask && typeof j.ask === 'object' ? { ask: j.ask as StepAsk } : {}),
    ...(typeof j.retry === 'string' ? { retry: j.retry.slice(0, 1000) } : {}),
  };
}

const defaultSpawn: SpawnHelper = (file, args) => spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * Run one claimed add-project request to its end, relaying its steps. Resolves once machine.finished is recorded.
 * The caller has checked it (the requester, the allowlist) and claimed it.
 */
export function runAddProject(d: AddProjectDeps, r: MachineRequest): Promise<void> {
  const [, name, repo] = r.args as [string, string, string];
  const a = asks(d.log);
  const appAsks: string[] = [];
  let lastFailed: Line | null = null;
  let stderrTail = '';
  const step = (l: Line, extra: { ask?: string } = {}) =>
    d.log.append('add_project.step', { request_id: r.id, name, repo, step: l.step, state: l.state, detail: l.detail, ...extra, ...(l.retry ? { retry: l.retry } : {}) }, d.instance, 'coordinator');
  const settleAppAsks = (ok: boolean, why: string) => {
    for (const id of appAsks.splice(0)) {
      try {
        if (ok) a.answer(id, { by: r.by, role: 'owner', answer: 'approved' });
        else a.cancel(id, 'coordinator', why);
      } catch {
        // answered or withdrawn in the console meanwhile
      }
    }
  };

  return new Promise<void>((done) => {
    let child: ChildProcessWithoutNullStreams;
    let finished = false;
    const finish = (outcome: 'done' | 'failed', detail: string) => {
      if (finished) return;
      finished = true;
      settleAppAsks(false, `add-project ${outcome === 'done' ? 'ended' : 'failed'}`);
      d.log.append('machine.finished', { id: r.id, outcome, detail: detail.slice(0, 1000) }, d.instance, 'coordinator');
      done();
    };
    try {
      child = (d.spawn ?? defaultSpawn)('sudo', ['-n', MACHINE_HELPER, 'add-project', name, repo]);
    } catch (e) {
      finish('failed', `couldn't start ${MACHINE_HELPER} add-project: ${(e as Error).message}`);
      return;
    }
    child.on('error', (e) => finish('failed', `couldn't start ${MACHINE_HELPER} add-project: ${e.message}`));
    child.stdin.on('error', () => {
      // the script exited first: nothing was to be written anyway
    });
    // INVARIANT (issue #711): nothing is ever written to the script's stdin, where a Claude token once went.
    child.stdin.end();
    child.stderr.on('data', (c: Buffer) => (stderrTail = (stderrTail + c.toString('utf8')).slice(-2000)));

    createInterface({ input: child.stdout }).on('line', (text) => {
      const l = parseStepLine(text);
      if (!l) return;
      if (l.state === 'ask') {
        let id: string | undefined;
        try {
          // Only a GitHub link to approve: any other ask (an earlier script's paste_secret for the Claude token
          // included) opens nothing, so no paste box takes a credential for this.
          if (l.ask?.kind === 'approve_link') {
            id = a.create({ kind: 'approve_link', instance: name, title: str(l.ask.title, 200) || `GitHub, for ${name}`, detail: str(l.ask.detail, 4000) || 'Open the link and approve it on GitHub.', url: str(l.ask.url, 2000) }, 'add-project').id;
            appAsks.push(id);
          }
        } catch (e) {
          step({ ...l, detail: `${l.detail} (not shown as an ask: ${(e as Error).message})` });
          return;
        }
        step(l, id ? { ask: id } : {});
        return;
      }
      if (l.step === 'app' && (l.state === 'done' || l.state === 'failed')) settleAppAsks(l.state === 'done', l.detail);
      // A waiting step (service: the setup PR not merged yet; claude-token: root to install the login) ends the run
      // too, saying what it waits for.
      if (l.state === 'failed' || l.state === 'waiting') lastFailed = l;
      step(l);
    });
    child.on('close', (code) => {
      const f = lastFailed as Line | null;
      if (code === 0) finish('done', `added ${name} (${repo})`);
      else if (f) finish('failed', `${f.step}: ${f.detail}${f.retry ? `; retry: ${f.retry}` : ''}`);
      else {
        const said = stderrTail.trim().split('\n').at(-1) ?? '';
        // sudo refused (no rule for it here: an older sudo, or machine-helper.sh not run since): never just a failure; the root command instead.
        const instead = /password is required|not allowed to execute|may not run sudo|not in the sudoers/i.test(stderrTail) ? `; sudo won't run the machine helper's add-project here, so run it at a root shell on the machine: ${addProjectCommand(name, repo)}` : '';
        finish('failed', `${MACHINE_HELPER} add-project exited ${code}: ${said}${instead}`);
      }
    });
  });
}
