// Which names the root helpers' kept verbs take (#902 rounds 10, 11): exactly src/instance-name.ts LATER_RESERVED, by
// behaviour. Every name the instance-name rules refuse (each fixed one, and one of each pattern) is run through every
// kept verb of the experiment and test-run helpers, each a copy cut right after its name check, so nothing past the
// check runs; and through is_test_user, taken out of the test-run helper and test-user.sh. Given the sources, so a
// test can feed it a changed copy (a widened kept set) as well as the files.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Every fixed name the instance-name rules refuse, and one of each pattern they refuse (src/instance-name.ts). */
export const REFUSED_NAMES = ['dash', 'hub', 'hub-setup', 'update', 'tailscale', 'claude-account', 'egress', 'agent', 'eval', 'work', 'mcp', 'mcpc', 'mcpctl', 'test-x', 'ci-x', 'exp-x', 'score-x', 'dashboard-x', 'plugin-fetch-x', 'x-agent', 'x-eval', 'x-work', 'x-mcp', 'x-mcpc', 'x-mcpctl'];
/** The verbs each helper takes a name reserved since for: its OFF, cleanup and read-only verbs. */
export const KEPT_VERBS = { exp: ['stop', 'wipe', 'prune', 'check', 'version'], testrun: ['wipe', 'check', 'version'] } as const;
/** The verbs that make or run something: never under a refused name, a kept one included. */
export const MAKING_VERBS = { exp: ['create', 'job', 'eval-put', 'eval-seal'], testrun: ['create', 'exec', 'fetch', 'db-start', 'store-tips', 'file', 'cache', 'shared'] } as const;

function cut(src: string, next: string, dir: string, file: string) {
  const at = src.indexOf(`\n${next}\n`);
  if (at < 0) throw new Error(`no ${next}`);
  const f = join(dir, file);
  writeFileSync(f, `${src.slice(0, at)}\necho "passed $name $cmd"\nexit 0\n`);
  return (...args: string[]) => spawnSync('/bin/bash', [f, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
}

const fnOf = (s: string, name: string) => {
  const at = s.indexOf(`\n${name}() {`);
  if (at < 0) throw new Error(`no ${name}()`);
  return s.slice(at + 1, s.indexOf('\n}\n', at) + 3);
};

/**
 * Every way the helpers' kept names differ from `later`, or [] when they don't: a refused name a kept verb takes, a
 * reserved name a kept verb refuses or a making verb takes, and is_test_user taking a refused name's test user or
 * refusing a reserved one's (in the test-run helper and in test-user.sh, with lib.sh's instance_name_problem).
 */
export function keptProblems(src: { exp: string; testrun: string; testUser: string; lib: string }, later: readonly string[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'kept-names-'));
  const out: string[] = [];
  const helpers = { exp: cut(src.exp, 'juser="wl-exp-$name"', dir, 'exp.sh'), testrun: cut(src.testrun, 'user="wl-test-$name"', dir, 'testrun.sh') };
  for (const h of ['exp', 'testrun'] as const) {
    for (const n of [...REFUSED_NAMES, ...later]) {
      for (const v of KEPT_VERBS[h]) {
        const passed = helpers[h](n, v, 'x1').status === 0;
        if (passed !== later.includes(n)) out.push(`${h} ${n} ${v}: ${passed ? 'taken' : 'refused'}`);
      }
    }
    for (const n of later) for (const v of MAKING_VERBS[h]) if (helpers[h](n, v).status === 0) out.push(`${h} ${n} ${v}: taken`);
  }
  // is_test_user: wl-test-<n> with $BASE/<n> made, for every name; only a valid name or a reserved one counts.
  const base = join(dir, 'base');
  for (const n of [...REFUSED_NAMES, ...later, 'alpha']) mkdirSync(join(base, n), { recursive: true });
  const cases = [...REFUSED_NAMES, ...later, 'alpha'];
  for (const [what, fns] of [['testrun', fnOf(src.testrun, 'instance_name_problem') + fnOf(src.testrun, 'is_test_user')], ['test-user.sh', fnOf(src.lib, 'instance_name_problem') + fnOf(src.testUser, 'is_test_user')]] as const) {
    const r = spawnSync('bash', ['-c', `BASE=${base}\n${fns}for n in "$@"; do if is_test_user "wl-test-$n"; then echo "$n yes"; else echo "$n no"; fi; done`, '_', ...cases], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    const got = new Map(r.stdout.trim().split('\n').map((l) => l.split(' ') as [string, string]));
    for (const n of cases) if ((got.get(n) === 'yes') !== (n === 'alpha' || later.includes(n))) out.push(`${what} is_test_user wl-test-${n}: ${got.get(n) ?? 'no answer'}`);
  }
  // And its inline exception names exactly those, in both copies.
  for (const [what, s] of [['testrun', src.testrun], ['test-user.sh', src.testUser]] as const) {
    const named = [...fnOf(s, 'is_test_user').matchAll(/\[ "\$n" = ([a-z0-9-]+) \]/g)].map((m) => m[1]!).sort();
    if (named.join(' ') !== [...later].sort().join(' ')) out.push(`${what} is_test_user names ${named.join(' ') || 'nothing'}`);
  }
  return out;
}
