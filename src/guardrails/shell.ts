// A small POSIX-ish shell splitter for guardrail matching. It finds every
// simple command in a command line: across ; && || | & and newlines, inside
// $(...), backticks, ( ) subshells, `bash -c '...'`, `eval`, and behind
// wrappers like sudo/env/xargs/timeout. It is a best-effort matcher, not a
// security boundary: credentials that make the action impossible are the
// real guard (docs/design.md §12).

export interface SimpleCommand {
  /** argv with leading VAR=value assignments and wrappers removed. */
  argv: string[];
  /** VAR=value assignments that prefixed the command. */
  assignments: Record<string, string>;
  /** Options given to an `env` wrapper (`-i`, `-u`, `-`): removed from argv with the wrapper. */
  envOptions: string[];
  /**
   * Files written by redirection (>, >>, &>) or tee, or that the command's own arguments name as changed: copied
   * or moved to, moved or removed, edited in place (sed -i, perl -i), created (touch, mkdir), linked, chmod-ed, dd of=.
   * A copy or move into what may be a directory is also listed with the file's name in it, so `cp x .claude`
   * counts as a write to `.claude/x`.
   */
  writes: string[];
  /** Files read by input redirection (`< file`); a here-document's word is not one. */
  reads: string[];
}

const COPY_LIKE = new Set(['cp', 'ln', 'install', 'rsync']);
const CHANGES_EACH = new Set(['rm', 'rmdir', 'unlink', 'touch', 'truncate', 'mkdir', 'shred']);
/** A chmod mode operand (octal, or symbolic such as u+x,go-w), not a file it changes. */
const CHMOD_MODE = /^([0-7]{1,4}|[ugoa]*([-+=][rwxXstugo]*)+(,[ugoa]*([-+=][rwxXstugo]*)+)*)$/;

/** Every operand of a command that it writes, moves or removes (see SimpleCommand.writes). */
function argumentWrites(base: string, argv: string[]): string[] {
  const args = argv.slice(1);
  const operands = args.filter((a) => !a.startsWith('-'));
  const into = (dest: string, srcs: string[]) => [dest, ...srcs.map((s) => `${dest.replace(/\/+$/, '')}/${basename(s)}`)];
  // mv also changes its sources: they're gone from where they were.
  if (base === 'mv') return operands.length < 2 ? [] : [...operands.slice(0, -1), ...into(operands.at(-1)!, operands.slice(0, -1))];
  if (COPY_LIKE.has(base)) return operands.length < 2 ? [] : into(operands.at(-1)!, operands.slice(0, -1));
  if (CHANGES_EACH.has(base)) return operands;
  // WHY: a mode can make a file a program stops running (a hook git skips once it isn't executable).
  if (base === 'chmod') return operands.filter((o) => !CHMOD_MODE.test(o));
  if (base === 'dd') return args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3));
  if (base === 'sed' || base === 'perl') {
    if (!args.some((a) => (base === 'sed' && a.startsWith('--in-place')) || /^-[a-zA-Z]*i/.test(a))) return [];
    // The script is the first operand unless given with -e/-f (or perl -e/-E); the rest are the files edited.
    const files: string[] = [];
    let script = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (/^-[a-zA-Z]*[efE]$/.test(a) || a === '--expression' || a === '--file') {
        script = true;
        i++;
      } else if (!a.startsWith('-')) {
        if (!script) script = true;
        else files.push(a);
      }
    }
    return files;
  }
  return [];
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
const WRAPPERS = new Set(['sudo', 'env', 'nohup', 'time', 'command', 'exec', 'nice', 'ionice', 'doas', 'builtin']);
const MAX_DEPTH = 8;

interface Token {
  text: string;
  op?: boolean;
}

/** Tokenize one level; $(...) and backtick bodies are returned for recursion. */
function tokenize(src: string, nested: string[]): Token[] {
  const out: Token[] = [];
  let cur = '';
  let has = false;
  const push = () => {
    if (has) out.push({ text: cur });
    cur = '';
    has = false;
  };
  let i = 0;
  const readUntilClose = (start: number, open: string, close: string): [string, number] => {
    let depth = 1;
    let j = start;
    let q: string | null = null;
    while (j < src.length) {
      const c = src[j]!;
      if (q) {
        if (c === '\\' && q === '"') j++;
        else if (c === q) q = null;
      } else if (c === "'" || c === '"') q = c;
      else if (c === '\\') j++;
      else if (src.startsWith(open, j)) depth++;
      else if (c === close && --depth === 0) return [src.slice(start, j), j + 1];
      j++;
    }
    return [src.slice(start), src.length];
  };
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\\') {
      if (src[i + 1] === '\n') {
        i += 2;
        continue;
      }
      cur += src[i + 1] ?? '';
      has = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      cur += src.slice(i + 1, end < 0 ? src.length : end);
      has = true;
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          cur += src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === '$' && src[j + 1] === '(') {
          const [body, next] = readUntilClose(j + 2, '(', ')');
          nested.push(body);
          cur += `$(${body})`;
          j = next;
          continue;
        }
        if (src[j] === '`') {
          const end = src.indexOf('`', j + 1);
          const body = src.slice(j + 1, end < 0 ? src.length : end);
          nested.push(body);
          cur += '`' + body + '`';
          j = end < 0 ? src.length : end + 1;
          continue;
        }
        cur += src[j];
        j++;
      }
      has = true;
      i = j + 1;
      continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      const [body, next] = readUntilClose(i + 2, '(', ')');
      nested.push(body);
      cur += `$(${body})`;
      has = true;
      i = next;
      continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      const body = src.slice(i + 1, end < 0 ? src.length : end);
      nested.push(body);
      cur += '`' + body + '`';
      has = true;
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (c === '#' && !has) {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (c === ' ' || c === '\t') {
      push();
      i++;
      continue;
    }
    // { and } are reserved words only as whole words: `{ a; }` groups, `{}` is a literal.
    const next = src[i + 1] ?? '';
    const groupBrace = !has && ((c === '{' && /\s/.test(next)) || (c === '}' && (next === '' || /[\s;)|&]/.test(next))));
    if (c === '\n' || c === ';' || c === '(' || c === ')' || groupBrace) {
      push();
      out.push({ text: c === '\n' ? ';' : c, op: true });
      i++;
      continue;
    }
    if (c === '&' || c === '|') {
      push();
      const two = src.slice(i, i + 2);
      if (two === '&&' || two === '||' || two === '|&') {
        out.push({ text: two, op: true });
        i += 2;
      } else if (c === '&' && src[i + 1] === '>') {
        out.push({ text: src[i + 2] === '>' ? '&>>' : '&>', op: true });
        i += src[i + 2] === '>' ? 3 : 2;
      } else {
        out.push({ text: c, op: true });
        i++;
      }
      continue;
    }
    if (c === '>' || c === '<') {
      // fd prefix like 2> stays attached to nothing: treat digits as part of op
      if (has && /^\d+$/.test(cur)) {
        cur = '';
        has = false;
      } else push();
      let op = c;
      if (src[i + 1] === c) op += c;
      else if (src[i + 1] === '&') op += '&';
      else if (src[i + 1] === '|') op += '|';
      out.push({ text: op, op: true });
      i += op.length;
      continue;
    }
    cur += c;
    has = true;
    i++;
  }
  push();
  return out;
}

const SEPARATORS = new Set([';', '&&', '||', '|', '|&', '&', '(', ')', '{', '}']);
const WRITE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>']);

/** A wrapper's options that take the next word as their value, so that word is not the command. */
const WRAPPER_VALUE_OPTIONS: Record<string, RegExp> = {
  sudo: /^-[ugCDhprtU]$/,
  env: /^--(unset|chdir|split-string)$/,
  nice: /^(-n|--adjustment)$/,
  ionice: /^(-[cnpPu]|--class|--classdata|--pid|--pgid|--uid)$/,
  exec: /^-[a-z]*a$/,
  doas: /^-[uC]$/,
  time: /^(-[fo]|--format|--output)$/,
};
/**
 * A short-option cluster as getopt and git's parse-options read it, given the letters that take a value: every
 * other letter is a flag and continues the cluster; the first value letter takes the rest of the word, or the next
 * word when it ends the word. `flags`: the letters before it. null for a word that isn't a short-option cluster.
 */
export function shortCluster(opt: string, valueLetters: string): { flags: string; letter?: string; attached: string } | null {
  if (!/^-[^-]/.test(opt)) return null;
  const j = [...opt].findIndex((ch, k) => k > 0 && valueLetters.includes(ch));
  return j < 0 ? { flags: opt.slice(1), attached: '' } : { flags: opt.slice(1, j), letter: opt[j]!, attached: opt.slice(j + 1) };
}
/** An env short-option cluster (GNU env's getopt string: "+C:iS:u:v0"); `-uCC` unsets CC. */
export const envShort = (opt: string) => shortCluster(opt, 'CSu');
/** Whether env option `opt` takes the next word as its value. */
export function envTakesNext(opt: string): boolean {
  const short = envShort(opt);
  return WRAPPER_VALUE_OPTIONS.env!.test(opt) || (short?.letter !== undefined && short.attached === '');
}

/**
 * argv without wrappers; VAR=value given to `env` is recorded in `assignments` (it sets the command's environment),
 * and `env`'s options, with their values, in `envOptions`.
 */
function stripWrappers(argv: string[], assignments: Record<string, string> = {}, envOptions: string[] = []): string[] {
  let a = argv;
  for (let guard = 0; guard < 10 && a.length; guard++) {
    const base = basename(a[0]!);
    if (WRAPPERS.has(base)) {
      a = a.slice(1);
      // Wrapper options (with their values) and env assignments
      while (a.length && (a[0]!.startsWith('-') || (base === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0]!)))) {
        const opt = a[0]!;
        a = a.slice(1);
        if (base === 'env' && !opt.startsWith('-')) {
          assignments[opt.slice(0, opt.indexOf('='))] = opt.slice(opt.indexOf('=') + 1);
          continue;
        }
        const takesValue = (base === 'env' ? envTakesNext(opt) : WRAPPER_VALUE_OPTIONS[base]?.test(opt)) && a.length > 0;
        const value = takesValue ? a[0]! : undefined;
        if (takesValue) a = a.slice(1);
        if (base !== 'env') continue;
        envOptions.push(opt, ...(value === undefined ? [] : [value]));
        const short = envShort(opt);
        if (short?.letter === 'S' || /^--split-string(=|$)/.test(opt)) {
          const line = value ?? (short ? short.attached : opt.includes('=') ? opt.slice(opt.indexOf('=') + 1) : '');
          a = [...line.split(/\s+/).filter(Boolean), ...a];
        }
      }
      continue;
    }
    if (base === 'timeout') {
      a = a.slice(1);
      while (a.length && a[0]!.startsWith('-')) a = a.slice(/^(-[sk]|--signal|--kill-after)$/.test(a[0]!) ? 2 : 1);
      a = a.slice(1); // duration
      continue;
    }
    if (base === 'xargs') {
      a = a.slice(1);
      while (a.length && a[0]!.startsWith('-')) {
        const opt = a[0]!;
        a = a.slice(1);
        if (/^(-[InPLsdEa]|--(max-args|max-procs|max-chars|delimiter|arg-file|process-slot-var))$/.test(opt)) a = a.slice(1);
      }
      continue;
    }
    if ((base === 'npx' || base === 'pnpx' || base === 'bunx') && a.length > 1) {
      a = a.slice(1);
      while (a.length && a[0]!.startsWith('-')) a = a.slice(1);
      continue;
    }
    break;
  }
  return a;
}

/** A command's words with its wrappers removed, as splitCommands reads them (for a program another one runs). */
export function unwrap(argv: string[]): Pick<SimpleCommand, 'argv' | 'assignments' | 'envOptions'> {
  const assignments: Record<string, string> = {};
  const envOptions: string[] = [];
  return { argv: stripWrappers(argv, assignments, envOptions), assignments, envOptions };
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

/** Options by their letters (`-x`, clustered) and long names (`--name`). */
export interface Options {
  short: string;
  long: string[];
}
/**
 * A runner's command line: `[options] [operands] command ...`. `value`: the options that take the next word as
 * their value (test/runner-option-tables.test.ts checks them against each installed program). `operands`: words before the command (flock's lock file, taskset's mask, chrt's priority). `none`:
 * options with which the runner runs no command of these words (flock -c runs a command string, taskset -p).
 * `needs`: an option without which it runs none (runuser -u). `script`: options whose value is a command string the
 * runner gives a shell (flock -c, runuser -c).
 */
export interface Runner {
  value: Options;
  operands?: number;
  none?: Options;
  needs?: Options;
  script?: Options;
}
const opts = (short: string, ...long: string[]): Options => ({ short, long });
/**
 * Programs that run a command from their words, after options and operands of their own (setsid git push).
 * INVARIANT: `value` lists exactly the options whose value may be the next word (getopt's `x:`, a long option's
 * required argument), as each program's own option table has them; an optional value (`x::`) is attached only.
 */
export const RUNNERS: Readonly<Record<string, Runner>> = {
  setsid: { value: opts('') },
  stdbuf: { value: opts('ioe', 'input', 'output', 'error') },
  strace: { value: opts('abeEIoOpPsSuUX', 'output', 'trace', 'signal', 'signals', 'status', 'env', 'user', 'attach', 'trace-path', 'string-limit', 'summary-sort-by', 'columns', 'abbrev', 'verbose', 'raw', 'read', 'write', 'fault', 'inject', 'kvm', 'decode-pids', 'argv0', 'trace-fds', 'detach-on', 'interruptible', 'const-print-style', 'summary-columns', 'summary-syscall-overhead', 'syscall-limit', 'stack-trace-frame-limit') },
  ltrace: { value: opts('aADeFlnopsuwxX', 'output', 'library', 'align', 'indent', 'debug', 'where') },
  chronic: { value: opts('') },
  unbuffer: { value: opts('') },
  flock: { value: opts('wE', 'wait', 'timeout', 'conflict-exit-code'), operands: 1, none: opts('c', 'command'), script: opts('c', 'command') },
  taskset: { value: opts(''), operands: 1, none: opts('p', 'pid') },
  chrt: { value: opts('TPD', 'sched-runtime', 'sched-period', 'sched-deadline'), operands: 1, none: opts('pm', 'pid', 'max') },
  nsenter: { value: opts('tSG', 'target', 'setuid', 'setgid') },
  unshare: { value: opts('SGRw', 'setuid', 'setgid', 'root', 'wd', 'map-user', 'map-group', 'map-users', 'map-groups', 'propagation', 'setgroups', 'monotonic', 'boottime') },
  caffeinate: { value: opts('tw') },
  fakeroot: { value: opts('lfisb', 'lib', 'faked', 'fd-base') },
  firejail: { value: opts('') },
  'systemd-run': { value: opts('HMEpu', 'unit', 'property', 'setenv', 'description', 'slice', 'uid', 'gid', 'working-directory', 'machine', 'host', 'nice', 'service-type', 'expand-environment', 'path-property', 'socket-property', 'on-active', 'on-boot', 'on-startup', 'on-unit-active', 'on-unit-inactive', 'on-calendar', 'timer-property') },
  runuser: { value: opts('ugGcsw', 'user', 'group', 'supp-group', 'command', 'shell', 'session-command', 'whitelist-environment'), none: opts('cl', 'command', 'session-command', 'login'), needs: opts('u', 'user'), script: opts('c', 'command', 'session-command') },
  'ssh-agent': { value: opts('atEPO') },
  'dbus-run-session': { value: opts('', 'config-file', 'dbus-daemon') },
};

/** Whether option word `t` names one of `which`; in a cluster, only before the first letter that takes a value. */
function names(t: string, which: Options, value: Options): boolean {
  if (t.startsWith('--')) return which.long.includes(t.slice(2).split('=')[0]!);
  for (const ch of t.slice(1)) {
    if (which.short.includes(ch)) return true;
    if (value.short.includes(ch)) return false;
  }
  return false;
}

/** Whether option word `t` takes the next word as its value (a cluster: only when its last letter does). */
function takesValue(t: string, value: Options): boolean {
  if (t.startsWith('--')) return !t.includes('=') && value.long.includes(t.slice(2));
  for (let j = 1; j < t.length; j++) if (value.short.includes(t[j]!)) return j === t.length - 1;
  return false;
}

/** Where a runner's command starts in its words, or -1 when it runs none of them. */
function runnerCommand(r: Runner, a: string[]): number {
  let i = 1;
  let needed = !r.needs;
  for (; i < a.length; i++) {
    const t = a[i]!;
    if (t === '--') {
      i++;
      break;
    }
    if (!t.startsWith('-') || t === '-') break;
    if (r.none && names(t, r.none, r.value)) return -1;
    if (r.needs && names(t, r.needs, r.value)) needed = true;
    if (takesValue(t, r.value)) i++;
  }
  if (!needed) return -1;
  i += r.operands ?? 0;
  if (a[i] === '--') i++;
  if (r.none && a[i]?.startsWith('-') && names(a[i]!, r.none, r.value)) return -1;
  return i < a.length ? i : -1;
}

/**
 * The command strings a runner's own options give a shell (flock F -c 'S', runuser -c 'S'), read from every word
 * before the command it runs. WHY: over-reading a word as a string can only add commands to judge.
 */
function runnerScripts(r: Runner, a: string[]): string[] {
  if (!r.script) return [];
  const k = runnerCommand(r, a);
  const out: string[] = [];
  const letters = r.value.short + r.script.short;
  for (let i = 1; i < (k > 0 ? k : a.length); i++) {
    const t = a[i]!;
    if (t.startsWith('--')) {
      const [name, ...v] = t.slice(2).split('=');
      if (!r.script.long.includes(name!)) continue;
      const value = v.length ? v.join('=') : a[i + 1];
      if (value !== undefined) out.push(value);
      continue;
    }
    const short = shortCluster(t, letters);
    if (!short?.letter || !r.script.short.includes(short.letter)) continue;
    const value = short.attached || a[i + 1];
    if (value !== undefined) out.push(value);
  }
  return out;
}

const FIND_EXEC = /^-(exec|execdir|ok|okdir)$/;

type Program = Pick<SimpleCommand, 'argv' | 'envOptions'>;

/**
 * Every program a command runs, in command position: itself (its wrappers removed by the shell matcher), each
 * find -exec/-execdir/-ok command, and a known runner's command (the first word after its options and operands).
 * A word that is only an argument (rm -rf vendor/git, grep env -i, setsid make -C vendor/git) runs nothing, and an
 * unknown program's words are not read.
 */
export function programsIn(c: Program, depth = 0): Program[] {
  const out = [c];
  const a = c.argv;
  if (depth > 4 || !a.length) return out;
  const base = basename(a[0]!);
  const runs: string[][] = [];
  if (base === 'find') {
    for (let i = 1; i < a.length; i++) {
      if (!FIND_EXEC.test(a[i]!)) continue;
      const end = a.findIndex((t, j) => j > i && (t === ';' || t === '+'));
      runs.push(a.slice(i + 1, end < 0 ? a.length : end));
    }
  } else if (Object.hasOwn(RUNNERS, base)) {
    const k = runnerCommand(RUNNERS[base]!, a);
    if (k > 0) runs.push(a.slice(k));
  }
  for (const r of runs) if (r.length) out.push(...programsIn(unwrap(r), depth + 1));
  return out;
}

/**
 * Every command string a command runs as a command line: a shell's -c script, for the command itself and for each
 * program it runs (programsIn: behind a runner, as a find -exec command), and a runner's own command string.
 * INVARIANT (#983): each is read as a command line and judged like the line around it.
 */
function commandStrings(c: Program): string[] {
  const out: string[] = [];
  for (const p of programsIn(c)) {
    const base = basename(p.argv[0] ?? '');
    if (SHELLS.has(base)) {
      const ci = p.argv.findIndex((x, idx) => idx > 0 && /^-[a-z]*c[a-z]*$/.test(x));
      const script = ci > 0 ? p.argv[ci + 1] : undefined;
      if (script !== undefined) out.push(script);
    } else if (Object.hasOwn(RUNNERS, base)) out.push(...runnerScripts(RUNNERS[base]!, p.argv));
  }
  return out;
}

/** Every simple command in a shell command line, recursively. */
export function splitCommands(src: string, depth = 0): SimpleCommand[] {
  if (depth > MAX_DEPTH) return [];
  const nested: string[] = [];
  const tokens = tokenize(src, nested);
  const result: SimpleCommand[] = [];
  let words: string[] = [];
  let writes: string[] = [];
  let reads: string[] = [];
  let pendingRedirect: string | null = null;

  const flush = () => {
    const assignments: Record<string, string> = {};
    let k = 0;
    while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]!)) {
      const w = words[k]!;
      const eq = w.indexOf('=');
      assignments[w.slice(0, eq)] = w.slice(eq + 1);
      k++;
    }
    const envOptions: string[] = [];
    const argv = stripWrappers(words.slice(k), assignments, envOptions);
    if (argv.length || Object.keys(assignments).length || writes.length || reads.length || envOptions.length) {
      const base = argv.length ? basename(argv[0]!) : '';
      if (base === 'tee') for (const f of argv.slice(1)) if (!f.startsWith('-')) writes.push(f);
      writes.push(...argumentWrites(base, argv));
      result.push({ argv, assignments, envOptions, writes, reads });
      // Re-parse the script given to a shell (itself, behind a runner or find -exec), a runner, or eval.
      for (const script of commandStrings({ argv, envOptions })) result.push(...splitCommands(script, depth + 1));
      if (base === 'eval' && argv.length > 1) {
        result.push(...splitCommands(argv.slice(1).join(' '), depth + 1));
      }
    }
    words = [];
    writes = [];
    reads = [];
  };

  for (const t of tokens) {
    if (pendingRedirect !== null) {
      if (!t.op && WRITE_REDIRECTS.has(pendingRedirect) && !t.text.startsWith('/dev/')) writes.push(t.text);
      if (!t.op && pendingRedirect === '<') reads.push(t.text);
      pendingRedirect = null;
      if (!t.op) continue;
    }
    if (t.op && SEPARATORS.has(t.text)) {
      flush();
      continue;
    }
    if (t.op) {
      pendingRedirect = t.text;
      continue;
    }
    words.push(t.text);
  }
  flush();
  for (const body of nested) result.push(...splitCommands(body, depth + 1));
  return result;
}
