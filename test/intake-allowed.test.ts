// isAllowed has one case per source and no default (src/intake/report.ts): a source added to SOURCES without its own
// allow check must never be let in by omission. The compiler refuses the missing case (the function would end without
// a return); this test refuses it at run time too (the answer would be undefined, not a boolean).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IntakeConfig, isAllowed, SOURCES } from '../src/intake/report.js';

test('isAllowed answers a boolean for every source in SOURCES: none is missing its case', () => {
  const cfg = IntakeConfig.parse({ version: 1 });
  for (const source of SOURCES) {
    const got: unknown = isAllowed({ source, id: 'someone' }, cfg);
    assert.equal(typeof got, 'boolean', `isAllowed has no case for source "${source}" (add one in src/intake/report.ts)`);
  }
});

test("isAllowed keeps today's answers: Discord by its list, the owner-gated sources allowed, the removed voice source nobody", () => {
  const cfg = IntakeConfig.parse({ version: 1, discord: { allowed_senders: ['100000000000000011'] } });
  assert.equal(isAllowed({ source: 'discord', id: '100000000000000011' }, cfg), true);
  assert.equal(isAllowed({ source: 'discord', id: '100000000000000099' }, cfg), false);
  for (const source of ['bug-store', 'alerts', 'github'] as const) assert.equal(isAllowed({ source, id: 'x' }, cfg), true, source);
  // Voice and Siri were removed (#743): a voice report is taken from nobody, even with intake.yaml's old keys on.
  const old = IntakeConfig.parse({ version: 1, voice: { enabled: true }, siri: { enabled: true } });
  for (const c of [cfg, old]) assert.equal(isAllowed({ source: 'voice', id: 'x' }, c), false);
});
