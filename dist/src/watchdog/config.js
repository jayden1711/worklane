// The watchdog's machine-level settings, /etc/<cli>/watchdog.json (optional; root's, readable by every
// coordinator). Every field is optional, and one that is out of range is ignored with the default kept, so a bad
// edit never turns the watchdog off:
//   stall_hours    ready work with nothing moving for this long is flagged (1-168; default 6)
//   disk_pct       a disk this full is flagged (50-99; default 85)
//   ops_channel    the Discord channel incidents are posted to, when no instance's intake.yaml names one
//                  (discord.ops_channel); the post goes with the bot token of the instance that posts
//   dashboard_url  the dashboard's https address, for the links in posts, when intake.yaml has none
//   min_free_gb    no test run or agent run starts while a filesystem it writes to has less free than the larger of
//   min_free_pct   these: GiB (1-10000; default 10) and % of the filesystem (0-50; default 5) (src/disk-guard.ts)
import { readFileSync } from 'node:fs';
import { DISK_PCT, STALL_HOURS } from './probes.js';
import { FLOOR_GB, FLOOR_PCT } from '../disk-guard.js';
import { etcPath } from '../os/system-paths.js';
export const WATCHDOG_CONFIG = etcPath('watchdog.json');
const num = (v, lo, hi, dflt) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : dflt);
/** The settings in effect: the file's valid fields over the defaults. */
export function watchdogConfig(path = WATCHDOG_CONFIG) {
    let j = {};
    try {
        const v = JSON.parse(readFileSync(path, 'utf8'));
        if (v && typeof v === 'object' && !Array.isArray(v))
            j = v;
    }
    catch {
        // absent or unreadable: the defaults
    }
    return {
        stallHours: num(j.stall_hours, 1, 168, STALL_HOURS),
        diskPct: num(j.disk_pct, 50, 99, DISK_PCT),
        opsChannel: typeof j.ops_channel === 'string' && /^\d{5,25}$/.test(j.ops_channel) ? j.ops_channel : null,
        dashboardUrl: typeof j.dashboard_url === 'string' && /^https:\/\/[^\s/]+(?:\/[^\s]*)?$/.test(j.dashboard_url) ? j.dashboard_url : null,
        minFreeGb: num(j.min_free_gb, 1, 10_000, FLOOR_GB),
        minFreePct: num(j.min_free_pct, 0, 50, FLOOR_PCT),
    };
}
//# sourceMappingURL=config.js.map