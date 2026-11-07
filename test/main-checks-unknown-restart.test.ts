// #731 round 2: an auto-merge whose required checks never reported is marked judged (merge.main_result timed_out) only
// once its stop is durable. A pass cut off right after that result (the process restarted, or a later read threw) still
// leaves auto-merge stopped, so after a restart the next ready PR does not merge onto a main nobody judged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator } from '../src/coordinator.js';
import { MAIN_CHECKS_MIN_POLLS } from '../src/coordinator/wait-caps.js';
import type { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { agents, approve, commitAll, fixture, git, passing, skip, type Fixture } from './repro-state-graph/harness.js';

const body = (what: string) => `${what}.\n\n\`\`\`done_when\n- test: test/price.test.js\n\`\`\`\n`;

/** PR mode, auto-merge on, `ci` required: two ready tasks, each a PR changing its own file. Then A merges for real. */
async function world() {
  const f = fixture();
  f.cfg.project.land_mode = 'pr';
  f.cfg.project.required_checks = ['ci'];
  // Its PRs each add a module with no test, and these cases are about main's checks after a merge, not the vacuity
  // gate (#784, test/merge-vacuity-*.test.ts cover it): its app code is somewhere these PRs never touch.
  f.cfg.tests.vacuity = { ...f.cfg.tests.vacuity!, app_paths: ['app/**'] };
  mkdirSync(f.stateDir, { recursive: true });
  const a = f.backlog.open({ title: 'Add the order notes', body: body('Add src/notes-a.js'), author: 'example-owner', labels: ['ready'] });
  const b = f.backlog.open({ title: 'Add the refund notes', body: body('Add src/notes-b.js'), author: 'example-owner', labels: ['ready'] });
  const runner = agents({
    worker: (req) => {
      const file = /notes-a/.test(req.prompt) ? 'notes-a.js' : 'notes-b.js';
      writeFileSync(join(req.cwd, 'src', file), `export const notes = '${file}';\n`);
      commitAll(req.cwd, `Add src/${file}`);
      return { summary: 'done' };
    },
    'evaluator-verdict': approve(),
  });
  const make = () => new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine, prPollMs: 0, autoMerge: () => true });
  let c = make();
  for (let i = 0; i < 12 && f.log.read(0, ['pr.opened']).length < 2; i++) {
    await c.tick();
    await c.idle();
  }
  const opened = f.log.read(0, ['pr.opened']).map((e) => e.payload as EventPayload<'pr.opened'>);
  assert.equal(opened.length, 2, 'both PRs open');
  const prA = opened.find((o) => o.issue === a)!;
  const prB = opened.find((o) => o.issue === b)!;
  f.backlog.mergeWith = (pr) => {
    const dir = join(mkdtempSync(join(tmpdir(), 'gh-merge-')), 'c');
    git(f.base, 'clone', '-q', f.remote, dir);
    git(dir, 'fetch', '-q', 'origin', pr.head);
    git(dir, '-c', 'user.email=gh@example.com', '-c', 'user.name=GitHub', '-c', 'commit.gpgsign=false', 'merge', '-q', '--no-ff', '-m', `Merge pull request #${pr.number}`, pr.headSha);
    git(dir, 'push', '-q', 'origin', 'main');
    return git(dir, 'rev-parse', 'HEAD');
  };
  const headOf = (n: number) => f.backlog.prs().find((p) => p.number === n)!.headSha;
  // A's required check green on its head: it auto-merges. B's has not reported yet, so B waits.
  f.backlog.setChecks(headOf(prA.number), passing);
  await c.tick();
  await c.idle();
  const merged = f.log.read(0, ['merge.done']).map((e) => e.payload as EventPayload<'merge.done'>);
  assert.equal(merged.length, 1, `A auto-merged (${JSON.stringify(f.log.read(0, ['merge.decided', 'merge.failed', 'merge.deferred']).map((e) => e.payload))})`);
  assert.equal(merged[0]!.number, prA.number);
  return {
    f,
    prA,
    prB,
    sha: merged[0]!.sha,
    headOf,
    get c() {
      return c;
    },
    watchMerges: () => (c as unknown as { watchMerges(): Promise<void> }).watchMerges(),
    /** A restart: a new coordinator over the same state directory and event log. */
    restart: () => {
      c = make();
      return c;
    },
  };
}

const stopFile = (f: Fixture) => join(f.stateDir, 'auto-merge-stopped.json');
const of = <T>(f: Fixture, type: Parameters<Fixture['log']['read']>[1] extends (infer U)[] | undefined ? U : never) => f.log.read(0, [type]).map((e) => e.payload as T);

test("#731: a pass cut off right after an auto-merge's checks are judged timed out still leaves auto-merge stopped: after a restart the next ready PR does not merge", { skip }, async () => {
  const w = await world();
  // The process dies right after merge.main_result is written for A's merge (a restart, or a later read that throws):
  // nothing after that write in the pass runs.
  const append = w.f.log.append.bind(w.f.log);
  let armed = true;
  w.f.log.append = ((...a: Parameters<EventLog['append']>) => {
    const e = append(...a);
    if (armed && a[0] === 'merge.main_result') {
      armed = false;
      throw new Error('the process died here');
    }
    return e;
  }) as EventLog['append'];
  let died = false;
  for (let i = 0; i < MAIN_CHECKS_MIN_POLLS + 2 && !died; i++) {
    try {
      await w.watchMerges();
    } catch (e) {
      assert.match(String(e), /the process died here/);
      died = true;
    }
  }
  assert.ok(died, "the pass was cut off right after A's result");
  assert.deepEqual(of<EventPayload<'merge.main_result'>>(w.f, 'merge.main_result').map((r) => [r.sha, r.outcome]), [[w.sha, 'timed_out']], 'A counts as judged');
  // A restart: a new process, the same state directory and event log.
  w.f.log.append = append;
  w.restart();
  for (let i = 0; i < MAIN_CHECKS_MIN_POLLS + 2; i++) await w.watchMerges();
  assert.ok(existsSync(stopFile(w.f)), 'auto-merge is stopped');
  assert.match(w.c.autoMergeStopped() ?? '', new RegExp(`ci never reported on .*${w.sha.slice(0, 8)}`));
  // The next ready PR, with a perfect verdict, does not merge onto a main nobody judged.
  w.f.backlog.setChecks(w.headOf(w.prB.number), passing);
  await w.c.tick();
  await w.c.idle();
  assert.ok(!of<EventPayload<'merge.done'>>(w.f, 'merge.done').some((m) => m.number === w.prB.number), 'B is not auto-merged');
  const decided = of<EventPayload<'merge.decided'>>(w.f, 'merge.decided').filter((d) => d.number === w.prB.number).at(-1)!;
  assert.equal(decided.auto, false);
});
