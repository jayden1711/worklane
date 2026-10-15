// WHY: a checkout with no config yet has nothing for the dashboard to load, yet that is where a new person starts
// (audit rows 9, 11, 12). Setup mode serves the first-run page alone, on a stand-in config from the templates, and
// drives the same code `init` does: the origin, auto-config's questions and draft (src/auto-config.ts), and the setup
// PR's merge. Once the checkout's own config loads, the CLI hands over to the normal dashboard (src/cli.ts).
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { applyAnswer, emptyAutoConfig, parseAnswer, proposeHeldDraft, type HeldDraft, type Question } from './auto-config.js';
import { applyConfigValues, repoConfigValues, ConfigChangeError, type ConfigChange, type RepoConfigValues } from './config-change.js';
import { configFrom } from './config/load.js';
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
  // WHY (#468): held for the page's preview; Confirm proposes it (proposeDraft).
  return autoConfig({ mode: 'local', root: o.root, repo, instance: null, prefix: toolPrefix(), yes: false, interactive: false, io, state, save, hold: true })
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

/** What the preview shows first, in plain words: read from the drafted files themselves, never from elsewhere. */
export interface DraftSummary {
  owner: string;
  writers: string[];
  /** The test commands by slot (worktree setup, runner.full / changed / one); unset ones left out. */
  tests: { slot: string; command: string }[];
  dailyBudgetUsd: number;
  /** Each enabled role and its model. */
  models: { role: string; model: string }[];
  /** What waits for the owner, and what may merge by itself. */
  waits: string[];
  autoMerge: string;
}

/** The drafted files as a config, through the same loader the coordinator uses. */
const draftConfig = (root: string, d: HeldDraft) => configFrom(root, (f) => d.yaml[f] ?? null);

/**
 * WHY (#468): the plain-language summary of a held draft, from the same files the preview lists below it (and
 * Confirm proposes): owners and writers, test commands, the daily budget, the models per role, the review levels.
 */
export function draftSummary(root: string, d: HeldDraft): DraftSummary {
  const c = draftConfig(root, d);
  const r = c.tests.runner as { full?: string; changed?: string; one?: string };
  const tests = [
    ...(c.tests.worktree?.setup?.length ? [{ slot: 'setup', command: c.tests.worktree.setup.join(' && ') }] : []),
    ...(['full', 'changed', 'one'] as const).flatMap((k) => (r[k] ? [{ slot: k, command: r[k]! }] : [])),
  ];
  const models = Object.entries(c.agents.roles as Record<string, { enabled: boolean; model: string } | undefined>).flatMap(([role, x]) => (x?.enabled ? [{ role, model: x.model }] : []));
  const rv = c.review;
  const waits = rv
    ? [
        `L3 categories: ${rv.levels.L3_human.when.join(', ') || 'none'}`,
        ...(rv.merge.wait_categories.length ? [`also: ${rv.merge.wait_categories.join(', ')}`] : []),
        `any PR over ${rv.merge.max_lines} changed lines or ${rv.merge.max_files} files`,
        'CI config and dependency changes, design-level changes, and anything the evaluator is unsure of',
      ]
    : ['every PR (no review.yaml)'];
  const autoMerge = !rv || !rv.merge.auto ? 'nothing: every PR waits for you' : `the rest, once its checks pass and the evaluator approves (L0: ${rv.levels.L0_auto.when.join(', ') || 'none'}; L1: ${rv.levels.L1_evaluator.when.join(', ') || 'none'}), and only where the instance policy turns auto-merge on`;
  return { owner: c.project.owners.default, writers: [...c.project.owners.writers], tests, dailyBudgetUsd: c.agents.daily_budget_usd, models, waits, autoMerge };
}

/** The held draft as the page previews it: its summary and its files (read-only), or why it doesn't load. */
export function draftView(root: string, d: HeldDraft | null | undefined): { summary: DraftSummary | null; error: string | null; files: { name: string; text: string }[]; values: RepoConfigValues | null; at: string } | null {
  if (!d) return null;
  const files = Object.entries(d.yaml).map(([name, text]) => ({ name, text }));
  try {
    return { summary: draftSummary(root, d), error: null, files, values: repoConfigValues(draftConfig(root, d)), at: d.at };
  } catch (e) {
    return { summary: null, error: (e as Error).message.split('\n').slice(0, 3).join(' '), files, values: null, at: d.at };
  }
}

/**
 * WHY (#468): Change on the preview, the Repo config form's values applied to the held draft (comments kept): what
 * they change, and with confirm, the draft changed, checked with the same loader first. Nothing is pushed.
 */
export function editDraft(file: string, root: string, values: Record<string, unknown>, confirm: boolean): ConfigChange[] {
  const s = stateOf(file, root);
  const d = s.autoConfig?.draft;
  if (!d) throw new SetupModeError('nothing drafted yet: draft the config first');
  if (s.autoConfig?.pr?.number) throw new SetupModeError(`already proposed in PR #${s.autoConfig.pr.number}: change it there`, 409);
  let e: ReturnType<typeof applyConfigValues>;
  try {
    e = applyConfigValues((f) => d.yaml[f] ?? null, repoConfigValues(draftConfig(root, d)), values, 'the draft');
    configFrom(root, (f) => e.texts[f] ?? d.yaml[f] ?? null);
  } catch (err) {
    if (err instanceof ConfigChangeError) throw new SetupModeError(err.message);
    throw new SetupModeError(`refused: ${(err as Error).message.split('\n').slice(1).map((l) => l.trim()).join('; ') || (err as Error).message}`);
  }
  if (confirm) {
    s.autoConfig!.draft = { ...d, yaml: { ...d.yaml, ...e.texts } };
    s.updatedAt = new Date().toISOString();
    writeInitState(file, s);
  }
  return e.changes;
}

/** WHY (#468): Confirm on the preview: the held draft proposed as the setup PR (auto-config's own push and PR). */
export async function proposeDraft(o: { file: string; root: string; io?: InitIo }): Promise<{ number: number; url: string }> {
  const s = stateOf(o.file, o.root);
  const repo = gitRemoteRepo(o.root);
  if (!repo) throw new SetupModeError('no GitHub origin yet: pick the repo first');
  const base = o.io ?? systemIo({ interactive: false });
  const r = await proposeHeldDraft({
    root: o.root,
    repo,
    state: s.autoConfig!,
    io: { git: (args, cwd) => base.run('git', args, { cwd }), gh: (args, cwd) => base.run('gh', args, { cwd }), ask: async () => null, say: () => {} },
    save: () => {
      s.updatedAt = new Date().toISOString();
      writeInitState(o.file, s);
    },
  });
  if (r.kind !== 'proposed' || !s.autoConfig?.pr?.number) throw new SetupModeError(r.kind === 'proposed' ? 'the PR was opened, but its number could not be read' : 'detail' in r ? r.detail : `not proposed (${r.kind})`, 502);
  return { number: s.autoConfig.pr.number, url: s.autoConfig.pr.url };
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
