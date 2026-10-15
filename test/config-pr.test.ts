// WHY (#468): every config PR the first-run page proposes ends the same way, wherever it is merged: seen as merged
// (never as an error), the checkout fast-forwarded to it when that is safe, and the step done with who merged it, when,
// and where the checkout is. Checked against a real git origin (a bare repo) with a stand-in gh: open, merged by the
// page's button, merged elsewhere, closed without merging, and the two cases the fast-forward refuses (local changes,
// a diverged branch), each saying exactly why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { systemGit } from '../src/checkout-sync.js';
import { loadConfig } from '../src/config/load.js';
import { CONFIG_BRANCH_PREFIX } from '../src/config-change.js';
import { readConfigPrs, refreshConfigPr, trackConfigPr, type ConfigPrRecord } from '../src/config-pr.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { projectStateDir } from '../src/guardrails/context.js';
import type { RunResult, SetupProbe } from '../src/setup-steps.js';
import { asPerson, exampleProject, exampleRoles } from './helpers.js';

process.env[`${BRAND.envPrefix}_STATE_DIR`] = mkdtempSync(join(tmpdir(), 'config-pr-state-'));
const REPO = 'example-org/example-shop';
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A checkout on main at origin's main (a bare repo), and a config PR's branch pushed from a second clone. */
function fixture() {
  const { dir } = exampleProject();
  const bare = join(mkdtempSync(join(tmpdir(), 'config-pr-origin-')), 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-q', 'origin', 'main');
  git(dir, 'fetch', '-q', 'origin');
  const other = join(mkdtempSync(join(tmpdir(), 'config-pr-other-')), 'other');
  execFileSync('git', ['clone', '-q', bare, other]);
  const head = `${CONFIG_BRANCH_PREFIX}20261015-120000`;
  git(other, 'checkout', '-q', '-b', head, 'origin/main');
  appendFileSync(join(other, BRAND.configDir, 'config.yaml'), '\nrequired_checks: [ci/test]\n');
  git(other, 'commit', '-qam', 'config: required checks');
  git(other, 'push', '-q', 'origin', head);
  return { dir, bare, other, head };
}

/** GitHub as gh shows it: one PR (#7) in the state the test sets; a merge (the page's, or GitHub's own) moves main. */
function github(f: ReturnType<typeof fixture>) {
  const calls: string[][] = [];
  const pr = { state: 'OPEN', mergedBy: null as string | null, mergedAt: null as string | null };
  const mergeElsewhere = (by: string) => {
    execFileSync('git', ['update-ref', 'refs/heads/main', `refs/heads/${f.head}`], { cwd: f.bare });
    Object.assign(pr, { state: 'MERGED', mergedBy: by, mergedAt: '2026-10-15T12:00:00Z' });
  };
  const gh = (args: string[]): RunResult => {
    calls.push(args);
    const a = args.join(' ');
    if (a.startsWith('pr view 7 ')) return { status: 0, stdout: JSON.stringify({ state: pr.state, headRefName: f.head, baseRefName: 'main', url: `https://github.com/${REPO}/pull/7`, title: 'Config from the first-run page: required_checks', mergedAt: pr.mergedAt, mergedBy: pr.mergedBy ? { login: pr.mergedBy } : null }), stderr: '' };
    if (a.startsWith(`api repos/${REPO} --jq [`)) return { status: 0, stdout: 'true,true,false\n', stderr: '' };
    if (a === 'api user --jq .login') return { status: 0, stdout: 'example-owner\n', stderr: '' };
    if (a.startsWith('pr merge 7 ')) {
      mergeElsewhere('example-owner');
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `no stand-in for gh ${a}` };
  };
  return { gh, calls, pr, mergeElsewhere };
}

const rec = (base = 'main'): ConfigPrRecord => ({ number: 7, url: `https://github.com/${REPO}/pull/7`, kind: 'config', base, state: 'open', mergedBy: null, mergedAt: null, synced: false, sha: null, why: null, retry: false, command: null, checkedAt: null });

test('#468 a config PR followed to its end: open; closed without merging (said, never an error); merged elsewhere (the checkout fast-forwarded, who and when kept); and nothing asked again once synced', () => {
  const f = fixture();
  const g = github(f);
  const o = { repo: REPO, gh: g.gh, git: systemGit(f.dir) };
  const before = git(f.dir, 'rev-parse', 'HEAD');
  const open = refreshConfigPr(rec(), o);
  assert.deepEqual([open.state, open.synced], ['open', false]);
  assert.equal(git(f.dir, 'rev-parse', 'HEAD'), before, 'an open PR changes nothing here');

  g.pr.state = 'CLOSED';
  const closed = refreshConfigPr(rec(), o);
  assert.equal(closed.state, 'closed');
  assert.match(closed.why!, /^PR #7 was closed without merging: nothing changed; propose it again$/);

  g.pr.state = 'OPEN';
  g.mergeElsewhere('someone-on-github');
  const merged = refreshConfigPr(rec(), o);
  assert.deepEqual([merged.state, merged.synced, merged.mergedBy, merged.mergedAt], ['merged', true, 'someone-on-github', '2026-10-15T12:00:00Z']);
  assert.equal(merged.sha, git(f.bare, 'rev-parse', 'main'));
  assert.equal(git(f.dir, 'rev-parse', 'HEAD'), merged.sha, 'the checkout is at the merge');
  assert.deepEqual(loadConfig(f.dir).project.required_checks, ['ci/test']);
  const calls = g.calls.length;
  assert.equal(refreshConfigPr(merged, o), merged, 'final: nothing asked again');
  assert.equal(g.calls.length, calls);
});

test('#468 merged, but the checkout has local changes: nothing touched, the files named, Fast-forward now offered; once they are gone it syncs', () => {
  const f = fixture();
  const g = github(f);
  g.mergeElsewhere('example-owner');
  writeFileSync(join(f.dir, 'README.md'), 'my edit\n');
  const head = git(f.dir, 'rev-parse', 'HEAD');
  const r = refreshConfigPr(rec(), { repo: REPO, gh: g.gh, git: systemGit(f.dir) });
  assert.deepEqual([r.state, r.synced, r.retry], ['merged', false, true]);
  assert.match(r.why!, /uncommitted changes \(1 file\(s\): README\.md\); nothing was changed: commit or stash them/);
  assert.equal(git(f.dir, 'rev-parse', 'HEAD'), head);
  git(f.dir, 'checkout', '--', 'README.md');
  const again = refreshConfigPr(r, { repo: REPO, gh: g.gh, git: systemGit(f.dir) });
  assert.deepEqual([again.synced, again.why], [true, null]);
});

test('#468 merged, but this checkout diverged: nothing touched, by how many commits each side, and the command to see them (no button: only the person can reconcile)', () => {
  const f = fixture();
  const g = github(f);
  g.mergeElsewhere('example-owner');
  writeFileSync(join(f.dir, 'local.txt'), 'mine\n');
  git(f.dir, 'add', 'local.txt');
  git(f.dir, 'commit', '-qm', 'mine');
  const mine = git(f.dir, 'rev-parse', 'HEAD');
  const r = refreshConfigPr(rec(), { repo: REPO, gh: g.gh, git: systemGit(f.dir) });
  assert.deepEqual([r.state, r.synced, r.retry], ['merged', false, false]);
  assert.match(r.why!, /it diverged by 1 commit\(s\) of its own and 1 of origin's/);
  assert.equal(r.command, 'git log origin/main..main');
  assert.equal(git(f.dir, 'rev-parse', 'HEAD'), mine);
});

const probe: SetupProbe = { which: (c) => `/stand-in/${c}`, run: () => ({ status: 1, stdout: '', stderr: 'stand-in' }), serviceRunning: () => false, systemUnitActive: () => false, linger: () => null };

async function dashboard(dir: string, gh: (args: string[]) => RunResult, user = 'example-owner') {
  const stateDir = projectStateDir(dir);
  mkdirSync(stateDir, { recursive: true });
  const d = await startDashboard({ root: dir, cfg: loadConfig(dir), eventsDb: join(stateDir, 'events.db'), stateDir, user, roleOf: exampleRoles, slotsDir: mkdtempSync(join(tmpdir(), 'cp-slots-')), webDir: mkdtempSync(join(tmpdir(), 'cp-web-')), setupProbe: probe, setupActions: { gh } });
  const base = d.url.split('/?')[0]!;
  const h = (user: string) => ({ authorization: `Bearer ${d.token}`, ...asPerson(user), 'content-type': 'application/json' });
  const get = async () => (await (await fetch(`${base}/api/first-run?fresh=1`, { headers: h('example-owner') })).json()) as { configPrs: ConfigPrRecord[] };
  const post = async (path: string, user: string | null, body: unknown) => {
    // null: the dashboard's own key on this machine, no person named (the break-glass).
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: user ? h(user) : { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const audit = () => {
    const log = new EventLog(join(stateDir, 'events.db'));
    try {
      return log.read(0, ['dashboard.audit']).map((e) => e.payload as { action: string; detail: Record<string, unknown> });
    } finally {
      log.close();
    }
  };
  return { d, get, post, audit, stateDir };
}

test('#468 through the page: Merge here (the one path) merges as the approver and syncs; merged elsewhere is seen on the next look; MERGED is never refused; owners only', async () => {
  const f = fixture();
  const g = github(f);
  const s = await dashboard(f.dir, g.gh);
  try {
    trackConfigPr(s.stateDir, { number: 7, url: `https://github.com/${REPO}/pull/7`, kind: 'config', base: 'main' });
    assert.equal((await s.get()).configPrs[0]!.state, 'open');
    assert.equal((await s.post('/api/first-run/config-pr', 'example-collaborator', { number: 7, action: 'merge', confirm: true })).status, 403);
    const plan = await s.post('/api/first-run/config-pr', 'example-owner', { number: 7, action: 'merge' });
    assert.equal(plan.body.command, `gh pr merge 7 --repo ${REPO} --merge --subject Config from the first-run page: required_checks (#7), approved by example-owner on the first-run page --body `);
    assert.equal(g.calls.some((c) => c[1] === 'merge'), false, 'nothing merged without Confirm');
    const done = await s.post('/api/first-run/config-pr', 'example-owner', { number: 7, action: 'merge', confirm: true });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual([done.body.merged, done.body.synced], [true, true]);
    assert.match(String(done.body.detail), /^PR #7 merged by @example-owner at 2026-10-15T12:00:00Z, checkout at [0-9a-f]{7}$/);
    assert.equal(git(f.dir, 'rev-parse', 'HEAD'), git(f.bare, 'rev-parse', 'main'));
    // Pressed again (or after a merge elsewhere): already merged, so nothing to run, and never an error.
    const again = await s.post('/api/first-run/config-pr', 'example-owner', { number: 7, action: 'merge', confirm: true });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(g.calls.filter((c) => c[1] === 'merge').length, 1);
    const merged = s.audit().filter((e) => e.action === 'first_run.config_merged');
    assert.deepEqual(merged.map((e) => [e.detail.approver, e.detail.here]), [['example-owner', true], ['example-owner', false]]);
    assert.equal(readConfigPrs(s.stateDir)[0]!.synced, true);
  } finally {
    await s.d.close();
  }
  // Merged on GitHub, nobody pressing anything here: the next look fast-forwards and says who.
  const e = fixture();
  const ge = github(e);
  const t = await dashboard(e.dir, ge.gh);
  try {
    trackConfigPr(t.stateDir, { number: 7, url: `https://github.com/${REPO}/pull/7`, kind: 'config', base: 'main' });
    ge.mergeElsewhere('someone-on-github');
    const pr = (await t.get()).configPrs[0]!;
    assert.deepEqual([pr.state, pr.synced, pr.mergedBy], ['merged', true, 'someone-on-github']);
    assert.equal(git(e.dir, 'rev-parse', 'HEAD'), git(e.bare, 'rev-parse', 'main'));
    assert.ok(t.audit().some((x) => x.action === 'first_run.config_pr_synced'));
  } finally {
    await t.d.close();
  }
});

test("#468 the dashboard's own key: the approver is the gh login merging it now, never the login recorded at start (setup mode's placeholder)", async () => {
  const f = fixture();
  const g = github(f);
  const s = await dashboard(f.dir, g.gh, 'your-github-handle');
  try {
    trackConfigPr(s.stateDir, { number: 7, url: `https://github.com/${REPO}/pull/7`, kind: 'config', base: 'main' });
    const plan = await s.post('/api/first-run/config-pr', null, { number: 7, action: 'merge' });
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
    assert.match(String(plan.body.command), /--subject .* \(#7\), approved by example-owner on the first-run page --body $/);
    assert.doesNotMatch(String(plan.body.command), /your-github-handle/);
    assert.equal((await s.post('/api/first-run/config-pr', null, { number: 7, action: 'merge', confirm: true })).status, 200);
    assert.equal(s.audit().find((e) => e.action === 'first_run.config_merged')!.detail.approver, 'example-owner');
  } finally {
    await s.d.close();
  }
});
