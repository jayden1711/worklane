import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from './script-child-process.js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

const helperSrc = join(repoRoot, 'scripts', 'machine', 'worklane-machine.cjs');
const h = createRequire(import.meta.url)(helperSrc) as { parsePlugin: (a: string[]) => Record<string, string> | null; needsUnit: (a: string[]) => boolean };
const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const URL_OK = 'https://github.com/o/kit.git';

test('the helper takes exactly the four plugin steps, each argument in its exact shape, and never an instance', () => {
  assert.deepEqual(h.parsePlugin(['plugin-fetch', 'kit', URL_OK, SHA]), { action: 'fetch', id: 'kit', url: URL_OK, sha: SHA });
  assert.deepEqual(h.parsePlugin(['plugin-fetch', 'kit', URL_OK, SHA, 'plugins/kit']), { action: 'fetch', id: 'kit', url: URL_OK, sha: SHA, path: 'plugins/kit' });
  assert.deepEqual(h.parsePlugin(['plugin-stage', 'kit', DIGEST, 'builder+reviewer']), { action: 'stage', id: 'kit', digest: DIGEST, roles: 'builder+reviewer' });
  assert.deepEqual(h.parsePlugin(['plugin-withdraw', 'kit']), { action: 'withdraw', id: 'kit' });
  assert.deepEqual(h.parsePlugin(['plugin-remove', 'kit']), { action: 'remove', id: 'kit' });
  const bad = [
    ['plugin-fetch', 'kit', 'http://github.com/o/kit', SHA], ['plugin-fetch', 'kit', 'https://u:p@github.com/o/kit', SHA], ['plugin-fetch', 'kit', 'https://github.com:22/o/kit', SHA],
    ['plugin-fetch', 'kit', URL_OK, 'main'], ['plugin-fetch', 'kit', URL_OK, SHA.toUpperCase()], ['plugin-fetch', 'kit', URL_OK, SHA, '../x'], ['plugin-fetch', 'kit', URL_OK, SHA, 'a/./b'],
    ['plugin-fetch', 'Kit', URL_OK, SHA], ['plugin-fetch', 'kit', URL_OK, SHA, 'p', 'x'], ['plugin-fetch', 'kit', `${URL_OK};id`, SHA],
    ['plugin-stage', 'kit', DIGEST], ['plugin-stage', 'kit', 'sha256:abc', 'builder'], ['plugin-stage', 'kit', DIGEST, 'Builder'], ['plugin-stage', 'kit', DIGEST, 'builder,reviewer'], ['plugin-stage', 'kit', DIGEST, 'builder', 'alpha'],
    ['plugin-remove'], ['plugin-remove', 'kit', 'alpha'], ['plugin-withdraw', '--instance'], ['plugin-confirm', 'kit', DIGEST], ['plugin-add', 'kit'],
  ];
  for (const a of bad) assert.equal(h.parsePlugin(a), null, JSON.stringify(a));
});

test('only plugin-remove writes /etc, so only it runs in a unit of its own; the fetch starts its own unit', () => {
  assert.equal(h.needsUnit(['plugin-remove', 'kit']), true);
  for (const a of [['plugin-fetch', 'kit', URL_OK, SHA], ['plugin-stage', 'kit', DIGEST, 'builder'], ['plugin-withdraw', 'kit']]) assert.equal(h.needsUnit(a), false, JSON.stringify(a));
});

test('the helper never confirms: it has no confirm step and no code path that writes an allowlist', () => {
  const src = readFileSync(helperSrc, 'utf8');
  assert.doesNotMatch(src, /plugin-confirm|'confirm'/);
  assert.doesNotMatch(src, /\/etc\/worklane\/plugins\/[^ ]*\.json['"`]/, 'no allowlist path in code (the doc comment names it once)');
  // The stage, withdraw and remove go to the engine's root operations with the instance from sudo, never an argument.
  assert.match(src, /\[cli, 'plugins', p\.action, '--instance', instance, \.\.\.args\]/);
});

test('sudo\'s patterns admit what the helper takes and refuse the rest (sudo reads them as regular expressions, ":" as ".")', { skip: process.platform === 'win32' && 'bash' }, () => {
  const r = spawnSync('bash', ['-c', 'source "$1"; printf "%s\\n" "${PLUGIN_SUDOERS_ARGS[@]}"', '_', join(repoRoot, 'scripts', 'setup', 'lib.sh')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const res = r.stdout.trim().split('\n').map((p) => new RegExp(p));
  const sudoOk = (a: string[]) => res.some((re) => re.test(a.join(' ')));
  for (const a of [['plugin-fetch', 'kit', URL_OK, SHA], ['plugin-fetch', 'kit', URL_OK, SHA, 'plugins/kit'], ['plugin-stage', 'kit', DIGEST, 'builder+reviewer'], ['plugin-withdraw', 'kit'], ['plugin-remove', 'kit']]) {
    assert.ok(sudoOk(a), JSON.stringify(a));
    assert.ok(h.parsePlugin(a), JSON.stringify(a));
  }
  for (const a of [['plugin-fetch', 'kit', URL_OK, SHA, 'p', 'x'], ['plugin-stage', 'kit', DIGEST, 'builder', 'alpha'], ['plugin-remove', 'kit', 'alpha'], ['plugin-confirm', 'kit', DIGEST], ['plugin-fetch', 'kit', 'http://x.example/o', SHA]]) assert.equal(sudoOk(a), false, JSON.stringify(a));
});
