// R1173af: flag state per coordinator (AF1, AF1b) and an import that keeps the pending offs when its log write fails
// (AF2). Ported from the review's probes (attacks-1173af/af-attacks.test.ts); each attack has its control.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventPayload } from '../src/events/types.js';
import { EventLog } from '../src/events/log.js';
import { withKnownFlags } from '../src/config/schema.js';
import { FlagState, adoptFlags } from '../src/flags.js';
import { exportBundle } from '../src/instance-move.js';
import { FakeRunner } from '../src/runner.js';
import { runSuite } from '../src/harness-evals/replay.js';
import { HarnessTask, type LoadedTask } from '../src/harness-evals/tasks.js';
import { fixture, git, skip, type Fixture } from './repro-state-graph/harness.js';

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
