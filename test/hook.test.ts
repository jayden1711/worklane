import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCorpus } from './hook-corpus.js';
import { repoRoot } from './helpers.js';

// WHY (#785): the guard's lanes' rules moved into its own modules (src/guard/) and its import tree was cut. The guard
// must decide exactly as before on every call: these answers were recorded from main before the move, and each case's
// answer (exit code, stdout and stderr, byte for byte) must still be the same.
test("the agents' tool guard answers every call in the corpus exactly as it did before its import tree was cut", async () => {
  const want = JSON.parse(readFileSync(join(repoRoot, 'test', 'fixtures', 'hook-corpus.json'), 'utf8')) as Record<string, string>;
  const got = await runCorpus();
  assert.deepEqual(Object.keys(got), Object.keys(want), 'the corpus and its recorded answers name the same cases, in order');
  const changed = Object.keys(want).filter((k) => got[k] !== want[k]);
  assert.deepEqual(changed.map((k) => ({ case: k, was: want[k], now: got[k] })), [], `${changed.length} of ${Object.keys(want).length} answers changed`);
  // The corpus reaches both answers on each lane: some calls refused, some let through.
  for (const lane of ['research:', 'intake lane:', 'chat in a project:', 'agent:', 'researcher in a project:']) {
    const answers = Object.entries(got).filter(([k]) => k.startsWith(lane)).map(([, v]) => v);
    assert.ok(answers.some((a) => a === 'exit 0'), `${lane} some call allowed`);
    assert.ok(answers.some((a) => a.includes('"permissionDecision":"deny"')), `${lane} some call refused`);
  }
});
