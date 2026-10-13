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

/** A branch filter pattern (GitHub's glob: `*` within a path segment, `**` across them) matching a branch name. */
const branchMatches = (pattern: string, branch: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '.')}$`).test(branch);

type PushFilter = { branches?: string[]; 'branches-ignore'?: string[]; tags?: string[]; 'tags-ignore'?: string[] } | null;

/**
 * Whether a workflow's `on:` runs it on a push to `branch`. A bare `push` runs on every branch; a push with tag
 * filters and no branch filter runs on those tags only, never a branch; otherwise branches / branches-ignore decide.
 */
function pushRunsOn(on: unknown, branch = 'main'): boolean {
  if (on === 'push') return true;
  if (Array.isArray(on)) return on.includes('push');
  if (!on || typeof on !== 'object' || !('push' in on)) return false;
  const push = (on as { push: PushFilter }).push;
  if (!push) return true;
  if (push.branches) return push.branches.filter((p) => !p.startsWith('!')).some((p) => branchMatches(p, branch)) && !push.branches.filter((p) => p.startsWith('!')).some((p) => branchMatches(p.slice(1), branch));
  if (push['branches-ignore']) return !push['branches-ignore'].some((p) => branchMatches(p, branch));
  return !(push.tags || push['tags-ignore']);
}

test('which push triggers run on a push to main', () => {
  assert.equal(pushRunsOn('push'), true);
  assert.equal(pushRunsOn(['push', 'pull_request']), true);
  assert.equal(pushRunsOn({ push: null }), true);
  assert.equal(pushRunsOn({ push: { branches: ['main'] } }), true);
  assert.equal(pushRunsOn({ push: { branches: ['release/*'] } }), false);
  assert.equal(pushRunsOn({ push: { branches: ['**'] } }), true);
  assert.equal(pushRunsOn({ push: { branches: ['*', '!main'] } }), false);
  assert.equal(pushRunsOn({ push: { 'branches-ignore': ['main'] } }), false);
  assert.equal(pushRunsOn({ push: { 'branches-ignore': ['dependabot/**'] } }), true);
  assert.equal(pushRunsOn({ push: { paths: ['src/**'] } }), true);
  // Tags only: a tag push, never a branch push.
  assert.equal(pushRunsOn({ push: { tags: ['v*'] }, workflow_dispatch: null }), false);
  assert.equal(pushRunsOn({ push: { 'tags-ignore': ['v*'] } }), false);
  // Tags and branches: the branch filter decides.
  assert.equal(pushRunsOn({ push: { tags: ['v*'], branches: ['main'] } }), true);
  assert.equal(pushRunsOn({ pull_request: null }), false);
});

/** Every check run a push to main creates, from the workflows: job names, matrix jobs expanded as GitHub names them. */
function pushChecks(): string[] {
  const dir = join(repoRoot, '.github', 'workflows');
  const out: string[] = [];
  for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
    const wf = parse(readFileSync(join(dir, f), 'utf8')) as { on?: unknown; jobs?: Record<string, { name?: string; if?: string; strategy?: { matrix?: Record<string, unknown[]> } }> };
    if (!pushRunsOn(wf.on)) continue;
    for (const [key, job] of Object.entries(wf.jobs ?? {})) {
      if (job.if && /event_name\s*==\s*'pull_request'/.test(job.if)) continue; // PR-only: always skipped on main
      const name = job.name ?? key;
      const matrix = job.strategy?.matrix;
      if (!matrix) {
        out.push(name);
        continue;
      }
      const axes = Object.entries(matrix).filter(([k]) => k !== 'include' && k !== 'exclude');
      let combos: string[][] = [[]];
      for (const [, values] of axes) combos = combos.flatMap((c) => values.map((v) => [...c, String(v)]));
      for (const c of combos) out.push(`${name} (${c.join(', ')})`);
    }
  }
  return out.sort();
}

/**
 * Push-to-main checks the updater deliberately does not wait for. Only these may differ; any other drift fails.
 * - bootstrap (macos-latest): the owner's decision. It is required to merge (.worklane/config.yaml), but engine
 *   updates on servers must not wait on the macOS run.
 * - bootstrap (windows-wsl): owner: macOS/Windows jobs don't gate updates. Not a required check either.
 */
const UPDATER_EXCLUDED = ['bootstrap (macos-latest)', 'bootstrap (windows-wsl)'];

test('the updater\'s default required checks are exactly the checks a push to main runs (no PR-only ones), minus the named exclusions', () => {
  const push = pushChecks();
  for (const x of UPDATER_EXCLUDED) assert.ok(push.includes(x), `exclusion "${x}" still names a check a push to main runs`);
  assert.deepEqual([...defaults()].sort(), push.filter((c) => !UPDATER_EXCLUDED.includes(c)));
  assert.ok(!defaults().includes('dco'), 'dco runs on pull requests only, so on main it is always skipped');
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
