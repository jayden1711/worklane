import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { repoRoot } from './helpers.js';

const lib = join(repoRoot, 'scripts', 'setup', 'lib.sh');

/** The default list as lib.sh declares it, read from the text (no bash needed). */
function defaults(): string[] {
  const m = readFileSync(lib, 'utf8').match(/^UPDATE_DEFAULT_CHECKS=\((.*)\)$/m);
  assert.ok(m, 'lib.sh declares UPDATE_DEFAULT_CHECKS');
  return [...m![1]!.matchAll(/"([^"]*)"/g)].map((x) => x[1]!);
}

type Job = { name?: string; if?: string; needs?: string | string[]; strategy?: { matrix?: Record<string, unknown[]> } };
/** both: every PR and every push to main. pr-only: never on main. main-only: every push to main, a PR only sometimes. */
type Tier = 'both' | 'pr-only' | 'main-only';
type Check = { name: string; tier: Tier; push: boolean; pr: boolean };

const PR_ONLY = /^github\.event_name == 'pull_request'$/;
/** Always on a push; on a PR only when the scope job says so (what the PR touches, or the full-ci label). */
const MAIN_ONLY = /^\$\{\{ !cancelled\(\) && \(github\.event_name == 'push' \|\| needs\.scope\.outputs\.[a-z]+ == 'true'\) \}\}$/;
/** ci.yml's PR-only helper that picks the main-only jobs a PR runs: not a check anything requires. */
const HELPERS = ['scope'];

function tier(file: string, key: string, job: Job): Tier {
  if (!job.if) return 'both';
  if (PR_ONLY.test(job.if)) return 'pr-only';
  if (MAIN_ONLY.test(job.if)) {
    assert.ok(([] as string[]).concat(job.needs ?? []).includes('scope'), `${file} ${key}: a main-only job needs the scope job`);
    return 'main-only';
  }
  return assert.fail(`${file} ${key}: an if: this test doesn't know (${job.if}); say whether it runs on main and on PRs`);
}

/** Every check run the workflows create, with when: job names, matrix jobs expanded as GitHub names them. */
function checks(): Check[] {
  const dir = join(repoRoot, '.github', 'workflows');
  const out: Check[] = [];
  for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
    const wf = parse(readFileSync(join(dir, f), 'utf8')) as { on?: unknown; jobs?: Record<string, Job> };
    const on = wf.on as Record<string, { branches?: string[] } | null> | string[] | undefined;
    const push = Array.isArray(on) ? on.includes('push') : on && 'push' in on ? (on.push?.branches ?? ['main']).includes('main') : false;
    const pr = Array.isArray(on) ? on.includes('pull_request') : !!on && 'pull_request' in on;
    for (const [key, job] of Object.entries(wf.jobs ?? {})) {
      if (HELPERS.includes(key)) continue;
      const t = tier(f, key, job);
      const name = job.name ?? key;
      const axes = Object.entries(job.strategy?.matrix ?? {}).filter(([k]) => k !== 'include' && k !== 'exclude');
      let combos: string[][] = [[]];
      for (const [, values] of axes) combos = combos.flatMap((c) => values.map((v) => [...c, String(v)]));
      for (const c of combos) out.push({ name: c.length ? `${name} (${c.join(', ')})` : name, tier: t, push: !!push, pr });
    }
  }
  return out;
}

/** Every check run a push to main creates. */
const pushChecks = () => checks().filter((c) => c.push && c.tier !== 'pr-only').map((c) => c.name).sort();
/** Every check run every pull request creates. */
const prChecks = () => checks().filter((c) => c.pr && c.tier !== 'main-only').map((c) => c.name).sort();

const MAIN_ONLY_CHECKS = ['bootstrap (macos-latest)', 'bootstrap (ubuntu-latest)', 'bootstrap (windows-wsl)', 'test-run sandbox (real systemd)', 'add-project (real systemd)', 'Claude sign-in probe (real users)'];

test('the updater\'s default required checks are exactly the checks a push to main runs (no PR-only ones)', () => {
  assert.deepEqual([...defaults()].sort(), pushChecks());
  assert.ok(!defaults().includes('dco'), 'dco runs on pull requests only, so on main it is always skipped');
  for (const x of MAIN_ONLY_CHECKS) {
    assert.equal(checks().find((c) => c.name === x)?.tier, 'main-only', `${x} runs on every push to main, on a PR only when it touches what it tests`);
    assert.ok(defaults().includes(x), `${x} gates the updater: a PR may not have run it`);
  }
});

test('the engine repo requires to merge exactly the checks every pull request runs, never a main-only one a PR may skip', () => {
  const cfg = parse(readFileSync(join(repoRoot, '.worklane', 'config.yaml'), 'utf8')) as { required_checks: string[] };
  assert.deepEqual([...cfg.required_checks].sort(), prChecks());
  for (const x of ['dco', 'scan', 'desktop', 'test (ubuntu-latest, 22)']) assert.ok(prChecks().includes(x), x);
  for (const x of MAIN_ONLY_CHECKS) assert.ok(!prChecks().includes(x), x);
});

test('check names with commas reach updates.json whole, never split', { skip: process.platform === 'win32' && 'bash' }, () => {
  const names = ['test (macos-latest, 22)', 'test (windows-latest, 24)', 'scan'];
  const r = spawnSync('bash', ['-c', 'source "$1"; shift; updates_config_json "$@"', '_', lib, 'https://example.invalid/r.git', ...names], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual((JSON.parse(r.stdout) as { required_checks: string[] }).required_checks, names);
  const d = spawnSync('bash', ['-c', 'source "$1"; updates_config_json url "${UPDATE_DEFAULT_CHECKS[@]}"', '_', lib], { encoding: 'utf8' });
  assert.deepEqual((JSON.parse(d.stdout) as { required_checks: string[] }).required_checks, defaults());
});

test('updates.sh passes each check as its own argument and refuses the old comma-separated --checks', () => {
  const s = readFileSync(join(repoRoot, 'scripts', 'setup', 'updates.sh'), 'utf8');
  assert.doesNotMatch(s, /split\(","\)/);
  assert.match(s, /updates_config_json "\$origin" "\$\{checks\[@\]\}"/);
  assert.match(s, /--checks\) echo .*gone/);
});
