// The engine updater on the main channel: one red tip doesn't block updates. It installs the newest commit on main's
// first-parent line, newer than the installed one and within max_lookback, whose checks are all green and that isn't
// held; a pending one is waited for until pending_wait_minutes after it landed (scripts/machine/worklane-update.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

type Cand = { sha: string; date: string | null };
const u = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', 'worklane-update.cjs')) as {
  run(deps: object): Promise<string>;
  firstParentLine(cmp: unknown, current: string | null, head: string, max: number): Cand[];
  lookbackOf(cfg: unknown): number;
  pendingWaitMs(cfg: unknown): number;
  CHECKS_SPACING_MS: number;
  VERDICT_TTL_MS: number;
  IDLE_AFTER_MS: number;
};

const sha = (c: string) => c.repeat(40);
const OLD = sha('0');
const NOW = Date.parse('2026-10-13T20:00:00Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

type Verdict = 'green' | 'red' | 'pending' | 'none' | 'unbatched' | 'batching';
type Commit = { sha: string; parents: string[]; checks: Verdict; landed?: number | undefined };

const fast = { name: 'test', status: 'completed', conclusion: 'success', started_at: '1', id: 1 };
// unbatched: the fast check green, the required push-gate never run, nothing else on the commit (a main commit the
// slow-checks batch hasn't reached, or skipped). batching: the same with another check of the batch still running.
const runs = (v: Verdict) =>
  v === 'none'
    ? []
    : v === 'unbatched'
      ? [fast]
      : v === 'batching'
        ? [fast, { name: 'other slow check', status: 'in_progress', conclusion: null, started_at: '1', id: 3 }]
    : [
        { name: 'test', status: 'completed', conclusion: 'success', started_at: '1', id: 1 },
        v === 'pending' ? { name: 'push-gate', status: 'in_progress', conclusion: null, started_at: '1', id: 2 } : { name: 'push-gate', status: 'completed', conclusion: v === 'green' ? 'success' : 'failure', started_at: '1', id: 2 },
      ];

/**
 * A fake machine whose engine is `installed`, following a main whose tip is `tip`. `commits`: every commit GitHub's
 * compare of installed...tip lists (what is reachable from the tip and not from the installed one), with parents.
 */
function machine(o: { commits: Commit[]; tip: string; installed?: string; cfg?: Record<string, unknown>; held?: { sha: string; at: string; failed: string[] } | null; noAnswer?: string[] }) {
  const calls: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const sleeps: number[] = [];
  let current = o.installed ?? OLD;
  let clock = NOW;
  let memo: Record<string, { reason: string; at: string }> | null = null;
  const by = new Map(o.commits.map((c) => [c.sha, c]));
  const deps = {
    config: () => ({ enabled: true, repo_url: 'https://github.com/example-org/engine.git', branch: 'main', required_checks: ['test', 'push-gate'], ...o.cfg }),
    installed: () => current,
    exec: (file: string, args: string[]) => {
      calls.push([file, ...args].join(' ').slice(0, 120));
      if (file === 'git') return `${o.tip}\trefs/heads/main\n`;
      if (file === 'systemctl' && args[0] === 'list-units') return 'worklane-x.service loaded active running x\n';
      if (file === 'systemctl' && args[0] === 'show') return 'ActiveState=active\nSubState=running\nNRestarts=0\nResult=success\n';
      return '';
    },
    fetchJson: async (url: string) => {
      const path = url.split('/repos/example-org/engine/')[1]!;
      calls.push(`fetch ${path}`);
      if (path.startsWith('compare/')) {
        return {
          status: 'ahead',
          ahead_by: o.commits.length,
          behind_by: 0,
          total_commits: o.commits.length,
          commits: o.commits.map((c) => ({ sha: c.sha, parents: c.parents.map((p) => ({ sha: p })), commit: { committer: { date: minutesAgo(c.landed ?? 10) } } })),
        };
      }
      const m = /^commits\/([0-9a-f]{40})\/check-runs/.exec(path);
      if (!m || o.noAnswer?.includes(m[1]!)) return null;
      return { check_runs: runs(by.get(m[1]!)?.checks ?? 'none') };
    },
    slots: () => [],
    alive: () => false,
    installTree: (s: string) => calls.push(`installTree ${s}`),
    syncHelpers: () => [],
    switchTo: (s: string) => {
      current = s;
      calls.push(`switchTo ${s}`);
    },
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    log: (e: Record<string, unknown>) => logs.push(e),
    held: () => o.held ?? null,
    hold: () => {},
    configChangedAt: () => 0,
    verdicts: () => memo,
    saveVerdicts: (m: Record<string, { reason: string; at: string }>) => (memo = m),
    note: (event: string, s: string | null, reason: string) => (logs.push({ event, to: s, reason }), event),
  };
  const checked = () => calls.filter((c) => c.includes('/check-runs')).map((c) => c.split('/')[1]!);
  const built = () => calls.filter((c) => c.startsWith('systemd-run') || c.startsWith('switchTo'));
  return { deps, calls, logs, sleeps, checked, built, current: () => current, memo: () => memo, advance: (ms: number) => (clock += ms) };
}

/** A straight main: OLD, then each commit's parent the one before it; returns them oldest first. */
function line(verdicts: Verdict[], landed: number[] = []): Commit[] {
  const out: Commit[] = [];
  verdicts.forEach((v, i) => out.push({ sha: sha('abcdef123456789'[i]!), parents: [i ? out[i - 1]!.sha : OLD], checks: v, landed: landed[i] }));
  return out;
}

test('a red tip with a green parent: the parent is installed, and the log says why the tip was skipped', async () => {
  const [c1, c2, c3] = line(['green', 'green', 'red']);
  const m = machine({ commits: [c1!, c2!, c3!], tip: c3!.sha });
  assert.equal(await u.run(m.deps), 'installed');
  assert.equal(m.current(), c2!.sha, 'the newest green commit, not the red tip');
  assert.deepEqual(m.checked(), [c3!.sha, c2!.sha], 'newest first, stopping at the first green one');
  assert.ok(m.calls.includes(`installTree ${c2!.sha}`), 'the parent is what is built');
  const chose = m.logs.find((l) => l.event === 'chose')!;
  assert.ok(chose, 'a chose line');
  assert.equal(chose.to, c2!.sha);
  assert.equal(chose.tip, c3!.sha);
  assert.match(String(chose.reason), new RegExp(`skipped ${c3!.sha.slice(0, 7)}: required check "push-gate" ended failure`));
  assert.deepEqual(m.logs.map((l) => l.event), ['chose', 'attempt', 'installed']);
  assert.deepEqual(m.sleeps.slice(0, 1), [u.CHECKS_SPACING_MS], 'the second check-run call waits its turn');
});

test('a red tip and every older commit red: nothing is installed, and the refusal lists each one', async () => {
  const [c1, c2, c3] = line(['red', 'red', 'red']);
  const m = machine({ commits: [c1!, c2!, c3!], tip: c3!.sha });
  assert.equal(await u.run(m.deps), 'refused');
  assert.deepEqual(m.built(), []);
  assert.deepEqual(m.checked(), [c3!.sha, c2!.sha, c1!.sha], 'every commit back to the installed one');
  assert.match(String(m.logs.at(-1)!.reason), /^nothing to install: c{7}: required check "push-gate" ended failure; b{7}: .*; a{7}: /);
  // Ten minutes later: the older red verdicts are remembered (an hour), the tip is asked again.
  m.advance(10 * 60_000);
  const before = m.checked().length;
  assert.equal(await u.run(m.deps), 'refused');
  assert.deepEqual(m.checked().slice(before), [c3!.sha], 'only the tip: the older red ones come from the memo');
  m.advance(u.VERDICT_TTL_MS);
  const later = m.checked().length;
  await u.run(m.deps);
  assert.deepEqual(m.checked().slice(later), [c3!.sha, c2!.sha, c1!.sha], 'after an hour they are asked again');
});

test('forward only: a green commit older than the installed one is never chosen', async () => {
  // main: OLD <- a (green) <- b (installed) <- c (red) <- d (red). The compare of b...d lists c and d only.
  const a = { sha: sha('a'), parents: [OLD], checks: 'green' as const };
  const b = { sha: sha('b'), parents: [a.sha], checks: 'green' as const };
  const c = { sha: sha('c'), parents: [b.sha], checks: 'red' as const };
  const d = { sha: sha('d'), parents: [c.sha], checks: 'red' as const };
  const m = machine({ commits: [c, d], tip: d.sha, installed: b.sha });
  assert.equal(await u.run(m.deps), 'refused');
  assert.equal(m.current(), b.sha);
  assert.deepEqual(m.checked(), [d.sha, c.sha], 'the commits newer than the installed one, and nothing older');
  assert.deepEqual(m.built(), []);
  // Even if a compare listed older commits, the line stops at the installed one.
  assert.deepEqual(u.firstParentLine({ status: 'ahead', commits: [a, b, c, d].map((x) => ({ sha: x.sha, parents: x.parents.map((p) => ({ sha: p })) })) }, b.sha, d.sha, 20).map((x) => x.sha), [d.sha, c.sha]);
  // An installed commit off the tip's first-parent line: the tip alone (the old rule).
  assert.deepEqual(u.firstParentLine({ status: 'ahead', commits: [c, d].map((x) => ({ sha: x.sha, parents: x.parents.map((p) => ({ sha: p })) })) }, sha('e'), d.sha, 20).map((x) => x.sha), [d.sha]);
});

test('the lookback bound: at most max_lookback commits back from the tip', async () => {
  const commits = line(['green', 'red', 'red', 'red', 'red']);
  const tip = commits.at(-1)!.sha;
  const bounded = machine({ commits, tip, cfg: { max_lookback: 3 } });
  assert.equal(await u.run(bounded.deps), 'refused');
  assert.equal(bounded.checked().length, 3, 'three commits looked at');
  assert.ok(!bounded.checked().includes(commits[0]!.sha), 'the green one five back is out of reach');
  assert.deepEqual(bounded.built(), []);
  const wide = machine({ commits, tip });
  assert.equal(await u.run(wide.deps), 'installed', 'the default (20) reaches it');
  assert.equal(wide.current(), commits[0]!.sha);
  assert.equal(u.lookbackOf({}), 20);
  assert.equal(u.lookbackOf({ max_lookback: 0 }), 20);
  assert.equal(u.lookbackOf({ max_lookback: 1000 }), 100);
});

test('a pending tip: waited for while young, nothing older installed; after pending_wait_minutes an older green one goes in', async () => {
  // Young (10 minutes on main), a green parent: wait for the tip, as before.
  const young = line(['green', 'pending'], [30, 10]);
  const w = machine({ commits: young, tip: young[1]!.sha });
  assert.equal(await u.run(w.deps), 'waiting');
  assert.deepEqual(w.checked(), [young[1]!.sha], 'the parent is not even asked');
  assert.match(String(w.logs.at(-1)!.reason), /"push-gate" is in_progress/);
  assert.deepEqual(w.built(), []);
  // Pending, with nothing green below it, long past the wait: still waiting (it may turn green), never refused.
  const stuck = line(['red', 'pending'], [120, 90]);
  const s = machine({ commits: stuck, tip: stuck[1]!.sha });
  assert.equal(await u.run(s.deps), 'waiting');
  assert.deepEqual(s.checked(), [stuck[1]!.sha, stuck[0]!.sha], 'past the wait, the older ones are looked at');
  assert.match(String(s.logs.at(-1)!.reason), /pending_wait_minutes/);
  assert.deepEqual(s.built(), []);
  // Pending 90 minutes, a green parent: the parent goes in.
  const old = line(['green', 'pending'], [120, 90]);
  const g = machine({ commits: old, tip: old[1]!.sha });
  assert.equal(await u.run(g.deps), 'installed');
  assert.equal(g.current(), old[0]!.sha);
  // A shorter wait in updates.json.
  const short = machine({ commits: young, tip: young[1]!.sha, cfg: { pending_wait_minutes: 5 } });
  assert.equal(await u.run(short.deps), 'installed');
  assert.equal(short.current(), young[0]!.sha);
  assert.equal(u.pendingWaitMs({}), 60 * 60_000);
  // No answer from GitHub (a rate limit): wait, never treat it as red and move on.
  const quiet = machine({ commits: old, tip: old[1]!.sha, noAnswer: [old[1]!.sha] });
  assert.equal(await u.run(quiet.deps), 'waiting');
  assert.deepEqual(quiet.checked(), [old[1]!.sha]);
});

test('a tip with a required check not run and nothing in flight is passed over at once for an older green commit', async () => {
  // The incident: main's tip has had no slow-checks batch, its fast checks are done, and an older commit is fully
  // green. 15 minutes on main, far inside pending_wait_minutes.
  const commits = line(['green', 'unbatched'], [40, 15]);
  const m = machine({ commits, tip: commits[1]!.sha });
  assert.equal(await u.run(m.deps), 'installed');
  assert.equal(m.current(), commits[0]!.sha, 'the older green commit, never the unbatched tip');
  const chose = m.logs.find((l) => l.event === 'chose')!;
  assert.match(JSON.stringify(chose), /required check \\"push-gate\\" hasn't run on this commit, and none of its checks is queued or running/);
  // Several unbatched commits above the green one: each passed over, the green one installed.
  const many = line(['green', 'unbatched', 'unbatched', 'unbatched'], [60, 40, 25, 12]);
  const g = machine({ commits: many, tip: many[3]!.sha });
  assert.equal(await u.run(g.deps), 'installed');
  assert.equal(g.current(), many[0]!.sha);
  // Below the tip, that verdict is remembered (only main's newest commit gets a batch): not asked again next run.
  assert.deepEqual(Object.keys(g.memo() ?? {}).sort(), [many[1]!.sha, many[2]!.sha].sort());
  // Nothing green below it: waiting on the tip, with the reason; never refused, nothing installed.
  const alone = line(['red', 'unbatched'], [40, 15]);
  const a = machine({ commits: alone, tip: alone[1]!.sha });
  assert.equal(await u.run(a.deps), 'waiting');
  assert.match(String(a.logs.at(-1)!.reason), /hasn't run on this commit/);
  assert.deepEqual(a.built(), []);
  // What is installed is as strict as ever: an unbatched commit is never chosen, however long it waits.
  const only = line(['unbatched'], [600]);
  const o = machine({ commits: only, tip: only[0]!.sha });
  assert.equal(await u.run(o.deps), 'waiting');
  assert.deepEqual(o.built(), []);
});

test('a tip whose checks are in flight, or that only just landed, is still waited for', async () => {
  // The batch is running on the tip: something is in flight, so wait for it, nothing older installed.
  const running = line(['green', 'batching'], [40, 15]);
  const r = machine({ commits: running, tip: running[1]!.sha });
  assert.equal(await u.run(r.deps), 'waiting');
  assert.deepEqual(r.checked(), [running[1]!.sha], 'the parent is not even asked');
  assert.deepEqual(r.built(), []);
  // Landed 2 minutes ago with nothing running yet: its checks may not have appeared. Wait.
  assert.equal(u.IDLE_AFTER_MS, 10 * 60_000);
  const fresh = line(['green', 'unbatched'], [40, 2]);
  const f = machine({ commits: fresh, tip: fresh[1]!.sha });
  assert.equal(await u.run(f.deps), 'waiting');
  assert.deepEqual(f.built(), []);
  const none = line(['green', 'none'], [40, 2]);
  const n = machine({ commits: none, tip: none[1]!.sha });
  assert.equal(await u.run(n.deps), 'waiting');
  assert.deepEqual(n.built(), []);
});

test('first parent only: a merge commit\'s second parent is never chosen', async () => {
  // main: OLD <- m (merge of OLD and f2) <- t. The branch f1 <- f2 was green; m and t are red.
  const f1 = { sha: sha('f'), parents: [OLD], checks: 'green' as const };
  const f2 = { sha: sha('e'), parents: [f1.sha], checks: 'green' as const };
  const mg = { sha: sha('d'), parents: [OLD, f2.sha], checks: 'red' as const };
  const t = { sha: sha('c'), parents: [mg.sha], checks: 'red' as const };
  const m = machine({ commits: [f1, f2, mg, t], tip: t.sha });
  assert.equal(await u.run(m.deps), 'refused');
  assert.deepEqual(m.checked(), [t.sha, mg.sha], 'the tip and the merge, never the branch behind it');
  assert.deepEqual(m.built(), []);
  // The merge itself green: it is the one installed.
  const g = machine({ commits: [f1, f2, { ...mg, checks: 'green' }, t], tip: t.sha });
  assert.equal(await u.run(g.deps), 'installed');
  assert.equal(g.current(), mg.sha);
});

test('a held commit is passed over for an older green one; a held tip with nothing else says held', async () => {
  const [c1, c2] = line(['green', 'green']);
  const held = { sha: c2!.sha, at: new Date(NOW - 3600_000).toISOString(), failed: ['worklane-x.service: failed'] };
  const m = machine({ commits: [c1!, c2!], tip: c2!.sha, held });
  assert.equal(await u.run(m.deps), 'installed');
  assert.equal(m.current(), c1!.sha);
  assert.match(String(m.logs.find((l) => l.event === 'chose')!.reason), /rolled back at/);
  const only = machine({ commits: [c2!], tip: c2!.sha, installed: c1!.sha, held });
  assert.equal(await u.run(only.deps), 'held');
  assert.match(String(only.logs.at(-1)!.reason), /^rolled back at .*held until a newer commit/);
});

test('a commit with over 100 check runs: every page is read, so required checks on a later page count; a missing page installs nothing', async () => {
  // The CI batch's scheduled run adds a check to main's tip every half hour; GitHub lists the newest first.
  const [c1] = line(['green']);
  const batchRuns = Array.from({ length: 100 }, (_, i) => ({ name: 'ci batch', status: 'completed', conclusion: 'success', started_at: `2026-10-13T1${i % 10}:00:00Z`, id: 100 + i }));
  const paged = (page2: unknown) => {
    const m = machine({ commits: [c1!], tip: c1!.sha });
    const base = m.deps.fetchJson;
    m.deps.fetchJson = async (url: string) => {
      if (!url.includes('/check-runs')) return base(url);
      m.calls.push(`fetch ${url.split('/repos/example-org/engine/')[1]}`);
      const page = Number(new URL(url).searchParams.get('page') ?? '1');
      return (page === 1 ? { total_count: 102, check_runs: batchRuns } : page === 2 ? page2 : { total_count: 102, check_runs: [] }) as never;
    };
    return m;
  };
  const m = paged({ total_count: 102, check_runs: runs('green') });
  assert.equal(await u.run(m.deps), 'installed');
  assert.equal(m.current(), c1!.sha);
  assert.deepEqual(m.calls.filter((c) => c.includes('/check-runs')), [`fetch commits/${c1!.sha}/check-runs?per_page=100`, `fetch commits/${c1!.sha}/check-runs?per_page=100&page=2`], 'two pages, no third');
  assert.deepEqual(m.sleeps.slice(0, 1), [u.CHECKS_SPACING_MS], 'the second page waits its turn');

  const red = paged({ total_count: 102, check_runs: runs('red') });
  assert.equal(await u.run(red.deps), 'refused', 'a red required check on page 2 counts');
  assert.equal(red.current(), OLD);
  const gone = paged(null);
  assert.equal(await u.run(gone.deps), 'waiting', 'a page GitHub gave no answer for could hide a red check: wait');
  assert.equal(gone.current(), OLD);
});
