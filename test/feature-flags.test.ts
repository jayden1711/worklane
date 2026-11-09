import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { EventLog } from '../src/events/log.js';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { EventPayload } from '../src/events/types.js';
import { FILES, NO_FLAGS, ProjectConfig, withKnownFlags, withRetiredFlags } from '../src/config/schema.js';
import { FLAGS, FLAG_NAME, RETIRED_FLAGS, adoptFlags, clearFlags, flagOn, flagState, flagsInText, flagsSchema, recordedFlags } from '../src/flags.js';
import { startConfig } from '../src/config/live.js';
import { loadConfig, loadConfigAt } from '../src/config/load.js';
import { FakeRunner } from '../src/runner.js';
import { exportBundle, importBundle } from '../src/instance-move.js';
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

const adopt = (f: Fixture) => adoptFlags({ log: f.log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
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
      adoptFlags({ log: f.log, repo: f.repo, actor: 'i', branch: 'main', check: () => [{ file: 'config.yaml', path: '', message: 'this instance refuses it' }] });
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
      assert.throws(() => adoptFlags({ log: failing, repo: f.repo, actor: 'i', branch: 'main', check: () => [] }), /disk full/);
      assert.equal(flagOn(T), false);
      // R1173k K2: the buffered log dropped the record (id 0), or holds it in memory: the flag doesn't go on.
      for (const [why, id, count] of [['dropped', 0, 0], ['held in memory', 99, 1]] as const) {
        const lossy = { read: (...a: Parameters<EventLog["read"]>) => f.log.read(...a), append: () => ({ id }), buffered: () => ({ count, dropped: 0, failure: null }) } as unknown as EventLog;
        adoptFlags({ log: lossy, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
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


/** The disk is full, as test/disk-full.test.ts makes it: the database can't grow, and its pages are filled. */
function fillLog(log: EventLog) {
  const pages = (log.db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
  log.db.exec(`PRAGMA max_page_count = ${pages}`);
  const put = log.db.prepare("INSERT INTO events (ts, type, actor, source, payload) VALUES ('2026-01-01T00:00:00Z', 'coordinator.tick', 'filler', 'coordinator', ?)");
  for (const size of [4096, 512, 64, 8, 1]) {
    try {
      for (;;) put.run(JSON.stringify({ instance: 'filler', dispatched: 0, reconciled: 0, pad: 'x'.repeat(size) }));
    } catch {
      // full at this size: try a smaller one
    }
  }
}
const roomLog = (log: EventLog) => log.db.exec('PRAGMA max_page_count = 1073741823');

test('R1173m 1: on a full disk (real SQLITE_FULL), a held flag.flipped never turns the flag on, on the first tick or the next; once written, it does', async () => {
  const f = fixture();
  const log = new EventLog(f.log.path, { buffer: {} });
  try {
    await withKnownFlags([T], async () => {
      onMain(f, (p) => appendFileSync(cfgFile(p), `flags:\n  ${T}: true\n`), 'on');
      fetch(f);
      fillLog(log);
      const a = () => adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
      a();
      assert.equal(flagOn(T), false, 'the first tick: the record is held in memory');
      a();
      assert.equal(flagOn(T), false, 'the next tick: the held record reads as recorded, and still turns nothing on');
      roomLog(log);
      log.flush();
      a();
      assert.equal(flagOn(T), true, 'written: on');
    });
  } finally {
    clearFlags();
    log.close();
    f.log.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("R1173n M3: origin's HEAD moved to another branch: flags follow only this instance's configured default branch, so none is on", async () => {
  const f = fixture();
  try {
    await withKnownFlags([T], async () => {
      git(f.repo, 'checkout', '-q', '-b', 'agent');
      appendFileSync(cfgFile(f.repo), `flags:\n  ${T}: true\n`);
      git(f.repo, 'add', '-A');
      git(f.repo, ...ID, 'commit', '-q', '-m', 'agent: on');
      git(f.repo, 'push', '-q', 'origin', 'agent');
      git(f.remote, 'symbolic-ref', 'HEAD', 'refs/heads/agent');
      fetch(f);
      git(f.repo, 'fetch', '-q', 'origin', 'agent');
      adopt(f);
      assert.equal(flagOn(T), false, "origin's HEAD isn't this instance's default branch");
    });
  } finally {
    clearFlags();
    f.log.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('a default branch that is not main (trunk): flags come from it when it is configured, never when another is', async () => {
  const f = fixture();
  try {
    await withKnownFlags([T], async () => {
      onMain(f, (p) => appendFileSync(cfgFile(p), `flags:\n  ${T}: true\n`), 'on');
      git(f.remote, 'branch', '-m', 'main', 'trunk');
      git(f.remote, 'symbolic-ref', 'HEAD', 'refs/heads/trunk');
      git(f.repo, 'fetch', '-q', 'origin', '+refs/heads/trunk:refs/remotes/origin/trunk');
      adoptFlags({ log: f.log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
      assert.equal(flagOn(T), false, 'configured main, origin says trunk: off');
      adoptFlags({ log: f.log, repo: f.repo, actor: 'i', branch: 'trunk', check: () => [] });
      assert.equal(flagOn(T), true, 'configured trunk: on');
    });
  } finally {
    clearFlags();
    f.log.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("R1173m: the coordinator adopts flags even when refreshing the config threw (a config.applied that can't be written)", { skip }, async () => {
  const f = fixture();
  try {
    await withKnownFlags([T], async () => {
      onMain(f, (p) => appendFileSync(cfgFile(p), `flags:\n  ${T}: true\n`), 'on');
      const { c } = startOn(f);
      await ticks(c);
      assert.equal(flagOn(T), true);
      // main turns it off and changes another setting, so the poll applies a new config and writes config.applied.
      onMain(f, (p) => writeFileSync(cfgFile(p), readFileSync(cfgFile(p), 'utf8').replace(`${T}: true`, `${T}: false`) + '# changed\n'), 'off, and a change');
      const append = f.log.append.bind(f.log);
      (f.log as { append: unknown }).append = (type: string, ...rest: unknown[]) => {
        if (type === 'config.applied') throw new Error('write refused');
        return (append as (...a: unknown[]) => unknown)(type, ...rest);
      };
      await ticks(c);
      assert.equal(flagOn(T), false, 'off, though the config step threw');
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

/** A second connection holding the log's write lock (BEGIN IMMEDIATE): the log's next write fails with SQLITE_BUSY. */
function lockLog(path: string): { release: () => void } {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 0');
  db.exec('BEGIN IMMEDIATE');
  return { release: () => { db.exec('ROLLBACK'); db.close(); } };
}
const turnOff = (p: string) => writeFileSync(cfgFile(p), readFileSync(cfgFile(p), 'utf8').replace(`${T}: true`, `${T}: false`));
const turnOn = (p: string) => writeFileSync(cfgFile(p), readFileSync(cfgFile(p), 'utf8').replace(`${T}: false`, `${T}: true`));

test('R1173o 2: main turns a flag off while a second connection holds the real log locked (SQLITE_BUSY): off at once, recorded once the lock is gone', async () => {
  const f = fixture();
  const log = new EventLog(f.log.path, { buffer: {} });
  try {
    await withKnownFlags([T], async () => {
      const s1 = onMain(f, (p) => appendFileSync(cfgFile(p), `flags:\n  ${T}: true\n`), 'on');
      fetch(f);
      const a = () => adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
      a();
      assert.equal(flagOn(T), true);
      const s2 = onMain(f, turnOff, 'off');
      fetch(f);
      const lock = lockLog(f.log.path);
      try {
        assert.throws(a, /locked/);
        assert.equal(log.buffered().count, 0, 'SQLITE_BUSY is thrown, not held');
        assert.equal(flagOn(T), false, 'off before the record that failed');
      } finally {
        lock.release();
      }
      a();
      assert.equal(flagOn(T), false);
      assert.deepEqual(flips(f), [[T, false, true, s1], [T, true, false, s2]]);
    });
  } finally {
    clearFlags();
    log.close();
    f.log.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('R1173p 2: a flag turned off whose off record failed, then turned on again by main: the off and the new on are both recorded', async () => {
  const f = fixture();
  const log = new EventLog(f.log.path, { buffer: {} });
  try {
    await withKnownFlags([T], async () => {
      const s1 = onMain(f, (p) => appendFileSync(cfgFile(p), `flags:\n  ${T}: true\n`), 'on');
      fetch(f);
      const a = () => adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
      a();
      const s2 = onMain(f, turnOff, 'off');
      fetch(f);
      const lock = lockLog(f.log.path);
      try {
        assert.throws(a, /locked/);
      } finally {
        lock.release();
      }
      assert.equal(flagOn(T), false);
      const s3 = onMain(f, turnOn, 'on again');
      fetch(f);
      a();
      assert.equal(flagOn(T), true);
      assert.deepEqual(flips(f), [[T, false, true, s1], [T, true, false, s2], [T, false, true, s3]], 'the off it ran, then the on');
    });
  } finally {
    clearFlags();
    log.close();
    f.log.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('R1173p 1: main turns a flag off and the instance check throws (as reading policy.yaml can): every flag off, and recorded off', async () => {
  for (const thrown of [Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }), new Error('EISDIR: illegal operation on a directory, read')]) {
    const f = fixture();
    try {
      await withKnownFlags([T], async () => {
        const s1 = onMain(f, (p) => appendFileSync(cfgFile(p), `flags:\n  ${T}: true\n`), 'on');
        fetch(f);
        adopt(f);
        assert.equal(flagOn(T), true);
        onMain(f, turnOff, 'off');
        fetch(f);
        const a = () => adoptFlags({ log: f.log, repo: f.repo, actor: 'i', branch: 'main', check: () => { throw thrown; } });
        a();
        assert.equal(flagOn(T), false, `${thrown.message}: off`);
        a();
        assert.equal(flagOn(T), false, `${thrown.message}: still off while the check throws`);
        assert.deepEqual(flips(f), [[T, false, true, s1], [T, true, false, null]]);
      });
    } finally {
      clearFlags();
      f.log.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  }
});

test("R1173p 1: the coordinator's tick, the instance check throwing: the flag goes off and stays off", { skip }, async () => {
  const f = fixture();
  try {
    await withKnownFlags([T], async () => {
      onMain(f, (p) => appendFileSync(cfgFile(p), `flags:\n  ${T}: true\n`), 'on');
      let broken = false;
      const check = () => { if (broken) throw new Error('EISDIR: illegal operation on a directory, read'); return []; };
      const start = startConfig({ repo: f.repo, remote: 'origin', fallback: loadConfig(f.repo) });
      const c = coordinator(f, new FakeRunner(() => ({ structured: { summary: 's' } })), { cfg: { ...start.cfg, project: { ...start.cfg.project, land_mode: 'direct' } }, liveConfig: { tree: start.tree, check } });
      await ticks(c);
      assert.equal(flagOn(T), true);
      onMain(f, turnOff, 'off');
      broken = true;
      await ticks(c, 3);
      assert.equal(flagOn(T), false);
    });
  } finally {
    clearFlags();
    f.log.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("R1173o 1: the coordinator's tick on a repo whose default branch is trunk adopts trunk's flag; configured main against a trunk HEAD adopts nothing", { skip }, async () => {
  for (const configured of ['trunk', 'main']) {
    const f = fixture();
    try {
      await withKnownFlags([T], async () => {
        onMain(f, (p) => writeFileSync(cfgFile(p), readFileSync(cfgFile(p), 'utf8').replace('default_branch: main', 'default_branch: trunk') + `flags:\n  ${T}: true\n`), 'trunk, and on');
        git(f.remote, 'branch', '-m', 'main', 'trunk');
        git(f.remote, 'symbolic-ref', 'HEAD', 'refs/heads/trunk');
        git(f.repo, 'fetch', '-q', 'origin', '+refs/heads/trunk:refs/remotes/origin/trunk');
        const base = loadConfig(f.repo);
        const cfg = { ...base, project: { ...base.project, land_mode: 'direct' as const, project: { ...base.project.project, default_branch: configured } } };
        const c = coordinator(f, new FakeRunner(() => ({ structured: { summary: 's' } })), { cfg });
        await ticks(c);
        assert.equal(flagOn(T), configured === 'trunk', `configured ${configured}, origin's HEAD trunk`);
      });
    } finally {
      clearFlags();
      f.log.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  }
});

test('R1173q 1: an off recorded late, then main on during a full disk: one off and one on, never the pair again at each held tick', async () => {
  const f = fixture();
  const log = new EventLog(f.log.path, { buffer: {} });
  try {
    await withKnownFlags([T], async () => {
      const s1 = onMain(f, (p) => appendFileSync(cfgFile(p), `flags:\n  ${T}: true\n`), 'on');
      fetch(f);
      const a = () => adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
      a();
      const s2 = onMain(f, turnOff, 'off');
      fetch(f);
      const lock = lockLog(f.log.path);
      try {
        assert.throws(a, /locked/);
      } finally {
        lock.release();
      }
      const s3 = onMain(f, turnOn, 'on again');
      fetch(f);
      fillLog(log);
      for (let i = 0; i < 3; i++) {
        a();
        assert.equal(flagOn(T), false, `held tick ${i}`);
      }
      roomLog(log);
      log.flush();
      a();
      assert.equal(flagOn(T), true);
      assert.deepEqual(flips(f), [[T, false, true, s1], [T, true, false, s2], [T, false, true, s3]]);
    });
  } finally {
    clearFlags();
    log.close();
    f.log.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('R1173q note 1: an off whose record is dropped (the buffer full) is still recorded before main turns the flag on again', async () => {
  const f = fixture();
  const log = new EventLog(f.log.path, { buffer: { max: 0 } });
  try {
    await withKnownFlags([T], async () => {
      const s1 = onMain(f, (p) => appendFileSync(cfgFile(p), `flags:\n  ${T}: true\n`), 'on');
      fetch(f);
      const a = () => adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
      a();
      assert.equal(flagOn(T), true);
      fillLog(log);
      const s2 = onMain(f, turnOff, 'off');
      fetch(f);
      a();
      assert.equal(flagOn(T), false, 'off, its record dropped');
      const s3 = onMain(f, turnOn, 'on again');
      fetch(f);
      a();
      assert.equal(flagOn(T), false, 'nothing goes on while the records are dropped');
      roomLog(log);
      a();
      assert.equal(flagOn(T), true);
      assert.deepEqual(flips(f), [[T, false, true, s1], [T, true, false, s2], [T, false, true, s3]]);
    });
  } finally {
    clearFlags();
    log.close();
    f.log.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("R1173r 1: the coordinator's tick under a log locked past the busy timeout ends, the process restarts, then main turns the flag on: the off and the on are both recorded", { skip }, async () => {
  const f0 = fixture();
  f0.log.close();
  const f = { ...f0, log: new EventLog(f0.log.path, { buffer: {} }) };
  try {
    await withKnownFlags([T], async () => {
      const s1 = onMain(f, (p) => appendFileSync(cfgFile(p), `flags:\n  ${T}: true\n`), 'on');
      const { c } = startOn(f);
      await ticks(c);
      assert.equal(flagOn(T), true);
      const s2 = onMain(f, turnOff, 'off');
      const lock = lockLog(f.log.path);
      try {
        // config.applied, the flag record and the step's own coordinator.error each wait out the busy timeout.
        await assert.rejects(ticks(c), /locked/);
      } finally {
        lock.release();
      }
      assert.equal(flagOn(T), false);
      // The process ends (the service's loop has no catch; systemd starts a fresh one): nothing in memory survives.
      clearFlags();
      const s3 = onMain(f, turnOn, 'on again');
      const { c: c2 } = startOn(f);
      await ticks(c2);
      assert.equal(flagOn(T), true);
      assert.deepEqual(flips(f), [[T, false, true, s1], [T, true, false, s2], [T, false, true, s3]], 'the off it ran, then the on');
    });
  } finally {
    clearFlags();
    f.log.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

const offFilePath = (f: Fixture) => join(f.base, 'flags-unrecorded.json');
/** A process restart: nothing in memory survives, and the log is opened again (what it held is lost). */
const restart = (log: EventLog, path: string) => {
  clearFlags();
  log.close();
  return new EventLog(path, { buffer: {} });
};

test('R1173s 1, R1173t D1: an off already on disk leaves flags-unrecorded.json, so a restart after a tick that held a record never writes its pair again', async () => {
  const f = fixture();
  const A = 'a_flag';
  const B = 'b_flag';
  let log = new EventLog(f.log.path, { buffer: {} });
  try {
    await withKnownFlags([A, B], async () => {
      const s1 = onMain(f, (p) => appendFileSync(cfgFile(p), `flags:\n  ${A}: true\n  ${B}: true\n`), 'both on');
      fetch(f);
      const a = () => adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
      a();
      const s2 = onMain(f, (p) => writeFileSync(cfgFile(p), readFileSync(cfgFile(p), 'utf8').replace(`${A}: true`, `${A}: false`)), 'a off');
      fetch(f);
      const lock = lockLog(f.log.path);
      try {
        assert.throws(a, /locked/);
      } finally {
        lock.release();
      }
      log = restart(log, f.log.path);
      const s3 = onMain(f, (p) => writeFileSync(cfgFile(p), readFileSync(cfgFile(p), 'utf8').replace(`${A}: false`, `${A}: true`).replace(`${B}: true`, `${B}: false`)), 'a on, b off');
      fetch(f);
      // The disk fills right after a's on is written, so b's off is held: the tick is not durable.
      const append = log.append.bind(log);
      (log as { append: unknown }).append = (type: string, p: { flag?: string; to?: boolean }, actor: string) => {
        const e = (append as (...x: unknown[]) => { id: number })(type, p, actor);
        if (p.flag === A && p.to) fillLog(log);
        return e;
      };
      a();
      assert.deepEqual(flips(f), [[A, false, true, s1], [B, false, true, s1], [A, true, false, s2], [A, false, true, s3]]);
      log = restart(log, f.log.path);
      a();
      assert.deepEqual(flips(f), [[A, false, true, s1], [B, false, true, s1], [A, true, false, s2], [A, false, true, s3], [B, true, false, s3]], "a's off and on once each");
    });
  } finally {
    clearFlags();
    log.close();
    f.log.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('R1173t D2: a save of flags-unrecorded.json that failed is tried again at the next tick, so the off survives a stop once the disk has room', async () => {
  const f = fixture();
  let log = new EventLog(f.log.path, { buffer: {} });
  try {
    await withKnownFlags([T], async () => {
      const s1 = onMain(f, (p) => appendFileSync(cfgFile(p), `flags:\n  ${T}: true\n`), 'on');
      fetch(f);
      const a = () => adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
      a();
      // The disk is full: the log, and the file (a folder at its name makes its rename fail, as ENOSPC would).
      fillLog(log);
      mkdirSync(offFilePath(f));
      const s2 = onMain(f, turnOff, 'off');
      fetch(f);
      a();
      assert.equal(flagOn(T), false);
      // Room again; one more tick (its record still held: nothing flushed it).
      rmSync(offFilePath(f), { recursive: true });
      roomLog(log);
      a();
      assert.ok(existsSync(offFilePath(f)), 'the file is written once there is room');
      // The process stops before the flush; then main turns the flag on again.
      log = restart(log, f.log.path);
      const s3 = onMain(f, turnOn, 'on again');
      fetch(f);
      a();
      assert.deepEqual(flips(f), [[T, false, true, s1], [T, true, false, s2], [T, false, true, s3]]);
    });
  } finally {
    clearFlags();
    log.close();
    f.log.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('R1173s 2a: a flag in flags-unrecorded.json whose off the log already holds is never written again, through held ticks', async () => {
  const f = fixture();
  let log = new EventLog(f.log.path, { buffer: {} });
  try {
    await withKnownFlags([T], async () => {
      const s1 = onMain(f, (p) => appendFileSync(cfgFile(p), `flags:\n  ${T}: true\n`), 'on');
      fetch(f);
      const a = () => adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
      a();
      const s2 = onMain(f, turnOff, 'off');
      fetch(f);
      const at = log.lastId();
      a();
      // A file left naming the flag (a stop between the off's row and the file's rewrite), then a restart.
      writeFileSync(offFilePath(f), JSON.stringify({ [T]: { sha: s2, after: at } }));
      log = restart(log, f.log.path);
      const s3 = onMain(f, turnOn, 'on again');
      fetch(f);
      fillLog(log);
      a();
      a();
      roomLog(log);
      log.flush();
      a();
      assert.equal(flagOn(T), true);
      assert.deepEqual(flips(f), [[T, false, true, s1], [T, true, false, s2], [T, false, true, s3]]);
    });
  } finally {
    clearFlags();
    log.close();
    f.log.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('R1173s 2b: flags-unrecorded.json stays while the off is only held, so a stop before the disk has room still records it', async () => {
  const f = fixture();
  let log = new EventLog(f.log.path, { buffer: {} });
  try {
    await withKnownFlags([T], async () => {
      const s1 = onMain(f, (p) => appendFileSync(cfgFile(p), `flags:\n  ${T}: true\n`), 'on');
      fetch(f);
      const a = () => adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
      a();
      fillLog(log);
      const s2 = onMain(f, turnOff, 'off');
      fetch(f);
      a();
      a();
      assert.ok(existsSync(offFilePath(f)), 'kept while the off is held');
      log = restart(log, f.log.path);
      const s3 = onMain(f, turnOn, 'on again');
      fetch(f);
      a();
      assert.deepEqual(flips(f), [[T, false, true, s1], [T, true, false, s2], [T, false, true, s3]]);
      assert.equal(existsSync(offFilePath(f)), false, 'removed once durable');
    });
  } finally {
    clearFlags();
    log.close();
    f.log.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

/** main's flags set to exactly `flags` (the `flags:` block these tests append last, replaced). */
const setFlags = (f: Fixture, flags: Record<string, boolean>, msg: string) =>
  onMain(f, (p) => writeFileSync(cfgFile(p), `${readFileSync(cfgFile(p), 'utf8').replace(/\nflags:\n[\s\S]*$/, '\n')}flags:\n${Object.entries(flags).map(([k, v]) => `  ${k}: ${v}\n`).join('')}`), msg);
/** A graceful stop (the service's last flush, then close), then a fresh process. */
const gracefulStop = (log: EventLog, path: string) => {
  assert.equal(log.flush().error, null, 'the last flush writes the held rows');
  return restart(log, path);
};

test('R1173v V1: a full disk that empties and fills again leaves a stored off in flags-unrecorded.json; a restart never writes its pair again', async () => {
  const f = fixture();
  const A = 'a_flag';
  const B = 'b_flag';
  let log = new EventLog(f.log.path, { buffer: {} });
  try {
    await withKnownFlags([A, B], async () => {
      const s1 = setFlags(f, { [B]: true }, 'b on');
      fetch(f);
      const a = () => adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
      a();
      const s2 = setFlags(f, { [B]: false }, 'b off');
      fetch(f);
      fillLog(log);
      a(); // b's off held, the file names b
      roomLog(log);
      assert.equal(log.flush().written, 1, "b's off is a stored row");
      const s3 = setFlags(f, { [A]: true, [B]: true }, 'a on, b on again');
      fetch(f);
      fillLog(log);
      a(); // a's and b's ons held
      roomLog(log);
      assert.equal(log.flush().written, 2);
      log = restart(log, f.log.path);
      a();
      a();
      assert.ok(flagOn(A) && flagOn(B));
      assert.deepEqual(flips(f), [[B, false, true, s1], [B, true, false, s2], [A, false, true, s3], [B, false, true, s3]]);
    });
  } finally {
    clearFlags();
    log.close();
    f.log.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("R1173v V2: a rewrite of flags-unrecorded.json that fails after the off's row is stored never gives a second pair after a restart", { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const f = fixture();
  const A = 'a_flag';
  const dir = f.base;
  let log = new EventLog(f.log.path, { buffer: {} });
  try {
    await withKnownFlags([A], async () => {
      const s1 = setFlags(f, { [A]: true }, 'a on');
      fetch(f);
      const a = () => adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
      a();
      const s2 = setFlags(f, { [A]: false }, 'a off');
      fetch(f);
      // Right after a's off row is stored, the folder takes no new entry: the file's rewrite fails.
      const off = log.subscribe((e) => {
        const p = e.payload as EventPayload<'flag.flipped'>;
        if (e.type === 'flag.flipped' && p.flag === A && !p.to) chmodSync(dir, 0o500);
      });
      a();
      off();
      assert.ok(existsSync(offFilePath(f)), 'the rewrite failed: the file still names a');
      chmodSync(dir, 0o700);
      const s3 = setFlags(f, { [A]: true }, 'a on again');
      fetch(f);
      chmodSync(dir, 0o500);
      a();
      assert.ok(flagOn(A));
      chmodSync(dir, 0o700);
      log = restart(log, f.log.path);
      a();
      assert.deepEqual(flips(f), [[A, false, true, s1], [A, true, false, s2], [A, false, true, s3]]);
    });
  } finally {
    chmodSync(dir, 0o700);
    clearFlags();
    log.close();
    f.log.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('R1173u D1: the off and the on held on a full disk, then a graceful stop flushes both (no tick after): the restart writes neither again', async () => {
  for (const blocked of [false, true]) {
    const f = fixture();
    let log = new EventLog(f.log.path, { buffer: {} });
    try {
      await withKnownFlags([T], async () => {
        const s1 = onMain(f, (p) => appendFileSync(cfgFile(p), `flags:\n  ${T}: true\n`), 'on');
        fetch(f);
        const a = () => adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
        a();
        fillLog(log);
        if (blocked) mkdirSync(offFilePath(f)); // the file's first save fails too, as on ENOSPC
        const s2 = onMain(f, turnOff, 'off');
        fetch(f);
        a();
        if (blocked) rmSync(offFilePath(f), { recursive: true });
        const s3 = onMain(f, turnOn, 'on again');
        fetch(f);
        if (blocked) roomLog(log);
        a(); // the on held behind the off
        if (!blocked) roomLog(log);
        log = gracefulStop(log, f.log.path);
        assert.deepEqual(flips(f), [[T, false, true, s1], [T, true, false, s2], [T, false, true, s3]], `blocked=${blocked}: every row stored before the restart`);
        a();
        assert.deepEqual(flips(f), [[T, false, true, s1], [T, true, false, s2], [T, false, true, s3]], `blocked=${blocked}: the off and the on once each`);
        assert.equal(existsSync(offFilePath(f)), false, `blocked=${blocked}: the file is gone`);
      });
    } finally {
      clearFlags();
      log.close();
      f.log.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  }
});

test("R1173v V3: a stop between an off's stored row and the file's rewrite, then main on: the restart writes no pair again", async () => {
  const f = fixture();
  const A = 'a_flag';
  let log = new EventLog(f.log.path, { buffer: {} });
  try {
    await withKnownFlags([A], async () => {
      const s1 = setFlags(f, { [A]: true }, 'a on');
      fetch(f);
      const a = () => adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
      a();
      const s2 = setFlags(f, { [A]: false }, 'a off');
      fetch(f);
      // The process dies right after a's off row is stored: a listener that throws stands in for the kill.
      const off = log.subscribe((e) => {
        const p = e.payload as EventPayload<'flag.flipped'>;
        if (e.type === 'flag.flipped' && p.flag === A && !p.to) throw new Error('killed');
      });
      assert.throws(a, /killed/);
      off();
      assert.ok(existsSync(offFilePath(f)), 'the file still names a');
      log = restart(log, f.log.path);
      const s3 = setFlags(f, { [A]: true }, 'a on again');
      fetch(f);
      a();
      assert.ok(flagOn(A));
      assert.deepEqual(flips(f), [[A, false, true, s1], [A, true, false, s2], [A, false, true, s3]]);
    });
  } finally {
    clearFlags();
    log.close();
    f.log.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('flags-unrecorded.json: an entry counts only an off stored after it went off; an older off of the same flag never stands for it, and the file is gone once its off is stored', async () => {
  const f = fixture();
  let log = new EventLog(f.log.path, { buffer: {} });
  try {
    await withKnownFlags([T], async () => {
      const s1 = onMain(f, (p) => appendFileSync(cfgFile(p), `flags:\n  ${T}: true\n`), 'on');
      fetch(f);
      const a = () => adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
      a();
      const s2 = onMain(f, turnOff, 'off');
      fetch(f);
      a();
      const s3 = onMain(f, turnOn, 'on');
      fetch(f);
      a();
      // Off again, its record refused (a lock past the busy timeout); the process ends.
      const s4 = onMain(f, turnOff, 'off again');
      fetch(f);
      const lock = lockLog(f.log.path);
      try {
        assert.throws(a, /locked/);
      } finally {
        lock.release();
      }
      log = restart(log, f.log.path);
      const s5 = onMain(f, turnOn, 'on again');
      fetch(f);
      a();
      assert.deepEqual(flips(f), [[T, false, true, s1], [T, true, false, s2], [T, false, true, s3], [T, true, false, s4], [T, false, true, s5]], 'the lost off at s4 recorded, s2 never standing for it');
      assert.equal(existsSync(offFilePath(f)), false, 'its off stored: the file is gone, in the same process');
    });
  } finally {
    clearFlags();
    log.close();
    f.log.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

// --- R1173w, R1173x: an entry is judged against the log it is in (restored, replaced, imported, or a bad `after`) ---
/** The flag.flipped rows on disk, by a fresh connection. */
const rowsAt = (path: string) => {
  const db = new DatabaseSync(path);
  try {
    return (db.prepare("SELECT payload FROM events WHERE type = 'flag.flipped' ORDER BY id").all() as { payload: string }[]).map((r) => JSON.parse(r.payload) as EventPayload<'flag.flipped'>).map((p) => [p.flag, p.from, p.to, p.sha]);
  } finally {
    db.close();
  }
};
/** One coordinator process on the log at `path`: fresh module state, fresh buffered connection. */
const proc = (path: string) => {
  clearFlags();
  return new EventLog(path, { buffer: {} });
};
const ticksOf = (n: number, log: EventLog) => {
  for (let i = 0; i < n; i++) log.append('coordinator.tick', { instance: 'i', dispatched: 0, reconciled: 0 } as never, 'i');
};
const sideOf = (path: string) => join(dirname(path), 'flags-unrecorded.json');
const dropLog = (path: string) => {
  for (const s of ['', '-wal', '-shm']) rmSync(`${path}${s}`, { force: true });
};

test('R1173x X1, R1173w (a canary rollback restores the migration backup): the lost off is written once, then the entry is gone, through restarts', async () => {
  const f = fixture();
  f.log.close();
  const A = 'a_flag';
  const path = f.log.path;
  try {
    await withKnownFlags([A], async () => {
      let log = proc(path);
      const a = () => adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
      const s1 = setFlags(f, { [A]: true }, 'a on');
      fetch(f);
      a();
      const bak = join(f.base, 'backup.db');
      log.db.exec(`VACUUM INTO '${bak}'`); // the migration backup, as src/migrations.ts takes it
      ticksOf(200, log);
      const s2 = setFlags(f, { [A]: false }, 'a off');
      fetch(f);
      fillLog(log);
      a(); // a's off held; the file names a
      log.close(); // the held off is lost
      dropLog(path);
      copyFileSync(bak, path); // restoreBackups: the backup over the log, -wal and -shm removed
      log = proc(path);
      a(); // the off, once, from the file
      const s3 = setFlags(f, { [A]: true }, 'a on again');
      fetch(f);
      a();
      assert.ok(flagOn(A));
      log.close();
      for (let i = 0; i < 3; i++) {
        log = proc(path);
        a();
        a();
        log.close();
      }
      assert.deepEqual(rowsAt(path), [[A, false, true, s1], [A, true, false, s2], [A, false, true, s3]]);
      assert.equal(existsSync(sideOf(path)), false);
    });
  } finally {
    clearFlags();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('R1173w W-1 fresh: the log replaced by a new one, where the flag was never on: the entry is dropped, no off written', async () => {
  const f = fixture();
  f.log.close();
  const A = 'a_flag';
  const path = f.log.path;
  try {
    await withKnownFlags([A], async () => {
      let log = proc(path);
      const a = () => adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
      setFlags(f, { [A]: true }, 'a on');
      fetch(f);
      a();
      ticksOf(50, log);
      setFlags(f, { [A]: false }, 'a off');
      fetch(f);
      fillLog(log);
      a();
      log.close();
      dropLog(path); // a new log
      const s3 = setFlags(f, { [A]: true }, 'a on again');
      fetch(f);
      for (let i = 0; i < 3; i++) {
        log = proc(path);
        a();
        log.close();
      }
      assert.deepEqual(rowsAt(path), [[A, false, true, s3]]);
      assert.equal(existsSync(sideOf(path)), false);
    });
  } finally {
    clearFlags();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("R1173x X2: import --force removes the target's flags-unrecorded.json: an imported log never gets offs it never had", async () => {
  const f = fixture();
  f.log.close();
  const A = 'a_flag';
  const src = join(f.base, 'src-state');
  const dst = join(f.base, 'dst-state');
  mkdirSync(src);
  mkdirSync(dst);
  const srcLog = join(src, 'events.db');
  const dstLog = join(dst, 'events.db');
  try {
    await withKnownFlags([A], async () => {
      setFlags(f, { [A]: true }, 'a on');
      fetch(f);
      let log = proc(dstLog);
      adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
      ticksOf(200, log);
      setFlags(f, { [A]: false }, 'a off');
      fetch(f);
      fillLog(log);
      adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
      log.close();
      assert.ok(existsSync(sideOf(dstLog)), "the target's lost off is in its file");
      const s3 = setFlags(f, { [A]: true }, 'a on again');
      fetch(f);
      log = proc(srcLog);
      adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
      log.close();
      const out = join(f.base, 'bundle.wlb');
      exportBundle({ stateDir: src, root: null, repo: null, host: 'laptop', out });
      importBundle({ file: out, stateDir: dst, root: null, instance: true, force: true });
      assert.equal(existsSync(sideOf(dstLog)), false, 'removed with the log it belonged to');
      for (let i = 0; i < 3; i++) {
        log = proc(dstLog);
        adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
        assert.ok(flagOn(A));
        log.close();
      }
      assert.deepEqual(rowsAt(dstLog), [[A, false, true, s3]]);
    });
  } finally {
    clearFlags();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('R1173x X3: an entry whose `after` is past every id (corrupt or planted) writes at most one off, then is gone', async () => {
  const f = fixture();
  f.log.close();
  const A = 'a_flag';
  const path = f.log.path;
  try {
    await withKnownFlags([A], async () => {
      let log = proc(path);
      const s1 = setFlags(f, { [A]: true }, 'a on');
      fetch(f);
      adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
      log.close();
      writeFileSync(sideOf(path), JSON.stringify({ [A]: { sha: s1, after: Number.MAX_SAFE_INTEGER, at: '2026-01-01T00:00:00.000Z' } }));
      for (let i = 0; i < 3; i++) {
        log = proc(path);
        adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
        log.close();
      }
      assert.ok(rowsAt(path).filter((r) => r[2] === false).length <= 1, JSON.stringify(rowsAt(path)));
      assert.equal(existsSync(sideOf(path)), false);
    });
  } finally {
    clearFlags();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("R1173x X5: a read that fails while a process's first tick judges the file leaves the entries for the next tick, and their flags off until then", async () => {
  const f = fixture();
  f.log.close();
  const A = 'a_flag';
  const path = f.log.path;
  try {
    await withKnownFlags([A], async () => {
      let log = proc(path);
      const a = () => adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
      const s1 = setFlags(f, { [A]: true }, 'a on');
      fetch(f);
      a();
      const s2 = setFlags(f, { [A]: false }, 'a off');
      fetch(f);
      fillLog(log);
      a();
      log.close();
      const s3 = setFlags(f, { [A]: true }, 'a on again');
      fetch(f);
      log = proc(path);
      // The first read of the log's rows at this tick fails, once (SQLITE_BUSY, or any read error).
      const db = log.db as unknown as { prepare: (sql: string) => unknown };
      const real = db.prepare.bind(db);
      let fired = false;
      db.prepare = (sql: string) => {
        if (!fired && /FROM events/.test(sql)) {
          fired = true;
          throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
        }
        return real(sql);
      };
      try {
        a();
      } catch {
        // the tick may fail; the entries must not be lost
      }
      assert.equal(flagOn(A), false, 'not judged yet: off');
      a();
      a();
      assert.ok(flagOn(A));
      const s4 = setFlags(f, { [A]: false }, 'a off 2');
      fetch(f);
      a();
      log.close();
      log = proc(path);
      a();
      log.close();
      assert.deepEqual(rowsAt(path), [[A, false, true, s1], [A, true, false, s2], [A, false, true, s3], [A, true, false, s4]]);
    });
  } finally {
    clearFlags();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('R1173x X1b: the log restored, and main had turned the flag on again before the restart: the lost off is written, then the on', async () => {
  const f = fixture();
  f.log.close();
  const A = 'a_flag';
  const path = f.log.path;
  try {
    await withKnownFlags([A], async () => {
      let log = proc(path);
      const a = () => adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
      const s1 = setFlags(f, { [A]: true }, 'a on');
      fetch(f);
      a();
      const bak = join(f.base, 'backup.db');
      log.db.exec(`VACUUM INTO '${bak}'`);
      ticksOf(200, log);
      const s2 = setFlags(f, { [A]: false }, 'a off');
      fetch(f);
      fillLog(log);
      a();
      log.close();
      dropLog(path);
      copyFileSync(bak, path);
      const s3 = setFlags(f, { [A]: true }, 'a on again'); // before the restart
      fetch(f);
      log = proc(path);
      a();
      assert.ok(flagOn(A));
      log.close();
      log = proc(path);
      a();
      log.close();
      assert.deepEqual(rowsAt(path), [[A, false, true, s1], [A, true, false, s2], [A, false, true, s3]]);
    });
  } finally {
    clearFlags();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("R1173x X5b: the file can't be judged at two ticks running, and main turns another flag off meanwhile: that flag goes off anyway", async () => {
  const f = fixture();
  f.log.close();
  const A = 'a_flag';
  const B = 'b_flag';
  const path = f.log.path;
  try {
    await withKnownFlags([A, B], async () => {
      let log = proc(path);
      const a = () => adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
      setFlags(f, { [A]: true, [B]: true }, 'both on');
      fetch(f);
      a();
      setFlags(f, { [A]: true, [B]: false }, 'b off');
      fetch(f);
      fillLog(log);
      a(); // b's off held; the file names b
      log.close();
      log = proc(path);
      // Every read of a row by id fails for two ticks (the file can't be judged).
      const db = log.db as unknown as { prepare: (sql: string) => unknown };
      const real = db.prepare.bind(db);
      let left = 2;
      db.prepare = (sql: string) => {
        if (left > 0 && /WHERE id = \?/.test(sql)) throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
        return real(sql);
      };
      try {
        a();
      } catch {
        // a tick may fail
      }
      left -= 1;
      assert.ok(flagOn(A), 'a, not in the file, is on');
      setFlags(f, { [A]: false, [B]: false }, 'a off too');
      fetch(f);
      try {
        a();
      } catch {
        // a tick may fail; a's turn-off must stand
      }
      left = 0;
      assert.equal(flagOn(A), false, "a's turn-off is not stopped by the file");
    });
  } finally {
    clearFlags();
    rmSync(f.base, { recursive: true, force: true });
  }
});

// --- R1173y, R1173z (ported from attacks-1173y/attack-1173y.test.ts and attacks-1173z/z-tail.ts) ---

// ===================== R1173z attacks (appended to a copy of test/feature-flags.test.ts at e2e35ddc) =====================
const pendingAt = (path: string) => (existsSync(sideOf(path)) ? JSON.parse(readFileSync(sideOf(path), 'utf8')) : null);
/** One-shot fault on the next `prepare` whose SQL matches `re` (as the builder's X5/X5b inject it). */
function failOnce(log: EventLog, re: RegExp): () => boolean {
  const db = log.db as unknown as { prepare: (sql: string) => unknown };
  const real = db.prepare.bind(db);
  let armed = true;
  let fired = false;
  db.prepare = (sql: string) => {
    if (armed && re.test(sql)) {
      armed = false;
      fired = true;
      throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
    }
    return real(sql);
  };
  return () => fired;
}

// Z1: the anchor read fails at the turn-off (the fallback at src/flags.ts:286-290). The off itself is stored, main turns
// the flag on again (stored), and a restart judges the entry foreign; the log reads on, so it is re-anchored and the
// off and the on are written a second time.
for (const fault of [false, true]) {
  test(`Z1 ${fault ? 'attack' : 'control'}: anchor read ${fault ? 'fails once' : 'ok'} at the turn-off; off stored, main on again, restarts`, async () => {
    const f = fixture();
    f.log.close();
    const A = 'a_flag';
    const path = f.log.path;
    try {
      await withKnownFlags([A], async () => {
        let log = proc(path);
        const a = () => adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
        const s1 = setFlags(f, { [A]: true }, 'a on');
        fetch(f);
        a();
        ticksOf(20, log);
        const s2 = setFlags(f, { [A]: false }, 'a off');
        fetch(f);
        const fired = fault ? failOnce(log, /SELECT ts FROM events WHERE id = \?/) : () => false;
        a();
        assert.equal(fired(), fault);
        assert.equal(flagOn(A), false);
        assert.deepEqual(rowsAt(path).at(-1), [A, true, false, s2], 'the off is a stored row');
        console.log(`Z1 ${fault ? 'attack' : 'control'} file after the off:`, JSON.stringify(pendingAt(path)));
        const s3 = setFlags(f, { [A]: true }, 'a on again');
        fetch(f);
        a();
        assert.ok(flagOn(A));
        log.close();
        for (let i = 0; i < 3; i++) {
          log = proc(path);
          a();
          a();
          log.close();
        }
        console.log(`Z1 ${fault ? 'attack' : 'control'} rows:`, JSON.stringify(rowsAt(path).map((r) => [r[1], r[2], String(r[3]).slice(0, 7)])));
        assert.deepEqual(rowsAt(path), [[A, false, true, s1], [A, true, false, s2], [A, false, true, s3]]);
      });
    } finally {
      clearFlags();
      rmSync(f.base, { recursive: true, force: true });
    }
  });
}

// Z1b: the builder's own X5b fault (every by-id read fails for two ticks), continued: a's off is stored with the
// fallback anchor, main turns a on again, and the process restarts.
test('Z1b attack: X5b continued: a turned off during the failed judge, then on again, then a restart', async () => {
  const f = fixture();
  f.log.close();
  const A = 'a_flag';
  const B = 'b_flag';
  const path = f.log.path;
  try {
    await withKnownFlags([A, B], async () => {
      let log = proc(path);
      const a = () => adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
      const s1 = setFlags(f, { [A]: true, [B]: true }, 'both on');
      fetch(f);
      a();
      const s2 = setFlags(f, { [A]: true, [B]: false }, 'b off');
      fetch(f);
      fillLog(log);
      a();
      log.close();
      log = proc(path);
      const db = log.db as unknown as { prepare: (sql: string) => unknown };
      const real = db.prepare.bind(db);
      let left = 2;
      db.prepare = (sql: string) => {
        if (left > 0 && /WHERE id = \?/.test(sql)) throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
        return real(sql);
      };
      try { a(); } catch { /* */ }
      left -= 1;
      const s3 = setFlags(f, { [A]: false, [B]: false }, 'a off too');
      fetch(f);
      try { a(); } catch { /* */ }
      left = 0;
      a();
      a();
      const s4 = setFlags(f, { [A]: true, [B]: false }, 'a on again');
      fetch(f);
      a();
      assert.ok(flagOn(A));
      log.close();
      for (let i = 0; i < 2; i++) {
        log = proc(path);
        a();
        log.close();
      }
      const aRows = rowsAt(path).filter((r) => r[0] === A);
      console.log('Z1b a rows:', JSON.stringify(aRows.map((r) => [r[1], r[2], String(r[3]).slice(0, 7)])), 's1..s4', [s1, s2, s3, s4].map((s) => s.slice(0, 7)));
      assert.deepEqual(aRows, [[A, false, true, s1], [A, true, false, s3], [A, false, true, s4]]);
    });
  } finally {
    clearFlags();
    rmSync(f.base, { recursive: true, force: true });
  }
});

// Z2: a foreign entry (restored log) is re-anchored at the judge, but that re-anchor's save fails (the disk is full:
// the log holds the off and the on too). Room comes back and a graceful stop flushes both (R1173u D1's shape), with no
// tick after. The next process sees the old, foreign entry again: the log reads on, so it is re-anchored again and the
// off and the on are written twice.
for (const blocked of [false, true]) {
  test(`Z2 ${blocked ? 'attack' : 'control'}: restored log, re-anchor save ${blocked ? 'fails' : 'ok'}, off+on held, graceful stop`, { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
    const f = fixture();
    f.log.close();
    const A = 'a_flag';
    const path = f.log.path;
    const dir = dirname(path);
    try {
      await withKnownFlags([A], async () => {
        let log = proc(path);
        const a = () => adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
        const s1 = setFlags(f, { [A]: true }, 'a on');
        fetch(f);
        a();
        const bak = join(f.base, 'backup.db');
        log.db.exec(`VACUUM INTO '${bak}'`);
        ticksOf(200, log);
        const s2 = setFlags(f, { [A]: false }, 'a off');
        fetch(f);
        fillLog(log);
        a(); // a's off held; the file names a, anchored in this log
        log.close();
        dropLog(path);
        copyFileSync(bak, path); // the rollback restores the backup
        const s3 = setFlags(f, { [A]: true }, 'a on again'); // main on again before the restart (X1b's shape)
        fetch(f);
        log = proc(path);
        fillLog(log); // the disk is full again
        if (blocked) chmodSync(dir, 0o500); // ...for the file's save too (ENOSPC on the stage file)
        a(); // judge: foreign, log reads on -> re-anchored (save fails when blocked); the off and the on are held
        a();
        assert.equal(flagOn(A), false);
        roomLog(log); // room comes back
        assert.equal(log.flush().error, null); // the service's last flush: off and on stored, no tick after
        log.close();
        chmodSync(dir, 0o700);
        console.log(`Z2 ${blocked ? 'attack' : 'control'} file at stop:`, JSON.stringify(pendingAt(path)));
        for (let i = 0; i < 3; i++) {
          log = proc(path);
          a();
          a();
          log.close();
        }
        console.log(`Z2 ${blocked ? 'attack' : 'control'} rows:`, JSON.stringify(rowsAt(path).map((r) => [r[1], r[2], String(r[3]).slice(0, 7)])));
        assert.deepEqual(rowsAt(path), [[A, false, true, s1], [A, true, false, s2], [A, false, true, s3]]);
      });
    } finally {
      chmodSync(dir, 0o700);
      clearFlags();
      rmSync(f.base, { recursive: true, force: true });
    }
  });
}

// Z3: stamp collision. The backup predates the flag's on; the restored timeline writes row `after` again with the same

for (const stale of [true, false]) {
  test(`Y-2 ${stale ? 'attack' : 'control'}: import WITHOUT --force into a state folder whose events.db was moved aside but whose flags-unrecorded.json stayed (src/instance-move.ts:130)`, async () => {
    const f = fixture();
    f.log.close();
    const A = 'a_flag';
    const src = join(f.base, 'src-state');
    const dst = join(f.base, 'dst-state');
    mkdirSync(src);
    mkdirSync(dst);
    const srcLog = join(src, 'events.db');
    const dstLog = join(dst, 'events.db');
    try {
      await withKnownFlags([A], async () => {
        setFlags(f, { [A]: true }, 'a on');
        fetch(f);
        let log = proc(dstLog);
        adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
        ticksOf(200, log);
        setFlags(f, { [A]: false }, 'a off');
        fetch(f);
        if (stale) fillLog(log); // the target's off lost: its file names a
        adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
        log.close();
        assert.equal(existsSync(sideOf(dstLog)), stale);
        const s3 = setFlags(f, { [A]: true }, 'a on again');
        fetch(f);
        log = proc(srcLog);
        adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
        log.close();
        const out = join(f.base, 'bundle.wlb');
        exportBundle({ stateDir: src, root: null, repo: null, host: 'laptop', out });
        // The operator moves the old history aside (the refusal says "export it first if it matters"), then imports.
        for (const s of ['', '-wal', '-shm']) if (existsSync(`${dstLog}${s}`)) renameSync(`${dstLog}${s}`, join(f.base, `old-events.db${s}`));
        importBundle({ file: out, stateDir: dst, root: null, instance: true });
        for (let i = 0; i < 3; i++) {
          log = proc(dstLog);
          adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
          log.close();
        }
        assert.deepEqual(rowsAt(dstLog), [[A, false, true, s3]], 'the imported log gets no off it never had');
      });
    } finally {
      clearFlags();
      rmSync(f.base, { recursive: true, force: true });
    }
  });
}

test('Y-5: a restored backup that reads the flag off, grown past `after` by other writers before the first tick: the stamp tells it apart (no test pins the stamp)', async () => {
  const f = fixture();
  f.log.close();
  const A = 'a_flag';
  const path = f.log.path;
  try {
    await withKnownFlags([A], async () => {
      let log = proc(path);
      const a = () => adoptFlags({ log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
      ticksOf(3, log);
      const bak = join(f.base, 'backup.db');
      log.db.exec(`VACUUM INTO '${bak}'`); // the backup, before a was ever on
      setFlags(f, { [A]: true }, 'a on');
      fetch(f);
      a();
      ticksOf(20, log);
      setFlags(f, { [A]: false }, 'a off');
      fetch(f);
      fillLog(log);
      a(); // a's off held; the file names a
      log.close();
      dropLog(path);
      copyFileSync(bak, path);
      const other = new EventLog(path); // the dashboard, the CLI: rows before the coordinator's first tick
      ticksOf(2000, other);
      other.close();
      const s3 = setFlags(f, { [A]: true }, 'a on again');
      fetch(f);
      for (let i = 0; i < 3; i++) {
        log = proc(path);
        a();
        log.close();
      }
      assert.deepEqual(rowsAt(path), [[A, false, true, s3]]);
      assert.equal(existsSync(sideOf(path)), false);
    });
  } finally {
    clearFlags();
    rmSync(f.base, { recursive: true, force: true });
  }
});
