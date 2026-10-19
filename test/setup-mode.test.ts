// WHY: setup mode (src/setup-mode.ts) is how a checkout with no config gets one from the browser: the origin, the
// questions, the draft and the setup PR's merge. Checked end to end against a bare repo standing in for GitHub and a
// stand-in gh, through a real dashboard: each step confirmed and owners only, and the checkout gets its config only
// by fast-forwarding to the merged default branch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SETUP_BRANCH } from '../src/auto-config.js';
import { BRAND } from '../src/brand.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { projectStateDir } from '../src/guardrails/context.js';
import { initCommand, readInitState, localInitFile, type InitArgs, type InitIo } from '../src/init.js';
import { logPath } from '../src/service.js';
import { configReady, needsSetupMode, setupModeConfig, setupModeLines } from '../src/setup-mode.js';
import type { RunResult, SetupProbe } from '../src/setup-steps.js';
import { asPerson, engineCli, exampleRoles, repoRoot } from './helpers.js';
import { freePort } from '../src/browser/cdp.js';

process.env[`${BRAND.envPrefix}_STATE_DIR`] = mkdtempSync(join(tmpdir(), 'setup-mode-state-'));

const PASSES = 'node -e "process.exit(0)"';

/** A checkout with no config, its origin a bare repo at a path that reads as github.com/example-org/example-shop. */
function project(withOrigin = true) {
  const base = mkdtempSync(join(tmpdir(), 'sm-repo-'));
  const bare = join(base, 'github.com', 'example-org', 'example-shop.git');
  mkdirSync(dirname(bare), { recursive: true });
  const root = join(base, 'shop');
  mkdirSync(root);
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(base, 'init', '-q', '--bare', '-b', 'main', bare);
  git(root, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 'ada@example.com'], ['user.name', 'Ada'], ['commit.gpgsign', 'false']] as const) git(root, 'config', k, v);
  writeFileSync(join(root, 'README.md'), 'shop\n');
  git(root, 'add', '--', '.');
  git(root, 'commit', '-q', '-m', 'init');
  if (withOrigin) {
    git(root, 'remote', 'add', 'origin', bare);
    git(root, 'push', '-q', 'origin', 'main');
  }
  return { root, bare, git };
}

/**
 * gh as auto-config, the merge and the repo list use it; a merge fast-forwards the bare repo's main to the setup branch
 * (as GitHub's would, by `mergedBy`). `admin`: this login is the repo's admin; `refuse`: GitHub's protection refuses the merge.
 */
function ghStandIn(bare: string, o: { admin?: boolean; refuse?: string } = {}) {
  const calls: string[][] = [];
  const pr = { state: 'OPEN', mergedBy: null as string | null, mergedAt: null as string | null };
  const mergeOnGitHub = (by: string) => {
    execFileSync('git', ['push', '-q', bare, `refs/heads/${SETUP_BRANCH}:refs/heads/main`], { cwd: bare });
    Object.assign(pr, { state: 'MERGED', mergedBy: by, mergedAt: '2026-10-15T12:00:00Z' });
  };
  const gh = (args: string[]): RunResult => {
    calls.push(args);
    const a = args.join(' ');
    if (a.startsWith('repo view')) return { status: 0, stdout: 'main\n', stderr: '' };
    if (a.startsWith('api user/repos')) return { status: 0, stdout: 'example-org/example-shop\nexample-org/other\n', stderr: '' };
    if (a.startsWith('api user')) return { status: 0, stdout: 'example-owner\n', stderr: '' };
    if (a.startsWith('api repos/') && a.endsWith('.permissions.admin')) return { status: 0, stdout: `${!!o.admin}\n`, stderr: '' };
    if (a.startsWith('api repos/')) return { status: 0, stdout: 'false,true,true\n', stderr: '' };
    if (a.startsWith('pr list')) return { status: 0, stdout: '', stderr: '' };
    if (a.startsWith('pr create')) return { status: 0, stdout: 'https://github.com/example-org/example-shop/pull/7\n', stderr: '' };
    if (a.startsWith('pr view') && a.includes('--json state,headRefName')) return { status: 0, stdout: JSON.stringify({ ...pr, mergedBy: pr.mergedBy ? { login: pr.mergedBy } : null, headRefName: SETUP_BRANCH, headRefOid: execFileSync('git', ['rev-parse', `refs/heads/${SETUP_BRANCH}`], { cwd: bare, encoding: 'utf8' }).trim(), baseRefName: 'main', url: 'https://github.com/example-org/example-shop/pull/7', title: `Add ${BRAND.name} config` }), stderr: '' };
    if (a.startsWith('pr view')) return { status: 0, stdout: `${pr.state}\n`, stderr: '' };
    if (a.startsWith('pr merge')) {
      if (o.refuse) return { status: 1, stdout: '', stderr: o.refuse };
      mergeOnGitHub('example-owner');
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `no stand-in for gh ${a}` };
  };
  const run = (cmd: string, args: string[], o: { cwd?: string } = {}): RunResult => {
    if (cmd === 'gh') return gh(args);
    if (cmd === 'git' && args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
    const r = spawnSync(cmd, args, { encoding: 'utf8', ...(o.cwd ? { cwd: o.cwd } : {}) });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return { calls, gh, run, mergeOnGitHub, pr };
}

function initIo(gh: (args: string[]) => RunResult, ask: (q: string) => string | null = () => null, interactive: string[][] = []): InitIo {
  return {
    which: (c) => `/stand-in/${c}`,
    run: (cmd, args, o = {}) => {
      if (cmd === 'git') {
        const r = spawnSync('git', args, { encoding: 'utf8', ...(o.cwd ? { cwd: o.cwd } : {}) });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr };
      }
      const a = args.join(' ');
      if (cmd === 'claude' && args[0] === '-p') return { status: 0, stdout: '{"type":"result","subtype":"success","is_error":false,"result":"ok"}', stderr: '' }; // the login's proof: a minimal real call, answered
      if (cmd === 'claude') return { status: 0, stdout: '{"loggedIn": true, "authMethod": "claude.ai"}', stderr: '' };
      if (cmd === 'gh' && a === 'auth status') return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'gh' && a.endsWith('--jq .permissions.push')) return { status: 0, stdout: 'true\n', stderr: '' };
      if (cmd === 'gh') return gh(args);
      return { status: 1, stdout: '', stderr: 'no stand-in' };
    },
    interactive: async (cmd, args) => (interactive.push([cmd, ...args]), 0),
    ask: async (q) => ask(q),
    say: () => undefined,
    download: async () => undefined,
    plan: () => null,
    addProject: async () => ({ code: 1, steps: {}, last: '' }),
  };
}

const probe = (gh: (args: string[]) => RunResult): SetupProbe => ({
  which: (c) => `/stand-in/${c}`,
  run: (cmd, args, o = {}) => {
    if (cmd === 'git') {
      const r = spawnSync('git', args, { encoding: 'utf8', ...(o.cwd ? { cwd: o.cwd } : {}) });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    }
    if (cmd === 'claude' && args[0] === '-p') return { status: 0, stdout: '{"type":"result","subtype":"success","is_error":false,"result":"ok"}', stderr: '' }; // the login's proof: a minimal real call, answered
    if (cmd === 'claude') return { status: 0, stdout: '{"loggedIn": true}', stderr: '' };
    if (cmd === 'gh' && args.join(' ') === 'auth status') return { status: 0, stdout: '', stderr: '' };
    return gh(args);
  },
  serviceRunning: () => false,
  systemUnitActive: () => false,
  linger: () => null,
});

async function setupDashboard(root: string, g: ReturnType<typeof ghStandIn>) {
  const cfg = setupModeConfig(root, 'example-owner');
  const d = await startDashboard({ root, cfg, eventsDb: logPath(root), stateDir: projectStateDir(root), user: 'example-owner', roleOf: exampleRoles, slotsDir: mkdtempSync(join(tmpdir(), 'sm-slots-')), setupProbe: probe(g.gh), setupMode: { run: g.run, io: initIo(g.gh) } });
  const base = d.url.split('/?')[0]!;
  const h = (user: string) => ({ authorization: `Bearer ${d.token}`, ...asPerson(user), 'content-type': 'application/json' });
  const get = async (path: string, user = 'example-owner') => (await (await fetch(`${base}${path}`, { headers: h(user) })).json()) as Record<string, any>;
  const post = async (path: string, body: unknown, user = 'example-owner') => {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: h(user), body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const drafted = async () => {
    for (let i = 0; i < 600; i++) {
      const j = await get('/api/first-run/setup/draft');
      if (!j.running) return j;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('the draft never finished');
  };
  const audit = () => {
    const log = new EventLog(logPath(root));
    try {
      return log.read(0, ['dashboard.audit']).map((e) => (e.payload as { action: string }).action).filter((a) => a.startsWith('first_run.setup'));
    } finally {
      log.close();
    }
  };
  const auditOf = () => {
    const log = new EventLog(logPath(root));
    try {
      return log.read(0, ['dashboard.audit']).map((e) => e.payload as { action: string; detail: Record<string, unknown> });
    } finally {
      log.close();
    }
  };
  const allAudit = () => auditOf().map((e) => e.action);
  return { d, get, post, drafted, audit, allAudit, auditOf };
}

/** Draft (confirmed), answering any question "none" or with a passing command, until the draft is held for its preview. */
async function toHeld(s: Awaited<ReturnType<typeof setupDashboard>>) {
  for (let i = 0; i < 6; i++) {
    assert.equal((await s.post('/api/first-run/setup/draft', { confirm: true })).status, 202);
    const j = await s.drafted();
    const ac = (await s.get('/api/first-run')).autoConfig;
    if (ac?.held) return ac;
    const answers = Object.fromEntries((ac?.questions ?? []).map((q: { id: string; choices: { id: string }[] }) => [q.id, q.id === 'no-test-command' ? `custom:${PASSES}` : q.choices.some((c) => c.id === 'none') ? 'none' : q.choices[0]!.id]));
    assert.equal((await s.post('/api/first-run/setup/answers', { answers })).status, 200, JSON.stringify(j));
  }
  throw new Error('the draft was never held');
}

test("setup mode's stand-in config: from the templates, with the origin's repo, and nothing written into the checkout", () => {
  const p = project();
  assert.equal(needsSetupMode(p.root), true);
  assert.equal(needsSetupMode(p.root, 'shop'), false, 'an instance never runs in setup mode');
  const cfg = setupModeConfig(p.root, 'example-owner');
  assert.deepEqual([cfg.project.project.repo, cfg.project.owners.default, cfg.root], ['example-org/example-shop', 'example-owner', p.root]);
  assert.equal(existsSync(join(p.root, BRAND.configDir)), false);
  assert.equal(configReady(p.root), false);
});

test('setup mode end to end: the page alone, Start refused; draft (confirmed) asks, answers are saved, the draft proposes a PR; Merge shows its command, merges, and the checkout fast-forwards to its config', async () => {
  const p = project();
  const g = ghStandIn(p.bare);
  const s = await setupDashboard(p.root, g);
  try {
    assert.equal((await s.get('/api/state')).setupMode, true);
    const f = await s.get('/api/first-run');
    assert.equal(f.setupMode, true);
    assert.equal(f.configReady, false);
    assert.equal(f.start.kind, 'unsupported');
    assert.match(f.start.why, /has none yet/);
    assert.equal((await s.post('/api/first-run/start', { confirm: true })).status, 409, 'no coordinator from a stand-in config');

    assert.equal((await s.post('/api/first-run/setup/draft', {})).status, 400, 'the draft runs commands: confirmed first');
    assert.equal((await s.post('/api/first-run/setup/draft', { confirm: true }, 'example-collaborator')).status, 403);
    assert.equal((await s.post('/api/first-run/setup/draft', { confirm: true })).status, 202);
    const first = await s.drafted();
    assert.equal(first.result.status, 'failed');
    assert.match(first.result.detail, /question/);
    const open = (await s.get('/api/first-run')).autoConfig.questions.map((q: { id: string }) => q.id);
    assert.deepEqual(open, ['no-test-command']);

    const bad = await s.post('/api/first-run/setup/answers', { answers: { 'no-test-command': 'maybe' } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /"maybe" isn't an answer to no-test-command/);
    const saved = await s.post('/api/first-run/setup/answers', { answers: { 'no-test-command': `custom:${PASSES}` } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.open, []);
    assert.deepEqual(readInitState(localInitFile(p.root))!.autoConfig!.answers['no-test-command'], { choice: 'custom', command: PASSES });

    // Further questions, if the draft asks any, answered "none" (no single-file runner) until it is drafted.
    const held = await toHeld(s);
    // #468: held for its preview; nothing pushed, no PR, until Confirm.
    assert.equal(held.pr, null);
    assert.ok(held.held.summary, JSON.stringify(held.held));
    assert.equal(g.calls.some((c) => c[0] === 'pr' && c[1] === 'create'), false, 'no PR before Confirm');
    assert.equal(spawnSync('git', ['ls-remote', p.bare, `refs/heads/${SETUP_BRANCH}`], { encoding: 'utf8' }).stdout.trim(), '', 'nothing pushed before Confirm');
    assert.equal(existsSync(join(p.root, BRAND.configDir)), false, 'the checkout is untouched until the merge');
    // Confirm: as a writer refused; without confirm, what it would do (and nothing done).
    assert.equal((await s.post('/api/first-run/setup/propose', { confirm: true }, 'example-collaborator')).status, 403);
    const plan = await s.post('/api/first-run/setup/propose', {});
    assert.equal(plan.status, 200);
    assert.match(plan.body.then, /opens the setup PR for you to merge on GitHub/, 'not the repo admin: no merge from here');
    assert.equal(g.calls.some((c) => c[0] === 'pr' && (c[1] === 'create' || c[1] === 'merge')), false, 'a plan opens and merges nothing');
    const opened = await s.post('/api/first-run/setup/propose', { confirm: true });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.deepEqual([opened.body.number, opened.body.merged, opened.body.url], [7, false, 'https://github.com/example-org/example-shop/pull/7']);
    assert.match(opened.body.why, /PR #7 opened: merge it on GitHub/);
    assert.equal(g.calls.some((c) => c[0] === 'pr' && c[1] === 'merge'), false, 'never merged for someone who is not the admin');

    // The shared merge path (#468): its command first (the approver named in the subject), then the merge.
    const preview = await s.post('/api/first-run/setup/merge', {});
    assert.equal(preview.status, 200);
    assert.equal(preview.body.command, `gh pr merge 7 --repo example-org/example-shop --squash --subject Add ${BRAND.name} config (#7), approved by example-owner on the first-run page --body `, "the repo's first allowed method; the approver in the subject");
    assert.equal(g.calls.some((c) => c[0] === 'pr' && c[1] === 'merge'), false, 'a preview merges nothing');
    assert.equal((await s.post('/api/first-run/setup/merge', { confirm: true }, 'example-collaborator')).status, 403);
    const merged = await s.post('/api/first-run/setup/merge', { confirm: true });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    assert.deepEqual([merged.body.merged, merged.body.synced], [true, true]);
    assert.match(merged.body.detail, /^PR #7 merged by @example-owner at 2026-10-15T12:00:00Z, checkout at [0-9a-f]{7}$/);
    assert.ok(configReady(p.root), 'the checkout fast-forwarded to the merged config');
    assert.equal((await s.get('/api/first-run')).configReady, true);
    const actions = s.audit();
    assert.ok(['first_run.setup_draft', 'first_run.setup_answers', 'first_run.setup_proposed'].every((a) => actions.includes(a)), actions.join(', '));
    assert.equal(s.allAudit().filter((a) => a === 'first_run.config_merged').length, 1);
    assert.equal(actions.filter((a) => a === 'first_run.setup_refused').length, 5, 'draft unconfirmed, draft by a writer, a bad answer, Confirm by a writer, merge by a writer');
  } finally {
    await s.d.close();
  }
});

test('#468 the preview: Change keeps its edits in the draft (nothing pushed); Confirm by the repo admin opens the setup PR and merges it as their approval, and the checkout has it', async () => {
  const p = project();
  const g = ghStandIn(p.bare, { admin: true });
  const s = await setupDashboard(p.root, g);
  try {
    const held = (await toHeld(s)).held;
    // The summary is read from the drafted files themselves.
    const { parse } = await import('yaml');
    const file = (n: string) => parse(held.files.find((f: { name: string }) => f.name === n)!.text);
    assert.equal(held.summary.owner, file('config.yaml').owners.default);
    assert.deepEqual(held.summary.writers, file('config.yaml').owners.writers);
    assert.equal(held.summary.dailyBudgetUsd, file('agents.yaml').daily_budget_usd);
    assert.deepEqual(held.summary.models, Object.entries(file('agents.yaml').roles as Record<string, { enabled: boolean; model: string }>).filter(([, r]) => r.enabled).map(([role, r]) => ({ role, model: r.model })));
    assert.deepEqual(held.summary.tests.find((t: { slot: string }) => t.slot === 'full')?.command, file('tests.yaml').runner.full);
    // Change: what it would change, then (confirmed) the draft changed, comments kept; nothing pushed either way.
    const shown = await s.post('/api/first-run/setup/draft-values', { values: { daily_budget_usd: 12 } });
    assert.equal(shown.status, 200, JSON.stringify(shown.body));
    assert.deepEqual(shown.body.changes, [{ file: `${BRAND.configDir}/agents.yaml`, key: 'daily_budget_usd', from: held.summary.dailyBudgetUsd, to: 12 }]);
    assert.equal((await s.get('/api/first-run')).autoConfig.held.summary.dailyBudgetUsd, held.summary.dailyBudgetUsd, 'not changed without confirm');
    assert.equal((await s.post('/api/first-run/setup/draft-values', { values: { daily_budget_usd: 12 }, confirm: true }, 'example-collaborator')).status, 403);
    assert.equal((await s.post('/api/first-run/setup/draft-values', { values: { daily_budget_usd: 12 }, confirm: true })).status, 200);
    const kept = (await s.get('/api/first-run')).autoConfig.held;
    assert.equal(kept.summary.dailyBudgetUsd, 12);
    assert.equal(kept.values.daily_budget_usd, 12, 'the form reopens with the edit');
    assert.match(kept.files.find((f: { name: string }) => f.name === 'agents.yaml').text, /daily_budget_usd: 12\s+# usage guard/, 'comments kept');
    assert.equal(g.calls.some((c) => c[0] === 'pr'), false);
    // Confirm, as the repo's admin: the PR opened, merged here as their approval, the checkout brought to it.
    const plan = await s.post('/api/first-run/setup/propose', {});
    assert.match(plan.body.then, /merges it here as your approval/);
    const done = await s.post('/api/first-run/setup/propose', { confirm: true });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual([done.body.number, done.body.merged, done.body.synced], [7, true, true]);
    const merge = g.calls.find((c) => c[0] === 'pr' && c[1] === 'merge')!;
    assert.deepEqual(merge.slice(merge.indexOf('--subject'), merge.indexOf('--subject') + 4), ['--subject', `Add ${BRAND.name} config (#7), approved by example-owner on the first-run page`, '--body', ''], 'the approver in the subject, nothing in the body');
    assert.match(spawnSync('git', ['show', `main:${BRAND.configDir}/agents.yaml`], { cwd: p.bare, encoding: 'utf8' }).stdout, /daily_budget_usd: 12/, 'what was previewed and changed is what merged');
    assert.ok(configReady(p.root), 'the checkout has it');
    const approval = s.auditOf().find((e) => e.action === 'first_run.config_merged')!;
    assert.deepEqual([approval.detail.number, approval.detail.approver, approval.detail.synced], [7, 'example-owner', true]);
  } finally {
    await s.d.close();
  }
});

test("#468 the preview's Confirm when GitHub's protection refuses the merge: the PR is opened, its link shown, nothing merged; the page keeps watching and sees a later merge on GitHub", async () => {
  const p = project();
  const g = ghStandIn(p.bare, { admin: true, refuse: 'GraphQL: Base branch policy prohibits the merge (mergePullRequest)' });
  const s = await setupDashboard(p.root, g);
  try {
    await toHeld(s);
    const r = await s.post('/api/first-run/setup/propose', { confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.merged, r.body.url], [false, 'https://github.com/example-org/example-shop/pull/7']);
    assert.match(r.body.why, /PR #7 opened: merge it on GitHub \(GitHub didn't merge PR #7: GraphQL: Base branch policy prohibits the merge/);
    assert.equal(g.pr.state, 'OPEN');
    assert.equal(existsSync(join(p.root, BRAND.configDir)), false);
    // Merged on GitHub, outside the page: the next look sees it, fast-forwards, and the step is done.
    g.mergeOnGitHub('example-owner');
    const f = await s.get('/api/first-run?fresh=1');
    const pr = f.configPrs.find((x: { number: number }) => x.number === 7);
    assert.deepEqual([pr.kind, pr.state, pr.synced, pr.mergedBy], ['setup', 'merged', true, 'example-owner']);
    assert.ok(configReady(p.root));
  } finally {
    await s.d.close();
  }
});

test('setup mode, the origin: the repos this login can push to; Review shows the commands, Confirm sets it; refused once there is one, and for a writer', async () => {
  const p = project(false);
  const g = ghStandIn(p.bare);
  const s = await setupDashboard(p.root, g);
  try {
    assert.deepEqual((await s.get('/api/first-run/setup/repos')).repos, ['example-org/example-shop', 'example-org/other']);
    const preview = await s.post('/api/first-run/setup/origin', { repo: 'example-org/example-shop' });
    assert.deepEqual(preview.body.commands, ['git remote add origin https://github.com/example-org/example-shop.git', 'git fetch -q origin']);
    assert.equal(spawnSync('git', ['remote'], { cwd: p.root, encoding: 'utf8' }).stdout.trim(), '', 'a preview sets nothing');
    assert.equal((await s.post('/api/first-run/setup/origin', { repo: 'example-org/example-shop', confirm: true }, 'example-collaborator')).status, 403);
    assert.equal((await s.post('/api/first-run/setup/origin', { repo: 'not a repo', confirm: true })).status, 400);
    const ok = await s.post('/api/first-run/setup/origin', { repo: 'example-org/example-shop', confirm: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: p.root, encoding: 'utf8' }).stdout.trim(), 'https://github.com/example-org/example-shop.git');
    const again = await s.post('/api/first-run/setup/origin', { repo: 'example-org/other', confirm: true });
    assert.equal(again.status, 400);
    assert.match(again.body.error, /origin is example-org\/example-shop already/);
  } finally {
    await s.d.close();
  }
});

test('a dashboard with its config has no setup routes', async () => {
  const p = project();
  const g = ghStandIn(p.bare);
  const s = await setupDashboard(p.root, g);
  await s.d.close();
  const { exampleProject } = await import('./helpers.js');
  const { loadConfig } = await import('../src/config/load.js');
  const { dir } = exampleProject();
  const d = await startDashboard({ root: dir, cfg: loadConfig(dir), eventsDb: logPath(dir), stateDir: projectStateDir(dir), user: 'example-owner', roleOf: exampleRoles, slotsDir: mkdtempSync(join(tmpdir(), 'sm-slots-')) });
  try {
    const r = await fetch(`${d.url.split('/?')[0]}/api/first-run/setup/draft`, { method: 'POST', headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' }, body: '{"confirm":true}' });
    assert.equal(r.status, 404);
  } finally {
    await d.close();
  }
});

test('init, stopped at the repo config with no config yet, offers the setup page: with a terminal it opens it on yes; without one it names the command', async () => {
  const p = project();
  const g = ghStandIn(p.bare);
  const prefix = mkdtempSync(join(tmpdir(), 'sm-prefix-'));
  const args = (interactive: boolean): InitArgs => ({ target: p.root, mode: 'local', instance: undefined, yes: false, reset: false, cwd: p.root, prefix, interactive });
  const opened: string[][] = [];
  const asked: string[] = [];
  const io = initIo(g.gh, (q) => (asked.push(q), /Finish in the browser/.test(q) ? 'y' : null), opened);
  assert.equal(await initCommand(args(true), io, () => false, async () => null), 1);
  assert.ok(asked.some((q) => /Finish in the browser/.test(q)));
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0]!.slice(2), ['dashboard', '--root', p.root]);
  assert.match(opened[0]![1]!, /cli\.js$/);
  const said: string[] = [];
  const quiet = { ...initIo(g.gh), say: (l: string) => void said.push(l) };
  assert.equal(await initCommand(args(false), quiet, () => false, async () => null), 1);
  assert.ok(said.some((l) => l === `or finish in the browser: \`${BRAND.cli} dashboard --root ${p.root}\` opens the setup page`), said.join('\n'));
});

test("what setup mode prints and opens: the key-free wizard URL and the key file's path, never the key", () => {
  const shown = setupModeLines('/r', 4317);
  assert.equal(shown.url, 'http://127.0.0.1:4317/first-run');
  assert.equal(shown.lines.filter((l) => l.includes('http')).join(), '  http://127.0.0.1:4317/first-run');
  assert.match(shown.lines.join('\n'), /the page asks once for the dashboard key, in this file \(only you can read it\):\n {4}\S.*dashboard-token\n/);
  assert.doesNotMatch(shown.lines.join('\n'), /[?&]t=/);
});

test('`dashboard` on a checkout with no config: setup mode at the given address, the key never printed; once the config is in, the dashboard on the same address and key', async () => {
  const p = project();
  const port = await freePort();
  const env = { ...process.env, [`${BRAND.envPrefix}_STATE_DIR`]: mkdtempSync(join(tmpdir(), 'sm-cli-state-')), PATH: '/usr/bin:/bin' };
  const child = spawn(process.execPath, [engineCli, 'dashboard', '--root', p.root, '--no-open', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let printed = '';
  child.stdout.on('data', (d) => (printed += d));
  child.stderr.on('data', (d) => (printed += d));
  const waitFor = async (re: RegExp) => {
    for (let i = 0; i < 300 && !re.test(printed); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(printed, re);
  };
  try {
    await waitFor(new RegExp(`no ${BRAND.configDir.replace('.', '\\.')}/ yet[\\s\\S]*\\n  http://127\\.0\\.0\\.1:${port}/first-run\\n`));
    // The key: only its file's path is printed; the key itself is read from that 0600 file, never from a URL.
    const keyFile = /the dashboard key, in this file \(only you can read it\):\n {4}(.+)\n/.exec(printed)![1]!;
    const token = readFileSync(keyFile, 'utf8').trim();
    assert.match(token, /^[A-Za-z0-9_-]{16,}$/);
    assert.equal(statSync(keyFile).mode & 0o077, 0, 'the key file is the owner\'s alone');
    const noKeyInOutput = () => {
      assert.equal(printed.includes(token), false, 'the key is never printed');
      assert.doesNotMatch(printed, /[?&]t=/, 'no URL carries a key');
    };
    noKeyInOutput();
    const state = async () => (await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { authorization: `Bearer ${token}` } })).json()) as { setupMode?: boolean };
    assert.equal((await state()).setupMode, true);
    // The config arrives (here: copied in, as the fast-forward would bring it).
    cpSync(join(repoRoot, 'examples', 'basic', BRAND.configDir), join(p.root, BRAND.configDir), { recursive: true });
    // #418: the URL carries no key and is followed by the key file's note (keyFileNote).
    await waitFor(new RegExp(`switching to the dashboard[\\s\\S]*http://127\\.0\\.0\\.1:${port} \\(the page asks for the key once: it is in `));
    assert.equal((await state()).setupMode, false, 'the normal dashboard, same address and key');
    noKeyInOutput();
  } finally {
    child.kill();
  }
});

test("the dashboard's close finishes while a browser still holds a connection open (setup mode's hand-over depends on it)", async () => {
  const p = project();
  const g = ghStandIn(p.bare);
  const s = await setupDashboard(p.root, g);
  const port = Number(new URL(s.d.url).port);
  // A socket with a request the server is still serving (its body never arrives): as a browser's kept-alive
  // connection that sent one more request looks to close().
  const socket = connect(port, '127.0.0.1');
  await new Promise<void>((r) => socket.once('connect', () => r()));
  socket.write(`POST /api/first-run/skip HTTP/1.1\r\nhost: 127.0.0.1\r\nauthorization: Bearer ${s.d.token}\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{`);
  await new Promise((r) => setTimeout(r, 200));
  socket.on('error', () => undefined);
  const closed = await Promise.race([s.d.close().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 3_000))]);
  socket.destroy();
  assert.equal(closed, true, 'close() returned within 3 s');
});
