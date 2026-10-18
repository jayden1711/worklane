// Where a provider run may send its key and its prompts (#392). A provider's base_url comes from the repo's
// agents.yaml, which anyone who can change the default branch can edit; the run sends the provider's key and every
// prompt (the issue, and the repository content the agent reads) there. So the hosts it may name are the machine's
// root's to allow, in /etc/<cli>/providers.json, root:root, not writable by its group or others (docs/providers.md):
//
//   {"hosts": ["api.provider.example", "127.0.0.1:8080"]}
//
// A base_url must name one of those hosts exactly: the same host name or address, and the same port (an entry without
// a port is the scheme's default port). No wildcards. It must be https://, except to a loopback address (127.x.x.x or
// [::1]), carry no user, password, query or fragment, and be written as WHATWG URL normalises it, since that string is
// what claude gets. The URL's shape is checked by the config schema (a bad
// one is a config error); the host against root's list when the coordinator starts, when it resolves each provider
// run (src/coordinator/providers.ts: the run takes its fallback, the role's normal model), and again by the runner
// right before it sets ANTHROPIC_BASE_URL (src/runner.ts: a refused run doesn't start).
//
// INVARIANT: fails closed. No file, or a file that is refused (anyone but root owns it, its group or others may
// write it, a symlink, too big, not this shape), means no provider host at all: provider runs are off. Nothing reads
// the list from an environment, an instance's config, a project's config or a request.
import { readRegularFile } from './os/index.js';
import { etcPath } from './os/system-paths.js';
import { ownedProblem } from './network.js';

export const PROVIDER_HOSTS_FILE = etcPath('providers.json');

/** Bounds on the file and its values. */
export const PROVIDER_HOSTS_LIMITS = { fileBytes: 8192, hosts: 64, entry: 255, baseUrl: 2048 } as const;

/** Root's provider hosts as read now. `missing`: no file; `refused`: a file that can't be trusted or used, and why. */
export interface ProviderHosts {
  file: string;
  state: 'missing' | 'ok' | 'refused';
  /** host or host:port, as the file has them; empty unless `ok`. */
  hosts: string[];
  error: string | null;
}

/**
 * Whether a URL's host is a loopback address: 127.0.0.0/8 or [::1] (WHATWG URL's normalised forms). WHY: a literal
 * address, never a name such as localhost, so plain http staying on this machine doesn't rest on name resolution.
 */
export const isLoopbackHost = (hostname: string): boolean => hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);

/**
 * Why `raw` can't be a provider's base_url, whatever the allowlist says; null when its shape is fine. http(s) only,
 * https except to a loopback address, no user or password, no query or fragment (a key in either would be a
 * credential in the repo). A path is allowed: some providers serve the Anthropic API under one.
 *
 * INVARIANT: already in the form WHATWG URL normalises it to (its href, or that without the trailing / of an empty
 * path). The host is checked on the parsed URL, but the string itself becomes claude's ANTHROPIC_BASE_URL; a spelling
 * WHATWG rewrites (https:host, a backslash, %2E, a fullwidth dot, 0x7f.0.0.1, uppercase, :443) would rest on claude
 * parsing it the same way. A canonical one means the same host under any parser.
 */
export function baseUrlProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return 'must be a URL string';
  if (raw.length > PROVIDER_HOSTS_LIMITS.baseUrl) return `is longer than ${PROVIDER_HOSTS_LIMITS.baseUrl} characters`;
  if (/[\s\0-\x1f\x7f]/.test(raw)) return 'contains whitespace or a control character';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'is not a URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `must be https:// (or http:// to a loopback address), not ${u.protocol}`;
  // WHY: WHATWG URL drops an empty "user@" or ":@"; the raw authority is checked too, as for network.json's proxy.
  if (u.username || u.password || /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*@/.test(raw)) return 'must not carry a user or password';
  if (u.search || u.hash || raw.includes('?') || raw.includes('#')) return 'must not carry a query or fragment';
  if (!u.hostname) return 'has no host';
  if (u.protocol === 'http:' && !isLoopbackHost(u.hostname)) return `must be https:// (plain http:// only to a loopback address: 127.x.x.x or [::1]), not http://${u.host}`;
  if (raw !== u.href && `${raw}/` !== u.href) return `must be written as a URL normalises it: ${u.pathname === '/' ? u.href.slice(0, -1) : u.href}`;
  return null;
}

/** A host as WHATWG URL parsed it: made only by parsedHost, so a refusal can't be handed raw text in its place. */
export type ParsedHost = string & { readonly __parsedHost: true };
const parsedHost = (host: string): ParsedHost => new URL(`https://${host}/`).hostname as ParsedHost;

/** Every way an allowlist entry is refused. */
export const ENTRY_REFUSALS = ['not-a-string', 'too-long', 'wildcard', 'not-host-port', 'not-a-host', 'not-normalised', 'bad-port'] as const;
export type EntryRefusal = (typeof ENTRY_REFUSALS)[number];

/**
 * What a refusal of entry `at` (its position in "hosts", from 1) says.
 *
 * INVARIANT (#392): it is given the position, the kind and at most a host WHATWG URL parsed from the entry, never the
 * entry as written. That host is only letters, digits, dots and hyphens, or a bracketed address (providerHostEntry
 * refuses the rest), so it can't hold a user, password, query, fragment or `key=value` pair, however the entry encoded
 * them (`%40`, a fullwidth `＠`, `%26`, `＝`). It can still be a word root wrote as a host name, such as
 * `secret.example.com`: a refusal shows that host, lower-cased. The refusal reaches the start-up log and writers
 * on the Health page, and a mistyped entry (`user:secret@host`, `host?key=secret`, `user%3Asecret%40host`) may hold a
 * credential. As src/network.ts does for the proxy.
 */
function refusalText(at: number, why: EntryRefusal, host: ParsedHost | null): string {
  const name = `hosts entry ${at}`;
  const notShown = 'not shown, as it may hold a credential';
  switch (why) {
    case 'not-a-string': return `${name} must be a non-empty string`;
    case 'too-long': return `${name} is longer than ${PROVIDER_HOSTS_LIMITS.entry} characters`;
    case 'wildcard': return `${name}: no wildcards; name each host`;
    case 'not-host-port': return `${name} must be host or host:port (no scheme, user, path, query or fragment); ${notShown}`;
    case 'not-a-host': return `${name} is not a host name or address; ${notShown}`;
    case 'not-normalised': return `${name} must be written as a URL normalises it: ${JSON.stringify(host)}`;
    case 'bad-port': return `${name} (${JSON.stringify(host)}) has a bad port`;
  }
}

/** One allowlist entry: host[:port], in the form WHATWG URL gives the host; or how it is refused (with the host URL parsed from it, if any). */
export function providerHostEntry(raw: unknown): { host: string; port: string | null } | { refused: EntryRefusal; host: ParsedHost | null } {
  const no = (refused: EntryRefusal, host: ParsedHost | null = null) => ({ refused, host });
  if (typeof raw !== 'string' || !raw) return no('not-a-string');
  if (raw.length > PROVIDER_HOSTS_LIMITS.entry) return no('too-long');
  if (raw.includes('*')) return no('wildcard');
  const m = /^(\[[0-9a-f:.]+\]|[^\s:/?#@[\]\\]+)(?::(\d{1,5}))?$/.exec(raw);
  if (!m) return no('not-host-port');
  const [, host, port] = m as unknown as [string, string, string | undefined];
  let canonical: ParsedHost;
  try {
    canonical = parsedHost(host);
  } catch {
    return no('not-a-host');
  }
  // WHY: URL keeps punctuation such as `! $ & ; = , _ ~` in a host, decoding `%26`, `＆` and the like into it, so a
  // host it parsed can still be `key=secret`. Only a letters-digits-dots-hyphens name or a bracketed address goes on.
  // No `_`: no host name has one (RFC 1123), a public CA may not certify one (and a name is https only), but tokens
  // do (`ghp_…`, `sk_live_…`), and the not-normalised refusal would show one lower-cased.
  if (!/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)$/.test(canonical)) return no('not-a-host');
  // WHY: matched exactly against what WHATWG URL makes of a base_url, so the entry must already be in that form.
  if (canonical !== host) return no('not-normalised', canonical);
  if (port !== undefined && (String(Number(port)) !== port || Number(port) < 1 || Number(port) > 65535)) return no('bad-port', canonical);
  return { host, port: port ?? null };
}

/** providerHostEntry, with a refusal as its text (refusalText). */
function entryOf(raw: unknown, at: number): { host: string; port: string | null } | string {
  const e = providerHostEntry(raw);
  return 'refused' in e ? refusalText(at, e.refused, e.host) : e;
}

/**
 * Root's provider hosts. No file: none (`missing`, not an error). Refused (none, and why): a file anyone but root
 * (`ownerUid`, 0 except in tests) owns, that its group or others may write, a symlink, over the size bound, not
 * JSON, with a key other than "hosts", or a host that isn't host[:port] in URL form. On native Windows there is no
 * root-owned file to check, so no host either.
 */
export function readProviderHosts(file = PROVIDER_HOSTS_FILE, o: { ownerUid?: number } = {}): ProviderHosts {
  const no = (why: string): ProviderHosts => ({ file, state: 'refused', hosts: [], error: `${file}: ${why}; no provider host is allowed` });
  const f = readRegularFile(file, PROVIDER_HOSTS_LIMITS.fileBytes);
  if (f.kind === 'missing') return { file, state: 'missing', hosts: [], error: null };
  const owned = ownedProblem(f, o.ownerUid ?? 0, PROVIDER_HOSTS_LIMITS.fileBytes);
  if (owned || f.kind !== 'file') return no(owned ?? "can't be read");
  let raw: unknown;
  try {
    raw = JSON.parse(f.text);
  } catch {
    return no('is not JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return no('expected {"hosts": ["<host>", "<host>:<port>", ...]}');
  const extra = Object.keys(raw).filter((k) => k !== 'hosts');
  // WHY (#392): a key is quoted only when it is a plain word, which can't hold a user, password, query or fragment.
  if (extra.length) return no(/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(extra[0]!) ? `unknown key ${JSON.stringify(extra[0])} (only "hosts")` : 'an unknown key, not shown (only "hosts")');
  const list = (raw as { hosts?: unknown }).hosts;
  if (!Array.isArray(list)) return no('expected {"hosts": ["<host>", "<host>:<port>", ...]}');
  if (list.length > PROVIDER_HOSTS_LIMITS.hosts) return no(`more than ${PROVIDER_HOSTS_LIMITS.hosts} hosts`);
  for (const [i, h] of list.entries()) {
    const e = entryOf(h, i + 1);
    if (typeof e === 'string') return no(e);
  }
  return { file, state: 'ok', hosts: [...new Set(list as string[])], error: null };
}

/**
 * Where the engine reads root's provider hosts. INVARIANT: the real file, root's; only a test points this at another
 * file (with its own uid as the owner), in its own process. Nothing reads it from an environment or config.
 */
export const machineProviderHosts: { file: string; ownerUid: number } = { file: PROVIDER_HOSTS_FILE, ownerUid: 0 };

/** Root's provider hosts, read now: a change applies to the next provider run, no restart. */
export const machineProviderHostsConfig = (): ProviderHosts => readProviderHosts(machineProviderHosts.file, { ownerUid: machineProviderHosts.ownerUid });

/** Why a provider run may not go to `baseUrl` on this machine, or null when root allows its host. */
export function providerHostRefusal(baseUrl: string, h: ProviderHosts = machineProviderHostsConfig()): string | null {
  const shape = baseUrlProblem(baseUrl);
  if (shape) return `its base_url ${shape}`;
  if (h.state === 'missing') return `no provider host is allowed on this machine (${h.file} doesn't exist; root writes it, docs/providers.md)`;
  if (h.state === 'refused') return h.error!;
  const u = new URL(baseUrl);
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  const ok = h.hosts.some((raw, i) => {
    const e = entryOf(raw, i + 1);
    return typeof e !== 'string' && e.host === u.hostname && (e.port === null ? u.port === '' : e.port === port);
  });
  return ok ? null : `${u.host} is not an allowed provider host (${h.hosts.join(', ') || 'none'}, from ${h.file})`;
}

/** The providers agents.yaml configures that go through a base_url: `local` and each `hosted:<name>`. */
export function configuredProviders(agents: { providers?: { local?: { base_url: string } | undefined; hosted?: Record<string, { base_url: string }> | undefined } | undefined }): { label: string; baseUrl: string }[] {
  const p = agents.providers;
  return [...(p?.local ? [{ label: 'local', baseUrl: p.local.base_url }] : []), ...Object.entries(p?.hosted ?? {}).map(([name, c]) => ({ label: `hosted:${name}`, baseUrl: c.base_url }))];
}

/** What the coordinator says at start: root's provider hosts (or that there are none, and why), and each configured provider they refuse. */
export function providerHostsAtStart(agents: Parameters<typeof configuredProviders>[0], h: ProviderHosts = machineProviderHostsConfig()): string[] {
  const providers = configuredProviders(agents);
  if (h.state === 'missing' && !providers.length) return [];
  const head = h.state === 'refused' ? `${h.error}: provider runs are off` : h.state === 'missing' ? `no ${h.file}: no provider host is allowed, so provider runs are off (root writes it, docs/providers.md)` : `provider hosts: ${h.hosts.join(', ') || 'none, so provider runs are off'} (from ${h.file})`;
  const refused = providers.flatMap(({ label, baseUrl }) => {
    const why = h.state === 'ok' ? providerHostRefusal(baseUrl, h) : baseUrlProblem(baseUrl);
    return why ? [`provider ${label} refused: ${why}; its runs take the role's normal model`] : [];
  });
  return [head, ...refused];
}

/** The Health page's provider-hosts line: root's hosts as read now, and each configured provider they refuse. */
export interface ProviderHostsHealth extends ProviderHosts {
  /** Each configured provider whose base_url root's hosts don't allow (every one, when there are none), and why. */
  refused: { provider: string; reason: string }[];
}

/**
 * What the Health page shows (owners and writers only: src/dashboard.ts): the same facts as providerHostsAtStart,
 * read now. Null when there is no file and no provider is configured: nothing would use one.
 */
export function providerHostsHealth(agents: Parameters<typeof configuredProviders>[0], h: ProviderHosts = machineProviderHostsConfig()): ProviderHostsHealth | null {
  const providers = configuredProviders(agents);
  if (h.state === 'missing' && !providers.length) return null;
  const refused = providers.flatMap(({ label, baseUrl }) => {
    const shape = baseUrlProblem(baseUrl);
    const why = h.state === 'ok' ? providerHostRefusal(baseUrl, h) : shape ? `its base_url ${shape}` : 'no provider host is allowed on this machine';
    return why ? [{ provider: label, reason: why }] : [];
  });
  return { ...h, hosts: [...h.hosts], refused };
}

const logged = new Set<string>();

/** Says a provider's refusal on stderr, once per provider and reason in this process (each run still records its fallback). */
export function logRefusalOnce(label: string, reason: string, log: (line: string) => void = console.error): void {
  const key = `${label}\0${reason}`;
  if (logged.has(key)) return;
  logged.add(key);
  log(`provider ${label} refused: ${reason}`);
}
