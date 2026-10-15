// Why no new work starts, said where people look: every hold the coordinator records (`governor.hold`) carries its
// kind and the numbers behind it, and this module turns them into what the Board and First run show (a banner with
// the reason, the numbers and the way out), what doctor warns of, and the disk floor's rule itself.
//
// The disk floor (the owner's decision, #470): another worktree may start only while the free disk after it stays at
// or above the larger of `governor.min_free_disk_gb` (default 10) and `governor.min_free_disk_pct` % of the disk
// (default 5). That is 10 GB on any disk up to 200 GB and 5% above it (23 GB of 460 GB).

/** Every reason dispatch holds (src/coordinator.ts, src/coordinator/fix-runs.ts, src/coordinator/base.ts governorHold). */
export const HOLD_KINDS = ['disk', 'disk_full', 'load', 'budget', 'slots', 'update_drain', 'usage_limit', 'sign_in', 'run_window'] as const;
export type HoldKind = (typeof HOLD_KINDS)[number];

/** The numbers behind a hold, as recorded when it began (each kind fills its own). */
export interface HoldFacts {
  free_gb?: number;
  total_gb?: number;
  floor_gb?: number;
  floor_min_gb?: number;
  floor_pct?: number;
  est_gb?: number;
  load?: number;
  max_load?: number;
  spent_usd?: number;
  budget_usd?: number;
  /** When it ends on its own (ISO): the usage limit's reset, the next run window, the budget's next day (UTC). */
  until?: string;
  cap?: number;
  running?: number;
  windows?: string;
}

/** A hold as the coordinator records it. */
export interface Hold {
  kind: HoldKind;
  reason: string;
  load: number | null;
  freeDiskPct: number | null;
  facts?: HoldFacts;
}

export interface FloorSettings {
  min_free_disk_gb: number;
  min_free_disk_pct: number;
}

/** The free GB a disk of `totalGb` must keep: the larger of the absolute floor and the share. */
export function diskFloorGb(totalGb: number, g: FloorSettings): number {
  return Math.max(g.min_free_disk_gb, (g.min_free_disk_pct / 100) * totalGb);
}

export interface DiskRoom {
  freeGb: number;
  totalGb: number;
  freePct: number;
  floorGb: number;
  estGb: number;
  /** Free GB once another worktree of `estGb` is made. */
  afterGb: number;
  /** GB to free so another worktree fits above the floor (0 when it already does). */
  shortGb: number;
  /** INVARIANT: true exactly when another worktree would leave less than the floor free. */
  held: boolean;
}

/** The disk's room for another worktree under the floor. */
export function diskRoom(disk: { freeGb: number; totalGb: number }, g: FloorSettings, estGb: number): DiskRoom {
  const floorGb = diskFloorGb(disk.totalGb, g);
  const afterGb = disk.freeGb - estGb;
  const shortGb = Math.max(0, floorGb - afterGb);
  return { freeGb: disk.freeGb, totalGb: disk.totalGb, freePct: disk.totalGb > 0 ? (disk.freeGb / disk.totalGb) * 100 : 0, floorGb, estGb, afterGb, shortGb, held: afterGb < floorGb };
}

/** A size in GB as people read it: whole GB from 10 up, one decimal below. */
export const gbText = (n: number) => `${n >= 10 ? Math.round(n) : Number(n.toFixed(1))} GB`;
const pctText = (n: number) => `${n >= 10 ? Math.round(n) : Number(n.toFixed(1))}%`;

/** The floor's rule in words: "23 GB (the larger of 10 GB and 5% of the disk)". */
export function floorText(floorGb: number, g: FloorSettings): string {
  return `${gbText(floorGb)} (the larger of ${gbText(g.min_free_disk_gb)} and ${g.min_free_disk_pct}% of the disk)`;
}

/** The disk's numbers: "46 GB free of 460 GB (10%); the floor is 23 GB (…); one more worktree needs ~1 GB". */
export function diskNumbers(r: DiskRoom, g: FloorSettings): string {
  return `${gbText(r.freeGb)} free of ${gbText(r.totalGb)} (${pctText(r.freePct)}); the floor is ${floorText(r.floorGb, g)}; one more worktree needs ~${gbText(r.estGb)}`;
}

/** GB to free, rounded up to a whole GB (never 0 when something must be freed). */
export const toFree = (shortGb: number) => Math.max(1, Math.ceil(shortGb));

/** The disk hold's reason (the coordinator's log line and the event's `reason`). */
export function diskHoldReason(r: DiskRoom): string {
  return `free disk would drop to ${gbText(Math.max(0, r.afterGb))} with another ${gbText(r.estGb)} worktree, under the ${gbText(r.floorGb)} floor`;
}

/** The hold for a disk without room, with its numbers; null when another worktree fits. */
export function diskHold(r: DiskRoom, g: FloorSettings, load: number | null): Hold | null {
  if (!r.held) return null;
  const facts: HoldFacts = { free_gb: r.freeGb, total_gb: r.totalGb, floor_gb: r.floorGb, floor_min_gb: g.min_free_disk_gb, floor_pct: g.min_free_disk_pct, est_gb: r.estGb };
  return { kind: 'disk', reason: diskHoldReason(r), load, freeDiskPct: r.freePct, facts };
}

/** The next start of a run window after `now` (local time, as inRunWindow reads them); null without windows. */
export function nextRunWindowStart(windows: { from: string; to: string }[], now: Date): Date | null {
  let best: Date | null = null;
  for (const w of windows) {
    const d = new Date(now);
    d.setHours(Number(w.from.slice(0, 2)), Number(w.from.slice(3, 5)), 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    if (!best || d < best) best = d;
  }
  return best;
}

/** Midnight UTC after `nowMs`: when the daily budget's day (spentToday's, UTC) turns. */
export function nextUtcDay(nowMs: number): Date {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
}

/** What the Board and First run show while a hold is in force. */
export interface HoldBanner {
  kind: HoldKind | 'other';
  /** The reason in plain words. */
  title: string;
  /** The numbers behind it, or null when the hold has none. */
  numbers: string | null;
  /** When it ends on its own (ISO), shown in the reader's local time as "wait until …"; null when it doesn't. */
  wait: string | null;
  /** What to do (after the wait, when there is one); null for a viewer. */
  fix: string | null;
  /** The page where it is changed; null for a viewer and when none. */
  link: { path: string; label: string } | null;
  /** When the hold began. */
  since: string;
}

const SETTINGS = { path: '/settings', label: 'Settings' };
const MACHINE = { path: '/machine', label: 'Machine page' };
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/**
 * The banner for a recorded hold. A hold recorded before kinds existed shows its reason only. The fix names a figure
 * from the numbers (the GB to free), never a guess.
 */
export function holdBanner(h: { kind?: string | undefined; reason: string; facts?: HoldFacts | undefined }, since: string): HoldBanner {
  const f = h.facts ?? {};
  const kind: HoldBanner['kind'] = (HOLD_KINDS as readonly string[]).includes(h.kind ?? '') ? (h.kind as HoldKind) : 'other';
  const base = { kind, since, wait: null as string | null, link: null as HoldBanner['link'] };
  switch (kind) {
    case 'disk': {
      const free = num(f.free_gb), total = num(f.total_gb), floor = num(f.floor_gb), est = num(f.est_gb);
      if (free === null || total === null || floor === null || est === null) return { ...base, title: 'Low disk: no new worktree fits above the floor', numbers: h.reason, fix: 'Free space on this disk, or change the floor in Settings.', link: SETTINGS };
      const g = { min_free_disk_gb: num(f.floor_min_gb) ?? floor, min_free_disk_pct: num(f.floor_pct) ?? 0 };
      const r = diskRoom({ freeGb: free, totalGb: total }, g, est);
      return { ...base, title: 'Low disk: work is held so another worktree never fills it', numbers: diskNumbers(r, g), fix: `Free ~${toFree(r.shortGb)} GB on this disk, or change the floor in Settings.`, link: SETTINGS };
    }
    case 'disk_full':
      return { ...base, title: 'The disk is full or below its floor: nothing new starts', numbers: h.reason.replace(/^paused: /, ''), fix: 'Free space on that disk: work resumes on its own once there is room.' };
    case 'load': {
      const load = num(f.load), max = num(f.max_load);
      return { ...base, title: 'The machine is busy: no new agent starts until its load drops', numbers: load !== null && max !== null ? `load ${load.toFixed(1)}; the limit is ${max}` : h.reason, fix: 'Wait: it resumes on its own once the load drops. The limit (governor.max_load) is shown in Settings.', link: SETTINGS };
    }
    case 'budget': {
      const spent = num(f.spent_usd), budget = num(f.budget_usd);
      return { ...base, title: "Today's agent budget is spent", numbers: spent !== null && budget !== null ? `$${spent.toFixed(2)} spent today (UTC) of the $${budget} daily budget` : h.reason, wait: f.until ?? null, fix: 'or raise the daily budget in Settings.', link: SETTINGS };
    }
    case 'slots': {
      const cap = num(f.cap), running = num(f.running);
      return { ...base, title: "Every agent slot on this machine is in use", numbers: cap !== null && running !== null ? `${running} of ${cap} agent slots in use (every instance and harness on this machine)` : h.reason, fix: 'Wait for one to finish, or raise the agent cap on the Machine page.', link: MACHINE };
    }
    case 'update_drain':
      return { ...base, title: 'Draining for an engine update', numbers: null, fix: 'Wait: work resumes once the update is installed (the Machine page shows it).', link: MACHINE };
    case 'usage_limit':
      return { ...base, title: 'Paused on the Claude usage limit', numbers: null, wait: f.until ?? null, fix: 'or switch the Claude account to resume sooner.' };
    case 'sign_in':
      return { ...base, title: 'Claude sign-in failed: no new runs', numbers: h.reason, fix: 'Sign in to Claude again; it resumes once a call on that login succeeds.', link: { path: '/first-run?open=claude-login', label: 'First run' } };
    case 'run_window':
      return { ...base, title: 'Outside the run windows', numbers: f.windows ? `run windows: ${f.windows}` : h.reason, wait: f.until ?? null, fix: 'or change the run windows in Settings.', link: SETTINGS };
    default:
      return { ...base, title: h.reason, numbers: null, fix: null };
  }
}

/** The banner as a viewer may have it: why work is held, never the way to change it (no fix, no link). */
export function bannerForViewer(b: HoldBanner): HoldBanner {
  return { ...b, fix: null, link: null };
}

/** doctor's and First run's disk check: warn when free disk is under the floor, or would be after one more worktree. */
export function diskFloorCheck(disk: { freeGb: number; totalGb: number }, g: FloorSettings, estGb: number): { level: 'ok' | 'warn'; detail: string; room: DiskRoom } {
  const r = diskRoom(disk, g, estGb);
  const numbers = diskNumbers(r, g);
  if (!r.held) return { level: 'ok', detail: `${numbers}: room for another worktree`, room: r };
  const under = r.freeGb < r.floorGb ? 'free disk is under the floor' : 'free disk would drop under the floor with one more worktree';
  return { level: 'warn', detail: `${under}, so no new work starts: ${numbers}. Free ~${toFree(r.shortGb)} GB, or lower the floor (governor.min_free_disk_gb / min_free_disk_pct in the repo config).`, room: r };
}
