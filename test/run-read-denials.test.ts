// #890: a run's task hidden paths and its project's secret paths are denied by the OS sandbox and the Read rules
// of the --settings the runner really passes, not only by the guard hook; a run whose own denials can't be worked
// out doesn't start. Fixtures only: a stand-in claude, an example project and a linked worktree as the coordinator
// makes one for an experiment. Nothing runs the real sandbox: the stand-in applies sandbox-runtime's own read-deny
// expansion (the library Claude Code's sandbox is built on) to the --settings it was given, and reads as a command
// inside it would.
import { STDIN_LINE, engineCli, exampleProject, repoRoot } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { agentSettings } from '../src/install.js';
import { laneRuns, PolicyFile, type Instance } from '../src/instance.js';
import { CliRunner, type RunRequest } from '../src/runner.js';
import { globToRegExp } from '../src/guardrails/glob.js';

const skip = process.platform !== 'linux' && 'the stand-in applies the Linux sandbox rules, where CI runs';
const SRT = join(repoRoot, 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'dist', 'sandbox');
const CRED_STORES = ['~/.ssh/**', '~/.aws/**'];

/**
 * The stand-in claude: records its --settings, then reads each target as a command in the sandbox those settings
 * describe would (Linux): every denyRead entry resolved as sandbox-runtime resolves it (a trailing /** is the
 * directory; any other glob expanded by its own expandReadDenyGlobLinux; a path that isn't there hides nothing), a
 * target at or under one is hidden (a file reads empty, a directory is an empty tmpfs). `git show` runs against an
 * empty object directory when the object store is hidden, as it would under that tmpfs.
 */
function standIn(dir: string, targets: string[], gitShow: { cwd: string; spec: string; objects: string }) {
  const bin = join(dir, 'claude');
  const out = join(dir, 'out.json');
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
${STDIN_LINE};
const at = args.indexOf('--settings');
const settings = at >= 0 ? JSON.parse(args[at + 1]) : null;
(async () => {
  const utils = await import(${JSON.stringify(join(SRT, 'sandbox-utils.js'))});
  const glob = await import(${JSON.stringify(join(SRT, 'read-deny-glob.js'))});
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const mounts = [];
  for (const e of (settings && settings.sandbox && settings.sandbox.filesystem && settings.sandbox.filesystem.denyRead) || []) {
    const stripped = utils.removeTrailingGlobSuffix(e);
    if (utils.containsGlobChars(stripped)) mounts.push(...glob.expandReadDenyGlobLinux(e, [], new Set()));
    else if (fs.existsSync(stripped)) mounts.push(real(stripped));
  }
  const hidden = (p) => mounts.some((m) => utils.isAtOrUnder(real(p), m));
  const reads = {};
  for (const t of ${JSON.stringify(targets)}) reads[t] = hidden(t) ? '' : fs.existsSync(t) ? fs.readFileSync(t, 'utf8') : null;
  const g = ${JSON.stringify(gitShow)};
  const empty = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tmpfs-'));
  const env = hidden(g.objects) ? { ...process.env, GIT_OBJECT_DIRECTORY: empty, GIT_ALTERNATE_OBJECT_DIRECTORIES: '' } : process.env;
  const r = cp.spawnSync('git', ['show', g.spec], { cwd: g.cwd, env, encoding: 'utf8' });
  fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ settings, mounts, reads, gitShow: { status: r.status, stdout: r.stdout } }));
  const say = (o) => console.log(JSON.stringify(o));
  say({ type: 'system', subtype: 'init', session_id: 's', tools: [], mcp_servers: [], plugins: [], output_style: (settings && settings.outputStyle) || 'default' });
  say({ type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0, num_turns: 1 });
})();
`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    out: () => (existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as { settings: Settings; mounts: string[]; reads: Record<string, string | null>; gitShow: { status: number; stdout: string } }) : null),
  };
}

type Settings = { sandbox?: { filesystem?: { denyRead?: string[] } }; permissions?: { deny?: string[] } };

/** An example project with an eval committed and secrets beside it, and an experiment's worktree cut from it. */
function fixture(o: { sandbox?: boolean; taskFile?: 'ok' | 'broken' | 'none' } = {}) {
  const { dir: repo } = exampleProject();
  const base = dirname(repo);
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'ignore' });
  mkdirSync(join(repo, 'evals-secret'));
  writeFileSync(join(repo, 'evals-secret', 'score.py'), 'SECRET_SCORER = 1\n');
  writeFileSync(join(repo, '.env.example'), 'TOKEN=\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'eval');
  // Untracked, as secrets are: the main checkout's own, and a copy a setup step put in the worktree.
  writeFileSync(join(repo, '.env'), 'TOKEN=main-checkout-secret\n');
  writeFileSync(join(repo, '.env.local'), 'TOKEN=local-secret\n');
  const wt = join(base, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'exp', wt, 'HEAD');
  // As the coordinator does (src/coordinator.ts, experimentHost session): literal hidden files deleted from the copy.
  rmSync(join(wt, 'evals-secret', 'score.py'));
  writeFileSync(join(wt, '.env'), 'TOKEN=worktree-secret\n');
  const tasks = mkdtempSync(join(tmpdir(), 'tasks-'));
  const taskFile = join(tasks, 'exp.json');
  if (o.taskFile !== 'none') writeFileSync(taskFile, o.taskFile === 'broken' ? '{ not json' : JSON.stringify({ id: 'exp', done_when: [{ manual: 'x' }], frozen: ['.worklane/**'], hidden: ['evals-secret/**', 'evals-secret/score.py', '.worklane/**'] }));
  const home = join(base, 'agent-home');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  const inst = {
    name: 'fixture',
    runAs: null,
    evalAs: null,
    home: join(base, 'inst-home'),
    stateDir: join(base, 'state'),
    repo: { path: repo, repo: 'example/fixture' },
    policy: PolicyFile.parse({ version: 1, budget: { daily_usd: 20 }, agents: { max_workers: 2 }, land_mode: 'pr', sandbox: o.sandbox ?? true }),
    credentials: { claude: { config_dir: join(base, 'agent-claude') } },
  } as unknown as Instance;
  const lanes = laneRuns(inst);
  const run = standIn(mkdtempSync(join(tmpdir(), 'stand-in-')), [join(wt, 'evals-secret', 'score.py'), join(repo, 'evals-secret', 'score.py'), join(wt, '.env'), join(repo, '.env'), join(repo, '.env.local'), join(repo, '.env.example'), join(wt, 'src', 'price.js'), join(home, '.ssh', 'id')], { cwd: wt, spec: 'HEAD:evals-secret/score.py', objects: join(repo, '.git', 'objects') });
  writeFileSync(join(home, '.ssh', 'id'), 'KEY\n');
  const runner = new CliRunner('cli', { PATH: process.env.PATH, HOME: home }, run.bin, undefined, lanes, undefined, {}, () => agentSettings(engineCli, [], [], CRED_STORES));
  const req: RunRequest = { env: {}, role: 'experimenter', prompt: 'p', cwd: wt, model: 'm', allowedTools: ['Read'], disallowedTools: ['Bash'], maxTurns: 1, maxBudgetUsd: 0.01, ...(o.taskFile === 'none' ? {} : { taskFile }), stallMs: 30_000, timeoutMs: 30_000 };
  return { repo, wt, home, lanes, runner, req, run };
}

/** Is `target` denied by one of these Read rules (Claude Code's "//" absolute form)? */
function readRuleDenies(rules: string[], target: string): boolean {
  return rules.some((r) => {
    const m = /^Read\(\/\/(.*)\)$/.exec(r);
    return !!m && globToRegExp(m[1]!).test(target.slice(1));
  });
}

test('#890: an experiment run\'s hidden paths and the secret paths are in its sandbox denyRead and its Read deny rules, under every checkout', { skip }, async () => {
  const f = fixture();
  const r = await f.runner.run(f.req);
  assert.equal(r.reason, 'succeeded', r.detail);
  const s = f.run.out()!.settings;
  const denyRead = s.sandbox!.filesystem!.denyRead!;
  const deny = s.permissions!.deny!;
  // Hidden: the eval folder and the config folder, in the experiment's worktree and in the main checkout.
  for (const p of [join(f.wt, 'evals-secret'), join(f.repo, 'evals-secret'), join(f.wt, '.worklane'), join(f.repo, '.worklane')]) {
    assert.ok(denyRead.includes(p), `${p} in denyRead: ${JSON.stringify(denyRead)}`);
    assert.ok(readRuleDenies(deny, join(p, 'x')), `${p}/x denied to Read: ${JSON.stringify(deny)}`);
  }
  // Secret: .env wherever a checkout has one, .env.* as what it matches now, never the exception.
  for (const p of [join(f.wt, '.env'), join(f.repo, '.env'), join(f.repo, '.env.local')]) {
    assert.ok(denyRead.includes(p), `${p} in denyRead: ${JSON.stringify(denyRead)}`);
    assert.ok(readRuleDenies(deny, p), `${p} denied to Read`);
  }
  assert.ok(!readRuleDenies(deny, join(f.repo, '.env.example')), 'the exception (!./.env.example) stays readable');
  assert.ok(!denyRead.some((d) => d.endsWith('.env.example') || d.endsWith('.env.*')), JSON.stringify(denyRead));
  // The object store, whose blobs hold the hidden files whatever the worktree shows.
  assert.ok(denyRead.includes(join(f.repo, '.git', 'objects')), JSON.stringify(denyRead));
  assert.ok(readRuleDenies(deny, join(f.repo, '.git', 'objects', 'pack', 'x.pack')));
  // Source the agent works on stays readable.
  assert.ok(!readRuleDenies(deny, join(f.wt, 'src', 'price.js')));
  // sandbox-runtime takes every entry (it refuses a deny glob that can match nothing).
  const { SandboxRuntimeConfigSchema } = await import('@anthropic-ai/sandbox-runtime');
  const v = SandboxRuntimeConfigSchema.safeParse({ network: { allowedDomains: [], deniedDomains: [] }, filesystem: { denyRead, allowWrite: [], denyWrite: [] } });
  assert.ok(v.success, v.success ? '' : JSON.stringify(v.error.issues));
});

test('#890: under a stand-in sandbox built from those settings, the scorer (also through git) and the env files read as nothing; the example and the source still read', { skip }, async () => {
  const f = fixture();
  assert.match(execFileSync('git', ['show', 'HEAD:evals-secret/score.py'], { cwd: f.wt, encoding: 'utf8' }), /SECRET_SCORER/, 'precondition: git still has the deleted scorer');
  const r = await f.runner.run(f.req);
  assert.equal(r.reason, 'succeeded', r.detail);
  const o = f.run.out()!;
  const read = (p: string) => o.reads[p];
  for (const p of [join(f.repo, 'evals-secret', 'score.py'), join(f.wt, '.env'), join(f.repo, '.env'), join(f.repo, '.env.local'), join(f.home, '.ssh', 'id')]) assert.equal(read(p), '', `${p} hidden: ${JSON.stringify(o.mounts)}`);
  assert.equal(read(join(f.repo, '.env.example')), 'TOKEN=\n');
  assert.match(read(join(f.wt, 'src', 'price.js')) ?? '', /\S/);
  assert.notEqual(o.gitShow.status, 0);
  assert.doesNotMatch(o.gitShow.stdout, /SECRET_SCORER/);
});

test('#890: no deny the lane and the instance had is lost', { skip }, async () => {
  const f = fixture();
  const r = await f.runner.run(f.req);
  assert.equal(r.reason, 'succeeded', r.detail);
  const s = f.run.out()!.settings;
  const lane = f.lanes.default!.settings!;
  const guard = agentSettings(engineCli, [], [], CRED_STORES) as Settings;
  for (const d of lane.sandbox.filesystem.denyRead) assert.ok(s.sandbox!.filesystem!.denyRead!.includes(d), `lost ${d}`);
  for (const d of [...lane.permissions.deny, ...(guard.permissions?.deny ?? [])]) assert.ok(s.permissions!.deny!.includes(d), `lost ${d}`);
});

test('#890: with the sandbox off, the Read rules still deny the hidden and secret paths', { skip }, async () => {
  const f = fixture({ sandbox: false });
  const r = await f.runner.run(f.req);
  assert.equal(r.reason, 'succeeded', r.detail);
  const s = f.run.out()!.settings;
  assert.equal(s.sandbox, undefined);
  for (const p of [join(f.wt, 'evals-secret', 'score.py'), join(f.repo, '.env'), join(f.wt, '.worklane', 'guardrails.yaml')]) assert.ok(readRuleDenies(s.permissions!.deny!, p), `${p} denied to Read`);
});

test('#890: a run whose task file can\'t be read doesn\'t start: its hidden paths can\'t be denied', { skip }, async () => {
  const f = fixture({ taskFile: 'broken' });
  const r = await f.runner.run(f.req);
  assert.equal(r.reason, 'failed');
  assert.match(r.detail, /task file .* can't be read.*hidden paths can't be denied; not starting/);
  assert.equal(f.run.out(), null, 'the stand-in never started');
});

test('#890: a run whose project guardrails can\'t load doesn\'t start: its secret paths can\'t be denied', { skip }, async () => {
  const f = fixture({ taskFile: 'none' });
  writeFileSync(join(f.wt, '.worklane', 'guardrails.yaml'), 'secret_paths: 7\n');
  const r = await f.runner.run(f.req);
  assert.equal(r.reason, 'failed');
  assert.match(r.detail, /guardrails in .* can't load.*secret paths can't be denied; not starting/);
  assert.equal(f.run.out(), null, 'the stand-in never started');
});
