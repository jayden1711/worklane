// Governor holds are seen (#470): the disk floor's rule (the larger of min_free_disk_gb and min_free_disk_pct), every
// hold kind's banner from recorded governor.hold events (reason, numbers, fix), cleared on release, a viewer's without
// the fix or link, doctor's warning under the floor, and the numbers Settings and First run read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardForViewer, boardView } from '../src/board.js';
import { loadConfig } from '../src/config/load.js';
import { BRAND } from '../src/brand.js';
import { diskFloorNow } from '../src/dashboard.js';
import { doctor } from '../src/doctor.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { diskFloorCheck, diskFloorGb, diskHold, diskRoom, HOLD_KINDS, holdBanner, nextRunWindowStart, type HoldKind } from '../src/governor-holds.js';
import { project } from '../src/projection.js';
import { stateForViewer } from '../src/viewer-events.js';
import { exampleProject } from './helpers.js';

const DEFAULTS = { min_free_disk_gb: 10, min_free_disk_pct: 5 };

test('the floor: 10 GB on a small disk, 5% on a big one, a custom percentage kept; held exactly when another worktree would go under it', () => {
  // A small disk: 10 GB beats 5% (5 GB of 100 GB).
  assert.equal(diskFloorGb(100, DEFAULTS), 10);
  assert.equal(diskFloorGb(200, DEFAULTS), 10, 'the two meet at 200 GB');
  assert.equal(diskRoom({ freeGb: 11, totalGb: 100 }, DEFAULTS, 1).held, false, '10 GB left after the worktree: at the floor, not under it');
  assert.equal(diskRoom({ freeGb: 10.9, totalGb: 100 }, DEFAULTS, 1).held, true, '9.9 GB left: under it');
  // Under the old flat 15%, 14.5 GB of 100 GB left held all work; now it doesn't.
  assert.equal(diskRoom({ freeGb: 15.5, totalGb: 100 }, DEFAULTS, 1).held, false);
  // A big disk: 5% (23 GB of 460 GB) beats 10 GB.
  assert.equal(diskFloorGb(460, DEFAULTS), 23);
  assert.equal(diskRoom({ freeGb: 24, totalGb: 460 }, DEFAULTS, 1).held, false);
  const big = diskRoom({ freeGb: 23.5, totalGb: 460 }, DEFAULTS, 1);
  assert.equal(big.held, true);
  assert.equal(big.shortGb, 0.5);
  // A config that set 15% keeps it: on 460 GB that's 69 GB.
  assert.equal(diskFloorGb(460, { min_free_disk_gb: 10, min_free_disk_pct: 15 }), 69);
  assert.equal(diskRoom({ freeGb: 46, totalGb: 460 }, { min_free_disk_gb: 10, min_free_disk_pct: 15 }, 1).held, true);
  // diskHold: null with room, the numbers as facts without.
  assert.equal(diskHold(diskRoom({ freeGb: 50, totalGb: 460 }, DEFAULTS, 1), DEFAULTS, 1), null);
  assert.deepEqual(diskHold(big, DEFAULTS, 2)?.facts, { free_gb: 23.5, total_gb: 460, floor_gb: 23, floor_min_gb: 10, floor_pct: 5, est_gb: 1 });
});

test('the config: the floor defaults to 10 GB and 5%, and a repo that set min_free_disk_pct keeps its value', () => {
  const { dir } = exampleProject();
  const g = loadConfig(dir).project.governor;
  assert.equal(g.min_free_disk_gb, 10);
  assert.equal(g.min_free_disk_pct, 5);
  const file = join(dir, BRAND.configDir, 'config.yaml');
  writeFileSync(file, `${readFileSync(file, 'utf8')}\ngovernor: { min_free_disk_pct: 15 }\n`);
  const kept = loadConfig(dir).project.governor;
  assert.equal(kept.min_free_disk_pct, 15, 'an existing setting is kept');
  assert.equal(kept.min_free_disk_gb, 10);
});

test('the next run window opens at its start, today if still ahead, else tomorrow', () => {
  const now = new Date(2026, 9, 10, 12, 0);
  assert.equal(nextRunWindowStart([{ from: '08:00', to: '09:00' }], now)?.getTime(), new Date(2026, 9, 11, 8, 0).getTime());
  assert.equal(nextRunWindowStart([{ from: '08:00', to: '09:00' }, { from: '18:30', to: '23:00' }], now)?.getTime(), new Date(2026, 9, 10, 18, 30).getTime());
  assert.equal(nextRunWindowStart([], now), null);
});

/** Each hold kind as the coordinator records it (src/coordinator.ts, src/coordinator/base.ts), with what its banner must say. */
const HOLDS: Record<HoldKind, { payload: EventPayload<'governor.hold'>; numbers: RegExp | null; fix: RegExp; wait?: string; link: string | null }> = {
  disk: {
    payload: { kind: 'disk', reason: 'free disk would drop to 45 GB with another 1 GB worktree, under the 69 GB floor', load: 1, free_disk_pct: 10, facts: { free_gb: 46, total_gb: 460, floor_gb: 69, floor_min_gb: 10, floor_pct: 15, est_gb: 1 } },
    numbers: /^46 GB free of 460 GB \(10%\); the floor is 69 GB \(the larger of 10 GB and 15% of the disk\); one more worktree needs ~1 GB$/,
    fix: /^Free ~24 GB on this disk, or change the floor in Settings\.$/,
    link: '/settings',
  },
  disk_full: {
    payload: { kind: 'disk_full', reason: 'paused: free disk is below the floor: /var/x has 3.0 GiB free, the floor is 10.0 GiB', load: null, free_disk_pct: null },
    numbers: /^free disk is below the floor: \/var\/x has 3\.0 GiB free, the floor is 10\.0 GiB$/,
    fix: /Free space on that disk/,
    link: null,
  },
  load: { payload: { kind: 'load', reason: 'machine load 41 > 40', load: 41, free_disk_pct: 50, facts: { load: 41, max_load: 40 } }, numbers: /^load 41\.0; the limit is 40$/, fix: /resumes on its own once the load drops/, link: '/settings' },
  budget: {
    payload: { kind: 'budget', reason: 'daily budget $5 reached', load: 1, free_disk_pct: 50, facts: { spent_usd: 5.2, budget_usd: 5, until: '2026-10-16T00:00:00.000Z' } },
    numbers: /^\$5\.20 spent today of the \$5 daily budget$/,
    fix: /^or raise the daily budget in Settings\.$/,
    wait: '2026-10-16T00:00:00.000Z',
    link: '/settings',
  },
  slots: { payload: { kind: 'slots', reason: 'machine-wide agent cap reached (all harnesses)', load: null, free_disk_pct: null, facts: { cap: 2, running: 2 } }, numbers: /^2 of 2 agent slots in use/, fix: /raise the agent cap on the Machine page/, link: '/machine' },
  update_drain: { payload: { kind: 'update_drain', reason: 'draining for an engine update: no new agent starts until it is installed', load: null, free_disk_pct: null }, numbers: null, fix: /once the update is installed/, link: '/machine' },
  usage_limit: { payload: { kind: 'usage_limit', reason: 'paused on the Claude usage limit until 2026-10-15T20:00:00.000Z', load: null, free_disk_pct: null, facts: { until: '2026-10-15T20:00:00.000Z' } }, numbers: null, fix: /switch the Claude account/, wait: '2026-10-15T20:00:00.000Z', link: null },
  sign_in: { payload: { kind: 'sign_in', reason: 'Claude sign-in failed (agents@example.com): no new runs until a call on that login succeeds', load: null, free_disk_pct: null }, numbers: /Claude sign-in failed/, fix: /Sign in to Claude again/, link: '/first-run?open=claude-login' },
  run_window: { payload: { kind: 'run_window', reason: 'outside the run windows (08:00-09:00)', load: null, free_disk_pct: null, facts: { windows: '08:00-09:00', until: '2026-10-16T13:00:00.000Z' } }, numbers: /^run windows: 08:00-09:00$/, fix: /change the run windows in Settings/, wait: '2026-10-16T13:00:00.000Z', link: '/settings' },
};

function logWith(...holds: EventPayload<'governor.hold'>[]) {
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'holds-')), 'events.db'));
  for (const h of holds) log.append('governor.hold', h, 'c');
  return log;
}
const boardOf = (log: EventLog, role: 'owner' | 'viewer' = 'owner') => boardView({ events: log.read(), instance: 'a', role, canReadDigest: role === 'owner', live: [], slots: { cap: 2, running: 0 } });

test('every hold kind recorded by the coordinator shows as a banner with its numbers and fix; a release clears it', () => {
  assert.deepEqual(Object.keys(HOLDS).sort(), [...HOLD_KINDS].sort(), 'every kind is checked');
  for (const kind of HOLD_KINDS) {
    const want = HOLDS[kind];
    const log = logWith(want.payload);
    const h = boardOf(log).hold;
    assert.ok(h, `${kind}: a banner while held`);
    assert.equal(h.kind, kind);
    assert.ok(h.title.length > 0, `${kind}: a reason in words`);
    if (want.numbers) assert.match(h.numbers ?? '', want.numbers, `${kind}: its numbers`);
    else assert.equal(h.numbers, null);
    assert.match(h.fix ?? '', want.fix, `${kind}: its fix`);
    assert.equal(h.wait, want.wait ?? null, `${kind}: its wait`);
    assert.equal(h.link?.path ?? null, want.link, `${kind}: its link`);
    // The state's projection carries the same banner (First run reads it there).
    assert.deepEqual(project(log.read()).governor?.banner, h);
    log.append('governor.release', { load: 1, free_disk_pct: null }, 'c');
    assert.equal(boardOf(log).hold, null, `${kind}: cleared on release`);
    assert.equal(project(log.read()).governor?.banner, null);
  }
});

test('a hold recorded before kinds existed still shows, by its reason', () => {
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'holds-')), 'events.db'));
  log.append('governor.hold', { reason: 'free disk would drop to 9.7% (< 15%) with another 1 GB worktree', load: 1, free_disk_pct: 10 }, 'c');
  const h = boardOf(log).hold!;
  assert.equal(h.kind, 'other');
  assert.equal(h.title, 'free disk would drop to 9.7% (< 15%) with another 1 GB worktree');
});

test('a viewer sees that work is held and why, never the fix or the Settings link', () => {
  const log = logWith(HOLDS.disk.payload);
  const forViewer = boardForViewer(boardOf(log, 'viewer')) as { hold: { numbers: string; fix: unknown; link: unknown; title: string } };
  assert.match(forViewer.hold.numbers, HOLDS.disk.numbers!);
  assert.equal(forViewer.hold.fix, null);
  assert.equal(forViewer.hold.link, null);
  const state = stateForViewer({ governor: project(log.read()).governor }) as { governor: { held: boolean; banner: { fix: unknown; link: unknown; numbers: string } } };
  assert.equal(state.governor.held, true);
  assert.match(state.governor.banner.numbers, HOLDS.disk.numbers!);
  assert.equal(state.governor.banner.fix, null);
  assert.equal(state.governor.banner.link, null);
});

test('doctor warns under the floor, and after one more worktree would be, with the numbers and the GB to free', () => {
  const { dir } = exampleProject();
  const check = (freeGb: number, totalGb: number) => doctor(dir, { disk: () => ({ freeGb, totalGb }) }).find((c) => c.name === 'disk floor')!;
  const under = check(46, 1000); // floor 50 GB
  assert.equal(under.level, 'warn');
  assert.match(under.detail, /^free disk is under the floor, so no new work starts: 46 GB free of 1000 GB \(4\.6%\); the floor is 50 GB \(the larger of 10 GB and 5% of the disk\); one more worktree needs ~1 GB\. Free ~5 GB/);
  const after = check(10.5, 100); // 9.5 GB left after the worktree
  assert.equal(after.level, 'warn');
  assert.match(after.detail, /^free disk would drop under the floor with one more worktree/);
  assert.match(after.detail, /Free ~1 GB/);
  assert.equal(check(60, 100).level, 'ok');
  assert.match(check(60, 100).detail, /room for another worktree/);
});

test("Settings' and First run's numbers: the same check, null when the disk can't be measured", () => {
  const { dir } = exampleProject();
  const cfg = loadConfig(dir);
  assert.deepEqual(diskFloorNow({ root: dir, cfg }, () => ({ freeGb: 22, totalGb: 460 })), diskFloorCheck({ freeGb: 22, totalGb: 460 }, cfg.project.governor, cfg.tests.worktree.est_size_gb));
  assert.equal(diskFloorNow({ root: dir, cfg }, () => ({ freeGb: 22, totalGb: 460 }))?.level, 'warn');
  assert.equal(
    diskFloorNow({ root: dir, cfg }, () => {
      throw new Error('no such path');
    }),
    null,
  );
});
