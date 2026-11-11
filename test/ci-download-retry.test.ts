// lint-test
// Every pinned download in CI goes through scripts/ci/fetch-pinned.sh, which retries a transient failure and checks the
// pinned sha256 before the file exists (#1201); every download in the setup and CI scripts retries. WHY: on 2026-11-08
// GitHub release downloads answered 504 for a while, and a single-shot `curl` turned whole PRs red with no test
// failing. The first version of this lint matched text around each curl and failed open on 20 forms (R1228a, R1228b:
// a check that can't fail, a check of another file, the first --retry read instead of the last, flags in a comment, a
// URL in a variable or an env: value, wget). So the retry and the check now live once, in the helper, its behavior is
// tested below with a stub curl, and the lint only has to hold that no pinned URL appears anywhere but on a helper line.
// Scope (owner decision (c), 2026-11-09, narrowed after R1228n/o): the guarantee is the helper's own digest check, for
// the downloads it handles: the bytes it leaves at the name match the pin, against a release asset that was tampered
// with or replaced, or a network attacker. It does NOT protect against code already running in the same job: an
// earlier step, or this one (GITHUB_ENV, GITHUB_PATH, LD_PRELOAD, sudo replacing the runner's tools, names built with
// eval). That is a stated limit, at the end of this file. This lint is a hint that catches the usual accidents (a
// helper bypassed, a pinned URL fetched another way), not a proof that none is left. Structurally, each helper step
// runs in a privileged /usr/bin/bash and names /usr/bin/bash -p (R1228o), so the step's shell takes no function or
// BASH_ENV from the environment and the helper's `bash` is no name a PATH or hash table can redirect.
// One exception, derived from the workflow, not a list: a job whose container can run a pull request's code runs its
// steps as root on the self-hosted runner until it switches to the runner user, and a root step there runs nothing
// from the checkout (desktop-removed.test.ts's RUNS_CHECKOUT). Its downloads stay inline, in one exact curl-and-check
// pair, and the helper is refused there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative } from 'node:path';
import { parse } from 'yaml';
import { BRAND } from '../src/brand.js';
import { repoRoot } from './helpers.js';

/** A pinned binary's URL: a GitHub release asset (download or API form), a raw file, or a vendor host CI fetches pinned binaries from. */
// Case-insensitive, and any run of `/` (R1228i D2: GitHub serves releases//download/, and NODEJS.ORG is nodejs.org).
const DOWNLOAD = /releases\/+download\/|\/releases\/+assets\/|(?:objects|release-assets|raw)\.githubusercontent\.com|storage\.googleapis\.com\/+chrome-for-testing-public\/|nodejs\.org\/+dist\//i;

const HELPER = 'scripts/ci/fetch-pinned.sh';
/** How ci-slow's WSL steps name the workspace: the one assignment a run with a `$ws/` helper line may make to `ws`. */
const WS_FROM_WORKSPACE = `ws="$(wslpath -u '\${{ github.workspace }}')"`;
/** The step shells used today (R1228i D3: a custom shell is a command line, so `curl -K {0}` would be the downloader). */
// check-table: never-grow
const SHELLS_ALLOWED =['bash', 'wsl-bash {0}', 'wsl-sudo {0}', '/usr/bin/bash --noprofile --norc -p -eo pipefail {0}'];
/**
 * A helper step's own shell (R1228o D1, owner decision (c) as narrowed): privileged (-p), so the step's shell imports no
 * function from the environment and reads no BASH_ENV (a `BASH_FUNC_bash%%` key or one written to GITHUB_ENV defined
 * its `bash`); by its absolute path, so no `bash` on PATH is the step's shell itself.
 */
const HELPER_SHELL = '/usr/bin/bash --noprofile --norc -p -eo pipefail {0}';
/**
 * The one helper step whose shell can't be HELPER_SHELL: a Windows runner's step that runs inside WSL through setup-wsl's
 * `wsl-bash {0}`. By workflow, job and step name, so it can't grow unseen. Its helper line is still `/usr/bin/bash -p`;
 * what its step shell takes from the environment is a stated limit (code already running in the job).
 */
// check-table: never-grow
const WSL_HELPER_STEPS = ["ci-slow.yml#bootstrap-windows#fetch the bootstrap's pinned Node inside WSL, for packing below"];
/** A shell variable reference, `$x` or `${x}`: no `$(…)`, no `${x:-…}`. */
const VAR = String.raw`\$\{?[A-Za-z_][A-Za-z0-9_]*\}?`;
/** A quoted path: plain characters and variables only. */
const PATH = String.raw`(?:[^"\s$\x60\\]|${VAR})+`;
/**
 * The one form a workflow line naming a pinned URL may take: the helper, run with bash, with a quoted https URL, a
 * 64-hex pin or a quoted variable holding one, and an out file, and nothing after it (no `|| true`, no `;`, no `#`).
 */
// The checkout's helper only (R1228i D1: a relative path, a working directory or a reassigned variable ran another
// file): by $GITHUB_WORKSPACE, which no run sets, or by $ws where a run sets it only from the workspace (WS_FROM_WORKSPACE).
// By `/usr/bin/bash -p` (owner decision (c); R1228o D2): a name with a slash skips PATH and the hash table, so no `bash`
// on PATH, in BASH_CMDS or by `hash -p` runs instead; -p reads no BASH_ENV or ENV file and takes no function from the
// environment, so neither stands in for the helper's tools.
const HELPER_LINE = new RegExp(
  String.raw`^\s*/usr/bin/bash -p "(?:\$GITHUB_WORKSPACE|\$ws)/scripts/ci/fetch-pinned\.sh" ` +
    String.raw`"https://${PATH}" ` +
    String.raw`(?:"${VAR}"|[0-9a-f]{64}) ` +
    String.raw`(?:"(?:[^"$\x60\\]|${VAR})+"|[A-Za-z0-9_./-]+)\s*$`,
);
/**
 * The inline download a root container step makes (it may run nothing from the checkout): the helper's own curl flags
 * (-sSfL first: self-hosted-guard.test.ts asks for it), to `<out>.part`, from an https URL.
 */
const INLINE_CURL = new RegExp(
  String.raw`^\s*curl -sSfL --proto '=https' --tlsv1\.2 --connect-timeout 20 --speed-limit 1024 --speed-time 60 --retry 5 --retry-all-errors --retry-delay 5 --retry-max-time 120 ` +
    String.raw`-o "(${PATH})\.part" "https://${PATH}"\s*$`,
);
/**
 * Its check, the very next line, fail-safe whatever the shell does (#1228 review R1228d D1): the pin (a variable or
 * 64 hex) and `<out>.part`, checked --strict (a pin holding a second line fails), and only then moved to `<out>`.
 * A check that failed, swallowed by `|| true`, `set +e` or a shell without -e, leaves nothing at the name that's used.
 */
const INLINE_CHECK = new RegExp(String.raw`^\s*echo "(?:${VAR}|[0-9a-f]{64})  (${PATH})\.part" \| sha256sum -c - --strict && mv -f -- "(${PATH})\.part" "(${PATH})"\s*$`);

/**
 * The helper named as a path (R1228z/aa D2: the bare stem in a step id or an input's description is no call): the stem
 * after a `/`, or with `.sh` after it.
 */
// R1228ae D2: after a `/`, the stem as a whole name (`fetch-pinned-logs` is another).
const HELPER_PATH = /\/\s*fetch-pinned(?![\w-])|fetch-pinned\.sh\b/;
/** Whether a line names the helper as a path, read with its quotes and backslashes taken out (R1228ac D2: `"…/ci/""fetch-pinned"".sh"`, `\fetch-pinned\.sh`). */
const namesHelperPath = (l: string) => HELPER_PATH.test(l.replace(/["'\\]/g, ''));
/** `bash` made to name something else: a function (`bash()`, `function bash`), an alias, or `hash -p <path> bash`. */
// R1228p D1: any function name that ends in `bash` (`/usr/bin/bash() {…}`, `function /usr/bin/bash {…}`); `bashful()` is kept.
const BASH_REDEFINED = /(?:^|[\s;&|(`{])(?:function\s+\S*\bbash(?![\w-])|\S*\bbash\s*\(\s*\))|\balias\s+(?:-[A-Za-z]+\s+)*bash=|\bhash\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*p/;
/** PATH given a value, however it is set (the helper line's `bash` is found on it). */
const PATH_SET = /(?:^|[\s;&|(`])(?:(?:export|declare|typeset|local|readonly)(?:\s+-[A-Za-z]+)*\s+)?PATH\+?=/;
/** BASH_ENV or ENV given a value (an empty one clears it), however it is set: assigned, exported, declared, by env. */
const HELPER_ENV_SET = /(?:^|[\s;&|(`])(?:(?:export|declare|typeset|local|readonly)(?:\s+-[A-Za-z]+)*\s+)?(?:BASH_ENV|ENV)=(?!(?:''|""|\s|$|;|&|\|))/;
/** A function put in the environment: `export -f`, `declare -fx`, `typeset -xf`, or a BASH_FUNC_ variable. */
const FUNCTION_EXPORT = /\bexport\s+(?:-[A-Za-z]*\s+)*-[A-Za-z]*f|\b(?:declare|typeset)\s+(?:-[A-Za-z]+\s+)*-(?:[A-Za-z]*f[A-Za-z]*x|[A-Za-z]*x[A-Za-z]*f)|\bBASH_FUNC_/;
/** ci-slow's $WS root (see runProblems). */
const WS_ENV_ROOT = /^\$\{?WS\}?\/(?:scripts|\.github)\//;
/** A shell file from the checkout's root: scripts/ or .github/, plainly or from $GITHUB_WORKSPACE or $ws. */
const SHELL_FILE_ROOT = /^(?:\.\/|\$\{?(?:GITHUB_WORKSPACE|ws)\}?\/)?(?:scripts|\.github)\//;
/** Downloaders other than curl: none may run in a workflow or a script (a probe to /dev/null aside, below). */
const OTHER_FETCH = /\bwget\b|\bgh\s+release\s+download\b|\bInvoke-WebRequest\b|\biwr\b|\bInvoke-RestMethod\b|\birm\b|\bWebClient\b|\bDownloadFile\b|\bHttpClient\b|\bStart-BitsTransfer\b|\baria2c\b|\bcurl\.exe\b|=\s*["']?curl\b|\bgh\s+api\b[^\n]*(?:releases\/|octet-stream)|\bgh\s+release\s+(?:view|list)\b[^\n]*\bassets\b|\b(?:command\s+-v|which|type\s+-[pP])\s+curl\b/i;

/** A run script's lines, with backslash-continued lines joined. */
// R1228f D2: bash removes a backslash-newline outright (no space), keeping the next line's indentation.
const logicalLines = (run: string) => run.replace(/\\\n/g, '').split('\n');

/** One shell command, and whether a pipe takes its output (`a | b`: a's). */
export interface Cmd {
  cmd: string;
  piped: boolean;
}

/** One shell line with its comment cut, split into commands at each unquoted `;`, `&` or `|` (so `&&`, `||`, pipes). */
export function shellCommands(line: string): Cmd[] {
  const out: Cmd[] = [];
  let cur = '';
  let q: string | null = null;
  const push = (piped: boolean) => {
    if (cur.trim()) out.push({ cmd: cur.trim(), piped });
    cur = '';
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      cur += c;
      if (c === '\\' && q === '"') cur += line[++i] ?? '';
      else if (c === q) q = null;
      continue;
    }
    if (c === '\\') { cur += c + (line[++i] ?? ''); continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) break;
    if (c === '|' && line[i + 1] === '|') { push(false); i++; continue; }
    if (c === '|') { push(true); continue; }
    if (c === '&' && line[i - 1] !== '>' && line[i + 1] !== '>') { if (line[i + 1] === '&') i++; push(false); continue; }
    if (c === ';') { push(false); continue; }
    cur += c;
  }
  push(false);
  return out;
}
export const commands = (line: string): string[] => shellCommands(line).map((c) => c.cmd);

/** A command's words as the shell splits them: quotes kept together and taken off. */
export function words(cmd: string): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  let q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (q) {
      if (c === q) q = null;
      else cur = (cur ?? '') + c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; cur ??= ''; continue; }
    if (/\s/.test(c)) { if (cur !== null) out.push(cur); cur = null; continue; }
    cur = (cur ?? '') + c;
  }
  if (cur !== null) out.push(cur);
  return out;
}

/** Whether a command runs curl (not a word in, say, an apt-get list): curl first, or after $( ` then do if ! exec env sudo nohup time timeout N or assignments. */
export const runsCurl = (cmd: string) => /(?:^|\$\(|`|\b(?:then|do|if|exec|command|sudo|env|nohup|time)\s+|[!{(]\s*|\btimeout\s+\S+\s+|^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+)curl(?:\s|$)/.test(cmd);

/**
 * Where one curl command's bodies go, one per transfer (`--next` or `-:` starts another): to a file (not /dev/null),
 * to stdout (a pipe, a redirect or a capture), or nowhere. The worst of them counts. Words are read as the shell
 * splits them, so an `-o /dev/null` inside a quoted header is no output (R1228d D3).
 */
export function curlOutput(cmd: string): 'file' | 'stdout' | 'none' {
  // Read two ways and the worse counts (R1228f D1): with the shell's quoting, from curl on (a capture's quotes,
  // "$(curl … "$1")", would otherwise make one word of it), and with quotes taken off from the start of curl's word
  // ("curl" -o f …, or bash -c "curl -o f …", where the shell's quoting hides the flags).
  const rank = { none: 0, stdout: 1, file: 2 } as const;
  const a = transfersOutput(words(cmd.slice(cmd.search(/\bcurl\b/))).slice(1));
  const b = transfersOutput(curlTokens(cmd).slice(1));
  return rank[a] >= rank[b] ? a : b;
}

/** curl's words with every quote taken off, from the start of the word curl is in. */
export const curlTokens = (cmd: string): string[] => cmd.slice(Math.max(0, cmd.search(/\S*\bcurl\b/))).replace(/["']/g, ' ').split(/\s+/).filter(Boolean).slice(0).map((w, i) => (i === 0 ? 'curl' : w));

/** The URL-looking words of a curl command, both ways it is read (an --url= value too). */
export const curlUrls = (cmd: string): string[] =>
  [...words(cmd.slice(cmd.search(/curl/))), ...curlTokens(cmd)].filter((w) => /^(?:--url=)?https?:\/\//i.test(w)).map((w) => w.replace(/^--url=/, ''));

function transfersOutput(t: readonly string[]): 'file' | 'stdout' | 'none' {
  let file = false;
  let stdout = false;
  let named = false;
  const end = () => {
    if (!named) stdout = true;
    named = false;
  };
  for (let i = 0; i < t.length; i++) {
    const tok = t[i]!;
    let target: string | undefined;
    if (tok === '--next' || tok === '-:') { end(); continue; }
    if (tok === '-o' || tok === '--output') target = t[++i];
    else if (tok.startsWith('--output=')) target = tok.slice('--output='.length);
    else if (tok === '--remote-name' || tok === '--remote-name-all') file = named = true;
    else if (/^-[a-zA-Z]+$/.test(tok)) {
      if (tok.includes('O')) file = named = true;
      if (tok.endsWith('o')) target = t[++i];
    } else if (/^-o\S/.test(tok)) target = tok.slice(2);
    if (target !== undefined) { named = true; if (target !== '/dev/null') file = true; }
  }
  end();
  return file ? 'file' : stdout ? 'stdout' : 'none';
}

/** Whether a curl command reads a config file (-K, --config): one can set its URL, its output, and reset --retry. */
const readsConfig = (cmd: string) => words(cmd.slice(cmd.search(/\bcurl\b/))).some((w) => w === '--config' || w.startsWith('--config=') || /^-[a-zA-Z]*K/.test(w));

/** The retry count curl uses: its last `--retry N` (curl takes the last), 0 when there is none. */
export function lastRetry(cmd: string): number {
  return Number([...cmd.matchAll(/(?:^|\s)--retry(?:=|\s+)(\d+)(?=\s|$)/g)].pop()?.[1] ?? 0);
}

/** What is wrong in one workflow file's text, line by line: a pinned URL anywhere but on a helper line, another downloader. */
export function workflowTextProblems(text: string): string[] {
  const out: string[] = [];
  for (const l of text.split('\n')) {
    // R1228ae D1: a one-line `run:` holds its helper line after the key.
    // R1228af D2: and in YAML single quotes (`run: '…'`).
    if (DOWNLOAD.test(l) && !HELPER_LINE.test(l.replace(/^\s*(?:-\s+)?run:\s+/, '').replace(/^'(.*)'\s*$/, '$1')) && !INLINE_CURL.test(l)) out.push(`a pinned URL not on a ${HELPER} line: ${l.trim()}`);
    if (!/^\s*#/.test(l) && OTHER_FETCH.test(l)) out.push(`a download that isn't the helper's curl: ${l.trim()}`);
  }
  return out;
}

/** A loopback URL: a local stand-in, never a download. */
const LOCAL = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?:[:/]|$)/;

/**
 * What is wrong in one step's script. Anywhere: a curl that keeps (to a file or stdout) what an https URL, or an http
 * URL that isn't loopback, returns, the inline pair aside; a curl that reads a config file. In a root container step
 * (`rootStep`): the helper (checkout code, as root), and an inline curl not followed at once by its fail-safe check of
 * the same file. Elsewhere: the inline pair (the helper is the one way).
 */
/**
 * The file bash or sh runs, read by bash's own option rules (R1228aj D3, R1228ak D1), or null when it runs none: a
 * `-c` (the script is on the line) or `-s` (stdin) in any cluster, `--version` or `--help`, a here-document. Long
 * options are read past (`--noprofile --norc`, `--rcfile <file>`), `-o`/`-O` and a cluster ending in either take the
 * next word (`-eo pipefail`), and `--` ends the options. A redirection is no file (R1228al D1: `bash x.sh > log`), but
 * a file on stdin is run (`bash < tools/get`) when no script is named.
 */
export function shellFileOf(w: readonly string[]): string | null {
  let stdin: string | null = null;
  let fromStdin = false;
  for (let i = 1; i < w.length; i++) {
    const t = w[i]!;
    if (/^\d*<</.test(t)) return null;
    if (/^\d*<$/.test(t)) {
      stdin = w[++i] ?? null;
      continue;
    }
    if (/^\d*</.test(t)) {
      stdin = t.replace(/^\d*</, '');
      continue;
    }
    if (/^(?:\d*|&)>/.test(t)) {
      if (/^(?:\d*|&)>>?&?$/.test(t)) i++;
      continue;
    }
    if (t === '--') return fromStdin ? stdin : (w[i + 1] ?? stdin);
    if (t === '--version' || t === '--help') return null;
    if (t.startsWith('--')) {
      if (t === '--rcfile' || t === '--init-file') i++;
      continue;
    }
    if (/^[-+][A-Za-z]+$/.test(t)) {
      if (t[0] === '-' && t.slice(1).includes('c')) return null;
      // `-s`: the script is stdin (`bash -s < tools/get` runs it); the words after are its arguments.
      if (t[0] === '-' && t.slice(1).includes('s')) fromStdin = true;
      if (/[oO]$/.test(t)) i++;
      continue;
    }
    if (fromStdin) continue;
    return t;
  }
  return stdin;
}

/**
 * A file the lint reads: under scripts/ or .github/ from the checkout's root, with no `..`; or, in a file the lint
 * reads (`inFile`), any relative `.sh` or `.bash` path that stays in the checkout, since the lint reads every shell
 * script wherever it is (R1228am D4: `cd "$(dirname "$0")" && bash b.sh` in scripts/ci/a.sh).
 */
const readFile = (file: string, inFile: string | null) => {
  const dotdot = /(^|\/)\.\.(\/|$)/.test(file);
  if (SHELL_FILE_ROOT.test(file) && !dotdot) return true;
  return inFile !== null && /\.(?:sh|bash)$/.test(file) && !posix.normalize(posix.join(posix.dirname(inFile), file)).startsWith('..');
};

/**
 * Why a line runs a shell file the lint doesn't read, or null (R1228am: after five rounds of command positions —
 * prefixes, wrappers' options, case arms, else, substitutions, make's @/-/+ — every `bash` or `sh` word on the line is
 * read, wherever it stands, inside quotes and substitutions too; measured over the repo, that refused two lines,
 * `bash train.sh` and `bash canary.sh` in scripts/ci/exp-real-systemd.sh, a scratch repository's files, which the
 * read-file rule below keeps as relative .sh paths). The file after it (bash's options read past) is judged when it is path-like (a `/`, or
 * `.sh`/`.bash`): a bare name isn't (`useradd -s /bin/bash user`). A relative one must be a file the lint reads; an
 * absolute one or one built from a variable can't be mapped to the checkout, a stated limit, except where a workflow
 * run's command starts with bash (owner decision (c): anchored at the checkout's root, nothing else). `name`: the file
 * the line is in, when it is a file the lint reads.
 */
function unreadShellFile(l: string, o: { wsFromEnvFile?: boolean; anchored?: boolean; name?: string } = {}): string | null {
  const tokens = l.split(/[\s;&|()`{}]+/).map((w) => w.replace(/["']/g, '')).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i]!.replace(/^[@+-]+/, '');
    if (!/^(?:\S*\/)?(?:bash|sh)$/.test(word)) continue;
    const file = shellFileOf(tokens.slice(i));
    if (!file || file.startsWith('-') || !/\/|\.(?:sh|bash)$/.test(file)) continue;
    const fromWs = WS_ENV_ROOT.test(file) && !!o.wsFromEnvFile;
    if (fromWs || /^\$\{?(?:GITHUB_WORKSPACE|ws)\}?\//.test(file) || readFile(file, o.name ?? null)) continue;
    // Absolute or built from a variable: refused only where a workflow run's command starts with this bash.
    if (/^[/~]/.test(file) || /[$`]/.test(file)) {
      const starts = o.anchored !== false && commands(l).some((c) => new RegExp(`^(?:\\S*/)?(?:bash|sh)\\b`).test(c.trim()) && words(c).includes(file));
      if (!starts) continue;
    }
    return `a shell file the download lint doesn't read (put it under scripts/ or .github/): ${l.trim()}`;
  }
  // `source` and `.` with a `.sh`/`.bash` file, at the start of a command, as before.
  for (const c of commands(l)) {
    const m = /^(?:source|\.)(?:\s+-[A-Za-z]+)*\s+("?)([^\s"]+\.(?:sh|bash))\1(?:\s|$)/.exec(c) ?? /^("?)(\.\/[^\s"]+\.(?:sh|bash))\1(?:\s|$)/.exec(c);
    if (!m) continue;
    const fromWs = WS_ENV_ROOT.test(m[2]!) && !!o.wsFromEnvFile;
    if (!fromWs && !readFile(m[2]!, o.name ?? null)) return `a shell file the download lint doesn't read (put it under scripts/ or .github/): ${c}`;
  }
  return null;
}

export function runProblems(run: string, rootStep = false): string[] {
  const out: string[] = [];
  const lines = logicalLines(run);
  // R1228i D1: GITHUB_WORKSPACE is only read in a run, and $ws, in a run with the helper, is only the workspace.
  if (/\bGITHUB_WORKSPACE\b/.test(run.replace(/\$\{?GITHUB_WORKSPACE\b/g, ''))) out.push('GITHUB_WORKSPACE set in a run (the helper is run by its path)');
  if (lines.some((l) => HELPER_LINE.test(l) && l.includes('$ws/'))) {
    const rest = run.split(WS_FROM_WORKSPACE).join('').replace(/\$\{?ws\b/g, '');
    if (!run.includes(WS_FROM_WORKSPACE) || /\bws\b/.test(rest)) out.push(`$ws set other than from the workspace (${WS_FROM_WORKSPACE}) in a run with ${HELPER}`);
  }
  // ci-slow's WSL steps name the checkout $WS, from /etc/wl-ci.env (written from the workspace's path): a root there only
  // in a run that sources that file and never sets WS itself.
  const wsFromEnvFile = /^\s*\. \/etc\/wl-ci\.env\s*$/m.test(run) && !/(?:^|[\s;&|(])(?:export\s+)?WS=/.test(run);
  // Owner decision (c): a run with the helper sets no BASH_ENV or ENV and exports no function (bash -p ignores both;
  // this keeps the run from relying on that alone).
  if (lines.some((l) => HELPER_LINE.test(l))) {
    for (const l of lines) {
      if (/^\s*#/.test(l)) continue;
      if (HELPER_ENV_SET.test(l)) out.push(`BASH_ENV or ENV set in a run with ${HELPER}: ${l.trim()}`);
      if (FUNCTION_EXPORT.test(l)) out.push(`a function exported in a run with ${HELPER}: ${l.trim()}`);
      // R1228l D1 (M3, N3): the word `bash` on the helper line is found by name, which -p can't change: a `bash`
      // function, alias or hashed path, or a PATH set in the same run, runs instead of the helper.
      if (BASH_REDEFINED.test(l)) out.push(`\`bash\` redefined (a function, an alias or a hashed path) in a run with ${HELPER}: ${l.trim()}`);
      if (PATH_SET.test(l)) out.push(`PATH set in a run with ${HELPER} (its \`bash\` is found on PATH): ${l.trim()}`);
    }
  }
  // R1228p D3: the checkout's helper only as HELPER_LINE: a call in any other form (another `bash`, its URL built from
  // pieces) would run outside both structural rules (the step's shell and the line's /usr/bin/bash -p).
  // R1228r D1, R1228s: by the helper's file stem, any path to it (`scripts/ci/./`, `scripts//ci/`, a quote split).
  for (const l of lines) if (!/^\s*#/.test(l) && namesHelperPath(l) && !HELPER_LINE.test(l)) out.push(`${HELPER} named other than on a helper line (\`/usr/bin/bash -p "$GITHUB_WORKSPACE/${HELPER}" <url> <pin> <out>\`): ${l.trim()}`);
  for (const [i, l] of lines.entries()) {
    if (HELPER_LINE.test(l) && rootStep) out.push(`${HELPER} from the checkout in a step that runs as root in the self-hosted container: ${l.trim()}`);
    const m = INLINE_CURL.exec(l);
    if (m) {
      if (!rootStep) out.push(`an inline download outside a root container step (use ${HELPER}): ${l.trim()}`);
      const next = lines.slice(i + 1).find((x) => x.trim() !== '' && !/^\s*#/.test(x)) ?? '';
      const c = INLINE_CHECK.exec(next);
      if (!c || c[1] !== m[1] || c[2] !== m[1] || c[3] !== m[1]) out.push(`an inline download not checked at once against its pin, then moved into place: ${l.trim()}`);
      continue;
    }
    for (const { cmd: c, piped } of shellCommands(l)) {
      // R1228f D1: every mention of curl, whatever its spelling (/usr/bin/curl, \curl, "curl", sudo -E, env -i, nice,
      // timeout -s, bash -c, xargs), is judged; not only the spellings runsCurl knows.
      if (!/curl/.test(c)) continue;
      if (readsConfig(c)) out.push(`a curl that reads a config file (-K): ${c}`);
      if (WORKFLOW_PROBES.includes(c)) continue;
      const urls = curlUrls(c);
      const o = curlOutput(c);
      const ws = words(c.slice(c.search(/curl/)));
      const redirected = ws.some((w, i) => /^&?>>?/.test(w) && (w.replace(/^&?>>?/, '') || ws[i + 1]) !== '/dev/null');
      const kept = o === 'file' || (o === 'stdout' && (piped || /\$\(\s*\S*curl\b/.test(c) || redirected));
      // Kept from any URL but a loopback one, written out (a URL in a variable included: R1228d W2).
      if (kept && !(urls.length && urls.every((u) => LOCAL.test(u)))) out.push(`a curl that keeps what a URL returns (use ${HELPER}): ${c}`);
      else if (o !== 'none' && urls.some((u) => /^https:/i.test(u) || !LOCAL.test(u))) out.push(`a curl that keeps what a URL returns (use ${HELPER}): ${c}`);
    }
    // R1228f D4: a run that executes a shell file runs only one the lint reads (under scripts/ or .github/).
    {
      const why = unreadShellFile(l, { wsFromEnvFile });
      if (why) out.push(why);
    }
  }
  return out;
}

/**
 * The runner-user switch a root container step may open with (as desktop-removed.test.ts's AS_RUNNER), exactly: after
 * it, the step runs as the runner user (R1228d D5: a looser match took a prelude that ran something else first).
 */
const AS_RUNNER = `# In the self-hosted runner's container, as the runner user (above), never root, with this same script.
if [ "\${${BRAND.envPrefix}_CI_CONTAINER:-}" = 1 ] && [ "$(id -u)" = 0 ]; then
  chown -R runner:runner "$GITHUB_WORKSPACE" "$RUNNER_TEMP"
  HOME=/home/runner exec runuser -p -u runner -- bash --noprofile --norc -eo pipefail "$0"
fi
`;
/** A step that switches to the runner user before anything else. */
const switchesToRunner = (run: string) => run.startsWith(AS_RUNNER);
/**
 * A job whose steps start as root: one with a container, unless it runs as another user (`options: --user`). R1228d
 * D5: matching the text `pull_request` missed a container expression that could run a pull request without it.
 */
const rootContainer = (job: { container?: unknown }) => {
  const c = job.container;
  if (c === undefined || c === null || c === '') return false;
  return !/--user\b|(^|\s)-u\s/.test(JSON.stringify(c));
};

/**
 * Workflow curls that keep what a URL in a variable returns and are allowed to: each reads a local stand-in (the fake
 * GitHub, the dashboard under test), never the network. Exact text, so an edit to one, or a new one, is checked.
 */
const WORKFLOW_PROBES: string[] = [
  // ci-slow's wizard and hub checks: the page the local dashboard serves, its sign-in round trip.
  String.raw`curl -s -o "$t/page.html" -w '%{http_code}\n' "$(tail -n 1 "$F/$log")"`,
  String.raw`csrf="$(curl -s -H "Cookie: $c" "$h/" | sed -n 's/.*name="csrf" value="\([^"]*\)".*/\1/p')"`,
  String.raw`curl -s -H "Cookie: $c" "$h$loc" > "$F/start.html"`,
  String.raw`curl -s -H "Cookie: $c" "$h/setup/app-manifest/callback?state=$state&code=ci-signin-code"`,
  String.raw`[ "$(curl -s -o "$F/loopback-page.html" -w '%{http_code}' "$u")" = 200 ]`,
  String.raw`[ "$(curl -s -o "$F/setup-page.html" -w '%{http_code}' "$u")" = 200 ]`,
];

/** The actions a workflow may use (R1228f D4: a release-download action has no URL text), pinned by commit; ./ local. */
// A local one only under .github (R1228g D1: `./\S+` let any repo path in, e.g. ./tools/zzdl, whose action.yml the
// walk of .github never reads): a reusable workflow file, one plain name (no `..`). No local action (R1228h D1: a
// Docker or node action under .github/actions runs a Dockerfile or index.js no walk reads): none is used today.
const USES_ALLOWED = /^(?:(?:actions\/(?:checkout|setup-node|upload-artifact|download-artifact)|Vampire\/setup-wsl)@[0-9a-f]{40}|\.\/\.github\/workflows\/[\w-]+\.ya?ml)$/;

/** Setup scripts that download pinned binaries themselves, each with its own checksum (the pinned-URL text rule skips them; the retry rule holds them). */
const SETUP_DOWNLOADERS = ['scripts/bootstrap.sh', 'scripts/setup/node.sh', 'scripts/setup/ci-runner.sh', 'scripts/setup/tools.sh'];

/**
 * Commands in scripts/ that keep what they fetch with no retry and are allowed to: each reads a local server's answer
 * (the dashboard, a package index), which a retry would hide. Exact text, so an edit to one of them, or a new one, is
 * checked.
 */
const SCRIPT_PROBES: Record<string, string[]> = {
  'scripts/ci/wizard-url.sh': [
    `code="$(curl -s -o "$work/page.html" -w '%{http_code}' "$url")"`,
    `code="$(curl -s -o "$work/api.json" -w '%{http_code}' "$origin$api")"`,
    `code="$(curl -s -o "$work/api.json" -w '%{http_code}' -H @"$work/auth" "$origin$api")"`,
  ],
  'scripts/ci/testrun-pip-real-systemd.sh': [`curl -fsS "http://$PUB:$PORT/simple/standin/"`],
  // An egress probe that must fail: a container must not reach the URL.
  'scripts/ci/runner-stand-in/job.sh': [`if out="$(docker run --rm "$img" wget -q -T 5 -O- "$u" 2>&1)"`],
};

/** wget's outputs (-O, --output-document): all of them, since it writes the last. */
const wgetOutputs = (cmd: string) => {
  const w = words(cmd.slice(cmd.search(/\bwget\b/)));
  const outs: string[] = [];
  for (let i = 0; i < w.length; i++) {
    if (w[i] === '-O' || w[i] === '--output-document') outs.push(w[++i] ?? '');
    else if (w[i]!.startsWith('--output-document=')) outs.push(w[i]!.slice('--output-document='.length));
    else if (/^-O./.test(w[i]!)) outs.push(w[i]!.slice(2));
  }
  return outs;
};

/** One shell script's downloads (a curl that keeps a body, or names a pinned URL) and what is wrong with them. */
export function scriptProblems(text: string, probes: string[] = []): { downloads: number; problems: string[] } {
  let downloads = 0;
  const problems: string[] = [];
  for (const { cmd: c, piped } of logicalLines(text).flatMap(shellCommands)) {
    if (probes.includes(c)) continue;
    if (OTHER_FETCH.test(c)) {
      // wget only as a probe whose every output is /dev/null (R1228d D6: it writes the last -O).
      const outs = /\bwget\b/.test(c) ? wgetOutputs(c) : [];
      if (!(outs.length && outs.every((o) => o === '/dev/null'))) problems.push(`a download that isn't curl: ${c}`);
      continue;
    }
    // Every mention of curl, whatever its spelling (R1228f D1); a word in an install list isn't run, and keeps nothing.
    if (!/\bcurl\b/.test(c)) continue;
    if (readsConfig(c)) problems.push(`a curl that reads a config file (-K: it can reset --retry): ${c}`);
    const o = curlOutput(c);
    // A body to stdout is kept when a pipe, a redirect or a capture takes it (R1228d D6).
    const kept = o === 'file' || (o === 'stdout' && (piped || /\$\(\s*\S*curl\b/.test(c) || words(c.slice(c.search(/\bcurl\b/))).some((w) => /^&?>>?/.test(w)))) || DOWNLOAD.test(c);
    if (!kept) continue;
    downloads++;
    if (lastRetry(c) < 1) problems.push(`a download with no retry (its last --retry must be 1 or more): ${c}`);
  }
  return { downloads, problems };
}

type Step = { run?: unknown; uses?: unknown };
type Doc = { jobs?: Record<string, { steps?: Step[]; container?: unknown }>; runs?: { steps?: Step[] } } | null;

/**
 * Every run script in `.github`'s YAML files, judged: a workflow job's steps as root when the job is a root container;
 * a local composite action's (`uses: ./…`) as root when any root job uses it (R1228d D5). Returns the inline pairs seen.
 */
function workflowFiles(files: readonly { name: string; text: string }[], report: (name: string, problem: string) => void): number {
  const docs = files.map((f) => ({ ...f, doc: parse(f.text) as Doc }));
  const rootActions = new Set<string>();
  for (const { doc } of docs) for (const j of Object.values(doc?.jobs ?? {})) if (rootContainer(j ?? {})) for (const s of j?.steps ?? []) if (typeof s?.uses === 'string' && s.uses.startsWith('./')) rootActions.add(s.uses.replace(/^\.\//, '').replace(/\/$/, ''));
  let inline = 0;
  for (const { name, doc } of docs) {
    // R1228f D3: every string the file holds, as YAML decodes it (an escape like \x67 or \x2F hides nothing), with its
    // continuations joined: the pinned-URL and downloader rules are read over these, not over the raw text.
    for (const v of scalars(doc)) for (const p of decodedProblems(v)) report(name, p);
    // R1228u D1, R1228v D1, R1228x/y D1, R1228z/aa D1: the helper's path off a helper line in any value but those at the
    // exact places that never reach a shell (SKIPPED_PATHS, by structural path): anything else is read, so it fails closed.
    // A step's run is read below, with its own message. A hashFiles(...) of it reads the file, never runs it.
    for (const [where, v] of valuesToCheck(doc)) {
      for (const l of logicalLines(v.replace(/\bhashFiles\([^)]*\)/g, ''))) if (!/^\s*#/.test(l) && namesHelperPath(l) && !HELPER_LINE.test(l)) report(name, `${HELPER} named in ${where} off a helper line: ${l.trim()}`);
    }
    // R1228f D4: only the actions used today, each pinned by commit (a new downloader action needs a lint edit).
    for (const u of usesOf(doc)) if (!USES_ALLOWED.test(u)) report(name, `an action this lint doesn't allow (pinned: ${USES_ALLOWED.source}): ${u}`);
    for (const [k, v] of entries(doc)) {
      // R1228i D3: a step's shell, or a default one, only as used today.
      if (k === 'shell' && !SHELLS_ALLOWED.includes(String(v))) report(name, `a shell this lint doesn't allow (${SHELLS_ALLOWED.join(', ')}): ${String(v)}`);
      // R1228i D1: no working directory, and GITHUB_WORKSPACE never set by an env: the helper is run by the workspace's path.
      if (k === 'working-directory') report(name, `a working directory (the helper is run from the workspace): ${String(v)}`);
      if (k === 'env' && v && typeof v === 'object' && Object.keys(v).some((e) => e === 'GITHUB_WORKSPACE' || e === 'ws')) report(name, 'GITHUB_WORKSPACE or ws set by an env');
    }
    const actionRoot = rootActions.has(name.replace(/\/action\.ya?ml$/, ''));
    const wfDefault = (doc as { defaults?: { run?: { shell?: unknown } } })?.defaults?.run?.shell;
    const steps = [
      ...Object.entries(doc?.jobs ?? {}).flatMap(([jn, j]) => (j?.steps ?? []).map((s) => ({ s, root: rootContainer(j ?? {}), envs: [(doc as { env?: unknown })?.env, (j as { env?: unknown })?.env], job: jn, defaultShell: (j as { defaults?: { run?: { shell?: unknown } } })?.defaults?.run?.shell ?? wfDefault }))),
      ...(doc?.runs?.steps ?? []).map((s) => ({ s, root: actionRoot, envs: [] as unknown[], job: '', defaultShell: undefined as unknown })),
    ];
    // R1228p D2: a WSL_HELPER_STEPS entry names one step: a second step with that name in that job (the exception
    // copied, the table unchanged) is refused, and neither is excepted.
    const stepCount = new Map<string, number>();
    for (const { s, job } of steps) if (job) {
      const k = `${name.split('/').pop()}#${job}#${String((s as { name?: unknown }).name ?? '')}`;
      stepCount.set(k, (stepCount.get(k) ?? 0) + 1);
    }
    for (const [k, n] of stepCount) if (n > 1 && WSL_HELPER_STEPS.includes(k)) report(name, `${n} steps named as the one WSL helper step (WSL_HELPER_STEPS names one): ${k}`);
    for (const { s, root, envs, job, defaultShell } of steps) {
      if (typeof s?.run !== 'string') continue;
      // Owner decision (c): a step that runs the helper gets no BASH_ENV or ENV with a value, from any level.
      if (logicalLines(s.run).some((l) => HELPER_LINE.test(l))) {
        // R1228o D1: its own shell is HELPER_SHELL, set on the step itself; the one WSL step in WSL_HELPER_STEPS aside.
        const stepName = String((s as { name?: unknown }).name ?? '');
        const shell = (s as { shell?: unknown }).shell;
        const wsl = shell === undefined && defaultShell === 'wsl-bash {0}' && WSL_HELPER_STEPS.includes(`${name.split('/').pop()}#${job}#${stepName}`) && stepCount.get(`${name.split('/').pop()}#${job}#${stepName}`) === 1;
        // R1228r D2: the excepted WSL step runs one helper line, its own.
        if (wsl && logicalLines(s.run).filter((l) => HELPER_LINE.test(l)).length > 1) report(name, `more than one helper line in the one WSL helper step (it runs its own download only): ${stepName}`);
        if (shell !== HELPER_SHELL && !wsl) report(name, `a step that runs ${HELPER} without \`shell: ${HELPER_SHELL}\` (a step shell that isn't privileged imports a \`bash\` function from the environment): ${stepName || s.run.split('\n')[0]}`);
        // R1228l D1 (N2): the step's own shell isn't started with -p, so a BASH_ENV an earlier step wrote to
        // GITHUB_ENV defines its `bash`. Only the step's own env overrides GITHUB_ENV: each helper step clears it there.
        const stepEnv = (s as { env?: Record<string, unknown> }).env;
        if (!stepEnv || typeof stepEnv !== 'object' || stepEnv.BASH_ENV !== '') report(name, `a step that runs ${HELPER} without \`env: BASH_ENV: ''\` (a BASH_ENV an earlier step writes to GITHUB_ENV reaches the step's own shell): ${String((s as { name?: unknown }).name ?? s.run.split('\n')[0])}`);
        for (const e of [...envs, (s as { env?: unknown }).env]) {
          if (!e || typeof e !== 'object') continue;
          for (const [k, v] of Object.entries(e)) if ((k === 'BASH_ENV' || k === 'ENV') && String(v ?? '') !== '') report(name, `${k} given a value in the env of a step that runs ${HELPER}: ${String(v)}`);
        }
      }
      inline += logicalLines(s.run).filter((l) => INLINE_CURL.test(l)).length;
      for (const p of runProblems(s.run, root && !switchesToRunner(s.run))) report(name, p);
    }
  }
  return inline;
}

/** Every key and its value in a parsed YAML document, at any depth. */
function entries(v: unknown): [string, unknown][] {
  if (Array.isArray(v)) return v.flatMap(entries);
  if (v && typeof v === 'object') return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [[k, x] as [string, unknown], ...entries(x)]);
  return [];
}

/** Every string value in a parsed YAML document. */
function scalars(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(scalars);
  if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).flatMap(scalars);
  return [];
}

/**
 * The exact places whose values never reach a shell, by structural path (R1228z/aa D1: a bare key name matched at any
 * depth, so an env var, matrix key, input or output named `name`, `run`, `uses`, `if` or `runs-on` was skipped). `*` is one
 * path segment. Anything not here is read (R1228x/y D1: fails closed), keys of those names inside env, matrix, with,
 * inputs or outputs included. A step's run has its own check. Nothing GitHub hands a step is skipped (R1228ab D1,
 * R1228ac D3): the workflow's `name` is every step's $GITHUB_WORKFLOW and `github.workflow`, a reusable workflow's path
 * (a job's `uses`) is `job.workflow_file_path`, and a local action's path (a step's `uses`) is a composite action's
 * $GITHUB_ACTION_PATH, so those are read. Nor is what another workflow's steps get through its event payload
 * (`github.event`, R1228ad D1): a workflow's `run-name` is `github.event.workflow_run.display_title` in a workflow
 * `on: workflow_run`, so it is read too. A job's `name` is read as a precaution: no trigger's payload carries it
 * (check_run doesn't trigger a workflow for a suite Actions created, and workflow_job, which names jobs, triggers none:
 * R1228af D1), but it is the run's display name and reading it costs nothing. Skipped: what no context, default
 * variable or trigger event's payload holds (GitHub's docs and webhook schemas, read 2026-11-10): a step's name (only the workflow_job webhook carries step
 * names, and it triggers no workflow), conditions, runner labels, timeouts, concurrency groups, permissions.
 */
// check-table: never-grow
const SKIPPED_PATHS = [
  'on.*.paths', 'on.*.paths-ignore', 'on.*.branches', 'on.*.branches-ignore', 'on.*.tags', 'on.*.tags-ignore', 'on.*.types',
  'concurrency', 'permissions',
  'jobs.*.if', 'jobs.*.runs-on', 'jobs.*.timeout-minutes', 'jobs.*.concurrency', 'jobs.*.permissions',
  'jobs.*.steps.*.name', 'jobs.*.steps.*.if', 'jobs.*.steps.*.timeout-minutes', 'jobs.*.steps.*.run',
  'jobs.*.services.*.env',
  'runs.steps.*.name', 'runs.steps.*.if', 'runs.steps.*.run',
  // R1228ab D2, R1228ac D4: a description is shown, never handed to a step.
  'on.*.inputs.*.description', 'on.*.outputs.*.description', 'on.*.secrets.*.description',
  'description', 'inputs.*.description', 'outputs.*.description',
];
/** Whether a value's path is one of SKIPPED_PATHS (each segment equal, or `*`). */
const skippedPath = (path: string[]) => SKIPPED_PATHS.some((p) => {
  const seg = p.split('.');
  return seg.length === path.length && seg.every((x, i) => x === '*' || x === path[i]);
});
/** Every string value in a workflow or action but those at SKIPPED_PATHS, each with its key path. */
function valuesToCheck(doc: Doc): [string, string][] {
  const out: [string, string][] = [];
  const walk = (v: unknown, path: string[]) => {
    if (path.length && skippedPath(path)) return;
    if (typeof v === 'string') {
      out.push([path.join('.') || '(the document)', v]);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, [...path, String(i)]));
      return;
    }
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, [...path, k]);
  };
  walk(doc, []);
  return out;
}

/** Every `uses:` in a workflow's jobs and steps, and a composite action's steps. */
function usesOf(doc: Doc): string[] {
  const steps = [...Object.values(doc?.jobs ?? {}).flatMap((j) => j?.steps ?? []), ...(doc?.runs?.steps ?? [])];
  const jobUses = Object.values(doc?.jobs ?? {}).map((j) => (j as { uses?: unknown } | undefined)?.uses);
  return [...steps.map((s) => s?.uses), ...jobUses].filter((u): u is string => typeof u === 'string');
}

/** The pinned-URL and downloader rules over one decoded string, its continuations joined as bash joins them. */
export function decodedProblems(text: string): string[] {
  const out: string[] = [];
  for (const l of logicalLines(text)) {
    if (DOWNLOAD.test(l) && !HELPER_LINE.test(l) && !INLINE_CURL.test(l)) out.push(`a pinned URL not on a ${HELPER} line: ${l.trim()}`);
    if (!/^\s*#/.test(l) && OTHER_FETCH.test(l)) out.push(`a download that isn't the helper's curl: ${l.trim()}`);
  }
  return out;
}

/** A file named as the helper anywhere but its own place (R1228i D1: a look-alike a relative path would run). */
function lookAlikes(names: readonly string[]): string[] {
  return names.filter((n) => n !== HELPER && n.split('/').pop() === 'fetch-pinned.sh').map((n) => `${n}: a file named as ${HELPER} elsewhere`);
}

/** A shell script by name or shebang. */
const isShell = (name: string, text: string) => /\.(sh|bash)$/.test(name) || (!name.includes('.') && /^#!.*\b(ba|da|z)?sh\b/.test(text));

/**
 * Whether the download lint reads a repo file (R1228ai D1, closing R1228i L9-L11: a pinned download in a file a
 * workflow runs passed when the lint never read the file): a shell script anywhere, every file under scripts/ whatever
 * its name, package.json (its scripts), a Makefile (`Makefile`, `makefile`, `GNUmakefile`, `*.mk`) and a Dockerfile
 * (`Dockerfile*`, `dockerfile*`, `*.Dockerfile`, `*.dockerfile`: R1228aj D2, R1228ak D3).
 */
const MAKEFILE = /^(?:[Mm]akefile|GNUmakefile)$|\.mk$/;
const DOCKERFILE = /^[Dd]ockerfile|\.[Dd]ockerfile$/;
export function readByDownloadLint(rel: string, text: string): boolean {
  const n = rel.split('/').pop()!;
  return rel.startsWith('scripts/') || isShell(n, text) || n === 'package.json' || MAKEFILE.test(n) || DOCKERFILE.test(n);
}

/** What the download lint reads of a file: a package.json's scripts (each a shell line), else the whole text. */
const lintText = (rel: string, text: string): string => {
  if (rel.split('/').pop() !== 'package.json') return text;
  const scripts = (JSON.parse(text) as { scripts?: Record<string, string> }).scripts ?? {};
  return Object.values(scripts).join('\n');
};

/**
 * Whether a shell runs the file, so its commands are read for the retry rule: a shell script, an extensionless file under
 * scripts/ (T3: `bash scripts/ci/get-gitleaks`), a Makefile's recipes, a Dockerfile's RUN lines, package.json's scripts.
 * A node, Python or TypeScript file's own download is a tool the lint doesn't know (the Limits); a README isn't run.
 */
const runByShell = (rel: string, text: string): boolean => {
  const n = rel.split('/').pop()!;
  return isShell(n, text) || (rel.startsWith('scripts/') && !n.includes('.')) || n === 'package.json' || MAKEFILE.test(n) || DOCKERFILE.test(n);
};

/** One file's problems: a look-alike of the helper, a pinned URL outside the helper and the setup downloaders, and (in what a shell runs) a download with no retry. */
export function fileDownloadProblems(rel: string, text: string, probes: string[] = []): { downloads: number; problems: string[] } {
  const n = rel.split('/').pop()!;
  // R1228ak D4: a Dockerfile's builder drops comment lines before it joins a RUN's continuations, so the RUN goes on.
  const t = DOCKERFILE.test(n) ? lintText(rel, text).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n') : lintText(rel, text);
  const problems = lookAlikes([rel]);
  // R1228ak D5: prose (a README's docs link) is no download; code and what a shell runs are read.
  if (!SETUP_DOWNLOADERS.includes(rel) && !/\.md$/i.test(n)) for (const l of logicalLines(t).filter((x) => !/^\s*#/.test(x) && DOWNLOAD.test(x))) problems.push(`a pinned URL outside ${HELPER} and the setup downloaders: ${l.trim()}`);
  if (!runByShell(rel, text)) return { downloads: 0, problems };
  // R1228ak D2: a package.json script, a Makefile recipe or a shell script running an unread shell file is refused, as
  // a workflow run is. A Dockerfile's RUN runs paths inside the image (a COPY's target), which the lint can't map: a
  // stated limit.
  if (!DOCKERFILE.test(n)) for (const l of logicalLines(t)) {
    const why = /^\s*#/.test(l) ? null : unreadShellFile(l, { anchored: false, name: rel });
    if (why) problems.push(why);
  }
  const r = scriptProblems(t, probes);
  return { downloads: r.downloads, problems: [...problems, ...r.problems] };
}

const walk = (d: string, keep: (p: string) => boolean): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : walk(p, keep)) : keep(p) ? [p] : [];
  });

const REL = 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz';
const PIN = '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb';

test('the workflow lint refuses every form R1228a and R1228b found, and keeps the helper and local probes', () => {
  const refused = (s: string) => workflowTextProblems(s).length + runProblems(s).length > 0;
  const bad = {
    'the old curl and sha256sum pair': `curl -sSfL --retry 5 --retry-all-errors --retry-delay 5 -o f "${REL}"\necho "${PIN}  f" | sha256sum -c -`,
    'a check that cannot fail': `curl -sSfL -o f "${REL}"\necho "${PIN}  f" | sha256sum -c - || true`,
    'the helper with || true': `bash ${HELPER} "${REL}" ${PIN} f || true`,
    'the helper then more on its line': `bash ${HELPER} "${REL}" ${PIN} f; tar -xzf f`,
    'the helper in a comment of another command': `true # bash ${HELPER} "${REL}" ${PIN} f`,
    'the helper with a command substitution in its URL': `bash ${HELPER} "https://$(cat u)/releases/download/x" ${PIN} f`,
    'the helper with a short pin': `bash ${HELPER} "${REL}" ${PIN.slice(1)} f`,
    'the helper over http': `bash ${HELPER} "http://github.com/a/b/releases/download/x" ${PIN} f`,
    'a URL in a shell variable': `u="${REL}"\ncurl -sSfL -o f "$u"`,
    'a URL in a workflow env: value': `env:\n  GL_URL: ${REL}`,
    'a URL in a heredoc': `u="$(cat <<X\n${REL}\nX\n)"`,
    'the release API asset endpoint': `curl -sSfL -H 'Accept: application/octet-stream' -o f https://api.github.com/repos/a/b/releases/assets/123`,
    'wget': `wget -O f "$u"`,
    'gh release download': 'gh release download v1 -R a/b -p "*.tgz"',
    'Invoke-WebRequest': 'Invoke-WebRequest -Uri $u -OutFile f',
    'iwr': 'iwr $u -OutFile f',
    'curl through a variable': 'c=curl\n"$c" -sSfL -o f "$u"',
    'a split URL to a file': `curl -sSfL -o f "https://github.com/a/b/rel""eases/download/x"`,
    'an https body piped to tar': 'curl -sSfL "https://example.com/x.tgz" | tar -xz',
    'an https body to a file with -O': 'curl -sSfLO "https://example.com/x.tgz"',
    'R1228d W1 plain http to a file': 'curl -sSfL -o tool "http://example.com/tool"; ./tool',
    'R1228d W3 a raw.githubusercontent URL in env': 'env:\n  TOOL_URL: https://raw.githubusercontent.com/a/b/main/tool',
    'R1228d W4 -o /dev/null hidden in a quoted header': 'curl -sSfL -H "X-Pad: -o /dev/null" "https://example.com/tool.tgz" | tar -xz',
    'R1228d W4 the same, with a word after it in the header': 'curl -sSfL -H "X-Pad: -o /dev/null x" "https://example.com/tool.tgz" | tar -xz',
    'R1228d W5 a second transfer after --next': 'curl -sS -o /dev/null "https://example.com/ping" --next "https://example.com/tool.tgz" | tar -xz',
    'R1228d W6 Invoke-RestMethod': 'Invoke-RestMethod -Uri https://example.com/t -OutFile t',
    'R1228d W6 irm': 'irm https://example.com/t -OutFile t',
    'R1228d W6 WebClient': '(New-Object Net.WebClient).DownloadFile("https://example.com/t", "t")',
    'R1228d W7 a config file': 'printf "url = https://example.com/t\\noutput = t\\n" > c\ncurl -sSfL -K c',
    // R1228i D1: the helper by a relative path (the step's directory picks the file).
    'R1228i the helper, relative': `bash ${HELPER} "https://github.com/gitleaks/gitleaks/releases/download/v\${GITLEAKS_VERSION}/\${tarball}" "\${GITLEAKS_SHA256}" "$tarball"`,
  };
  for (const [why, s] of Object.entries(bad)) assert.ok(refused(s), `refused: ${why}`);
  const good = {
    'the helper from the workspace, a literal pin': `/usr/bin/bash -p "$GITHUB_WORKSPACE/${HELPER}" "${REL}" ${PIN} "$f"`,
    'the helper inside WSL': `${WS_FROM_WORKSPACE}\n/usr/bin/bash -p "$ws/${HELPER}" "https://nodejs.org/dist/$v/node-$v-linux-x64.tar.xz" "$sum" /tmp/node.tar.xz`,
    'a probe to /dev/null': `[ "$(curl -s -o /dev/null -w '%{http_code}' https://hub.example.test/first-run)" = 200 ]`,
    'a local probe': 'curl -sf "$GH_FAKE/repos/example/alpha"',
    'a loopback page kept': `curl -sS -o "$F/seam.json" -w '%{http_code}' "http://127.0.0.1:$port/api/x"`,
    'a loopback probe in a loop': 'for _ in $(seq 40); do curl -fsS -o /dev/null "http://127.0.0.1:$port/" && break; sleep 0.5; done',
  };
  for (const [why, s] of Object.entries(good)) assert.ok(!refused(s), `kept: ${why}: ${[...workflowTextProblems(s), ...runProblems(s)].join('; ')}`);
});

test('a root container step: the helper is refused, the inline pair must be exact and fail-safe; outside one the pair is refused (R1228d D1, D5)', () => {
  const F = "curl -sSfL --proto '=https' --tlsv1.2 --connect-timeout 20 --speed-limit 1024 --speed-time 60 --retry 5 --retry-all-errors --retry-delay 5 --retry-max-time 120";
  const pair = (out: string, pin = '${CHROME_SHA256}') => `${F} -o "${out}.part" "${REL}"\necho "${pin}  ${out}.part" | sha256sum -c - --strict && mv -f -- "${out}.part" "${out}"`;
  assert.deepEqual(runProblems(pair('/tmp/$f'), true), [], 'the exact pair in a root step');
  assert.deepEqual(runProblems(`${F} -o "$f.part" "${REL}"\n# a comment\n\necho "${PIN}  $f.part" | sha256sum -c - --strict && mv -f -- "$f.part" "$f"`, true), [], 'comments and blank lines between are skipped');
  assert.match(runProblems(pair('/tmp/$f'), false).join(), /outside a root container step/, 'elsewhere the helper is the one way');
  assert.match(runProblems(`/usr/bin/bash -p "$GITHUB_WORKSPACE/${HELPER}" "${REL}" ${PIN} "$f"`, true).join(), /from the checkout in a step that runs as root/);
  const bad = {
    'the old pair (no .part, no move)': `${F.replace(' --connect-timeout 20 --speed-limit 1024 --speed-time 60', '')} -o "$f" "${REL}"\necho "${PIN}  $f" | sha256sum -c -`,
    'a check that cannot fail': `${F} -o "$f.part" "${REL}"\necho "${PIN}  $f.part" | sha256sum -c - --strict || true`,
    'no --strict': `${F} -o "$f.part" "${REL}"\necho "${PIN}  $f.part" | sha256sum -c - && mv -f -- "$f.part" "$f"`,
    'moved before the check': `${F} -o "$f.part" "${REL}"\nmv -f -- "$f.part" "$f"\necho "${PIN}  $f" | sha256sum -c - --strict`,
    'a check of another file': `${F} -o "$f.part" "${REL}"\necho "${PIN}  other.part" | sha256sum -c - --strict && mv -f -- "other.part" "other"`,
    'moved to another name': `${F} -o "$f.part" "${REL}"\necho "${PIN}  $f.part" | sha256sum -c - --strict && mv -f -- "$f.part" "$g"`,
    'no check': `${F} -o "$f.part" "${REL}"`,
    'two downloads, one check': `${F} -o "$f.part" "${REL}"\n${F} -o "$g.part" "${REL}"\necho "${PIN}  $g.part" | sha256sum -c - --strict && mv -f -- "$g.part" "$g"`,
  };
  for (const [why, s] of Object.entries(bad)) assert.ok(runProblems(s, true).length > 0, why);
  assert.equal(INLINE_CURL.test(`${F.replace('--retry 5', '--retry 0')} -o "$f.part" "${REL}"`), false, 'the flags are exact');
  assert.equal(INLINE_CURL.test(`${F.replace(' --speed-time 60', '')} -o "$f.part" "${REL}"`), false, 'the stall bound is part of them (R1228d D2, R1228e D1)');
  // D5: a container is root unless it runs as another user; the runner switch is matched exactly.
  assert.ok(rootContainer({ container: "${{ github.event_name != 'push' && fromJSON('{}') || '' }}" }), 'X1: a container expression without the text pull_request');
  assert.ok(!rootContainer({}) && !rootContainer({ container: { image: 'x', options: '--user 1001' } }));
  const prelude = AS_RUNNER;
  assert.ok(switchesToRunner(`${prelude}echo ok\n`));
  assert.ok(!switchesToRunner(prelude.replace('chown -R runner:runner "$GITHUB_WORKSPACE" "$RUNNER_TEMP"', `/usr/bin/bash -p "$GITHUB_WORKSPACE/${HELPER}" "${REL}" ${PIN} f`)), 'X2: a prelude that runs something else');
  assert.ok(!switchesToRunner(prelude.replace('-u runner', '-u root')), 'X2: a switch to root');
});

test('the inline pair, run: a failed check leaves nothing at the name used, however the shell carries on (R1228d D1, measured with a stub curl and the real sha256sum)', { skip: process.platform === 'win32' }, () => {
  const d = mkdtempSync(join(tmpdir(), 'inline-pair-'));
  try {
    writeFileSync(join(d, 'curl'), '#!/usr/bin/env bash\nout=\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done\nprintf evil > "$out"\n', { mode: 0o755 });
    const F = "curl -sSfL --proto '=https' --tlsv1.2 --connect-timeout 20 --speed-limit 1024 --speed-time 60 --retry 5 --retry-all-errors --retry-delay 5 --retry-max-time 120";
    const good = sha('good');
    const pairFor = (pin: string) => `${F} -o "$f.part" "${REL}"\necho "${pin}  $f.part" | sha256sum -c - --strict && mv -f -- "$f.part" "$f"`;
    const forms: Record<string, string> = {
      'R1 the pair in { … } || true': `{ ${pairFor(good).replace('\n', '; ')}; } || true`,
      'R2 set +e first': `set +e\n${pairFor(good)}`,
      'R3 a shell without -e': pairFor(good),
      'R4 a pin holding a second line': `SUM="$(printf 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  /dev/null\\n')"\n${pairFor('${SUM}')}`,
    };
    for (const [why, script] of Object.entries(forms)) {
      rmSync(join(d, 'f'), { force: true });
      const r = spawnSync('bash', ['--noprofile', '--norc', '-c', `f=f\n${script}\n[ -e "$f" ] && echo USED || echo NOTHING`], { cwd: d, encoding: 'utf8', env: { ...process.env, PATH: `${d}:${process.env.PATH}` } });
      assert.match(r.stdout, /NOTHING\s*$/, `${why}: ${r.stdout} ${r.stderr}`);
    }
    // And the right bytes do land.
    writeFileSync(join(d, 'curl'), '#!/usr/bin/env bash\nout=\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done\nprintf good > "$out"\n', { mode: 0o755 });
    const ok = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', `f=f\n${pairFor(good)}\ncat "$f"`], { cwd: d, encoding: 'utf8', env: { ...process.env, PATH: `${d}:${process.env.PATH}` } });
    assert.equal(ok.stdout.trim().split('\n').at(-1), 'good', ok.stderr);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('a composite action used by a root job is judged as root (R1228d D5 X3)', () => {
  const problems: string[] = [];
  const files = [
    { name: '.github/workflows/zz.yml', text: `jobs:\n  t:\n    container: { image: x }\n    steps:\n      - uses: ./.github/actions/zz\n` },
    { name: '.github/actions/zz/action.yml', text: `runs:\n  using: composite\n  steps:\n    - shell: ${HELPER_SHELL}\n      env:\n        BASH_ENV: ''\n      run: /usr/bin/bash -p "$GITHUB_WORKSPACE/${HELPER}" "${REL}" ${PIN} "$f"\n` },
  ];
  workflowFiles(files, (n, p) => problems.push(`${n}: ${p}`));
  assert.match(problems.join(), /\.github\/actions\/zz\/action\.yml: .*from the checkout in a step that runs as root/);
  problems.length = 0;
  workflowFiles([{ ...files[0]!, text: files[0]!.text.replace('    container: { image: x }\n', '') }, files[1]!], (n, p) => problems.push(`${n}: ${p}`));
  assert.deepEqual(problems.filter((p) => !/an action this lint doesn't allow/.test(p)), [], 'used by no root job: the helper is the one way');
});

test('the scripts lint: the last --retry counts, comments and continuations are read as the shell reads them', () => {
  const bad = {
    'no retry': `curl -fsSL -o g "${REL}"`,
    'a later --retry 0': 'curl -fsSL --retry 5 --retry 0 -o g "$u"',
    'the retry only in a comment': 'curl -fsSL -o g "$u" # --retry 5',
    'a continued line': 'curl -fsSL \\\n  -o g "$u"',
    'a nodejs.org body piped': 'curl -fsSL "https://nodejs.org/dist/v1/x.tar.xz" | tar -xJ',
    'a helper function with no retry': 'fetch() { curl -fsSL -o "$work/$3" "$1"; echo "$2  $work/$3" | sha256sum -c -; }',
    'combined -O': 'curl -fsSLO "$u"',
    '--output=': 'curl -fsSL --output=g "$u"',
    'wget to a file': 'wget -O g "$u"',
    'wget to stdout': 'wget -O- "$u" | tar -xz',
    'gh release download': 'gh release download v1 -R a/b',
    'R1228d S1 a body redirected to a file': 'curl -fsSL "$url" > "$out"',
    'R1228d S2 a body piped from a variable URL': 'curl -fsSL "$url" | tar -xz -C "$dir"',
    'R1228d S2 a body captured': 'body="$(curl -fsSL "$url")"',
    'R1228d S3 wget with a later -O to a file': 'wget -q -O /dev/null "$u" -O "$out"',
    'R1228d S4 a config file that resets the retry': 'curl --retry 3 -K "$cfg" -o "$out" "$url"',
  };
  for (const [why, s] of Object.entries(bad)) assert.ok(scriptProblems(s).problems.length > 0, `refused: ${why}`);
  const good = {
    'a retried download': 'curl -fsSL --retry 3 -o "$out" "$url"',
    'a retried download, continued': 'curl -fsSL --proto \'=https\' \\\n  --retry 3 -o "$work/$3" "$1"',
    'a status probe': `answers() { [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" 2>/dev/null || true)" = 200 ]; }`,
    'a wget egress probe to /dev/null': 'docker run --rm "$img" wget -T 10 -O /dev/null https://github.com/',
    'a mention in a comment': '# wget -O g "$u"',
    'curl as a word in an install list': 'apt-get install -y -q uidmap git curl ca-certificates tar',
    'a body piped, retried': 'curl -fsSL --retry 3 "$url" | tar -xz -C "$dir"',
  };
  for (const [why, s] of Object.entries(good)) assert.deepEqual(scriptProblems(s).problems, [], `kept: ${why}`);
  assert.equal(lastRetry('curl --retry 5 --retry-delay 9 -o f u'), 5, '--retry-delay is not --retry');
  assert.ok(isShell('x.bash', '') && isShell('stand-in', '#!/usr/bin/env bash\n') && !isShell('x.mjs', '#!/usr/bin/env bash\n'), '.bash files and shebang scripts are walked');
});

test('R1228g D1: a workflow using a local action outside .github (whose action.yml the walk never reads) is reported', () => {
  const problems: string[] = [];
  const text = 'on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./tools/zzdl\n        with:\n          url: https://example.com/x\n';
  workflowFiles([{ name: '.github/workflows/planted.yml', text }], (name, p) => problems.push(`${name}: ${p}`));
  assert.ok(problems.some((p) => /^\.github\/workflows\/planted\.yml: an action this lint doesn't allow .*: \.\/tools\/zzdl$/.test(p)), problems.join('\n'));
});

test(`every pinned download in .github goes through ${HELPER}, and nothing else there downloads (#1201)`, () => {
  const problems: string[] = [];
  let helperLines = 0;
  let inline = 0;
  const files = walk(join(repoRoot, '.github'), (p) => /\.ya?ml$/.test(p)).sort().map((f) => ({ name: relative(repoRoot, f), text: readFileSync(f, 'utf8') }));
  for (const { name, text } of files) {
    helperLines += text.split('\n').filter((l) => HELPER_LINE.test(l)).length;
    for (const p of workflowTextProblems(text)) problems.push(`${name}: ${p}`);
  }
  inline = workflowFiles(files, (name, p) => problems.push(`${name}: ${p}`));
  const allCmds = files.flatMap(({ text }) => scalars(parse(text) as Doc)).flatMap((v) => logicalLines(v).flatMap((l) => commands(l)));
  for (const p of WORKFLOW_PROBES) assert.ok(allCmds.includes(p), `an allowed workflow probe is gone; remove it from WORKFLOW_PROBES: ${p}`);
  assert.deepEqual(problems, []);
  assert.ok(helperLines + inline >= 9, `found ${helperLines} helper lines and ${inline} inline pairs: the lint must see the workflows' 9 pinned downloads`);
  assert.ok(inline >= 2, `found ${inline} inline pairs: the test shards' Chrome and gitleaks downloads are root container steps`);
});

test("every download in the setup and CI scripts retries, the helpers in bootstrap.sh and ci-runner.sh among them", () => {
  const problems: string[] = [];
  const seen = new Map<string, number>();
  // R1228f D4: shell files anywhere in the repo (under .github too), not only under scripts/.
  const skip = new Set(['node_modules', 'dist', '.git', '.claude']);
  // R1228ai D1: every file the lint reads (readByDownloadLint), not only shell scripts.
  const lintFiles = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      if (skip.has(n)) return [];
      const p = join(d, n);
      const st = statSync(p);
      return st.isDirectory() ? lintFiles(p) : st.isFile() && st.size < 2_000_000 && readByDownloadLint(relative(repoRoot, p), readFileSync(p, 'utf8').slice(0, 200)) ? [p] : [];
    });
  for (const f of lintFiles(repoRoot).sort()) {
    const name = relative(repoRoot, f);
    const probes = SCRIPT_PROBES[name] ?? [];
    const cmds = logicalLines(readFileSync(f, 'utf8')).flatMap(commands);
    for (const p of probes) assert.ok(cmds.includes(p), `${name}: the allowed probe is gone; remove it from SCRIPT_PROBES: ${p}`);
    const r = fileDownloadProblems(name, readFileSync(f, 'utf8'), probes);
    seen.set(name, r.downloads);
    for (const p of r.problems) problems.push(`${name}: ${p}`);
  }
  assert.deepEqual(problems, []);
  for (const f of ['scripts/bootstrap.sh', 'scripts/setup/ci-runner.sh', 'scripts/setup/tools.sh', 'scripts/setup/test-user.sh', 'scripts/setup/node.sh', HELPER]) {
    assert.ok((seen.get(f) ?? 0) >= 1, `${f}: the lint must see its download`);
  }
});


test('R1228f: any spelling of curl, bash-joined continuations, YAML escapes, gh api on release assets, a downloader action and an unread shell file are refused', () => {
  const refused = (s: string) => decodedProblems(s).length + runProblems(s).length > 0;
  const U = 'https://example.com/tool.tgz';
  const forms: Record<string, string> = {
    '/usr/bin/curl': `/usr/bin/curl -sSfL -o f ${U}`,
    '\\curl': `\\curl -sSfL -o f ${U}`,
    '"curl"': `"curl" -sSfL -o f ${U}`,
    'sudo -E curl': `sudo -E curl -sSfL -o f ${U}`,
    'env -i curl': `env -i curl -sSfL -o f ${U}`,
    'nice curl': `nice curl -sSfL -o f ${U}`,
    'timeout -s KILL 60 curl': `timeout -s KILL 60 curl -sSfL -o f ${U}`,
    'bash -c "curl …"': `bash -c "curl -sSfL -o f ${U}"`,
    'command -v curl': 'c="$(command -v curl)"\n"$c" -sSfL -o f "$u"',
    'a variable URL kept': 'curl -sSfL -o f "$u"',
    'curl --url=': `curl -sSfL --url=${U} -o f`,
    'a continuation inside the word (bash joins it to curl)': `cu\\\nrl -sSfL -o f ${U}`,
    'gh release split across lines': "gh release \\\n  download v8.30.1 -R gitleaks/gitleaks -p 'x.tar.gz'",
    'gh api on a release asset': `gh api -H 'Accept: application/octet-stream' "repos/a/b/releases/$KIND/123" > f`,
    'a shell file outside the walked folders': 'bash test/zz-get.sh',
  };
  for (const [why, s] of Object.entries(forms)) assert.ok(refused(s), `refused: ${why}`);
  // A YAML escape decodes to wget of a pinned URL: the decoded scalar is what is read.
  const doc = parse('jobs:\n  a:\n    steps:\n      - run: "w\\x67et -q -O g https://github.com/a/b/releases\\x2Fdownload/x"\n') as Doc;
  assert.ok(scalars(doc).some((v) => decodedProblems(v).length > 0), 'a YAML escape hides nothing');
  // A downloader action, and the actions used today.
  assert.equal(USES_ALLOWED.test('robinraju/release-downloader@v1'), false);
  assert.equal(USES_ALLOWED.test('actions/checkout@v7'), false, 'by tag: refused (pinned by commit only)');
  for (const u of ['actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'Vampire/setup-wsl@d1da7f2c0322a5ee4f24975344f67fc0f5baf364', './.github/workflows/ci-slow.yml']) assert.ok(USES_ALLOWED.test(u), u);
  // R1228g D1: a local action outside .github, or one reached through `..`, is refused.
  for (const u of ['./tools/zzdl', './.github/../tools/zzdl', './.github/actions/../../tools/zzdl', './.github/actions/a/b', './scripts/ci', './.github/actions/setup', './.github/workflows/../x.yml']) assert.equal(USES_ALLOWED.test(u), false, u);
  // Kept: probes and loopback, and a shell file under scripts/ or .github/.
  for (const s of ['curl -sf "$GH_FAKE/repos/example/alpha" >/dev/null', `curl -fsS -o /dev/null ${U}`, 'curl -sS -o f "http://127.0.0.1:8080/x"', 'bash scripts/ci/x.sh', '/usr/bin/bash -p "$GITHUB_WORKSPACE/scripts/ci/fetch-pinned.sh" "https://x/y" ' + PIN + ' f'.replace('https://x/y', 'https://example.com/y')]) {
    assert.deepEqual(runProblems(s), [], `kept: ${s}`);
  }
  // The scripts rule: xargs curl, /usr/bin/curl with no retry.
  assert.ok(scriptProblems('xargs -n1 curl -fsSL -O < urls').problems.length > 0, 'xargs curl');
  assert.ok(scriptProblems('/usr/bin/curl -fsSL -o f "$u"').problems.length > 0, '/usr/bin/curl');
  assert.ok(scriptProblems('"curl" -fsSL -o f "$u"').problems.length > 0, '"curl" (read with its quotes off)');
});

/** Runs the helper with a stub curl first on PATH: it logs its argv and writes `body` to its -o target, or exits `rc`. */
function runHelper(args: (d: string) => string[], opts: { body?: string; rc?: number; stale?: boolean; bashArgs?: string[]; env?: (d: string) => Record<string, string> } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'fetch-pinned-'));
  try {
    // The helper calls its tools by absolute path (#1181 R1181l 2): it runs as a copy whose /usr/bin paths point at the
    // stub curl and this machine's own tools; nothing else in it changes.
    let text = readFileSync(join(repoRoot, HELPER), 'utf8');
    for (const t of ['curl', 'sha256sum', 'mktemp', 'rm', 'mv']) text = text.split(`/usr/bin/${t} `).join(`${t === 'curl' ? join(d, 'curl') : spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim()} `);
    writeFileSync(join(d, 'helper.sh'), text);
    writeFileSync(
      join(d, 'curl'),
      '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" > "$STUB_LOG"\nout=\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done\n' +
        '[ "$STUB_RC" = 0 ] || exit "$STUB_RC"\nprintf %s "$STUB_BODY" > "$out"\n',
      { mode: 0o755 },
    );
    if (opts.stale) writeFileSync(join(d, 'out.bin'), 'stale');
    const r = spawnSync('bash', [...(opts.bashArgs ?? []), join(d, 'helper.sh'), ...args(d)], {
      cwd: d,
      encoding: 'utf8',
      env: { ...process.env, STUB_LOG: join(d, 'log'), STUB_BODY: opts.body ?? '', STUB_RC: String(opts.rc ?? 0), ...(opts.env?.(d) ?? {}) },
    });
    return {
      status: r.status,
      stderr: r.stderr,
      out: existsSync(join(d, 'out.bin')) ? readFileSync(join(d, 'out.bin'), 'utf8') : null,
      parts: readdirSync(d).filter((n) => n.includes('.part')),
      curlArgs: existsSync(join(d, 'log')) ? readFileSync(join(d, 'log'), 'utf8').trim().split('\n') : null,
    };
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test('the helper: a matching download lands at its out file, fetched over https with the retry, and nothing else is left', () => {
  const r = runHelper((d) => [REL, sha('hello'), join(d, 'out.bin')], { body: 'hello' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out, 'hello');
  assert.deepEqual(r.parts, []);
  const a = r.curlArgs!;
  assert.equal(a[0], '-q', 'curl reads no ~/.curlrc: -q comes first (R1228d D7)');
  for (const flag of ['-fsSL', '--retry-all-errors', '--tlsv1.2']) assert.ok(a.includes(flag), `curl gets ${flag}`);
  // Bounded in time (R1228d D2): a stalled try ends (under 1 KB/s for 60 s), and no retry begins after
  // --retry-max-time. Not a whole-transfer cap (R1228e D1: --max-time 60 needed ~27 Mbit/s for Chrome's 203 MB).
  assert.equal(a.includes('--max-time'), false);
  assert.equal(a[a.indexOf('--speed-limit') + 1], '1024');
  assert.equal(a[a.indexOf('--speed-time') + 1], '60');
  assert.equal(a[a.indexOf('--connect-timeout') + 1], '20');
  assert.equal(a[a.indexOf('--retry-max-time') + 1], '120');
  // An unpredictable part file beside the out file (mktemp), never a name a link could be planted at (R1228d D7).
  assert.match(a[a.indexOf('-o') + 1]!, /\/out\.bin\.part\.[A-Za-z0-9]{6}$/);
  assert.equal(a[a.indexOf('--proto') + 1], '=https');
  assert.ok(Number(a[a.lastIndexOf('--retry') + 1]) >= 3, 'curl retries at least 3 times');
  assert.equal(a.at(-1), REL, 'the URL is the last argument');
});

test('the helper: a sha256 mismatch exits 1 and leaves nothing at the out file, a stale file there included', () => {
  for (const stale of [false, true]) {
    const r = runHelper((d) => [REL, sha('expected'), join(d, 'out.bin')], { body: 'tampered', stale });
    assert.equal(r.status, 1, `stale=${stale}: ${r.stderr}`);
    assert.match(r.stderr, /sha256 mismatch/);
    assert.equal(r.out, null, `stale=${stale}: nothing is at the out file`);
    assert.deepEqual(r.parts, []);
  }
});

test('the helper: a failed download exits non-zero and leaves nothing; a bad argument exits 2 before any download', () => {
  const failed = runHelper((d) => [REL, sha('x'), join(d, 'out.bin')], { rc: 22, stale: true });
  assert.notEqual(failed.status, 0);
  assert.equal(failed.out, null);
  assert.deepEqual(failed.parts, []);
  const badArgs: Record<string, (d: string) => string[]> = {
    'an http URL': (d) => ['http://example.com/x', sha('x'), join(d, 'out.bin')],
    'an upper-case pin': (d) => [REL, sha('x').toUpperCase(), join(d, 'out.bin')],
    'a short pin': (d) => [REL, sha('x').slice(1), join(d, 'out.bin')],
    'an empty out file': () => [REL, sha('x'), ''],
    'two arguments': () => [REL, sha('x')],
    'four arguments': (d) => [REL, sha('x'), join(d, 'out.bin'), 'extra'],
  };
  for (const [why, args] of Object.entries(badArgs)) {
    const r = runHelper(args, { body: 'x' });
    assert.equal(r.status, 2, `${why}: ${r.stderr}`);
    assert.equal(r.curlArgs, null, `${why}: curl never ran`);
  }
});

test('the .github scan reads decoded strings and every uses: (R1228f D3, D4), as the repo scan runs it', () => {
  const problems: string[] = [];
  workflowFiles([{ name: '.github/workflows/zz.yml', text: 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "w\\x67et -q -O g https://github.com/a/b/releases\\x2Fdownload/x"\n      - uses: robinraju/release-downloader@v1\n' }], (n, p) => problems.push(`${n}: ${p}`));
  assert.match(problems.join('\n'), /zz\.yml: a pinned URL not on a scripts\/ci\/fetch-pinned\.sh line: wget/, 'the escaped wget of a pinned URL');
  assert.match(problems.join('\n'), /zz\.yml: an action this lint doesn't allow .*robinraju\/release-downloader@v1/);
});

test('R1228h D1, R1228i D1-D3: a local Docker action, the helper by another path, other URL spellings and a custom shell are refused at the scan', () => {
  const GL = 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz';
  const wf = (steps: string) => `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;
  const scan = (files: { name: string; text: string }[]) => {
    const problems: string[] = [];
    workflowFiles(files, (n, p) => problems.push(`${n}: ${p}`));
    return problems;
  };
  const helper = `/usr/bin/bash -p "$GITHUB_WORKSPACE/${HELPER}" "${GL}" ${PIN} gl.tgz`;
  // The control: the helper line as CI writes it passes.
  assert.deepEqual(scan([{ name: '.github/workflows/k1.yml', text: wf(`      - shell: ${HELPER_SHELL}\n        env:\n          BASH_ENV: ''\n        run: |\n          ${helper}\n`) }]), []);
  const refused: Record<string, { name: string; text: string }[]> = {
    // R1228h D1 (probe C): a local Docker action whose Dockerfile curls the pinned release.
    'a local Docker action': [
      { name: '.github/workflows/zz-probe.yml', text: wf('      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n      - uses: ./.github/actions/zzdock\n') },
      { name: '.github/actions/zzdock/action.yml', text: 'runs:\n  using: docker\n  image: Dockerfile\n' },
    ],
    // R1228i D1 (L1-L4): the helper by a relative path, a working directory, or a reassigned ws or GITHUB_WORKSPACE.
    'L1 cd, then a relative path': [{ name: '.github/workflows/l1.yml', text: wf(`      - run: |\n          cd tools\n          bash scripts/ci/fetch-pinned.sh "${GL}" ${PIN} gl.tgz\n`) }],
    'L2 a working directory': [{ name: '.github/workflows/l2.yml', text: wf(`      - working-directory: tools\n        run: |\n          ${helper}\n`) }],
    'L3 ws reassigned': [{ name: '.github/workflows/l3.yml', text: wf(`      - run: |\n          ws=tools\n          /usr/bin/bash -p "$ws/${HELPER}" "${GL}" ${PIN} gl.tgz\n`) }],
    'L3b ws from the workspace, then reassigned': [{ name: '.github/workflows/l3b.yml', text: wf(`      - run: |\n          ws="$(wslpath -u '\${{ github.workspace }}')"\n          ws=tools\n          /usr/bin/bash -p "$ws/${HELPER}" "${GL}" ${PIN} gl.tgz\n`) }],
    'L4 GITHUB_WORKSPACE reassigned': [{ name: '.github/workflows/l4.yml', text: wf(`      - run: |\n          GITHUB_WORKSPACE="$PWD/tools"\n          ${helper}\n`) }],
    'L4b GITHUB_WORKSPACE set by an env': [{ name: '.github/workflows/l4b.yml', text: wf(`      - env:\n          GITHUB_WORKSPACE: /tmp/tools\n        run: |\n          ${helper}\n`) }],
    // R1228i D2 (L14): a pinned URL spelled with a doubled slash, handed to a script.
    'L14 releases//download': [{ name: '.github/workflows/l14.yml', text: wf(`      - run: bash scripts/ci/zz-get.sh "${GL.replace('releases/download', 'releases//download')}" gl.tgz\n`) }],
    'NODEJS.ORG': [{ name: '.github/workflows/l16.yml', text: wf('      - run: bash scripts/ci/zz-get.sh "https://NODEJS.ORG/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz" n.tar.xz\n') }],
    // R1228i D3 (L15, L17): a custom shell that is curl, its run a curl config.
    'L15 shell: curl -K {0}, a pinned URL': [{ name: '.github/workflows/l15.yml', text: wf(`      - shell: curl -fsSL -K {0}\n        run: |\n          url = "${GL.replace('releases/download', 'releases//download')}"\n          output = "gl.tgz"\n`) }],
    'L17 shell: curl -K {0}, any https URL': [{ name: '.github/workflows/l17.yml', text: wf('      - shell: curl -fsSL -K {0}\n        run: |\n          url = "https://example.com/tool.tgz"\n          output = "tool.tgz"\n') }],
    'a default shell': [{ name: '.github/workflows/ds.yml', text: `on: push\ndefaults:\n  run:\n    shell: curl -fsSL -K {0}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n` }],
  };
  for (const [what, files] of Object.entries(refused)) assert.notDeepEqual(scan(files), [], what);
  // ci-slow's own WSL form passes.
  assert.deepEqual(scan([{ name: '.github/workflows/ws.yml', text: wf(`      - shell: ${HELPER_SHELL}\n        env:\n          BASH_ENV: ''\n        run: |\n          ws="$(wslpath -u '\${{ github.workspace }}')" home=/h\n          v="$(sed -n 's/^V=//p' "$ws/scripts/bootstrap.sh")"\n          /usr/bin/bash -p "$ws/${HELPER}" "https://nodejs.org/dist/$v/node-$v-linux-x64.tar.xz" "$sum" /tmp/node.tar.xz\n`) }]), []);
});

test('R1228i D1, D2: a look-alike helper anywhere else is refused, and the pinned-URL rule reads the spellings the servers accept', () => {
  assert.deepEqual(lookAlikes([HELPER, 'scripts/ci/other.sh']), []);
  assert.equal(lookAlikes(['tools/scripts/ci/fetch-pinned.sh']).length, 1);
  for (const u of ['https://github.com/o/r/releases//download/v1/x.tgz', 'https://NODEJS.ORG/dist/v22.11.0/node.tar.xz', 'https://nodejs.org//dist/v22/x', 'https://github.com/o/r/RELEASES/DOWNLOAD/v1/x']) assert.ok(DOWNLOAD.test(u), u);
  // L6, L16: a script naming such a URL outside the helper is refused by the scan's pinned-URL rule, which is DOWNLOAD
  // over each line (above); and a workflow scalar by decodedProblems.
  assert.ok(decodedProblems('curl -fsSL --retry 3 -o gl.tgz "https://github.com/o/r/releases//download/v1/x.tgz"').length > 0, 'L6 in a workflow');
});

// --- Owner decision (c), 2026-11-09: the cheap structural hardenings; the helper's digest check is the guarantee ---
test('owner decision (c): the helper is run with bash -p, so a BASH_ENV function named by a tool\'s absolute path never checks the download; plain bash runs it (the control)', { skip: process.platform === 'win32' }, () => {
  const tool = spawnSync('sh', ['-c', 'command -v sha256sum'], { encoding: 'utf8' }).stdout.trim();
  if (!tool) return;
  const env = (d: string) => {
    writeFileSync(join(d, 'env.sh'), `${tool}() { cat >/dev/null; return 0; }\n`);
    return { BASH_ENV: join(d, 'env.sh') };
  };
  const plain = runHelper((d) => [REL, sha('expected'), join(d, 'out.bin')], { body: 'tampered', env });
  assert.equal(plain.status, 0, 'control, plain bash: the function stands in for the tool and the tampered file lands');
  const p = runHelper((d) => [REL, sha('expected'), join(d, 'out.bin')], { body: 'tampered', env, bashArgs: ['-p'] });
  assert.notEqual(p.status, 0, 'bash -p reads no BASH_ENV: the real tool checks it, and it is refused');
  assert.equal(p.out, null);
  // A function exported into the environment (BASH_FUNC_…): bash -p takes none either.
  const f = runHelper((d) => [REL, sha('expected'), join(d, 'out.bin')], { body: 'tampered', bashArgs: ['-p'], env: () => ({ [`BASH_FUNC_${tool}%%`]: '() { cat >/dev/null; return 0; }' }) });
  assert.notEqual(f.status, 0);
});

test('owner decision (c): a helper line without -p, a run with the helper that sets BASH_ENV or ENV or exports a function, and a step env giving them a value are refused; clearing them is kept', () => {
  const H = `/usr/bin/bash -p "$GITHUB_WORKSPACE/${HELPER}" "${REL}" ${PIN} "$f"`;
  assert.deepEqual(runProblems(H), [], 'the helper line');
  const noP = H.replace('bash -p ', 'bash ');
  assert.ok(decodedProblems(noP).length + runProblems(noP).length > 0, 'without -p: its pinned URL is on no helper line');
  for (const pre of ['BASH_ENV=/tmp/e', 'export BASH_ENV=/tmp/e', 'ENV=/tmp/e', 'declare -x BASH_ENV="$x"', 'export -f sha256sum', 'declare -fx sha256sum', 'typeset -xf mv', 'export BASH_FUNC_x%%="() { :; }"']) {
    assert.ok(runProblems(`${pre}\n${H}`).length > 0, `refused: ${pre}`);
  }
  for (const pre of ["BASH_ENV=''", 'BASH_ENV=', 'unset BASH_ENV ENV', '# export -f x in a comment']) assert.deepEqual(runProblems(`${pre}\n${H}`), [], `kept: ${pre}`);
  const wf = (env: string) => ({ name: '.github/workflows/x.yml', text: `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - shell: ${HELPER_SHELL}\n${env}        run: |\n          ${H}\n` });
  const problems = (text: { name: string; text: string }) => {
    const out: string[] = [];
    workflowFiles([text], (_n, p) => out.push(p));
    return out;
  };
  assert.deepEqual(problems(wf("        env:\n          BASH_ENV: ''\n")), [], 'cleared: kept');
  // R1228l D1 (N2): a helper step must clear BASH_ENV in its own env (only that overrides GITHUB_ENV).
  assert.match(problems(wf('')).join(), /a step that runs scripts\/ci\/fetch-pinned\.sh without `env: BASH_ENV: ''`/, 'not cleared: refused');
  assert.match(problems(wf('        env:\n          OTHER: x\n')).join(), /without `env: BASH_ENV: ''`/, 'an env without it: refused');
  assert.match(problems(wf('        env:\n          BASH_ENV: /tmp/e\n')).join(), /BASH_ENV given a value in the env of a step that runs/);
  assert.match(problems(wf("        env:\n          BASH_ENV: ''\n          ENV: /tmp/e\n")).join(), /ENV given a value/);
  const jobLevel = { name: '.github/workflows/y.yml', text: `on: push\nenv:\n  BASH_ENV: /tmp/e\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - shell: ${HELPER_SHELL}\n        env:\n          BASH_ENV: ''\n        run: |\n          ${H}\n` };
  assert.match(problems(jobLevel).join(), /BASH_ENV given a value/, 'from the workflow level too');
});

test('owner decision (c): a shell file is read only from the checkout\'s root: anchored, no `..`, bash\'s options read past', () => {
  for (const c of ['bash /tmp/x/scripts/y.sh', 'bash "/tmp/x/.github/y.sh"', 'bash scripts/../../tmp/y.sh', 'bash -x /tmp/x/scripts/y.sh', 'source ~/scripts/y.sh', 'bash $HOME/scripts/y.sh', 'bash -p test/zz.sh']) {
    assert.match(runProblems(c).join(), /a shell file the download lint doesn't read/, c);
  }
  for (const c of ['bash scripts/ci/x.sh', 'bash ./scripts/ci/x.sh', 'bash .github/x.sh', 'bash "$GITHUB_WORKSPACE/scripts/ci/x.sh"', 'bash -x scripts/ci/x.sh', 'bash "$ws/scripts/x.sh"']) {
    assert.deepEqual(runProblems(c).filter((p) => /shell file/.test(p)), [], c);
  }
  // $WS: only in a run that sources /etc/wl-ci.env and never sets WS.
  assert.deepEqual(runProblems('. /etc/wl-ci.env\nbash "$WS/scripts/bootstrap.sh" --yes').filter((p) => /shell file/.test(p)), [], 'sourced');
  assert.match(runProblems('bash "$WS/scripts/bootstrap.sh"').join(), /shell file/, 'not sourced');
  assert.match(runProblems('. /etc/wl-ci.env\nWS=/tmp/x\nbash "$WS/scripts/bootstrap.sh"').join(), /shell file/, 'WS set in the run');
});

test("R1228l D1: the helper line's `bash` found by name: a BASH_ENV from GITHUB_ENV (N2), PATH in the run (N3), a bash function, alias or hashed path (M3) are refused; a stand-in on GITHUB_PATH (N1) is a stated limit", () => {
  const GL = 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz';
  const helper = `/usr/bin/bash -p "$GITHUB_WORKSPACE/${HELPER}" "${GL}" ${PIN} gl.tgz`;
  const clear = `        shell: ${HELPER_SHELL}\n        env:\n          BASH_ENV: ''\n`;
  const wf = (steps: string) => ({ name: '.github/workflows/zz-attack.yml', text: `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n${steps}` });
  const scan = (f: { name: string; text: string }) => {
    const out: string[] = [];
    workflowFiles([f], (_n, p) => out.push(p));
    return out;
  };
  // N2 (attacks-1228l/plants/N2-github-env-bash-env): an earlier step writes BASH_ENV to GITHUB_ENV; the helper step's
  // own shell would read it. Refused unless the helper step clears it in its own env.
  const n2 = (env: string) => wf(`      - run: echo "BASH_ENV=$GITHUB_WORKSPACE/scripts/ci/zz-fn.sh" >> "$GITHUB_ENV"\n      - run: |\n          ${helper}\n`.replace('      - run: |\n', `      - ${env ? `${env.trimStart()}        ` : ''}run: |\n`));
  assert.match(scan(n2('')).join(), /without `env: BASH_ENV: ''`/, 'N2: refused');
  assert.deepEqual(scan(n2(clear)), [], 'N2 control: the helper step clears BASH_ENV: kept');
  // N3: PATH set in the helper's own run.
  assert.match(scan(wf(`      - ${clear.trimStart()}        run: |\n          mkdir -p /tmp/b && cp scripts/ci/zz-bash.sh /tmp/b/bash && chmod +x /tmp/b/bash\n          export PATH="/tmp/b:$PATH"\n          ${helper}\n`)).join(), /PATH set in a run with/, 'N3: refused');
  // M3 and its kin: `bash` made to name something else in the helper's run.
  for (const pre of ['bash() { shift 2; command bash scripts/ci/zz-get.sh "$@"; }', 'function bash { :; }', 'f() { :; }; bash () { :; }', "alias bash='sh'", 'hash -p /tmp/b/bash bash', 'PATH=/tmp/b:$PATH', 'export PATH=/tmp/b:$PATH', 'declare -x PATH=/tmp/b', 'PATH+=:/tmp/b']) {
    assert.ok(runProblems(`${pre}\n${helper}`).length > 0, `refused: ${pre}`);
  }
  for (const pre of ['echo "$PATH"', 'bashful() { :; }', 'command -v bash', '# bash() { :; } in a comment', 'MYPATH=/x', 'hash -r']) {
    assert.deepEqual(runProblems(`${pre}\n${helper}`), [], `kept: ${pre}`);
  }
  // N1, a stated limit (below): a stand-in `bash` an earlier step puts on GITHUB_PATH isn't seen. A fix shows up here.
  assert.deepEqual(scan(wf(`      - run: |\n          mkdir -p "$RUNNER_TEMP/b" && cp scripts/ci/zz-bash.sh "$RUNNER_TEMP/b/bash" && chmod +x "$RUNNER_TEMP/b/bash"\n          echo "$RUNNER_TEMP/b" >> "$GITHUB_PATH"\n      - ${clear.trimStart()}        run: |\n          ${helper}\n`)), [], 'N1: not seen (a stated limit)');
});

test("R1228o D1, D2: a helper step's own shell is the privileged /usr/bin/bash and its line names /usr/bin/bash -p; the one WSL step is excepted by workflow, job and step", () => {
  const GL = 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz';
  const line = (pre: string) => `${pre} "$GITHUB_WORKSPACE/${HELPER}" "${GL}" ${PIN} gl.tgz`;
  const scan = (f: { name: string; text: string }) => {
    const out: string[] = [];
    workflowFiles([f], (_n, p) => out.push(p));
    return out;
  };
  const wf = (shell: string, run: string) => ({ name: '.github/workflows/zz.yml', text: `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - name: get\n${shell}        env:\n          BASH_ENV: ''\n        run: |\n          ${run}\n` });
  assert.deepEqual(scan(wf(`        shell: ${HELPER_SHELL}\n`, line('/usr/bin/bash -p'))), [], 'the helper step as CI writes it');
  for (const [what, shell] of [['no shell', ''], ['bash', '        shell: bash\n'], ['bash -p not by its path', '        shell: bash --noprofile --norc -p -eo pipefail {0}\n']] as const) {
    assert.match(scan(wf(shell, line('/usr/bin/bash -p'))).join(), /without `shell: \/usr\/bin\/bash --noprofile --norc -p -eo pipefail \{0\}`/, `refused: ${what}`);
  }
  // The helper line by its absolute path only: `bash -p` (PATH, the hash table) is no helper line, so its URL is refused.
  for (const pre of ['bash -p', '/bin/bash -p', '/usr/bin/bash', 'command bash -p', '/usr/local/bin/bash -p']) {
    assert.match(scan(wf(`        shell: ${HELPER_SHELL}\n`, line(pre))).join(), /a pinned URL not on a scripts\/ci\/fetch-pinned\.sh line/, `refused: ${pre}`);
  }
  // The WSL exception: that one step, by workflow, job and step name, under the job's `wsl-bash {0}` default.
  const wsl = (file: string, job: string, step: string, stepShell = '') => ({ name: `.github/workflows/${file}`, text: `on: push\njobs:\n  ${job}:\n    runs-on: windows-latest\n    defaults:\n      run:\n        shell: wsl-bash {0}\n    steps:\n      - name: ${JSON.stringify(step)}\n${stepShell}        env:\n          BASH_ENV: ''\n        run: |\n          ${WS_FROM_WORKSPACE}\n          /usr/bin/bash -p "$ws/${HELPER}" "https://nodejs.org/dist/$v/node-$v-linux-x64.tar.xz" "$sum" /tmp/node.tar.xz\n` });
  const step = "fetch the bootstrap's pinned Node inside WSL, for packing below";
  assert.deepEqual(scan(wsl('ci-slow.yml', 'bootstrap-windows', step)), [], 'the pinned step');
  assert.match(scan(wsl('ci-slow.yml', 'bootstrap-windows', `${step} again`)).join(), /without `shell:/, 'another step name');
  assert.match(scan(wsl('ci-slow.yml', 'other-job', step)).join(), /without `shell:/, 'another job');
  assert.match(scan(wsl('ci-other.yml', 'bootstrap-windows', step)).join(), /without `shell:/, 'another workflow');
  assert.match(scan(wsl('ci-slow.yml', 'bootstrap-windows', step, '        shell: wsl-bash {0}\n')).join(), /without `shell:/, 'its shell set on the step');
});

test("R1228p D1-D3: a function named /usr/bin/bash, a second step named as the WSL exception, and the helper named other than on a helper line are refused", () => {
  const GL = 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz';
  const line = `/usr/bin/bash -p "$GITHUB_WORKSPACE/${HELPER}" "${GL}" ${PIN} gl.tgz`;
  // D1: A5, A6 (and the plain `bash` forms); `bashful()` and a `bash` command are kept.
  for (const pre of ['/usr/bin/bash() { printf EVIL > "$5"; }', 'function /usr/bin/bash { :; }', '/usr/bin/bash () { :; }', 'bash() { :; }', 'function bash { :; }']) {
    assert.match(runProblems(`${pre}\n${line}`).join(), /`bash` redefined/, `refused: ${pre}`);
  }
  for (const pre of ['bashful() { :; }', 'function bashrc_load { :; }', '/usr/bin/bash --version', 'echo bash']) {
    assert.deepEqual(runProblems(`${pre}\n${line}`).filter((p) => /redefined/.test(p)), [], `kept: ${pre}`);
  }
  // D3 (V3): the helper by another form, its URL built from pieces: no DOWNLOAD URL on the line, so before this no rule fired.
  for (const call of [`bash "$GITHUB_WORKSPACE/${HELPER}" "$u" ${PIN} gl.tgz`, `/usr/bin/bash -p "$GITHUB_WORKSPACE/${HELPER}" "$u" ${PIN} gl.tgz`, `sh scripts/ci/fetch-pinned.sh "$u" ${PIN} gl.tgz`, `. "$GITHUB_WORKSPACE/${HELPER}"`]) {
    assert.match(runProblems(`u="https://github.com/a/b/rel""eases/download/v1/x.tgz"\n${call}`).join(), /named other than on a helper line/, `refused: ${call}`);
  }
  assert.deepEqual(runProblems(`# ${HELPER} is the one downloader\n${line}`).filter((p) => /named other than/.test(p)), [], 'a comment naming it is kept');
  assert.deepEqual(runProblems(line), [], 'the helper line itself');
  // D2 (W1): the pinned WSL step, copied under the same name into the same job.
  const wslStep = (out: string) => `      - name: "fetch the bootstrap's pinned Node inside WSL, for packing below"\n        env:\n          BASH_ENV: ''\n        run: |\n          ${WS_FROM_WORKSPACE}\n          /usr/bin/bash -p "$ws/${HELPER}" "https://nodejs.org/dist/$v/node-$v-linux-x64.tar.xz" "$sum" ${out}\n`;
  const wsl = (steps: string) => ({ name: '.github/workflows/ci-slow.yml', text: `on: push\njobs:\n  bootstrap-windows:\n    runs-on: windows-latest\n    defaults:\n      run:\n        shell: wsl-bash {0}\n    steps:\n${steps}` });
  const scan = (f: { name: string; text: string }) => {
    const out: string[] = [];
    workflowFiles([f], (_n, p) => out.push(p));
    return out;
  };
  assert.deepEqual(scan(wsl(wslStep('/tmp/node.tar.xz'))), [], 'control: the one pinned step');
  const twice = scan(wsl(wslStep('/tmp/node.tar.xz') + wslStep('/tmp/node2.tar.xz'))).join(' | ');
  assert.match(twice, /2 steps named as the one WSL helper step/, 'W1: a second step under the pinned name');
  assert.match(twice, /without `shell:/, 'and neither is excepted');
});

test("R1228r, R1228s: the helper named by its file stem in any other spelling is refused; the one WSL step runs one helper line; a name built at run time is a stated limit", () => {
  const pre = 'u="https://github.com/a/b/rel""eases/download/v1/x.tgz"\n';
  // X1-X3, S2-S4 (S5 is S1's shape with no shell key: the same line), W2's quote split: each keeps the stem.
  for (const call of [
    `bash "$GITHUB_WORKSPACE/scripts/ci/./fetch-pinned.sh" "$u" ${PIN} gl.tgz`,
    `bash "$GITHUB_WORKSPACE/scripts//ci/fetch-pinned.sh" "$u" ${PIN} gl.tgz`,
    `bash scripts/ci/./fetch-pinned.sh "$u" ${PIN} gl.tgz`,
    `bash "$GITHUB_WORKSPACE/scripts/ci/"fetch-pinned.sh "$u" ${PIN} gl.tgz`,
    `bash "$ws/scripts/ci/"fetch-pinned.sh "$u" "$sum" /tmp/node2.tar.xz`,
    `cp scripts/ci/fetch-pinned.sh /tmp/x.sh`,
    // R1228ac D2: read with quotes and backslashes taken out, so a quote split or an escape around the stem is the path
    // (C12, C13), and so is X4's quote split inside the stem (a stated limit until now).
    `bash "$GITHUB_WORKSPACE/scripts/ci/""fetch-pinned"".sh" "$u" ${PIN} gl.tgz`,
    `bash $GITHUB_WORKSPACE/scripts/ci/\\fetch-pinned\\.sh "$u" ${PIN} gl.tgz`,
    `f="scripts/ci/fetch-pin""ned.sh"; bash "$f" "$u" ${PIN} gl.tgz`,
  ]) assert.match(runProblems(pre + call).join(), /named other than on a helper line/, `refused: ${call}`);
  // A name built at run time (S1 a glob, S6 a bracket class, S7 a variable): not seen. A
  // stated limit (code in the job, out of scope; the digest still checks): a fix shows up here as a change.
  for (const call of [`bash scripts/ci/fetch-pinne?.sh "$u" ${PIN} gl.tgz`, `bash scripts/ci/fetch-pinne[d].sh "$u" ${PIN} gl.tgz`, `h=fetch-; bash "$GITHUB_WORKSPACE/scripts/ci/\${h}pinned.sh" "$u" ${PIN} gl.tgz`]) {
    assert.deepEqual(runProblems(pre + call).filter((p) => /named other than/.test(p)), [], `not seen (a stated limit): ${call}`);
  }
  const scan = (f: { name: string; text: string }) => {
    const out: string[] = [];
    workflowFiles([f], (_n, p) => out.push(p));
    return out;
  };
  const step = (name: string, extra: string) => `      - name: ${JSON.stringify(name)}\n        env:\n          BASH_ENV: ''\n        run: |\n          ${WS_FROM_WORKSPACE}\n          /usr/bin/bash -p "$ws/${HELPER}" "https://nodejs.org/dist/$v/node-$v-linux-x64.tar.xz" "$sum" /tmp/node.tar.xz\n${extra}`;
  const wsl = (steps: string) => ({ name: '.github/workflows/ci-slow.yml', text: `on: push\njobs:\n  bootstrap-windows:\n    runs-on: windows-latest\n    defaults:\n      run:\n        shell: wsl-bash {0}\n    steps:\n${steps}` });
  const pinned = "fetch the bootstrap's pinned Node inside WSL, for packing below";
  assert.deepEqual(scan(wsl(step(pinned, ''))), [], 'control: the pinned step, one helper line');
  // W2: a second helper line (here the literal one) in the excepted step.
  assert.match(scan(wsl(step(pinned, `          /usr/bin/bash -p "$ws/${HELPER}" "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz" ${PIN} /tmp/gl.tgz\n`))).join(), /more than one helper line in the one WSL helper step/);
  // W3: another WSL step, another name, the helper by a quote split: refused by the stem.
  assert.match(scan(wsl(step(pinned, '') + `      - name: other\n        run: |\n          ${WS_FROM_WORKSPACE}\n          /usr/bin/bash -p "$ws/scripts/ci/"fetch-pinned.sh "$u" "$sum" /tmp/n2\n`)).join(), /named other than on a helper line/);
});

test("R1228u D1, N1: the helper's path in an env:, matrix or with: value is refused; a pin read from the release's own asset digest is refused", () => {
  const scan = (text: string) => {
    const out: string[] = [];
    workflowFiles([{ name: '.github/workflows/zz.yml', text }], (_n, p) => out.push(p));
    return out;
  };
  const wf = (job: string) => `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n${job}`;
  // E1: env, E2: matrix, and a with: value: the whole literal path, off a helper line.
  assert.match(scan(wf(`    steps:\n      - shell: bash\n        env:\n          FETCH: scripts/ci/fetch-pinned.sh\n          U: \${{ vars.GITLEAKS_URL }}\n        run: bash "$FETCH" "$U" ${PIN} gl.tgz\n`)).join(), /named in \S+ off a helper line/, 'E1: an env: value');
  assert.match(scan(wf(`    strategy:\n      matrix:\n        helper: [scripts/ci/fetch-pinned.sh]\n    steps:\n      - shell: bash\n        run: bash "\${{ matrix.helper }}" "\${{ vars.GITLEAKS_URL }}" ${PIN} gl.tgz\n`)).join(), /named in \S+ off a helper line/, 'E2: a matrix value');
  assert.match(scan(wf(`    env:\n      H: ./scripts/ci/./fetch-pinned.sh\n    steps:\n      - shell: bash\n        run: bash "$H" "$U" ${PIN} gl.tgz\n`)).join(), /named in \S+ off a helper line/, 'a job-level env value, another spelling');
  // The helper step as CI writes it: no report from the value check (its run is a helper line).
  const GL = 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz';
  assert.deepEqual(scan(wf(`    steps:\n      - name: get\n        shell: ${HELPER_SHELL}\n        env:\n          BASH_ENV: ''\n        run: |\n          /usr/bin/bash -p "$GITHUB_WORKSPACE/${HELPER}" "${GL}" ${PIN} gl.tgz\n`)), [], 'control: the helper step');
  // N1: the pin read at run time from the release itself (GitHub's asset digest): no pin. Refused as a fetch.
  assert.match(decodedProblems(`sum="$(gh release view v8.30.1 -R gitleaks/gitleaks --json assets --jq '.assets[0].digest')"`).join(), /./, 'gh release view … assets');
  assert.deepEqual(decodedProblems('gh release view v1 --json tagName'), [], 'control: a release view that reads no asset');
});

test("R1228v D1: on: paths, a step's name and a hashFiles() key are kept; the values a shell can receive are refused", () => {
  const scan = (name: string, text: string) => {
    const out: string[] = [];
    workflowFiles([{ name, text }], (_n, p) => out.push(p));
    return out;
  };
  const GL = 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz';
  const helperStep = `      - name: get\n        shell: ${HELPER_SHELL}\n        env:\n          BASH_ENV: ''\n        run: |\n          /usr/bin/bash -p "$GITHUB_WORKSPACE/${HELPER}" "${GL}" ${PIN} gl.tgz\n`;
  // Must pass: FR1 the repo's own convention, a script listed in on.<event>.paths; FR2 a step named for it; FR3 a cache key hashing it.
  const fr1 = `on:\n  pull_request:\n    paths:\n      - scripts/ci/fetch-pinned.sh\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n${helperStep}`;
  const fr2 = `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n${helperStep.replace('- name: get', '- name: gitleaks via fetch-pinned')}`;
  const fr3 = `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/cache@0400d5f644dc74513175e3cd8d07132dd4860809\n        with:\n          path: x\n          key: x-\${{ hashFiles('scripts/ci/fetch-pinned.sh') }}\n${helperStep}`;
  for (const [what, text] of [['FR1 on.pull_request.paths', fr1], ['FR2 a step name', fr2], ['FR3 a hashFiles() key', fr3]] as const) {
    assert.deepEqual(scan('.github/workflows/zz.yml', text).filter((p) => /named in/.test(p)), [], `kept: ${what}`);
  }
  // Must refuse: a matrix include, a composite step's with:, and an input's default (workflow_call, composite).
  const off = /named in \S+ off a helper line/;
  assert.match(scan('.github/workflows/zz.yml', `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        include:\n          - helper: scripts/ci/fetch-pinned.sh\n    steps:\n      - run: echo hi\n`).join(), off, 'a matrix include');
  assert.match(scan('.github/workflows/zz.yml', `on: push\nenv:\n  F: scripts/ci/fetch-pinned.sh\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`).join(), off, 'a workflow-level env');
  assert.match(scan('.github/workflows/zz.yml', `on:\n  workflow_call:\n    inputs:\n      h:\n        type: string\n        default: scripts/ci/fetch-pinned.sh\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`).join(), /named in on\.workflow_call\.inputs\.h\.default off a helper line/, 'a workflow_call input default');
  assert.match(scan('.github/actions/zz/action.yml', `inputs:\n  h:\n    default: scripts/ci/fetch-pinned.sh\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: echo hi\n`).join(), /named in inputs\.h\.default off a helper line/, "a composite action's input default");
  assert.match(scan('.github/actions/zz/action.yml', `runs:\n  using: composite\n  steps:\n    - uses: actions/cache@0400d5f644dc74513175e3cd8d07132dd4860809\n      with:\n        path: scripts/ci/fetch-pinned.sh\n`).join(), off, "a composite step's with:");
});

test("R1228x/y D1: every value but those under a key that never reaches a shell is checked: workflow_dispatch defaults and options, a container's env, a job's outputs refused; if: and a services container's env kept", () => {
  const scan = (text: string) => {
    const out: string[] = [];
    workflowFiles([{ name: '.github/workflows/zz.yml', text }], (_n, p) => out.push(p));
    return out.filter((p) => /named in/.test(p));
  };
  const H = 'scripts/ci/fetch-pinned.sh';
  const job = (extra: string, steps = '      - run: echo hi\n') => `    runs-on: ubuntu-latest\n${extra}    steps:\n${steps}`;
  // Must refuse (each a plain, parameterised form the narrowed check missed).
  const refused: [string, string, RegExp][] = [
    ['P1 a workflow_dispatch input default', `on:\n  workflow_dispatch:\n    inputs:\n      h:\n        default: ${H}\njobs:\n  a:\n${job('')}`, /on\.workflow_dispatch\.inputs\.h\.default/],
    ['P1b a choice input option', `on:\n  workflow_dispatch:\n    inputs:\n      h:\n        type: choice\n        options: [${H}]\njobs:\n  a:\n${job('')}`, /on\.workflow_dispatch\.inputs\.h\.options\.0/],
    ['P2 a container env', `on: push\njobs:\n  a:\n${job(`    container:\n      image: x\n      options: --user 1001\n      env:\n        FETCH: ${H}\n`)}`, /jobs\.a\.container\.env\.FETCH/],
    ['P3 a job output', `on: push\njobs:\n  a:\n${job(`    outputs:\n      h: ${H}\n`)}`, /jobs\.a\.outputs\.h/],
    ['P4 an output through a step env', `on: push\njobs:\n  a:\n${job(`    outputs:\n      h: ${H}\n`)}  b:\n    needs: a\n${job('', '      - env:\n          FETCH: ${{ needs.a.outputs.h }}\n        run: echo hi\n')}`, /jobs\.a\.outputs\.h/],
  ];
  for (const [what, text, where] of refused) {
    const got = scan(text).join(' | ');
    assert.match(got, /named in \S+ off a helper line/, `refused: ${what}`);
    assert.match(got, where, `names where: ${what}`);
  }
  // Must pass: under keys that never reach a shell.
  for (const [what, text] of [
    ['FR4 if: hashFiles()', `on: push\njobs:\n  a:\n${job('', `      - if: hashFiles('${H}') != ''\n        run: echo hi\n`)}`],
    ['P6 a services container env', `on: push\njobs:\n  a:\n${job(`    services:\n      db:\n        image: x\n        env:\n          F: ${H}\n`)}`],
    ['on.push.paths-ignore', `on:\n  push:\n    paths-ignore: [${H}]\njobs:\n  a:\n${job('')}`],
  ] as const) assert.deepEqual(scan(text), [], `kept: ${what}`);
});

test("R1228z/aa D1, D2: skipped by structural path only (an env, matrix, input or output entry named name, run, uses, if or runs-on is read); the stem only as a path (an id or a description naming it is kept)", () => {
  const scan = (text: string, file = '.github/workflows/zz.yml') => {
    const out: string[] = [];
    workflowFiles([{ name: file, text }], (_n, p) => out.push(p));
    return out.filter((p) => /named in|named other than/.test(p));
  };
  const H = 'scripts/ci/fetch-pinned.sh';
  const steps = '    steps:\n      - run: echo hi\n';
  for (const key of ['name', 'run', 'uses', 'if', 'runs-on']) {
    for (const [what, text, where] of [
      ['a step env', `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - env:\n          ${key}: ${H}\n        run: echo hi\n`, `jobs.a.steps.0.env.${key}`],
      ['a job env', `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    env:\n      ${key}: ${H}\n${steps}`, `jobs.a.env.${key}`],
      ['a matrix key', `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        ${key}: [${H}]\n${steps}`, `jobs.a.strategy.matrix.${key}.0`],
      ['an input', `on:\n  workflow_dispatch:\n    inputs:\n      ${key}:\n        default: ${H}\njobs:\n  a:\n    runs-on: ubuntu-latest\n${steps}`, `on.workflow_dispatch.inputs.${key}.default`],
      ['an output', `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    outputs:\n      ${key}: ${H}\n${steps}`, `jobs.a.outputs.${key}`],
    ] as const) {
      const got = scan(text).join(' | ');
      assert.ok(got.includes(`named in ${where} off a helper line`), `refused: ${what} named ${key}: ${got}`);
    }
  }
  // D2: the bare stem, not a path: a step id, an input's description, a step name.
  const kept = `on:\n  workflow_dispatch:\n    inputs:\n      h:\n        description: which fetch-pinned run to repeat\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - id: fetch-pinned\n        name: fetch-pinned gitleaks\n        run: echo "\${{ steps.fetch-pinned.outputs.x }}"\n`;
  assert.deepEqual(scan(kept), [], 'an id, a description and a name naming the stem');
  // The path forms are still refused, in a value and in a run.
  assert.match(scan(`on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    env:\n      X: ./scripts/ci/./fetch-pinned.sh\n${steps}`).join(), /named in jobs\.a\.env\.X/);
  assert.match(runProblems(`bash "$GITHUB_WORKSPACE/scripts/ci/"fetch-pinned.sh "$u" ${PIN} gl.tgz`).join(), /named other than on a helper line/);
});

test("R1228ab, R1228ac: what GitHub hands a step is read (the workflow's name, a job's or step's uses); a description naming the helper's path is kept; the bare stem in a value is a stated limit", () => {
  const scan = (text: string, file = '.github/workflows/zz.yml') => {
    const out: string[] = [];
    workflowFiles([{ name: file, text }], (_n, p) => out.push(p));
    return out.filter((p) => /named in|named other than/.test(p));
  };
  const H = 'scripts/ci/fetch-pinned.sh';
  const job = '    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n';
  // D1/D3: $GITHUB_WORKFLOW and github.workflow; job.workflow_file_path; a composite action's $GITHUB_ACTION_PATH.
  assert.match(scan(`name: check ${H}\non: push\njobs:\n  a:\n${job}`).join(), /named in name off a helper line/, "the workflow's name");
  assert.match(scan(`on: push\njobs:\n  a:\n    uses: ./.github/workflows/fetch-pinned.sh\n`).join(), /named in jobs\.a\.uses off a helper line/, "a job's uses");
  assert.match(scan(`on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./scripts/ci/fetch-pinned\n`).join(), /named in jobs\.a\.steps\.0\.uses off a helper line/, "a step's uses");
  assert.match(scan(`name: x\nruns:\n  using: composite\n  steps:\n    - uses: ./scripts/ci/fetch-pinned\n`, '.github/actions/zz/action.yml').join(), /named in runs\.steps\.0\.uses off a helper line/, "a composite step's uses");
  // D2/D4: a description is shown, never handed to a step (R1228aa FR-b as F1, and FA1).
  assert.deepEqual(scan(`on:\n  workflow_dispatch:\n    inputs:\n      ver:\n        description: gitleaks version (downloaded through ${H})\n  workflow_call:\n    inputs:\n      a:\n        description: see ${H}\n        type: string\n    outputs:\n      o:\n        description: from ${H}\n        value: x\n    secrets:\n      s:\n        description: for ${H}\njobs:\n  a:\n${job}`), [], 'F1: input, output and secret descriptions');
  assert.deepEqual(scan(`name: x\ndescription: Downloads pinned gitleaks through ${H}\ninputs:\n  out:\n    description: where ${H} writes the tarball\noutputs:\n  o:\n    description: what ${H} wrote\n    value: x\nruns:\n  using: composite\n  steps:\n    - run: echo hi\n      shell: bash\n`, '.github/actions/zz/action.yml'), [], "FA1: an action's description and its inputs' and outputs'");
  // Kept as before: a step's name (FR2), if: hashFiles (FR4). (FR5, run-name, is read since R1228ad D1.)
  assert.deepEqual(scan(`on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - name: run ${H}\n        if: hashFiles('${H}') != ''\n        run: echo hi\n`), []);
  // A description's value under another key is still read: an input's default.
  assert.match(scan(`on:\n  workflow_dispatch:\n    inputs:\n      description:\n        default: ${H}\njobs:\n  a:\n${job}`).join(), /named in on\.workflow_dispatch\.inputs\.description\.default/, 'an input named description');
  // C1, C2: the bare stem in a value, the folder and .sh added in the run: a stated limit (a fix shows up here).
  assert.deepEqual(scan(`on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    env:\n      H: fetch-pinned\n    strategy:\n      matrix:\n        tool: [fetch-pinned]\n    steps:\n      - run: echo hi\n`), [], 'C1, C2: not seen (a stated limit)');
});

test("R1228ad, R1228ae: run-name, which reaches another workflow's steps through its event, and (a precaution) a job's name are read; a one-line run: helper line is kept; the stem after a / only as a whole name", () => {
  const scan = (text: string, file = '.github/workflows/zz.yml') => {
    const out: string[] = [];
    workflowFiles([{ name: file, text }], (_n, p) => out.push(p));
    return out;
  };
  const named = (text: string) => scan(text).filter((p) => /named in|named other than/.test(p));
  const H = 'scripts/ci/fetch-pinned.sh';
  const job = '    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n';
  // ad D1 (W1): github.event.workflow_run.display_title in a workflow on: workflow_run.
  assert.match(named(`name: zz producer\nrun-name: ${H}\non: push\njobs:\n  a:\n${job}`).join(), /named in run-name off a helper line/, 'run-name');
  // A precaution (R1228af D1): no trigger's payload carries a job's name, but it is read.
  assert.match(named(`on: push\njobs:\n  a:\n    name: build ${H}\n${job}`).join(), /named in jobs\.a\.name off a helper line/, "a job's name");
  assert.deepEqual(named(`on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - name: run ${H}\n        run: echo hi\n`), [], "a step's name: no trigger's payload holds it");
  // ae D1 (G1): the helper step as CI writes it, its one helper line on the run: key's own line.
  const URL = 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz';
  const step = (run: string) => `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - shell: ${HELPER_SHELL}\n        env:\n          BASH_ENV: ''\n        ${run}\n`;
  const line = `/usr/bin/bash -p "$GITHUB_WORKSPACE/${H}" "${URL}" ${PIN} gl.tgz`;
  // The file's text, line by line (the repo scan's first check), and its decoded values.
  for (const check of [workflowTextProblems, (t: string) => scan(t)]) {
    assert.deepEqual(check(step(`run: ${line}`)).filter((p) => /not on a .* line/.test(p)), [], 'G1: a one-line run:');
    assert.deepEqual(check(step(`run: '${line}'`)).filter((p) => /not on a .* line/.test(p)), [], "G1b: in YAML single quotes (R1228af D2)");
    assert.deepEqual(check(step(`run: |\n          ${line}`)).filter((p) => /not on a .* line/.test(p)), [], 'G0: the same in a block');
  }
  assert.match(workflowTextProblems(step(`run: echo ${URL}`)).join(), /a pinned URL not on a/, 'control: the URL off a helper line, one-line');
  assert.match(workflowTextProblems(step(`run: ${line}; echo done`)).join(), /a pinned URL not on a/, 'control: more after the helper call');
  // ae D2 (G4, G5): a folder named after the helper is another name; G3 (the stem alone after a /) is still taken.
  assert.deepEqual(named(`on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: mkdir -p "$RUNNER_TEMP/fetch-pinned-logs"\n`), [], 'G4');
  assert.deepEqual(named(`on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    env:\n      LOGS: \${{ runner.temp }}/fetch-pinned_logs/x\n    steps:\n      - run: echo hi\n`), [], 'G5-like: an underscore name');
  assert.match(named(`on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: mkdir -p "$RUNNER_TEMP/fetch-pinned"\n`).join(), /named other than on a helper line/, 'G3: still refused');
  for (const f of ['bash scripts/ci/fetch-pinned "$u"', 'bash scripts/ci/fetch-pinned.sh "$u"', 'x=/fetch-pinned;']) assert.match(named(`on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${f}\n`).join(), /named other than/, `still refused: ${f}`);
});

test('R1228ai D1: a pinned download in a file a workflow runs is read wherever the lint can: package.json scripts, a Makefile, any file under scripts/, a Dockerfile; bash or sh running any file outside scripts/ is refused', () => {
  const C = `curl -fsSL -o gl.tgz ${REL}`;
  const has = (rel: string, text: string) => readByDownloadLint(rel, text) && fileDownloadProblems(rel, text).problems.length > 0;
  // T1-T4: each read, and refused (a pinned URL off the helper, and no retry).
  for (const [what, rel, text] of [
    ['T1 a package.json script', 'package.json', JSON.stringify({ name: 'x', scripts: { 'zz:get': C } })],
    ['T1 a package.json under a folder', 'tools/package.json', JSON.stringify({ scripts: { get: C } })],
    ['T2 a .mk file', 'tools.mk', `gitleaks:\n\t${C}\n`],
    ['T2 a Makefile', 'tools/Makefile', `gitleaks:\n\t${C}\n`],
    ['T3 a file under scripts/ with no extension and no shebang', 'scripts/ci/get-gitleaks', `${C}\n`],
    ['T3 a .txt under scripts/', 'scripts/ci/get.txt', `${C}\n`],
    ['T4 a Dockerfile', 'Dockerfile', `FROM ubuntu:24.04\nRUN ${C} && tar -xzf gl.tgz\n`],
    ['T4 a named Dockerfile', 'docker/Dockerfile.ci', `FROM x\nRUN ${C}\n`],
  ] as const) {
    assert.ok(has(rel, text), `refused: ${what}`);
    assert.ok(fileDownloadProblems(rel, text).problems.some((p) => /a pinned URL outside/.test(p)), `the URL named: ${what}`);
  }
  // package.json: its scripts only, so another field's URL (a homepage on raw.githubusercontent.com) isn't a download.
  assert.deepEqual(fileDownloadProblems('package.json', JSON.stringify({ homepage: 'https://raw.githubusercontent.com/a/b/main/README.md', scripts: { build: 'tsc' } }, null, 2)).problems, [], 'a URL outside scripts');
  // The retry rule in what a shell runs, a URL the pinned list doesn't know included (T3's "no retry").
  assert.match(fileDownloadProblems('scripts/ci/get-tool', 'curl -fsSL -o t.tgz https://example.com/t.tgz\n').problems.join(), /a download with no retry/);
  assert.deepEqual(fileDownloadProblems('scripts/ci/get-tool', 'curl -fsSL --retry 5 -o t.tgz https://example.com/t.tgz\n').problems, [], 'control: with a retry');
  assert.match(fileDownloadProblems('Dockerfile', 'FROM x\nRUN curl -fsSL -o t https://example.com/t\n').problems.join(), /a download with no retry/);
  // Not run by a shell: a README or a node script is read for a pinned URL only (a node download is a stated limit).
  assert.deepEqual(fileDownloadProblems('scripts/bench/README.md', 'curl -fsSL https://claude.ai/install.sh | bash\n').problems, []);
  assert.deepEqual(fileDownloadProblems('scripts/bench/confirm.ts', "if (form !== 'curl') x();\n").problems, []);
  assert.match(fileDownloadProblems('scripts/x.mjs', `const u = '${REL}';\n`).problems.join(), /a pinned URL outside/, 'a pinned URL in a node file under scripts/');
  assert.ok(!readByDownloadLint('src/x.ts', `const u = '${REL}';`), 'src/ is not a file a workflow runs as a script');
  // The run rule: bash or sh with any file, not only .sh (T3), outside scripts/ or .github/ refused; inside read.
  for (const c of ['bash tools/get-gitleaks', 'sh -e tools/get', 'bash ./tools/get.bash', 'bash -x /tmp/get']) assert.match(runProblems(c).join(), /a shell file the download lint doesn't read/, `refused: ${c}`);
  for (const c of ['bash scripts/ci/get-gitleaks', 'sh scripts/ci/x', 'bash -c "echo hi"', 'bash -lc "make x"', 'sh -s < x', '. /etc/wl-ci.env', 'source ./env']) assert.ok(!/a shell file the download lint doesn't read/.test(runProblems(c).join()), `kept: ${c}`);
});

test('R1228aj, R1228ak: bash and sh read by their own option rules and wherever a command runs them; lowercase makefile and dockerfile read; a Dockerfile RUN read past a comment line; a README link kept', () => {
  // ak D1, aj D3: legitimate lines, refused at 11dcd3d6 (the option's argument or a long option taken for the file).
  for (const c of ['bash --version', 'bash --help', 'bash --noprofile --norc scripts/ci/x.sh', 'bash -o pipefail scripts/ci/x.sh', 'bash -eo pipefail scripts/ci/x.sh', 'bash -O extglob scripts/ci/x.sh', 'sh -- scripts/ci/x', 'bash --login -c "make"', 'bash --login scripts/ci/x.sh', 'bash scripts/ci/x.sh', 'bash -e scripts/ci/x.sh', 'bash -lc "make x"', 'sh -s < x', '/usr/bin/bash -p "$GITHUB_WORKSPACE/scripts/ci/x.sh"', '. /etc/wl-ci.env']) {
    assert.deepEqual(runProblems(c).filter((p) => /a shell file the download lint doesn't read/.test(p)), [], `kept: ${c}`);
  }
  assert.equal(shellFileOf(['bash', '-eo', 'pipefail', 'tools/get']), 'tools/get');
  assert.equal(shellFileOf(['bash', '--noprofile', '--norc', '--', '-weird']), '-weird');
  // aj D1, ak D2 (K2, K2b, B-group): a prefix before bash, at any command position.
  for (const c of ['bash -o pipefail tools/get', 'GL_VERSION=8.30.1 bash tools/get-gitleaks', 'sudo bash tools/get-gitleaks', 'sudo -E -u runner bash tools/get', 'env X=1 bash tools/get', 'env -i bash tools/get', 'time bash tools/get', 'timeout 300 bash tools/get', 'nice -n 5 bash tools/get', 'exec bash tools/get', 'if bash tools/get; then :; fi', '( bash tools/get )', 'cd x && bash ../tools/get', 'true; sh tools/get', 'echo | bash tools/get', '/bin/bash tools/get']) {
    assert.match(runProblems(c).join(), /a shell file the download lint doesn't read/, `refused: ${c}`);
  }
  // ak D2 (K3, K4): a file the lint reads running an unread one.
  assert.match(fileDownloadProblems('package.json', JSON.stringify({ scripts: { 'zz:get': 'bash tools/get-gitleaks' } })).problems.join(), /a shell file the download lint doesn't read/, 'K3');
  assert.match(fileDownloadProblems('tools.mk', 'gitleaks:\n\tbash tools/get-gitleaks\n').problems.join(), /a shell file the download lint doesn't read/, 'K4');
  assert.match(fileDownloadProblems('scripts/ci/x.sh', 'bash tools/get\n').problems.join(), /a shell file the download lint doesn't read/, 'a shell script');
  assert.deepEqual(fileDownloadProblems('package.json', JSON.stringify({ scripts: { get: 'bash scripts/ci/get-gitleaks', build: 'tsc' } })).problems, [], 'kept: a read file');
  // aj D2, ak D3 (K5, K6): make's default makefile, and a lowercase dockerfile.
  for (const rel of ['makefile', 'mk/makefile', 'docker/dockerfile', 'x.dockerfile', 'dockerfile.ci']) {
    assert.ok(readByDownloadLint(rel, ''), `read: ${rel}`);
    assert.match(fileDownloadProblems(rel, `x:\n\tcurl -fsSL -o t ${REL}\n`).problems.join(), /a pinned URL outside/, `refused: ${rel}`);
  }
  // ak D4 (K7): a comment line inside a continued RUN.
  assert.match(fileDownloadProblems('Dockerfile', 'FROM x\nRUN curl -fsSL \\\n# --retry 5 \\\n    -o /tmp/t.tgz https://example.com/t.tgz\n').problems.join(), /a download with no retry/, 'K7');
  assert.deepEqual(fileDownloadProblems('Dockerfile', 'FROM x\nRUN curl -fsSL \\\n# a note \\\n    --retry 5 -o /tmp/t.tgz https://example.com/t.tgz\n').problems, [], 'kept: with a retry past the comment');
  // ak D5 (K8): a docs link in a README under scripts/.
  assert.deepEqual(fileDownloadProblems('scripts/bench/README.md', 'The default rules: https://raw.githubusercontent.com/gitleaks/gitleaks/master/config/gitleaks.toml\n').problems, [], 'K8');
  assert.match(fileDownloadProblems('scripts/x.mjs', `const u = '${REL}';\n`).problems.join(), /a pinned URL outside/, 'code under scripts/ still read');
});

test('R1228al, R1228am: every bash or sh word on a line is read, wherever it stands (case arms, else, substitutions, quotes, make prefixes, any wrapper); a redirection is no file, a stdin file is; a read script runs its own .sh siblings', () => {
  const refused = (c: string) => /a shell file the download lint doesn't read/.test(runProblems(c).join());
  // am D1 (wrappers' own options), al D2 / am D2 (positions), and the wrappers the Limits named: read by construction.
  for (const c of ['sudo -n bash tools/get', 'sudo -S bash tools/get', 'sudo -k bash tools/get', 'env -u X bash tools/get', 'nice -n5 bash tools/get', 'case "$x" in a) bash tools/get;; esac', 'if x; then :; else bash tools/get; fi', 'if x; then :; elif bash tools/get; then :; fi', 'y=$(bash tools/get)', 'y=`bash tools/get`', "sh -c 'bash tools/get'", 'runuser -u runner -- bash tools/get', 'xargs -a l bash tools/get', 'flock /tmp/l bash tools/get', 'setsid bash tools/get', 'stdbuf -oL bash tools/get']) {
    assert.ok(refused(c), `refused: ${c}`);
  }
  // al D1: a redirection is no file; a file on stdin is run.
  for (const c of ['bash scripts/ci/x.sh > /tmp/log', 'bash scripts/ci/x.sh 2>&1', 'bash < scripts/ci/x', 'bash -s < scripts/ci/x', 'bash > /tmp/log scripts/ci/x.sh']) assert.ok(!refused(c), `kept: ${c}`);
  for (const c of ['bash < tools/get', 'bash -s < tools/get', 'bash 2> /tmp/err tools/get']) assert.ok(refused(c), `refused: ${c}`);
  // am D3: make's recipe prefixes.
  for (const p of ['@', '-', '+', '@-']) assert.match(fileDownloadProblems('tools.mk', `x:\n\t${p}bash tools/get\n`).problems.join(), /a shell file the download lint doesn't read/, `make ${p}`);
  // am D4: in a read script, a sibling .sh is read wherever it is; another relative name is judged from the root.
  assert.deepEqual(fileDownloadProblems('scripts/ci/a.sh', 'cd "$(dirname "$0")" && bash b.sh\n. ./lib.sh\n').problems, [], 'S4, S5');
  assert.match(fileDownloadProblems('scripts/ci/a.sh', 'bash ../../../x.sh\n').problems.join(), /a shell file/, 'out of the checkout');
  assert.match(fileDownloadProblems('scripts/ci/a.sh', 'bash tools/get\n').problems.join(), /a shell file/, 'an unread extensionless file');
  // A bare name is no path (`useradd -s /bin/bash user`); a here-document runs no file.
  for (const c of ['useradd -m -s /bin/bash user', 'bash <<EOF', 'echo bash rocks']) assert.ok(!refused(c), `kept: ${c}`);
  // The repo's two any-position hits (a scratch repository's files, in exp-real-systemd.sh): relative .sh, so kept in a
  // read script; in a workflow run, judged from the root.
  assert.deepEqual(fileDownloadProblems('scripts/ci/exp-real-systemd.sh', "spec 5 'bash train.sh' | as_coord job x\n").problems, []);
  assert.ok(refused("spec 5 'bash train.sh'"), 'a workflow run: from the root');
});

// Limits (owner decision (c): stated, not closed; the helper's digest check holds for each download it handles):
// - What the lint reads (R1228ai D1, closing R1228i L9-L11; R1228aj, R1228ak): workflow and action YAML, a shell
//   script anywhere, every file under scripts/ whatever its name (a pinned URL, prose in a .md aside; the retry rule in
//   what a shell runs: an extensionless file too), package.json's scripts, a Makefile (makefile, GNUmakefile, *.mk) and
//   a Dockerfile (lowercase too; comment lines dropped before a RUN's continuations are joined). `bash` or `sh` running
//   a file outside scripts/ or .github/ is refused wherever the word stands on the line (R1228am: every bash/sh word
//   is read, inside quotes, substitutions, case arms, else branches and after any wrapper or make prefix), its options
//   read as bash reads them, a
//   redirection read past and a file on stdin read, in a workflow run, a package.json script, a Makefile recipe or a
//   shell script (where a relative .sh/.bash sibling is read wherever it is). A workflow run whose command starts with
//   `bash` is anchored at the checkout's root (owner decision (c)): an absolute path or a variable other than the
//   checkout's is refused. Not seen: elsewhere, a path that is absolute (an installed copy,
//   `/opt/<engine>/current/scripts/…`) or built from a variable (`"$here/x.sh"`), which can't be mapped to the
//   checkout; a bare name with no `/` and no `.sh` (`bash get`); a file piped in (`cat tools/get | bash`); a Dockerfile
//   RUN running a path inside the image (a COPY's target); and a file elsewhere that a workflow runs another way.
// - A download that never names a URL the lint knows (DOWNLOAD), through a tool it doesn't know (python, node, perl, a
//   compiled binary, an action not in USES_ALLOWED once allowed: a node or Python file's own download), or built from
//   pieces at run time, isn't seen.
// - **Code already running in the same job is out of scope.** The helper and its step shell run inside a job whose
//   earlier steps, and whose own run, can change what they run, and the lint doesn't model that. Structurally, a helper
//   step's shell is HELPER_SHELL (privileged: no imported function, no BASH_ENV) and its line names /usr/bin/bash -p (no
//   PATH or hash table); the rules on PATH, `bash` redefinition (any function name ending in `bash`, R1228p D1) and
//   BASH_ENV in its run catch the plain accidents. The structural rules recognise the helper named as a path: its stem
//   after a `/` or with `.sh`, read with quotes and backslashes taken out (R1228p D3, R1228r D1, R1228s, R1228z/aa D2,
//   R1228ac D2). The bare stem alone (`fetch-pinned`, an id, `needs:`, a word in a name) is not a call. They look in a
//   run and in every other value of a workflow or action but those at the exact places that never reach a step
//   (SKIPPED_PATHS, by structural path: on.<event>'s filters, step names, conditions, runner labels, timeouts,
//   concurrency, permissions, descriptions, a services container's env): anything not there is read by default, a key
//   named `name`, `run` or `if` inside env, matrix, with, inputs or outputs included, and so are the workflow's `name`
//   and a job's or step's `uses`, which GitHub hands every step, the `run-name`, which reaches another workflow's steps
//   through its event, and, as a precaution, a job's `name`, which no trigger's payload carries (R1228x/y D1,
//   R1228z/aa D1, R1228ab D1, R1228ad D1, R1228af D1). The one WSL step
//   runs one helper line. The stem after a `/` counts only as a whole name: `fetch-pinned-logs` is another (R1228ae
//   D2); an extensionless `…/fetch-pinned` folder is still taken for the helper.
//   Not seen, and not claimed:
//   - a pin read at run time is no pin: one read from the release itself (`gh release view … assets`, GitHub's asset
//     digest) is refused (R1228u N1), any other way of computing it isn't seen;
//   - the helper's name or path built from pieces at run time: a glob (`fetch-pinne?.sh`, `fetch-pinne[d].sh`), a
//     variable (`${h}pinned.sh`) (R1228s S1, S5-S7), or the bare stem in a value with the folder or `.sh` added in the
//     run (`env: H: fetch-pinned` and `scripts/ci/$H.sh`; a matrix value and `scripts/ci/${{ matrix.tool }}.sh`:
//     R1228ac C1, C2, refused before R1228z/aa D2 narrowed the stem to a path). That is code in the job, out of scope;
//     the digest still checks;
//   - LD_PRELOAD or LD_LIBRARY_PATH, from GITHUB_ENV or the same run, reach curl, sha256sum and mv by their absolute
//     paths (R1228n D1: L1, L2);
//   - every hosted runner has passwordless sudo, so an earlier step or the same run can replace /usr/bin/sha256sum,
//     /usr/bin/curl, /usr/local/bin/bash or /usr/bin/bash itself (R1228o D3: O7, O8, O8s; R1228n S1, S2);
//   - an exported `bash` function from a step, job or workflow `env:` key or from GITHUB_ENV (R1228o D1: O1, O1j, O1w,
//     O2): the privileged step shell doesn't import it, but the lint doesn't read those keys;
//   - a function named /usr/bin/bash defined by eval with a split name (`eval '/usr/bin/ba''sh() {…}'`) or in a sourced
//     file (R1228p D1: A4, A7): these stay open (the plain forms, A5 and A6, are refused);
//   - the plain spellings the PATH and `bash` rules don't read (read -r PATH, printf -v PATH, mapfile, for PATH in,
//     declare -n, BASH_CMDS[bash], BASH_ALIASES; R1228n B1, B2, B4, R1228o D2: O3-O6), which /usr/bin/bash -p makes
//     moot for the helper's own `bash`;
//   - the one WSL helper step (WSL_HELPER_STEPS): its step shell is setup-wsl's `wsl-bash {0}`, not HELPER_SHELL, so
//     what that shell takes from the environment (an exported `bash` function, BASH_ENV) and what earlier WSL steps put
//     in the distro (it keeps its filesystem between steps) can change what runs; only its helper line is held, and
//     a second step under its name is refused (R1228p D2);
//   - a stand-in `bash` on GITHUB_PATH (R1228l N1) is moot for the helper line, which names /usr/bin/bash.
// - The helper line runs whatever file is at its path, so a helper file changed before it runs isn't seen: by `sed -i`
//   or `cp` in the same run or an earlier step (M1, M2), or copied over from a folder no walk reads, such as `.claude/`
//   (M11). Nor is a GITHUB_WORKSPACE or `ws` reached another way: names split by quotes (M6 `GITHUB_WORK''SPACE=`, M8
//   `declare w''s=`), `ws` from GITHUB_ENV (M7), or a checkout of another repository (`actions/checkout` with
//   `repository:`, M9).
// - A self-hosted runner's own environment, a runner image or a pinned action that is itself compromised.
