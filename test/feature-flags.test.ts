import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { EventLog } from '../src/events/log.js';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventPayload } from '../src/events/types.js';
import { FILES, NO_FLAGS, ProjectConfig, withKnownFlags, withRetiredFlags } from '../src/config/schema.js';
import { FLAGS, FLAG_NAME, RETIRED_FLAGS, adoptFlags, clearFlags, flagOn, flagState, flagsInText, flagsSchema, recordedFlags } from '../src/flags.js';
import { startConfig } from '../src/config/live.js';
import { loadConfig, loadConfigAt } from '../src/config/load.js';
import { FakeRunner } from '../src/runner.js';
import { coordinator, fixture, git, skip, type Fixture } from './repro-state-graph/harness.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const base = parse(readFileSync(join(repoRoot, 'examples', 'basic', '.worklane', 'config.yaml'), 'utf8')) as Record<string, unknown>;
const ID = ['-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false'];
/** A flag registered only for the test that names it (the engine knows none yet). */
const T = 'test_flag';

test('flags: absent is none; only names the engine knows, each true or false; anything else makes the config invalid; the parsed value is always none', () => {
  const s = flagsSchema(() => ['risky_thing', 'other']);
  assert.equal(s.parse(undefined), NO_FLAGS);
  assert.equal(s.parse({ risky_thing: true, other: false }), NO_FLAGS, 'valid, and still no flags on the config: flagOn reads them from git');
  for (const bad of [{ risky_thng: true }, { 'Risky-Thing': true }, { risky_thing: 'yes' }, { risky_thing: 1 }, { risky_thing: null }, { '': true }]) {
    assert.equal(s.safeParse(bad).success, false, JSON.stringify(bad));
  }
  assert.match(JSON.stringify(s.safeParse({ risky_thng: true }).error?.issues), /no such flag: risky_thng \(the engine knows risky_thing, other/);
  assert.equal(ProjectConfig.parse(base).flags, NO_FLAGS);
  const unknown = ProjectConfig.safeParse({ ...base, flags: { not_a_flag_here: true } });
  assert.equal(unknown.success, false);
  assert.match(JSON.stringify(unknown.error?.issues), /no such flag: not_a_flag_here/);
});

test('a retired flag: still accepted in a config, whatever its value, and always off; any other unknown name stays invalid', () => {
  const s = flagsSchema(() => ['live_one'], () => ['old_one']);
  assert.equal(s.safeParse({ live_one: true, old_one: true }).success, true);
  assert.equal(s.safeParse({ old_one: 'yes' }).success, false, 'still a boolean, as when it was a flag');
  assert.equal(s.safeParse({ never_one: false }).success, false);
  assert.deepEqual(flagsInText('flags:\n  live_one: true\n  old_one: true\n', ['live_one'], ['old_one']), { on: ['live_one'] }, 'retired: accepted, never on');
});

test('the engine starts on a repo whose config still names a retired flag, on or off: loadConfig at start, with no last good config to fall back on (#1173 review)', () => {
  for (const value of [true, false]) {
    const dir = mkdtempSync(join(tmpdir(), 'flags-retired-'));
    cpSync(join(repoRoot, 'examples', 'basic'), dir, { recursive: true });
    appendFileSync(join(dir, '.worklane', 'config.yaml'), `flags:\n  retired_one: ${value}\n`);
    try {
      assert.throws(() => loadConfig(dir), /no such flag: retired_one/);
      const cfg = withRetiredFlags(['retired_one'], () => loadConfig(dir));
      assert.equal(cfg.project.flags, NO_FLAGS, `retired_one: ${value} loads`);
      assert.equal(flagOn('retired_one'), false);
      assert.throws(() => loadConfig(dir), /no such flag: retired_one/, 'retired only for that call');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** The engine files that name a test seam (any mention of the bare name). */
const seamUsers = (files: readonly (readonly [string, string])[]) => files.filter(([, text]) => /\bwith(Retired|Known)Flags\b/.test(text)).map(([f]) => f);
const srcFiles = () => {
  const src = join(repoRoot, 'src');
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : /\.[cm]?[jt]s$/.test(n) ? [join(d, n)] : []));
  return walk(src).map((f) => [f, readFileSync(f, 'utf8')] as const);
};

test('the flag lists are frozen and share no name; only the schema itself retires or registers one for a test (#1173 review)', async () => {
  assert.ok(Object.isFrozen(FLAGS), 'FLAGS is frozen');
  assert.ok(Object.isFrozen(RETIRED_FLAGS), 'RETIRED_FLAGS is frozen');
  assert.throws(() => (RETIRED_FLAGS as string[]).push('x'), TypeError);
  assert.throws(() => ((RETIRED_FLAGS as string[]).length = 0), TypeError);
  assert.throws(() => ((FLAGS as Record<string, unknown>).x = { what: 'w', since: '#1' }), TypeError);
  const known = Object.keys(FLAGS);
  assert.deepEqual(known.filter((n) => RETIRED_FLAGS.includes(n)), []);
  for (const n of [...known, ...RETIRED_FLAGS]) assert.match(n, FLAG_NAME);
  // The seams: only inside the call, nested calls unwind, a throw unwinds.
  const s = () => flagsSchema().safeParse({ seam_one: true }).success;
  assert.equal(s(), false);
  assert.equal(withRetiredFlags(['seam_one'], () => withRetiredFlags(['other'], s)), true);
  assert.equal(await withKnownFlags(['seam_one'], s), true);
  assert.equal(s(), false);
  await assert.rejects(withKnownFlags(['seam_one'], () => { throw new Error('boom'); }), /boom/);
  assert.equal(s(), false, 'unwound after a throw too');
  // No engine module names either seam: only src/config/schema.ts defines them, and only tests use them.
  const definer = join(repoRoot, 'src', 'config', 'schema.ts');
  assert.deepEqual(seamUsers(srcFiles().filter(([f]) => f !== definer)), []);
  for (const text of ["import { withRetiredFlags as retire } from './config/schema.js'; retire(['x'], f);", "schema.withKnownFlags.call(null, ['x'], f)", "withRetiredFlags (['x'], f)", "const { withKnownFlags: w } = schema;"]) {
    assert.deepEqual(seamUsers([['src/x-flags.ts', text]]), ['src/x-flags.ts'], text);
  }
});

test('one writer: only the coordinator adopts flags (#1173 review R1173h)', () => {
  const users = srcFiles().filter(([f, text]) => !f.endsWith(join('src', 'flags.ts')) && /\badoptFlags\b/.test(text)).map(([f]) => f.slice(repoRoot.length));
  assert.deepEqual(users, ['src/coordinator.ts']);
});

test('FILES and ProjectConfig.shape are frozen (a shallow freeze: zod objects inside can be changed), and no flag depends on the schema: a loosened one turns nothing on (#1173 reviews R1173f 2, R1173g, R1173h A8)', async () => {
  assert.ok(Object.isFrozen(FILES));
  assert.throws(() => ((FILES as Record<string, unknown>)['config.yaml'] = ProjectConfig), TypeError);
  assert.ok(Object.isFrozen(ProjectConfig.shape));
  assert.throws(() => ((ProjectConfig.shape as Record<string, unknown>).flags = null), TypeError);
  // R1173h A8: zod's own objects aren't frozen, so a module can loosen the flags schema in place. The flags flagOn
  // reads never go through it: flagsInText checks them in plain code.
  const zflags = ProjectConfig.shape.flags as unknown as { _zod: { run: (p: unknown, c: unknown) => unknown } };
  const run = zflags._zod.run;
  try {
    zflags._zod.run = (p) => p;
    assert.equal(ProjectConfig.safeParse({ ...base, flags: { typo_flag: true } }).success, true, 'the schema is loosened');
    await withKnownFlags([T], () => {
      assert.deepEqual(flagsInText(`flags:\n  typo_flag: true\n  ${T}: "yes"\n`), { error: 'no such flag: typo_flag' });
      assert.deepEqual(flagsInText(`flags:\n  ${T}: "yes"\n`), { error: `${T} is not true or false` });
    });
  } finally {
    zflags._zod.run = run;
  }
  assert.equal(ProjectConfig.safeParse({ ...base, flags: { typo_flag: true } }).success, false, 'restored');
});

test('flagsInText: only an own `true` of a known name turns a flag on; anything odd turns nothing on (#1173 review R1173h A10)', () => {
  const k = ['adv_x'];
  assert.deepEqual(flagsInText('version: 1\n', k), { on: [] });
  assert.deepEqual(flagsInText('flags:\n  adv_x: true\n', k), { on: ['adv_x'] });
  assert.deepEqual(flagsInText('flags:\n  adv_x: false\n', k), { on: [] });
  for (const v of ['flags:\n  adv_X: true\n', 'flags:\n  adv-x: true\n', 'flags:\n  "adv_x ": true\n', 'flags:\n  adv_х: true\n', 'flags:\n  adv_x: "true"\n', 'flags:\n  adv_x: 1\n', 'flags:\n  adv_x: false\n  adv_x: true\n', 'flags:\n  __proto__: { adv_x: true }\n', 'flags:\n  constructor: true\n', 'flags: [adv_x]\n', 'flags: adv_x\n', 'flags:\n  <<: { adv_x: true }\n']) {
    const r = flagsInText(v, k);
    assert.ok('error' in r || r.on.length === 0, `${JSON.stringify(v)} -> ${JSON.stringify(r)}`);
  }
});

test('flagOn: one reader, of the adopted snapshot only; no config object carries flags, nor can one be written on, nor inherited (#1173 review R1173h A3, A6, A7)', () => {
  clearFlags();
  const f = fixture();
  const proto = Object.prototype as Record<string, unknown>;
  try {
    // A3: the working tree's and a branch's flags, through loadConfig and loadConfigAt: the config carries none.
    appendFileSync(join(f.repo, '.worklane', 'config.yaml'), 'flags:\n  retired_x: true\n');
    const wt = withRetiredFlags(['retired_x'], () => loadConfig(f.repo));
    assert.equal(wt.project.flags, NO_FLAGS);
    git(f.repo, 'checkout', '-q', '-b', 'b');
    git(f.repo, 'add', '-A');
    git(f.repo, ...ID, 'commit', '-q', '-m', 'b');
    assert.equal(withRetiredFlags(['retired_x'], () => loadConfigAt(f.repo, 'b')).project.flags, NO_FLAGS);
    // A6: the parsed flags are frozen; a write throws.
    assert.throws(() => ((wt.project.flags as Record<string, boolean>).adv_x = true), TypeError);
    // A7: a polluted prototype turns nothing on.
    proto[T] = true;
    assert.equal(flagOn(T), false);
    assert.deepEqual(flagState(), { sha: null, on: [] });
  } finally {
    delete proto[T];
    f.log.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

/** Commit `edit` to main on the remote, as a person would. Returns the new commit. */
function onMain(f: Fixture, edit: (p: string) => void, msg: string): string {
  const person = join(f.base, `person-${Math.random().toString(36).slice(2)}`);
  git(f.base, 'clone', '-q', f.remote, person);
  edit(person);
  git(person, 'add', '-A');
  git(person, ...ID, 'commit', '-q', '-m', msg);
  git(person, 'push', '-q', 'origin', 'main');
  return git(person, 'rev-parse', 'HEAD').trim();
}
const cfgFile = (root: string) => join(root, '.worklane', 'config.yaml');
const flips = (f: Fixture) => f.log.read(0, ['flag.flipped']).map((e) => { const p = e.payload as EventPayload<'flag.flipped'>; return [p.flag, p.from, p.to, p.sha]; });

const adopt = (f: Fixture) => adoptFlags({ log: f.log, repo: f.repo, actor: 'i', check: () => [] });
const fetch = (f: Fixture) => git(f.repo, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');

test("adoptFlags: the default branch's head as the remote says, when its config is here and valid; each change of state recorded first; no change, no event", async () => {
  const f = fixture();
  try {
    await withKnownFlags(['a_flag', 'b_flag'], async () => {
      assert.deepEqual(adopt(f), [], 'main names none, never recorded: nothing to say');
      const s1 = onMain(f, (p) => appendFileSync(cfgFile(p), 'flags:\n  a_flag: true\n'), 'a on');
      assert.deepEqual(adopt(f), [], 'not fetched yet: the commit is not here, nothing is adopted');
      assert.equal(flagOn('a_flag'), false);
      fetch(f);
      adopt(f);
      assert.equal(flagOn('a_flag'), true);
      assert.deepEqual(flips(f), [['a_flag', false, true, s1]]);
      adopt(f);
      assert.equal(flips(f).length, 1, 'the same state again: no event');
      const s2 = onMain(f, (p) => writeFileSync(cfgFile(p), readFileSync(cfgFile(p), 'utf8').replace('a_flag: true', 'b_flag: true')), 'b on, a off');
      fetch(f);
      adopt(f);
      assert.deepEqual(flips(f).slice(1), [['a_flag', true, false, s2], ['b_flag', false, true, s2]]);
      assert.deepEqual(flagState(), { sha: s2, on: ['b_flag'] });
      // An invalid config at the head, or none: every flag off (R1173l D2: a failed read never keeps one on), recorded.
      onMain(f, (p) => appendFileSync(cfgFile(p), 'bogus_top: 1\n'), 'break');
      fetch(f);
      adopt(f);
      assert.deepEqual(flagState(), { sha: null, on: [] });
      assert.deepEqual(flips(f).at(-1), ['b_flag', true, false, null]);
      // Fixed again: read again (a failed read is never cached), on again.
      const s4 = onMain(f, (p) => writeFileSync(cfgFile(p), readFileSync(cfgFile(p), 'utf8').replace('bogus_top: 1\n', '')), 'fix');
      fetch(f);
      adopt(f);
      assert.deepEqual(flagState(), { sha: s4, on: ['b_flag'] });
      onMain(f, (p) => rmSync(join(p, '.worklane'), { recursive: true, force: true }), 'remove');
      fetch(f);
      adopt(f);
      assert.deepEqual(flagState(), { sha: null, on: [] }, 'a commit with no config: off');
    });
    // A flag the engine stopped knowing that was on is recorded off.
    adopt(f);
    assert.deepEqual([...recordedFlags(f.log)].sort(), [['a_flag', false], ['b_flag', false]]);
  } finally {
    clearFlags();
    f.log.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("adoptFlags reads the remote's head, never a local ref: an agent moving refs/remotes/origin/main, or a failed fetch, adopts nothing (#1173 review R1173j D1, D2, D4)", async () => {
  const f = fixture();
  try {
    await withKnownFlags([T], async () => {
      // An agent's commit in the coordinator's clone, with the flag on, and the remote-tracking ref moved to it.
      git(f.repo, 'checkout', '-q', '-b', 'agent');
      appendFileSync(cfgFile(f.repo), `flags:\n  ${T}: true\n`);
      git(f.repo, 'add', '-A');
      git(f.repo, ...ID, 'commit', '-q', '-m', 'agent: flag on');
      git(f.repo, 'update-ref', 'refs/remotes/origin/main', git(f.repo, 'rev-parse', 'HEAD').trim());
      adopt(f);
      assert.equal(flagOn(T), false, "the local ref is not the remote's head");
      assert.deepEqual(flips(f), []);
      // An agent's branch pushed to origin, named to sort before main's line (R1173l D1) or anything else (R1173k K1):
      // only origin's default branch, by its exact ref, counts.
      git(f.repo, 'push', '-q', 'origin', 'HEAD:refs/heads/a/refs/heads/main', 'HEAD:refs/heads/agent-task');
      adopt(f);
      assert.equal(flagOn(T), false, 'a pushed branch is never the source');
      // main turns it on, and then the remote can't be reached: every flag off (fail-closed), recorded.
      onMain(f, (p) => appendFileSync(cfgFile(p), `flags:\n  ${T}: true\n`), 'on');
      fetch(f);
      adopt(f);
      assert.equal(flagOn(T), true);
      renameSync(f.remote, `${f.remote}.gone`);
      try {
        adopt(f);
        assert.deepEqual(flagState(), { sha: null, on: [] }, 'unreachable: off');
        assert.deepEqual(flips(f).at(-1), [T, true, false, null]);
      } finally {
        renameSync(`${f.remote}.gone`, f.remote);
      }
    });
  } finally {
    clearFlags();
    f.log.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("a config this instance refuses (its check) turns no flag on: main's flags count only from a config the coordinator would apply (#1173 review R1173j)", async () => {
  const f = fixture();
  try {
    await withKnownFlags([T], async () => {
      onMain(f, (p) => appendFileSync(cfgFile(p), `flags:\n  ${T}: true\n`), 'on');
      fetch(f);
      adoptFlags({ log: f.log, repo: f.repo, actor: 'i', check: () => [{ file: 'config.yaml', path: '', message: 'this instance refuses it' }] });
      assert.equal(flagOn(T), false);
      assert.deepEqual(flips(f), []);
      adopt(f);
      assert.equal(flagOn(T), true, 'the same config, no refusal: on');
    });
  } finally {
    clearFlags();
    f.log.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('a flag is never on without its record: a flag.flipped that fails to write leaves the snapshot as it was (#1173 review R1173j D3)', async () => {
  const f = fixture();
  try {
    await withKnownFlags([T], async () => {
      onMain(f, (p) => appendFileSync(cfgFile(p), `flags:\n  ${T}: true\n`), 'on');
      fetch(f);
      const failing = { read: (...a: Parameters<EventLog["read"]>) => f.log.read(...a), append: () => { throw new Error('disk full'); }, buffered: () => ({ count: 0, dropped: 0, failure: null }) } as unknown as EventLog;
      assert.throws(() => adoptFlags({ log: failing, repo: f.repo, actor: 'i', check: () => [] }), /disk full/);
      assert.equal(flagOn(T), false);
      // R1173k K2: the buffered log dropped the record (id 0), or holds it in memory: the flag doesn't go on.
      for (const [why, id, count] of [['dropped', 0, 0], ['held in memory', 99, 1]] as const) {
        const lossy = { read: (...a: Parameters<EventLog["read"]>) => f.log.read(...a), append: () => ({ id }), buffered: () => ({ count, dropped: 0, failure: null }) } as unknown as EventLog;
        adoptFlags({ log: lossy, repo: f.repo, actor: 'i', check: () => [] });
        assert.equal(flagOn(T), false, why);
      }
      adopt(f);
      assert.equal(flagOn(T), true, 'recorded durably: on');
    });
  } finally {
    clearFlags();
    f.log.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('the known-flags seam refuses outside a test run (#1173 review R1173j: a computed name reached it from src/)', () => {
  const schema = join(repoRoot, 'dist', 'src', 'config', 'schema.js');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { withKnownFlags } from ${JSON.stringify(schema)}; withKnownFlags(['x'], () => 1).then(() => console.log('RAN'), (e) => console.log('REFUSED: ' + e.message));`], { encoding: 'utf8', env });
  assert.match(r.stdout, /^REFUSED: withKnownFlags is for tests only/, r.stderr);
});

/** Start like the service: startConfig, then a coordinator on its config and tree. */
function startOn(f: Fixture) {
  const start = startConfig({ repo: f.repo, remote: 'origin', fallback: loadConfig(f.repo) });
  const c = coordinator(f, new FakeRunner(() => ({ structured: { summary: 's' } })), { cfg: { ...start.cfg, project: { ...start.cfg.project, land_mode: 'direct' } }, liveConfig: { tree: start.tree } });
  return { start, c };
}
const ticks = async (c: { tick: () => Promise<unknown>; idle: () => Promise<unknown> }, n = 1) => {
  for (let i = 0; i < n; i++) {
    await c.tick();
    await c.idle();
  }
};

test("a checkout's config never turns a flag on: started on it (main invalid or missing), every flag is off and none is recorded (#1173 reviews R1173f 1, R1173h A1, A2)", { skip }, async () => {
  for (const breakMain of [(p: string) => appendFileSync(cfgFile(p), 'bogus_top: 1\n'), (p: string) => rmSync(join(p, '.worklane'), { recursive: true, force: true })]) {
    const f = fixture();
    try {
      await withKnownFlags([T], async () => {
        git(f.repo, 'checkout', '-q', '-b', 'try-it');
        appendFileSync(cfgFile(f.repo), `flags:\n  ${T}: true\n`);
        git(f.repo, 'add', '-A');
        git(f.repo, ...ID, 'commit', '-q', '-m', 'branch: flag on');
        onMain(f, breakMain, 'break main');
        const { start, c } = startOn(f);
        assert.match(start.note ?? '', /started with the checkout's/);
        await ticks(c, 2);
        assert.equal(flagOn(T), false);
        assert.deepEqual(flips(f), []);
      });
    } finally {
      clearFlags();
      f.log.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  }
});

test("the coordinator's tick adopts main's flag with its record; main broken or its config removed before the first tick adopts nothing until it is valid again (#1173 reviews R1173h A4, A4b, A5)", { skip }, async () => {
  for (const [what, breakMain] of [['invalid', (p: string) => appendFileSync(cfgFile(p), 'bogus_top: 1\n')], ['removed', (p: string) => rmSync(join(p, '.worklane'), { recursive: true, force: true })]] as const) {
    const f = fixture();
    try {
      await withKnownFlags([T], async () => {
        const s0 = onMain(f, (p) => appendFileSync(cfgFile(p), `flags:\n  ${T}: true\n`), 'turn it on');
        const { start, c } = startOn(f);
        assert.equal(start.note, null);
        await ticks(c);
        assert.equal(flagOn(T), true, `${what}: main's head, adopted at the first tick`);
        assert.deepEqual(flips(f), [[T, false, true, s0]]);
        clearFlags();
        const f2 = fixture();
        try {
          onMain(f2, (p) => appendFileSync(cfgFile(p), `flags:\n  ${T}: true\n`), 'turn it on');
          const { c: c2 } = startOn(f2);
          onMain(f2, breakMain, `main ${what}`);
          await ticks(c2, 2);
          assert.equal(flagOn(T), false, `${what} before the first tick: nothing adopted (fail-closed)`);
          assert.deepEqual(flips(f2), [], `${what}: nothing recorded`);
          if (what === 'invalid') {
            const s2 = onMain(f2, (p) => writeFileSync(cfgFile(p), readFileSync(cfgFile(p), 'utf8').replace('bogus_top: 1\n', '')), 'fix');
            await ticks(c2);
            assert.equal(flagOn(T), true);
            assert.deepEqual(flips(f2), [[T, false, true, s2]]);
          }
        } finally {
          f2.log.close();
          rmSync(f2.base, { recursive: true, force: true });
        }
      });
    } finally {
      clearFlags();
      f.log.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  }
});

test("started on the checkout, then main is valid again on that same tree: recovered, and main's flag turns on with its record (#1173 reviews R1173g, R1173h A12)", { skip }, async () => {
  const f = fixture();
  try {
    await withKnownFlags([T], async () => {
      onMain(f, (p) => appendFileSync(cfgFile(p), `flags:\n  ${T}: true\n`), 'turn it on');
      git(f.repo, 'pull', '-q', 'origin', 'main');
      onMain(f, (p) => appendFileSync(cfgFile(p), 'bogus_top: 1\n'), 'break main');
      const { start, c } = startOn(f);
      assert.match(start.note ?? '', /committed config \(HEAD\)/);
      await ticks(c);
      assert.equal(flagOn(T), false, 'the checkout: off');
      const s2 = onMain(f, (p) => writeFileSync(cfgFile(p), readFileSync(cfgFile(p), 'utf8').replace('bogus_top: 1\n', '')), 'revert');
      await ticks(c);
      assert.equal(f.log.read(0, ['config.recovered']).length, 1);
      assert.equal(flagOn(T), true, "main's config, at its commit");
      assert.deepEqual(flips(f), [[T, false, true, s2]]);
    });
  } finally {
    clearFlags();
    f.log.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("the coordinator's tick audits flag state: a flag recorded on that this engine doesn't know is recorded off at its first tick", { skip }, async () => {
  const f = fixture();
  try {
    f.log.append('flag.flipped', { flag: 'retired_flag', from: false, to: true, sha: null }, 'earlier-engine');
    const c = coordinator(f, new FakeRunner(() => ({ structured: { summary: 's' } })));
    await ticks(c);
    assert.deepEqual(flips(f).slice(1).map((p) => p.slice(0, 3)), [['retired_flag', true, false]]);
    await ticks(c);
    assert.equal(flips(f).length, 2, 'and once only');
  } finally {
    clearFlags();
    f.log.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});
