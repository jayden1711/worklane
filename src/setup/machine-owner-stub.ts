// A stand-in for the machine-owners module (src/machine-owners.ts, built in parallel): the same interface,
// `isMachineOwner(login)`, over the same file, /etc/<cli>/machine-owners.json (root-owned, a JSON list of GitHub
// logins, or { "owners": [...] }). It fails closed: no file, an unreadable one or a malformed one means nobody is
// a machine owner. Once that module lands, its import replaces this one and this file goes.
import { readFileSync } from 'node:fs';
import { BRAND } from '../brand.js';

export const MACHINE_OWNERS_FILE = `/etc/${BRAND.cli}/machine-owners.json`;

/** The machine owners' logins, lowercased; none when the file is missing or malformed. */
export function machineOwners(file = MACHINE_OWNERS_FILE): string[] {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    const list = Array.isArray(j) ? j : (j as { owners?: unknown })?.owners;
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(x)).map((x) => x.toLowerCase()) : [];
  } catch {
    return [];
  }
}

export function isMachineOwner(login: string, file = MACHINE_OWNERS_FILE): boolean {
  return !!login && machineOwners(file).includes(login.toLowerCase());
}
