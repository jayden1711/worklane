// Voice intake, spoken approvals and Siri are removed (#743). What an install that had them on still holds is refused
// or ignored, never honoured:
// - a dashboard request that says it came by voice (any `voice` field) is refused with 410, never taken as a click: a
//   click may approve what voice never could (voice's exclusions went with it), so a tab still running the old page
//   can't turn a spoken "approve" into a click's approval (here);
// - intake.yaml's `voice` and `siri` keys still load, so a leftover never turns intake off, and do nothing; each one
//   is a warning (src/intake/report.ts);
// - the hub's --siri-port and dashboards.sh's --siri are accepted and ignored: no gateway listens (src/cli.ts,
//   scripts/setup/dashboards.sh);
// - an instance's dashboard deletes its own Siri gateway token and device store when it starts (here);
// - doctor fails while the machine still has anything of them, and says how to remove each (src/doctor-voice-removed.ts).
import { rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * An instance's own Siri leftovers in its state: its gateway token (an older dashboard made one for every server
 * instance, Siri on or not) and its device store. Its dashboard deletes them when it starts, as the instance's own
 * user, so an install that never used Siri has nothing to do, and no device record outlives the upgrade. A link is
 * removed, never followed. A failure is left for doctor to name.
 */
export function removeSiriLeftovers(stateDir: string): void {
  for (const f of ['siri-gateway-token', 'siri']) {
    try {
      rmSync(join(stateDir, f), { recursive: true, force: true });
    } catch {
      // doctor names what is still there
    }
  }
}

/** What the hub says when its unit still has --siri-port: it starts, with no gateway. */
export const SIRI_PORT_IGNORED = 'warning: --siri-port is ignored: Siri was removed, so no gateway starts. Rerun dashboards.sh as root to drop it from the hub unit (doctor prints the command)';

/** What a request said by voice is told: nothing is done by voice any more. */
export const VOICE_REMOVED = 'voice intake, spoken approvals and Siri were removed: nothing is done by voice. Answer it with a click on the dashboard';

/**
 * The refusal for a request body that says it came by voice, or null for an ordinary click. Any `voice` field at all,
 * whatever its value (null and false too), is refused: only the old voice client ever sent one.
 */
export function voiceRequestRefusal(body: unknown): string | null {
  return body && typeof body === 'object' && Object.hasOwn(body, 'voice') ? VOICE_REMOVED : null;
}
