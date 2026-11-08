import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { ProjectConfig } from '../src/config/schema.js';
import { FLAGS, FLAG_NAME, RETIRED_FLAGS, flagOn, flagsSchema, recordFlagFlips, recordedFlags, withRetiredFlags } from '../src/flags.js';
import { loadConfig } from '../src/config/load.js';
import { FakeRunner } from '../src/runner.js';
import { coordinator, fixture, skip } from './repro-state-graph/harness.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const base = parse(readFileSync(join(repoRoot, 'examples', 'basic', '.worklane', 'config.yaml'), 'utf8')) as Record<string, unknown>;

test('flags: absent is none; only names the engine knows, each true or false; anything else makes the config invalid', () => {
  const s = flagsSchema(() => ['risky_thing', 'other']);
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

test('a retired flag: still accepted in a config, whatever its value, and always off; any other unknown name stays invalid', () => {
  const s = flagsSchema(() => ['live_one'], () => ['old_one']);
  assert.deepEqual(s.parse({ live_one: true, old_one: true }), { live_one: true }, 'dropped from the parsed flags, so never on');
  assert.deepEqual(s.parse({ old_one: false }), {});
  assert.equal(s.safeParse({ old_one: 'yes' }).success, false, 'still a boolean, as when it was a flag');
  assert.equal(s.safeParse({ never_one: false }).success, false);
});

test('the engine starts on a repo whose config still names a retired flag, on or off: loadConfig at start, with no last good config to fall back on (#1173 review)', () => {
  for (const value of [true, false]) {
    const dir = mkdtempSync(join(tmpdir(), 'flags-retired-'));
    cpSync(join(repoRoot, 'examples', 'basic'), dir, { recursive: true });
    appendFileSync(join(dir, '.worklane', 'config.yaml'), `flags:\n  retired_one: ${value}\n`);
    try {
      // Before it is retired (an engine that never knew it): the config is invalid, as for any unknown name.
      assert.throws(() => loadConfig(dir), /no such flag: retired_one/);
      const cfg = withRetiredFlags(['retired_one'], () => loadConfig(dir));
      assert.deepEqual(cfg.project.flags, {}, `retired_one: ${value} loads, and is off`);
      assert.equal(flagOn(cfg.project.flags, 'retired_one'), false);
      assert.throws(() => loadConfig(dir), /no such flag: retired_one/, 'retired only for that call');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('the flag lists are frozen and share no name; only the schema itself retires one for a test (#1173 review)', () => {
  assert.ok(Object.isFrozen(FLAGS), 'FLAGS is frozen');
  assert.ok(Object.isFrozen(RETIRED_FLAGS), 'RETIRED_FLAGS is frozen');
  assert.throws(() => (RETIRED_FLAGS as string[]).push('x'), TypeError, 'nothing can retire a name from outside the reviewed file');
  assert.throws(() => ((RETIRED_FLAGS as string[]).length = 0), TypeError, 'nor bring the startup outage back by emptying it');
  assert.throws(() => ((FLAGS as Record<string, unknown>).x = { what: 'w', since: '#1' }), TypeError);
  const known = Object.keys(FLAGS);
  assert.deepEqual(known.filter((n) => RETIRED_FLAGS.includes(n)), [], 'no name is both known and retired');
  for (const n of [...known, ...RETIRED_FLAGS]) assert.match(n, FLAG_NAME);
  // The seam: retired only inside the call, and nested calls unwind.
  const s = () => flagsSchema().safeParse({ seam_one: true }).success;
  assert.equal(s(), false);
  assert.equal(withRetiredFlags(['seam_one'], () => withRetiredFlags(['other'], s)), true);
  assert.equal(s(), false);
  assert.throws(() => withRetiredFlags(['seam_one'], () => { throw new Error('boom'); }), /boom/);
  assert.equal(s(), false, 'unwound after a throw too');
  // No engine module calls the seam: only the schema defines it, and only tests use it.
  const src = join(repoRoot, 'src');
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : n.endsWith('.ts') ? [join(d, n)] : []));
  const callers = walk(src).filter((f) => !f.endsWith(join('config', 'schema.ts')) && !f.endsWith('flags.ts') && /withRetiredFlags\(/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(callers, []);
  assert.doesNotMatch(readFileSync(join(src, 'flags.ts'), 'utf8'), /withRetiredFlags\(/, 'flags.ts only re-exports it');
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
