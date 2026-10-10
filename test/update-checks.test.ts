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

/** Every check run a push to main creates, from the workflows: job names, matrix jobs expanded as GitHub names them. */
function pushChecks(): string[] {
  const dir = join(repoRoot, '.github', 'workflows');
  const out: string[] = [];
  for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
    const wf = parse(readFileSync(join(dir, f), 'utf8')) as { on?: unknown; jobs?: Record<string, { name?: string; if?: string; strategy?: { matrix?: Record<string, unknown[]> } }> };
    const on = wf.on as Record<string, { branches?: string[] } | null> | string[] | undefined;
    const push = Array.isArray(on) ? on.includes('push') : on && 'push' in on ? (on.push?.branches ?? ['main']).includes('main') : false;
    if (!push) continue;
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

test('the updater\'s default required checks are exactly the checks a push to main runs (no PR-only ones)', () => {
  assert.deepEqual([...defaults()].sort(), pushChecks());
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
