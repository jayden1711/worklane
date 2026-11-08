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
${body}
`);
  chmodSync(bin, 0o755);
  return bin;
}
const run = (bin: string) => spawnSync(process.execPath, [probe, bin], { encoding: 'utf8', timeout: 120_000 });

test("#958: ci-slow.yml's add-project job runs the setting-sources probe on the pinned real claude, with no secret, on pull requests too", () => {
  const wf = parse(readFileSync(join(repoRoot, '.github', 'workflows', 'ci-slow.yml'), 'utf8')) as { on: Record<string, unknown>; jobs: Record<string, { steps?: { name?: string; run?: string; env?: unknown }[] }> };
  assert.ok('pull_request' in wf.on, 'the slow workflow runs on pull requests');
  const steps = wf.jobs['add-project-real-systemd']?.steps ?? [];
  const step = steps.find((s) => /setting-sources-probe\.mjs/.test(s.run ?? ''));
  assert.ok(step, 'the job runs the probe');
  assert.match(step.run ?? '', /sed -n 's\/\^CLAUDE_VERSION=\/\/p' scripts\/bootstrap\.sh/, "the version the machine installs (bootstrap.sh's pin)");
  assert.match(step.run ?? '', /npm install -g --prefix "\$cc" .*"@anthropic-ai\/claude-code@\$v"/);
  assert.match(step.run ?? '', /node scripts\/ci\/setting-sources-probe\.mjs "\$cc\/bin\/claude"/);
  assert.doesNotMatch(JSON.stringify(step), /secrets\.|ANTHROPIC_API_KEY/, 'no secret: the probe gives claude a dummy key against its own stand-in');
  assert.ok(steps.indexOf(step) <= steps.findIndex((s) => /machine\.sh/.test(s.name ?? '')), 'before the machine steps, right after the build');
  // A pull request that changes the runner or the probe runs that job (scripts/ci/slow-jobs.sh).
  const scope = readFileSync(join(repoRoot, 'scripts', 'ci', 'slow-jobs.sh'), 'utf8');
  assert.match(scope, /\^\(scripts\/\(setup\|machine\|ci\)\/\|[^\n]*src\/runner\\\.ts\)' <<< "\$files"; then run="\$run \$MACHINE"/);
  assert.match(scope, /MACHINE="[^"]*add-project-real-systemd/);
});

test("#958: the probe fails on a claude that loads the checkout's CLAUDE.md under --setting-sources '', or that never calls the API", { skip: isWindows && 'POSIX stand-in claude', timeout: 120_000 }, () => {
  // Loads CLAUDE.md and runs the checkout's SessionStart hook whatever the sources say: the controls pass, the guarded run fails.
  const leaky = run(fake(`const s = JSON.parse(fs.readFileSync('.claude/settings.json', 'utf8'));
require('node:child_process').execSync(s.hooks.SessionStart[0].hooks[0].command);
post(fs.readFileSync('CLAUDE.md', 'utf8') + fs.readFileSync('.claude/CLAUDE.md', 'utf8')).then(() => process.exit(1));`));
  assert.equal(leaky.status, 1, `${leaky.stdout}\n${leaky.stderr}`);
  assert.match(leaky.stderr, /a guarded run's request carries projectClaudeMd \(PLANTED-PROJECT-CLAUDE-MD\): that file was loaded/);
  assert.match(leaky.stderr, /a guarded run ran the project settings' SessionStart hook/);
  // Never calls the API: nothing is measured, so it fails rather than passing on an empty record.
  const silent = run(fake(`process.exit(0);`));
  assert.equal(silent.status, 1, `${silent.stdout}\n${silent.stderr}`);
  assert.match(silent.stderr, /the control made no model call to the stand-in, so nothing here is measured/);
  assert.match(silent.stderr, /the guarded run made no model call/);
  // Honours the sources for CLAUDE.md, but its plant check (every source) can't find the rest: the control says so.
  const partial = run(fake(`if (sources !== '') post(fs.readFileSync('CLAUDE.md', 'utf8')).then(() => process.exit(1)); else post('nothing').then(() => process.exit(1));`));
  assert.equal(partial.status, 1, `${partial.stdout}\n${partial.stderr}`);
  assert.match(partial.stderr, /with every source, homeClaudeMd \(PLANTED-HOME-CLAUDE-MD\) didn't reach a request: its plant is broken/);
  assert.doesNotMatch(partial.stderr, /a guarded run's request carries/);
});
