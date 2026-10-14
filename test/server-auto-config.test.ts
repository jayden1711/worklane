// Auto-config on a server (src/server-auto-config.ts; the audit's B4 and B5): the setup PR opened through the
// instance's App over GitHub's REST API (the fake GitHub, with the repo on its git root), the draft fitted to the
// instance's policy, and a rerun that reuses what is there (the open PR, or an old setup branch with no PR) instead
// of failing on it.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { BRAND } from '../src/brand.js';
import { autoConfigure, emptyAutoConfig, SETUP_BRANCH, type AutoConfigIo, type AutoConfigOptions } from '../src/auto-config.js';
import { loadConfigAt } from '../src/config/load.js';
import { instanceConfigProblems, PolicyFile } from '../src/instance.js';
import { fitToPolicy, ghOverRest } from '../src/server-auto-config.js';
import { FAKE_INSTALLATION_TOKEN, fakeGitHub } from './fake-github.js';

process.env[`${BRAND.envPrefix}_STATE_DIR`] = mkdtempSync(join(tmpdir(), 'server-ac-state-'));
const REPO = 'example-org/example-shop';
const PASSES = 'node -e "process.exit(0)"';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A checkout whose origin is a bare repo on the fake GitHub's git root, with `files` on main. */
function project(files: Record<string, string>) {
  const base = mkdtempSync(join(tmpdir(), 'server-ac-'));
  const gitRoot = join(base, 'github');
  const bare = join(gitRoot, `${REPO}.git`);
  mkdirSync(dirname(bare), { recursive: true });
  const root = join(base, 'checkout');
  mkdirSync(root);
  git(base, 'init', '-q', '--bare', '-b', 'main', bare);
  git(root, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 'ada@example.com'], ['user.name', 'Ada'], ['commit.gpgsign', 'false']] as const) git(root, 'config', k, v);
  for (const [f, text] of Object.entries(files)) writeFileSync(join(root, f), text);
  git(root, 'add', '--', '.');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'remote', 'add', 'origin', bare);
  git(root, 'push', '-q', 'origin', 'main');
  return { root, bare, gitRoot, ref: (r: string) => spawnSync('git', ['rev-parse', '--verify', '-q', r], { cwd: bare, encoding: 'utf8' }).stdout.trim() };
}

const policy = PolicyFile.parse({ version: 1, budget: { daily_usd: 20 }, agents: { max_workers: 2 } });

function io(gh: ReturnType<typeof ghOverRest>, said: string[] = []): AutoConfigIo {
  return {
    git: (args, cwd) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
    gh: (args) => gh(args),
    ask: async () => null,
    say: (l) => said.push(l),
  };
}

test('ghOverRest: the calls auto-config makes, answered by the App over REST; nothing else, and no other repo', async () => {
  const p = project({ 'README.md': 'shop\n' });
  const fake = await fakeGitHub({ repo: REPO, permissions: {}, installed: true, gitRoot: p.gitRoot });
  try {
    const gh = ghOverRest(REPO, async () => FAKE_INSTALLATION_TOKEN, fake.url);
    assert.deepEqual(await gh(['repo', 'view', REPO, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']), { status: 0, stdout: 'main\n', stderr: '' });
    assert.equal((await gh(['api', 'user', '--jq', '.login'])).status, 1, "an App's token has no user");
    assert.deepEqual(await gh(['pr', 'list', '--repo', REPO, '--head', SETUP_BRANCH, '--state', 'open']), { status: 0, stdout: '\n', stderr: '' });
    assert.match((await gh(['repo', 'view', 'example-org/other'])).stderr, /only example-org\/example-shop is reachable here/);
    assert.match((await gh(['issue', 'list', '--repo', REPO])).stderr, /not something the App does here/);
    const denied = ghOverRest(REPO, async () => 'not-the-token', fake.url);
    assert.match((await denied(['pr', 'list', '--repo', REPO, '--head', SETUP_BRANCH])).stderr, /HTTP 401/);
  } finally {
    await fake.close();
  }
});

test('fitToPolicy: the drafted budget and worker count brought within the instance policy, so the merged config starts the coordinator', () => {
  const dir = mkdtempSync(join(tmpdir(), 'server-ac-fit-'));
  writeFileSync(join(dir, 'agents.yaml'), 'daily_budget_usd: 40        # a comment kept\nroles:\n  workers:   { enabled: true, count: 1, max: 4, model: sonnet }\n');
  fitToPolicy(dir, policy);
  const text = readFileSync(join(dir, 'agents.yaml'), 'utf8');
  const a = parse(text) as { daily_budget_usd: number; roles: { workers: { count: number; max: number } } };
  assert.deepEqual([a.daily_budget_usd, a.roles.workers.count, a.roles.workers.max], [20, 1, 2]);
  assert.match(text, /# a comment kept/);
});

test('server auto-config (audit B4, B5): the setup PR through the App, fitted to the policy; a rerun reuses the open PR or replaces an old setup branch, never stuck on it', async () => {
  const p = project({ 'README.md': 'shop\n' });
  const fake = await fakeGitHub({ repo: REPO, permissions: {}, installed: true, gitRoot: p.gitRoot });
  // What the old checkout.sh left: a worklane/setup branch on origin with no PR, and one in the checkout.
  git(p.root, 'switch', '-q', '-c', SETUP_BRANCH);
  writeFileSync(join(p.root, 'old.txt'), 'old scaffold\n');
  git(p.root, 'add', 'old.txt');
  git(p.root, 'commit', '-q', '-m', 'old scaffold');
  git(p.root, 'push', '-q', 'origin', `HEAD:refs/heads/${SETUP_BRANCH}`);
  git(p.root, 'switch', '-q', 'main');
  const stale = p.ref(`refs/heads/${SETUP_BRANCH}`);
  const main = p.ref('refs/heads/main');
  try {
    const gh = ghOverRest(REPO, async () => FAKE_INSTALLATION_TOKEN, fake.url);
    const said: string[] = [];
    const opts = (state = emptyAutoConfig()): AutoConfigOptions => ({
      root: p.root,
      repo: REPO,
      io: io(gh, said),
      state,
      given: { 'no-test-command': `custom:${PASSES}`, 'one-test-file': 'none' },
      save: () => undefined,
      owner: 'example-owner',
      adjust: (d) => fitToPolicy(d, policy),
      check: (cfg) => instanceConfigProblems(cfg, REPO, policy).map((e) => e.message),
    });
    const state = emptyAutoConfig();
    const r = await autoConfigure(opts(state));
    assert.equal(r.kind, 'proposed', JSON.stringify(r) + said.join('\n'));
    assert.equal(fake.state.pulls.length, 1, 'one PR, opened through the App');
    assert.deepEqual(state.pr, { number: 1, url: `${fake.url}/${REPO}/pull/1`, branch: SETUP_BRANCH });
    assert.match(said.join('\n'), /origin has a worklane\/setup from before \([0-9a-f]{8}\) with no open PR: replacing it with this draft/);
    const drafted = p.ref(`refs/heads/${SETUP_BRANCH}`);
    assert.notEqual(drafted, stale, 'the old setup branch was replaced');
    assert.equal(p.ref('refs/heads/main'), main, 'main untouched');
    git(p.root, 'fetch', '-q', 'origin', SETUP_BRANCH);
    const cfg = loadConfigAt(p.root, `origin/${SETUP_BRANCH}`);
    assert.deepEqual([cfg.agents.daily_budget_usd, cfg.agents.roles.workers?.max, cfg.project.owners.default, cfg.tests.runner.full], [20, 2, 'example-owner', PASSES], 'fitted to the policy; the owner given');
    assert.deepEqual(instanceConfigProblems(cfg, REPO, policy), []);

    // Rerun, state kept: the open PR is checked, nothing opened or pushed again.
    assert.equal((await autoConfigure(opts(state))).kind, 'proposed');
    // Rerun, state lost: the open PR from the setup branch is found and kept as it is (never pushed over).
    const lost = emptyAutoConfig();
    const again = await autoConfigure(opts(lost));
    assert.equal(again.kind, 'proposed', JSON.stringify(again));
    assert.equal(lost.pr?.number, 1);
    assert.equal(fake.state.pulls.length, 1);
    assert.equal(p.ref(`refs/heads/${SETUP_BRANCH}`), drafted);
    assert.match(said.join('\n'), /worklane\/setup already has an open PR \(#1\): kept as it is/);

    // Merged (the branch into main on GitHub): the PR reads as merged, and auto-config says the config is there.
    git(p.bare, 'update-ref', 'refs/heads/main', drafted);
    assert.equal((await gh(['pr', 'view', '1', '--repo', REPO, '--json', 'state', '--jq', '.state'])).stdout, 'MERGED\n');
    assert.deepEqual(await autoConfigure(opts(state)), { kind: 'merged', branch: 'main' });
  } finally {
    await fake.close();
  }
});
