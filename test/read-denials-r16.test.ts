// #890 round 16 (the round-15 second review and final check):
// - R1: a coordinator start root that is, or holds, the main checkout (`..`, `.`, `""`) left the coordinator's place
//   unhidden, so a worktree it made later was read from every run (measured, probe `dotdot`). Such a place now gets a
//   sandbox entry for the engine's worktree names, `<place>/<cli>-*`, expanded at each command; the run's own checkout
//   is bound back as its cwd. A main checkout whose own name matches refuses the run.
// - R2: a coordinator place missing when a run starts was skipped without a word (measured). The runner (in the
//   coordinator's process) makes the coordinator's own places again before working out the denials, and a place
//   still missing then refuses the run, by name.
// - A guarded runner given the repository path but not the coordinator's places refuses its runs: the service must
//   pass both.
import { STDIN_LINE, engineCli, exampleProject, repoRoot } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { agentSettings } from '../src/install.js';
import { laneRuns, PolicyFile, type Instance } from '../src/instance.js';
import { projectStateDir } from '../src/guardrails/context.js';
import { runReadDenials } from '../src/read-denials.js';
import { CliRunner, type RunRequest } from '../src/runner.js';

const linux = process.platform === 'linux';
const skip = !linux && "sandbox-runtime's Linux rules, where CI runs";
const bwrapRuns = linux && spawnSync('bwrap', ['--dev-bind', '/', '/', '--unshare-user', '--unshare-pid', '--proc', '/proc', '--', '/bin/sh', '-c', ':']).status === 0;
const SRT = join(repoRoot, 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'dist', 'sandbox');
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

type Denials = { paths: string[]; sandboxOnly?: string[] } | { error: string };
const denials = (o: Record<string, unknown>): Denials => runReadDenials(o as Parameters<typeof runReadDenials>[0]);
const ok = (d: Denials) => {
  if ('error' in d) assert.fail(d.error);
  return d;
};

/** `command` as sandbox-runtime's Linux wrapper wraps it with these read entries, writing only in `cwd`. */
async function wrap(entries: string[], cwd: string, command: string): Promise<string> {
  const utils = await import(join(SRT, 'sandbox-utils.js'));
  const glob = await import(join(SRT, 'read-deny-glob.js'));
  const lin = await import(join(SRT, 'linux-sandbox-utils.js'));
  const denyOnly: string[] = [];
  const unlistable = new Set<string>();
  for (const e of entries) {
    const stripped: string = utils.removeTrailingGlobSuffix(e);
    if (utils.containsGlobChars(stripped)) denyOnly.push(...(glob.expandReadDenyGlobLinux(e, [cwd], unlistable) as string[]));
    else denyOnly.push(stripped);
  }
  return lin.wrapCommandWithSandboxLinux({ command, needsNetworkRestriction: false, readConfig: { denyOnly, allowWithinDeny: [], unlistableDenyDirs: [...unlistable] }, writeConfig: { allowOnly: [cwd], denyWithinAllow: [] }, binShell: 'bash' });
}

/** The example project with the coordinator's start root `..`: its worktrees are the main checkout's siblings. */
function dotdot(mainName = 'example') {
  const { dir: made } = exampleProject();
  const dir = join(dirname(made), mainName);
  if (dir !== made) renameSync(made, dir);
  const place = dirname(dir);
  const own = join(place, `${BRAND.cli}-a`);
  git(dir, 'worktree', 'add', '-q', '-b', 'a', own, 'HEAD');
  writeFileSync(join(own, 'mine.txt'), 'MINE\n');
  const engine = join(projectStateDir(dir), 'worktrees');
  mkdirSync(engine, { recursive: true });
  return { dir, place, own, places: [place, engine], home: mkdtempSync(join(tmpdir(), 'home-')) };
}

test('#890 r16 (R1): with a start root of "..", a worktree the coordinator makes later is unreadable; the run\'s own checkout and the main checkout read and write as before', { skip, timeout: 120_000 }, async () => {
  const { dir, place, own, places, home } = dotdot();
  const fromOwn = ok(denials({ cwd: own, home, repo: dir, places }));
  const fromMain = ok(denials({ cwd: dir, home, repo: dir, places }));
  for (const d of [fromOwn, fromMain]) assert.ok(d.sandboxOnly?.includes(join(place, `${BRAND.cli}-*`)), JSON.stringify(d.sandboxOnly));
  // Made by the coordinator after both runs started.
  const late = join(place, `${BRAND.cli}-c`);
  git(dir, 'worktree', 'add', '-q', '-b', 'c', late, 'HEAD');
  writeFileSync(join(late, 'notes.txt'), 'LATE-C\n');
  if (!bwrapRuns) return;
  const run = async (d: { paths: string[]; sandboxOnly?: string[] }, cwd: string, cmd: string) => spawnSync('bash', ['-c', await wrap([...d.paths, ...(d.sandboxOnly ?? [])], cwd, cmd)], { cwd, encoding: 'utf8', timeout: 60_000 });
  const a = await run(fromOwn, own, `cat mine.txt && echo w > new.txt && cat new.txt && rm new.txt && git status --porcelain >/dev/null && echo OWN-OK; cat ${join(dir, 'README.md')} > /dev/null && echo MAIN-OK; cat ${join(late, 'notes.txt')} ${join(late, 'README.md')} 2>/dev/null; true`);
  assert.equal(a.status, 0, (a.stderr ?? '').slice(0, 300));
  assert.match(a.stdout, /MINE\nw\nOWN-OK\nMAIN-OK/);
  assert.doesNotMatch(a.stdout, /LATE-C|Example project/);
  const m = await run(fromMain, dir, `cat README.md > /dev/null && echo x > s.txt && rm s.txt && echo MAIN-OK; cat ${join(late, 'notes.txt')} ${join(own, 'mine.txt')} 2>/dev/null; true`);
  assert.equal(m.status, 0, (m.stderr ?? '').slice(0, 300));
  assert.match(m.stdout, /MAIN-OK/);
  assert.doesNotMatch(m.stdout, /LATE-C|MINE/);
});

test('#890 r16 (R1): a main checkout whose own name matches the engine\'s worktree names, under such a root, refuses the run', { skip }, () => {
  const { dir, own, places, home } = dotdot(`${BRAND.cli}-main`);
  const r = denials({ cwd: own, home, repo: dir, places });
  assert.ok('error' in r, JSON.stringify(r).slice(0, 300));
  assert.match(r.error, /main checkout/);
});

test('#890 r16 (R2): a coordinator place missing at the run\'s start refuses its denials, by name', { skip }, () => {
  const { dir } = exampleProject();
  const place = join(dir, '.claude', 'worktrees');
  const engine = join(projectStateDir(dir), 'worktrees');
  mkdirSync(engine, { recursive: true });
  const r = denials({ cwd: dir, home: mkdtempSync(join(tmpdir(), 'home-')), repo: dir, places: [place, engine] });
  assert.ok('error' in r, JSON.stringify(r).slice(0, 300));
  assert.ok(r.error.includes(place), r.error);
});

/** A stand-in claude that records the --settings it was given. */
function standIn() {
  const base = mkdtempSync(join(tmpdir(), 'run-'));
  const out = join(base, 'settings.json');
  const bin = join(base, 'claude');
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
${STDIN_LINE};
const at = args.indexOf('--settings');
const settings = at >= 0 ? JSON.parse(args[at + 1]) : null;
fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(settings));
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', tools: [], mcp_servers: [], plugins: [], output_style: (settings && settings.outputStyle) || 'default' }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0, num_turns: 1 }));
`,
  );
  chmodSync(bin, 0o755);
  const home = join(base, 'agent-home');
  mkdirSync(home);
  return { base, bin, home, settings: () => (existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as { sandbox?: { filesystem?: { denyRead?: string[] } } }) : null) };
}

function guardedRunner(dir: string, s: ReturnType<typeof standIn>, places?: string[]) {
  const inst = {
    name: 'fixture',
    runAs: null,
    evalAs: null,
    home: join(s.base, 'inst-home'),
    stateDir: join(s.base, 'state'),
    repo: { path: dir, repo: 'example/fixture' },
    policy: PolicyFile.parse({ version: 1, budget: { daily_usd: 20 }, agents: { max_workers: 2 }, land_mode: 'pr', sandbox: true }),
    credentials: { claude: { config_dir: join(s.base, 'agent-claude') } },
  } as unknown as Instance;
  const args: unknown[] = ['cli', { PATH: process.env.PATH, HOME: s.home }, s.bin, undefined, laneRuns(inst), undefined, {}, () => agentSettings(engineCli, [], [], []), undefined, undefined, undefined, undefined, dir, undefined, undefined, places];
  return new (CliRunner as unknown as new (...a: unknown[]) => CliRunner)(...args);
}
const request = (cwd: string): RunRequest => ({ env: {}, role: 'worker', prompt: 'p', cwd, model: 'm', allowedTools: ['Read'], disallowedTools: ['Bash'], maxTurns: 1, maxBudgetUsd: 0.01, stallMs: 30_000, timeoutMs: 30_000 });

test('#890 r16 (R2): the runner makes the coordinator\'s own place again when it went missing, and hides it whole', { skip }, async () => {
  const { dir } = exampleProject();
  const place = join(dir, '.claude', 'worktrees');
  const places = [place, join(projectStateDir(dir), 'worktrees')];
  for (const p of places) mkdirSync(p, { recursive: true });
  rmSync(place, { recursive: true, force: true });
  const s = standIn();
  const r = await guardedRunner(dir, s, places).run(request(dir));
  assert.equal(r.reason, 'succeeded', JSON.stringify(r).slice(0, 400));
  assert.ok(existsSync(place), 'made again');
  assert.ok(s.settings()?.sandbox?.filesystem?.denyRead?.includes(place), JSON.stringify(s.settings()?.sandbox?.filesystem?.denyRead));
});

test('#890 r16: a guarded runner with the repository path but not the coordinator\'s places refuses its runs', { skip }, async () => {
  const { dir } = exampleProject();
  const s = standIn();
  const r = await guardedRunner(dir, s).run(request(dir));
  assert.equal(r.reason, 'failed', JSON.stringify(r).slice(0, 400));
  assert.match(r.detail, /places/);
  assert.equal(s.settings(), null, 'claude never started');
});
