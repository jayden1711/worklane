// #887 review (round 4): a plain shell word still longer than PATH_MAX once resolved is matched against the secret
// globs as the base did (by its text alone, no file touched), not passed over. A program that walks a path one
// component at a time (`mkdir -p`) can act on a deep path inside a hidden directory, which the base refused. A word
// over 1 MiB is refused before that match, so the regex work one word adds past the call's deadline stays bounded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { GuardrailsConfig } from '../src/config/schema.js';
import { exampleContext } from '../src/guardrails/check.js';
import { evaluate } from '../src/guardrails/engine.js';

/** A plain folder holding a hidden directory, with the agent run's built-in anywhere globs, judged at the engine. */
function hiddenProject() {
  const p = mkdtempSync(join(tmpdir(), 'hidden-long-'));
  mkdirSync(join(p, 'evals-secret'));
  writeFileSync(join(p, 'evals-secret', 'score.py'), 'EXPECTED = 42\n');
  const g = GuardrailsConfig.parse({ version: 1, rules: [], secret_paths: ['evals-secret/**', '/**/evals/held-out/**', '/**/dashboard-token'], examples: { must_block: [], must_ask: [], must_allow: [] } });
  const decide = (command: string) => {
    const started = performance.now();
    const v = evaluate({ tool: 'Bash', input: { command }, cwd: p }, g, { ...exampleContext(g, p, true), home: join(p, 'no-home') });
    return { ...v, ms: performance.now() - started };
  };
  return { p, decide };
}

/** 5,000 characters of path: with any prefix, the word is over PATH_MAX (4,096) once resolved. */
const deep = 'd/'.repeat(2_500);

test('a plain shell word over 4,096 characters that names the hidden directory and a deep path behind it is refused', () => {
  const { p, decide } = hiddenProject();
  const cases: [string, string][] = [
    ['relative, under the hidden directory', `mkdir -p evals-secret/${deep}x`],
    ['absolute, under the hidden directory', `mkdir -p ${p}/evals-secret/${deep}x`],
    ['with ./ runs that resolution collapses', `mkdir -p ${'./'.repeat(1_000)}evals-secret/${deep}x`],
    ['under a built-in anywhere glob', `mkdir -p ${p}/a/evals/held-out/${deep}x`],
    ['1 MB, under the hidden directory', `mkdir -p evals-secret/${'d/'.repeat(500_000)}x`],
  ];
  for (const [what, command] of cases) {
    const v = decide(command);
    assert.equal(v.decision, 'deny', `${what}: ${v.decision} ${v.reason ?? ''}`);
    assert.equal(v.rule, 'secret-path', what);
    assert.ok((v.reason ?? '').length < 1_000, `${what}: the reason does not echo the word`);
    assert.ok(v.ms < 2_000, `${what}: took ${Math.round(v.ms)} ms`);
  }
});

test('an ordinary long word that names no secret is let through, as at the base', () => {
  const { decide } = hiddenProject();
  const cases: [string, string][] = [
    ['a long quoted message', `echo "${'the quick brown fox jumps over the lazy dog, again. '.repeat(150)}"`],
    ['a long path that names no secret', `ls ${'src/'.repeat(1_500)}x`],
    ['a long path whose name only contains the hidden one', `mkdir -p notevals-secret/${deep}x`],
    ['a long path that ends at a directory of the same name', `mkdir -p ${deep}evals-secret`],
    ['1 MB of path that names no secret', `ls ${'src/'.repeat(250_000)}x`],
  ];
  for (const [what, command] of cases) {
    const v = decide(command);
    assert.equal(v.decision, 'none', `${what}: ${v.decision} ${v.reason ?? ''}`);
    assert.ok(v.ms < 2_000, `${what}: took ${Math.round(v.ms)} ms`);
  }
});

test('a plain shell word over 1 MiB is refused before it is matched, so one word bounds how far the budget can overrun', () => {
  const { decide } = hiddenProject();
  const v = decide(`ls ${'src/'.repeat(300_000)}x`);
  assert.equal(v.decision, 'deny', v.reason ?? '');
  assert.match(v.reason ?? '', /shell word longer than 1048576 characters/);
  assert.ok(v.reason!.length < 1_000, 'the reason does not echo the word');
});
