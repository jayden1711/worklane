// The bench command (#748): `node dist/scripts/bench/cli.js <command>`, run as the bench user from its own clone.
// `preflight` runs every check the driver makes before a run that needs no model call and no container, one line per
// check (PASS, FAIL or SKIP), and exits 0 only when all pass. It is what the owner runs after the one-time setup
// (README) and before the first smoke round.
//
// What it never does: start a container, make a model call, download anything, or keep anything on disk (the
// held-out store is only lstat'ed; the bench root isn't made; the srt probe's settings file is a 0600 temporary file,
// removed when srt ends, probe.ts). The bench user check and the home check come first, and when
// either fails nothing else runs: as another user, the login check would ask that user's claude about that user's
// login, and the srt probe would try that user's sockets and files. The sandbox confirmation (one model call) and the
// limits read back from a probe container (which needs a task image) stay the run's: the output says so.
//
// What it prints carries no secret (owner, 2026-10-19): main() wraps the one output sink in scrub(), so every line,
// whoever writes it, is scrubbed on its full text before it is cut. scrub() drops the value of every variable whose
// name may hold a credential or switch the login and each piece of such a value that starts or ends it (a message
// cut short upstream ends in one), token-shaped strings, email addresses and control characters. The checks themselves print no variable's value and no field of the
// login but its method and plan.
//
// `download` (#748, slice 2) fetches the pinned dataset file into the held-out store (download.ts), as the bench user
// only, with the pins from scripts/bench/pins.json and nowhere else: it takes no argument. It starts no container and
// makes no model call.
import { realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { currentUser } from '../../src/os/index.js';
import { benchLane, runtimeDir } from './agent.js';
import { LOGIN_SWITCH_VAR, requireBenchUser, requireClaudePin, requireSubscription } from './auth.js';
import { MODE_MAX_USD, PER_TASK_MAX_USD, REAPPROVE_MEAN_USD } from './caps.js';
import { Docker, limitsFrom, type DockerOptions, type Limits } from './container.js';
import { downloadDataset, httpsFetcher, type Fetcher } from './download.js';
import { assertResearchOff, BENCH_SETTINGS } from './driver.js';
import { benchHome, benchRoot, type BenchLayout } from './paths.js';
import { loadPins, PINS_FILE, type Pins } from './pins.js';
import { sandboxProbe, SRT_LABEL } from './probe.js';
import { heldOutCheck } from './store.js';

export interface CliDeps {
  env: NodeJS.ProcessEnv;
  /** This process's user name, real uid and effective uid. */
  user: string;
  uid: number;
  euid: number;
  /** This user's home in the user database (its passwd entry). */
  passwdHome: () => string;
  /** The claude and srt binaries (default: from PATH, as the driver runs them). */
  claude: string;
  srt: string;
  /** The driver's docker (default: the docker CLI from PATH). */
  docker: DockerOptions;
  /** This machine's CPUs and memory, for the limits' check (default: os.cpus(), os.totalmem()). */
  host?: { cpus: number; memoryBytes: number };
  /** Where each line goes (default: stdout). Every line is scrubbed first. */
  out: (line: string) => void;
  /** `download`'s one HTTP request at a time (default: Node's fetch, no redirect followed; tests pass a stand-in). */
  fetch?: Fetcher;
}

export type CheckStatus = 'PASS' | 'FAIL' | 'SKIP';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

/** A variable whose value may be a credential (container.ts SECRET_NAME without the daemon's names, which are paths). */
const SECRET_VAR = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE|SESSION/i;
/** Token shapes: Anthropic keys and OAuth tokens, GitHub tokens, Slack tokens, AWS key ids, JWTs. */
const TOKEN_SHAPE = /sk-ant-[\w-]+|\bgh[opsur]_\w{16,}|\bgithub_pat_\w{16,}|\bxox[abprs]-[\w-]+|\bAKIA[0-9A-Z]{16}\b|\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+/g;
/** An email address: its domain ends in a letters-only label, so a package spec such as `name@0.0.79` is not one. */
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/g;
/** What scrub() keeps of one detail, and of one printed line. */
export const DETAIL_MAX = 400;
const LINE_MAX = 1000;
/** The shortest piece of a secret value scrub() redacts on its own. */
export const PIECE_MIN = 6;
/** A value that is a path or a socket address, not a secret: only its whole value is redacted, never its pieces. */
const PATH_VALUE = /^(\/|unix:)/;

/**
 * `text` fit to print. Redacted, as [redacted]: the value of every variable in `env` whose name may hold a credential
 * or switch the login (PIECE_MIN characters or more), and every piece of such a value of PIECE_MIN or more that starts
 * or ends it (#851 round 2: a message cut short upstream, as the driver's checks cut a child's stderr, ends in a
 * prefix of the value; this redacts it whatever cut it); every token-shaped string. Email addresses become [email];
 * control and format characters (an ANSI escape's ESC, a bell, a bidi override) a space. Cut to at most `max`
 * characters only after all of that.
 */
export function scrub(text: string, env: NodeJS.ProcessEnv, max = DETAIL_MAX): string {
  let s = text;
  const values = Object.entries(env)
    .filter(([k, v]) => typeof v === 'string' && v.length >= PIECE_MIN && (SECRET_VAR.test(k) || LOGIN_SWITCH_VAR.test(k.toUpperCase())))
    .map(([, v]) => v as string)
    .sort((a, b) => b.length - a.length);
  for (const v of values) s = s.split(v).join('[redacted]');
  for (const v of values) {
    if (PATH_VALUE.test(v)) continue;
    // Longest piece first, so a long prefix is redacted whole, not a shorter one inside it.
    for (let n = Math.min(v.length - 1, s.length); n >= PIECE_MIN; n--) {
      for (const piece of [v.slice(0, n), v.slice(v.length - n)]) if (s.includes(piece)) s = s.split(piece).join('[redacted]');
    }
  }
  s = s.replace(TOKEN_SHAPE, '[redacted]').replace(EMAIL, '[email]').replace(/[\p{Cc}\p{Cf}]/gu, ' ');
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// The held-out store's check lives with the store (store.ts): `bench download` runs it too.
export { heldOutCheck };

/** Every model-free, container-free check, in order. The user and home checks gate all the others. */
export function preflight(d: CliDeps): Check[] {
  const checks: Check[] = [];
  const add = (name: string, f: () => string): boolean => {
    try {
      checks.push({ name, status: 'PASS', detail: f() });
      return true;
    } catch (e) {
      checks.push({ name, status: 'FAIL', detail: message(e) });
      return false;
    }
  };
  const skip = (names: readonly string[], why: string) => {
    for (const name of names) checks.push({ name, status: 'SKIP', detail: why });
  };
  const rest = ['bench root', 'held-out store', 'research-on-demand', 'claude pin', 'claude login', 'sandbox probe', 'docker', 'container limits'];

  if (!add('bench user', () => requireBenchUser(d.env, d.user, d.uid, d.euid))) {
    skip(['home', ...rest], 'not run: not the bench user (it would ask another user\'s login and probe another home)');
    return checks;
  }
  let home = '';
  if (!add('home', () => (home = benchHome(d.env, d.passwdHome)))) {
    skip(rest, "not run: HOME isn't the bench user's (claude would follow it to another login)");
    return checks;
  }
  let layout: BenchLayout | undefined;
  add('bench root', () => (layout = benchRoot(d.env, home)).root);
  if (layout) {
    const l = layout;
    add('held-out store', () => heldOutCheck(l, d.uid));
  } else skip(['held-out store'], 'not run: no bench root');
  add('research-on-demand', () => (assertResearchOff(BENCH_SETTINGS), 'off: every research cap is 0'));
  add('claude pin', () => `${requireClaudePin(d.env, d.claude)}, updates off`);
  add('claude login', () => {
    const login = requireSubscription(d.env, d.claude, home);
    return `${login.method}, plan ${login.subscription_type ?? 'not reported'}`;
  });
  if (layout) {
    const l = layout;
    add('sandbox probe', () => {
      const input = { home, runtimeDir: runtimeDir(d.env, d.uid), heldOut: l.heldOut, state: l.state, dockerHost: d.env.DOCKER_HOST, dataHome: d.env.XDG_DATA_HOME };
      const report = sandboxProbe({ ...input, settings: benchLane(input).settings, srt: d.srt });
      return `every attempt refused (${report.results.length}), under ${SRT_LABEL}`;
    });
  } else skip(['sandbox probe'], 'not run: no bench root (the lane denies its state and held-out store)');
  let limits: Limits | undefined;
  const limitsCheck = () => {
    limits = d.host ? limitsFrom(d.env, d.host) : limitsFrom(d.env);
    return `${limits.memoryBytes} bytes of memory (no extra swap), ${limits.cpus} CPUs, ${limits.pids} pids; read back from a probe container when the run starts`;
  };
  // INVARIANT: Docker.preflight sends `docker info` only: no container, and the limits it is built with are unused.
  add('docker', () => {
    new Docker({ ...d.docker, env: d.env }, { memoryBytes: 1, cpus: 1, pids: 1 }).preflight();
    return "this user's daemon is rootless, reached through an absolute DOCKER_HOST";
  });
  add('container limits', limitsCheck);
  return checks;
}

const USAGE = [
  'usage: node dist/scripts/bench/cli.js <command>   (as the bench user, from its own clone; scripts/bench/README.md)',
  '',
  '  preflight   the checks a run makes before any model call or container: one PASS/FAIL/SKIP line each;',
  '              exits 0 only when all pass. Starts no container, makes no model call, downloads nothing, keeps nothing on disk.',
  '  download    the dataset file at the revision and sha256 pinned in scripts/bench/pins.json, into the held-out',
  '              store (0700; the file 0600), verified before it is kept. Takes no argument: only that file sets a pin.',
  '  help        this text',
];

/** `bench download`: as the bench user, the pinned dataset into the held-out store. Its exit code. */
export async function download(d: CliDeps, pins: () => Pins = loadPins): Promise<number> {
  d.out('bench download (#748): the pinned dataset into the held-out store; no container, no model call');
  try {
    requireBenchUser(d.env, d.user, d.uid, d.euid);
    const layout = benchRoot(d.env, benchHome(d.env, d.passwdHome));
    const pin = pins().dataset;
    if (!pin) throw new Error(`the dataset is not pinned yet: ${PINS_FILE} has no revision and sha256 (the owner records both); nothing fetched`);
    const r = await downloadDataset(layout, d.uid, pin, d.fetch ?? httpsFetcher);
    d.out(`  PASS  dataset  ${r.fetched ? 'downloaded and verified' : 'already there, verified'}: sha256 ${pin.sha256} at revision ${pin.revision}, ${r.bytes} bytes, ${r.file} (0600)`);
    return 0;
  } catch (e) {
    d.out(`  FAIL  dataset  ${scrub(message(e), d.env)}`);
    return 1;
  }
}

function printPreflight(d: CliDeps): number {
  const say = d.out;
  say('bench preflight (#748): no container, no model call, no download, nothing kept on disk');
  const checks = preflight(d);
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) say(`  ${c.status}  ${c.name.padEnd(width)}  ${scrub(c.detail, d.env)}`);
  say(`approved caps: $${MODE_MAX_USD.smoke} per smoke round, $${PER_TASK_MAX_USD} per task; a smoke averaging over $${REAPPROVE_MEAN_USD} per task needs the owner's re-approval before the baseline`);
  say("left to the run: the containers' limits read back from a probe container (it needs a task image), and the sandbox confirmation, the run's first model call");
  const failed = checks.filter((c) => c.status === 'FAIL').length;
  const skipped = checks.filter((c) => c.status === 'SKIP').length;
  say(failed || skipped ? `preflight: ${failed} of ${checks.length} checks failed${skipped ? `, ${skipped} not run` : ''}` : `preflight: all ${checks.length} checks passed`);
  return failed || skipped ? 1 : 0;
}

/** The bench command; its exit code (`download`'s once it ends). */
export function main(argv: readonly string[], deps: Partial<CliDeps> = {}): number | Promise<number> {
  const env = deps.env ?? process.env;
  const sink = deps.out ?? ((l: string) => process.stdout.write(`${l}\n`));
  const d: CliDeps = {
    env,
    user: deps.user ?? currentUser(),
    uid: deps.uid ?? process.getuid?.() ?? -1,
    euid: deps.euid ?? process.geteuid?.() ?? -1,
    passwdHome: deps.passwdHome ?? (() => userInfo().homedir),
    claude: deps.claude ?? 'claude',
    srt: deps.srt ?? 'srt',
    docker: deps.docker ?? { docker: 'docker' },
    ...(deps.host ? { host: deps.host } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    // INVARIANT: the only way out: every line, whoever writes it, is scrubbed on its full text before any cut (#851 round 2).
    out: (l) => sink(scrub(l, env, LINE_MAX)),
  };
  const [command, ...extra] = argv;
  if (command === 'help' || command === '--help') {
    for (const l of USAGE) d.out(l);
    return 0;
  }
  if (command === 'preflight' && extra.length === 0) return printPreflight(d);
  if (command === 'download' && extra.length === 0) return download(d);
  const takesNone = command === 'preflight' || command === 'download';
  d.out(command === undefined ? 'no command' : takesNone ? `${command} takes no arguments, not ${scrub(extra.join(' '), env, 200)}` : `unknown command: ${scrub(command, env, 200)}`);
  for (const l of USAGE) d.out(l);
  return 2;
}

// WHY: run as a script only, never on import (the tests import main).
const self = fileURLToPath(import.meta.url);
let invoked = '';
try {
  invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
} catch {
  // not a file: not run as this script
}
if (invoked === self) {
  const code = main(process.argv.slice(2));
  if (typeof code === 'number') process.exitCode = code;
  else void code.then((c) => (process.exitCode = c));
}
