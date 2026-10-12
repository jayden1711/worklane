// Where a test run's steps happen: its workspace, its database, its commands and its wipe.
//
// The sandbox host (production, Linux) does each through the root-owned helper (scripts/machine/<cli>-testrun.sh,
// installed by scripts/setup/test-user.sh), which sudo lets the instance's coordinator run for its own test user
// only: the workspace, the commands and the database all belong to that user, in the test runs' slice, and the
// commands run sandboxed. The local host does the same steps as the current user in a directory of its own, with
// no sandbox: for the engine's tests and for development, never for a project's PRs (the coordinator refuses it).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { BRAND } from '../brand.js';
import { killTree, shellCommand, spawnDetached } from '../os/index.js';
import { PINNED_IMAGE } from './config.js';

export const SANDBOX_HELPER = `/usr/local/libexec/${BRAND.cli}-testrun`;
/** The label on every container a run starts: wipe removes whatever carries its run's. */
export const RUN_LABEL = `${BRAND.cli}.test-run`;

export interface ExecResult {
  /** null: it timed out or was cancelled. */
  code: number | null;
  out: string;
  /** What the command used, where the host can tell (the sandbox's unit reports it). */
  stats?: { cpuS: number | null; memPeakMb: number | null };
}

const UNIT = { s: 1, ms: 0.001, us: 0.000001, min: 60, h: 3600 } as Record<string, number>;
const MEM = { B: 1 / 1048576, K: 1 / 1024, M: 1, G: 1024, T: 1048576 } as Record<string, number>;

/**
 * systemd-run --wait's own lines (its unit's name at the start; its result, CPU time and peak memory at the end),
 * taken out of a command's output and read.
 */
export function systemdRunStats(out: string): { out: string; stats: { cpuS: number | null; memPeakMb: number | null } } {
  let cpuS: number | null = null;
  let memPeakMb: number | null = null;
  const own = /^(Running as unit: |Finished with result: |Main processes terminated with: |Service runtime: |CPU time consumed: |Memory peak: |Memory swap peak: |IP traffic received: |IP traffic sent: |IO bytes read: |IO bytes written: )/;
  const kept: string[] = [];
  for (const line of out.split('\n')) {
    if (!own.test(line)) {
      kept.push(line);
      continue;
    }
    const cpu = /^CPU time consumed: (.+)$/.exec(line);
    if (cpu) cpuS = [...cpu[1]!.matchAll(/([\d.]+)(us|ms|min|s|h)/g)].reduce((a, m) => a + Number(m[1]) * UNIT[m[2]!]!, 0);
    const mem = /^Memory peak: ([\d.]+)([BKMGT])/.exec(line);
    if (mem) memPeakMb = Math.round(Number(mem[1]) * MEM[mem[2]!]! * 10) / 10;
  }
  return { out: kept.join('\n'), stats: { cpuS: cpuS === null ? null : Math.round(cpuS * 10) / 10, memPeakMb } };
}

export interface RunDatabase {
  url: string;
  port: number;
  container: string;
}

export interface RunHost {
  readonly kind: 'sandbox' | 'local';
  /** A new run's workspace, unpacked from a tar stream of the tree. */
  create(id: string, tree: Readable): Promise<{ workdir: string }>;
  /** The change's paths, one per line, in a file of the run's (for {changed_files}). */
  changedFiles(id: string, files: readonly string[]): Promise<string>;
  /** A cache's directory for this key (made if new). */
  cache(name: string, key: string): Promise<string>;
  /** A directory every run of the instance shares (e.g. a test-port registry); no wipe removes it. */
  shared(name: string): Promise<string>;
  /** The run's own Postgres: a unique container and a port the daemon picks, on loopback. */
  startDb(id: string, db: { image: string; name: string; readyS: number }): Promise<RunDatabase>;
  /** Run a command in the workspace with exactly `env` (and the host's fixed PATH, HOME, TMPDIR, CI). */
  exec(id: string, command: string, env: Record<string, string>, timeoutMs: number, signal?: AbortSignal): Promise<ExecResult>;
  /** The sandbox's own boundary check; a check that can't run is not ok. */
  check(): Promise<{ ok: boolean; detail: string }>;
  /** Remove everything of the run: its processes, containers, volumes and files. `left`: what is still there. */
  wipe(id: string): Promise<{ ok: boolean; left: string[] }>;
}

export const RUN_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
function checkId(id: string): void {
  if (!RUN_ID.test(id)) throw new Error(`not a run id: ${id}`);
}

/** A new run id: the kind, the commit, and enough randomness that two runs of one commit never share one. */
export function newRunId(kind: 'fast' | 'full', sha: string): string {
  return `${kind}-${sha.slice(0, 10)}-${randomBytes(4).toString('hex')}`;
}

function checkName(name: string): void {
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(name)) throw new Error(`not a directory name: ${name}`);
}

const OUT_CAP = 8_000_000;

/** Spawn and collect output, killed at the timeout or on abort (code null then). */
function run(file: string, args: string[], o: { env?: NodeJS.ProcessEnv; cwd?: string; stdin?: Readable | string; timeoutMs?: number; signal?: AbortSignal | undefined }): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], detached: spawnDetached });
    let out = '';
    let killed = false;
    const take = (d: Buffer) => {
      out += d.toString();
      if (out.length > OUT_CAP) out = out.slice(-OUT_CAP / 2);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
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
      resolve({ code: killed ? null : code, out });
    };
    child.on('error', (e) => {
      out += `\n${e.message}`;
      finish(127);
    });
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => {});
    if (typeof o.stdin === 'string') child.stdin.end(o.stdin);
    else if (o.stdin) o.stdin.pipe(child.stdin);
    else child.stdin.end();
  });
}

const fail = (what: string, r: ExecResult) => new Error(`${what} failed (exit ${r.code ?? 'killed'}): ${r.out.trim().split('\n').slice(-5).join(' | ').slice(0, 800)}`);

function postgresUrl(port: number, password: string, db: string): string {
  return `postgres://postgres:${password}@127.0.0.1:${port}/${db}`;
}

function checkDb(db: { image: string; name: string; readyS: number }): void {
  if (!PINNED_IMAGE.test(db.image)) throw new Error(`the database image must be pinned to its digest: ${db.image}`);
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(db.name)) throw new Error(`not a database name: ${db.name}`);
}

/** The production host: every step through the sandbox helper, for instance `instance`'s test user. */
export function sandboxHost(instance: string, helper = SANDBOX_HELPER, sudo = 'sudo'): RunHost {
  if (!/^[a-z][a-z0-9-]{0,20}$/.test(instance)) throw new Error(`not an instance name: ${instance}`);
  const call = (args: string[], o: Parameters<typeof run>[2] = {}) => run(sudo, ['-n', helper, instance, ...args], { env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, ...o });
  const lastLine = (r: ExecResult) => r.out.trim().split('\n').pop() ?? '';
  return {
    kind: 'sandbox',
    async create(id, tree) {
      checkId(id);
      const r = await call(['create', id], { stdin: tree, timeoutMs: 600_000 });
      if (r.code !== 0) throw fail(`creating run ${id}'s workspace`, r);
      return { workdir: lastLine(r) };
    },
    async changedFiles(id, files) {
      checkId(id);
      const r = await call(['file', id, 'changed-files'], { stdin: files.map((f) => `${f}\n`).join(''), timeoutMs: 60_000 });
      if (r.code !== 0) throw fail(`writing run ${id}'s changed files`, r);
      return lastLine(r);
    },
    async cache(name, key) {
      const r = await call(['cache', name, key], { timeoutMs: 60_000 });
      if (r.code !== 0) throw fail(`the ${name} cache`, r);
      return lastLine(r);
    },
    async shared(name) {
      checkName(name);
      const r = await call(['shared', name], { timeoutMs: 60_000 });
      if (r.code !== 0) throw fail(`the shared directory ${name}`, r);
      return lastLine(r);
    },
    async startDb(id, db) {
      checkId(id);
      checkDb(db);
      const r = await call(['db-start', id, db.image, db.name, String(db.readyS)], { timeoutMs: (db.readyS + 300) * 1000 });
      const m = /^(\d{1,5}) ([0-9a-f]{32})$/.exec(lastLine(r));
      if (r.code !== 0 || !m) throw fail(`starting run ${id}'s database`, r);
      return { url: postgresUrl(Number(m[1]), m[2]!, db.name), port: Number(m[1]), container: `${BRAND.cli}-test-${instance}-${id}` };
    },
    async exec(id, command, env, timeoutMs, signal) {
      checkId(id);
      const args = ['exec', id, String(Math.max(1, Math.ceil(timeoutMs / 1000)))];
      for (const [k, v] of Object.entries(env)) args.push('--env', `${k}=${v}`);
      // The helper's unit ends at its RuntimeMaxSec; this timer is the backstop (a wipe stops whatever is left).
      const r = await call([...args, '--', command], { timeoutMs: timeoutMs + 60_000, signal });
      const s = systemdRunStats(r.out);
      return { ...r, out: s.out, stats: s.stats };
    },
    async check() {
      const r = await call(['check'], { timeoutMs: 300_000 });
      const fails = r.out.split('\n').filter((l) => l.startsWith('FAIL'));
      return { ok: r.code === 0 && /^OK$/m.test(r.out) && !fails.length, detail: (fails.length ? fails.join('\n') : r.code === 0 ? 'all checks passed' : `the check didn't run: ${r.out.trim().slice(-300)}`).slice(0, 2000) };
    },
    async wipe(id) {
      checkId(id);
      const r = await call(['wipe', id], { timeoutMs: 300_000 });
      if (r.code === 0) return { ok: true, left: [] };
      return { ok: false, left: r.out.trim().split('\n').filter((l) => /^(unit|container|volume|dir) /.test(l)).concat(r.code === 0 ? [] : [`wipe exit ${r.code ?? 'killed'}`]) };
    },
  };
}

/**
 * The unsandboxed host: the same steps as the current user under `base`, with `docker` from PATH (or the one
 * given). For the engine's tests and development only: nothing here keeps a run away from this user's files.
 */
export function localHost(base: string, o: { docker?: string; path?: string } = {}): RunHost {
  const docker = o.docker ?? 'docker';
  const dockerEnv = { PATH: o.path ?? process.env.PATH ?? '/usr/bin:/bin', HOME: join(base, 'docker-home') };
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
    async create(id, tree) {
      checkId(id);
      const dir = runDir(id);
      if (existsSync(dir)) throw new Error(`run ${id} exists; wipe it first`);
      for (const sub of ['work', 'tmp', 'home']) mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
      const r = await run('tar', ['-x', '-f', '-', '-C', join(dir, 'work')], { stdin: tree, timeoutMs: 600_000 });
      if (r.code !== 0) throw fail(`creating run ${id}'s workspace`, r);
      return { workdir: join(dir, 'work') };
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
        if (p.code !== 0) throw fail(`pulling ${db.image}`, p);
      }
      // A unique name and a port the daemon picks, on loopback only: never a fixed host port.
      const r = await d(['run', '-d', '--name', container, '--label', `${RUN_LABEL}=${id}`, '-p', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data:rw', '-e', `POSTGRES_PASSWORD=${password}`, '-e', `POSTGRES_DB=${db.name}`, db.image]);
      if (r.code !== 0) throw fail(`starting run ${id}'s database`, r);
      const p = await d(['port', container, '5432/tcp']);
      const m = /^127\.0\.0\.1:(\d{1,5})$/m.exec(p.out);
      if (p.code !== 0 || !m) throw fail(`reading the port of ${container}`, p);
      for (let i = 0; i < db.readyS; i++) {
        const ready = await d(['exec', container, 'pg_isready', '-q', '-U', 'postgres', '-d', db.name, '-h', '127.0.0.1']);
        if (ready.code === 0) return { url: postgresUrl(Number(m[1]), password, db.name), port: Number(m[1]), container };
        await new Promise((res) => setTimeout(res, 1000));
      }
      throw new Error(`${container} wasn't ready after ${db.readyS}s`);
    },
    async exec(id, command, env, timeoutMs, signal) {
      checkId(id);
      const dir = runDir(id);
      const [file, args] = shellCommand(command);
      // Exactly these variables: never this process's own environment.
      const full = { ...env, PATH: o.path ?? process.env.PATH ?? '/usr/bin:/bin', HOME: join(dir, 'home'), TMPDIR: join(dir, 'tmp'), LANG: 'C.UTF-8', CI: '1' };
      return run(file, args, { cwd: join(dir, 'work'), env: full, timeoutMs, signal });
    },
    async check() {
      return { ok: false, detail: 'the local host has no sandbox: for the engine\'s tests and development only' };
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
