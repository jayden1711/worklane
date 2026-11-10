// lint-test
// #1262 (the owner's decision, 2026-11-10): the one-launch rule (#958, test/claude-launch-lint.test.ts) reaches the
// repo's scripts. Every `claude` a shell script, a workflow's `run:` step or a script the repo runs starts must end
// with the launch's guards (`--settings <json>`, `--setting-sources ''`, `--strict-mcp-config`: Claude Code takes the
// last of each), or be a pinned exception (file and argv: `--version`, `auth status`, `auth login`), which start no
// session. Else a setup or CI script reopens #958's route: a planted hook or CLAUDE.md, loaded as root or the agent.
//
// What it reads, as text (a lint can't run a shell): each line of a shell file (`*.sh`, `*.bash`, a `#!/…sh` script)
// and each line of a workflow file, comments and their tails dropped, continued lines joined. A command is found at
// the start of a line or after `;`, `&&`, `||`, `|`, `(`, `{`, `$(`, a backtick, `then`, `do`, `else`, `!`, past any
// `VAR=value` and the wrappers `command`, `exec`, `env` (its options and assignments), `sudo` (its options),
// `timeout <n>`, `nice`, `nohup`, `time`. It is claude when it is `claude`, ends in `/claude`, or is a variable this
// file sets to one of those (`C=claude`, `C=$(command -v claude)`). Its arguments are the rest of the command,
// with an array it expands ("${ARGS[@]}") read from that array's assignment in this file. A `sh -c`/`bash -c`
// string, a heredoc fed to a shell, and `$(...)` are read as lines of their own.
//
// What it can't see (named limits): a command built at run time (`eval`, a name from parts, `"$@"` handed claude by
// a caller), a function or alias that wraps claude, a variable set in another file or the environment, a script
// fetched at run time, and languages other than shell and JavaScript.
//
// JavaScript the repo runs (scripts/**/*.{mjs,cjs,js}) is read as text too (jsLaunchProblems): the claude binary as
// a literal (`'claude'`, `'/…/claude'`) followed by a literal argv (`[...]`) must carry the guards, or start with an
// exempt argv. A binary held in a variable, or an argv built another way, isn't seen here: src/'s launches are held by
// an AST lint to the one launch function (#958), and that is the place for any new one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { repoRoot } from './helpers.js';

const WRAPPERS = new Set(['command', 'exec', 'nohup', 'time', 'nice']);
// check-table: never-shrink
const KEYWORDS = new Set([
  'then',
  'do',
  'else',
  'if',
  'elif',
  'while',
  'until',
  '!',
  '{',
  '(',
]);

/**
 * A line split into its commands: at `;`, `&&`, `||`, `|`, `(`, `{` outside quotes, and at `$(` or a backtick outside
 * single quotes (a substitution runs inside double quotes too). Quoted text stays in its command, as a word.
 */
function commands(t: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (let k = 0; k < t.length; k++) {
    const c = t[k]!;
    const two = t.slice(k, k + 2);
    if (q === "'") {
      cur += c;
      if (c === "'") q = null;
      continue;
    }
    if (two === '$(' || c === '`') {
      out.push(cur);
      cur = '';
      if (two === '$(') k++;
      // A substitution is a context of its own: its quotes don't close the ones around it.
      q = null;
      continue;
    }
    if (q === '"') {
      cur += c;
      if (c === '"' && t[k - 1] !== '\\') q = null;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
    } else if (two === '&&' || two === '||') {
      out.push(cur);
      cur = '';
      k++;
    } else if (c === ';' || c === '|' || c === '(' || c === ')') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
/** Pinned exceptions: file, then the argv (its first words) a call passes. None starts a session. */
// check-table: never-grow
export const SHELL_EXCEPTIONS: [string, string][] = [
  // A CI probe of Claude Code's own MCP policy (managed allowedMcpServers): the real CLI in a throwaway HOME with a
  // stand-in key, its project source on purpose (the policy is what it reads); no session gets past its init event.
  ['.github/workflows/ci-slow.yml', '-p --output-format stream-json --verbose --max-turns 1 --setting-sources project --strict-mcp-config'],
];
const EXEMPT_ARGV = /^(?:--version|auth status|auth login)(?:\s|$)/;

/** Joins continued lines, drops comments (a `#` at a word's start outside quotes) and blank lines. */
function logicalLines(text: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const raw = text.split('\n');
  for (let i = 0; i < raw.length; i++) {
    const start = i;
    let l = raw[i]!;
    while (/\\\s*$/.test(l) && i + 1 < raw.length) l = l.replace(/\\\s*$/, ' ') + raw[++i];
    let q: string | null = null;
    let cut = l.length;
    for (let k = 0; k < l.length; k++) {
      const c = l[k]!;
      if (q) {
        if (c === q && l[k - 1] !== '\\') q = null;
      } else if (c === "'" || c === '"') q = c;
      else if (c === '#' && (k === 0 || /\s/.test(l[k - 1]!))) {
        cut = k;
        break;
      }
    }
    const t = l.slice(0, cut).trim();
    if (t) out.push({ line: start + 1, text: t });
  }
  return out;
}

const unquote = (w: string) => w.replace(/^["']|["']$/g, '');

/** Each claude this file's text starts without the guards, as `<path>:<line>: <why>`. */
export function shellLaunchProblems(path: string, text: string): string[] {
  const lines = logicalLines(text);
  // Variables set to claude, and arrays' assigned text.
  const vars = new Set<string>();
  const arrays = new Map<string, string>();
  for (const { text: t } of lines) {
    const v = /^(?:export\s+|local\s+|readonly\s+)?([A-Za-z_]\w*)=(.*)$/.exec(t);
    if (!v) continue;
    const val = v[2]!.trim();
    if (/^\(/.test(val)) arrays.set(v[1]!, val);
    else if (/^["']?(?:[^"'\s]*\/)?claude["']?$/.test(val) || /^["']?\$\((?:command -v|which|type -P) claude\)["']?$/.test(val)) vars.add(v[1]!);
  }
  const isClaude = (w: string) => {
    const u = unquote(w);
    if (/^(?:[^\s]*\/)?claude$/.test(u)) return true;
    const m = /^\$\{?([A-Za-z_]\w*)\}?$/.exec(u);
    return !!m && vars.has(m[1]!);
  };
  const out: string[] = [];
  const judge = (path0: string, line: number, cmd: string) => {
    // Words, quotes kept together (enough to find the command and read its arguments).
    // A word is unquoted text and quoted runs together; `${x:+...}` and `${x:-...}` stay one word.
    const words = cmd.match(/(?:\$\{[^}]*\}|'[^']*'|"(?:[^"\\]|\\.)*"|[^\s'"$]|\$(?!\{))+/g) ?? [];
    let k = 0;
    const skipOpts = () => {
      while (k < words.length && words[k]!.startsWith('-')) {
        const o = words[k++]!;
        if (/^-[ugCDhpTr]$|^--(?:user|group|chdir|prompt)$/.test(o)) k++;
      }
    };
    for (;;) {
      const w = words[k];
      if (w === undefined) return;
      if (/^[A-Za-z_]\w*=/.test(w) || KEYWORDS.has(w) || /^\$\{\w+:[+-]/.test(w)) k++;
      else if (WRAPPERS.has(w)) {
        k++;
        if (w === 'nice') {
          if (words[k] === '-n') k += 2;
          skipOpts();
        }
      } else if (w === 'env') {
        k++;
        skipOpts();
      } else if (w === 'sudo') {
        k++;
        skipOpts();
        if (words[k] === '--') k++;
      } else if (w === 'timeout') {
        k++;
        skipOpts();
        k++;
      } else break;
    }
    const c = words[k];
    if (!c || !isClaude(c)) {
      // `sh -c '<script>'`, `bash -c "<script>"`: the script is read as lines of its own.
      if (c && /^(?:\S*\/)?(?:ba)?sh$/.test(unquote(c)) && words[k + 1] === '-c' && words[k + 2]) for (const l of logicalLines(unquote(words[k + 2]!))) scan(path0, line, l.text);
      return;
    }
    let args = words.slice(k + 1).join(' ');
    for (const [name, val] of arrays) args = args.replace(new RegExp(`"?\\$\\{${name}\\[@\\]\\}"?`, 'g'), val.replace(/^\(|\)$/g, ''));
    if (EXEMPT_ARGV.test(args.replace(/["']/g, '')) || SHELL_EXCEPTIONS.some(([f, a]) => f === path0 && args.startsWith(a))) return;
    const guarded = /--setting-sources(?:=|\s+)(?:''|"")/.test(args) && /--strict-mcp-config\b/.test(args) && /--settings\b/.test(args);
    if (!guarded) out.push(`${path0}:${line}: starts claude (\`${cmd.slice(0, 120)}\`) without the launch's guards (--settings, --setting-sources '', --strict-mcp-config): add them, last`);
  };
  function scan(path0: string, line: number, t: string) {
    // A `case` label (`claude)`, `a|b)`) names no command.
    const body = t.replace(/^[^()\s]+\)(?=\s|$)/, '');
    for (const part of commands(body)) judge(path0, line, part);
  }
  for (const { line, text: t } of lines) scan(path, line, t);
  return out;
}

/** Each literal claude call in a JavaScript file's text without the guards, as `<path>:<line>: <why>`. */
export function jsLaunchProblems(path: string, text: string): string[] {
  const out: string[] = [];
  const re = /(['"`])((?:[^'"`\s]*\/)?claude)\1\s*,\s*\[([^\]]*)\]/g;
  for (const m of text.matchAll(re)) {
    const argv = [...m[3]!.matchAll(/(['"`])((?:(?!\1).)*)\1/g)].map((x) => x[2]!);
    const joined = argv.join(' ');
    if (EXEMPT_ARGV.test(joined) || SHELL_EXCEPTIONS.some(([f, a]) => f === path && joined.startsWith(a))) continue;
    const i = argv.indexOf('--setting-sources');
    if (i >= 0 && argv[i + 1] === '' && argv.includes('--strict-mcp-config') && argv.includes('--settings')) continue;
    out.push(`${path}:${text.slice(0, m.index).split('\n').length}: starts claude (${m[0].slice(0, 120)}) without the launch's guards: use the engine's launch, or add them, last`);
  }
  return out;
}

const jsFiles = (): string[] =>
  readdirSync(join(repoRoot, 'scripts'), { recursive: true })
    .map((x) => `scripts/${String(x).split(sep).join('/')}`)
    .filter((f) => /\.(?:mjs|cjs|js)$/.test(f));

const files = (): string[] => {
  const all = readdirSync(repoRoot, { recursive: true }).map((x) => String(x).split(sep).join('/'));
  return all.filter((f) => {
    if (/(^|\/)(node_modules|dist|\.git|test\/fixtures)(\/|$)|^\.claude\//.test(f)) return false;
    if (/\.(?:sh|bash)$/.test(f) || /^\.github\/workflows\/.*\.ya?ml$/.test(f)) return true;
    if (!f.startsWith('scripts/') || /\.\w+$/.test(f)) return false;
    try {
      return /^#!.*\b(?:ba)?sh\b/.test(readFileSync(join(repoRoot, f), 'utf8').slice(0, 100));
    } catch {
      return false;
    }
  });
};

test("#1262: every claude a script starts ends with the launch's guards, or is a pinned exception", () => {
  const problems = files().flatMap((f) => shellLaunchProblems(f, readFileSync(join(repoRoot, f), 'utf8')));
  assert.deepEqual(problems, []);
  assert.deepEqual(jsFiles().flatMap((f) => jsLaunchProblems(f, readFileSync(join(repoRoot, f), 'utf8'))), [], 'the scripts in JavaScript too');
});

test('#1262: every way a script can start claude without the guards is refused (fixtures), and the controls pass', () => {
  const dir = join(repoRoot, 'test', 'fixtures', 'claude-launch-shell');
  const names = readdirSync(dir).filter((f) => f.endsWith('.sh.txt')).map((f) => f.replace(/\.sh\.txt$/, '')).sort();
  // Every fixture by name: one deleted fails here.
  // check-table: never-shrink
  const MUST_FAIL = ['after-and', 'array-unguarded', 'backticks', 'command-builtin', 'command-v-variable', 'continued-line', 'direct', 'dollar-paren', 'env-wrapper', 'exec', 'heredoc', 'in-a-case-arm', 'one-guard-only', 'optional-env', 'path', 'sh-c', 'sudo-wrapper', 'timeout-wrapper', 'variable'];
  // check-table: never-shrink
  const CONTROLS = ['ok-auth-status', 'ok-case-label', 'ok-comment', 'ok-continued-guards', 'ok-grep-regex', 'ok-guarded', 'ok-guarded-array', 'ok-other-tool', 'ok-prose', 'ok-version'];
  assert.deepEqual(names, [...MUST_FAIL, ...CONTROLS].sort(), 'every fixture, by name');
  // JavaScript: a literal call without the guards is refused; with them, or an exempt argv, it passes.
  const g = "'--settings', '{}', '--setting-sources', '', '--strict-mcp-config'";
  assert.equal(jsLaunchProblems('scripts/x.mjs', "spawn('claude', ['-p', 'hi']);").length, 1, 'a literal call');
  assert.equal(jsLaunchProblems('scripts/x.mjs', "spawnSync('/usr/local/bin/claude', ['-p', 'hi'], {});").length, 1, 'by its path');
  assert.equal(jsLaunchProblems('scripts/x.mjs', "asUser(user, 'claude', ['-p', 'hi'], env);").length, 1, 'through a wrapper');
  assert.deepEqual(jsLaunchProblems('scripts/x.mjs', `spawn('claude', ['-p', 'hi', ${g}]);`), [], 'guarded');
  assert.deepEqual(jsLaunchProblems('scripts/x.mjs', "asUser(user, 'claude', ['auth', 'status', '--json'], env);"), [], 'auth status');
  for (const n of names) {
    const problems = shellLaunchProblems(`scripts/${n}.sh`, readFileSync(join(dir, `${n}.sh.txt`), 'utf8'));
    if (n.startsWith('ok-')) assert.deepEqual(problems, [], `${n}: a control passes`);
    else assert.ok(problems.length > 0, `${n}: refused`);
  }
});
