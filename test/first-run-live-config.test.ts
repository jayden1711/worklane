// WHY: a checkout's first-run page must act on the config the checkout has now, not the one its dashboard started
// with, and merging a Repo config PR from the page must bring that config into the checkout (a fast-forward only),
// so the person never restarts the dashboard or runs `git pull` between two steps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { fastForwardCheckout, systemGit } from '../src/checkout-sync.js';
import { loadConfig } from '../src/config/load.js';
import { CONFIG_BRANCH_PREFIX } from '../src/config-change.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { projectStateDir } from '../src/guardrails/context.js';
import type { ActionPlan } from '../src/setup-actions.js';
import type { RunResult, SetupProbe } from '../src/setup-steps.js';
import { asPerson, exampleProject, exampleRoles } from './helpers.js';

process.env[`${BRAND.envPrefix}_STATE_DIR`] = mkdtempSync(join(tmpdir(), 'live-config-state-'));
const REPO = 'example-org/example-shop';
const CHECKS = '\nrequired_checks: [ci/test]\n';

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A checkout whose origin is a local bare repo, on main, at origin's main; and a second clone to push PR branches from. */
function fixture() {
  const { dir } = exampleProject();
  const bare = join(mkdtempSync(join(tmpdir(), 'live-config-origin-')), 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-q', 'origin', 'main');
  git(dir, 'fetch', '-q', 'origin');
  const other = join(mkdtempSync(join(tmpdir(), 'live-config-other-')), 'other');
  execFileSync('git', ['clone', '-q', bare, other]);
  return { dir, bare, other };
}

/** A config PR as the form pushes it: required_checks added, on a branch of the form's own. */
function proposeChecks(other: string, branch = `${CONFIG_BRANCH_PREFIX}1`) {
  git(other, 'checkout', '-q', '-b', branch, 'origin/main');
  appendFileSync(join(other, BRAND.configDir, 'config.yaml'), CHECKS);
  git(other, 'commit', '-qam', 'config: required checks');
  git(other, 'push', '-q', 'origin', branch);
  return branch;
}

/** gh as the page uses it: the PR, the repo's merge settings, the merge (main moves to the PR branch), protection. */
function github(bare: string, pr: { head: string; state?: string; base?: string }) {
  const calls: string[][] = [];
  const ok = (stdout: string): RunResult => ({ status: 0, stdout, stderr: '' });
  let state = pr.state ?? 'OPEN';
  const gh = (args: string[]): RunResult => {
    calls.push(args);
    const a = args.join(' ');
    if (a.startsWith('pr view 7 ')) return ok(JSON.stringify({ state, headRefName: pr.head, baseRefName: pr.base ?? 'main', url: `https://github.com/${REPO}/pull/7`, title: 'Config from the first-run page: required_checks', mergedAt: state === 'MERGED' ? '2026-10-15T12:00:00Z' : null, mergedBy: state === 'MERGED' ? { login: 'example-owner' } : null }));
    if (a.startsWith(`api repos/${REPO} --jq`)) return ok('false,true,false\n');
    if (a.startsWith(`pr merge 7 --repo ${REPO} --squash `)) {
      execFileSync('git', ['update-ref', 'refs/heads/main', `refs/heads/${pr.head}`], { cwd: bare });
      state = 'MERGED';
      return ok('');
    }
    if (a.includes('/protection')) return args.includes('PUT') ? ok('{}') : { status: 1, stdout: '', stderr: 'gh: Branch not protected (HTTP 404)' };
    return { status: 1, stdout: '', stderr: `no stand-in for gh ${a}` };
  };
  return { gh, calls };
}

const probe: SetupProbe = { which: (c) => `/stand-in/${c}`, run: () => ({ status: 1, stdout: '', stderr: 'stand-in' }), serviceRunning: () => false, systemUnitActive: () => false, linger: () => null };

async function dashboard(dir: string, gh: (args: string[]) => RunResult) {
  const stateDir = projectStateDir(dir);
  mkdirSync(stateDir, { recursive: true });
  // The config it starts with: the checkout's now, before any change.
  const d = await startDashboard({ root: dir, cfg: loadConfig(dir), eventsDb: join(stateDir, 'events.db'), stateDir, user: 'example-owner', roleOf: exampleRoles, slotsDir: mkdtempSync(join(tmpdir(), 'lc-slots-')), webDir: mkdtempSync(join(tmpdir(), 'lc-web-')), setupProbe: probe, setupActions: { gh } });
  const base = d.url.split('/?')[0]!;
  const h = (user: string) => ({ authorization: `Bearer ${d.token}`, ...asPerson(user), 'content-type': 'application/json' });
  const actions = async () => ((await (await fetch(`${base}/api/first-run?fresh=1`, { headers: h('example-owner') })).json()) as { actions: Record<string, ActionPlan> }).actions;
  const post = async (path: string, user: string, body: unknown) => {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: h(user), body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const audit = () => {
    const log = new EventLog(join(stateDir, 'events.db'));
    try {
      return log.read(0, ['dashboard.audit']).map((e) => (e.payload as { action: string }).action);
    } finally {
      log.close();
    }
  };
  return { d, actions, post, audit };
}

test('the first-run actions use the checkout\'s config now: required checks merged and pulled turn Protect on, with no restart', async () => {
  const { dir, bare, other } = fixture();
  const { gh, calls } = github(bare, { head: proposeChecks(other) });
  const s = await dashboard(dir, gh);
  try {
    assert.match((await s.actions()).protection!.why ?? '', /name the required checks first/);
    // The PR merges on GitHub and the person pulls (or the page's merge fast-forwards): the dashboard isn't restarted.
    execFileSync('git', ['update-ref', 'refs/heads/main', `refs/heads/${CONFIG_BRANCH_PREFIX}1`], { cwd: bare });
    git(dir, 'pull', '-q', '--ff-only', 'origin', 'main');
    const plan = (await s.actions()).protection!;
    assert.equal(plan.available, true, plan.why ?? '');
    assert.match(plan.changes[0]!, /checks ci\/test must pass/);
    const r = await s.post('/api/first-run/actions/protection', 'example-owner', { confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const put = calls.find((c) => c.includes('PUT'))!;
    assert.ok(put, 'GitHub was asked to protect main');
  } finally {
    await s.d.close();
  }
});

test('Merge a Repo config PR from the page: the command shown first, owners only, only the form\'s own PR; then the checkout is fast-forwarded and the next step reads the new config', async () => {
  const { dir, bare, other } = fixture();
  const branch = proposeChecks(other);
  const { gh, calls } = github(bare, { head: branch });
  const s = await dashboard(dir, gh);
  try {
    const before = git(dir, 'rev-parse', 'HEAD');
    assert.equal((await s.post('/api/first-run/repo-config/merge', 'example-collaborator', { number: 7, confirm: true })).status, 403);
    const shown = await s.post('/api/first-run/repo-config/merge', 'example-owner', { number: 7 });
    assert.equal(shown.status, 200, JSON.stringify(shown.body));
    assert.equal(shown.body.command, `gh pr merge 7 --repo ${REPO} --squash --subject Config from the first-run page: required_checks (#7), approved by example-owner on the first-run page --body `);
    assert.match(String(shown.body.then), /fast-forwarded to origin's \(only a fast-forward: refused if it has local changes or diverged\)/);
    assert.ok(!calls.some((c) => c[1] === 'merge'), 'nothing merged by the preview');
    const done = await s.post('/api/first-run/repo-config/merge', 'example-owner', { number: 7, confirm: true });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual([done.body.merged, done.body.synced], [true, true]);
    assert.match(String(done.body.detail), /^PR #7 merged by @example-owner at 2026-10-15T12:00:00Z, checkout at [0-9a-f]{7}$/);
    assert.notEqual(git(dir, 'rev-parse', 'HEAD'), before);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), execFileSync('git', ['rev-parse', 'main'], { cwd: bare, encoding: 'utf8' }).trim());
    assert.equal(git(dir, 'rev-list', '--merges', '--count', `${before}..HEAD`), '0', 'no merge commit');
    assert.deepEqual(loadConfig(dir).project.required_checks, ['ci/test']);
    assert.equal((await s.actions()).protection!.available, true, 'the next step reads the new config');
    assert.deepEqual(s.audit().filter((a) => a.startsWith('first_run.config_merge')), ['first_run.config_merge_refused', 'first_run.config_merged']);
  } finally {
    await s.d.close();
  }
  // Only a PR from the page's own branches into the default branch; closed is said as such. (#468: MERGED is not refused.)
  for (const [pr, why] of [[{ head: 'someone/else' }, /isn't one this page proposed/], [{ head: branch, state: 'CLOSED' }, /was closed without merging: nothing to merge; propose it again/], [{ head: branch, base: 'release' }, /is against release, not main/]] as const) {
    const t = await dashboard(fixture().dir, github(bare, pr).gh);
    try {
      const r = await t.post('/api/first-run/repo-config/merge', 'example-owner', { number: 7, confirm: true });
      assert.equal(r.status, 400);
      assert.match(String(r.body.error), why);
    } finally {
      await t.d.close();
    }
  }
});

test('the fast-forward never overwrites the person\'s work: local changes, a diverged branch or another branch are refused, nothing changed', async () => {
  const setup = () => {
    const f = fixture();
    proposeChecks(f.other);
    execFileSync('git', ['update-ref', 'refs/heads/main', `refs/heads/${CONFIG_BRANCH_PREFIX}1`], { cwd: f.bare });
    return f;
  };
  // Uncommitted changes to a tracked file the merge doesn't touch: git alone would carry them; refused here.
  const dirty = setup();
  writeFileSync(join(dirty.dir, 'README.md'), 'my edit\n');
  const head = git(dirty.dir, 'rev-parse', 'HEAD');
  const r1 = fastForwardCheckout('main', systemGit(dirty.dir));
  assert.equal(r1.ok, false);
  assert.match(r1.detail, /uncommitted changes \(1 file\(s\): README\.md\); nothing was changed: commit or stash them, then fast-forward again \(or run `git pull --ff-only origin main`\)/);
  assert.equal(git(dirty.dir, 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(join(dirty.dir, 'README.md'), 'utf8'), 'my edit\n');
  // A local commit origin doesn't have.
  const diverged = setup();
  writeFileSync(join(diverged.dir, 'local.txt'), 'mine\n');
  git(diverged.dir, 'add', 'local.txt');
  git(diverged.dir, 'commit', '-qm', 'mine');
  const mine = git(diverged.dir, 'rev-parse', 'HEAD');
  const r2 = fastForwardCheckout('main', systemGit(diverged.dir));
  assert.equal(r2.ok, false);
  assert.match(r2.detail, /has commits origin's doesn't \(it diverged by 1 commit\(s\) of its own and 1 of origin's\); nothing was changed/);
  assert.equal(git(diverged.dir, 'rev-parse', 'HEAD'), mine);
  // Another branch checked out.
  const elsewhere = setup();
  git(elsewhere.dir, 'checkout', '-q', '-b', 'topic');
  const r3 = fastForwardCheckout('main', systemGit(elsewhere.dir));
  assert.equal(r3.ok, false);
  assert.match(r3.detail, /this checkout is on topic, not main/);
  assert.equal(fastForwardCheckout('--upload-pack=x', systemGit(elsewhere.dir)).ok, false);
  // Already there: nothing to do, ok.
  const there = setup();
  git(there.dir, 'pull', '-q', '--ff-only', 'origin', 'main');
  const r4 = fastForwardCheckout('main', systemGit(there.dir));
  assert.equal(r4.ok, true);
  assert.match(r4.detail, /at origin's already/);
  // Through the page: merged on GitHub, but the checkout is left as it was and the page says why.
  const viaPage = fixture();
  const b = proposeChecks(viaPage.other);
  writeFileSync(join(viaPage.dir, 'README.md'), 'my edit\n');
  const s = await dashboard(viaPage.dir, github(viaPage.bare, { head: b }).gh);
  try {
    const before = git(viaPage.dir, 'rev-parse', 'HEAD');
    const r = await s.post('/api/first-run/repo-config/merge', 'example-owner', { number: 7, confirm: true });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.merged, r.body.synced], [true, false]);
    assert.match(String(r.body.detail), /uncommitted changes/);
    assert.equal(git(viaPage.dir, 'rev-parse', 'HEAD'), before);
  } finally {
    await s.d.close();
  }
});
