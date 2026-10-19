// Machine owners: the GitHub logins that may change the machine itself (the agent and test-run slot caps, engine
// updates; later, adding a project), as opposed to an instance's owners (admin on its repo), who own only that
// instance. The list is root's: /etc/<cli>/machine-owners.json, root:root 0644, written by
// `dashboards.sh --machine-owner <login>[,<login>...]`. Every instance user reads it; none can change it.
//
//   {"owners": ["<login>", "<login>"]}
//
// It's checked three times: by the dashboard before it records a machine request (src/machine-requests.ts), by
// the coordinator again before it runs one (src/coordinator/machine-requests.ts: the request names who asked),
// and never for the owner's break-glass (the token, on this machine only), which stays allowed. A machine change
// also needs a signed-in session and one of the machine devices (dashboards.sh --machine-devices; an older hub unit's
// --console-devices, the removed owner terminal's list, is read as these).
//
// Fails closed: no file, a file anyone but root (or this user) owns or may write, or one that doesn't parse, or
// that names anything but GitHub logins, means no machine owners, so only the break-glass may change the machine.
import { readFileSync } from 'node:fs';
import { BRAND } from './brand.js';
import { fileAccess } from './os/index.js';
import { etcPath } from './os/system-paths.js';

export const MACHINE_OWNERS_FILE = etcPath('machine-owners.json');

/** A GitHub login: letters, digits and single dashes inside, at most 39 characters (dashboards.sh checks the same). */
export const GITHUB_LOGIN = /^(?=.{1,39}$)[A-Za-z0-9](?:-?[A-Za-z0-9])*$/;

/** The machine owners and, when the file can't be used, why (no file is no owners, not an error). */
export function readMachineOwners(file = MACHINE_OWNERS_FILE): { owners: string[]; error: string | null } {
  const a = fileAccess(file);
  if (a.kind === 'missing') return { owners: [], error: null };
  if (a.kind === 'hidden') return { owners: [], error: `${file} can't be read by this user (it should be root:root 0644)` };
  if (a.kind === 'file') {
    const me = typeof process.getuid === 'function' ? process.getuid() : null;
    if (a.uid !== 0 && a.uid !== me) return { owners: [], error: `${file} isn't root's: an admin rewrites it with dashboards.sh --machine-owner` };
    if (Number.parseInt(a.mode, 8) & 0o022) return { owners: [], error: `${file} is writable by its group or others (mode ${a.mode}): an admin rewrites it with dashboards.sh --machine-owner` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { owners: [], error: `${file}: ${(e as NodeJS.ErrnoException).code ? "can't be read" : 'not JSON'}` };
  }
  const list = (raw as { owners?: unknown } | null)?.owners;
  if (!Array.isArray(list) || !list.every((l): l is string => typeof l === 'string' && GITHUB_LOGIN.test(l))) return { owners: [], error: `${file}: expected {"owners": ["<GitHub login>", ...]}` };
  const seen = new Set<string>();
  return { owners: list.filter((l) => !seen.has(l.toLowerCase()) && !!seen.add(l.toLowerCase())), error: null };
}

/** The machine owners' GitHub logins; none when the file is missing or can't be trusted. */
export const machineOwners = (file = MACHINE_OWNERS_FILE): string[] => readMachineOwners(file).owners;

/** Whether this GitHub login is a machine owner (case-insensitive, as GitHub logins are). */
export function isMachineOwner(login: string | null | undefined, file = MACHINE_OWNERS_FILE): boolean {
  if (!login || !GITHUB_LOGIN.test(login)) return false;
  const l = login.toLowerCase();
  return machineOwners(file).some((o) => o.toLowerCase() === l);
}

/** Who asks for a machine change, as the dashboard resolved them. */
export interface MachineRequester {
  login: string;
  /** The owner's break-glass (the token, on this machine only): allowed without the checks below. */
  breakGlass: boolean;
  /** Whether the hub identified this request's Tailscale device as one of the machine devices. */
  deviceOk: boolean;
}

/** The machine owners as the page names them: `@a, @b`, or that none are set and how to set them. */
export const ownersText = (owners: string[]) => (owners.length ? owners.map((o) => `@${o}`).join(', ') : 'none set (an admin runs dashboards.sh --machine-owner <login>)');

/**
 * Why this person may not ask for a machine change now; null when they may: a machine owner, from one of the machine
 * devices (src/console/terminal-devices.ts). The break-glass is allowed.
 */
export function machineChangeRefusal(r: MachineRequester, o: { file?: string } = {}): string | null {
  if (r.breakGlass) return null;
  const file = o.file ?? MACHINE_OWNERS_FILE;
  if (!isMachineOwner(r.login, file)) return `only the machine's owners may change the machine (machine owners: ${ownersText(machineOwners(file))}); @${r.login} isn't one`;
  if (!r.deviceOk) return "a machine change needs one of the machine's allowed devices (dashboards.sh --machine-devices); this request didn't come from one";
  return null;
}
