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

test('finds files a command changes through its arguments: copies, moves, in-place edits, removals', () => {
  const w = (s: string) => splitCommands(s).flatMap((c) => c.writes);
  assert.deepEqual(w('cp a.txt b/c.txt'), ['b/c.txt', 'b/c.txt/a.txt']);
  assert.deepEqual(w('mv x .claude'), ['x', '.claude', '.claude/x']);
  assert.deepEqual(w('rm -rf .claude'), ['.claude']);
  assert.deepEqual(w("sed -i.bak -e 's/a/b/' f1 f2"), ['f1', 'f2']);
  assert.deepEqual(w("sed -i 's/a/b/' f1"), ['f1']);
  assert.deepEqual(w("sed -n 's/a/b/p' f1"), [], 'not in place');
  assert.deepEqual(w('dd if=a of=b'), ['b']);
  assert.deepEqual(w('chmod -x .git/hooks/pre-commit'), ['.git/hooks/pre-commit']);
  assert.deepEqual(w('chmod u+x,go-w a b'), ['a', 'b'], 'a mode is not a file');
  assert.deepEqual(w('chmod 0644 a'), ['a']);
  assert.deepEqual(w('cat a b'), []);
});

test('recurses into the command string a runner or find -exec gives a shell, and a runner\'s own (#983)', () => {
  for (const [line, want] of [
    ["setsid bash -c 'git push --no-verify'", 'git push --no-verify'],
    ["nice -n 5 setsid sh -lc 'git commit -n'", 'git commit -n'],
    ["flock /tmp/l -c 'git commit -n'", 'git commit -n'],
    ["flock -w 5 /tmp/l --command 'git commit -n'", 'git commit -n'],
    ["runuser -u me -- bash -c 'git commit -n'", 'git commit -n'],
    ["runuser -u me --command='git commit -n'", 'git commit -n'],
    ["runuser -u me -lc 'git commit -n'", 'git commit -n'],
    ["find . -exec sh -c 'git commit -n' \\;", 'git commit -n'],
    ["setsid flock /tmp/l -c 'git commit -n'", 'git commit -n'],
  ] as const) assert.ok(argvs(line).includes(want), `${line}: ${JSON.stringify(argvs(line))}`);
  // WHY: a runner's ordinary operands and a command it runs directly are not strings.
  assert.deepEqual(argvs('flock /tmp/l make test'), ['flock /tmp/l make test']);
  assert.deepEqual(argvs('setsid make -C vendor/git'), ['setsid make -C vendor/git']);
});

test('subshells and groups', () => {
  assert.deepEqual(argvs('(cd x && railway run --environment production y) ; { a; b; }'), ['cd x', 'railway run --environment production y', 'a', 'b']);
});
