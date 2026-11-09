import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { repoRoot } from './helpers.js';

// #958 (the owner's decision, 2026-11-08): a guarded run relies on --setting-sources '' alone, so CI proves it on the
// real claude binary (scripts/ci/setting-sources-probe.mjs, in ci-slow.yml's add-project job). Here: the job runs it,
// with the pinned version and no secret, and the probe itself fails on a claude that loads the checkout's files, or
// that never calls the API (nothing measured).

const isWindows = process.platform === 'win32';
const probe = join(repoRoot, 'scripts', 'ci', 'setting-sources-probe.mjs');

/** A stand-in claude: `body` is its script after reading its argv and env (ANTHROPIC_BASE_URL is the probe's stand-in API). */
function fake(body: string): string {
  const d = mkdtempSync(join(tmpdir(), 'probe-fake-'));
  const bin = join(d, 'fake-cc');
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const sources = args[args.indexOf('--setting-sources') + 1];
const post = (text) => fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', body: JSON.stringify({ system: text }) });
void sources;
${body}
`);
  chmodSync(bin, 0o755);
  return bin;
}
const run = (bin: string) => spawnSync(process.execPath, [probe, bin], { encoding: 'utf8', timeout: 240_000 });

test("#958: ci-slow.yml's add-project job runs the setting-sources probe on the pinned real claude, with no secret, on pull requests too", () => {
  const wf = parse(readFileSync(join(repoRoot, '.github', 'workflows', 'ci-slow.yml'), 'utf8')) as { on: Record<string, unknown>; jobs: Record<string, { steps?: { name?: string; run?: string; env?: unknown }[] }> };
  assert.ok('pull_request' in wf.on, 'the slow workflow runs on pull requests');
  const steps = wf.jobs['add-project-real-systemd']?.steps ?? [];
  const step = steps.find((s) => /setting-sources-probe\.mjs/.test(s.run ?? ''));
  assert.ok(step, 'the job runs the probe');
  assert.match(step.run ?? '', /sed -n 's\/\^CLAUDE_VERSION=\/\/p' scripts\/bootstrap\.sh/, "the version the machine installs (bootstrap.sh's pin)");
  assert.match(step.run ?? '', /npm install -g --prefix "\$cc" .*"@anthropic-ai\/claude-code@\$v"/);
  assert.match(step.run ?? '', /node scripts\/ci\/setting-sources-probe\.mjs "\$cc\/bin\/claude"/);
  // The must-fail wrappers around the real claude (R1185n): the probe must exit 1 on each, naming its leak.
  for (const [w, says] of [['env', 'guarded run'], ['resume', 'guarded resumed run'], ['perm', 'a guarded run ran Write'], ['tool-env', 'guarded worker run'], ['role-prompt', 'guarded worker run'], ['resume-worker', 'guarded resumed run'], ['second-turn', "a guarded run's request"], ['helper', "a guarded run ran the local settings' apiKeyHelper"], ['lane-sandbox', "a guarded run's request"], ['plugin-locks', "a guarded run's request"], ['task-file', "a guarded run's request"]]) {
    assert.match(step.run ?? '', new RegExp(`(^|\\s)${w}:"[^"]*${says}`), `wrap-${w}-leak.cjs runs, and must fail naming its leak`);
    assert.ok(existsSync(join(repoRoot, 'test', 'fixtures', 'setting-sources', `wrap-${w}-leak.cjs`)), `wrap-${w}-leak.cjs is there`);
  }
  assert.match(step.run ?? '', /SETTING_SOURCES_REAL_CLAUDE="\$cc\/bin\/claude" node scripts\/ci\/setting-sources-probe\.mjs "\$f"/);
  assert.match(step.run ?? '', /then cat [^;]+; echo "the probe passed \$f, which leaks" >&2; exit 1; fi/);
  assert.doesNotMatch(JSON.stringify(step), /secrets\.|ANTHROPIC_API_KEY/, 'no secret: the probe gives claude a dummy key against its own stand-in');
  assert.ok(steps.indexOf(step) === steps.findIndex((s) => /machine\.sh/.test(s.name ?? '')) + 1, 'right after machine.sh: production-shaped runs have the lane sandbox on, which needs its bubblewrap');
  // A pull request that changes the runner or the probe runs that job (scripts/ci/slow-jobs.sh).
  const scope = readFileSync(join(repoRoot, 'scripts', 'ci', 'slow-jobs.sh'), 'utf8');
  assert.match(scope, /MACHINE="[^"]*add-project-real-systemd/);
});

test("#958: the probe fails on a claude that loads the checkout's files under --setting-sources '', on one that leaks only once a tool runs (R1185l), and on one that never calls the API", { skip: isWindows && 'POSIX stand-in claude', timeout: 300_000 }, () => {
  // Loads CLAUDE.md and runs the checkout's SessionStart hook whatever the sources say.
  const leaky = run(fake(`const s = JSON.parse(fs.readFileSync('.claude/settings.json', 'utf8'));
require('node:child_process').execSync(s.hooks.SessionStart[0].hooks[0].command);
post(fs.readFileSync('CLAUDE.md', 'utf8') + fs.readFileSync('.claude/CLAUDE.md', 'utf8')).then(() => process.exit(0));`));
  assert.equal(leaky.status, 1, `${leaky.stdout}\n${leaky.stderr}`);
  assert.match(leaky.stderr, /a guarded run's request carries projectClaudeMd \(PLANTED-PROJECT-CLAUDE-MD\): that was loaded/);
  assert.match(leaky.stderr, /a guarded run ran the project settings' SessionStart hook/);
  // R1185l's: honours '' for everything read at the start, but runs the checkout's PreToolUse and Stop hooks once a
  // model call succeeds. The stand-in's tool turn reaches that, so the probe catches it.
  const lazy = run(join(repoRoot, 'test', 'fixtures', 'setting-sources', 'fake-lazy-leak.cjs'));
  assert.equal(lazy.status, 1, `${lazy.stdout}\n${lazy.stderr}`);
  assert.match(lazy.stderr, /a guarded run ran the project settings' PreToolUse hook/);
  assert.match(lazy.stderr, /a guarded run ran the project settings' Stop hook/);
  // Never calls the API: nothing is measured, so it fails rather than passing on an empty record.
  const silent = run(fake(`process.exit(0);`));
  assert.equal(silent.status, 1, `${silent.stdout}\n${silent.stderr}`);
  assert.match(silent.stderr, /the project control: no model call reached the stand-in, so nothing is measured/);
  assert.match(silent.stderr, /the guarded run: no model call reached the stand-in/);
});

test("#958 (R1185p D3): a pull request touching anything the probe loads runs add-project's job: the probe's import closure is scripts/ci/setting-sources-probe.files, and slow-jobs.sh reads it", { skip: isWindows && 'bash', timeout: 120_000 }, () => {
  const listed = readFileSync(join(repoRoot, 'scripts', 'ci', 'setting-sources-probe.files'), 'utf8');
  const now = spawnSync(process.execPath, [probe, '--files'], { encoding: 'utf8' });
  assert.equal(listed, now.stdout, 'the list is the closure as it is now: run `node scripts/ci/setting-sources-probe.mjs --files > scripts/ci/setting-sources-probe.files`');
  // The guard's hook entry and what it imports (R1185r D1): spawned by every guarded run's hooks, never imported.
  for (const f of ['src/runner.ts', 'src/sandbox.ts', 'src/plugins/run.ts', 'src/brand.ts', 'src/guardrails/push-hook.ts', 'src/agent-settings.ts', 'src/install.ts', 'src/network.ts', 'scripts/lib/git.cjs', 'src/hook-main.ts', 'src/hook.ts', 'src/hook-deadline.ts', 'src/guard/commit.ts']) assert.ok(listed.split('\n').includes(f), `${f} is in the closure`);
  // slow-jobs.sh, on a pull request in a scratch repo, for a change to one file of the list each.
  const d = mkdtempSync(join(tmpdir(), 'slow-jobs-'));
  const git = (...a: string[]) => spawnSync('git', a, { cwd: d, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@example.com');
  git('config', 'user.name', 'A');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(d, 'scripts', 'ci'), { recursive: true });
  writeFileSync(join(d, 'scripts', 'ci', 'setting-sources-probe.files'), listed);
  writeFileSync(join(d, 'README'), 'x');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  const jobs = (path: string) => {
    git('checkout', '-q', base);
    mkdirSync(join(d, path, '..'), { recursive: true });
    writeFileSync(join(d, path), 'changed');
    git('add', '-A');
    git('commit', '-q', '-m', path);
    const head = git('rev-parse', 'HEAD').stdout.trim();
    const r = spawnSync('bash', [join(repoRoot, 'scripts', 'ci', 'slow-jobs.sh')], { cwd: d, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', EVENT: 'pull_request', PR_BASE: base, PR_HEAD: head } });
    return /^run=(.*)$/m.exec(r.stdout)?.[1] ?? `(failed: ${r.stderr})`;
  };
  for (const f of ['src/sandbox.ts', 'src/guardrails/push-hook.ts', 'src/brand.ts']) assert.match(jobs(f), / add-project-real-systemd /, `${f} runs add-project's job`);
  assert.doesNotMatch(jobs('src/sandbox.ts'), /wizard/, "and not the wizard's walk for that alone");
  assert.doesNotMatch(jobs('docs/x.md'), /add-project-real-systemd/, 'a file outside it does not');
});

test("#958 (R1185s S1): the probe loads src/ only through dist(), only what LOADS names, and its closure's hook entry is install.ts's HOOK_ENTRY", () => {
  const text = readFileSync(probe, 'utf8');
  // Its code, comments out (line and block), strings kept.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal((code.match(/\bimport\s*\(/g) ?? []).length, 1, 'one import(), the one inside dist()');
  // Outside shim(), whose text is the source of the child it writes: no require() or createRequire beside it.
  const shimAt = code.indexOf('function shim(');
  const outside = shimAt < 0 ? code : code.slice(0, shimAt) + code.slice(code.indexOf('\n}\n', shimAt));
  assert.ok(shimAt >= 0, 'shim() is where the probe says');
  assert.doesNotMatch(outside, /\brequire\s*\(|createRequire/, 'no require() or createRequire beside it');
  assert.match(code, /const dist = \(f\) => \{\n\s*if \(!LOADS\.includes\(/, 'dist() refuses a module LOADS doesn\'t name');
  const loads = JSON.parse((/const LOADS = (\[[^\]]*\]);/.exec(code)?.[1] ?? '[]').replace(/'/g, '"')) as string[];
  const calls = [...code.matchAll(/\bdist\(\s*(['"`])([^'"`]+)\1\s*\)/g)].map((m) => m[2]!.replace(/\.js$/, ''));
  assert.ok(calls.length > 0 && calls.every((c) => loads.includes(c)), `every dist() call is in LOADS: ${calls.join(', ')}`);
  assert.equal((code.match(/\bdist\(/g) ?? []).length, calls.length, 'every dist() call names a literal');
  const entry = /export const HOOK_ENTRY = '([\w/-]+)\.js'/.exec(readFileSync(join(repoRoot, 'src', 'install.ts'), 'utf8'))?.[1];
  assert.ok(entry && readFileSync(join(repoRoot, 'scripts', 'ci', 'setting-sources-probe.files'), 'utf8').split('\n').includes(`src/${entry}.ts`), 'the hook entry is in the closure');
});
