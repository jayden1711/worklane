// The task's environment (#748): one throwaway container per task, from its SWE-bench instance image, in the bench
// user's rootless Docker, where the repo's Python env lives and its tests run. The agents don't run in it: they run
// on the host, as the bench user, in the engine's sandbox (auth.ts), so the container needs no route out and gets
// none (--network none).
// The bench user's home holds its claude login, and its rootless daemon can mount anything that user can read. So
// (owner's update, 2026-10-18):
// - no agent ever reaches the daemon: the sandbox denies its socket and XDG_RUNTIME_DIR, and the agent's environment
//   carries no DOCKER_* or XDG_RUNTIME_DIR (agentBase in auth.ts, benchLane in agent.ts);
// - a container mounts nothing at all: the worktree reaches it as a tar stream on `docker exec -i` (syncTree);
// - the task's commands go through TaskRunner, which only ever sends `docker exec <that task's container> argv`, with
//   no docker option but a work dir and plain variables.
// Every container has a memory (no extra swap), CPU and pids limit, read back from the daemon and from the
// container's own cgroup (memory.max, memory.swap.max = 0, cpu.max, pids.max) before anything runs in it: a limit
// that didn't apply refuses the run (checkLimits).
// Every docker command passes checkDockerArgs, then (for a task) hiddenLeaks on its argv and on its stdin (a tar
// stream: only what its base tree lacks counts): refused, nothing sent, on any match.
import { spawn, spawnSync } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import { posix } from 'node:path';
import { BRAND } from '../../src/brand.js';
import { hiddenLeaks, type TaskRow } from './hidden.js';

/** Environment names that may carry a credential or reach a daemon: never passed into a container. */
export const SECRET_NAME = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE|SESSION|^DOCKER_|^XDG_RUNTIME_DIR$/i;

/** This process's environment for the docker CLI: without any variable that may carry a credential (DOCKER_HOST kept). */
export function dockerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => k === 'DOCKER_HOST' || k === 'XDG_RUNTIME_DIR' || !SECRET_NAME.test(k)));
}

export interface TaskContainer {
  /** The container's name: bench-<run>-<key>. */
  name: string;
  /** The task's instance image, by tag or digest. */
  image: string;
}

/** Where the task's trees go inside its container (its own filesystem: nothing is mounted). */
export const WORK = '/work';

const IMAGE = /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?(@sha256:[a-f0-9]{64})?$/;
const NAME = /^bench-[a-zA-Z0-9_.-]{1,100}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const NUM = /^[1-9][0-9]{0,15}(\.[0-9]{1,3})?$/;

/** Every container's limits: memory in bytes (swap the same, so none extra), CPUs, processes. */
export interface Limits {
  memoryBytes: number;
  cpus: number;
  pids: number;
}

export const LIMIT_ENV = { memory: `${BRAND.envPrefix}_BENCH_MEMORY`, cpus: `${BRAND.envPrefix}_BENCH_CPUS`, pids: `${BRAND.envPrefix}_BENCH_PIDS` } as const;
export const DEFAULT_LIMITS = { memory: '8g', cpus: '4', pids: '4096' } as const;

/** The page size memory limits are kept in (cgroup v2 memory.max). */
const PAGE = 4096;

/** Bytes from 8g / 512m / 1073741824. */
function bytes(s: string): number {
  const m = /^([0-9]+)([kmg]?)$/i.exec(s.trim());
  if (!m) return NaN;
  return Number(m[1]) * { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2]!.toLowerCase() as '' | 'k' | 'm' | 'g'];
}

/**
 * The containers' limits (LIMIT_ENV, else DEFAULT_LIMITS). Refused: a missing, zero or unreadable value; CPUs over the
 * host's; memory over 75% of the host's. One task runs at a time.
 */
export function limitsFrom(env: NodeJS.ProcessEnv, host = { cpus: cpus().length, memoryBytes: totalmem() }): Limits {
  const raw = (k: keyof typeof LIMIT_ENV) => (env[LIMIT_ENV[k]] ?? DEFAULT_LIMITS[k]).trim();
  const l: Limits = { memoryBytes: bytes(raw('memory')), cpus: Number(raw('cpus')), pids: Number(raw('pids')) };
  if (!(l.memoryBytes >= 64 * 1024 ** 2)) throw new Error(`${LIMIT_ENV.memory} ${raw('memory')} refused: a memory limit of at least 64m is required (e.g. 8g)`);
  if (!(l.cpus > 0) || !/^[0-9]+(\.[0-9]{1,2})?$/.test(raw('cpus'))) throw new Error(`${LIMIT_ENV.cpus} ${raw('cpus')} refused: a CPU limit over 0 is required`);
  if (!Number.isInteger(l.pids) || l.pids <= 0) throw new Error(`${LIMIT_ENV.pids} ${raw('pids')} refused: a pids limit over 0 is required`);
  if (l.cpus > host.cpus) throw new Error(`${LIMIT_ENV.cpus} ${l.cpus} is over this machine's ${host.cpus} CPUs`);
  if (l.memoryBytes > 0.75 * host.memoryBytes) throw new Error(`${LIMIT_ENV.memory} ${raw('memory')} is over 75% of this machine's memory`);
  // The kernel keeps memory.max in whole pages: any other value would read back different, and refuse every run.
  if (l.memoryBytes % PAGE !== 0) throw new Error(`${LIMIT_ENV.memory} ${raw('memory')} refused: not a multiple of ${PAGE} bytes (use k, m or g, e.g. ${Math.floor(l.memoryBytes / 1024 ** 2)}m)`);
  return l;
}

/** The limit flags, as `docker create`/`run` take them. */
export const limitArgs = (l: Limits): string[] => ['--memory', `${l.memoryBytes}b`, '--memory-swap', `${l.memoryBytes}b`, '--cpus', String(l.cpus), '--pids-limit', String(l.pids)];

/** The only `docker create`/`run` options the driver uses, and the value each must have (null: checked below). */
const RUN_OPTIONS: Record<string, string | null> = {
  '--detach': '', '--rm': '', '--name': null, '--network': 'none', '--cap-drop': 'ALL', '--security-opt': 'no-new-privileges',
  '--pids-limit': null, '--memory': null, '--memory-swap': null, '--cpus': null, '--workdir': WORK, '--entrypoint': 'sleep',
};
/** The only `docker exec` options: a work dir, plain variables, stdin for a tree. */
const EXEC_OPTIONS: Record<string, string | null> = { '--workdir': null, '--env': null, '--interactive': '' };

/**
 * Refuses (throws) any docker command but these: `info --format`, `inspect --format <bench container>`,
 * `start`/`rm --force` of a bench container, `create`/`run` with exactly the options above (so no mount, volume,
 * device, privilege, capability or network, and every limit), and `exec` with only a work dir, variables and stdin.
 * `verbs` narrows further (TaskRunner: exec only). Options stop at the container's name (create/run: the image); what
 * follows is the command inside, where `-v` is pytest's. Each option is parsed with its value, and the required ones
 * are looked for among the parsed options only, so a value (`--name --network`) never stands in for an option.
 */
export function checkDockerArgs(args: readonly string[], verbs: readonly string[] = ['info', 'create', 'start', 'run', 'inspect', 'exec', 'rm']): void {
  const verb = args[0] ?? '';
  if (!verbs.includes(verb)) throw new Error(`docker ${verb} refused: only ${verbs.join(', ')}`);
  if (verb === 'info') {
    if (args.length !== 3 || args[1] !== '--format') throw new Error('docker info takes only --format');
    return;
  }
  if (verb === 'inspect') {
    if (args.length !== 4 || args[1] !== '--format' || !NAME.test(args[3]!)) throw new Error('docker inspect takes only --format and a bench container');
    return;
  }
  if (verb === 'rm' || verb === 'start') {
    const ok = verb === 'rm' ? args.length === 3 && args[1] === '--force' && NAME.test(args[2]!) : args.length === 2 && NAME.test(args[1]!);
    if (!ok) throw new Error(`docker ${verb} takes only a bench container${verb === 'rm' ? ' (and --force)' : ''}`);
    return;
  }
  const make = verb === 'run' || verb === 'create';
  const allowed = make ? RUN_OPTIONS : EXEC_OPTIONS;
  const parsed = new Set<string>();
  let i = 1;
  for (; i < args.length && args[i]!.startsWith('-'); i++) {
    const [flag, glued] = args[i]!.split(/=(.*)/s, 2) as [string, string | undefined];
    if (!Object.hasOwn(allowed, flag)) throw new Error(`docker ${verb} option ${flag} refused`);
    const want = allowed[flag];
    parsed.add(flag);
    if (want === '') {
      if (glued !== undefined) throw new Error(`docker ${verb} ${flag} takes no value`);
      continue;
    }
    const v = glued ?? args[++i];
    if (v === undefined || (want !== null && v !== want)) throw new Error(`docker ${verb} ${flag} ${v ?? ''} refused${want ? `: only ${want}` : ''}`);
    if (flag === '--name' && !NAME.test(v)) throw new Error(`docker ${verb} --name ${v} refused: only a bench container`);
    if (flag === '--env') {
      // NAME alone would copy NAME's value from the driver's own environment.
      const eq = v.indexOf('=');
      const name = eq < 0 ? v : v.slice(0, eq);
      if (eq < 0) throw new Error(`docker ${verb} --env ${name} refused: only NAME=value`);
      if (!ENV_NAME.test(name)) throw new Error(`docker ${verb} --env ${name} refused`);
      if (SECRET_NAME.test(name)) throw new Error(`docker ${verb} --env ${name} refused: may carry a credential or reach a daemon`);
    }
    if (flag === '--workdir' && (posix.normalize(v) !== v || !(v === WORK || v.startsWith(`${WORK}/`)))) throw new Error(`docker ${verb} --workdir ${v} refused: only a normalized path under ${WORK}`);
    if (['--memory', '--memory-swap', '--cpus', '--pids-limit'].includes(flag) && !NUM.test(v.replace(/b$/, ''))) throw new Error(`docker ${verb} ${flag} ${v} refused: a positive number`);
  }
  const target = args[i];
  if (verb === 'exec' && (!target || !NAME.test(target))) throw new Error(`docker exec into ${target ?? 'nothing'} refused: only a bench container`);
  if (make) {
    if (!target || !IMAGE.test(target)) throw new Error(`image ${target ?? 'none'} refused`);
    for (const need of ['--name', '--network', '--cap-drop', '--security-opt', '--memory', '--memory-swap', '--cpus', '--pids-limit']) {
      if (!parsed.has(need)) throw new Error(`docker ${verb} without ${need} refused`);
    }
  }
}

/** `docker create` (or `run --detach --rm`) for a task: no mount, no network, no capability, no new privilege, every limit. */
export function makeArgs(verb: 'create' | 'run', c: TaskContainer, l: Limits): string[] {
  if (!NAME.test(c.name)) throw new Error(`container name ${JSON.stringify(c.name)} refused`);
  return [verb, ...(verb === 'run' ? ['--detach', '--rm'] : []), '--name', c.name, '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', ...limitArgs(l), '--workdir', WORK, '--entrypoint', 'sleep', c.image, 'infinity'];
}

export interface Sent {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the docker CLI (tests pass a stand-in). */
export type DockerCall = (docker: string, args: readonly string[], o: { env: NodeJS.ProcessEnv; timeoutMs: number; input?: Buffer }) => Sent;

const spawnDocker: DockerCall = (docker, args, o) => {
  const r = spawnSync(docker, args, { env: o.env, encoding: 'utf8', timeout: o.timeoutMs, maxBuffer: 64 * 1024 * 1024, ...(o.input ? { input: o.input } : {}) });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error) : '') };
};

/** Runs the docker CLI without blocking, ended (its process killed) when `signal` fires (tests pass a stand-in). */
export type DockerCallAsync = (docker: string, args: readonly string[], o: { env: NodeJS.ProcessEnv; timeoutMs: number; input?: Buffer; signal?: AbortSignal }) => Promise<Sent>;

const spawnDockerAsync: DockerCallAsync = (docker, args, o) =>
  new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const child = spawn(docker, args, { env: o.env, timeout: o.timeoutMs, ...(o.signal ? { signal: o.signal } : {}), stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', (e) => resolve({ status: null, stdout: Buffer.concat(out).toString('utf8'), stderr: `${Buffer.concat(err).toString('utf8')}${String(e)}` }));
    child.on('close', (status) => resolve({ status, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
    child.stdin.on('error', () => {});
    child.stdin.end(o.input ?? undefined);
  });

export interface DockerOptions {
  docker: string;
  env?: NodeJS.ProcessEnv;
  call?: DockerCall;
  /** A task's commands (TaskRunner); unset: the docker CLI, or `call` when only that is given (tests). */
  callAsync?: DockerCallAsync;
}

/**
 * The one way anything reaches docker: checkDockerArgs, then refused when the argv, or the stdin, carries any of
 * `row`'s hidden fields. The stdin (a worktree's tar stream) is checked against `base`, the text of the task's base
 * tree: only a hidden piece the base lacks counts. No base: every piece counts.
 */
function check(verbs: readonly string[], args: string[], row: TaskRow | null, input?: Buffer, base?: Buffer): void {
  checkDockerArgs(args, verbs);
  if (row) {
    const leaks = hiddenLeaks(args.join('\n'), row);
    if (leaks.length) throw new Error(`refused: this docker command would carry the task's hidden ${leaks.join(', ')}`);
    const inLeaks = input ? hiddenLeaks(input.toString('utf8'), row, base?.toString('utf8') ?? '') : [];
    if (inLeaks.length) throw new Error(`refused: this docker command's input would carry the task's hidden ${inLeaks.join(', ')} (not in its base tree)`);
  }
}

function send(o: DockerOptions, verbs: readonly string[], args: string[], row: TaskRow | null, timeoutMs: number, input?: Buffer, base?: Buffer): Sent {
  check(verbs, args, row, input, base);
  return (o.call ?? spawnDocker)(o.docker, args, { env: dockerEnv(o.env), timeoutMs, ...(input ? { input } : {}) });
}

/** send, for a task's commands: the same checks, then the docker CLI without blocking, ended when `signal` fires. */
async function sendAsync(o: DockerOptions, verbs: readonly string[], args: string[], row: TaskRow, timeoutMs: number, signal: AbortSignal | undefined, input?: Buffer, base?: Buffer): Promise<Sent> {
  check(verbs, args, row, input, base);
  if (signal?.aborted) throw new Error("not run: the task's wall-clock cap has passed");
  const opt = { env: dockerEnv(o.env), timeoutMs, ...(input ? { input } : {}), ...(signal ? { signal } : {}) };
  if (o.callAsync) return o.callAsync(o.docker, args, opt);
  if (o.call) return o.call(o.docker, args, opt);
  return spawnDockerAsync(o.docker, args, opt);
}

/** Whether this daemon is rootless, from `docker info --format '{{json .SecurityOptions}}'`. */
export function rootless(stdout: string): boolean {
  try {
    const opts = JSON.parse(stdout) as unknown;
    return Array.isArray(opts) && opts.some((o) => /(^|,)name=rootless(,|$)/.test(String(o)));
  } catch {
    return false;
  }
}

/** A container's limits didn't all apply: nothing more runs. */
export class LimitsNotApplied extends Error {}

const DELEGATE ='scripts/bench/README.md, one-time setup: the systemd Delegate= drop-in';

/**
 * Refuses (throws) unless every limit applied: the daemon's record (`docker inspect`: Memory, MemorySwap, NanoCpus,
 * PidsLimit) and, when the container runs (`cgroup`: its memory.max, memory.swap.max, cpu.max and pids.max, one per
 * line), the kernel's. memory.swap.max must be 0: --memory-swap equal to --memory means no swap beyond the memory.
 * Names the controller that is missing.
 */
export function checkLimits(l: Limits, inspect: string, cgroup?: string): void {
  let h: { Memory?: unknown; MemorySwap?: unknown; NanoCpus?: unknown; PidsLimit?: unknown } = {};
  try {
    h = JSON.parse(inspect) as typeof h;
  } catch {
    // unreadable: every check below fails
  }
  const missing: string[] = [];
  if (h.Memory !== l.memoryBytes || h.MemorySwap !== l.memoryBytes) missing.push('memory');
  if (h.NanoCpus !== Math.round(l.cpus * 1e9)) missing.push('cpu');
  if (h.PidsLimit !== l.pids) missing.push('pids');
  if (cgroup !== undefined) {
    const [mem, swap, cpu, pids] = cgroup.split('\n').map((s) => s.trim());
    if (mem !== String(l.memoryBytes)) missing.push('memory (memory.max)');
    if (swap !== '0') missing.push('memory (memory.swap.max)');
    const [quota, period] = (cpu ?? '').split(/\s+/).map(Number);
    if (!quota || !period || Math.abs(quota / period - l.cpus) > 0.01) missing.push('cpu (cpu.max)');
    if (pids !== String(l.pids)) missing.push('pids (pids.max)');
  }
  if (missing.length) throw new LimitsNotApplied(`not run: the container's ${[...new Set(missing)].join(', ')} limit did not apply (the ${missing[0]!.split(' ')[0]} cgroup controller is not delegated to this user?): ${DELEGATE}`);
}

const CGROUP_READ = ['cat', '/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.swap.max', '/sys/fs/cgroup/cpu.max', '/sys/fs/cgroup/pids.max'];
const HOST_CONFIG = '{{json .HostConfig}}';

/** The driver's own docker: the rootless check, the limits' check, and a task container's start and removal. */
export class Docker {
  constructor(
    private o: DockerOptions,
    readonly limits: Limits,
  ) {}

  /** Refuses (throws) unless this user's daemon is rootless: a rootful daemon's container root is the host's. */
  preflight(): void {
    const r = send(this.o, ['info'], ['info', '--format', '{{json .SecurityOptions}}'], null, 30_000);
    if (r.status !== 0) throw new Error(`docker info failed (is this user's rootless Docker running?): ${r.stderr.trim().slice(0, 300)}`);
    if (!rootless(r.stdout)) throw new Error("this user's Docker daemon is not rootless (no name=rootless in its security options): the bench runs only on the bench user's rootless Docker (scripts/bench/README.md)");
  }

  /** The limits read back from a running container (its HostConfig, then its own cgroup files). */
  private readBack(c: TaskContainer, row: TaskRow | null, running: boolean): void {
    const i = send(this.o, ['inspect'], ['inspect', '--format', HOST_CONFIG, c.name], row, 60_000);
    if (i.status !== 0) throw new Error(`docker inspect ${c.name} failed: ${i.stderr.trim().slice(0, 300)}`);
    if (!running) return checkLimits(this.limits, i.stdout);
    const g = send(this.o, ['exec'], ['exec', c.name, ...CGROUP_READ], row, 60_000);
    if (g.status !== 0) throw new Error(`reading ${c.name}'s cgroup limits failed: ${g.stderr.trim().slice(0, 300)}`);
    checkLimits(this.limits, i.stdout, g.stdout);
  }

  /**
   * Before the first task: a container with the limits, created without running and read back from the daemon,
   * then started and read back from its own cgroup, then removed. Throws on any limit that didn't apply.
   */
  probe(c: TaskContainer): void {
    try {
      const r = send(this.o, ['create'], makeArgs('create', c, this.limits), null, 600_000);
      if (r.status !== 0) throw new Error(`docker create ${c.name} with the limits failed (a cgroup controller not delegated?): ${r.stderr.trim().slice(0, 300)}; ${DELEGATE}`);
      this.readBack(c, null, false);
      const s = send(this.o, ['start'], ['start', c.name], null, 120_000);
      if (s.status !== 0) throw new Error(`docker start ${c.name} failed: ${s.stderr.trim().slice(0, 300)}`);
      this.readBack(c, null, true);
    } finally {
      this.stop(c);
    }
  }

  /** The task's container, its limits read back before anything else runs in it. */
  start(c: TaskContainer, row: TaskRow): void {
    const r = send(this.o, ['run'], makeArgs('run', c, this.limits), row, 600_000);
    if (r.status !== 0) throw new Error(`docker run ${c.name} failed: ${r.stderr.trim().slice(0, 300)}`);
    this.readBack(c, row, true);
  }

  stop(c: TaskContainer): void {
    send(this.o, ['rm'], ['rm', '--force', c.name], null, 120_000);
  }
}

/**
 * A task's commands, in its container and nowhere else: `docker exec <container> argv` and nothing else, ever. The
 * repo's and the tests' commands (the engine's checks, the stub CI) come through here.
 */
export class TaskRunner {
  constructor(
    private o: DockerOptions,
    readonly c: TaskContainer,
    private row: TaskRow,
    /**
     * The task's base tree as a tar stream of its base commit, made by the driver before any agent runs: what a tar
     * sent to the container is checked against (a hidden piece already in it doesn't count). None: every piece counts.
     */
    private base?: Buffer,
    /**
     * The task's stop (the driver's wall-clock cap, the run's usage limit): a command running when it fires is ended
     * (its docker CLI killed; the container's removal right after ends what it started inside), and none starts after.
     */
    private signal?: AbortSignal,
  ) {}

  /** argv in the container, in `cwd` (under WORK), with only `env` beyond the image's own. Never blocks the driver. */
  async exec(cwd: string, argv: readonly string[], env: Record<string, string> = {}, timeoutMs = 15 * 60_000, input?: Buffer): Promise<Sent> {
    if (!argv.length) throw new Error('nothing to run');
    const args = ['exec', ...(input ? ['--interactive'] : []), '--workdir', posix.normalize(cwd), ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]), this.c.name, ...argv];
    return sendAsync(this.o, ['exec'], args, this.row, timeoutMs, this.signal, input, this.base);
  }

  /** Replace `dst` (under WORK) in the container with the tree in `tar` (a tar stream of a worktree's files). */
  async syncTree(dst: string, tar: Buffer): Promise<Sent> {
    const d = posix.normalize(dst);
    if (!d.startsWith(`${WORK}/`)) throw new Error(`sync target ${dst} is not under ${WORK}`);
    return this.exec(WORK, ['sh', '-c', 'rm -rf -- "$1" && mkdir -p -- "$1" && tar -x -f - -C "$1"', 'sh', d], {}, 10 * 60_000, tar);
  }
}
