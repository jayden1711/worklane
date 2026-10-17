// Why no new work starts, said where people look: every hold the coordinator records (`governor.hold`) carries its
// kind and the numbers behind it, and this module turns them into what the Board and First run show (a banner with
// the reason, the numbers and the way out), what doctor warns of, and the disk floor's rule itself.
//
// The disk floor (the owner's decision, #470): another worktree may start only while the free disk after it stays at
// or above the larger of `governor.min_free_disk_gb` (default 10) and `governor.min_free_disk_pct` % of the disk
// (default 5). That is 10 GB on any disk up to 200 GB and 5% above it (23 GB of 460 GB).
/** Every reason dispatch holds (src/coordinator.ts, src/coordinator/fix-runs.ts, src/coordinator/base.ts governorHold). */
export const HOLD_KINDS = ['disk', 'disk_full', 'load', 'budget', 'slots', 'update_drain', 'usage_limit', 'sign_in', 'run_window'];
/** The free GB a disk of `totalGb` must keep: the larger of the absolute floor and the share. */
export function diskFloorGb(totalGb, g) {
    return Math.max(g.min_free_disk_gb, (g.min_free_disk_pct / 100) * totalGb);
}
/** The disk's room for another worktree under the floor. */
export function diskRoom(disk, g, estGb) {
    const floorGb = diskFloorGb(disk.totalGb, g);
    const afterGb = disk.freeGb - estGb;
    const shortGb = Math.max(0, floorGb - afterGb);
    return { freeGb: disk.freeGb, totalGb: disk.totalGb, freePct: disk.totalGb > 0 ? (disk.freeGb / disk.totalGb) * 100 : 0, floorGb, estGb, afterGb, shortGb, held: afterGb < floorGb };
}
/** A size in GB as people read it: whole GB from 10 up, one decimal below. */
export const gbText = (n) => `${n >= 10 ? Math.round(n) : Number(n.toFixed(1))} GB`;
const pctText = (n) => `${n >= 10 ? Math.round(n) : Number(n.toFixed(1))}%`;
/** The floor's rule in words: "23 GB (the larger of 10 GB and 5% of the disk)". */
export function floorText(floorGb, g) {
    return `${gbText(floorGb)} (the larger of ${gbText(g.min_free_disk_gb)} and ${g.min_free_disk_pct}% of the disk)`;
}
/** The disk's numbers: "46 GB free of 460 GB (10%); the floor is 23 GB (…); one more worktree needs ~1 GB". */
export function diskNumbers(r, g) {
    return `${gbText(r.freeGb)} free of ${gbText(r.totalGb)} (${pctText(r.freePct)}); the floor is ${floorText(r.floorGb, g)}; one more worktree needs ~${gbText(r.estGb)}`;
}
/** GB to free, rounded up to a whole GB (never 0 when something must be freed). */
export const toFree = (shortGb) => Math.max(1, Math.ceil(shortGb));
/** The disk hold's reason (the coordinator's log line and the event's `reason`). */
export function diskHoldReason(r) {
    return `free disk would drop to ${gbText(Math.max(0, r.afterGb))} with another ${gbText(r.estGb)} worktree, under the ${gbText(r.floorGb)} floor`;
}
/** The hold for a disk without room, with its numbers; null when another worktree fits. */
export function diskHold(r, g, load) {
    if (!r.held)
        return null;
    const facts = { free_gb: r.freeGb, total_gb: r.totalGb, floor_gb: r.floorGb, floor_min_gb: g.min_free_disk_gb, floor_pct: g.min_free_disk_pct, est_gb: r.estGb };
    return { kind: 'disk', reason: diskHoldReason(r), load, freeDiskPct: r.freePct, facts };
}
/** The next start of a run window after `now` (local time, as inRunWindow reads them); null without windows. */
export function nextRunWindowStart(windows, now) {
    let best = null;
    for (const w of windows) {
        const d = new Date(now);
        d.setHours(Number(w.from.slice(0, 2)), Number(w.from.slice(3, 5)), 0, 0);
        if (d.getTime() <= now.getTime())
            d.setDate(d.getDate() + 1);
        if (!best || d < best)
            best = d;
    }
    return best;
}
const SETTINGS = { path: '/settings', label: 'Settings' };
const MACHINE = { path: '/machine', label: 'Machine page' };
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
/**
 * The banner for a recorded hold. A hold recorded before kinds existed shows its reason only. The fix names a figure
 * from the numbers (the GB to free), never a guess.
 */
export function holdBanner(h, since) {
    const f = h.facts ?? {};
    const kind = HOLD_KINDS.includes(h.kind ?? '') ? h.kind : 'other';
    const base = { kind, since, wait: null, link: null };
    switch (kind) {
        case 'disk': {
            const free = num(f.free_gb), total = num(f.total_gb), floor = num(f.floor_gb), est = num(f.est_gb);
            if (free === null || total === null || floor === null || est === null)
                return { ...base, title: 'Low disk: no new worktree fits above the floor', numbers: h.reason, fix: 'Free space on this disk, or change the floor in Settings.', link: SETTINGS };
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
            return { ...base, title: "Today's agent budget is spent", numbers: spent !== null && budget !== null ? `$${spent.toFixed(2)} spent today of the $${budget} daily budget` : h.reason, wait: f.until ?? null, fix: 'or raise the daily budget in Settings.', link: SETTINGS };
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
export function bannerForViewer(b) {
    return { ...b, fix: null, link: null };
}
/** doctor's and First run's disk check: warn when free disk is under the floor, or would be after one more worktree. */
export function diskFloorCheck(disk, g, estGb) {
    const r = diskRoom(disk, g, estGb);
    const numbers = diskNumbers(r, g);
    if (!r.held)
        return { level: 'ok', detail: `${numbers}: room for another worktree`, room: r };
    const under = r.freeGb < r.floorGb ? 'free disk is under the floor' : 'free disk would drop under the floor with one more worktree';
    return { level: 'warn', detail: `${under}, so no new work starts: ${numbers}. Free ~${toFree(r.shortGb)} GB, or lower the floor (governor.min_free_disk_gb / min_free_disk_pct in the repo config).`, room: r };
}
//# sourceMappingURL=governor-holds.js.map