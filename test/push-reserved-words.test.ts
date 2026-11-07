// #1125 (R101l on #1101): a hook-skipping push behind a shell reserved word or inside a compound command got through
// the tool guard: the guard read the reserved word (`if`, `then`, `do`, `!`, `coproc`, …) as the program and never saw
// the `git` after it. A command after a reserved word is now judged like any other simple command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuardrailsConfig } from '../src/config/schema.js';
import { exampleContext } from '../src/guardrails/check.js';
import { evaluate } from '../src/guardrails/engine.js';
import { splitCommands } from '../src/guardrails/shell.js';

const cfg = GuardrailsConfig.parse({ version: 1 });
const bash = (command: string) => evaluate({ tool: 'Bash', input: { command }, cwd: '/p' }, cfg, exampleContext(cfg, '/p', true));

const FORMS = [
  'if true; then git push --no-verify; fi',
  'if git push --no-verify; then :; fi',
  'if false; then :; elif true; then git push --no-verify; fi',
  'if false; then :; else git push --no-verify; fi',
  'for x in 1; do git push --no-verify; done',
  'while true; do git push --no-verify; break; done',
  'until false; do git push --no-verify; done',
  'while git push --no-verify; do break; done',
  'select x in a; do git push --no-verify; break; done',
  '! git push --no-verify',
  'coproc git push --no-verify',
  'time git push --no-verify',
  'time -p git push --no-verify',
  '! if true; then git push --no-verify; fi',
];

test('#1125: a hook-skipping push behind a reserved word or in a compound command is refused, alone and before && git push', () => {
  const letThrough: string[] = [];
  for (const f of FORMS) {
    for (const c of [f, `${f} && git push`]) if (bash(c).decision !== 'deny') letThrough.push(c);
  }
  assert.deepEqual(letThrough, []);
});

test('#1125: the program after a reserved word is read as the program; a reserved word elsewhere is an argument', () => {
  const argv0 = (c: string) => splitCommands(c).map((s) => s.argv[0]);
  assert.deepEqual(argv0('if true; then git status; fi'), ['true', 'git', 'fi']);
  assert.deepEqual(argv0('! grep -q x f'), ['grep']);
  assert.deepEqual(splitCommands('echo if then do')[0]!.argv, ['echo', 'if', 'then', 'do']);
  assert.deepEqual(splitCommands('X=if git status')[0]!.argv, ['git', 'status']);
});

test('#1125: ordinary compound commands with no push are allowed as before', () => {
  for (const c of ['if true; then git status; fi', 'for f in a b; do echo $f; done', '! grep -q x README.md', 'time npm test']) assert.notEqual(bash(c).decision, 'deny', c);
});
