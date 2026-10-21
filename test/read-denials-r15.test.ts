// #890 round 15 (the round-14 second review):
// - B: the coordinator's own worktree root was hidden whole only while a config the run reads still named it. With
//   every config naming another root, a worktree the coordinator then made in its own root was read from inside the
//   sandbox (measured). The coordinator now passes its own places (its start root and the engine's) to every guarded
//   run, and those are always hidden whole, whatever the configs say.
// - G: a root a main-checkout role wrote into the working-tree config (`/usr`) was hidden whole from every run, which
//   took Bash away from all of them (measured). Only the coordinator's own places are hidden whole now.
import { STDIN_LINE, engineCli, exampleProject, repoRoot } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function setRoot(checkout: string, root: string) {
  const f = join(checkout, '.worklane', 'tests.yaml');
  writeFileSync(f, readFileSync(f, 'utf8').replace(/^ {2}root: .*$/m, `  root: ${JSON.stringify(root)}`));
}

/** The coordinator's worktrees in `.claude/worktrees` (its start root); worktrees a (the run's) and b there. */
function fixture() {
  const { dir } = exampleProject();
  const place = join(dir, '.claude', 'worktrees');
  const a = join(place, 'a');
  const b = join(place, 'b');
  git(dir, 'worktree', 'add', '-q', '-b', 'a', a, 'HEAD');
  git(dir, 'worktree', 'add', '-q', '-b', 'b', b, 'HEAD');
  const places = [place, join(projectStateDir(dir), 'worktrees')];
  for (const p of places) mkdirSync(p, { recursive: true });
  return { dir, place, a, b, places, home: mkdtempSync(join(tmpdir(), 'home-')) };
}

type Denials = { paths: string[]; sandboxOnly?: string[] } | { error: string };
/** runReadDenials with the coordinator's own places, as the runner passes them. */
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

test('#890 r15 (B): the coordinator\'s own root stays hidden whole when every config names another; a worktree made there later is unreadable', { skip, timeout: 120_000 }, async () => {
  const { dir, place, a, places, home } = fixture();
  setRoot(dir, 'wt2');
  setRoot(a, 'wt2');
  const d = ok(denials({ cwd: a, home, repo: dir, places }));
  assert.ok(d.sandboxOnly?.includes(place), JSON.stringify(d.sandboxOnly));
  // Made by the coordinator in its own root after the run started.
  const c = join(place, 'c');
  git(dir, 'worktree', 'add', '-q', '-b', 'c', c, 'HEAD');
  writeFileSync(join(c, 'notes.txt'), 'LATE-C\n');
  if (!bwrapRuns) return;
  const out = spawnSync('bash', ['-c', await wrap([...d.paths, ...(d.sandboxOnly ?? [])], a, `cat ${join(c, 'notes.txt')} ${join(c, 'README.md')} 2>/dev/null; echo DONE`)], { cwd: a, encoding: 'utf8', timeout: 60_000 });
  assert.match(out.stdout, /DONE/, out.stderr);
  assert.doesNotMatch(out.stdout, /LATE-C|Example project/);
});

test('#890 r15 (G): a root a config names is never hidden whole; a run keeps its Bash when the working-tree config names /usr', { skip, timeout: 120_000 }, async () => {
  const { dir, a, places, home } = fixture();
  setRoot(dir, '/usr');
  const d = ok(denials({ cwd: a, home, repo: dir, places }));
  assert.ok(!(d.sandboxOnly ?? []).includes('/usr'), JSON.stringify(d.sandboxOnly));
  assert.ok(!d.paths.includes('/usr'), 'not an entry either');
  if (!bwrapRuns) return;
  const out = spawnSync('bash', ['-c', await wrap([...d.paths, ...(d.sandboxOnly ?? [])], a, 'echo BASH-OK')], { cwd: a, encoding: 'utf8', timeout: 60_000 });
  assert.equal(out.status, 0, (out.stderr ?? '').slice(0, 300));
  assert.match(out.stdout, /BASH-OK/);
});

test('#890 r15: a guarded CliRunner given the coordinator\'s places carries them in its sandbox, whatever the configs name', { skip }, async () => {
  const { dir, place, a, places } = fixture();
  setRoot(dir, 'wt2');
  setRoot(a, 'wt2');
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
  const inst = {
    name: 'fixture',
    runAs: null,
    evalAs: null,
    home: join(base, 'inst-home'),
    stateDir: join(base, 'state'),
    repo: { path: dir, repo: 'example/fixture' },
    policy: PolicyFile.parse({ version: 1, budget: { daily_usd: 20 }, agents: { max_workers: 2 }, land_mode: 'pr', sandbox: true }),
    credentials: { claude: { config_dir: join(base, 'agent-claude') } },
  } as unknown as Instance;
  // As src/service.ts builds it: repository path, no branch or start secrets here, then the coordinator's places.
  const args: unknown[] = ['cli', { PATH: process.env.PATH, HOME: home }, bin, undefined, laneRuns(inst), undefined, {}, () => agentSettings(engineCli, [], [], []), undefined, undefined, undefined, undefined, dir, undefined, undefined, places];
  const runner = new (CliRunner as unknown as new (...a: unknown[]) => CliRunner)(...args);
  const req: RunRequest = { env: {}, role: 'worker', prompt: 'p', cwd: a, model: 'm', allowedTools: ['Read'], disallowedTools: ['Bash'], maxTurns: 1, maxBudgetUsd: 0.01, stallMs: 30_000, timeoutMs: 30_000 };
  const r = await runner.run(req);
  assert.equal(r.reason, 'succeeded', JSON.stringify(r).slice(0, 400));
  const s = JSON.parse(readFileSync(out, 'utf8')) as { sandbox?: { filesystem?: { denyRead?: string[] } } };
  assert.ok(s.sandbox?.filesystem?.denyRead?.includes(place), JSON.stringify(s.sandbox?.filesystem?.denyRead));
});
