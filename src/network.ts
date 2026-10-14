// Where the engine's children send credentials (#381 follow-up): to the hosts the claude and gh CLIs and git name
// themselves, directly, unless the machine's root sets an outbound proxy. Two parts:
//
// 1. outboundEnv() strips every variable that redirects a child's requests (a proxy, an endpoint, a provider switch,
//    a GitHub host or repo) from an environment the engine builds, in every casing, whatever set it: the inherited
//    environment, an instance config, agents.yaml, tests.yaml or a request.
// 2. It then sets the proxy variables from /etc/<cli>/network.json, and only from it: root:root, not writable by its
//    group or others, written by an admin (docs/network.md):
//
//      {"proxy": "http://proxy.internal:3128", "no_proxy": "localhost,127.0.0.1"}
//
//    The proxy is an http(s) URL with a host and nothing else: no user or password (a proxy login in a world-readable
//    file, and in every child's environment, would be a credential handed out), no path, query or fragment.
//
// INVARIANT: the proxy comes from that file only. Nothing reads a proxy from an environment, a project's config or a
// request; a refused file means no proxy (children go direct), never a fallback to the inherited one.
import { readFileSync } from 'node:fs';
import { BRAND } from './brand.js';
import { fileAccess } from './os/index.js';

export const NETWORK_FILE = `/etc/${BRAND.cli}/network.json`;

/** Bounds on the file and its values. */
export const NETWORK_LIMITS = { fileBytes: 4096, proxy: 512, noProxy: 1024 } as const;

/**
 * Variables that send a child's requests (and so its credentials) somewhere else. Matched by name, ignoring case
 * (curl reads lowercase http_proxy, Go and Node either; Windows names are case-insensitive).
 */
const REDIRECTS: RegExp[] = [
  // Proxies: curl/git, gh (Go), Node, claude. git's own proxy command.
  /^(?:HTTPS?|ALL|NO|FTP)_PROXY$/i,
  /^GIT_PROXY_COMMAND$/i,
  /^CLAUDE_CODE_PROXY_RESOLVES_HOSTS$/i,
  // claude's endpoints: ANTHROPIC_BASE_URL, ANTHROPIC_API_URL, ANTHROPIC_{BEDROCK,BEDROCK_MANTLE,AWS,VERTEX,FOUNDRY}_BASE_URL,
  // ANTHROPIC_FOUNDRY_RESOURCE (the Foundry host's name).
  /^ANTHROPIC_(?:[A-Z]+_)*(?:BASE_URL|API_URL|RESOURCE)$/i,
  // claude's provider switches (each sends prompts to another cloud), the host-managed routing switch, the IDE host.
  /^CLAUDE_CODE_(?:USE_(?:BEDROCK|VERTEX|FOUNDRY|MANTLE|ANTHROPIC_AWS)|PROVIDER_MANAGED_BY_HOST|IDE_HOST_OVERRIDE)$/i,
  // Telemetry and tracing endpoints claude exports to.
  /^BETA_TRACING_ENDPOINT$/i,
  /^OTEL_EXPORTER_OTLP(?:_[A-Z]+)*_ENDPOINT$/i,
  // gh: its host, a [HOST/]OWNER/REPO, and the GitHub API, server and GraphQL URL variables (Actions tooling).
  /^(?:GH|GITHUB)_(?:HOST|HOSTNAME|REPO|(?:[A-Z]+_)*URL)$/i,
];

/** Whether `name` is a variable that redirects where a child sends its requests. */
export const isRedirectVar = (name: string): boolean => REDIRECTS.some((r) => r.test(name));

/** The machine's outbound proxy, as network.json sets it. */
export interface MachineProxy {
  /** scheme://host[:port], as the children get it. */
  url: string;
  /** host[:port], for the Health page. */
  host: string;
  noProxy: string | null;
  file: string;
}

export interface NetworkConfig {
  proxy: MachineProxy | null;
  /** Why the file was refused; null when it's absent or fine. */
  error: string | null;
}

/** Why `raw` can't be the proxy URL, or null. */
export function proxyProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return 'proxy must be a URL string';
  if (raw.length > NETWORK_LIMITS.proxy) return `proxy is longer than ${NETWORK_LIMITS.proxy} characters`;
  if (/[\s\0]/.test(raw)) return 'proxy contains whitespace or a control character';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'proxy is not a URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `proxy must be http:// or https://, not ${u.protocol}`;
  // WHY: a proxy login in the file would be in every child's environment, and the file is world-readable.
  if (u.username || u.password || /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*@/.test(raw)) return 'proxy must not carry a user or password';
  if (!u.hostname) return 'proxy has no host';
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) return 'proxy must be scheme://host[:port] only (no path, query or fragment)';
  return null;
}

/** Why `raw` can't be the no_proxy list, or null. */
export function noProxyProblem(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'no_proxy must be a string';
  if (raw.length > NETWORK_LIMITS.noProxy) return `no_proxy is longer than ${NETWORK_LIMITS.noProxy} characters`;
  if (!/^[A-Za-z0-9.*:,\-[\] ]*$/.test(raw)) return 'no_proxy may hold host names, addresses, ports, "*" and commas only';
  return null;
}

/**
 * The machine's network settings. No file is no proxy, not an error. Refused (no proxy, and why): a file anyone but
 * root owns (`ownerUid`, 0 except in tests), one its group or others may write, one too big, not JSON, with an unknown
 * key, or with a bad or credentialed proxy.
 */
export function readNetworkConfig(file = NETWORK_FILE, o: { ownerUid?: number } = {}): NetworkConfig {
  const owner = o.ownerUid ?? 0;
  const no = (why: string): NetworkConfig => ({ proxy: null, error: `${file}: ${why}; no outbound proxy is set` });
  const a = fileAccess(file);
  if (a.kind === 'missing') return { proxy: null, error: null };
  // Root-owned files are a POSIX notion: a machine-level proxy isn't supported on native Windows.
  if (a.kind === 'unsupported') return { proxy: null, error: null };
  if (a.kind === 'hidden') return no("can't be read by this user (it should be root:root 0644)");
  if (a.uid !== owner) return no(`isn't root's (owner uid ${a.uid})`);
  if (Number.parseInt(a.mode, 8) & 0o022) return no(`is writable by its group or others (mode ${a.mode})`);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return no("can't be read");
  }
  if (Buffer.byteLength(text) > NETWORK_LIMITS.fileBytes) return no(`is over ${NETWORK_LIMITS.fileBytes} bytes`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return no('is not JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return no('expected {"proxy": "http://host:port", "no_proxy": "..."}');
  const r = raw as Record<string, unknown>;
  const extra = Object.keys(r).filter((k) => k !== 'proxy' && k !== 'no_proxy');
  if (extra.length) return no(`unknown key ${JSON.stringify(extra[0])} (only "proxy" and "no_proxy")`);
  if (r.proxy === undefined) return r.no_proxy === undefined ? { proxy: null, error: null } : no('no_proxy without a proxy');
  const p = proxyProblem(r.proxy);
  if (p) return no(p);
  const np = r.no_proxy === undefined ? null : noProxyProblem(r.no_proxy);
  if (np) return no(np);
  const u = new URL(r.proxy as string);
  const noProxy = typeof r.no_proxy === 'string' && r.no_proxy.trim() ? r.no_proxy.trim() : null;
  return { proxy: { url: `${u.protocol}//${u.host}`, host: u.host, noProxy, file }, error: null };
}

/**
 * Where the engine reads the machine's network settings. INVARIANT: the real file, root's; only a test points this
 * at another file (with its own uid as the owner), in its own process. Nothing reads it from an environment or config.
 */
export const machineNetwork: { file: string; ownerUid: number } = { file: NETWORK_FILE, ownerUid: 0 };

/** The machine's network settings, read now (a change applies to the next child, no restart). */
export const machineNetworkConfig = (): NetworkConfig => readNetworkConfig(machineNetwork.file, { ownerUid: machineNetwork.ownerUid });

/**
 * `env` without any redirecting variable (isRedirectVar), then with the machine's proxy, when root set one, in both
 * casings. The same object, for chaining.
 */
export function outboundEnv<T extends Record<string, string | undefined>>(env: T, proxy: MachineProxy | null = machineNetworkConfig().proxy): T {
  const e = env as Record<string, string | undefined>;
  for (const k of Object.keys(e)) if (isRedirectVar(k)) delete e[k];
  if (proxy) {
    for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) e[k] = proxy.url;
    if (proxy.noProxy) for (const k of ['NO_PROXY', 'no_proxy']) e[k] = proxy.noProxy;
  }
  return env;
}

/** The Health page's line: the proxy and its file, or why the file was refused; null when none is set. */
export function networkHealth(c: NetworkConfig = machineNetworkConfig()): { proxy: string | null; file: string; error: string | null } | null {
  if (c.proxy) return { proxy: c.proxy.host, file: c.proxy.file, error: null };
  if (c.error) return { proxy: null, file: machineNetwork.file, error: c.error };
  return null;
}
