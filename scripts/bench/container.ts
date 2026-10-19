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
// container's own cgroup before anything runs in it: a limit that didn't apply refuses the run (checkLimits).
// Every docker command passes checkDockerArgs, then (for a task) hiddenLeaks: refused, nothing sent, on any match.
import { spawnSync } from 'node:child_process';
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
 * follows is the command inside, where `-v` is pytest's.
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
  let i = 1;
  for (; i < args.length && args[i]!.startsWith('-'); i++) {
    const [flag, glued] = args[i]!.split(/=(.*)/s, 2) as [string, string | undefined];
    if (!(flag in allowed)) throw new Error(`docker ${verb} option ${flag} refused`);
    const want = allowed[flag];
    if (want === '') {
      if (glued !== undefined) throw new Error(`docker ${verb} ${flag} takes no value`);
      continue;
    }
    const v = glued ?? args[++i];
    if (v === undefined || (want !== null && v !== want)) throw new Error(`docker ${verb} ${flag} ${v ?? ''} refused${want ? `: only ${want}` : ''}`);
    if (flag === '--env' && !ENV_NAME.test(v.split('=')[0]!)) throw new Error(`docker ${verb} --env ${v.split('=')[0]} refused`);
    if (flag === '--env' && SECRET_NAME.test(v.split('=')[0]!)) throw new Error(`docker ${verb} --env ${v.split('=')[0]} refused: may carry a credential or reach a daemon`);
    if (flag === '--workdir' && !(v === WORK || v.startsWith(`${WORK}/`))) throw new Error(`docker ${verb} --workdir ${v} refused: only under ${WORK}`);
    if (['--memory', '--memory-swap', '--cpus', '--pids-limit'].includes(flag) && !NUM.test(v.replace(/b$/, ''))) throw new Error(`docker ${verb} ${flag} ${v} refused: a positive number`);
  }
  const target = args[i];
  if (verb === 'exec' && (!target || !NAME.test(target))) throw new Error(`docker exec into ${target ?? 'nothing'} refused: only a bench container`);
  if (make) {
    if (!target || !IMAGE.test(target)) throw new Error(`image ${target ?? 'none'} refused`);
    for (const need of ['--network', '--cap-drop', '--security-opt', '--memory', '--memory-swap', '--cpus', '--pids-limit']) {
      if (!args.slice(1, i).some((a) => a === need || a.startsWith(`${need}=`))) throw new Error(`docker ${verb} without ${need} refused`);
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

export interface DockerOptions {
  docker: string;
  env?: NodeJS.ProcessEnv;
  call?: DockerCall;
}

/** The one way anything reaches docker: checkDockerArgs, then refused when the argv carries any of `row`'s hidden fields. */
function send(o: DockerOptions, verbs: readonly string[], args: string[], row: TaskRow | null, timeoutMs: number, input?: Buffer): Sent {
  checkDockerArgs(args, verbs);
  if (row) {
    const leaks = hiddenLeaks(args.join('\n'), row);
    if (leaks.length) throw new Error(`refused: this docker command would carry the task's hidden ${leaks.join(', ')}`);
  }
  return (o.call ?? spawnDocker)(o.docker, args, { env: dockerEnv(o.env), timeoutMs, ...(input ? { input } : {}) });
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
 * PidsLimit) and, when the container runs (`cgroup`: its memory.max, cpu.max and pids.max), the kernel's.
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
    const [mem, cpu, pids] = cgroup.split('\n').map((s) => s.trim());
    if (mem !== String(l.memoryBytes)) missing.push('memory (memory.max)');
    const [quota, period] = (cpu ?? '').split(/\s+/).map(Number);
    if (!quota || !period || Math.abs(quota / period - l.cpus) > 0.01) missing.push('cpu (cpu.max)');
    if (pids !== String(l.pids)) missing.push('pids (pids.max)');
  }
  if (missing.length) throw new LimitsNotApplied(`not run: the container's ${[...new Set(missing)].join(', ')} limit did not apply (the ${missing[0]!.split(' ')[0]} cgroup controller is not delegated to this user?): ${DELEGATE}`);
}

const CGROUP_READ = ['cat', '/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/cpu.max', '/sys/fs/cgroup/pids.max'];
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
  ) {}

  /** argv in the container, in `cwd` (under WORK), with only `env` beyond the image's own. */
  exec(cwd: string, argv: readonly string[], env: Record<string, string> = {}, timeoutMs = 15 * 60_000, input?: Buffer): Sent {
    if (!argv.length) throw new Error('nothing to run');
    const args = ['exec', ...(input ? ['--interactive'] : []), '--workdir', posix.normalize(cwd), ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]), this.c.name, ...argv];
    return send(this.o, ['exec'], args, this.row, timeoutMs, input);
  }

  /** Replace `dst` (under WORK) in the container with the tree in `tar` (a tar stream of a worktree's files). */
  syncTree(dst: string, tar: Buffer): Sent {
    const d = posix.normalize(dst);
    if (!d.startsWith(`${WORK}/`)) throw new Error(`sync target ${dst} is not under ${WORK}`);
    return this.exec(WORK, ['sh', '-c', 'rm -rf -- "$1" && mkdir -p -- "$1" && tar -x -f - -C "$1"', 'sh', d], {}, 10 * 60_000, tar);
  }
}
