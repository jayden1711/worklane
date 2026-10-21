// Where a test run's steps happen: its workspace, its database, its commands and its wipe.
//
// The sandbox host (production, Linux) does each through the root-owned helper (scripts/machine/<cli>-testrun.sh,
// installed by scripts/setup/test-user.sh), which sudo lets the instance's coordinator run for its own test user
// only: the workspace, the commands and the database all belong to that user, in the test runs' slice, and the
// commands run sandboxed. The local host does the same steps as the current user in a directory of its own, with
// no sandbox: for the engine's tests and for development, never for a project's PRs (the coordinator refuses it).
import { spawn } from '../os/child-process.js';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { BRAND } from '../brand.js';
import { killTree, shellCommand, spawnDetached } from '../os/index.js';
import { ownEnv } from '../os/own-env.js';
import { SPARSE_MAX, sparseDirProblem } from '../checkout.js';
import { MAX_CONNECTIONS, PINNED_IMAGE } from './config.js';
import { HELPER_PROTOCOL } from './helper.js';
import { cloneScript } from './workspace.js';
import { gpuLine, type GpuGrant } from './gpu.js';
import { networkLine, NETWORK_TIER, type NetworkGrant } from './network.js';
import { FETCH_CACHE_ENV, fetchScript, MAX_REQUIREMENTS, requirementsFileProblem, type Fetcher } from './fetch.js';
import { libexecPath } from '../os/system-paths.js';

export const SANDBOX_HELPER = libexecPath('testrun');
/** The label on every container a run starts: wipe removes whatever carries its run's. */
export const RUN_LABEL = `${BRAND.cli}.test-run`;

export interface ExecResult {
  /** null: it timed out or was cancelled. */
  code: number | null;
  out: string;
  /** What the command used, where the host can tell (the sandbox's unit reports it). */
  stats?: SystemdRunStats;
  /** Its stderr alone (the sandbox's systemd-run lines taken out): what a failed setup step's check shows. */
  err?: string;
  /**
   * It was stopped at its own timeout: the sandbox's unit at its RuntimeMaxSec (systemd-run's "Finished with result:
   * timeout"; its exit code is then non-zero, not null), or the host's own timer. Never for a cancellation.
   */
  timedOut?: boolean;
  /** The sandbox unit's result as systemd-run's summary gives it ("success", "exit-code", "timeout", "signal", ...). */
  unitResult?: string | null;
  /** Only for a command that asked for the GPU: what the helper granted (./gpu.ts), or null when it said nothing. */
  gpu?: GpuGrant | null;
  /** Only for a command that asked for the network: what the helper granted (./network.ts), or null when it said nothing. */
  network?: NetworkGrant | null;
}

/** What a command asks of its host besides its environment. */
export interface ExecOptions {
  /** Ask for the GPU (a tier's `gpu: true`): granted only as root's file says (./gpu.ts). */
  gpu?: boolean;
  /**
   * Ask for the network for this tier (a tier's `network: true`, or "setup" for the setup steps): granted only when
   * root's file lists that tier for this instance (./network.ts). Absent: the command has no network.
   */
  network?: string;
}

/**
 * A setup step of a run (its workspace, a cache, its database) failed. `step` names it; `stderr` is the end of what
 * the helper or tool said on stderr, never its stdout (db-start prints the database's password there on success).
 */
export class SetupStepError extends Error {
  constructor(
    readonly step: string,
    /** What failed and its exit, in a line (the message adds the stderr's last lines). */
    readonly what: string,
    readonly stderr: string,
  ) {
    super(stderr.trim() ? `${what}: ${stderr.trim().split('\n').slice(-5).join(' | ').slice(0, 800)}` : what);
  }
}

// systemd's format_timespan suffixes (src/basic/time-util.c), in seconds; a month and a year as systemd counts them.
const TIMESPAN: Record<string, number> = { y: 31_557_600, month: 2_629_800, w: 604_800, d: 86_400, h: 3600, min: 60, s: 1, ms: 1e-3, us: 1e-6, '\u00b5s': 1e-6, '\u03bcs': 1e-6 };
// format_bytes's IEC suffixes (src/basic/format-util.c), in MiB.
const BYTES: Record<string, number> = { K: 1 / 1024, M: 1, G: 1024, T: 1024 ** 2, P: 1024 ** 3, E: 1024 ** 4 };

/** Seconds from systemd's format_timespan: "0", "44ms", "1.234s", "1min 2.345s", "2h 3min 4s". null: not that format. */
export function parseTimespan(s: string): number | null {
  if (s === '0') return 0;
  let total = 0;
  for (const part of s.split(' ')) {
    const m = /^(\d+(?:\.\d+)?)(y|month|w|d|h|min|s|ms|us|\u00b5s|\u03bcs)$/.exec(part);
    if (!m) return null;
    total += Number(m[1]) * TIMESPAN[m[2]!]!;
  }
  return total;
}

/** MiB from systemd's format_bytes (IEC, one digit below the point, a trailing B below 1K): "0B", "512B", "256.0K", "1.5G". */
export function parseBytes(s: string): number | null {
  const b = /^(\d+)B$/.exec(s);
  if (b) return Number(b[1]) / 1048576;
  const m = /^(\d+\.\d)([KMGTPE])$/.exec(s);
  return m ? Number(m[1]) * BYTES[m[2]!]! : null;
}

// systemd-run --wait's summary (src/run/run.c), each line in its own exact format, in the order it prints them.
const SUMMARY_LINE: Array<[string, RegExp]> = [
  ['result', /^Finished with result: ([a-z-]+)$/],
  ['main', /^Main processes terminated with: code=[a-z]+\/status=[A-Za-z0-9+-]+$/],
  ['runtime', /^Service runtime: (.+)$/],
  ['cpu', /^CPU time consumed: (.+)$/],
  ['mem', /^Memory peak: (.+)$/],
  ['swap', /^Memory swap peak: (.+)$/],
  ['ipin', /^IP traffic received: (.+)$/],
  ['ipout', /^IP traffic sent: (.+)$/],
  ['ioread', /^IO bytes read: (.+)$/],
  ['iowrite', /^IO bytes written: (.+)$/],
];
const TIMESPAN_LINES = new Set(['runtime', 'cpu']);

/** The summary at the very end of systemd-run's stderr, line by line; null unless every line is one of its own, in order. */
function summary(tail: string): Map<string, string> | null {
  const lines = tail.endsWith('\n') ? tail.slice(0, -1).split('\n') : tail.split('\n');
  const got = new Map<string, string>();
  let next = 0;
  for (const line of lines) {
    let i = next;
    while (i < SUMMARY_LINE.length && !SUMMARY_LINE[i]![1].test(line)) i++;
    if (i === SUMMARY_LINE.length) return null;
    const [key, re] = SUMMARY_LINE[i]!;
    const value = re.exec(line)![1] ?? '';
    if (TIMESPAN_LINES.has(key) ? parseTimespan(value) === null : key !== 'result' && key !== 'main' && parseBytes(value) === null) return null;
    got.set(key, value);
    next = i + 1;
  }
  return got.has('result') ? got : null;
}

export interface SystemdRunStats {
  cpuS: number | null;
  memPeakMb: number | null;
}

/** A run's variables as the sandbox helper's exec reads them on stdin: NAME=value, each ended by a NUL. */
export function runVars(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`not a variable name: ${k}`);
      if (v.includes('\0') || v.includes('\n')) throw new Error(`${k}: one line, no NUL`);
      return `${k}=${v}\0`;
    })
    .join('');
}

/**
 * systemd-run --wait's own lines in its stderr (not --quiet; the run's stderr is the same stream under --pipe):
 * "Running as unit: <unit>" near the start (with "; invocation ID: <id>" on some systemd 255 builds, not others), and its summary (result, CPU time, peak memory, ...)
 * at the very end, after the unit has stopped, so nothing a run prints can come after it. Only that final block is
 * read: a run's own "Memory peak: 999G" line is part of its output, never a stat. `own`: the [start, end) ranges of
 * `stderr` that are systemd-run's.
 */
export function systemdRunStats(stderr: string): { stats: SystemdRunStats; own: Array<[number, number]>; result: string | null } {
  const own: Array<[number, number]> = [];
  const stats: SystemdRunStats = { cpuS: null, memPeakMb: null };
  // The unit's result ("success", "exit-code", "timeout", ...), from that final block only.
  let result: string | null = null;
  // The unit's name: <cli>-test-<name>_<id>_<pid> (protocol 9), or <cli>-test-<name>-<id>-<pid> from a helper before it.
  const unit = new RegExp(`(?:^|\n)(Running as unit: ${BRAND.cli}-test-[a-z0-9_-]+\\.service(?:; invocation ID: [0-9a-f]{32})?\n)`).exec(stderr);
  if (unit) own.push([unit.index + unit[0].length - unit[1]!.length, unit.index + unit[0].length]);
  // The last "Finished with result: " whose rest is all summary; the line may follow a run's last unended line.
  for (let at = stderr.lastIndexOf('Finished with result: '); at >= 0; at = at === 0 ? -1 : stderr.lastIndexOf('Finished with result: ', at - 1)) {
    const s = summary(stderr.slice(at));
    if (!s) continue;
    if (!own.length || own[0]![1] <= at) own.push([at, stderr.length]);
    const cpu = s.get('cpu');
    const mem = s.get('mem');
    if (cpu !== undefined) stats.cpuS = Math.round(parseTimespan(cpu)! * 10) / 10;
    if (mem !== undefined) stats.memPeakMb = Math.round(parseBytes(mem)! * 10) / 10;
    result = s.get('result') ?? null;
    break;
  }
  return { stats, own, result };
}

/** What a run's Postgres is started with (test_run.database). */
export interface RunDbSpec {
  image: string;
  name: string;
  readyS: number;
  /** Postgres's max_connections (`-c max_connections=<n>`), within MAX_CONNECTIONS. */
  maxConnections: number;
}

export interface RunDatabase {
  url: string;
  /** The sandbox's: the directory of the database's Unix socket (it has no network, so no port). */
  socketDir?: string;
  /** The local host's: its port on 127.0.0.1. */
  port?: number;
  container: string;
}

export interface BundleRefs {
  branch: string;
  head: string;
  base: string;
  /** The commit to check out and the default branch's tip, in full (the bundle may carry neither: the store has them). */
  headSha: string;
  baseSha: string;
  /** Directories left out of the checkout (tests.yaml checkout.sparse_exclude); none for a full one. */
  exclude: readonly string[];
}

const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function checkRefs(id: string, r: BundleRefs): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(r.branch) || r.branch.includes('..')) throw new Error(`not a branch name: ${r.branch}`);
  if (r.head !== `refs/${BRAND.cli}/test-run/${id}/head` || r.base !== `refs/${BRAND.cli}/test-run/${id}/base`) throw new Error(`not run ${id}'s bundle refs`);
  if (!FULL_SHA.test(r.headSha) || !FULL_SHA.test(r.baseSha)) throw new Error(`not full commit ids: ${r.headSha} ${r.baseSha}`);
  if (r.exclude.length > SPARSE_MAX) throw new Error(`at most ${SPARSE_MAX} directories left out`);
  for (const d of r.exclude) {
    const why = sparseDirProblem(d);
    if (why) throw new Error(`${d}: ${why}`);
  }
}

/** The store's tips as the helper prints them: one full commit id a line, nothing else. */
function parseTips(out: string): string[] {
  return out.split('\n').map((l) => l.trim()).filter((l) => FULL_SHA.test(l));
}

/**
 * The sandbox check's result. `unsupported`: this machine can't give a run a user namespace of its own (its unshare
 * is older than util-linux 2.38, or there's no setpriv), with the fix. INVARIANT: only shown (doctor, the Machine page,
 * health); `ok` never depends on it, and nothing that turns test runs off or rolls an update back reads it.
 */
export interface SandboxCheck {
  ok: boolean;
  detail: string;
  unsupported?: string;
}

/** The sandbox helper's check's `NOTE userns-unsupported: <why and fix>` line, or null. */
export function usernsUnsupported(stdout: string): string | null {
  const m = /^NOTE userns-unsupported: (.+)$/m.exec(stdout);
  return m ? m[1]!.trim().slice(0, 500) : null;
}

export interface RunHost {
  readonly kind: 'sandbox' | 'local';
  /**
   * A new run's workspace (./workspace.ts): the store takes what the bundle stream carries (the commit as `refs.head`,
   * the default branch as `refs.base`, either or both left out when the store has it), then a repo of the run's own
   * reads the store, with `refs.headSha` checked out (leaving `refs.exclude` out) and `refs.baseSha` as `refs.branch`
   * and origin/`refs.branch`.
   */
  create(id: string, bundle: Readable, refs: BundleRefs): Promise<{ workdir: string }>;
  /** The commits the instance's object store keeps (its tips), so a bundle can leave out what they reach. */
  storeTips(): Promise<string[]>;
  /** The change's paths, one per line, in a file of the run's (for {changed_files}). */
  changedFiles(id: string, files: readonly string[]): Promise<string>;
  /** A cache's directory for this key (made if new). */
  cache(name: string, key: string): Promise<string>;
  /** A directory every run of the instance shares (e.g. a test-port registry); no wipe removes it. */
  shared(name: string): Promise<string>;
  /** The run's own Postgres: a unique container, reached on its Unix socket (the sandbox's has no network). */
  startDb(id: string, db: RunDbSpec): Promise<RunDatabase>;
  /**
   * The fetch phase (./fetch.ts): what the run's lockfile pins (pip: its requirements `files`), downloaded into cache
   * `cache` (key `key`) with network, running none of the repo's code. Its output and exit as a setup step's.
   */
  fetch(id: string, fetcher: Fetcher, cache: string, key: string, timeoutMs: number, signal?: AbortSignal, files?: readonly string[]): Promise<ExecResult>;
  /**
   * Run a command in the workspace with exactly `env` (and the host's fixed PATH, HOME, TMPDIR, CI). With `o.gpu`, the
   * sandbox helper may grant the GPU; a wait for it counts against `timeoutMs`.
   */
  exec(id: string, command: string, env: Record<string, string>, timeoutMs: number, signal?: AbortSignal, o?: ExecOptions): Promise<ExecResult>;
  /** The sandbox's own boundary check; a check that can't run is not ok. */
  check(): Promise<SandboxCheck>;
  /** Remove everything of the run: its processes, containers, volumes and files. `left`: what is still there. */
  wipe(id: string): Promise<{ ok: boolean; left: string[] }>;
  /** The helper's protocol version (./helper.ts); null when it has none or couldn't be asked, with its stderr. */
  helperVersion(): Promise<{ version: number | null; stderr: string }>;
}

export const RUN_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
function checkId(id: string): void {
  if (!RUN_ID.test(id)) throw new Error(`not a run id: ${id}`);
}

/** A fetcher and its arguments as the helper takes them: npm none, pip 1 to MAX_REQUIREMENTS requirements files. */
function checkFetch(fetcher: Fetcher, files: readonly string[]): void {
  if (fetcher !== 'npm' && fetcher !== 'pip') throw new Error(`no fetch for ${String(fetcher)}`);
  if (fetcher === 'npm' ? files.length !== 0 : files.length < 1 || files.length > MAX_REQUIREMENTS) throw new Error(`fetch ${fetcher}: ${files.length} requirements files`);
  for (const f of files) {
    const why = requirementsFileProblem(f);
    if (why) throw new Error(`not a requirements file: ${f} (${why})`);
  }
}

/** A new run id: the kind, the commit, and enough randomness that two runs of one commit never share one. */
export function newRunId(kind: 'fast' | 'full', sha: string): string {
  return `${kind}-${sha.slice(0, 10)}-${randomBytes(4).toString('hex')}`;
}

function checkName(name: string): void {
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(name)) throw new Error(`not a directory name: ${name}`);
}

const OUT_CAP = 8_000_000;

/** A finished process: its output merged in arrival order, and each stream on its own. */
interface Ran extends ExecResult {
  stdout: string;
  stderr: string;
  /** The merged output without these [start, end) ranges of `stderr`. */
  without(ranges: ReadonlyArray<readonly [number, number]>): string;
}

/** Spawn and collect output, killed at the timeout or on abort (code null then). */
function run(file: string, args: string[], o: { env?: NodeJS.ProcessEnv; cwd?: string; stdin?: Readable | string; timeoutMs?: number; signal?: AbortSignal | undefined }): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], detached: spawnDetached });
    // Each piece in arrival order, tagged with its stream, so either stream can be read alone and the merged
    // output rebuilt without some of one's text. Past the cap the oldest pieces go.
    const pieces: { err: boolean; text: string }[] = [];
    let size = 0;
    let killed = false;
    const take = (err: boolean) => (text: string) => {
      pieces.push({ err, text });
      size += text.length;
      while (size > OUT_CAP && pieces.length > 1) size -= pieces.shift()!.text.length;
    };
    child.stdout.setEncoding('utf8').on('data', take(false));
    child.stderr.setEncoding('utf8').on('data', take(true));
    const kill = () => {
      killed = true;
      killTree(child.pid, () => child.kill('SIGKILL'));
    };
    const timer = o.timeoutMs ? setTimeout(kill, o.timeoutMs) : undefined;
    o.signal?.addEventListener('abort', kill, { once: true });
    if (o.signal?.aborted) kill();
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      o.signal?.removeEventListener('abort', kill);
      const stream = (err: boolean) => pieces.filter((p) => p.err === err).map((p) => p.text).join('');
      const without = (ranges: ReadonlyArray<readonly [number, number]>) => {
        let at = 0;
        let merged = '';
        for (const p of pieces) {
          if (!p.err) {
            merged += p.text;
            continue;
          }
          const end = at + p.text.length;
          let from = at;
          for (const [s, e] of [...ranges].sort((x, y) => x[0] - y[0])) {
            if (e <= from || s >= end) continue;
            if (s > from) merged += p.text.slice(from - at, s - at);
            from = Math.max(from, Math.min(e, end));
          }
          merged += p.text.slice(from - at);
          at = end;
        }
        return merged;
      };
      resolve({ code: killed ? null : code, out: without([]), stdout: stream(false), stderr: stream(true), without });
    };
    child.on('error', (e) => {
      pieces.push({ err: true, text: `\n${e.message}` });
      finish(127);
    });
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => {});
    if (typeof o.stdin === 'string') child.stdin.end(o.stdin);
    else if (o.stdin) o.stdin.pipe(child.stdin);
    else child.stdin.end();
  });
}

/** The last lines of a text, at most `lines` of them. */
const lastLines = (text: string, lines: number) => text.trim().split('\n').slice(-lines).join('\n');

/** A step that failed: its stderr only, never its stdout (db-start prints the password there). */
const fail = (step: string, what: string, r: Ran) => {
  return new SetupStepError(step, `${what} failed (exit ${r.code ?? 'killed'})`, lastLines(r.stderr, 20));
};

/** A text without these [start, end) ranges. */
function cut(text: string, ranges: ReadonlyArray<readonly [number, number]>): string {
  let out = '';
  let at = 0;
  for (const [s, e] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (s > at) out += text.slice(at, s);
    at = Math.max(at, e);
  }
  return out + text.slice(at);
}

function postgresUrl(port: number, password: string, db: string): string {
  return `postgres://postgres:${password}@127.0.0.1:${port}/${db}`;
}

/**
 * The URL of a database reached on its Unix socket: libpq, node-postgres and Prisma all take the socket's directory
 * as the `host` parameter (the socket is <dir>/.s.PGSQL.5432).
 */
export function postgresSocketUrl(dir: string, password: string, db: string): string {
  if (!/^\/[A-Za-z0-9._/-]{1,200}$/.test(dir) || dir.includes('..')) throw new Error(`not a socket directory: ${dir}`);
  return `postgres://postgres:${password}@localhost/${db}?host=${dir}`;
}

function checkDb(db: RunDbSpec): void {
  if (!PINNED_IMAGE.test(db.image)) throw new Error(`the database image must be pinned to its digest: ${db.image}`);
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(db.name)) throw new Error(`not a database name: ${db.name}`);
  const n = db.maxConnections;
  if (!Number.isInteger(n) || n < MAX_CONNECTIONS.min || n > MAX_CONNECTIONS.max) throw new Error(`max_connections: ${MAX_CONNECTIONS.min} to ${MAX_CONNECTIONS.max}, got ${n}`);
}

/** The production host: every step through the sandbox helper, for instance `instance`'s test user. */
export function sandboxHost(instance: string, helper = SANDBOX_HELPER, sudo = 'sudo'): RunHost {
  if (!/^[a-z][a-z0-9-]{0,20}$/.test(instance)) throw new Error(`not an instance name: ${instance}`);
  const call = (args: string[], o: Parameters<typeof run>[2] = {}) => run(sudo, ['-n', helper, instance, ...args], { env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, ...o });
  // What the helper prints for the coordinator is on its stdout; its own and git's messages are on stderr.
  const lastLine = (r: Ran) => r.stdout.trim().split('\n').pop() ?? '';
  return {
    kind: 'sandbox',
    async create(id, bundle, refs) {
      checkId(id);
      checkRefs(id, refs);
      const r = await call(['create', id, refs.branch, refs.head, refs.base, refs.headSha, refs.baseSha, ...refs.exclude], { stdin: bundle, timeoutMs: 600_000 });
      if (r.code !== 0) throw fail('create', `creating run ${id}'s workspace`, r);
      return { workdir: lastLine(r) };
    },
    async storeTips() {
      const r = await call(['store-tips'], { timeoutMs: 60_000 });
      if (r.code !== 0) throw fail('store-tips', 'reading the object store', r);
      return parseTips(r.stdout);
    },
    async changedFiles(id, files) {
      checkId(id);
      const r = await call(['file', id, 'changed-files'], { stdin: files.map((f) => `${f}\n`).join(''), timeoutMs: 60_000 });
      if (r.code !== 0) throw fail('changed-files', `writing run ${id}'s changed files`, r);
      return lastLine(r);
    },
    async cache(name, key) {
      const r = await call(['cache', name, key], { timeoutMs: 60_000 });
      if (r.code !== 0) throw fail('caches', `the ${name} cache`, r);
      return lastLine(r);
    },
    async shared(name) {
      checkName(name);
      const r = await call(['shared', name], { timeoutMs: 60_000 });
      if (r.code !== 0) throw fail('shared', `the shared directory ${name}`, r);
      return lastLine(r);
    },
    async startDb(id, db) {
      checkId(id);
      checkDb(db);
      const r = await call(['db-start', id, db.image, db.name, String(db.readyS), String(db.maxConnections)], { timeoutMs: (db.readyS + 300) * 1000 });
      const m = /^(\/[A-Za-z0-9._/-]{1,200}) ([0-9a-f]{32})$/.exec(lastLine(r));
      if (r.code !== 0 || !m) throw fail('db-start', `starting run ${id}'s database`, r);
      return { url: postgresSocketUrl(m[1]!, m[2]!, db.name), socketDir: m[1]!, container: `${BRAND.cli}-test-${instance}-${id}` };
    },
    async fetch(id, fetcher, cache, key, timeoutMs, signal, files = []) {
      checkId(id);
      checkFetch(fetcher, files);
      if (!/^[a-z][a-z0-9_-]{0,39}$/.test(cache) || !/^[0-9a-f]{16,64}$/.test(key)) throw new Error(`not a cache: ${cache} ${key}`);
      const r = await call(['fetch', id, fetcher, cache, key, String(Math.max(1, Math.ceil(timeoutMs / 1000))), ...files], { timeoutMs: timeoutMs + 60_000, signal });
      const line = new RegExp(`^${BRAND.cli}-testrun: fetch ${fetcher} \\([^\\n]*\\)\\n`).exec(r.stderr);
      const s = systemdRunStats(r.stderr);
      const own: Array<[number, number]> = [...(line ? [[0, line[0].length] as [number, number]] : []), ...s.own];
      const timedOut = s.result === 'timeout' || (r.code === null && !signal?.aborted);
      return { code: r.code, out: r.without(own), stats: s.stats, err: cut(r.stderr, own), timedOut, unitResult: s.result };
    },
    async exec(id, command, env, timeoutMs, signal, o = {}) {
      checkId(id);
      if (o.network !== undefined && !NETWORK_TIER.test(o.network)) throw new Error(`not a tier name: ${o.network}`);
      // INVARIANT: no variable's value is ever in an argv. sudo logs its whole command line to the journal and any
      // user can read a process's argv (ps, /proc/<pid>/cmdline); DATABASE_URL carries the run's database password.
      // The run's variables go on stdin, each NAME=value ended by a NUL (no value can hold one).
      const vars = runVars(env);
      // The helper's unit ends at its RuntimeMaxSec; this timer is the backstop (a wipe stops whatever is left). A GPU
      // command's wait for its GPU counts against the same timeout (the helper gives the unit only what is left), so
      // the backstop covers the wait too.
      const r = await call(['exec', id, String(Math.max(1, Math.ceil(timeoutMs / 1000))), ...(o.gpu ? ['--gpu'] : []), ...(o.network !== undefined ? ['--network', o.network] : []), '--', command], { stdin: vars, timeoutMs: timeoutMs + 60_000, signal });
      // systemd-run's lines are in the stderr the run shares with it: taken out, and its summary read from there only.
      // So are the helper's GPU line, the first of all when the command asked for the GPU, and its network line next.
      const s = systemdRunStats(r.stderr);
      const g = o.gpu ? gpuLine(r.stderr) : { grant: null, own: [] };
      const n = o.network !== undefined ? networkLine(r.stderr, g.own.length ? g.own[0]![1] : 0) : { grant: null, own: [] };
      const own = [...g.own, ...n.own, ...s.own];
      // A GPU still held at the run's timeout: no unit ran, and the command's time was spent waiting.
      const held = o.gpu && g.grant !== null && !g.grant.granted && g.grant.why.startsWith('still held');
      const timedOut = s.result === 'timeout' || held || (r.code === null && !signal?.aborted);
      return { code: r.code, out: r.without(own), stats: s.stats, err: cut(r.stderr, own), timedOut, unitResult: s.result, ...(o.gpu ? { gpu: g.grant } : {}), ...(o.network !== undefined ? { network: n.grant } : {}) };
    },
    async check() {
      const r = await call(['check'], { timeoutMs: 300_000 });
      const fails = r.stdout.split('\n').filter((l) => l.startsWith('FAIL'));
      const unsupported = usernsUnsupported(r.stdout);
      return { ok: r.code === 0 && /^OK$/m.test(r.stdout) && !fails.length, detail: (fails.length ? fails.join('\n') : r.code === 0 ? 'all checks passed' : `the check didn't run: ${r.out.trim().slice(-300)}`).slice(0, 2000), ...(unsupported ? { unsupported } : {}) };
    },
    async wipe(id) {
      checkId(id);
      const r = await call(['wipe', id], { timeoutMs: 300_000 });
      if (r.code === 0) return { ok: true, left: [] };
      return { ok: false, left: r.stderr.trim().split('\n').filter((l) => /^(unit|container|volume|dir) /.test(l)).concat([`wipe exit ${r.code ?? 'killed'}`]) };
    },
    async helperVersion() {
      const r = await call(['version'], { timeoutMs: 60_000 });
      const v = r.stdout.trim();
      return { version: r.code === 0 && /^[1-9][0-9]{0,5}$/.test(v) ? Number(v) : null, stderr: lastLines(r.stderr, 20) };
    },
  };
}

/**
 * The unsandboxed host: the same steps as the current user under `base`, with `docker` from PATH (or the one
 * given). For the engine's tests and development only: nothing here keeps a run away from this user's files.
 */
export function localHost(base: string, o: { docker?: string; path?: string } = {}): RunHost {
  const docker = o.docker ?? 'docker';
  const dockerEnv = { PATH: o.path ?? ownEnv().get('PATH') ?? '/usr/bin:/bin', HOME: join(base, 'docker-home') };
  const runDir = (id: string) => join(base, 'runs', id);
  const d = (args: string[], timeoutMs = 120_000) => run(docker, args, { env: dockerEnv, timeoutMs });
  const leftovers = async (id: string): Promise<string[]> => {
    const left: string[] = [];
    const ps = await d(['ps', '-aq', '--filter', `label=${RUN_LABEL}=${id}`]);
    if (ps.code === 0) left.push(...ps.out.split('\n').filter(Boolean).map((c) => `container ${c}`));
    const vols = await d(['volume', 'ls', '-q', '--filter', `label=${RUN_LABEL}=${id}`]);
    if (vols.code === 0) left.push(...vols.out.split('\n').filter(Boolean).map((v) => `volume ${v}`));
    if (existsSync(runDir(id))) left.push(`dir ${runDir(id)}`);
    return left;
  };
  return {
    kind: 'local',
    async create(id, bundle, refs) {
      checkId(id);
      checkRefs(id, refs);
      const dir = runDir(id);
      if (existsSync(dir)) throw new Error(`run ${id} exists; wipe it first`);
      for (const sub of ['work', 'tmp', 'home']) mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
      const file = join(dir, 'tree.bundle');
      const w = await run('sh', ['-c', 'cat > "$1"', '_', file], { stdin: bundle, timeoutMs: 600_000 });
      if (w.code !== 0) throw fail('create', `receiving run ${id}'s bundle`, w);
      const [bash, args] = shellCommand(cloneScript());
      const env = { PATH: o.path ?? ownEnv().get('PATH') ?? '/usr/bin:/bin', HOME: join(dir, 'home'), LANG: 'C.UTF-8' };
      mkdirSync(join(base, 'store'), { recursive: true, mode: 0o700 });
      const r = await run(bash, [...args, '_', file, join(dir, 'work'), refs.branch, refs.head, refs.base, refs.headSha, refs.baseSha, join(base, 'store'), ...refs.exclude], { env, cwd: dir, timeoutMs: 600_000 });
      if (r.code !== 0) throw fail('create', `creating run ${id}'s workspace`, r);
      return { workdir: join(dir, 'work') };
    },
    async storeTips() {
      if (!existsSync(join(base, 'store', 'HEAD'))) return [];
      const r = await run('git', [`--git-dir=${join(base, 'store')}`, 'for-each-ref', '--format=%(objectname)', 'refs/keep/'], { env: { PATH: o.path ?? ownEnv().get('PATH') ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, timeoutMs: 60_000 });
      if (r.code !== 0) throw fail('store-tips', 'reading the object store', r);
      return parseTips(r.stdout);
    },
    async changedFiles(id, files) {
      checkId(id);
      const f = join(runDir(id), 'changed-files');
      writeFileSync(f, files.map((x) => `${x}\n`).join(''), { mode: 0o600 });
      return f;
    },
    async cache(name, key) {
      if (!/^[a-z][a-z0-9_-]{0,39}$/.test(name) || !/^[0-9a-f]{16,64}$/.test(key)) throw new Error(`not a cache: ${name} ${key}`);
      const root = join(base, 'cache');
      const dir = join(root, `${name}-${key}`);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const now = new Date();
      utimesSync(dir, now, now);
      // Keep the two newest keys of each cache, as the sandbox helper does.
      const mine = readdirSync(root)
        .filter((n) => n.startsWith(`${name}-`) && /^[0-9a-f]{16,64}$/.test(n.slice(name.length + 1)))
        .map((n) => ({ n, t: statSync(join(root, n)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const old of mine.slice(2)) rmSync(join(root, old.n), { recursive: true, force: true });
      return dir;
    },
    async shared(name) {
      checkName(name);
      const dir = join(base, 'shared', name);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      return dir;
    },
    async startDb(id, db) {
      checkId(id);
      checkDb(db);
      const container = `${BRAND.cli}-test-${id}`;
      const password = randomBytes(16).toString('hex');
      const pull = await d(['image', 'inspect', db.image]);
      if (pull.code !== 0) {
        const p = await d(['pull', '-q', db.image], 600_000);
        if (p.code !== 0) throw fail('db-start', `pulling ${db.image}`, p);
      }
      // A unique name and a port the daemon picks, on loopback only: never a fixed host port.
      const r = await d(['run', '-d', '--name', container, '--label', `${RUN_LABEL}=${id}`, '-p', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data:rw', '-e', `POSTGRES_PASSWORD=${password}`, '-e', `POSTGRES_DB=${db.name}`, db.image, '-c', `max_connections=${db.maxConnections}`]);
      if (r.code !== 0) throw fail('db-start', `starting run ${id}'s database`, r);
      const p = await d(['port', container, '5432/tcp']);
      const m = /^127\.0\.0\.1:(\d{1,5})$/m.exec(p.out);
      if (p.code !== 0 || !m) throw fail('db-start', `reading the port of ${container}`, p);
      for (let i = 0; i < db.readyS; i++) {
        const ready = await d(['exec', container, 'pg_isready', '-q', '-U', 'postgres', '-d', db.name, '-h', '127.0.0.1']);
        if (ready.code === 0) return { url: postgresUrl(Number(m[1]), password, db.name), port: Number(m[1]), container };
        await new Promise((res) => setTimeout(res, 1000));
      }
      throw new SetupStepError('db-start', `${container} wasn't ready after ${db.readyS}s`, '');
    },
    async fetch(id, fetcher, cache, key, timeoutMs, signal, files = []) {
      checkId(id);
      checkFetch(fetcher, files);
      const dir = runDir(id);
      const fd = join(dir, 'fetch');
      rmSync(fd, { recursive: true, force: true });
      mkdirSync(join(fd, 'home'), { recursive: true, mode: 0o700 });
      // The workspace, then the requirements files, are the script's arguments, as the helper passes them. (The helper
      // runs it in its unit's private /tmp; the local host has no sandbox, and uses a directory of the run's.)
      const [file, args] = shellCommand(fetchScript(fetcher));
      const full = { PATH: o.path ?? ownEnv().get('PATH') ?? '/usr/bin:/bin', HOME: join(fd, 'home'), TMPDIR: join(dir, 'tmp'), LANG: 'C.UTF-8', CI: '1', [FETCH_CACHE_ENV[fetcher]]: await this.cache(cache, key) };
      const r = await run(file, [...args, 'fetch', join(dir, 'work'), ...files], { cwd: fd, env: full, timeoutMs, signal });
      rmSync(fd, { recursive: true, force: true });
      return { code: r.code, out: r.out, err: r.stderr, timedOut: r.code === null && !signal?.aborted };
    },
    async exec(id, command, env, timeoutMs, signal, eo = {}) {
      checkId(id);
      const dir = runDir(id);
      const [file, args] = shellCommand(command);
      // Exactly these variables: never this process's own environment.
      const full = { ...env, PATH: o.path ?? ownEnv().get('PATH') ?? '/usr/bin:/bin', HOME: join(dir, 'home'), TMPDIR: join(dir, 'tmp'), LANG: 'C.UTF-8', CI: '1' };
      const r = await run(file, args, { cwd: join(dir, 'work'), env: full, timeoutMs, signal });
      // The local host has no GPU to grant: a command that asks is told so, as the helper would.
      // Nor network: it has no sandbox to keep a command off it, and says so to one that asks.
      return { code: r.code, out: r.out, err: r.stderr, timedOut: r.code === null && !signal?.aborted, ...(eo.gpu ? { gpu: { granted: false as const, why: 'the local host grants no GPU' } } : {}), ...(eo.network !== undefined ? { network: { granted: false as const, why: 'the local host has no sandbox, so it grants nothing' } } : {}) };
    },
    async check() {
      return { ok: false, detail: 'the local host has no sandbox: for the engine\'s tests and development only' };
    },
    async helperVersion() {
      // No helper: the local host does each step itself, so it always speaks this engine's protocol.
      return { version: HELPER_PROTOCOL, stderr: '' };
    },
    async wipe(id) {
      checkId(id);
      const ps = await d(['ps', '-aq', '--filter', `label=${RUN_LABEL}=${id}`]);
      const ids = ps.code === 0 ? ps.out.split('\n').filter(Boolean) : [];
      if (ids.length) await d(['rm', '-f', '-v', ...ids]);
      const vols = await d(['volume', 'ls', '-q', '--filter', `label=${RUN_LABEL}=${id}`]);
      const vs = vols.code === 0 ? vols.out.split('\n').filter(Boolean) : [];
      if (vs.length) await d(['volume', 'rm', '-f', ...vs]);
      rmSync(runDir(id), { recursive: true, force: true });
      const left = await leftovers(id);
      return { ok: left.length === 0, left };
    },
  };
}
