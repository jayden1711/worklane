// Where a provider run may send its key and its prompts (#392). A provider's base_url comes from the repo's
// agents.yaml, which anyone who can change the default branch can edit; the run sends the provider's key and every
// prompt (the issue, and the repository content the agent reads) there. So the hosts it may name are the machine's
// root's to allow, in /etc/<cli>/providers.json, root:root, not writable by its group or others (docs/providers.md):
//
//   {"hosts": ["api.provider.example", "127.0.0.1:8080"]}
//
// A base_url must name one of those hosts exactly: the same host name or address, and the same port (an entry without
// a port is the scheme's default port). No wildcards. It must be https://, except to a loopback address (this
// machine), and carry no user, password, query or fragment. The URL's shape is checked by the config schema (a bad
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

/** Whether a URL's host is this machine's loopback: localhost, 127.0.0.0/8 or [::1] (WHATWG URL's normalised forms). */
export const isLoopbackHost = (hostname: string): boolean => hostname === 'localhost' || hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);

/**
 * Why `raw` can't be a provider's base_url, whatever the allowlist says; null when its shape is fine. http(s) only,
 * https except to loopback, no user or password, no query or fragment (a key in either would be a credential in the
 * repo). A path is allowed: some providers serve the Anthropic API under one.
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
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `must be https:// (or http:// to this machine), not ${u.protocol}`;
  // WHY: WHATWG URL drops an empty "user@" or ":@"; the raw authority is checked too, as for network.json's proxy.
  if (u.username || u.password || /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*@/.test(raw)) return 'must not carry a user or password';
  if (u.search || u.hash || raw.includes('?') || raw.includes('#')) return 'must not carry a query or fragment';
  if (!u.hostname) return 'has no host';
  if (u.protocol === 'http:' && !isLoopbackHost(u.hostname)) return `must be https:// (plain http:// only to this machine: localhost, 127.x.x.x or [::1]), not http://${u.host}`;
  return null;
}

/** One allowlist entry: host[:port], in the form WHATWG URL gives the host; or why it isn't one. */
function entryOf(raw: unknown): { host: string; port: string | null } | string {
  if (typeof raw !== 'string' || !raw) return 'each host must be a non-empty string';
  const show = JSON.stringify(raw.slice(0, 80));
  if (raw.length > PROVIDER_HOSTS_LIMITS.entry) return `host ${show} is longer than ${PROVIDER_HOSTS_LIMITS.entry} characters`;
  if (raw.includes('*')) return `host ${show}: no wildcards; name each host`;
  const m = /^(\[[0-9a-f:.]+\]|[^\s:/?#@[\]\\]+)(?::(\d{1,5}))?$/.exec(raw);
  if (!m) return `host ${show} must be host or host:port (no scheme, user, path or query)`;
  const [, host, port] = m as unknown as [string, string, string | undefined];
  let canonical: string;
  try {
    canonical = new URL(`https://${host}/`).hostname;
  } catch {
    return `host ${show} is not a host name or address`;
  }
  // WHY: matched exactly against what WHATWG URL makes of a base_url, so the entry must already be in that form.
  if (canonical !== host) return `host ${show} must be written as a URL normalises it: ${JSON.stringify(canonical)}`;
  if (port !== undefined && (String(Number(port)) !== port || Number(port) < 1 || Number(port) > 65535)) return `host ${show} has a bad port`;
  return { host, port: port ?? null };
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
  if (extra.length) return no(`unknown key ${JSON.stringify(extra[0])} (only "hosts")`);
  const list = (raw as { hosts?: unknown }).hosts;
  if (!Array.isArray(list)) return no('expected {"hosts": ["<host>", "<host>:<port>", ...]}');
  if (list.length > PROVIDER_HOSTS_LIMITS.hosts) return no(`more than ${PROVIDER_HOSTS_LIMITS.hosts} hosts`);
  for (const h of list) {
    const e = entryOf(h);
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
  const ok = h.hosts.some((raw) => {
    const e = entryOf(raw);
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

const logged = new Set<string>();

/** Says a provider's refusal on stderr, once per provider and reason in this process (each run still records its fallback). */
export function logRefusalOnce(label: string, reason: string, log: (line: string) => void = console.error): void {
  const key = `${label}\0${reason}`;
  if (logged.has(key)) return;
  logged.add(key);
  log(`provider ${label} refused: ${reason}`);
}
