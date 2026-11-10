// R1173af: flag state per coordinator (AF1, AF1b) and an import that keeps the pending offs when its log write fails
// (AF2). Ported from the review's probes (attacks-1173af/af-attacks.test.ts); each attack has its control.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { gunzipSync, gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventPayload } from '../src/events/types.js';
import { EventLog } from '../src/events/log.js';
import { withKnownFlags } from '../src/config/schema.js';
import { FlagState, OFF_FILE, adoptFlags } from '../src/flags.js';
import { exportBundle, importBundle, type Bundle } from '../src/instance-move.js';
import { Coordinator } from '../src/coordinator.js';
import { FakeRunner } from '../src/runner.js';
import { runSuite } from '../src/harness-evals/replay.js';
import { HarnessTask, type LoadedTask } from '../src/harness-evals/tasks.js';
import { coordinator, fixture, git, skip, type Fixture } from './repro-state-graph/harness.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const T = 'test_flag';
const SHA = 'a'.repeat(40);
const ID = ['-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false'];
/** The instance's coordinator's flags (in the engine, its `coordinator.flags`); a new one is a fresh process. */
const adopt = (f: Fixture, flags: FlagState) => adoptFlags({ flags, log: f.log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
const flips = (f: Fixture) =>
  f.log.read(0, ['flag.flipped']).map((e) => {
    const p = e.payload as EventPayload<'flag.flipped'>;
    return [p.flag, p.from, p.to];
  });

/** Main's config turns T on, fetched into the instance's checkout. */
function mainTurnsOn(f: Fixture) {
  const person = join(f.base, 'person');
  git(f.base, 'clone', '-q', f.remote, person);
  appendFileSync(join(person, '.worklane', 'config.yaml'), `flags:\n  ${T}: true\n`);
  git(person, 'add', '-A');
  git(person, ...ID, 'commit', '-q', '-m', 'on');
  git(person, 'push', '-q', 'origin', 'main');
  git(f.repo, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
}

/** A harness-eval task repo (a public third-party repo in real use), its committed config naming `flags` or not. */
function taskSeed(flags: string | null) {
  const base = mkdtempSync(join(tmpdir(), 'af-task-'));
  const seed = join(base, 'seed');
  cpSync(join(repoRoot, 'examples', 'basic'), seed, { recursive: true });
  if (flags) appendFileSync(join(seed, '.worklane', 'config.yaml'), flags);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'add', '-A');
  git(seed, ...ID, 'commit', '-q', '-m', 'init');
  const task: LoadedTask = { ...HarnessTask.parse({ id: 'af-1', repo: 'example/shop', base: git(seed, 'rev-parse', 'HEAD').trim(), title: 't', body: 'b', done_when: [{ test: 'test/price.test.js' }], outcome: { pr: 1, merge: SHA } }), heldOut: false, file: 'x' };
  const work = join(base, 'work');
  mkdirSync(work);
  return { base, seed, task, work };
}

/** A harness eval in the instance's own process (src/coordinator/harness-evals.ts): the real runSuite, one tick. */
async function replay(s: ReturnType<typeof taskSeed>) {
  const runner = new FakeRunner(() => ({ structured: { summary: 'nothing' }, costUsd: 0 }));
  await runSuite({ tasks: [s.task], samples: 1, budgetUsd: 1, runner, trigger: 'manual', engine: SHA, pr: null, workDir: s.work, source: () => s.seed, emit: () => {}, maxTicks: 1 });
}

for (const attack of [false, true]) {
  test(`R1173af AF1 (${attack ? 'attack' : 'control'}): a harness-eval replay in the instance's process ${attack ? 'whose task repo turns a flag on' : 'whose task repo names no flag'}: the instance's flag stays as ITS main says`, { skip }, async () => {
    const f = fixture();
    const s = taskSeed(attack ? `flags:\n  ${T}: true\n` : null);
    try {
      await withKnownFlags([T], async () => {
        const flags = new FlagState();
        adopt(f, flags);
        assert.equal(flags.on(T), false, "the instance's main names no flag: off");
        await replay(s);
        assert.equal(flags.on(T), false, "another repo's config (a task repo) never turns the instance's flag on");
        adopt(f, flags);
        assert.deepEqual(flips(f), []);
      });
    } finally {
      f.log.close();
      rmSync(f.base, { recursive: true, force: true });
      rmSync(s.base, { recursive: true, force: true });
    }
  });
}

for (const attack of [false, true]) {
  test(`R1173af AF1b (${attack ? 'attack' : 'control'}): the instance's flag on (recorded); ${attack ? 'a replay with no flags' : 'no replay'}: it stays on, and no flip goes unrecorded`, { skip }, async () => {
    const f = fixture();
    const s = taskSeed(null);
    try {
      await withKnownFlags([T], async () => {
        mainTurnsOn(f);
        const flags = new FlagState();
        adopt(f, flags);
        assert.equal(flags.on(T), true);
        if (attack) await replay(s);
        assert.equal(flags.on(T), true, 'never turned off by another repo, unrecorded in the instance log');
        adopt(f, flags);
        assert.equal(flags.on(T), true);
        assert.deepEqual(flips(f), [[T, false, true]]);
      });
    } finally {
      f.log.close();
      rmSync(f.base, { recursive: true, force: true });
      rmSync(s.base, { recursive: true, force: true });
    }
  });
}

/** importBundle --force in a child whose writes past 256 KiB fail (EFBIG, SIGXFSZ ignored): a disk that fills during the import. */
function importOnFullDisk(bundle: string, stateDir: string) {
  const mod = join(repoRoot, 'dist', 'src', 'instance-move.js');
  const js = `import(${JSON.stringify(mod)}).then((m) => { try { m.importBundle({ file: ${JSON.stringify(bundle)}, stateDir: ${JSON.stringify(stateDir)}, root: null, instance: true, force: true }); console.log('IMPORTED'); } catch (e) { console.log('THREW ' + e.code + ' ' + e.message); } })`;
  return spawnSync('bash', ['-c', `trap '' XFSZ; ulimit -f 512; exec node -e '${js.replace(/'/g, "'\\''")}'`], { encoding: 'utf8' });
}

for (const attack of [false, true]) {
  test(`R1173af AF2 (${attack ? 'attack' : 'control'}): a pending off beside the target's log; ${attack ? 'an import --force whose log write fails (disk full)' : 'no import'}; main has the flag on: the off and the on are both recorded`, { skip: skip || process.platform === 'win32' }, async () => {
    const f = fixture();
    const s = mkdtempSync(join(tmpdir(), 'af2-src-'));
    try {
      await withKnownFlags([T], async () => {
        mainTurnsOn(f);
        adopt(f, new FlagState());
        assert.deepEqual(flips(f), [[T, false, true]]);
        // A process turned T off (main had it off for a while) and was killed after the off was saved in the file,
        // before its row: the file names T, anchored in this log; the log still reads on.
        const after = f.log.lastId();
        const at = (f.log.db.prepare('SELECT ts FROM events WHERE id = ?').get(after) as { ts: string }).ts;
        const side = join(f.base, 'flags-unrecorded.json');
        const pending = `${JSON.stringify({ [T]: { sha: null, after, at } })}\n`;
        writeFileSync(side, pending);
        if (attack) {
          // Another instance's bundle, its log about 2 MB.
          const big = new EventLog(join(s, 'events.db'));
          for (let i = 0; i < 4000; i++) big.append('coordinator.error', { instance: 'x', where: 'w', kind: 'k', message: 'm'.repeat(400) }, 'x');
          big.close();
          const out = join(s, 'bundle.wlb');
          exportBundle({ stateDir: s, root: null, repo: null, host: 'h', out });
          const r = importOnFullDisk(out, f.base);
          assert.match(r.stdout, /THREW/, `the import failed: ${r.stdout} ${r.stderr.slice(0, 300)}`);
          assert.equal(f.log.lastId(), after, "the target's log is still its own");
          assert.equal(existsSync(`${side}.import-old`), false, 'nothing left aside');
        }
        assert.equal(existsSync(side) ? readFileSync(side, 'utf8') : null, pending, 'the pending off is still beside the log');
        // A fresh process (the coordinator restarted); main has T on.
        adopt(f, new FlagState());
        assert.deepEqual(flips(f), [[T, false, true], [T, true, false], [T, false, true]], 'the off that ran, then the on: both audited');
      });
    } finally {
      f.log.close();
      rmSync(f.base, { recursive: true, force: true });
      rmSync(s, { recursive: true, force: true });
    }
  });
}

// --- R1173ag AG1 / R1173ah AH1, AH1b, AH2, AH2b (ported from attacks-1173ag/ag-tail.ts, attacks-1173ah/ah-attacks.test.ts) ---
const flipsOf = (log: EventLog) =>
  log.read(0, ['flag.flipped']).map((e) => {
    const p = e.payload as EventPayload<'flag.flipped'>;
    return [p.flag, p.from, p.to];
  });
/** A bundle of another instance whose log is about 2 MB: its import fails on a disk that fills past 256 KiB. */
function bigBundle(dir: string): string {
  mkdirSync(join(dir, 'state'));
  const b = new EventLog(join(dir, 'state', 'events.db'));
  for (let i = 0; i < 4000; i++) b.append('coordinator.error', { instance: 'x', where: 'w', kind: 'k', message: 'm'.repeat(400) }, 'x');
  b.close();
  return exportBundle({ stateDir: join(dir, 'state'), root: null, repo: null, host: 'h', out: join(dir, 'b.wlb') }).file;
}

for (const stale of [false, true]) {
  test(`R1173ag AG-2 (${stale ? 'attack' : 'control'}): no ${OFF_FILE}${stale ? ', a stale .import-old beside it' : ''}; an import --force that fails: the target's file state is unchanged`, { skip: skip || process.platform === 'win32' }, () => {
    const f = fixture();
    const s = mkdtempSync(join(tmpdir(), 'ag2-src-'));
    try {
      const side = join(f.base, OFF_FILE);
      // An entry from some other log (an anchor this log doesn't have).
      if (stale) writeFileSync(`${side}.import-old`, `${JSON.stringify({ [T]: { sha: null, after: 999999, at: '2020-01-01T00:00:00.000Z' } })}\n`);
      const r = importOnFullDisk(bigBundle(s), f.base);
      assert.match(r.stdout, /THREW/, r.stdout);
      assert.equal(existsSync(side), false, `a failed import created ${OFF_FILE} the target didn't have`);
    } finally {
      f.log.close();
      rmSync(f.base, { recursive: true, force: true });
      rmSync(s, { recursive: true, force: true });
    }
  });
}

/** importBundle --force in a child: `kill`, SIGKILL as it removes `<file>.import-old` (after its log write); `full`, a disk that fills. */
function importChild(bundle: string, stateDir: string, o: { kill?: boolean; full?: boolean }) {
  const mod = join(repoRoot, 'dist', 'src', 'instance-move.js');
  const js = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const rm = fs.rmSync;
    fs.rmSync = (p, ...a) => { if (${o.kill ? 'true' : 'false'} && String(p).endsWith('.import-old')) process.kill(process.pid, 'SIGKILL'); return rm(p, ...a); };
    syncBuiltinESMExports();
    const m = await import(${JSON.stringify(mod)});
    try { m.importBundle({ file: ${JSON.stringify(bundle)}, stateDir: ${JSON.stringify(stateDir)}, root: null, instance: true, force: true }); console.log('IMPORTED'); } catch (e) { console.log('THREW ' + e.code); }`;
  const cmd = `${o.full ? "trap '' XFSZ; ulimit -f 512; " : ''}exec node --input-type=module -e '${js.replace(/'/g, "'\\''")}'`;
  return spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
}

for (const attack of [false, true]) {
  test(`R1173ah AH1 (${attack ? 'attack' : 'control'}): import #1 ${attack ? 'killed between its log write and its removal of .import-old' : 'completes'}; import #2 fails (disk full): the next start writes no flip that never ran`, { skip: skip || process.platform === 'win32' }, async () => {
    const f = fixture();
    const sd = join(f.base, 'sd');
    const bk = mkdtempSync(join(tmpdir(), 'ah1-bk-'));
    const big = mkdtempSync(join(tmpdir(), 'ah1-big-'));
    mkdirSync(sd);
    try {
      await withKnownFlags([T], async () => {
        mainTurnsOn(f);
        let log = new EventLog(join(sd, 'events.db'));
        const adoptInto = (l: EventLog) => adoptFlags({ flags: new FlagState(), log: l, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
        adoptInto(log);
        assert.deepEqual(flipsOf(log), [[T, false, true]]);
        // A backup of this instance (its log reads T on), exported now.
        mkdirSync(join(bk, 'state'));
        log.db.exec(`VACUUM INTO '${join(bk, 'state', 'events.db')}'`);
        const backup = exportBundle({ stateDir: join(bk, 'state'), root: null, repo: null, host: 'h', out: join(bk, 'b.wlb') }).file;
        // Later: more rows, then a process turned T off and was killed after saving its pending off, before the row.
        for (let i = 0; i < 5; i++) log.append('coordinator.error', { instance: 'i', where: 'w', kind: 'k', message: 'm' }, 'i');
        const after = log.lastId();
        const at = (log.db.prepare('SELECT ts FROM events WHERE id = ?').get(after) as { ts: string }).ts;
        writeFileSync(join(sd, OFF_FILE), `${JSON.stringify({ [T]: { sha: null, after, at } })}\n`);
        log.close();
        // Import #1: the owner restores the backup.
        importChild(backup, sd, { kill: attack });
        // Import #2: another bundle on a disk that fills: it throws, the backup's log stays.
        assert.match(importChild(bigBundle(big), sd, { full: true }).stdout, /THREW/);
        // A fresh process on the backup's log; main still has T on, as it had throughout the backup's log.
        log = new EventLog(join(sd, 'events.db'));
        const before = flipsOf(log);
        adoptInto(log);
        assert.deepEqual(flipsOf(log), before, "no off/on pair the backup's log never had");
        log.close();
      });
    } finally {
      f.log.close();
      rmSync(f.base, { recursive: true, force: true });
      rmSync(bk, { recursive: true, force: true });
      rmSync(big, { recursive: true, force: true });
    }
  });
}

for (const attack of [false, true]) {
  test(`R1173ah AH1b (${attack ? 'attack' : 'control'}): an export of a state folder with ${attack ? `${OFF_FILE}.import-old` : 'events.db-wal'} beside the log leaves it out`, () => {
    const d = mkdtempSync(join(tmpdir(), 'ah1b-'));
    try {
      const log = new EventLog(join(d, 'events.db'));
      log.append('coordinator.error', { instance: 'i', where: 'w', kind: 'k', message: 'm' }, 'i');
      log.close();
      const name = attack ? `${OFF_FILE}.import-old` : 'events.db-wal';
      writeFileSync(join(d, name), attack ? '{"test_flag":{"sha":null,"after":1,"at":"x"}}\n' : 'x');
      const r = exportBundle({ stateDir: d, root: null, repo: null, host: 'h', out: join(d, '..', `${d.split('/').pop()}.wlb`) });
      rmSync(r.file, { force: true });
      assert.ok(!r.files.includes(`state/${name}`), `${name} is carried in the bundle`);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
}

for (const attack of [false, true]) {
  test(`R1173ah AH2 (${attack ? 'attack' : 'control'}): main names no flag; ${attack ? 'a method put on FlagState.prototype outside src/flags.ts' : 'nothing else'}: the coordinator's flag stays off`, { skip }, async () => {
    const f = fixture();
    const proto = FlagState.prototype as unknown as { on?: unknown };
    try {
      await withKnownFlags([T], async () => {
        const c = coordinator(f, new FakeRunner(() => ({ structured: { summary: 's' } })));
        await c.tick();
        assert.equal(c.flags.on(T), false);
        if (attack) {
          // A method put on the class's prototype: the instance's own reader shadows it.
          proto.on = () => true;
          // The instance's own reader can't be replaced either (it is frozen).
          assert.throws(() => {
            (c.flags as unknown as { on: unknown }).on = () => true;
          }, TypeError);
          assert.ok(Object.isFrozen(c.flags) && Object.isFrozen(FlagState) && Object.hasOwn(c.flags, 'on'));
        }
        await c.tick();
        assert.equal(c.flags.on(T), false, 'a flag reads on that no commit turned on and the log never recorded');
      });
    } finally {
      delete proto.on;
      f.log.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  });
}

for (const attack of [false, true]) {
  test(`R1173ah AH2b (${attack ? 'attack' : 'control'}): two Coordinators; ${attack ? "one's flags handle assigned to the other (readonly is compile-time)" : 'untouched'}: their states stay apart`, { skip }, async () => {
    const f = fixture();
    const g = fixture();
    try {
      await withKnownFlags([T], async () => {
        mainTurnsOn(f);
        const a = coordinator(f, new FakeRunner(() => ({ structured: { summary: 's' } })));
        const b = coordinator(g, new FakeRunner(() => ({ structured: { summary: 's' } })));
        if (attack) {
          const d = Object.getOwnPropertyDescriptor(b, 'flags')!;
          assert.equal(d.writable || d.configurable, false, 'not writable, not configurable');
          assert.throws(() => Object.assign(b, { flags: a.flags }), TypeError);
        }
        await a.tick();
        assert.equal(b.flags.on(T), false, "b's flag reads on from a's repo, unrecorded in b's log");
      });
    } finally {
      f.log.close();
      g.log.close();
      rmSync(f.base, { recursive: true, force: true });
      rmSync(g.base, { recursive: true, force: true });
    }
  });
}

// --- R1173aj AJ1-AJ4 (ported from attacks-1173aj/aj-attacks.test.ts; each attack with its control) ---
const aRunner = () => new FakeRunner(() => ({ structured: { summary: 's' } }));

for (const attack of [false, true]) {
  test(`R1173aj AJ1 (${attack ? 'attack' : 'control'}): two Coordinators; ${attack ? "Coordinator's parent swapped at run time for one returning a Proxy" : 'untouched'}: b never holds a's FlagState`, { skip }, async () => {
    const f = fixture();
    const g = fixture();
    const Base = Object.getPrototypeOf(Coordinator) as new (...a: unknown[]) => object;
    try {
      await withKnownFlags([T], async () => {
        mainTurnsOn(f);
        const a = coordinator(f, aRunner());
        if (attack) {
          const Evil = function (this: unknown, ...args: unknown[]) {
            const o = Reflect.construct(Base, args, new.target);
            return new Proxy(o, {
              defineProperty(t, k, d) {
                if (k === 'flags' && d.configurable === false) return Reflect.defineProperty(t, 'flags', { value: a.flags, writable: false, configurable: false, enumerable: true });
                return Reflect.defineProperty(t, k, d);
              },
            });
          };
          Object.setPrototypeOf(Evil, Base);
          Object.setPrototypeOf(Coordinator, Evil);
        }
        let b: Coordinator;
        try {
          b = coordinator(g, aRunner());
        } catch (e) {
          assert.ok(attack, `the control is refused: ${(e as Error).message}`);
          assert.match((e as Error).message, /never a Proxy/);
          return;
        } finally {
          Object.setPrototypeOf(Coordinator, Base);
        }
        assert.ok(!attack, 'the Proxy Coordinator was made');
        await a.tick();
        assert.notEqual(b.flags, a.flags);
        assert.equal(b.flags.on(T), false);
      });
    } finally {
      Object.setPrototypeOf(Coordinator, Base);
      f.log.close();
      g.log.close();
      rmSync(f.base, { recursive: true, force: true });
      rmSync(g.base, { recursive: true, force: true });
    }
  });
}

for (const attack of [false, true]) {
  test(`R1173aj AJ2 (${attack ? 'attack' : 'control'}): adoptFlags called from outside the Coordinator with ${attack ? 'c.flags' : 'a fresh FlagState'}, another repo (main on) and a scratch log: c's flag stays off`, { skip }, async () => {
    const f = fixture();
    const g = fixture();
    const scratch = new EventLog(':memory:');
    try {
      await withKnownFlags([T], async () => {
        mainTurnsOn(g);
        const c = coordinator(f, aRunner());
        await c.tick();
        const target = attack ? c.flags : new FlagState();
        const adopt = () => adoptFlags({ flags: target, log: scratch, repo: g.repo, actor: 'x', branch: 'main', check: () => [] });
        if (attack) assert.throws(adopt, /adopts only for its own log and repo/);
        else assert.deepEqual(adopt().map((p) => [p.flag, p.from, p.to]), [[T, false, true]], 'control: a state of its own adopts from anywhere');
        assert.equal(c.flags.on(T), false, "c's flag read on from another repo, recorded only in a scratch log");
      });
    } finally {
      scratch.close();
      f.log.close();
      g.log.close();
      rmSync(f.base, { recursive: true, force: true });
      rmSync(g.base, { recursive: true, force: true });
    }
  });
}

for (const attack of [false, true]) {
  test(`R1173aj AJ3 (${attack ? 'attack' : 'control'}): main's valid config turns nothing on; ${attack ? 'Array.prototype.includes replaced' : 'built-ins untouched'}: the flag stays off`, { skip }, async () => {
    const f = fixture();
    const realIncludes = Array.prototype.includes;
    try {
      await withKnownFlags([T], async () => {
        const c = coordinator(f, aRunner());
        await c.tick();
        let on: boolean;
        try {
          if (attack) Array.prototype.includes = () => true;
          on = c.flags.on(T);
        } finally {
          Array.prototype.includes = realIncludes;
        }
        assert.equal(on, false, 'a flag reads on that no commit turned on and the log never recorded');
      });
    } finally {
      Array.prototype.includes = realIncludes;
      f.log.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  });
}

/** A source instance whose log reads T on, with T's off pending (saved in its file, not yet a row); its bundle. */
function sourceBundle(f: Fixture, dir: string, big = false): string {
  const sd = join(dir, 'state');
  mkdirSync(sd, { recursive: true });
  const log = new EventLog(join(sd, 'events.db'));
  adoptFlags({ flags: new FlagState(), log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
  assert.deepEqual(flipsOf(log), [[T, false, true]]);
  for (let i = 0; i < (big ? 4000 : 5); i++) log.append('coordinator.error', { instance: 'i', where: 'w', kind: 'k', message: big ? 'm'.repeat(400) : 'm' }, 'i');
  const after = log.lastId();
  const at = (log.db.prepare('SELECT ts FROM events WHERE id = ?').get(after) as { ts: string }).ts;
  writeFileSync(join(sd, OFF_FILE), `${JSON.stringify({ [T]: { sha: null, after, at } })}\n`);
  log.close();
  return exportBundle({ stateDir: sd, root: null, repo: null, host: 'h', out: join(dir, 'b.wlb') }).file;
}
/** The same bundle with `first` listed first (a bundle is JSON, carried however you like; nothing checks its order). */
function reorder(file: string, out: string, first: string): string {
  const b = JSON.parse(gunzipSync(Buffer.from(readFileSync(file, 'utf8'), 'base64')).toString('utf8')) as Bundle;
  b.files.sort((x, y) => (x.path === first ? -1 : y.path === first ? 1 : 0));
  writeFileSync(out, gzipSync(JSON.stringify(b)).toString('base64'));
  return out;
}
/** A fresh process on `sd`'s log with main still turning T on: the flips before and after its first adopt. */
function restartOn(f: Fixture, sd: string) {
  const log = new EventLog(join(sd, 'events.db'));
  try {
    const before = flipsOf(log);
    adoptFlags({ flags: new FlagState(), log, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
    return { before, after: flipsOf(log) };
  } finally {
    log.close();
  }
}

for (const order of ['export', 'off file first', 'log first'] as const) {
  test(`R1173aj AJ4a (${order}): a bundle with a pending off, imported into a fresh folder: the off is recorded at the next start`, { skip }, async () => {
    const f = fixture();
    const src = mkdtempSync(join(tmpdir(), 'aj4-src-'));
    const sd = mkdtempSync(join(tmpdir(), 'aj4-sd-'));
    try {
      await withKnownFlags([T], async () => {
        mainTurnsOn(f);
        let b = sourceBundle(f, src);
        if (order !== 'export') b = reorder(b, join(src, 'r.wlb'), order === 'off file first' ? `state/${OFF_FILE}` : 'state/events.db');
        importBundle({ file: b, stateDir: sd, root: null, instance: true });
        assert.ok(existsSync(join(sd, OFF_FILE)), "the bundle's pending offs were dropped by the import that carried them");
        assert.deepEqual(restartOn(f, sd).after, [[T, false, true], [T, true, false], [T, false, true]], 'the pending off is recorded');
      });
    } finally {
      f.log.close();
      for (const d of [f.base, src, sd]) rmSync(d, { recursive: true, force: true });
    }
  });
}

for (const order of ['export', 'off file first', 'log first'] as const) {
  test(`R1173aj AJ4b (${order}): an import --force onto a log of its own that fails (disk full): the target's log gets no flip that never ran`, { skip: skip || process.platform === 'win32' }, async () => {
    const f = fixture();
    const src = mkdtempSync(join(tmpdir(), 'aj4b-src-'));
    const sd = mkdtempSync(join(tmpdir(), 'aj4b-sd-'));
    try {
      await withKnownFlags([T], async () => {
        mainTurnsOn(f);
        const own = new EventLog(join(sd, 'events.db'));
        adoptFlags({ flags: new FlagState(), log: own, repo: f.repo, actor: 'i', branch: 'main', check: () => [] });
        own.close();
        let b = sourceBundle(f, src, true);
        if (order !== 'export') b = reorder(b, join(src, 'r.wlb'), order === 'off file first' ? `state/${OFF_FILE}` : 'state/events.db');
        assert.match(importChild(b, sd, { full: true }).stdout, /THREW/);
        const fl = restartOn(f, sd);
        assert.deepEqual(fl.after, fl.before, "no off/on pair the target's log never had");
      });
    } finally {
      f.log.close();
      for (const d of [f.base, src, sd]) rmSync(d, { recursive: true, force: true });
    }
  });
}
