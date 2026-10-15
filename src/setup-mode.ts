// WHY: a checkout with no config yet has nothing for the dashboard to load, yet that is where a new person starts
// (audit rows 9, 11, 12). Setup mode serves the first-run page alone, on a stand-in config from the templates, and
// drives the same code `init` does: the origin, auto-config's questions and draft (src/auto-config.ts), and the setup
// PR's merge. Once the checkout's own config loads, the CLI hands over to the normal dashboard (src/cli.ts).
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { applyAnswer, emptyAutoConfig, parseAnswer, type Question } from './auto-config.js';
import { BRAND } from './brand.js';
import { loadConfig, type Config } from './config/load.js';
import { autoConfig, newState, readInitState, systemIo, writeInitState, type InitIo, type InitState } from './init.js';
import { gitRemoteRepo, scaffoldConfig } from './install.js';
import { addProjectRepoOk } from './machine.js';
import type { RunResult } from './setup-steps.js';
import { toolPrefix } from './tool-path.js';
import { keyLines, wizardUrl } from './dashboard-detach.js';
import { projectStateDir } from './guardrails/context.js';

export const needsSetupMode = (root: string, instance?: string | null) => !instance && !existsSync(join(root, BRAND.configDir));

/** The checkout's own config loads now: setup mode is over. */
export function configReady(root: string): boolean {
  try {
    loadConfig(root);
    return true;
  } catch {
    return false;
  }
}

/** INVARIANT: a stand-in, read from the templates in a temporary folder and never written into the checkout. */
export function setupModeConfig(root: string, owner?: string): Config {
  const tmp = mkdtempSync(join(tmpdir(), `${BRAND.cli}-setup-mode-`));
  try {
    scaffoldConfig(join(tmp, BRAND.configDir), { name: basename(root), repo: gitRemoteRepo(root) ?? 'owner/repo', ...(owner ? { owner } : {}) });
    return { ...loadConfig(tmp), root };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export class SetupModeError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const stateOf = (file: string, root: string): InitState => {
  const s = readInitState(file) ?? newState('local', root, gitRemoteRepo(root), null);
  s.autoConfig ??= emptyAutoConfig();
  return s;
};

/** Record answers to auto-config's open questions (the same check as `init --answer`); an answered question closes. */
export function saveAnswers(file: string, root: string, given: Record<string, unknown>): { saved: string[]; open: Question[] } {
  const s = stateOf(file, root);
  const ac = s.autoConfig!;
  const errors: string[] = [];
  const saved: string[] = [];
  for (const [id, text] of Object.entries(given)) {
    const q = ac.questions.find((x) => x.id === id);
    if (!q) {
      errors.push(`no open question ${id}`);
      continue;
    }
    const a = typeof text === 'string' ? parseAnswer(q, text) : null;
    const why = a ? applyAnswer(ac, q, a) : `"${String(text)}" isn't an answer to ${id}: ${q.choices.map((c) => c.id).join(', ')}`;
    if (why) errors.push(why);
    else saved.push(id);
  }
  if (errors.length) throw new SetupModeError(errors.join('; '));
  ac.questions = ac.questions.filter((q) => !saved.includes(q.id));
  s.updatedAt = new Date().toISOString();
  writeInitState(file, s);
  return { saved, open: ac.questions };
}

/** The origin a checkout without one gets: the GitHub repo picked, and the commands that set it. */
export function originPlan(root: string, repo: unknown): { repo: string; commands: string[][] } {
  if (!addProjectRepoOk(repo)) throw new SetupModeError('pick a GitHub repo as owner/name');
  if (gitRemoteRepo(root)) throw new SetupModeError(`this checkout's origin is ${gitRemoteRepo(root)} already`);
  const url = `https://github.com/${repo}.git`;
  return { repo, commands: [['git', 'remote', 'add', 'origin', url], ['git', 'fetch', '-q', 'origin']] };
}

export type Run = (cmd: string, args: string[], o?: { cwd?: string }) => RunResult;

export function setOrigin(root: string, repo: unknown, run: Run): string {
  const p = originPlan(root, repo);
  for (const [cmd, ...args] of p.commands) {
    const r = run(cmd!, args, { cwd: root });
    if (r.status !== 0) throw new SetupModeError(`${[cmd, ...args].join(' ')} failed: ${r.stderr.trim().split('\n')[0] ?? ''}`, 500);
  }
  return p.repo;
}

/** The repos this gh login may push to, newest first: the origin picker's choices. */
export function pushableRepos(run: Run): { repos: string[]; error?: string } {
  const r = run('gh', ['api', 'user/repos?per_page=100&sort=pushed', '--jq', '.[] | select(.permissions.push) | .full_name']);
  if (r.status !== 0) return { repos: [], error: `gh couldn't list your repos: ${r.stderr.trim().split('\n')[0] ?? ''}` };
  return { repos: r.stdout.split('\n').map((s) => s.trim()).filter(addProjectRepoOk) };
}

export interface DraftJob {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  lines: string[];
  /** auto-config's answer: what stopped it, or merged (the checkout has its config now). */
  result: { status: 'done' | 'failed' | 'skipped'; detail: string } | { status: 'merged'; detail: string } | null;
}

export const newDraftJob = (): DraftJob => ({ running: false, startedAt: null, finishedAt: null, lines: [], result: null });

/**
 * Run auto-config as `init` does (no terminal: an open question is recorded, never guessed), in the background; the
 * job keeps what it said. It runs the project's commands on a scratch worktree of the default branch, as this user.
 */
export function startDraft(o: { root: string; file: string; job: DraftJob; io?: InitIo }): Promise<void> {
  const j = o.job;
  if (j.running) throw new SetupModeError('auto-config is running already', 409);
  const repo = gitRemoteRepo(o.root);
  if (!repo) throw new SetupModeError('no GitHub origin yet: pick the repo first');
  Object.assign(j, newDraftJob(), { running: true, startedAt: new Date().toISOString() });
  const base = o.io ?? systemIo({ interactive: false });
  const io: InitIo = { ...base, ask: async () => null, say: (l) => void j.lines.push(l.slice(0, 500)) };
  const state = stateOf(o.file, o.root);
  state.repo = repo;
  const save = () => {
    state.updatedAt = new Date().toISOString();
    writeInitState(o.file, state);
  };
  return autoConfig({ mode: 'local', root: o.root, repo, instance: null, prefix: toolPrefix(), yes: false, interactive: false, io, state, save })
    .then((r) => {
      j.result = r ?? { status: 'merged', detail: 'the config is on the default branch and in this checkout' };
    })
    .catch((e: Error) => {
      j.result = { status: 'failed', detail: e.message.split('\n')[0] ?? 'failed' };
    })
    .finally(() => {
      save();
      j.running = false;
      j.finishedAt = new Date().toISOString();
    });
}

/** How the setup PR would be merged: the first method the repo allows, of merge, squash, rebase. */
export function mergeMethod(repo: string, run: Run): string {
  const r = run('gh', ['api', `repos/${repo}`, '--jq', '[.allow_merge_commit, .allow_squash_merge, .allow_rebase_merge] | @csv']);
  if (r.status !== 0) throw new SetupModeError(`can't read ${repo}'s merge settings: ${r.stderr.trim().split('\n')[0] ?? ''}`, 502);
  const allowed = r.stdout.trim().split(',');
  const i = allowed.findIndex((x) => x === 'true');
  if (i < 0) throw new SetupModeError(`${repo} allows no merge method gh can use`);
  return ['merge', 'squash', 'rebase'][i]!;
}

/** The setup PR as init recorded it, and the gh command that merges it; refused unless it is open. */
export function setupPrMerge(file: string, root: string, run: Run): { number: number; url: string; repo: string; command: string[] } {
  const s = readInitState(file);
  const pr = s?.autoConfig?.pr;
  const repo = gitRemoteRepo(root);
  if (!pr?.number || !repo) throw new SetupModeError('no setup PR yet: draft the config first');
  const state = run('gh', ['pr', 'view', String(pr.number), '--repo', repo, '--json', 'state', '--jq', '.state']);
  if (state.status !== 0 || state.stdout.trim() !== 'OPEN') throw new SetupModeError(`PR #${pr.number} isn't open (${state.status === 0 ? state.stdout.trim() : state.stderr.trim().split('\n')[0]})`, 409);
  return { number: pr.number, url: pr.url, repo, command: ['gh', 'pr', 'merge', String(pr.number), '--repo', repo, `--${mergeMethod(repo, run)}`] };
}

/**
 * INVARIANT: what the setup-mode command prints and opens never carries the dashboard's key: the URL is #357's
 * key-free wizard URL, and only the key file's path is named (the page asks for the key once, in a hidden field).
 */
export function setupModeLines(root: string, port: number, o: { bold?: boolean } = {}): { url: string; lines: string[] } {
  const url = wizardUrl(port);
  return {
    url,
    lines: [
      `${BRAND.name} setup for ${root}: no ${BRAND.configDir}/ yet, so the dashboard opens on its first-run page`,
      ...keyLines(join(projectStateDir(root), 'dashboard-token'), o),
      `  ${url}`,
      '(local only; Ctrl+C to stop)',
    ],
  };
}
