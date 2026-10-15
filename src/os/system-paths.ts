// The machine's own locations: everything the engine reads or runs outside a checkout and a user's home, in one place.
// /etc/<cli> (machine owners, network, updates, slots, limits, the watchdog, signers), /var/lib/<cli> (the machine's
// state: changes, updates log, the Claude account, the init lock, the agent slots), /usr/local/libexec/<cli>-* (the
// root helpers), /opt/<cli> (the installed engine), /run/lock (the full-run lock), and the systemd unit directory.
//
// WHY: the release runs `npm test` on a machine that runs the engine (#312). A test that read the real
// /etc/<cli>/machine-owners.json, the real helper, or the real updates log got the machine's answer, not the test's.
// test/isolate.ts sets <PREFIX>_SYSTEM_ROOT to a fresh temporary directory, so under the suite every one of these is
// inside it; test/isolate.test.ts checks every constant built here and that src/ names none of these roots elsewhere.
//
// INVARIANT: every such path in src/ is built by systemPath(); unset (every real machine), each is the path itself.
// Moving the root can only point the engine at files somewhere else: it never widens what root's helpers allow
// (sudo runs only the real helper paths its rules name, with its own environment).
import { join } from 'node:path';
import { BRAND } from '../brand.js';

/** The variable that moves every system location under one directory (tests only; test/isolate.ts). */
export const SYSTEM_ROOT_VAR = `${BRAND.envPrefix}_SYSTEM_ROOT`;

/** `p` (an absolute system path) on this machine: itself, or under <PREFIX>_SYSTEM_ROOT when that is set. */
export function systemPath(p: string): string {
  if (!p.startsWith('/')) throw new Error(`systemPath: ${p} is not absolute`);
  const root = process.env[SYSTEM_ROOT_VAR];
  return root ? join(root, p) : p;
}

/** The roots below, as the real machine has them (the lint in test/isolate.test.ts looks for these in src/). */
export const SYSTEM_ROOTS = {
  etc: `/etc/${BRAND.cli}`,
  varLib: `/var/lib/${BRAND.cli}`,
  libexec: '/usr/local/libexec',
  opt: `/opt/${BRAND.cli}`,
  runLock: '/run/lock',
  units: '/etc/systemd/system',
  varTmp: '/var/tmp',
} as const;

/** /etc/<cli>/<name> */
export const etcPath = (name: string) => systemPath(`${SYSTEM_ROOTS.etc}/${name}`);
/** /var/lib/<cli>/<name> */
export const varLibPath = (name: string) => systemPath(`${SYSTEM_ROOTS.varLib}/${name}`);
/** /usr/local/libexec/<cli>-<name>: a root helper. */
export const libexecPath = (name: string) => systemPath(`${SYSTEM_ROOTS.libexec}/${BRAND.cli}-${name}`);
/** /opt/<cli>/<name>: the installed engine. */
export const optPath = (name: string) => systemPath(`${SYSTEM_ROOTS.opt}/${name}`);
/** /run/lock/<cli>-<name> */
export const runLockPath = (name: string) => systemPath(`${SYSTEM_ROOTS.runLock}/${BRAND.cli}-${name}`);
/** /etc/systemd/system/<unit> */
export const unitPath = (unit: string) => systemPath(`${SYSTEM_ROOTS.units}/${unit}`);
/** The test-run sandbox's base (scripts/setup/testrun-sandbox.sh): beside /var/lib/<cli>, its own directory. */
export const testRunBasePath = () => systemPath(`/var/lib/${BRAND.cli}-test`);
/** Single-user and development machines' slot directory (unbranded: every agent harness on the box shares it). */
export const devSlotsPath = () => systemPath(`${SYSTEM_ROOTS.varTmp}/agent-slots`);

/**
 * The same locations as root sees them, never moved: only for text that tells a person what to run as root, or what
 * root's helper changes (a root shell and the helper are outside the engine, so they always mean the real files). The
 * engine never opens or runs one of these; what it opens or runs is built by the functions above.
 */
export const asRoot = {
  etc: (name: string) => `${SYSTEM_ROOTS.etc}/${name}`,
  varLib: (name: string) => `${SYSTEM_ROOTS.varLib}/${name}`,
  libexec: (name: string) => `${SYSTEM_ROOTS.libexec}/${BRAND.cli}-${name}`,
  opt: (name: string) => `${SYSTEM_ROOTS.opt}/${name}`,
} as const;
