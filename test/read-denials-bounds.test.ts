// #890, second adversarial review round 7:
// - The default branch's committed config is read at the branch the coordinator names (it passes the one it started
//   with), never one an agent-writable config names; when that ref has no config, the run doesn't start.
// - Matching agent-written patterns runs in the coordinator: it takes linear time, so a crafted "*a*a…*b" can't hang
//   it (decision guide 2: off and stop must always work).
// - A tool-less run with no project root (the experiment monitor) still runs: it reads nothing.
// - One checkout's files can't overflow every other run's sandbox: past a cap, another linked worktree is denied
//   whole; the main checkout or the run's own checkout past it refuses the run.
// Each entry is checked with sandbox-runtime's own read-deny expansion (the library Claude Code's sandbox is built on).
import { STDIN_LINE, engineCli, exampleProject, repoRoot } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReadDenials } from '../src/read-denials.js';
import { agentSettings } from '../src/install.js';
import { CliRunner, type RunRequest } from '../src/runner.js';

const skip = process.platform !== 'linux' && "sandbox-runtime's Linux read-deny rules, where CI runs";
const SRT = join(repoRoot, 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'dist', 'sandbox');

type Opts = Parameters<typeof runReadDenials>[0];
/** runReadDenials with the coordinator's default branch, an option older builds don't have (so they ignore it). */
const withBranch = (o: Opts & { defaultBranch: string }) => runReadDenials(o as Opts);

const paths = (r: ReturnType<typeof runReadDenials>) => {
  if ('error' in r) assert.fail(r.error);
  return r.paths;
};

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Does the sandbox these denyRead entries describe hide `target`? Resolved as sandbox-runtime resolves them (Linux). */
async function hides(entries: string[], target: string): Promise<boolean> {
  const utils = await import(join(SRT, 'sandbox-utils.js'));
  const glob = await import(join(SRT, 'read-deny-glob.js'));
  const mounts: string[] = [];
  for (const e of entries) {
    const stripped: string = utils.removeTrailingGlobSuffix(e);
    if (utils.containsGlobChars(stripped)) mounts.push(...(glob.expandReadDenyGlobLinux(e, [], new Set()) as string[]));
    else if (existsSync(stripped)) mounts.push(real(stripped));
  }
  return mounts.some((m) => utils.isAtOrUnder(real(target), m));
}

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** `dir`'s config steered as a main-checkout agent could: secret_paths emptied, default_branch a ref that isn't there. */
function steer(dir: string) {
  const g = join(dir, '.worklane', 'guardrails.yaml');
  writeFileSync(g, readFileSync(g, 'utf8').replace(/^secret_paths:\n(?: {2}- .*\n)+/m, 'secret_paths: []\n'));
  const c = join(dir, '.worklane', 'config.yaml');
  writeFileSync(c, readFileSync(c, 'utf8').replace(/default_branch: main/, 'default_branch: no-such-branch'));
}

function secrets(dir: string) {
  writeFileSync(join(dir, '.env'), 'TOKEN=main\n');
  writeFileSync(join(dir, '.env.local'), 'TOKEN=local\n');
}

test('#890: a main-checkout run that steers default_branch and empties secret_paths still has the default branch\'s denials', { skip }, async () => {
  const { dir } = exampleProject();
  secrets(dir);
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  steer(dir);
  const p = paths(withBranch({ cwd: dir, home: '/h', defaultBranch: 'main' }));
  for (const t of [join(dir, '.env'), join(dir, '.env.local')]) assert.ok(await hides(p, t), `${t} hidden: ${JSON.stringify(p)}`);
});

test('#890: a worktree run after the main checkout\'s config was steered the same way still has them', { skip }, async () => {
  const { dir } = exampleProject();
  secrets(dir);
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const wt = join(dir, '.claude', 'worktrees', 'exp');
  git(dir, 'worktree', 'add', '-q', '-b', 'exp', wt, 'HEAD');
  writeFileSync(join(wt, '.env'), 'TOKEN=wt\n');
  steer(dir);
  steer(wt);
  const p = paths(withBranch({ cwd: wt, home: '/h', defaultBranch: 'main' }));
  for (const t of [join(dir, '.env'), join(dir, '.env.local'), join(wt, '.env')]) assert.ok(await hides(p, t), `${t} hidden: ${JSON.stringify(p)}`);
});

test('#890: when the coordinator\'s default branch has no config, the run doesn\'t start (never skipped)', { skip }, () => {
  const { dir } = exampleProject();
  const r = withBranch({ cwd: dir, home: '/h', defaultBranch: 'main' });
  assert.ok('error' in r && /default branch/.test(r.error), JSON.stringify(r));
});

test('#890: a crafted "*a*a…*b" pattern with an exception can\'t hang the coordinator', { skip, timeout: 60_000 }, () => {
  const { dir } = exampleProject();
  const k = 12;
  const g = join(dir, '.worklane', 'guardrails.yaml');
  const crafted = `${'*a'.repeat(k)}*b`;
  writeFileSync(g, readFileSync(g, 'utf8').replace(/^secret_paths:\n(?: {2}- .*\n)+/m, `secret_paths:\n  - ${JSON.stringify(crafted)}\n  - "!*q"\n`));
  writeFileSync(join(dir, 'a'.repeat(40)), 'x');
  // In a child process with a hard limit: a hung matcher would block this process's event loop for good.
  const mod = new URL('../src/read-denials.js', import.meta.url).href;
  const script = `const { runReadDenials } = await import(${JSON.stringify(mod)}); const t = performance.now(); const r = runReadDenials({ cwd: ${JSON.stringify(dir)}, home: '/h' }); process.stdout.write(JSON.stringify({ ms: performance.now() - t, error: r.error ?? null }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 0, `finished within 10 s (signal ${r.signal}): ${r.stderr.slice(0, 300)}`);
  const out = JSON.parse(r.stdout) as { ms: number };
  assert.ok(out.ms < 2_000, `took ${out.ms} ms`);
});

/** A stand-in claude that records whether it ran and answers with the monitor's structured output. */
function standIn(dir: string) {
  const bin = join(dir, 'claude');
  const ran = join(dir, 'ran');
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
${STDIN_LINE};
const at = args.indexOf('--settings');
const text = at >= 0 ? args[at + 1] : '{}';
fs.writeFileSync(${JSON.stringify(ran)}, 'yes');
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', tools: [], mcp_servers: [], plugins: [], output_style: JSON.parse(text).outputStyle || 'default' }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', structured_output: { flagged: false, findings: [] }, total_cost_usd: 0, num_turns: 1 }));
`,
  );
  chmodSync(bin, 0o755);
  return { bin, ran: () => existsSync(ran) };
}

test('#890: the experiment monitor (tool-less, in a directory with no project) still runs under the guardrails', { skip }, async () => {
  const s = standIn(mkdtempSync(join(tmpdir(), 'stand-in-')));
  const cwd = mkdtempSync(join(tmpdir(), 'ws-'));
  const home = mkdtempSync(join(tmpdir(), 'monitor-home-'));
  // The monitor's request as src/coordinator.ts makes it (experimentHost, monitor).
  const req: RunRequest = { env: {}, role: 'experiment-monitor', prompt: 'p', cwd, model: 'm', allowedTools: [], disallowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task'], maxTurns: 2, maxBudgetUsd: 0.01, jsonSchema: { type: 'object', additionalProperties: false, required: ['flagged', 'findings'], properties: { flagged: { type: 'boolean' }, findings: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 300 } } } }, stallMs: 60_000, timeoutMs: 60_000 };
  const r = await new CliRunner('cli', { PATH: process.env.PATH, HOME: home }, s.bin, undefined, undefined, undefined, {}, () => agentSettings(engineCli, [], [], [])).run(req);
  assert.equal(r.reason, 'succeeded', r.detail);
  assert.ok(s.ran(), 'the stand-in ran');
  // A run that can use a tool, in the same directory, still doesn't start.
  const refused = await new CliRunner('cli', { PATH: process.env.PATH, HOME: home }, s.bin, undefined, undefined, undefined, {}, () => agentSettings(engineCli, [], [], [])).run({ ...req, disallowedTools: ['Bash'] });
  assert.equal(refused.reason, 'failed');
});

test('#890: another worktree full of secret-matching files is denied whole; the main checkout overflowing refuses the run', { skip }, async () => {
  const { dir } = exampleProject();
  const root = join(dir, '.claude', 'worktrees');
  const exp = join(root, 'exp');
  const other = join(root, 'other');
  git(dir, 'worktree', 'add', '-q', '-b', 'exp', exp, 'HEAD');
  git(dir, 'worktree', 'add', '-q', '-b', 'other', other, 'HEAD');
  for (let i = 0; i < 300; i++) writeFileSync(join(other, `.env.x${i}`), 'x');
  const p = paths(runReadDenials({ cwd: exp, home: '/h' }));
  assert.ok(p.length < 100, `${p.length} entries`);
  assert.ok(await hides(p, join(other, '.env.x7')), JSON.stringify(p.slice(0, 20)));
  assert.equal(await hides(p, join(exp, 'README.md')), false, "the run's own checkout stays readable");
  // The main checkout overflowing: refused, never denied whole.
  for (let i = 0; i < 300; i++) writeFileSync(join(dir, `.env.m${i}`), 'x');
  const r = runReadDenials({ cwd: exp, home: '/h' });
  assert.ok('error' in r && r.error.includes(dir), JSON.stringify(r).slice(0, 300));
});
