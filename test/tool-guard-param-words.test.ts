// #924: a Bash word with a parameter expansion, or in $'...' or $"..." quoting, names the files bash would make of
// it. Before, `cat $UNSET.env`, `cat ${X:-.env}` and `cat $'\x2eenv'` read a secret file the guard allowed. Judged at
// the guard's engine, as test/hidden-paths-guard.test.ts does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GuardrailsConfig } from '../src/config/schema.js';
import { exampleContext } from '../src/guardrails/check.js';
import { evaluate } from '../src/guardrails/engine.js';
import { ansiC } from '../src/guardrails/shell.js';

/** A folder with a .env and a home with an SSH key, both secret, judged at the engine. */
function project() {
  const p = mkdtempSync(join(tmpdir(), 'param-words-'));
  writeFileSync(join(p, '.env'), 'TOKEN=x\n');
  writeFileSync(join(p, 'README.md'), 'hi\n');
  const home = join(p, 'home');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'key\n');
  const g = GuardrailsConfig.parse({ version: 1, rules: [], secret_paths: ['.env', '**/.env', '~/.ssh/**'], examples: { must_block: [], must_ask: [], must_allow: [] } });
  return (command: string) => evaluate({ tool: 'Bash', input: { command }, cwd: p }, g, { ...exampleContext(g, p, true), home }).decision;
}

test('#924: a parameter expansion that could make a secret path is refused: unset, braced, quoted, positional, a default word, $HOME', () => {
  const decide = project();
  const refused = [
    'cat $UNSET_VAR.env',
    'cat ${X}.env',
    'cat "$X".env',
    'cat "${X}".env',
    'cat ${X:-.env}',
    'cat ${X-.env}',
    'cat ${X:=.env}',
    'cat ${X:+.env}',
    'cat $1.env',
    'cat $@.env',
    'cat $X$Y.env',
    'cat .e$X"nv"',
    'cat $HOME/.ssh/id_rsa',
    'cat ${HOME}/.ssh/id_rsa',
    'X=y cat $X.env',
  ];
  const through = refused.filter((c) => decide(c) !== 'deny');
  assert.deepEqual(through, [], `${through.length} of ${refused.length} let through`);
});

test("#924: $'...' is decoded and $\"...\" read as bash reads them, so neither hides a secret file's name", () => {
  const decide = project();
  for (const c of ["cat $'\\x2eenv'", "cat $'\\056env'", "cat $'\\u002eenv'", "cat $'.e'nv", 'cat $"".env', 'cat $".env"']) assert.equal(decide(c), 'deny', c);
  assert.deepEqual(ansiC("\\x2eenv' rest", 0), ['.env', 8]);
  assert.deepEqual(ansiC("a\\tb\\'c\\\\d\\056\\u00e9\\cA\\q'", 0), ["a\tb'c\\d.é\u0001\\q", 26]);
  assert.deepEqual(ansiC('open', 0), ['open', 4], 'unclosed: to the end');
});

test("#924: an expansion the guard can't read is refused, never let through; ordinary expansions still run", () => {
  const decide = project();
  for (const c of ['cat ${X${Y}}.env', 'cat ${X', 'cat ${X:-$(printf .env)}', 'cat ${X:-${Y:-.env}}']) assert.equal(decide(c), 'deny', c);
  // Nothing an agent normally runs: a variable alone, a path under one, a wildcard with no dot, a word that only
  // becomes a non-secret name.
  for (const c of ['echo $PATH', 'ls $HOME', 'cd $DIR', 'echo "$HOME/x"', 'cat x$1.env', 'cat $X.md', 'cat README.md', 'echo ${#X}', 'echo $?', 'cat *', 'node -e "console.log(1)"']) {
    assert.notEqual(decide(c), 'deny', c);
  }
});
