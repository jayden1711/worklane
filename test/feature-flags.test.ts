import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { ProjectConfig } from '../src/config/schema.js';
import { FLAGS, flagOn, flagsSchema, recordFlagFlips, recordedFlags } from '../src/flags.js';
import { FakeRunner } from '../src/runner.js';
import { coordinator, fixture, skip } from './repro-state-graph/harness.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const base = parse(readFileSync(join(repoRoot, 'examples', 'basic', '.worklane', 'config.yaml'), 'utf8')) as Record<string, unknown>;

test('flags: absent is none; only names the engine knows, each true or false; anything else makes the config invalid', () => {
  const s = flagsSchema(['risky_thing', 'other']);
  assert.deepEqual(s.parse(undefined), {});
  assert.deepEqual(s.parse({ risky_thing: true, other: false }), { risky_thing: true, other: false });
  for (const bad of [{ risky_thng: true }, { 'Risky-Thing': true }, { risky_thing: 'yes' }, { risky_thing: 1 }, { risky_thing: null }, { '': true }]) {
    assert.equal(s.safeParse(bad).success, false, JSON.stringify(bad));
  }
  const typo = s.safeParse({ risky_thng: true });
  assert.match(JSON.stringify(typo.error?.issues), /no such flag: risky_thng \(the engine knows risky_thing, other/);
  // The real config.yaml: every flag off with none set, and a name this engine doesn't know refused.
  assert.deepEqual(ProjectConfig.parse(base).flags, {});
  const unknown = ProjectConfig.safeParse({ ...base, flags: { not_a_flag_here: true } });
  assert.equal(unknown.success, false);
  assert.match(JSON.stringify(unknown.error?.issues), /no such flag: not_a_flag_here/);
  for (const name of Object.keys(FLAGS)) assert.equal(ProjectConfig.parse(base).flags[name], undefined, `${name} is off by default`);
});

test('flagOn: only an explicit true is on', () => {
  assert.equal(flagOn({ x: true }, 'x'), true);
  for (const f of [{ x: false }, {}, undefined, { y: true }, { x: 'true' } as unknown as Record<string, boolean>, { x: 1 } as unknown as Record<string, boolean>]) assert.equal(flagOn(f, 'x'), false, JSON.stringify(f));
});

test('flag flips are audited: each change of state from the last one recorded is one flag.flipped, with the config commit; no change, no event', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flags-'));
  const log = new EventLog(join(dir, 'events.db'));
  const known = ['a_flag', 'b_flag'];
  const flips = () => log.read(0, ['flag.flipped']).map((e) => e.payload as EventPayload<'flag.flipped'>);
  const sha1 = '1'.repeat(40);
  const sha2 = '2'.repeat(40);
  try {
    assert.deepEqual(recordFlagFlips({ log, flags: {}, sha: sha1, actor: 'i', known }), [], 'all off, never recorded: nothing to say');
    recordFlagFlips({ log, flags: { a_flag: true }, sha: sha1, actor: 'i', known });
    assert.deepEqual(flips(), [{ flag: 'a_flag', from: false, to: true, sha: sha1 }]);
    recordFlagFlips({ log, flags: { a_flag: true, b_flag: false }, sha: sha1, actor: 'i', known });
    assert.equal(flips().length, 1, 'the same state again: no event (b_flag false is off, as before)');
    recordFlagFlips({ log, flags: { b_flag: true }, sha: sha2, actor: 'i', known });
    assert.deepEqual(flips().slice(1), [
      { flag: 'a_flag', from: true, to: false, sha: sha2 },
      { flag: 'b_flag', from: false, to: true, sha: sha2 },
    ]);
    // A flag the engine stopped knowing (removed once its change became the default) that was on is recorded off.
    recordFlagFlips({ log, flags: { b_flag: true }, sha: sha2, actor: 'i', known: ['a_flag'] });
    assert.deepEqual(flips().at(-1), { flag: 'b_flag', from: true, to: false, sha: sha2 });
    assert.deepEqual([...recordedFlags(log)].sort(), [['a_flag', false], ['b_flag', false]]);
    assert.equal(log.read(0, ['flag.flipped']).every((e) => e.actor === 'i'), true);
  } finally {
    log.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the coordinator's tick audits flag state: a flag recorded on that this engine doesn't know is recorded off at its first tick", { skip }, async () => {
  const f = fixture();
  try {
    f.log.append('flag.flipped', { flag: 'retired_flag', from: false, to: true, sha: null }, 'earlier-engine');
    const c = coordinator(f, new FakeRunner(() => ({ structured: { summary: 's' } })));
    await c.tick();
    await c.idle();
    const after = f.log.read(0, ['flag.flipped']).map((e) => e.payload as EventPayload<'flag.flipped'>);
    assert.deepEqual(after.slice(1).map((p) => [p.flag, p.from, p.to]), [['retired_flag', true, false]]);
    await c.tick();
    await c.idle();
    assert.equal(f.log.read(0, ['flag.flipped']).length, 2, 'and once only');
  } finally {
    f.log.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});
