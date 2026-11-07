// #890 round 11: each place task checkouts are made is hidden whole by the sandbox, so a worktree made after a run
// starts is hidden from it too (round 10 left that open: 3000 files a `**` secret glob matched in such a worktree made
// the run's next command exceed bwrap's argument limit, measured). The run's own checkout beneath the place is bound
// back by the sandbox as its writable cwd; the place never goes to the Read rules, which could not bring it back.
// Checked with sandbox-runtime's own glob expansion and Linux wrapper, and, where bubblewrap can start here, by running
// the wrapped command.
import { STDIN_LINE, engineCli, exampleProject, repoRoot } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentSettings } from '../src/install.js';
import { laneRuns, PolicyFile, type Instance } from '../src/instance.js';
import { runReadDenials } from '../src/read-denials.js';
import { CliRunner, type RunRequest } from '../src/runner.js';

const linux = process.platform === 'linux';
const skip = !linux && "sandbox-runtime's Linux read-deny rules, where CI runs";
const bwrapRuns = linux && spawnSync('bwrap', ['--dev-bind', '/', '/', '--unshare-user', '--unshare-pid', '--proc', '/proc', '--', '/bin/sh', '-c', ':']).status === 0;
const SRT = join(repoRoot, 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'dist', 'sandbox');

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

type Denials = { paths: string[]; sandboxOnly?: string[] };
const denials = (r: ReturnType<typeof runReadDenials>): Denials => {
  if ('error' in r) assert.fail(r.error);
  return r as Denials;
};

/** The example project with `**\/*.pem` in the main checkout's secret_paths, and two worktrees in its worktree root. */
function fixture() {
  const { dir } = exampleProject();
  const g = join(dir, '.worklane', 'guardrails.yaml');
  writeFileSync(g, readFileSync(g, 'utf8').replace(/^secret_paths:\n/m, 'secret_paths:\n  - "**/*.pem"\n'));
  const place = join(dir, '.claude', 'worktrees');
  const w = join(place, 'w');
  const own = join(place, 'o');
  git(dir, 'worktree', 'add', '-q', '-b', 'w', w, 'HEAD');
  git(dir, 'worktree', 'add', '-q', '-b', 'o', own, 'HEAD');
  writeFileSync(join(w, 'notes.txt'), 'SIBLING\n');
  writeFileSync(join(own, 'mine.txt'), 'MINE\n');
  return { dir, place, w, own, home: mkdtempSync(join(tmpdir(), 'home-')) };
}

/** `command` as sandbox-runtime's Linux wrapper wraps it for a run with these sandbox entries, writing only in `cwd`. */
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

const sandboxEntries = (d: Denials) => [...d.paths, ...(d.sandboxOnly ?? [])];

test('#890 r11: the worktree root is hidden whole by the sandbox only, never by a Read rule', { skip }, () => {
  const { dir, place, own, home } = fixture();
  for (const cwd of [own, dir]) {
    const d = denials(runReadDenials({ cwd, home, repo: dir }));
    assert.ok(d.sandboxOnly?.includes(place), `the place, for a run in ${cwd}: ${JSON.stringify(d.sandboxOnly)}`);
    assert.ok(!d.paths.includes(place), 'not in the Read rules');
  }
});

test('#890 r11 (B5glob, late): a worktree made after the run starts, with 3000 matches, doesn\'t break the run\'s next command', { skip, timeout: 120_000 }, async () => {
  const { dir, place, own, home } = fixture();
  const d = denials(runReadDenials({ cwd: own, home, repo: dir }));
  const late = join(place, 'late');
  git(dir, 'worktree', 'add', '-q', '-b', 'late', late, 'HEAD');
  mkdirSync(join(late, 'keys'));
  for (let i = 0; i < 3000; i++) writeFileSync(join(late, 'keys', `k${'x'.repeat(40)}${i}.pem`), '');
  writeFileSync(join(late, 'notes.txt'), 'LATE\n');
  // At 8c0da5b8 this threw: "Sandbox profile has 18033 bwrap arguments and bwrap accepts at most 9000".
  const wrapped = await wrap(sandboxEntries(d), own, `cat ${join(own, 'mine.txt')}; cat ${join(late, 'notes.txt')} 2>/dev/null; true`);
  if (!bwrapRuns) return;
  const r = spawnSync('bash', ['-c', wrapped], { cwd: own, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, (r.stderr ?? '').slice(0, 400));
  assert.match(r.stdout, /MINE/);
  assert.doesNotMatch(r.stdout, /LATE/);
});

test('#890 r11: the run\'s own checkout under the hidden place reads, writes and runs git; the main checkout is unaffected', { skip: skip || (!bwrapRuns && 'bubblewrap can\'t start here'), timeout: 120_000 }, async () => {
  const { dir, w, own, home } = fixture();
  const d = denials(runReadDenials({ cwd: own, home, repo: dir }));
  const ownRun = spawnSync('bash', ['-c', await wrap(sandboxEntries(d), own, `cat mine.txt && echo new > new.txt && cat new.txt && rm new.txt && git status --porcelain >/dev/null && git log --oneline -1 >/dev/null && echo GIT-OK; cat ${join(dir, 'README.md')} >/dev/null && echo MAIN-OK; cat ${join(w, 'notes.txt')} 2>/dev/null; true`)], { cwd: own, encoding: 'utf8', timeout: 60_000 });
  assert.equal(ownRun.status, 0, (ownRun.stderr ?? '').slice(0, 400));
  assert.match(ownRun.stdout, /MINE\nnew\nGIT-OK\nMAIN-OK/);
  assert.doesNotMatch(ownRun.stdout, /SIBLING/);
  const m = denials(runReadDenials({ cwd: dir, home, repo: dir }));
  const mainRun = spawnSync('bash', ['-c', await wrap(sandboxEntries(m), dir, `cat README.md >/dev/null && echo x > scratch.txt && cat scratch.txt && rm scratch.txt && git status --porcelain >/dev/null && echo MAIN-OK; cat ${join(w, 'notes.txt')} ${join(own, 'mine.txt')} 2>/dev/null; true`)], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
  assert.equal(mainRun.status, 0, (mainRun.stderr ?? '').slice(0, 400));
  assert.match(mainRun.stdout, /x\nMAIN-OK/);
  assert.doesNotMatch(mainRun.stdout, /SIBLING|MINE/);
});

test('#890 r11: a guarded run\'s --settings carry the worktree root in the sandbox\'s denyRead, and no Read rule for it', { skip }, async () => {
  const { dir, place, own } = fixture();
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
  const runner = new CliRunner('cli', { PATH: process.env.PATH, HOME: home }, bin, undefined, laneRuns(inst), undefined, {}, () => agentSettings(engineCli, [], [], []));
  const req: RunRequest = { env: {}, role: 'worker', prompt: 'p', cwd: own, model: 'm', allowedTools: ['Read'], disallowedTools: ['Bash'], maxTurns: 1, maxBudgetUsd: 0.01, stallMs: 30_000, timeoutMs: 30_000 };
  const r = await runner.run(req);
  assert.equal(r.reason, 'succeeded', JSON.stringify(r).slice(0, 400));
  const s = JSON.parse(readFileSync(out, 'utf8')) as { sandbox?: { filesystem?: { denyRead?: string[] } }; permissions?: { deny?: string[] } };
  assert.ok(s.sandbox?.filesystem?.denyRead?.includes(place), JSON.stringify(s.sandbox?.filesystem?.denyRead));
  assert.ok(!(s.permissions?.deny ?? []).some((d) => d === `Read(/${place}/**)` || d === `Read(/${place})`), 'no Read rule for the place');
});

test('#890 r11: the sandbox-only entries reach the sandbox\'s denyRead and no Read rule', async () => {
  const mod = (await import('../src/sandbox.js')) as Record<string, unknown>;
  const add = mod.withSandboxDeniedReads as ((s: object, p: string[]) => { sandbox?: { filesystem?: { denyRead?: string[] } }; permissions?: { deny?: string[] } }) | undefined;
  assert.equal(typeof add, 'function');
  const s = add!({ sandbox: { enabled: true, filesystem: { denyRead: ['/a'] } }, permissions: { deny: ['Read(//a/**)'] } }, ['/p/.claude/worktrees']);
  assert.deepEqual(s.sandbox?.filesystem?.denyRead, ['/a', '/p/.claude/worktrees']);
  assert.deepEqual(s.permissions?.deny, ['Read(//a/**)']);
  // No sandbox: nothing to add to.
  assert.deepEqual(add!({ permissions: { deny: [] } }, ['/p']), { permissions: { deny: [] } });
});
