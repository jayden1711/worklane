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
//
// `select` (#748, slice 3) writes the pinned task selection's manifest into the held-out store (select.ts), as the
// bench user only. It takes no argument either: the rule, the seed and the rows' digest come from the pins file, the
// rows and the images from the store, so no instance id, seed or count is ever typed into a shell (whose history the
// agents may read). It prints keys, counts and digests, and the smoke run's plan; never an instance id. As a backstop,
// scrub(), which every printed line goes through, first withholds every word shaped like an instance id or an instance
// image name (pins.ts TASK_SHAPE), in any of its decoded, normalised or look-alike spellings (withholdTasks), whoever
// writes it, before it splits or cuts anything.
//
// `images` (#748, slice 4) writes each selected task's image reference into the held-out store (images.ts), as the
// bench user only, after `select`. It takes no argument either: the tasks come from the store's manifest, each name
// from the task's own instance id under SWE-bench's naming, each digest from the registry's manifest for that name,
// taken only when pins.json pins it. It prints keys, counts and digests, never an instance id or an image name.
//
// `pull --tasks smoke|baseline` (#748, slice 4) pulls that task set's images by their pinned digests and reads each
// back, then puts each task's base tree in the held-out store, copied out of its image's /testbed through the bench's
// own container runner (pull.ts): a bare remote with one commit and a clone of it. `--tasks` is the one argument, and
// it is required: the same choice `bench run` makes, never a default. It prints keys and counts only.
import { realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { redactString } from '../../src/events/redact.js';
import { currentUser } from '../../src/os/index.js';
import { benchLane, runtimeDir } from './agent.js';
import { LOGIN_SWITCH_VAR, requireBenchUser, requireClaudePin, requireSubscription } from './auth.js';
import { isMode, MODE_MAX_USD, PER_TASK_MAX_USD, REAPPROVE_MEAN_USD, type Mode } from './caps.js';
import { Docker, limitsFrom, type DockerOptions, type Limits } from './container.js';
import { downloadDataset, httpsFetcher, type Fetcher } from './download.js';
import { assertResearchOff, BENCH_SETTINGS } from './driver.js';
import { httpsRegistry, writeImages, type ImagesSummary, type RegistryFetch } from './images.js';
import { benchHome, benchRoot, type BenchLayout } from './paths.js';
import { loadPins, PINS_FILE, TASK_SHAPE, type Pins } from './pins.js';
import { sandboxProbe, SRT_LABEL } from './probe.js';
import { baseTree, pullTasks, Refused, TREE_CAPS, TREES, type TreeCaps } from './pull.js';
import { loadTasks, MODE_TASKS, RowsUnpinned, writeSelection, type SelectedTask, type SelectionSummary } from './select.js';
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
  /** `images`' one registry request at a time (default: Node's fetch, to the registry only; tests pass a stand-in). */
  registry?: RegistryFetch;
}

export type CheckStatus = 'PASS' | 'FAIL' | 'SKIP';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

/** A variable whose value may be a credential (container.ts SECRET_NAME without the daemon's names, which are paths). */
const SECRET_VAR = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE|SESSION/i;
/**
 * An email address: its domain ends in a letters-only label, so a package spec such as `name@0.0.79` is not one. Read
 * after the token masks, so a mask may stand in a label (`x@wld_[redacted].com`): the address is still found.
 */
const EMAIL = /(?:[\w.+-]|\[redacted\])+@(?:[\w-]|\[redacted\])+(?:\.(?:[\w-]|\[redacted\])+)*\.[A-Za-z]{2,}\b/g;
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
 * every control character (an ANSI escape's ESC, a bell, a line break) a space; a format character (a zero-width
 * space, a bidi override) is dropped, before the token shapes are looked for. Cut to at most `max`
 * characters only after all of that.
 *
 * INVARIANT (#884 round 2): first of all, every word shaped like a task is withheld (withholdTasks), on the text as it
 * came: before anything here turns a format character into a space (which would split the word) or cuts the text (which
 * would leave a prefix). Every caller's scrub() withholds, not only the sink's.
 */
export function scrub(text: string, env: NodeJS.ProcessEnv, max = DETAIL_MAX): string {
  let s = withholdTasks(text);
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
  // A format character (a zero-width space, a bidi override) is dropped before the token shapes are looked for, so it
  // can't split one (#889 round 3). Then the shared redactor, its broad rules too (a token cut short, a value after a
  // secret's name); it finds a token right after an ANSI escape itself (its glue points). Then emails, as before, and
  // every control character becomes a space.
  s = redactString(s.replace(/\p{Cf}/gu, ''), { broad: true, mask: '[redacted]' }).replace(EMAIL, '[email]').replace(/\p{Cc}/gu, ' ');
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** What a word shaped like an instance id or an instance image name prints as. */
export const WITHHELD = '[task withheld]';

/** An instance id's tail (`__repo-1234`), whatever comes before it: a word may start there (a space split it off). */
const TASK_TAIL = /__[A-Za-z0-9_.-]*-\d/;
const FORMAT = /[\p{Cc}\p{Cf}]/gu;
const NON_ASCII = /[^\x00-\x7f]/gu;

/** What a word too long to judge prints as (#884 round 3): withheld unjudged, so judging stays linear and fails closed. */
export const WITHHELD_LONG = '[word too long to check: withheld]';
/** The longest word judged; a longer one is withheld. An instance id or image name is far shorter. */
export const WORD_MAX = 512;
/** The most rounds of decoding; a word that still decodes to something new after them is withheld. */
export const DECODE_ROUNDS = 16;

/** The character with code point `n`, or `?` for a number that isn't a code point. */
const codePoint = (n: number): string => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '?');

/** The named HTML entities for the characters an id or image name is made of besides letters and digits. */
const NAMED: Readonly<Record<string, string>> = {
  lowbar: '_',
  UnderBar: '_',
  underbar: '_',
  hyphen: '-',
  dash: '-',
  minus: '-',
  ndash: '-',
  mdash: '-',
  horbar: '-',
  hybull: '-',
  period: '.',
  sol: '/',
  commat: '@',
  colon: ':',
};

/**
 * `w` with one round of escapes decoded: percent escapes, `\uXXXX`, `\u{X}`, `\xXX`, numeric entities (`&#N;`, `&#xX;`,
 * the `;` optional), and the named entities in NAMED (`&lowbar;`, `&hyphen;`, ...).
 */
const unescapeOnce = (w: string): string =>
  w
    .replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => codePoint(parseInt(h, 16)))
    .replace(/\\u\{([0-9A-Fa-f]{1,6})\}/g, (_, h: string) => codePoint(parseInt(h, 16)))
    .replace(/\\u([0-9A-Fa-f]{4})/g, (_, h: string) => codePoint(parseInt(h, 16)))
    .replace(/\\x([0-9A-Fa-f]{2})/g, (_, h: string) => codePoint(parseInt(h, 16)))
    .replace(/&#[xX]([0-9A-Fa-f]{1,6});?/g, (_, h: string) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d{1,7});?/g, (_, d: string) => codePoint(parseInt(d, 10)))
    .replace(/&([A-Za-z]+);/g, (all, name: string) => (Object.hasOwn(NAMED, name) ? NAMED[name]! : all));

/** Each non-ASCII character read by its own role (#884 round 3): a dash as `-`, other punctuation, a symbol or a modifier letter as `_`, a digit as `0`, another letter as `a`, a mark dropped. */
const byRole = (s: string): string =>
  s.replace(NON_ASCII, (ch) =>
    /\p{M}/u.test(ch) ? '' : /\p{Pd}/u.test(ch) ? '-' : /[\p{P}\p{S}\p{Lm}]/u.test(ch) ? '_' : /[\p{Nd}\p{No}]/u.test(ch) ? '0' : /\p{L}/u.test(ch) ? 'a' : '_',
  );

/**
 * The spellings a word is judged in (#884 rounds 2 and 3), or null when it still decodes to something new after
 * DECODE_ROUNDS (withheld): as written, and each round of decoding until it is stable; each with its control and format
 * characters taken out, as is, NFKC-normalised (fullwidth `＿` is `_`) and with its combining marks taken out (NFD); and,
 * where non-ASCII is left, each such character read as a possible look-alike: all as `_`, all as `-`, all as `a`, all
 * as `0`, and each by its own role (byRole).
 */
function spellings(word: string): string[] | null {
  const forms = [word];
  for (;;) {
    const next = unescapeOnce(forms.at(-1)!);
    if (next === forms.at(-1)) break;
    if (forms.length > DECODE_ROUNDS) return null;
    forms.push(next);
  }
  const out = new Set<string>();
  for (const f of forms) {
    const bare = f.replace(FORMAT, '');
    // Before NFKC too: it can turn one look-alike into several characters (U+2017 is a space and a combining mark).
    for (const s of [bare, bare.normalize('NFKC').replace(FORMAT, ''), bare.normalize('NFD').replace(/\p{M}/gu, '')]) {
      out.add(s);
      if (!/[^\x00-\x7f]/.test(s)) continue;
      for (const c of ['_', '-', 'a', '0']) out.add(s.replace(NON_ASCII, c));
      out.add(byRole(s));
    }
  }
  return [...out];
}

/** The loose reading's placeholders: ANY stands for any non-ASCII character but a digit or a mark; DIGIT for a non-ASCII digit. */
const ANY = '\x01';
const DIGIT = '\x02';

/**
 * `s` read loosely (#884 round 4): every non-ASCII character that is neither a digit nor a mark (a letter, punctuation, a
 * symbol, a format, private-use or unassigned character), and every control character, becomes ANY; a non-ASCII digit
 * becomes DIGIT; a mark is dropped. looseShaped lets ANY fill any `_` place, any `-` place, any place in the repo's name,
 * and places in the digit run, so no look-alike needs a role picked for it: the class is closed by construction.
 */
const loose = (s: string, digit = DIGIT): string =>
  s.replace(/[^\x20-\x7e]/gu, (ch) => (/\p{M}/u.test(ch) ? '' : /[\p{Nd}\p{No}]/u.test(ch) ? digit : ANY));

/**
 * The loose readings of `s` (#884 round 5). A combining mark can stand for a character too (`̲` drawn as `_`), so marks
 * are read three ways: dropped (loose), each mark as ANY, and each character carrying marks, with its marks, as one ANY
 * (`l̲` drawn as `_`). And a non-ASCII digit can stand for a separator, so one more reading takes digits as ANY. With
 * these, every non-ASCII character, whatever its kind, can fill any `_` or `-` place in some reading.
 */
const looseReadings = (s: string): string[] => [loose(s), loose(s.replace(/\p{M}/gu, ANY)), loose(s.replace(/[^\p{M}]\p{M}+/gu, ANY)), loose(s, ANY)];

/**
 * `_1776_`, an instance image name's mark, read loosely: ANY in an underscore's place, DIGIT in a digit's, and any ANYs
 * between them (#884 round 6: a mark on one digit, read as ANY), as the tail scan allows. Each `\x01*` ends at the next
 * fixed class, and words are at most WORD_MAX long.
 */
const LOOSE_1776 = /[_\x01]\x01*[1\x02]\x01*[7\x02]\x01*[7\x02]\x01*[6\x02]\x01*[_\x01]/;

/**
 * Whether `s` (a loose reading) holds an instance id's tail, in linear time: two underscore places (`_` or ANY), then
 * repo characters (letters, digits, `_`, `.`, `-`, ANY, DIGIT), then a hyphen place (`-` or ANY), then any ANYs, then
 * a digit (an ASCII digit or DIGIT). TASK_SHAPE's first form holds such a tail, so this covers it too.
 */
function looseTail(s: string): boolean {
  const n = s.length;
  const isU = (c: string) => c === '_' || c === ANY;
  const isH = (c: string) => c === '-' || c === ANY;
  const isD = (c: string) => (c >= '0' && c <= '9') || c === DIGIT;
  const isR = (c: string) => /[A-Za-z0-9_.-]/.test(c) || c === ANY || c === DIGIT;
  // fromHere[x]: from x on, repo characters lead to a hyphen place that ANYs and then a digit follow.
  const fromHere = new Array<boolean>(n + 1).fill(false);
  let anysThenDigit = false;
  for (let x = n - 1; x >= 0; x--) {
    const c = s[x]!;
    const hyphenHere = isH(c) && anysThenDigit;
    fromHere[x] = isR(c) && (hyphenHere || fromHere[x + 1]!);
    anysThenDigit = isD(c) || (c === ANY && anysThenDigit);
  }
  for (let i = 0; i + 2 <= n; i++) if (isU(s[i]!) && isU(s[i + 1]!) && fromHere[i + 2]) return true;
  return false;
}

/**
 * Whether `word` is, in any of its spellings, shaped like an instance id or an instance image name, or holds an id's
 * tail, read exactly or loosely; also true (fail closed) for a word it can't judge: longer than WORD_MAX, or still
 * decoding after DECODE_ROUNDS.
 */
export function taskShaped(word: string): boolean {
  if (word.length > WORD_MAX) return true;
  const all = spellings(word);
  if (all === null || all.some((s) => TASK_SHAPE.test(s) || TASK_TAIL.test(s))) return true;
  // The loose reading, of each decoded form as it came (format characters kept, as ANY) and of each spelling.
  const forms = new Set<string>(all);
  for (let f = word, i = 0; i <= DECODE_ROUNDS; i++) {
    forms.add(f);
    forms.add(f.normalize('NFKC'));
    const next = unescapeOnce(f);
    if (next === f) break;
    f = next;
  }
  for (const s of forms) {
    for (const l of looseReadings(s)) if (LOOSE_1776.test(l) || looseTail(l)) return true;
  }
  return false;
}

/**
 * `text` with every word (between spaces) that is taskShaped replaced: by WITHHELD_LONG when it is over WORD_MAX
 * characters (never judged, so the check stays linear in the text's length), otherwise by WITHHELD. The whole word, so
 * no piece of it is left. scrub() runs it first, so every line printed, whoever writes it, goes through it before
 * anything splits or cuts a word. What no word-level match can catch (an id split across a real space, or base64) is
 * covered only by the protection by design: the bench's messages are built from keys, never from an instance id.
 */
export function withholdTasks(text: string): string {
  return text
    .split(/(\s+)/)
    .map((w) => (!w || /^\s+$/.test(w) ? w : w.length > WORD_MAX ? WITHHELD_LONG : taskShaped(w) ? WITHHELD : w))
    .join('');
}

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
  '  select      the tasks the pinned rule and seed choose from the pinned rows, as a manifest in the held-out store,',
  "              and the smoke run's plan. Takes no argument: prints keys (t01, ...), never an instance id.",
  "  images      each selected task's image reference (its own name, at a pinned digest the registry serves for it) into",
  '              the held-out store, after bench select. Takes no argument: prints keys, counts and digests only. No image is pulled.',
  '  pull --tasks smoke|baseline',
  "              that task set's images, by their pinned digests only (never a tag), each read back; then each task's base",
  "              tree, copied out of its image's /testbed (no upstream fetch) into the held-out store as a bare remote with one",
  '              commit and a clone of it. After bench images. --tasks is required. Prints keys and counts only.',
  '  help        this text',
];

/** What `bench pull` says about its one argument when it is anything else. */
export const PULL_ARGS = 'pull takes --tasks smoke or --tasks baseline (the task set bench run will take), and nothing else';

/** The smoke run's plan, for `bench select`: keys and caps only. */
export function smokePlan(keys: readonly string[]): string[] {
  const smoke = keys.slice(0, MODE_TASKS.smoke);
  return [
    `smoke run plan: tasks ${smoke.join(' ')} (the first ${MODE_TASKS.smoke} of the ${keys.length}; the baseline runs ${keys[0]}..${keys.at(-1)}, with the same rule and seed, and again on each release)`,
    `  caps: at most $${MODE_MAX_USD.smoke} for the round (--spend), $${PER_TASK_MAX_USD} per task; a round averaging over $${REAPPROVE_MEAN_USD} per task needs the owner's re-approval before the baseline`,
    '  the run takes its tasks from the held-out store (the manifest, the rows, the images file): no instance id or image name on any command line',
    "  task setup (slice 4): bench images, then bench pull --tasks smoke (the images by digest, and each task's base tree in the store)",
    "  still to come before it can run: the engine's runner seam and the test relay (slices 5 and 6, #701), and bench run (slice 7)",
  ];
}

/**
 * `bench images`: as the bench user, every selected task's image reference into the held-out store (images.ts), then
 * the run's own check of it (loadTasks, smoke and baseline). Prints keys, counts and digests only. Its exit code.
 */
export async function images(d: CliDeps, pins: () => Pins = loadPins): Promise<number> {
  d.out("bench images (#748): each selected task's pinned image reference into the held-out store; registry manifests only: no image pulled, no container, no model call");
  const say = (status: string, name: string, detail: string) => d.out(`  ${status}  ${name.padEnd(9)}  ${scrub(detail, d.env)}`);
  let layout: BenchLayout;
  let p: Pins;
  let s: ImagesSummary;
  try {
    requireBenchUser(d.env, d.user, d.uid, d.euid);
    layout = benchRoot(d.env, benchHome(d.env, d.passwdHome));
    p = pins();
    s = await writeImages(layout, d.uid, p, d.registry ?? httpsRegistry);
  } catch (e) {
    say('FAIL', 'images', message(e));
    return 1;
  }
  say('PASS', 'images', `${s.keys.length} tasks, ${s.keys[0]}..${s.keys.at(-1)}: each a pinned digest under its own task's name; the images file (0600, in the store) ${s.written ? 'written' : 'was already there, the same: kept'}, sha256 ${s.sha256}`);
  try {
    const smoke = loadTasks(layout, d.uid, p, 'smoke');
    const baseline = loadTasks(layout, d.uid, p, 'baseline');
    say('PASS', 'run check', `the run takes it: the smoke's ${smoke.map((t) => t.key).join(' ')}, and the baseline's ${baseline.length} tasks`);
  } catch (e) {
    say('FAIL', 'run check', message(e));
    return 1;
  }
  d.out('  next: bench select now passes every line; then bench pull --tasks smoke pulls the images and puts each base tree in the store');
  return 0;
}

/**
 * `bench pull --tasks <mode>`: as the bench user, the task set's images pulled by their pinned digests and read back
 * (pull.ts pullTasks), then each task's base tree into the held-out store (pull.ts baseTree), one task at a time,
 * stopping at the first refusal. Prints keys and counts only. Its exit code.
 */
export async function pull(d: CliDeps, mode: Mode, pins: () => Pins = loadPins, capsIn: Partial<TreeCaps> = {}): Promise<number> {
  // Tests lower a cap; anything they don't name is the bench's own (TREE_CAPS).
  const caps: TreeCaps = { ...TREE_CAPS, ...capsIn };
  d.out(`bench pull (#748): the ${mode} tasks' images by pinned digest, and each task's base tree from its own image into the held-out store; no model call, no upstream fetch`);
  const say = (status: string, name: string, detail: string) => d.out(`  ${status}  ${name.padEnd(9)}  ${scrub(detail, d.env)}`);
  const o: DockerOptions = { ...d.docker, env: d.env };
  let layout: BenchLayout;
  let p: Pins;
  let tasks: readonly SelectedTask[];
  try {
    if (!isMode(mode)) throw new Error(PULL_ARGS);
    requireBenchUser(d.env, d.user, d.uid, d.euid);
    layout = benchRoot(d.env, benchHome(d.env, d.passwdHome));
    p = pins();
    tasks = loadTasks(layout, d.uid, p, mode);
  } catch (e) {
    say('FAIL', 'tasks', message(e));
    return 1;
  }
  say('PASS', 'tasks', `${mode}: ${tasks.map((t) => t.key).join(' ')}, each a pinned digest under its own task's name (the store's images.json)`);
  let docker: Docker;
  try {
    docker = new Docker(o, d.host ? limitsFrom(d.env, d.host) : limitsFrom(d.env));
    docker.preflight();
  } catch (e) {
    say('FAIL', 'docker', message(e));
    return 1;
  }
  say('PASS', 'docker', "this user's daemon is rootless; every container gets the limits, read back before anything runs in it");
  try {
    pullTasks(layout, d.uid, p, mode, o, tasks);
  } catch (e) {
    // pullTasks' own refusals name keys only; anything else (loadTasks' again) names keys too.
    say('FAIL', 'pull', message(e));
    return 1;
  }
  say('PASS', 'pull', `${tasks.length} images pulled by digest, none by tag; each digest read back as images.json and pins.json give it`);
  for (const t of tasks) {
    try {
      const r = await baseTree(layout, d.uid, t, o, docker, caps);
      say('PASS', t.key, `base tree: /testbed's tree at base_commit (HEAD checked, bound by its commit's hash), its tree hash recorded; a bare remote with one commit and a clone of it, in the store${r.kept ? ' (already there, verified: kept)' : ''}`);
    } catch (e) {
      say('FAIL', t.key, e instanceof Refused ? e.message : "its base tree was refused (the store's check failed): nothing kept");
      return 1;
    }
  }
  say('PASS', 'trees', `${tasks.length} base trees in the store (${TREES}/<key>/), none with upstream history`);
  d.out(`  next: the ${mode} run's task setup is done; bench run (still to come) copies each task's tree into its own folder`);
  return 0;
}

/** `bench select`: as the bench user, the pinned selection into the held-out store, and the smoke's plan. Its exit code. */
export function select(d: CliDeps, pins: () => Pins = loadPins): number {
  d.out('bench select (#748): the pinned task selection into the held-out store; no container, no model call, no download');
  const say = (status: string, name: string, detail: string) => d.out(`  ${status}  ${name.padEnd(9)}  ${scrub(detail, d.env)}`);
  let layout: BenchLayout;
  let p: Pins;
  let s: SelectionSummary;
  try {
    requireBenchUser(d.env, d.user, d.uid, d.euid);
    layout = benchRoot(d.env, benchHome(d.env, d.passwdHome));
    p = pins();
    s = writeSelection(layout, d.uid, p);
  } catch (e) {
    if (e instanceof RowsUnpinned) say('FAIL', 'rows', e.message);
    else say('FAIL', 'selection', message(e));
    return 1;
  }
  say('PASS', 'rows', `${s.rows} rows, canonical sha256 ${s.rowsSha256} (the pinned one), from the dataset at revision ${s.revision}`);
  say('PASS', 'selection', `rule ${s.rule}, seed ${s.seed}: ${s.keys.length} tasks, ${s.keys[0]}..${s.keys.at(-1)}; the manifest (0600, in the store) ${s.written ? 'written' : 'was already there, the same: kept'}`);
  let ok = true;
  try {
    const tasks = loadTasks(layout, d.uid, p, 'smoke');
    say('PASS', 'images', `the smoke's ${tasks.map((t) => t.key).join(' ')}: each a pinned digest, under its own task's name (the baseline's are checked when it runs)`);
  } catch (e) {
    ok = false;
    say('FAIL', 'images', message(e));
  }
  for (const l of smokePlan(s.keys)) d.out(l);
  return ok ? 0 : 1;
}

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
    ...(deps.registry ? { registry: deps.registry } : {}),
    // INVARIANT: the only way out: every line, whoever writes it, is scrubbed on its full text before any cut (#851 round 2),
    // and has every word shaped like a task withheld first (#748 slice 3; scrub() does that before anything else).
    out: (l) => sink(scrub(l, env, LINE_MAX)),
  };
  const [command, ...extra] = argv;
  if (command === 'help' || command === '--help') {
    for (const l of USAGE) d.out(l);
    return 0;
  }
  if (command === 'preflight' && extra.length === 0) return printPreflight(d);
  if (command === 'download' && extra.length === 0) return download(d);
  if (command === 'select' && extra.length === 0) return select(d);
  if (command === 'images' && extra.length === 0) return images(d);
  if (command === 'pull') {
    // Exactly `--tasks <mode>`: never a default, and nothing else (an argument would sit in the shell's history).
    if (extra.length === 2 && extra[0] === '--tasks' && isMode(extra[1])) return pull(d, extra[1]);
    d.out(PULL_ARGS);
    for (const l of USAGE) d.out(l);
    return 2;
  }
  const takesNone = command === 'preflight' || command === 'download' || command === 'select' || command === 'images';
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
