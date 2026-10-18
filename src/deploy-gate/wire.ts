// The deploy gate's real git and GitHub calls, and setting it up at coordinator start (only with tests.yaml
// deploy_gate, and only once the instance's test runs are set up: the gate runs its tiers through them).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { asks } from '../console/asks.js';
import { secretsDir } from '../console/secrets.js';
import type { Config } from '../config/load.js';
import type { EventLog } from '../events/log.js';
import { classifyGitHubError } from '../github/errors.js';
import { checkNamesFor, postChecks, startTestRun, type TestRunResult } from '../testrun/index.js';
import type { IncidentSink } from '../usage-limit.js';
import { DEPLOY_GATE_CHECK, HOST_TOKEN_CREDENTIAL, type PostDeployConfig } from './config.js';
import { DeployGate, refUpdateBody, type DeployRefs, type GateGit, type RefResult } from './gate.js';
import { PostDeploy } from './post-deploy.js';
import { githubDeployments, railwayHost, RAILWAY_API } from './railway.js';

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
      // A rename as both its paths: test selection runs everything when a changed file is gone (#683).
      const r = from ? git('diff', '--name-only', '--no-renames', '-z', `${from}..${to}`) : git('diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', '-m', '--first-parent', to);
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
  /** The instance: its secrets hold the host's token (secretsDir). Absent (a checkout): no token, no rollback. */
  instance?: string;
  /** The coordinator user's home, where the secrets are (tests); the process's own when unset. */
  secretsHome?: string;
  /** The host's GraphQL endpoint (tests point it at a fake); else Railway's. */
  hostApi?: string;
  /** The smoke checks' HTTP (tests). */
  http?: typeof fetch;
  /** The post-deploy check's poll and retry pauses (tests). */
  postDeployPollMs?: number;
  postDeployRetryMs?: number;
  postDeployNow?: () => number;
  /** GitHub's deployments of a commit (tests); else read with the App's token. */
  github?: (sha: string) => Promise<{ total: number; success: number } | null>;
}

/** The host token's file: the instance's secrets, 0400, for the coordinator user only (console/secrets.ts). */
export function hostTokenFile(instance: string, home = homedir()): string {
  return join(secretsDir(instance, home), HOST_TOKEN_CREDENTIAL);
}

/** The stored host token, read now, or null. Never logged. */
export function readHostToken(file: string | null): string | null {
  if (!file || !existsSync(file)) return null;
  try {
    return readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * The post-deploy check, for a gate with deploy_gate.post_deploy. Without a stored token it still smoke-tests and
 * alerts, and asks the owner once (a paste_secret ask in the setup console) for the token a rollback needs.
 */
export function postDeployFor(config: PostDeployConfig, branch: string, s: DeployGateSetup, d: { log: EventLog; actor: string; stateDir: string; incidents?: IncidentSink }, markFailed: (sha: string, reason: string) => void): PostDeploy {
  const file = s.instance ? hostTokenFile(s.instance, s.secretsHome) : null;
  const token = () => readHostToken(file);
  if (s.instance && !token()) {
    const a = asks(d.log);
    const open = a.list({ instance: s.instance, status: 'open' }).some((x) => x.kind === 'paste_secret' && x.credential === HOST_TOKEN_CREDENTIAL);
    if (!open)
      a.create({
        kind: 'paste_secret',
        instance: s.instance,
        title: "The host's API token, for the post-deploy rollback",
        detail: `deploy_gate.post_deploy is on, but no ${config.host} token is stored. Without it, a failed post-deploy check is only reported: production is not rolled back. Paste an account or workspace token (docs/deploy-gate.md, "Post-deploy check"). It is stored for the coordinator only (0400) and never shown, logged or posted.`,
        credential: HOST_TOKEN_CREDENTIAL,
        where: `the instance's secrets, ${HOST_TOKEN_CREDENTIAL} (the coordinator only)`,
      });
  }
  return new PostDeploy({
    config,
    branch,
    host: railwayHost({ project: config.project, environment: config.environment }, token, fetch, s.hostApi ?? RAILWAY_API),
    hasToken: () => token() !== null,
    github: s.github ?? githubDeployments(s.repo, s.token, config.github_environment, fetch, s.api),
    markFailed,
    log: d.log,
    actor: d.actor,
    stateDir: d.stateDir,
    ...(d.incidents ? { incidents: d.incidents } : {}),
    ...(s.http ? { http: s.http } : {}),
    ...(s.postDeployPollMs !== undefined ? { pollMs: s.postDeployPollMs } : {}),
    ...(s.postDeployRetryMs !== undefined ? { retryMs: s.postDeployRetryMs } : {}),
    ...(s.postDeployNow ? { now: s.postDeployNow } : {}),
  });
}

/**
 * The gate, when tests.yaml has deploy_gate with `enabled: true` and the test runs are set up; else undefined (and,
 * when it is on but can't start, why, in the log). Off: nothing is built, so nothing runs, moves, checks or asks.
 */
export function setupDeployGate(cfg: Config, s: DeployGateSetup, d: { log: EventLog; actor: string; root: string; stateDir: string; remote?: string; testRunsReady: boolean; incidents?: IncidentSink }): DeployGate | undefined {
  const config = cfg.tests.deploy_gate;
  const testRun = cfg.tests.test_run;
  if (!config || !config.enabled || !testRun) return undefined;
  const fail = (message: string) => {
    d.log.append('coordinator.error', { instance: d.actor, where: 'deploy gate', kind: 'config', message }, d.actor);
    return undefined;
  };
  if (!d.testRunsReady) return fail('deploy_gate is set, but the test runs are not (tests.yaml test_run and the sandbox check): the deploy branch does not move');
  const main = cfg.project.project.default_branch;
  if (config.branch === main) return fail(`deploy_gate.branch can't be the default branch (${main})`);
  const names = checkNamesFor(testRun);
  const gateNames = Object.fromEntries(config.tiers.map((t) => [t, DEPLOY_GATE_CHECK]));
  let gate: DeployGate | null = null;
  const postDeploy = config.post_deploy ? postDeployFor(config.post_deploy, config.branch, s, d, (sha, reason) => gate?.markFailed(sha, reason)) : undefined;
  gate = new DeployGate({
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
    ...(postDeploy ? { postDeploy } : {}),
  });
  return gate;
}
