// WHY (owner, on the plugin-fetch sudoers pattern): a plugin is fetched only from a host root allows, by name, over
// https, never from an address. The allowlist is root's (/etc/<cli>/plugin-hosts.json, root:root 0644, set by
// scripts/setup/plugins.sh hosts); absent, it is github.com alone. A URL must name exactly one of those hosts (WHATWG
// URL's hostname, compared whole: no suffix, user, port or look-alike passes), never an IP literal in any spelling; at
// fetch time the name must resolve only to public addresses, and git is pinned to the one that was checked
// (http.curloptResolve), with redirects off, so DNS can't swap the address after the check.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { readRegularFile } from '../os/index.js';
import { etcPath } from '../os/system-paths.js';

export const PLUGIN_HOSTS_FILE = () => etcPath('plugin-hosts.json');
export const DEFAULT_PLUGIN_HOSTS = ['github.com'] as const;
/** A DNS name as the allowlist holds it: lowercase labels, at least one dot, no IP literal. */
export const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * The hosts plugins may come from. No file: github.com alone. A file anyone but root owns, that others may write, or
 * that doesn't hold {"hosts": [<name>, ...]}: no host at all (fails closed), with why.
 */
export function readPluginHosts(file = PLUGIN_HOSTS_FILE(), ownerUid = 0): { hosts: string[]; problem: string | null } {
  const f = readRegularFile(file, 64 * 1024);
  if (f.kind === 'missing') return { hosts: [...DEFAULT_PLUGIN_HOSTS], problem: null };
  if (f.kind !== 'file') return { hosts: [], problem: `${file}: ${f.kind}` };
  if (f.uid !== ownerUid || Number.parseInt(f.mode, 8) & 0o022) return { hosts: [], problem: `${file} isn't root's alone` };
  try {
    const v = JSON.parse(f.text) as { hosts?: unknown };
    if (!Array.isArray(v.hosts) || !v.hosts.every((h) => typeof h === 'string' && HOST_NAME.test(h) && isIP(h) === 0)) return { hosts: [], problem: `${file}: expected {"hosts": [<host name>, ...]}` };
    return { hosts: v.hosts as string[], problem: null };
  } catch {
    return { hosts: [], problem: `${file}: not JSON` };
  }
}

/** Why `url` may not be fetched from, given the allowed hosts; null when it may. */
export function pluginUrlProblem(url: string, hosts: readonly string[]): string | null {
  if (!url.startsWith('https://')) return 'the source must start with https://';
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'the source is not a URL';
  }
  if (u.protocol !== 'https:') return 'the source must be https';
  if (u.username || u.password) return 'the source may not carry a user or password';
  if (u.port) return 'the source may not name a port';
  if (u.search || u.hash) return 'the source may not carry a query or fragment';
  const host = u.hostname;
  // WHATWG URL has already turned decimal, octal and hex IPv4 spellings into dotted form; IPv6 comes bracketed.
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0 || host.startsWith('[')) return `the source names an address (${host}), not a host`;
  if (!hosts.includes(host)) return `${host} is not a host plugins may come from (${hosts.join(', ') || 'none'}; root sets them with plugins.sh hosts)`;
  return null;
}

/** Whether an address is public: not loopback, private, link-local, CGNAT, ULA, multicast, reserved or unspecified. */
export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && ip.startsWith('192.0.0.')) || (b === 0 && ip.startsWith('192.0.2.')))) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && ip.startsWith('198.51.100.')))) return false;
    if (a === 203 && ip.startsWith('203.0.113.')) return false;
    return true;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]!);
    if (x === '::' || x === '::1') return false;
    const first = Number.parseInt(x.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 ULA
    if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return false; // multicast
    if (x.startsWith('64:ff9b:') || x.startsWith('2001:db8:') || x.startsWith('::ffff:') || x.startsWith('100::')) return false;
    return true;
  }
  return false;
}

/**
 * Resolve `host` once, refuse it unless every address it gives is public, and return the address git is pinned to.
 * `resolve` is a test seam (the system resolver otherwise).
 */
export async function pinnedAddress(host: string, resolve: (h: string) => Promise<{ address: string; family: number }[]> = (h) => lookup(h, { all: true, verbatim: true })): Promise<string> {
  const addrs = await resolve(host);
  if (!addrs.length) throw new Error(`${host} doesn't resolve`);
  const bad = addrs.filter((a) => !isPublicAddress(a.address));
  if (bad.length) throw new Error(`${host} resolves to an address that isn't public (${bad.map((a) => a.address).join(', ')}): refused`);
  return addrs[0]!.address;
}

/** git's pin for one host on https: http.curloptResolve's "host:443:address" (an IPv6 address in brackets). */
export const curlResolve = (host: string, ip: string) => `${host}:443:${isIP(ip) === 6 ? `[${ip}]` : ip}`;
