// Network for test runs (docs/test-runs.md "Network"). A run's commands have none: the sandbox helper gives every
// command's unit PrivateNetwork=yes (its own loopback only). Root's own file, /etc/<cli>/testrun-network.json
// (root:root 0644, written only by scripts/setup/testrun-network.sh), lists the tiers of each instance that may have
// it. A tier asks (tests.yaml test_run `network: true`; the setup steps with `setup_network: true`, as the tier
// "setup"); the helper reads root's file itself and grants or not, and says which on stderr ("<cli>-testrun: network
// granted (<tier>; ...)" or "network none (<why>)").
//
// INVARIANT: nothing here grants anything. The engine reads root's file only to show it (doctor, the Machine page).
import { lstatSync, readFileSync } from 'node:fs';
import { BRAND } from '../brand.js';
import { asRoot, etcPath } from '../os/system-paths.js';

export const NETWORK_FILE_NAME = 'testrun-network.json';
/** Root's grants, as the engine reads them (under the test root in tests). */
export const networkFilePath = () => etcPath(NETWORK_FILE_NAME);
/** The name the setup steps ask under: a tier can't be called this (./config.ts). */
export const SETUP_TIER = 'setup';

/** The root script that changes it, as a root shell runs it. */
export const NETWORK_SCRIPT = asRoot.opt('current/scripts/setup/testrun-network.sh');
export const networkCommands = (instance: string) => ({
  enable: `sudo bash ${NETWORK_SCRIPT} enable ${instance} --tiers <tier>[,<tier>...]`,
  disable: `sudo bash ${NETWORK_SCRIPT} disable ${instance}`,
  status: `sudo bash ${NETWORK_SCRIPT} status`,
});

export interface NetworkFile {
  /** instance -> the tiers granted the network, in the file's order. */
  instances: Record<string, string[]>;
}

const INSTANCE = /^[a-z][a-z0-9-]{0,20}$/;
export const NETWORK_TIER = /^[a-z][a-z0-9_-]{0,39}$/;

/** The file's text exactly as the script writes it (and the helper reads it): one instance a line. */
export function networkFileText(f: NetworkFile): string {
  const names = Object.keys(f.instances);
  const head = '{\n  "version": 1,\n';
  if (!names.length) return `${head}  "instances": {}\n}\n`;
  const lines = names.map((n, i) => `    "${n}": { "tiers": [${f.instances[n]!.map((t) => `"${t}"`).join(', ')}] }${i < names.length - 1 ? ',' : ''}`);
  return `${head}  "instances": {\n${lines.join('\n')}\n  }\n}\n`;
}

/** The file, or why it isn't one the helper reads: valid JSON in exactly the script's form, nothing more. */
export function parseNetworkFile(text: string): NetworkFile | { error: string } {
  const bad = { error: 'not in the form scripts/setup/testrun-network.sh writes' };
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return bad;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return bad;
  const o = j as Record<string, unknown>;
  if (o.version !== 1 || !o.instances || typeof o.instances !== 'object' || Array.isArray(o.instances)) return bad;
  const instances: Record<string, string[]> = {};
  for (const [name, v] of Object.entries(o.instances as Record<string, unknown>)) {
    const t = (v as { tiers?: unknown } | null)?.tiers;
    if (!INSTANCE.test(name) || !Array.isArray(t) || t.length < 1 || t.length > 32 || t.some((x) => typeof x !== 'string' || !NETWORK_TIER.test(x))) return bad;
    instances[name] = t as string[];
  }
  const f = { instances };
  return networkFileText(f) === text ? f : bad;
}

/** What root's file says of one instance: the tiers granted (maybe none), or unknown (it can't be read). */
export type NetworkPolicy = { state: 'on'; tiers: string[] } | { state: 'off'; why: string } | { state: 'unknown'; why: string };

/** Root's file for `instance`, as the helper would read it: a file it would refuse grants nothing (off). */
export function networkPolicy(instance: string, file = networkFilePath(), rootUid = 0): NetworkPolicy {
  let st;
  try {
    st = lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'off', why: 'no tier of any instance has the network on this machine (no root grant file)' };
    return { state: 'unknown', why: `${file} can't be read: ${(e as Error).message}` };
  }
  if (!st.isFile()) return { state: 'off', why: `${file} is not a regular file, so the helper grants no network` };
  if (st.uid !== rootUid || (st.mode & 0o777) !== 0o644) return { state: 'off', why: `${file} is not root's and 0644, so the helper grants no network` };
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return { state: 'unknown', why: `${file} can't be read: ${(e as Error).message}` };
  }
  const f = parseNetworkFile(text);
  if ('error' in f) return { state: 'off', why: `${file} is ${f.error}, so the helper grants no network` };
  const t = f.instances[instance];
  return t ? { state: 'on', tiers: [...new Set(t)] } : { state: 'off', why: `no tier of ${instance} has the network` };
}

/** What the helper said of a command that asked for the network. */
export type NetworkGrant = { granted: true; tier: string } | { granted: false; why: string };

/**
 * The helper's network line, which it prints only for a command that asked (exec --network): at `from` in the stderr
 * (right after any GPU line, before systemd-run's own). `own`: its [start, end) range, taken out of the run's output.
 */
export function networkLine(stderr: string, from = 0): { grant: NetworkGrant | null; own: Array<[number, number]> } {
  const re = new RegExp(`${BRAND.cli}-testrun: network (?:granted \\(([a-z][a-z0-9_-]{0,39}); [^\\n]*\\)|none \\(([^\\n]*)\\))\\n`, 'y');
  re.lastIndex = from;
  const m = re.exec(stderr);
  if (!m) return { grant: null, own: [] };
  const own: Array<[number, number]> = [[from, from + m[0].length]];
  return { grant: m[1] !== undefined ? { granted: true, tier: m[1] } : { granted: false, why: m[2]! }, own };
}

/** A tier's network as its record says it: none (the default, and any request not granted) or granted. */
export type NetworkRecord = { network: 'none' | 'granted'; detail?: string };

export function networkRecord(asked: boolean, g: NetworkGrant | null): NetworkRecord {
  if (!asked) return { network: 'none' };
  if (!g) return { network: 'none', detail: "asked for the network; the helper didn't say (it may have stopped before the command)" };
  if (!g.granted) return { network: 'none', detail: `asked for the network, not granted: ${g.why}`.slice(0, 300) };
  return { network: 'granted' };
}

/** The line a tier that asked for the network starts its check with. */
export function networkSummaryLine(r: NetworkRecord, instance: string, tier: string): string {
  if (r.network === 'granted') return 'Network: granted by root\'s policy (public addresses and the machine\'s DNS only)';
  return `Network: none (${r.detail ?? 'not asked'}). Only root grants it: ${networkCommands(instance).enable.replace('<tier>[,<tier>...]', tier)}`;
}
