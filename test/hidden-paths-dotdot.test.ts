// #887 review (round 5): an absolute secret glob (`/**/evals/held-out/**`) is tested against an absolute path as the
// call wrote it, `..` kept, as before #847, and not only against the normalised path. A path that steps into such a
// directory and back out names that directory on the way, and the base refused it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GuardrailsConfig } from '../src/config/schema.js';
import { exampleContext } from '../src/guardrails/check.js';
import { evaluate } from '../src/guardrails/engine.js';

test('an absolute path that enters a directory an absolute secret glob covers and steps back out with .. is refused', () => {
  const p = mkdtempSync(join(tmpdir(), 'hidden-dotdot-'));
  mkdirSync(join(p, 'evals', 'held-out'), { recursive: true });
  writeFileSync(join(p, 'evals', 'held-out', 'score.py'), 'EXPECTED = 42\n');
  writeFileSync(join(p, 'evals', 'notes.txt'), 'notes\n');
  const g = GuardrailsConfig.parse({ version: 1, rules: [], secret_paths: ['/**/evals/held-out/**'], examples: { must_block: [], must_ask: [], must_allow: [] } });
  const decide = (tool: string, input: Record<string, unknown>) => evaluate({ tool, input, cwd: p }, g, { ...exampleContext(g, p, true), home: join(p, 'no-home') });
  const through = `${p}/evals/held-out/../notes.txt`;
  const cases: [string, string, Record<string, unknown>, 'deny' | 'none'][] = [
    ['a Bash word', 'Bash', { command: `cat ${through}` }, 'deny'],
    ['a Read path', 'Read', { file_path: through }, 'deny'],
    ['the same file named directly (control)', 'Read', { file_path: join(p, 'evals', 'notes.txt') }, 'none'],
  ];
  for (const [what, tool, input, want] of cases) {
    const v = decide(tool, input);
    assert.equal(v.decision, want, `${what}: ${v.decision} ${v.reason ?? ''}`);
    if (want === 'deny') assert.equal(v.rule, 'secret-path', what);
  }
});
