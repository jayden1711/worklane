import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  for (const w of ['env', 'resume']) assert.match(step.run ?? '', new RegExp(`${w}:"guarded`), `wrap-${w}-leak.cjs runs, and must fail`);
  assert.match(step.run ?? '', /SETTING_SOURCES_REAL_CLAUDE="\$cc\/bin\/claude" node scripts\/ci\/setting-sources-probe\.mjs "\$f"/);
  assert.match(step.run ?? '', /then cat [^;]+; echo "the probe passed \$f, which leaks" >&2; exit 1; fi/);
  assert.doesNotMatch(JSON.stringify(step), /secrets\.|ANTHROPIC_API_KEY/, 'no secret: the probe gives claude a dummy key against its own stand-in');
  assert.ok(steps.indexOf(step) <= steps.findIndex((s) => /machine\.sh/.test(s.name ?? '')), 'before the machine steps, right after the build');
  // A pull request that changes the runner or the probe runs that job (scripts/ci/slow-jobs.sh).
  const scope = readFileSync(join(repoRoot, 'scripts', 'ci', 'slow-jobs.sh'), 'utf8');
  // Everything the probe exercises (R1185k, R1185n C2): what builds a guarded run, the plant and the probe's own test.
  const machineLine = scope.split('\n').find((l) => l.includes('then run="$run $MACHINE"')) ?? '';
  for (const path of ['scripts/ci/x', 'scripts/lib/git.cjs', 'scripts/bootstrap.sh', 'src/runner.ts', 'src/service.ts', 'src/instance.ts', 'src/agent-settings.ts', 'src/install.ts', 'src/network.ts', 'examples/basic/x', 'test/setting-sources-probe.test.ts', 'test/fixtures/setting-sources/x']) {
    const pattern = /grep -qE '([^']+)'/.exec(machineLine)?.[1] ?? '$^';
    assert.match(path, new RegExp(pattern), `${path} runs the add-project job`);
  }
  assert.match(scope, /MACHINE="[^"]*add-project-real-systemd/);
});

test("#958: the probe fails on a claude that loads the checkout's files under --setting-sources '', on one that leaks only once a tool runs (R1185l), and on one that never calls the API", { skip: isWindows && 'POSIX stand-in claude', timeout: 300_000 }, () => {
  // Loads CLAUDE.md and runs the checkout's SessionStart hook whatever the sources say.
  const leaky = run(fake(`const s = JSON.parse(fs.readFileSync('.claude/settings.json', 'utf8'));
require('node:child_process').execSync(s.hooks.SessionStart[0].hooks[0].command);
post(fs.readFileSync('CLAUDE.md', 'utf8') + fs.readFileSync('.claude/CLAUDE.md', 'utf8')).then(() => process.exit(0));`));
  assert.equal(leaky.status, 1, `${leaky.stdout}\n${leaky.stderr}`);
  assert.match(leaky.stderr, /a guarded run's request carries projectClaudeMd \(PLANTED-PROJECT-CLAUDE-MD\): that file was loaded/);
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
