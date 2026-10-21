// Auto-config on a server (src/auto-config.ts, wired into scripts/setup/checkout.sh and add-project.sh): the same
// detection, questions, runs on the default branch and setup PR as local mode, for an instance whose repo has no
// config folder yet. Run as the instance's coordinator user, in its checkout. What differs from local mode:
// - GitHub is the instance's App (an installation token, over the REST API), not the person's gh login;
// - the drafted commands run as the instance's agent user, never as the user holding the credentials, in a scratch
//   worktree beside the checkout (group-writable for the agents, like the checkout);
// - the draft is fitted to the instance's policy (budget, workers) and checked against it, so the merged config
//   doesn't stop the coordinator;
// - there is no terminal: open questions are recorded, and answered with `instance auto-config <name> --answer`.
// Its state is the coordinator's own (auto-config.json in the instance's state dir); each run prints one JSON line.
import { gitSpawnSync } from './os/git.js';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import { autoConfigure, emptyAutoConfig, type AutoConfigResult, type AutoConfigState, type RunResult } from './auto-config.js';
import { BRAND } from './brand.js';
import { GITHUB_API } from './github-hosts.js';
import { installationTokens } from './github-app.js';
import { instanceConfigProblems, loadInstanceSetup, type PolicyFile } from './instance.js';
import { machineOwners } from './machine-owners.js';
import { writeOwnerOnly } from './os/index.js';
import { coordinatorUser } from './setup/app-manifest.js';

type Fetch = typeof fetch;

export const githubApiBase = () => GITHUB_API;

const arg = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

/**
 * The few gh calls auto-config makes, answered over GitHub's REST API with an installation token: the default
 * branch, a PR's state, the open PR from a branch, opening a PR. `api user` has no answer (an App's token has no
 * user). Anything else is refused, so a new call can't slip through unanswered.
 */
export function ghOverRest(repo: string, token: () => Promise<string>, api = githubApiBase(), fetchImpl: Fetch = fetch): (args: string[]) => Promise<RunResult> {
  const req = async (method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: unknown }> => {
    const res = await fetchImpl(`${api}${path}`, {
      method,
      headers: { authorization: `Bearer ${await token()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      json = text;
    }
    return { ok: res.ok, status: res.status, json };
  };
  const ok = (stdout: string): RunResult => ({ status: 0, stdout: `${stdout}\n`, stderr: '' });
  const no = (stderr: string): RunResult => ({ status: 1, stdout: '', stderr });
  const http = (r: { status: number; json: unknown }) => no(`HTTP ${r.status}: ${(r.json as { message?: string } | null)?.message ?? 'no message'}`);
  return async (args) => {
    const [a, b] = args;
    const of = arg(args, '--repo') ?? (a === 'repo' && b === 'view' ? args[2] : undefined);
    if (a !== 'api' && of !== repo) return no(`only ${repo} is reachable here, not ${of ?? 'no repo'}`);
    try {
      if (a === 'repo' && b === 'view') {
        const r = await req('GET', `/repos/${repo}`);
        return r.ok ? ok(String((r.json as { default_branch?: string }).default_branch ?? '')) : http(r);
      }
      if (a === 'api' && b === 'user') return no("an App installation's token has no user");
      if (a === 'pr' && b === 'view') {
        const r = await req('GET', `/repos/${repo}/pulls/${Number(args[2])}`);
        if (!r.ok) return http(r);
        const p = r.json as { state?: string; merged?: boolean; merged_at?: string | null };
        return ok(p.merged || p.merged_at ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED');
      }
      if (a === 'pr' && b === 'list') {
        const head = arg(args, '--head');
        const r = await req('GET', `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${repo.split('/')[0]}:${head}`)}`);
        if (!r.ok) return http(r);
        const first = (r.json as { number: number; html_url: string }[])[0];
        return ok(first ? `${first.number} ${first.html_url}` : '');
      }
      if (a === 'pr' && b === 'create') {
        const r = await req('POST', `/repos/${repo}/pulls`, { base: arg(args, '--base'), head: arg(args, '--head'), title: arg(args, '--title'), body: arg(args, '--body') });
        return r.ok ? ok(String((r.json as { html_url?: string }).html_url ?? '')) : http(r);
      }
    } catch (e) {
      return no(`couldn't reach GitHub: ${(e as Error).message}`);
    }
    return no(`gh ${args.slice(0, 2).join(' ')}: not something the App does here`);
  };
}

/** Fit a drafted config folder to an instance's policy: the daily budget and the worker count no higher than it allows. */
export function fitToPolicy(cfgDir: string, policy: PolicyFile): void {
  const file = join(cfgDir, 'agents.yaml');
  const doc = parseDocument(readFileSync(file, 'utf8'));
  const budget = doc.get('daily_budget_usd');
  if (typeof budget === 'number' && budget > policy.budget.daily_usd) doc.set('daily_budget_usd', policy.budget.daily_usd);
  for (const k of ['count', 'max']) {
    const v = doc.getIn(['roles', 'workers', k]);
    if (typeof v === 'number' && v > policy.agents.max_workers) doc.setIn(['roles', 'workers', k], policy.agents.max_workers);
  }
  writeOwnerOnly(file, String(doc));
}

export const serverAutoConfigFile = (stateDir: string) => join(stateDir, 'auto-config.json');

export function readServerAutoConfig(stateDir: string): AutoConfigState {
  try {
    return { ...emptyAutoConfig(), ...(JSON.parse(readFileSync(serverAutoConfigFile(stateDir), 'utf8')) as AutoConfigState) };
  } catch {
    return emptyAutoConfig();
  }
}

export interface ServerAutoConfigLine {
  kind: AutoConfigResult['kind'];
  detail: string;
  /** The setup PR, once proposed. */
  pr: string | null;
  /** The open questions' ids, with the command that answers them. */
  questions: string[];
}

/** Run auto-config for an instance, as its coordinator user: one line saying where it stands. */
export async function serverAutoConfig(name: string, o: { answers?: Record<string, string>; timeoutMs?: number; fetchImpl?: Fetch; owner?: string } = {}): Promise<ServerAutoConfigLine> {
  const i = loadInstanceSetup(name);
  const g = i.credentials.github;
  if (g.kind !== 'app') return { kind: 'failed', detail: `instance ${name} has no GitHub App in credentials.yaml yet: credentials.sh ${name} github-app ... (or add-project's App step)`, pr: null, questions: [] };
  const tokens = installationTokens({ appId: g.app_id, installationId: g.installation_id, keyPath: g.key_path }, [i.repo.repo], i.stateDir, o.fetchImpl ?? fetch, githubApiBase());
  const state = readServerAutoConfig(i.stateDir);
  mkdirSync(i.stateDir, { recursive: true, mode: 0o700 });
  const save = () => writeOwnerOnly(serverAutoConfigFile(i.stateDir), JSON.stringify(state, null, 2) + '\n');
  const identity = { GIT_AUTHOR_NAME: `${name} coordinator`, GIT_AUTHOR_EMAIL: 'noreply@localhost', GIT_COMMITTER_NAME: `${name} coordinator`, GIT_COMMITTER_EMAIL: 'noreply@localhost' };
  const gh = ghOverRest(i.repo.repo, tokens, githubApiBase(), o.fetchImpl ?? fetch);
  const worktrees = join(dirname(i.repo.path), '.setup');
  if (!existsSync(worktrees)) mkdirSync(worktrees, { recursive: true });
  const owner = o.owner ?? machineOwners()[0];
  const r = await autoConfigure({
    root: i.repo.path,
    repo: i.repo.repo,
    state,
    ...(o.answers ? { given: o.answers } : {}),
    ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
    io: {
      git: (args, cwd) => {
        const p = gitSpawnSync(args, { cwd, encoding: 'utf8', env: { ...process.env, ...identity, GIT_TERMINAL_PROMPT: '0', [`${BRAND.envPrefix}_INSTANCE`]: name }, timeout: 300_000 });
        return { status: p.error ? null : p.status, stdout: p.stdout ?? '', stderr: p.error ? p.error.message : (p.stderr ?? '') };
      },
      gh: (args) => gh(args),
      ask: async () => null,
      say: (line) => console.error(line),
    },
    save,
    ...(i.runAs ? { runAs: i.runAs } : {}),
    worktreeRoot: worktrees,
    worktreeStateDir: i.stateDir,
    ...(owner ? { owner } : {}),
    adjust: (cfgDir) => fitToPolicy(cfgDir, i.policy),
    check: (cfg) => instanceConfigProblems(cfg, i.repo.repo, i.policy).map((e) => `${e.file}${e.path ? ` ${e.path}` : ''}: ${e.message}`),
  });
  save();
  const answer = `sudo -H -u ${coordinatorUser(name)} ${BRAND.cli} instance auto-config ${name} --answer <id>=<choice>`;
  const detail = r.kind === 'questions' ? r.detail.replace(/Run `[^`]*` in a terminal to answer, or `[^`]*`/, `answer with \`${answer}\``) : r.kind === 'merged' ? `the config is on ${r.branch}` : r.detail;
  return { kind: r.kind, detail, pr: state.pr?.url ?? null, questions: r.kind === 'questions' ? r.open.map((q) => q.id) : [] };
}
