// The git runner's commit-graph setting in the environment, which the gits a program like gitleaks runs get (#927).
// Three copies set it: src/os/git.ts gitEnv, scripts/lib/git.cjs gitEnv, and the push gate's graphOff (it runs alone,
// so it writes them out). Each is tested here, the gate's taken from its source.
// - GIT_CONFIG_COUNT: only a canonical count (a plain decimal 0 to 9999) is read, and the runner's pair goes after the
//   caller's. Any other count becomes one git refuses, so the git fails closed. Round 8 tried to read a count as git's
//   strtoul does and got the sign wrong: `-0` is 0 to git, and lost the pair (#927 round 8's reviews, measured).
//   Before that, Number() turned counts git refuses (`0x1`, `1e0`, `1 `) into a run that applied the caller's pair.
// - GIT_CONFIG_PARAMETERS (what `git -c` hands the gits it runs) is read after the COUNT pairs: a caller's
//   `git -c core.commitGraph=true` there won (measured). The setting is appended to it too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitEnv, gitSpawnSync } from '../src/os/git.js';
import { repoRoot } from './helpers.js';

type EnvFn = (e: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
const scripts = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'lib', 'git.cjs')) as { gitEnv: EnvFn };
const gateSource = readFileSync(join(repoRoot, 'scripts', 'push-gate.mjs'), 'utf8');
const gateFn = /const graphOff = (\(e\) => \{[\s\S]*?\n\});/.exec(gateSource);
assert.ok(gateFn, 'the push gate declares graphOff');
const graphOff = new Function(`return ${gateFn[1]}`)() as EnvFn;
const COPIES: [string, EnvFn][] = [['src/os/git.ts gitEnv', gitEnv], ['scripts/lib/git.cjs gitEnv', scripts.gitEnv], ['scripts/push-gate.mjs graphOff', graphOff]];

const dir = mkdtempSync(join(tmpdir(), 'config-count-'));
const base = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
/** `git config --get key` as a git that reads only its environment (gitleaks' gits): status and value. */
const envOnly = (env: NodeJS.ProcessEnv, key: string) => {
  const r = spawnSync('git', ['config', '--get', key], { cwd: dir, env, encoding: 'utf8' });
  return { status: r.status, value: r.stdout.trim() };
};
const pair = { GIT_CONFIG_KEY_0: 'x.y', GIT_CONFIG_VALUE_0: 'z' };
const NBSP = String.fromCharCode(0xa0);

// Counts git itself refuses, counts git reads that aren't canonical (`-0`, `+1`, ` 1`, `01`), and overlong ones.
const NOT_CANONICAL = [
  '', '+0', '+1', ' 1', '\v1', '\n1', '01', '0000001', '-0', ' -0', '-00', '\t-0', '-', '+', '+-1', '-+0', '1\n', '0x1',
  '1e0', '1 ', 'abc', '-1', '-01', '1.5', ' ', `${NBSP}1`, '10000', '2147483646', '2147483647', '2147483648', '4294967296',
  '9007199254740991', '9007199254740993', '18446744073709551615', '18446744073709551616', '-18446744073709551615',
];

for (const count of NOT_CANONICAL) {
  test(`GIT_CONFIG_COUNT ${JSON.stringify(count)} isn't canonical: every copy makes it one git refuses, and git runs nothing`, () => {
    for (const [which, fn] of COPIES) {
      const env = fn({ ...base(), GIT_CONFIG_COUNT: count, ...pair });
      assert.equal(env.GIT_CONFIG_COUNT, 'refused', which);
      assert.equal(env.GIT_CONFIG_PARAMETERS, "'core.commitGraph=false'", which);
      const r = envOnly(env, 'x.y');
      assert.equal(r.status, 128, `${which}: git refuses the count`);
      assert.equal(r.value, '', `${which}: the caller's pair is not applied`);
    }
    // And through the runner itself.
    const r = gitSpawnSync(['config', '--get', 'x.y'], { cwd: dir, encoding: 'utf8', env: { ...base(), GIT_CONFIG_COUNT: count, ...pair } });
    assert.equal(r.status, 128, r.stderr);
    assert.equal(r.stdout, '');
  });
}

for (const count of [undefined, '0', '1', '12', '9999']) {
  test(`GIT_CONFIG_COUNT ${count === undefined ? 'unset' : JSON.stringify(count)} is canonical: every copy keeps the caller's pairs and puts the runner's after them`, () => {
    const n = count === undefined ? 0 : Number(count);
    for (const [which, fn] of COPIES) {
      const env = fn({ ...base(), ...(count === undefined ? {} : { GIT_CONFIG_COUNT: count }), ...pair });
      assert.equal(env.GIT_CONFIG_COUNT, String(n + 1), which);
      assert.equal(env[`GIT_CONFIG_KEY_${n}`], 'core.commitGraph', which);
      assert.equal(env[`GIT_CONFIG_VALUE_${n}`], 'false', which);
      assert.equal(env.GIT_CONFIG_PARAMETERS, "'core.commitGraph=false'", which);
      if (n > 1) continue; // git needs every pair below the count: the shape is what is checked here
      assert.deepEqual(envOnly(env, 'core.commitGraph'), { status: 0, value: 'false' }, which);
      assert.deepEqual(envOnly(env, 'x.y'), n === 1 ? { status: 0, value: 'z' } : { status: 1, value: '' }, which);
    }
  });
}

for (const [what, params] of [
  ['old form', "'core.commitGraph=true'"],
  ['new form', "'core.commitGraph'='true'"],
  ['with another key first', "'a.b'='c' 'core.commitGraph'='true'"],
] as const) {
  test(`a caller's GIT_CONFIG_PARAMETERS (${what}) setting core.commitGraph=true: a git that reads only the environment still reads false`, () => {
    // Plain git believes the caller's.
    assert.deepEqual(envOnly({ ...base(), GIT_CONFIG_PARAMETERS: params }, 'core.commitGraph'), { status: 0, value: 'true' });
    for (const [which, fn] of COPIES) {
      const env = fn({ ...base(), GIT_CONFIG_PARAMETERS: params });
      assert.equal(env.GIT_CONFIG_PARAMETERS, `${params} 'core.commitGraph=false'`, which);
      assert.deepEqual(envOnly(env, 'core.commitGraph'), { status: 0, value: 'false' }, which);
      // Also with the caller's count pair saying true.
      const both = fn({ ...base(), GIT_CONFIG_PARAMETERS: params, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.commitGraph', GIT_CONFIG_VALUE_0: 'true' });
      assert.deepEqual(envOnly(both, 'core.commitGraph'), { status: 0, value: 'false' }, which);
    }
    const r = gitSpawnSync(['config', '--get', 'core.commitGraph'], { cwd: dir, encoding: 'utf8', env: { ...base(), GIT_CONFIG_PARAMETERS: params } });
    assert.equal(r.stdout.trim(), 'false');
  });
}

test('a malformed caller GIT_CONFIG_PARAMETERS stays one git refuses, or reads false: never true', () => {
  for (const params of ["'a.b'='c", "'core.commitGraph=true", "core.commitGraph=true", "'core.commitGraph'='true"]) {
    for (const [which, fn] of COPIES) {
      const r = envOnly(fn({ ...base(), GIT_CONFIG_PARAMETERS: params }), 'core.commitGraph');
      assert.ok(r.status === 128 || r.value === 'false', `${which} ${JSON.stringify(params)}: ${JSON.stringify(r)}`);
    }
  }
});

test('the copies agree on every count and parameters value tried here', () => {
  for (const count of [...NOT_CANONICAL, '0', '1', '12', '9999']) {
    const input = { ...base(), GIT_CONFIG_COUNT: count, ...pair, GIT_CONFIG_PARAMETERS: "'a.b=c'" };
    const want = gitEnv({ ...input });
    for (const [which, fn] of COPIES.slice(1)) {
      const got = fn({ ...input });
      for (const k of Object.keys(want).filter((key) => key.startsWith('GIT_CONFIG'))) assert.equal(got[k], want[k], `${which} ${JSON.stringify(count)} ${k}`);
    }
  }
});
