// Doctor's check for what an install that had voice or Siri on still holds after their removal (#743, src/voice-removed.ts):
// intake.yaml's `voice` and `siri` keys, an instance's Siri device token store and gateway token, the hub unit's
// --siri-port, and the tailnet's 8443 forward to the old gateway. Nothing reads or serves any of them now; doctor
// fails until they are gone, and names the step that removes each.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from './brand.js';
import { OWNER_TERMINAL_RERUN, ownerTerminalRerun } from './console/owner-terminal-removed.js';
import { INTAKE_FILE, loadIntakeConfig } from './intake/config.js';
import { REMOVED_INTAKE_KEYS } from './intake/report.js';
import { instancesDir } from './instance.js';
import { asRoot, unitPath } from './os/system-paths.js';
import { TAILSCALE_SCRIPT } from './tailscale-setup.js';

/** The old Siri gateway's files in an instance's state directory: its device token store and its gateway token. */
export const SIRI_STATE_FILES = ['siri', 'siri-gateway-token'] as const;
/** The hub unit's option that started the old Siri gateway. */
export const SIRI_PORT_OPTION = '--siri-port';
/** The step that removes the tailnet's 8443 forward to the old gateway. */
export const UNSERVE_SIRI = `sudo bash ${asRoot.opt('current/scripts/setup/tailscale.sh')} unserve-siri`;

export interface SiriLeftoverPaths {
  /** The instances whose intake.yaml to read. */
  instances?: readonly string[];
  /** Each instance's intake.yaml (tests); default: instancesDir()/<name>/intake.yaml. */
  intakeFile?: (instance: string) => string;
  /** The hub's unit: its ExecStart names --siri-port and each instance's state directory. */
  hubUnitFile?: string;
  /** Whether tailscale serve still forwards the tailnet's 8443 to the old gateway; null when it can't be told. */
  tailnetSiri?: () => boolean | null;
  /** Who must own the hub unit for doctor to build the exact rerun from it (tests pass their own uid). */
  rootUid?: number;
}

/** What the hub unit says, read loosely (to find leftovers, never to build a command): --siri-port, and each --hub state directory. */
function readHubUnit(file: string): { siriPort: boolean; states: string[] } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { siriPort: false, states: [] };
  }
  const words = text
    .split('\n')
    .filter((l) => /^\s*ExecStart\s*=/.test(l))
    .flatMap((l) => l.replace(/^\s*ExecStart\s*=/, '').trim().split(/[ \t]+/));
  const at = words.indexOf('--hub');
  const hub = at >= 0 ? words[at + 1] : undefined;
  const states = hub && hub !== '-' ? hub.split(',').flatMap((i) => (i.includes('=') ? [i.slice(i.indexOf('=') + 1)] : [])) : [];
  return { siriPort: words.includes(SIRI_PORT_OPTION), states };
}

/** tailscale.sh status --json's `siri`: 8443 on this machine's tailnet name still forwards to the old gateway. */
function tailnetSiriNow(script = TAILSCALE_SCRIPT): boolean | null {
  if (!existsSync(script)) return null;
  const r = spawnSync('bash', [script, 'status', '--json'], { encoding: 'utf8', timeout: 15_000 });
  if (r.status !== 0) return null;
  try {
    return (JSON.parse(r.stdout) as { siri?: unknown }).siri === true;
  } catch {
    return null;
  }
}

/**
 * Null while the machine has nothing of voice or Siri left; a failure naming each leftover and the step that removes
 * it otherwise. A path this user can't see (another user's state) is said, never guessed: a warning on its own.
 */
export function voiceSiriLeftoverCheck(o: SiriLeftoverPaths = {}): { name: string; level: 'fail' | 'warn'; detail: string } | null {
  const found: string[] = [];
  const unseen: string[] = [];
  for (const name of o.instances ?? []) {
    const file = o.intakeFile ? o.intakeFile(name) : join(instancesDir(), name, INTAKE_FILE);
    let loaded: ReturnType<typeof loadIntakeConfig> = null;
    try {
      loaded = loadIntakeConfig(file);
    } catch {
      // unreadable here: the intake check says so
    }
    if (loaded && 'config' in loaded) {
      for (const k of REMOVED_INTAKE_KEYS) if (loaded.config[k] !== undefined) found.push(`${file} still has ${k} (ignored): delete that section`);
    }
  }
  const unitFile = o.hubUnitFile ?? unitPath(`${BRAND.cli}-dashboard-hub.service`);
  const unit = readHubUnit(unitFile);
  let rerun = false;
  if (unit.siriPort) {
    found.push(`the hub's unit (${unitFile}) still has ${SIRI_PORT_OPTION} (ignored: no gateway starts)`);
    rerun = true;
  }
  for (const state of unit.states) {
    for (const f of SIRI_STATE_FILES) {
      const p = join(state, f);
      try {
        lstatSync(p);
        found.push(`${p} is still there (${f === 'siri' ? 'the Siri device token store' : 'the Siri gateway token'})`);
        rerun = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EACCES') unseen.push(p);
      }
    }
  }
  const tailnet = (o.tailnetSiri ?? tailnetSiriNow)();
  if (tailnet) found.push("tailscale serve still forwards this machine's tailnet port 8443 to the removed Siri gateway");
  const cantCheck = unseen.length ? [`can't check (permission denied; run doctor as root): ${unseen.join(', ')}`] : [];
  if (!found.length) return cantCheck.length ? { name: 'voice and Siri removed', level: 'warn', detail: cantCheck[0]! } : null;
  const steps: string[] = [];
  if (rerun) {
    const r = ownerTerminalRerun({ hubUnitFile: unitFile, ...(o.rootUid !== undefined ? { rootUid: o.rootUid } : {}) });
    const command = 'command' in r ? r.command : `${OWNER_TERMINAL_RERUN} (each <...> and [...] filled in from the hub unit's ExecStart; the exact command can't be built here: ${r.error})`;
    steps.push(`as root, rerun dashboards.sh once: it drops ${SIRI_PORT_OPTION} and deletes each instance's Siri token store and gateway token: ${command}`);
  }
  if (tailnet) steps.push(`as root, remove the 8443 forward: ${UNSERVE_SIRI}`);
  return {
    name: 'voice and Siri removed',
    level: 'fail',
    detail: ['voice intake, spoken approvals and Siri were removed; this machine still has some of them, which nothing reads or serves:', ...found.map((f) => `- ${f}`), ...steps, ...cantCheck].join('\n'),
  };
}
