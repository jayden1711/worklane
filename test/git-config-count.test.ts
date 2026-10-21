// A GIT_CONFIG_COUNT git refuses stays refused through the git runner (#927 round 8, #1001 item 1). git reads the count
// with strtoul over the whole value: `0x1`, `1e0`, `1 ` and `abc` are "bogus count", and git runs nothing. gitEnv read
// it with Number(), so the runner turned that refusal into a run, and for `0x1`, `1e0` and `1 ` into one that applied
// the caller's first pair (measured by the second review of 5d8c98ab). A count git accepts is read as git reads it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitEnv, gitSpawnSync, GIT_FIXED_ENV } from '../src/os/git.js';
import { repoRoot } from './helpers.js';

const scripts = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'lib', 'git.cjs')) as { gitEnv: (e?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv };
const pair = { GIT_CONFIG_KEY_0: 'x.y', GIT_CONFIG_VALUE_0: 'z' };

for (const count of ['0x1', '1e0', '1 ', 'abc', '-1', '1.5', ' ']) {
  test(`a GIT_CONFIG_COUNT of ${JSON.stringify(count)}, which git refuses, is left as it is: git still refuses it`, () => {
    for (const [which, env] of [['src/os/git.ts', gitEnv], ['scripts/lib/git.cjs', scripts.gitEnv]] as const) {
      assert.deepEqual({ ...env({ GIT_CONFIG_COUNT: count, ...pair }) }, { GIT_CONFIG_COUNT: count, ...pair, ...GIT_FIXED_ENV }, which);
    }
    const r = gitSpawnSync(['config', '--get', 'x.y'], { cwd: mkdtempSync(join(tmpdir(), 'config-count-')), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: count, ...pair } });
    assert.equal(r.status, 128, `${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, '', 'the pair was not applied');
  });
}

for (const [count, n] of [['1', 1], ['01', 1], [' 1', 1], ['+1', 1], ['', 0]] as const) {
  test(`a GIT_CONFIG_COUNT of ${JSON.stringify(count)}, which git reads as ${n}, keeps the caller's pairs and adds the runner's after them`, () => {
    const out = gitEnv({ GIT_CONFIG_COUNT: count, ...pair });
    assert.equal(out.GIT_CONFIG_COUNT, String(n + 1));
    assert.equal(out[`GIT_CONFIG_KEY_${n}`], 'core.commitGraph');
    assert.equal(out[`GIT_CONFIG_VALUE_${n}`], 'false');
    assert.deepEqual({ ...scripts.gitEnv({ GIT_CONFIG_COUNT: count, ...pair }) }, { ...out });
    const r = gitSpawnSync(['config', '--get', 'x.y'], { cwd: mkdtempSync(join(tmpdir(), 'config-count-')), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: count, ...pair } });
    assert.equal(r.status, n ? 0 : 1, r.stderr);
    assert.equal(r.stdout.trim(), n ? 'z' : '');
  });
}
