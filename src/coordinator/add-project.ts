// The coordinator's side of an add-project request (the machine helper's add-project, which runs
// scripts/setup/add-project.sh as root): it runs for minutes and waits on the owner on the way, so it is streamed,
// not run like the helper's one-shot settings. Each JSON line the script prints becomes an `add_project.step` event
// in this instance's log (the audit of every step); an ask line becomes a setup-console ask:
// - the GitHub App's clicks, an approve_link each, answered (approved) once the App step is done, withdrawn if it fails;
// - the agents' Claude token, a paste_secret: the dashboard stores what the owner pastes in this user's secrets
//   directory (src/console/secrets.ts); this hands it to the script's stdin, once, and deletes the file. The token is
//   never in an event, a log line or an argument.
// The script's end is the request's machine.finished: done, or failed with the step and its retry.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { EventLog } from '../events/log.js';
import { asks } from '../console/asks.js';
import { secretsDir } from '../console/secrets.js';
import { MACHINE_HELPER } from '../machine.js';
import type { MachineRequest } from '../machine-requests.js';

export const ADD_PROJECT_STEPS = ['instance', 'app', 'claude-token', 'checkout', 'policy', 'service', 'test-user', 'machine-helper', 'dashboards'] as const;
export type AddProjectStep = (typeof ADD_PROJECT_STEPS)[number];
const STATES = ['started', 'done', 'failed', 'ask'] as const;
/** The paste_secret ask's credential name: the file the dashboard writes it to, in secretsDir(<new instance>). */
export const CLAUDE_TOKEN_CREDENTIAL = 'claude-token';
/** How long the Claude token ask stays open before the step gives up (the script then fails, naming the retry). */
export const SECRET_WAIT_MS = 30 * 60_000;

export type SpawnHelper = (file: string, args: string[]) => ChildProcessWithoutNullStreams;

export interface AddProjectDeps {
  log: EventLog;
  /** This coordinator's instance (it took the request). */
  instance: string;
  /** How the helper starts: sudo -n <helper> add-project <name> <repo> by default. */
  spawn?: SpawnHelper;
  /** This user's home, where the dashboard stored a pasted secret; the process's own by default. */
  home?: string;
  pollMs?: number;
  now?: () => number;
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
  const pollMs = d.pollMs ?? 2_000;
  const now = d.now ?? Date.now;
  const a = asks(d.log);
  const appAsks: string[] = [];
  let secretAsk: { id: string; until: number } | null = null;
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
    let timer: NodeJS.Timeout | null = null;
    const finish = (outcome: 'done' | 'failed', detail: string) => {
      if (finished) return;
      finished = true;
      if (timer) clearInterval(timer);
      settleAppAsks(false, `add-project ${outcome === 'done' ? 'ended' : 'failed'}`);
      if (secretAsk) {
        try {
          a.cancel(secretAsk.id, 'coordinator', 'add-project ended before the token was pasted');
        } catch {
          // answered meanwhile
        }
        rmSync(join(secretsDir(name, d.home ?? homedir()), CLAUDE_TOKEN_CREDENTIAL), { force: true });
      }
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
      // the script exited before reading: its own line says why
    });
    child.stderr.on('data', (c: Buffer) => (stderrTail = (stderrTail + c.toString('utf8')).slice(-2000)));

    // The pasted token: handed to the script once, then deleted. A withdrawn or expired ask ends stdin empty, and
    // the script fails that step, naming the retry.
    const pollSecret = () => {
      if (!secretAsk) return;
      const s = a.get(secretAsk.id);
      const file = join(secretsDir(name, d.home ?? homedir()), CLAUDE_TOKEN_CREDENTIAL);
      if (s?.status === 'answered') {
        secretAsk = null;
        let value = '';
        try {
          value = readFileSync(file, 'utf8').trim();
        } catch {
          // stored nowhere this user can read: the script gets nothing and says so
        }
        rmSync(file, { force: true });
        child.stdin.end(value ? `${value}\n` : '\n');
        value = '';
      } else if (s?.status === 'cancelled' || now() > secretAsk.until) {
        if (s?.status === 'open') {
          try {
            a.cancel(secretAsk.id, 'coordinator', 'nobody pasted the token in time');
          } catch {
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
      if (!l) return;
      if (l.state === 'ask') {
        let id: string | undefined;
        try {
          if (l.ask?.kind === 'approve_link') {
            id = a.create({ kind: 'approve_link', instance: name, title: str(l.ask.title, 200) || `GitHub, for ${name}`, detail: str(l.ask.detail, 4000) || 'Open the link and approve it on GitHub.', url: str(l.ask.url, 2000) }, 'add-project').id;
            appAsks.push(id);
          } else if (l.ask?.kind === 'paste_secret' && l.step === 'claude-token') {
            rmSync(join(secretsDir(name, d.home ?? homedir()), CLAUDE_TOKEN_CREDENTIAL), { force: true });
            id = a.create({ kind: 'paste_secret', instance: name, title: str(l.ask.title, 200) || `The Claude login for ${name}'s agents`, detail: str(l.ask.detail, 4000) || 'Paste the token claude setup-token prints.', credential: CLAUDE_TOKEN_CREDENTIAL, where: `wl-${name}-agent's Claude login` }, 'add-project').id;
            secretAsk = { id, until: now() + SECRET_WAIT_MS };
          }
        } catch (e) {
          step({ ...l, detail: `${l.detail} (not shown as an ask: ${(e as Error).message})` });
          return;
        }
        step(l, id ? { ask: id } : {});
        return;
      }
      if (l.step === 'app' && (l.state === 'done' || l.state === 'failed')) settleAppAsks(l.state === 'done', l.detail);
      if (l.state === 'failed') lastFailed = l;
      step(l);
    });
    child.on('close', (code) => {
      const f = lastFailed as Line | null;
      if (code === 0) finish('done', `added ${name} (${repo})`);
      else if (f) finish('failed', `${f.step}: ${f.detail}${f.retry ? `; retry: ${f.retry}` : ''}`);
      else finish('failed', `${MACHINE_HELPER} add-project exited ${code}: ${stderrTail.trim().split('\n').at(-1) ?? ''}`);
    });
  });
}
