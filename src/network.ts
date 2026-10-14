// Where the engine's children send credentials, and whom they trust (#381 follow-up, #391): the hosts the claude and
// gh CLIs and git name themselves, verified against their own trust stores, unless the machine's root says otherwise.
//
// 1. outboundEnv() strips every variable that redirects a child's requests (a proxy, an endpoint, a provider switch,
//    a GitHub host or repo) or changes what TLS it trusts (a CA bundle or directory, a client certificate, a switch
//    that loosens or turns off verification), from an environment the engine builds, in every casing, whatever set
//    it: the inherited environment, an instance config, agents.yaml, tests.yaml or a request. git config carried in
//    the environment (GIT_CONFIG_COUNT/KEY/VALUE) loses the same settings.
// 2. It then sets the proxy and a custom CA from /etc/<cli>/network.json, and only from it: root:root, not writable
//    by its group or others, written by an admin (docs/network.md):
//
//      {"proxy": "http://proxy.internal:3128", "no_proxy": "localhost,127.0.0.1", "ca_file": "/etc/<cli>/ca/corp.pem"}
//
//    The proxy is an http(s) URL with a host and nothing else: no user or password (a proxy login in a world-readable
//    file, and in every child's environment, would be a credential handed out), no path, query or fragment. The CA
//    file is root's too, in a directory only root may write, a regular file (never a symlink), bounded, and nothing
//    but PEM certificates that parse.
//
// INVARIANT: the proxy and the CA come from that file only. Nothing reads either from an environment, a project's
// config or a request; a refused file means neither (children go direct and trust their own stores), never a
// fallback to the inherited ones. Nothing here can turn TLS verification off: there is no such setting.
import { X509Certificate } from 'node:crypto';
import { dirname, posix } from 'node:path';
import { BRAND } from './brand.js';
import { fileAccess, readRegularFile } from './os/index.js';

export const NETWORK_FILE = `/etc/${BRAND.cli}/network.json`;

/** Bounds on the file and its values. */
export const NETWORK_LIMITS = { fileBytes: 4096, proxy: 512, noProxy: 1024, caPath: 256, caBytes: 256 * 1024, caCerts: 64 } as const;

/**
 * Variables that send a child's requests (and so its credentials) somewhere else, or change what it trusts. Matched by
 * name, ignoring case (curl reads lowercase http_proxy, Go and Node either; Windows names are case-insensitive).
 */
const REDIRECTS: RegExp[] = [
  // Proxies: curl/git, gh (Go), Node, claude. git's own proxy command, and its proxy auth method.
  /^(?:HTTPS?|ALL|NO|FTP)_PROXY$/i,
  /^GIT_PROXY_COMMAND$/i,
  /^GIT_HTTP_PROXY_AUTHMETHOD$/i,
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
  // TLS trust. Node and claude: an extra CA bundle, the system store switch, verification off. OpenSSL (curl, git,
  // Python, Node's OpenSSL config): its CA file and directory, its config (which can lower the security level).
  // Python requests and curl: their CA bundles. Go (gh): SSL_CERT_FILE/DIR, and GODEBUG (x509sha1 and the like).
  // libcurl/NSS: SSLKEYLOGFILE, which writes TLS session keys to a file (anyone who reads it decrypts the traffic).
  /^(?:NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_USE_SYSTEM_CA|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|OPENSSL_CONF|OPENSSL_CONF_INCLUDE|OPENSSL_MODULES|GODEBUG|SSLKEYLOGFILE)$/i,
  // git: every GIT_SSL_* and GIT_PROXY_SSL_* override (GIT_SSL_NO_VERIFY, _CAINFO, _CAPATH, _CERT, _KEY,
  // _CERT_PASSWORD_PROTECTED, _VERSION, _CIPHER_LIST, _PINNEDPUBKEY, and the proxy's), and `git -c` config passed to
  // child gits (GIT_CONFIG_PARAMETERS), which can carry http.sslVerify=false.
  /^GIT_(?:PROXY_)?SSL_[A-Z_]+$/i,
  /^GIT_CONFIG_PARAMETERS$/i,
  // claude: its CA sources (bundled/system), and a client certificate for mTLS.
  /^CLAUDE_CODE_(?:CERT_STORE|CLIENT_CERT|CLIENT_KEY|CLIENT_KEY_PASSPHRASE)$/i,
];

/** Whether `name` is a variable that redirects where a child sends its requests, or changes what TLS it trusts. */
export const isRedirectVar = (name: string): boolean => REDIRECTS.some((r) => r.test(name));

/**
 * git config keys that change where git connects or what it trusts: http.[<url>.]ssl*, proxy*, schannel*, pinnedPubkey,
 * curloptResolve; url.<base>.insteadOf and pushInsteadOf (another host for the same remote).
 */
const GIT_KEY = /^(?:http\.(?:.+\.)?(?:ssl[a-z]*|proxy[a-z]*|schannel[a-z]*|pinnedpubkey|curloptresolve)|url\..+\.(?:insteadof|pushinsteadof))$/i;
export const isRedirectGitKey = (key: string): boolean => GIT_KEY.test(key.trim());

/** Node flags that change what TLS trusts or how it verifies: NODE_OPTIONS carrying one is dropped whole. */
const NODE_TLS_FLAG = /(?:^|\s)--(?:use-openssl-ca|use-bundled-ca|use-system-ca|openssl-config|openssl-shared-config|openssl-legacy-provider|tls-[\w-]+|insecure-http-parser)\b/i;

/** The machine's outbound proxy, as network.json sets it. */
export interface MachineProxy {
  /** scheme://host[:port], as the children get it. */
  url: string;
  /** host[:port], for the Health page. */
  host: string;
  noProxy: string | null;
  file: string;
}

/** The machine's custom CA, as network.json names it. */
export interface MachineCa {
  path: string;
  /** How many certificates the file holds. */
  count: number;
  /** Each certificate's SHA-256 fingerprint, lowercase hex without separators. */
  fingerprints: string[];
}

export interface NetworkConfig {
  proxy: MachineProxy | null;
  ca: MachineCa | null;
  /** Why the file was refused; null when it's absent or fine. */
  error: string | null;
}

const NONE: NetworkConfig = { proxy: null, ca: null, error: null };

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

/** Why a file read by readRegularFile can't be trusted as root's, or null. */
function ownedProblem(r: ReturnType<typeof readRegularFile>, owner: number, maxBytes: number): string | null {
  switch (r.kind) {
    case 'missing':
      return "doesn't exist";
    case 'hidden':
      return "can't be read by this user (it should be root:root 0644)";
    case 'symlink':
      return 'is a symlink (it must be a regular file)';
    case 'not-file':
      return 'is not a regular file';
    case 'too-big':
      return `is over ${maxBytes} bytes`;
    case 'unsupported':
      return 'has no owner to check on this system';
    case 'file':
      if (r.uid !== owner) return `isn't root's (owner uid ${r.uid})`;
      if (Number.parseInt(r.mode, 8) & 0o022) return `is writable by its group or others (mode ${r.mode})`;
      return null;
  }
}

/** The CA file `raw` names, checked and parsed; or why it can't be used. */
export function readCaFile(raw: unknown, owner: number): { ca: MachineCa } | { error: string } {
  if (typeof raw !== 'string' || !raw) return { error: 'ca_file must be a path string' };
  if (raw.length > NETWORK_LIMITS.caPath) return { error: `ca_file is longer than ${NETWORK_LIMITS.caPath} characters` };
  if (!/^\/[A-Za-z0-9._/-]+$/.test(raw) || raw.split('/').some((s) => s === '..' || s === '.') || posix.normalize(raw) !== raw) return { error: 'ca_file must be an absolute, plain path (letters, digits, . _ - /; no . or .. parts)' };
  const f = readRegularFile(raw, NETWORK_LIMITS.caBytes);
  const owned = ownedProblem(f, owner, NETWORK_LIMITS.caBytes);
  if (owned || f.kind !== 'file') return { error: `ca_file ${raw} ${owned ?? "can't be read"}` };
  // WHY: a root-owned file in a directory someone else may write can be replaced by that someone.
  const dir = fileAccess(dirname(raw));
  if (dir.kind !== 'file') return { error: `ca_file's directory ${dirname(raw)} can't be checked` };
  if (dir.uid !== owner || Number.parseInt(dir.mode, 8) & 0o022) return { error: `ca_file's directory ${dirname(raw)} must be root's and not writable by its group or others (owner uid ${dir.uid}, mode ${dir.mode})` };
  const BLOCK = /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+?-----END CERTIFICATE-----/g;
  const blocks = f.text.match(BLOCK) ?? [];
  // INVARIANT: PEM certificates and whitespace only: no private key, no other PEM type, no stray text.
  if (f.text.replace(BLOCK, '').trim() !== '') return { error: `ca_file ${raw} holds something other than PEM certificates` };
  if (!blocks.length) return { error: `ca_file ${raw} holds no PEM certificate` };
  if (blocks.length > NETWORK_LIMITS.caCerts) return { error: `ca_file ${raw} holds more than ${NETWORK_LIMITS.caCerts} certificates` };
  const fingerprints: string[] = [];
  for (const [n, b] of blocks.entries()) {
    try {
      fingerprints.push(new X509Certificate(b).fingerprint256.replaceAll(':', '').toLowerCase());
    } catch {
      return { error: `ca_file ${raw}: certificate ${n + 1} doesn't parse` };
    }
  }
  return { ca: { path: raw, count: blocks.length, fingerprints } };
}

/**
 * The machine's network settings. No file is neither proxy nor CA, not an error. Refused (neither, and why): a file
 * anyone but root owns (`ownerUid`, 0 except in tests), one its group or others may write, a symlink, one too big,
 * not JSON, with an unknown key, a bad or credentialed proxy, or a CA file that fails readCaFile.
 */
export function readNetworkConfig(file = NETWORK_FILE, o: { ownerUid?: number } = {}): NetworkConfig {
  const owner = o.ownerUid ?? 0;
  const no = (why: string): NetworkConfig => ({ proxy: null, ca: null, error: `${file}: ${why}; no outbound proxy or custom CA is set` });
  const f = readRegularFile(file, NETWORK_LIMITS.fileBytes);
  if (f.kind === 'missing') return NONE;
  // Root-owned files are a POSIX notion: no machine-level proxy or CA on native Windows.
  if (f.kind === 'unsupported') return NONE;
  const owned = ownedProblem(f, owner, NETWORK_LIMITS.fileBytes);
  if (owned || f.kind !== 'file') return no(owned ?? "can't be read");
  let raw: unknown;
  try {
    raw = JSON.parse(f.text);
  } catch {
    return no('is not JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return no('expected {"proxy": "http://host:port", "no_proxy": "...", "ca_file": "/etc/.../ca.pem"}');
  const r = raw as Record<string, unknown>;
  const extra = Object.keys(r).filter((k) => k !== 'proxy' && k !== 'no_proxy' && k !== 'ca_file');
  if (extra.length) return no(`unknown key ${JSON.stringify(extra[0])} (only "proxy", "no_proxy" and "ca_file")`);
  if (r.proxy === undefined && r.no_proxy !== undefined) return no('no_proxy without a proxy');
  let proxy: MachineProxy | null = null;
  if (r.proxy !== undefined) {
    const p = proxyProblem(r.proxy);
    if (p) return no(p);
    const np = r.no_proxy === undefined ? null : noProxyProblem(r.no_proxy);
    if (np) return no(np);
    const u = new URL(r.proxy as string);
    const noProxy = typeof r.no_proxy === 'string' && r.no_proxy.trim() ? r.no_proxy.trim() : null;
    proxy = { url: `${u.protocol}//${u.host}`, host: u.host, noProxy, file };
  }
  let ca: MachineCa | null = null;
  if (r.ca_file !== undefined) {
    const c = readCaFile(r.ca_file, owner);
    if ('error' in c) return no(c.error);
    ca = c.ca;
  }
  return { proxy, ca, error: null };
}

/**
 * Where the engine reads the machine's network settings. INVARIANT: the real file, root's; only a test points this
 * at another file (with its own uid as the owner), in its own process. Nothing reads it from an environment or config.
 */
export const machineNetwork: { file: string; ownerUid: number } = { file: NETWORK_FILE, ownerUid: 0 };

/** The machine's network settings, read now (a change applies to the next child, no restart). */
export const machineNetworkConfig = (): NetworkConfig => readNetworkConfig(machineNetwork.file, { ownerUid: machineNetwork.ownerUid });

/** git config pairs in the environment (GIT_CONFIG_COUNT/KEY_n/VALUE_n) without any isRedirectGitKey key, renumbered. */
function withoutRedirectGitConfig(e: Record<string, string | undefined>): void {
  const raw = e.GIT_CONFIG_COUNT;
  if (raw === undefined) return;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 1000) return; // git itself refuses a bad count
  const pairs: [string, string][] = [];
  for (let i = 0; i < n; i++) {
    const k = e[`GIT_CONFIG_KEY_${i}`];
    const v = e[`GIT_CONFIG_VALUE_${i}`];
    delete e[`GIT_CONFIG_KEY_${i}`];
    delete e[`GIT_CONFIG_VALUE_${i}`];
    if (k !== undefined && !isRedirectGitKey(k)) pairs.push([k, v ?? '']);
  }
  e.GIT_CONFIG_COUNT = String(pairs.length);
  pairs.forEach(([k, v], i) => {
    e[`GIT_CONFIG_KEY_${i}`] = k;
    e[`GIT_CONFIG_VALUE_${i}`] = v;
  });
}

/** The variables a valid custom CA sets: Node and claude add it to their bundle; Go (gh) and git read it as their CA file. */
export const CA_VARS = ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'GIT_SSL_CAINFO'] as const;

/**
 * `env` without any redirecting or trust-changing variable (isRedirectVar), git config key (isRedirectGitKey) or Node
 * TLS flag, then with the machine's proxy (both casings) and custom CA, when root set them. The same object.
 */
export function outboundEnv<T extends Record<string, string | undefined>>(env: T, net: Pick<NetworkConfig, 'proxy' | 'ca'> | null = machineNetworkConfig()): T {
  const e = env as Record<string, string | undefined>;
  for (const k of Object.keys(e)) {
    if (isRedirectVar(k)) delete e[k];
    else if (k.toUpperCase() === 'NODE_OPTIONS' && NODE_TLS_FLAG.test(e[k] ?? '')) delete e[k];
  }
  withoutRedirectGitConfig(e);
  const proxy = net?.proxy;
  if (proxy) {
    for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) e[k] = proxy.url;
    if (proxy.noProxy) for (const k of ['NO_PROXY', 'no_proxy']) e[k] = proxy.noProxy;
  }
  if (net?.ca) for (const k of CA_VARS) e[k] = net.ca.path;
  return env;
}

/** What the Health page shows: the proxy and the CA from root's file, or why the file was refused; null when neither is set. */
export interface NetworkHealth {
  proxy: string | null;
  file: string;
  ca: { path: string; count: number; fingerprints: string[] } | null;
  error: string | null;
}

export function networkHealth(c: NetworkConfig = machineNetworkConfig()): NetworkHealth | null {
  if (c.error) return { proxy: null, file: machineNetwork.file, ca: null, error: c.error };
  if (!c.proxy && !c.ca) return null;
  // Short fingerprints: the first 16 hex digits (64 bits) of each certificate's SHA-256.
  return { proxy: c.proxy?.host ?? null, file: machineNetwork.file, ca: c.ca ? { path: c.ca.path, count: c.ca.count, fingerprints: c.ca.fingerprints.map((f) => f.slice(0, 16)) } : null, error: null };
}
