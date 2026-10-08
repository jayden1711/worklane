import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCommands } from '../src/guardrails/shell.js';

const argvs = (s: string) => splitCommands(s).map((c) => c.argv.join(' '));

test('splits on operators and newlines', () => {
  assert.deepEqual(argvs('a 1 && b 2 || c; d | e & f\ng'), ['a 1', 'b 2', 'c', 'd', 'e', 'f', 'g']);
});

test('keeps quoted text together and strips quotes', () => {
  assert.deepEqual(argvs(`echo "a && b" 'c; d' e\\ f`), ['echo a && b c; d e f']);
});

test('recurses into bash -c, sh -lc, eval, $(...) and backticks', () => {
  const all = argvs(`bash -c 'railway run --environment production node x.js'; sh -lc "psql \\$URL"; eval "cast send 1"; echo $(railway ssh) \`whoami\``);
  for (const want of ['railway run --environment production node x.js', 'psql $URL', 'cast send 1', 'railway ssh', 'whoami']) {
    assert.ok(all.includes(want), `${want} in ${JSON.stringify(all)}`);
  }
});

test('strips env assignments and wrappers', () => {
  const [c] = splitCommands('FOO=1 BAR="x y" sudo -u root env -i timeout 5 npx railway run --environment production');
  assert.deepEqual(c!.argv, ['railway', 'run', '--environment', 'production']);
  assert.deepEqual(c!.assignments, { FOO: '1', BAR: 'x y' });
  assert.deepEqual(argvs('echo id | xargs -I{} railway ssh {}'), ['echo id', 'railway ssh {}']);
});

test('finds files written by redirection and tee', () => {
  const cs = splitCommands('echo x > .worklane/a.yaml; cat y >> b.txt 2>/dev/null; echo z | tee -a c.txt d.txt');
  assert.deepEqual(cs.flatMap((c) => c.writes), ['.worklane/a.yaml', 'b.txt', 'c.txt', 'd.txt']);
});

test('subshells and groups', () => {
  assert.deepEqual(argvs('(cd x && railway run --environment production y) ; { a; b; }'), ['cd x', 'railway run --environment production y', 'a', 'b']);
});
