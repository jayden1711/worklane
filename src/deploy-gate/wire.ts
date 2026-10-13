// The deploy gate's real git and GitHub calls, and setting it up at coordinator start (only with tests.yaml
// deploy_gate, and only once the instance's test runs are set up: the gate runs its tiers through them).
import { spawnSync } from 'node:child_process';
import type { Config } from '../config/load.js';
import type { EventLog } from '../events/log.js';
import { classifyGitHubError } from '../github/errors.js';
import { checkNamesFor, postChecks, startTestRun, type TestRunResult } from '../testrun/index.js';
import type { IncidentSink } from '../usage-limit.js';
import { DEPLOY_GATE_CHECK } from './config.js';
import { DeployGate, refUpdateBody, type DeployRefs, type GateGit, type RefResult } from './gate.js';

type Fetch = typeof fetch;

/** The gate's git over the coordinator's clone: both branches fetched (the deploy branch only when it exists). */
export function gateGit(repo: string, remote: string, main: string, deploy: string): GateGit {
  const git = (...a: string[]) => spawnSync('git', a, { cwd: repo, encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
  return {
    fetch: () => {
      const ls = git('ls-remote', remote, `refs/heads/${deploy}`);
      if (ls.status !== 0) throw new Error(`git ls-remote failed: ${(ls.stderr || '').trim().slice(0, 300)}`);
      const exists = ls.stdout.trim() !== '';
      const f = git('fetch', '-q', remote, `+refs/heads/${main}:refs/remotes/${remote}/${main}`, ...(exists ? [`+refs/heads/${deploy}:refs/remotes/${remote}/${deploy}`] : []));
      if (f.status !== 0) throw new Error(`git fetch failed: ${(f.stderr || '').trim().slice(0, 300)}`);
      const rev = (ref: string) => {
        const r = git('rev-parse', '--verify', '-q', `${ref}^{commit}`);
        return r.status === 0 ? r.stdout.trim() : null;
      };
      const m = rev(`refs/remotes/${remote}/${main}`);
      if (!m) throw new Error(`no ${main} on ${remote}`);
      return { main: m, deploy: exists ? rev(`refs/remotes/${remote}/${deploy}`) : null };
    },
    isAncestor: (a, b) => git('merge-base', '--is-ancestor', a, b).status === 0,
    onFirstParent: (sha, tip) => git('rev-list', '--first-parent', tip).stdout.split('\n').includes(sha),
    resolve: (ref) => {
      const r = git('rev-parse', '--verify', '-q', `${ref}^{commit}`);
      return r.status === 0 ? r.stdout.trim() || null : null;
    },
    changed: (from, to) => {
      const r = from ? git('diff', '--name-only', '-z', `${from}..${to}`) : git('diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '-m', '--first-parent', to);
      return r.status === 0 ? r.stdout.split('\0').filter(Boolean) : [];
    },
  };
}

/** The deploy branch's ref writes through the App's token: a fast-forward (PATCH, force false) or its creation. */
export function githubDeployRefs(repo: string, branch: string, token: () => Promise<string>, f: Fetch = fetch, api = 'https://api.github.com'): DeployRefs {
  const call = async (method: 'PATCH' | 'POST', url: string, body: object): Promise<RefResult> => {
    const res = await f(url, {
      method,
      headers: { authorization: `Bearer ${await token()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true };
    const text = await res.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { ok: false, status: res.status, message: classifyGitHubError(res.status, Object.fromEntries(res.headers.entries()), json).message };
  };
  return {
    fastForward: (sha) => call('PATCH', `${api}/repos/${repo}/git/refs/heads/${branch}`, refUpdateBody(sha)),
    // Creating a ref can't overwrite one: GitHub answers 422 when it exists.
    create: (sha) => call('POST', `${api}/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: refUpdateBody(sha).sha }),
  };
}

export interface DeployGateSetup {
  /** owner/name */
  repo: string;
  token: () => Promise<string>;
  api?: string;
}

/** The gate, when tests.yaml has deploy_gate and the test runs are set up; else undefined (and why, in the log). */
export function setupDeployGate(cfg: Config, s: DeployGateSetup, d: { log: EventLog; actor: string; root: string; stateDir: string; remote?: string; testRunsReady: boolean; incidents?: IncidentSink }): DeployGate | undefined {
  const config = cfg.tests.deploy_gate;
  const testRun = cfg.tests.test_run;
  if (!config || !testRun) return undefined;
  const fail = (message: string) => {
    d.log.append('coordinator.error', { instance: d.actor, where: 'deploy gate', kind: 'config', message }, d.actor);
    return undefined;
  };
  if (!d.testRunsReady) return fail('deploy_gate is set, but the test runs are not (tests.yaml test_run and the sandbox check): the deploy branch does not move');
  const main = cfg.project.project.default_branch;
  if (config.branch === main) return fail(`deploy_gate.branch can't be the default branch (${main})`);
  const names = checkNamesFor(testRun);
  const gateNames = Object.fromEntries(config.tiers.map((t) => [t, DEPLOY_GATE_CHECK]));
  return new DeployGate({
    config,
    defaultBranch: main,
    git: gateGit(d.root, d.remote ?? 'origin', main, config.branch),
    refs: githubDeployRefs(s.repo, config.branch, s.token, fetch, s.api),
    log: d.log,
    actor: d.actor,
    stateDir: d.stateDir,
    repo: d.root,
    start: (req, o) => startTestRun(req, o),
    post: async (sha: string, result: TestRunResult) => {
      await postChecks(sha, result, names);
      // One check over the gate's tiers: it passes only when every one of them passed (and the run had a verdict).
      const gate: TestRunResult = { ...result, tiers: config.tiers.map((t) => result.tiers.find((r) => r.tier === t) ?? { tier: t, ok: false, durationMs: 0, summary: 'not run', logRef: '' }) };
      await postChecks(sha, gate, gateNames);
    },
    ...(d.incidents ? { incidents: d.incidents } : {}),
  });
}
