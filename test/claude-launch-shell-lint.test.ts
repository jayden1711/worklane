// lint-test
// #1262 (the owner's decision, 2026-11-10): the one-launch rule (#958; src/'s is held by its own AST lint) reaches
// the repo's scripts. A script starts a claude session only through scripts/setup/lib.sh's claude_guarded (R1264g-j),
// which runs scripts/lib/claude-guarded.sh in a clean bash with a fixed PATH (no caller's shell function, environment
// or PATH entry reaches it), found by the absolute path lib.sh had when sourced and only while it is lib.sh's owner's
// alone (R1264k/l), and so claude in
// an empty environment (no CLAUDE_CODE_PLUGIN_DIRS, NODE_OPTIONS or BUN_*); its words start with -p (no subcommand),
// every flag is allowlisted (no --plugin-dir, --agents, --add-dir, --mcp-config, no abbreviation of one, no prompt read
// as a flag), a value-taking flag has its value, --input-format is text only (stream-json's control requests load
// settings past the guards); it takes settings only as `{}` or a plain-path apiKeyHelper, and puts the launch's guards
// last (`--settings <json> --setting-sources '' --strict-mcp-config`). Any other claude call is refused, unless it starts no session
// (`--version`, `auth status`, `auth login`) or is a pinned exception: its file, its exact line, why, and the digest of
// its scope (pinScope: its function, or its whole script or workflow step, and every assignment of a variable it
// reads), so no edit around it moves or widens it unseen. Else a setup, CI or spike script reopens #958's route: a
// planted hook or CLAUDE.md, loaded as root or the agent. Each round before this read the call's literal argv, and
// each review found a spelling it didn't (R1264g/h): the rule is now where a script starts claude, not how.
//
// It fails closed (R1264a/b): it doesn't list the launchers claude can sit behind. In each command (a line split at
// `;`, `&&`, `||`, `|`, `(`, `)`, `{`, `}`, `$(`, a backtick, quote-aware), ANY unquoted word that is `claude`,
// `…/claude`, `@anthropic-ai/claude-code[@…]`, `…/claude-code/cli.js` or `…/claude/versions/<v>`, a lookup of it
// (`"$(command -v claude)"`, `` `which claude` ``), or a variable this file sets to one (`C=claude`,
// `C="${X:-claude}"`, `C=$(command -v claude)`), in any position (after `sudo`, `/usr/bin/env -i`, `timeout -k`,
// `xargs`, `find -exec`, `npx`, `node`, a helper of the repo's own), is a claude call, and so is a quoted literal one as
// a command's first word. Only a command whose first word is a known non-launcher (`command -v`, `which`, `install`,
// `ln`, `echo`, a `for` list, …) names claude without starting it. A string after `-c` (`bash -c`, `bash -lc`,
// `su -c`, attached `-c"…"`), `-c --`, `eval`, `--command`/`--command=` (su, runuser) or `env -S`/`--split-string`, and
// every quoted word of a command `tmux`, `ssh` or `watch` runs, is read as commands of its own, recursively. A default
// with or without its colon (`${X:-claude}`, `${X-claude}`), `printf -v NAME … claude`, and a glob aimed at the binary
// (`…/claud[e]`) name it too. A function or alias named for a command a launch runs through (sudo, env, timeout,
// command, builtin, cd, …), or by any path (`/usr/bin/env() {…}`, which bash runs for that exact path), a DEBUG or RETURN
// trap, extdebug and functrace, `enable -n`, a script that names the tests' .claude-guarded-test-path marker, and a
// script that sets a CLAUDE_GUARDED_* variable, are refused (R1264l D3, m D2, o D2/D3). Quoting is read as bash reads it
// (R1264j D2): nothing escaped in `'…'`, a backslash takes the next character in `$'…'`, `"…"` and outside quotes. A script that defines its own claude_guarded is
// refused.
//
// What it reads: every tracked file whose shebang names a shell, `*.sh`, `*.bash`, `*.zsh`, `*.ksh`, `*.fish`,
// `.githooks/*`; every workflow's and composite action's `run:` steps (parsed as YAML) and any `uses:` of a claude
// action; Makefile recipes; package.json scripts; Dockerfile RUN lines; and, as text, JavaScript and TypeScript under
// scripts/ (jsLaunchProblems).
//
// What it can't see (named limits): an alias or function defined elsewhere that hides the word claude (except one
// named claude_guarded), a variable set
// in another file or the environment (`$CLAUDE_BIN` from the caller), a command built at run time (a name from parts,
// `eval "$x"` of a variable, `"$@"` handed claude by a caller), a script fetched at run time, and languages other than
// shell and JavaScript; a non-launcher word as an option's value (`sudo -u test claude …`, `docker run --name test
// img claude …`) still makes the call data (R1264f D5 f05); a command string handed to a shell on stdin
// (`echo 'claude -p hi' | bash`, `bash <<<'claude -p hi'`, R1264f D5 f06); in JavaScript, a string that starts
// with the binary and then a plain word (`run('claude doctor')` through a promisified exec), outside exec and '-c';
// for a pin outside a workflow step, the positional parameters its call reads (`$1`, `$@`); and a glob that also
// matches another name (`*e`, `c*`). src/'s own launches are held by the AST
// lint, test/claude-launch-lint.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parse } from 'yaml';
import { repoRoot } from './helpers.js';

/** The claude binary as a word: its name, a path to it, its package (with a version), or its cli.js. */
// R1264f D5 (f04): the native installer's binary under a version, wherever it is (`…/claude/versions/2.1.282`).
const BINARY = /^(?:\S*\/)?claude$|^@anthropic-ai\/claude-code(?:@\S*)?$|\/claude-code\/cli\.js$|\/claude\/versions\/|\/\.claude\/local\//;
/**
 * Fail closed (R1264d D3/D4): a word that ends in the binary however it is spelled, quoted or not, in any position: a
 * path to it, a default (`${X:-claude}`), `.exe`/`.cmd`; or that names its package or cli.js. One token only (no
 * whitespace once unquoted): a quoted string with spaces is a command (read where `-c` or eval runs it) or prose.
 */
const CLAUDE_WORD = /^\S+$/;
const ENDS_CLAUDE = /(?:^|[^A-Za-z0-9._-]|\$\{\w+:?[-=](?:[^}\s]*\/)?)claude(?:\.exe|\.cmd)?[}"')\]]*$|@anthropic-ai\/claude-code|claude-code\/cli\.js/;
const isClaudeToken = (u: string) => CLAUDE_WORD.test(u) && ENDS_CLAUDE.test(u);
/** A variable's value that is the binary (R1264d D4): its first token is, or a default or lookup of it is anywhere. */
const VALUE_CLAUDE = (v: string) => isClaudeToken(v.split(/\s+/)[0] ?? '') || /\$\{\w+:?[-=](?:[^}\s]*\/)?claude\}|\$\((?:command -v|which|type -P) claude\)/.test(v);
/** Commands that name claude without starting it: their words are data. */
// check-table: never-grow
const NON_LAUNCHERS = new Set([
  'command',
  'which',
  'type',
  'hash',
  'install',
  'ln',
  'cp',
  'mv',
  'rm',
  'test',
  '[',
  '[[',
  'chmod',
  'chown',
  'readlink',
  'realpath',
  'ls',
  'stat',
  'file',
  'sha256sum',
  'echo',
  'printf',
  'for',
  'case',
  'grep',
  'local',
  'export',
  'declare',
  'readonly',
]);
/** An argv that starts no session: a call whose argument words begin so is exempt anywhere. */
const EXEMPT_ARGV = /^(?:--version|auth status|auth login)(?:\s|$)/;
/**
 * Pinned exceptions, as the spike's pins are (R1264c D4): file, the exact text (trimmed) of the physical line that holds
 * the call, why, and the sha256 of its scope (pinScope: the function around the call, or the whole script when the call
 * is top-level; R1264e D1, R1264f D4). Each covers exactly one call.
 */
type Pin = [file: string, line: string, why: string, scope: string];
// check-table: never-grow
export const SHELL_EXCEPTIONS: Pin[] = [
  [
    '.github/workflows/ci-slow.yml',
    "init() { echo hi | sudo -u wl-ci-agent env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=\"$h\" CLAUDE_CONFIG_DIR=\"$h/.claude\" ANTHROPIC_API_KEY=sk-ant-not-a-key sh -c 'cd \"$HOME\" && { \"$0\"/bin/claude -p --output-format stream-json --verbose --max-turns 1 --setting-sources project --strict-mcp-config --mcp-config \"$HOME/mcp.json\" --settings \"$1\" || true; }' \"$cc\" \"$1\" 2>/dev/null | jq -c 'select(.type == \"system\" and .subtype == \"init\") | .mcp_servers'; }",
    "a CI probe of Claude Code's own MCP policy (managed allowedMcpServers): the real CLI in a throwaway HOME with a stand-in key, its project source on purpose; no session gets past its init event",
    '7f73f39275d975b81aea6e1a339256bd6aba2f3f15102f233152912391c797e7',
  ],
  [
    '.github/workflows/ci-slow.yml',
    "if printf '%s\\n' \"$bad\" | sudo bash scripts/setup/credentials.sh probe claude > \"$RUNNER_TEMP/bad.out\" 2>&1; then echo \"a bad token was accepted\"; exit 1; fi",
    "credentials.sh's `probe claude` names the login to check: the script, not claude, runs (a bad token)",
    '1c80be8764dd95ae19a1d3d918ebe6bf367abed22b2cf74f3506babf9ea417c8',
  ],
  [
    '.github/workflows/ci-slow.yml',
    "printf '%s\\n' \"$t\" | sudo bash scripts/setup/credentials.sh probe claude > \"$RUNNER_TEMP/good.out\" 2>&1",
    "credentials.sh's `probe claude` names the login to check: the script, not claude, runs (a good token)",
    '1c80be8764dd95ae19a1d3d918ebe6bf367abed22b2cf74f3506babf9ea417c8',
  ],
  [
    'scripts/lib/claude-guarded.sh',
    'command ${cg_sudo[@]+"${cg_sudo[@]}"} ${cg_timeout[@]+"${cg_timeout[@]}"} /usr/bin/env -i "HOME=$cg_home" PATH=/usr/local/bin:/usr/bin:/bin CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 ${cg_env[@]+"${cg_env[@]}"} "$cg_bin" "$@" --settings "$cg_settings" --setting-sources \'\' --strict-mcp-config',
    "claude_guarded, the one launch a script may use (R1264g-j): run by lib.sh's claude_guarded in a clean bash; an empty environment but for HOME, USER, a fixed PATH and allowlisted names; -p first, only allowlisted flags, each value-taking one with its value, --permission-mode dontAsk and --input-format text only; settings only {} or a plain-path apiKeyHelper; the guards last. Held with its whole file by digest",
    'dfa1f7fa7fd433d396e91308171947668ddd6451d2b38be0c09bae6796d946f1',
  ],
];

/**
 * Unguarded calls pinned by file and the exact text of the physical line that holds them (trimmed), with why:
 * scripts/ci/claude-launch-shell-pins.json (data, so no test names a spike: #673). A pin covers one line: a copy of it
 * elsewhere in the file, or in any other file, is refused.
 */
export const SHELL_PINS = (JSON.parse(readFileSync(join(repoRoot, 'scripts', 'ci', 'claude-launch-shell-pins.json'), 'utf8')) as { pins: Pin[] }).pins;

type Word = { text: string; quoted: boolean };
/** The commands a claude launch runs through: a function or alias of one of these names is refused (R1264l D3). */
const SHADOWED = new Set('sudo env timeout command builtin exec claude printenv cd pwd dirname stat bash sh find unset declare source printf read eval readonly echo local test [ enable'.split(' '));

/** Words that open a command without being it. */
// check-table: never-grow
const KEYWORDS = new Set([
  'if',
  'then',
  'elif',
  'else',
  'while',
  'until',
  'do',
  '!',
  'time',
]);

/** A quote the lint is inside: `'…'`, ANSI-C `$'…'` or `"…"`. */
type Quote = null | "'" | "$'" | '"';
/**
 * bash's quoting, one step at a time (R1264j D2): inside `'…'` nothing is escaped (`'\'` is a backslash); inside
 * `$'…'` and `"…"`, and outside quotes, a backslash takes the next character (`$'can\'t'`, `"C:\\"`). The state after
 * the step at t[k], and how many characters it took.
 */
function quoteStep(t: string, k: number, q: Quote): { q: Quote; n: number } {
  const c = t[k]!;
  if (q === "'") return { q: c === "'" ? null : q, n: 1 };
  if (c === '\\') return { q, n: 2 };
  if (q === "$'") return { q: c === "'" ? null : q, n: 1 };
  if (q === '"') return { q: c === '"' ? null : q, n: 1 };
  if (c === '$' && t[k + 1] === "'") return { q: "$'", n: 2 };
  if (c === "'" || c === '"') return { q: c, n: 1 };
  return { q: null, n: 1 };
}

/** Joins continued lines and drops comments (a `#` at a word's start outside quotes) and blank lines. */
function logicalLines(text: string): { line: number; end: number; text: string }[] {
  const out: { line: number; end: number; text: string }[] = [];
  const raw = text.split('\n');
  for (let i = 0; i < raw.length; i++) {
    const start = i;
    let l = raw[i]!;
    while (/\\\s*$/.test(l) && i + 1 < raw.length) l = l.replace(/\\\s*$/, ' ') + raw[++i];
    let q: Quote = null;
    let cut = l.length;
    for (let k = 0; k < l.length; ) {
      if (!q && l[k] === '#' && (k === 0 || /\s/.test(l[k - 1]!))) {
        cut = k;
        break;
      }
      const r = quoteStep(l, k, q);
      q = r.q;
      k += r.n;
    }
    const t = l.slice(0, cut).trim();
    if (t) out.push({ line: start + 1, end: i + 1, text: t });
  }
  return out;
}

/** Whether a shell glob (`*`, `?`, `[…]`) matches `name` whole. */
function globMatches(glob: string, name: string): boolean {
  let re = '';
  for (let k = 0; k < glob.length; k++) {
    const c = glob[k]!;
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = glob.indexOf(']', k + 2);
      if (end < 0) re += '\\[';
      else {
        re += `[${glob.slice(k + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        k = end;
      }
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  try {
    return new RegExp(`^${re}$`).test(name);
  } catch {
    return true;
  }
}


/**
 * A whole shell text with quoted text, comments and heredoc bodies masked by spaces, newlines kept (R1264t D2, u D1,
 * w/x D1). A stack of contexts, as bash reads them: `$(…)` and `` `…` `` inside "…" are unquoted again; `((…))` and
 * `$((…))` are arithmetic (a `<<` there is a shift, a `#` no comment); a `#` at a word's start (after a blank or one of
 * ;&|()) opens a comment; a heredoc starts only at `<<` or `<<-` (never `<<<`, a here-string), its delimiter the next
 * word with quotes and backslashes removed (`<<\EOF`, `<<E"OF"`), and its body is masked to that delimiter; and inside
 * `case … esac` a pattern's `)` closes nothing. `open` names where the text ended if not at top level (a quote, a
 * substitution, an unfinished heredoc), so a reader that lost sync with bash refuses the file rather than masking the
 * rest of it unseen.
 */
function maskFile(text: string): { out: string; open: string | null } {
  type Ctx = { q: Quote | 'sub' | 'bq' | 'arith' | 'brace'; depth: number; cases: number; masked?: boolean };
  const st: Ctx[] = [{ q: null, depth: 0, cases: 0 }];
  const top = () => st[st.length - 1]!;
  const plain = () => top().q === null || top().q === 'sub' || top().q === 'bq';
  const docs: { word: string; strip: boolean }[] = [];
  let unfinished: string | null = null;
  const wordAt = (k: number) => k === 0 || /[\s;&|()]/.test(text[k - 1]!);
  let out = '';
  for (let k = 0; k < text.length; ) {
    const c = text[k]!;
    const t = top();
    if (c === '\n' && docs.length && plain()) {
      out += '\n';
      k++;
      // Heredoc bodies, one after another, masked to each delimiter line.
      while (docs.length) {
        const d = docs.shift()!;
        let found = false;
        while (k < text.length) {
          const e = text.indexOf('\n', k) < 0 ? text.length : text.indexOf('\n', k);
          const l = text.slice(k, e);
          out += ' '.repeat(l.length) + (e < text.length ? '\n' : '');
          k = e + 1;
          if ((d.strip ? l.replace(/^\t+/, '') : l) === d.word) {
            found = true;
            break;
          }
        }
        if (!found) unfinished = `a heredoc to ${d.word}`;
      }
      continue;
    }
    // ${…} (R1264z D2): bash's own quoting inside it, nested even within "…" ("${raw//'"'/}"); its braces nest; masked
    // where it sits inside "…".
    if (t.q === 'brace') {
      const put = (x: string) => (out += t.masked ? x.replace(/[^\n]/g, ' ') : x);
      if (c === '}' && t.depth === 0) { st.pop(); put('}'); k++; continue; }
      if (c === '\\') { put(text.slice(k, k + 2)); k += 2; continue; }
      if (c === '$' && text[k + 1] === '{') { st.push({ q: 'brace', depth: 0, cases: 0, masked: t.masked === true }); put('${'); k += 2; continue; }
      if (c === '$' && text[k + 1] === '(') { st.push({ q: 'sub', depth: 0, cases: 0 }); put('$('); k += 2; continue; }
      if (c === '`') { st.push({ q: 'bq', depth: 0, cases: 0 }); put(c); k++; continue; }
      if (c === '$' && text[k + 1] === "'") { st.push({ q: "$'", depth: 0, cases: 0 }); put("$'"); k += 2; continue; }
      if (c === "'" || c === '"') { st.push({ q: c, depth: 0, cases: 0 }); put(c); k++; continue; }
      if (c === '{') t.depth++;
      else if (c === '}') t.depth--;
      put(c);
      k++;
      continue;
    }
    if (t.q === 'arith') {
      if (c === ')' && text[k + 1] === ')' && t.depth === 0) { st.pop(); out += '))'; k += 2; continue; }
      if (c === '(') t.depth++;
      else if (c === ')') t.depth = Math.max(0, t.depth - 1);
      out += c;
      k++;
      continue;
    }
    if (plain()) {
      if (c === '#' && wordAt(k)) {
        const e = text.indexOf('\n', k) < 0 ? text.length : text.indexOf('\n', k);
        out += ' '.repeat(e - k);
        k = e;
        continue;
      }
      // A heredoc: exactly `<<` or `<<-` (not `<<<`, nor the second `<` of one), then its word.
      if (c === '<' && text[k + 1] === '<' && text[k + 2] !== '<' && text[k - 1] !== '<') {
        const h = /^<<(-?)[ \t]*((?:\\.|'[^'\n]*'|"[^"\n]*"|[^\s;&|<>()'"\\])+)/.exec(text.slice(k, k + 200));
        if (h) {
          docs.push({ word: h[2]!.replace(/\\(.)/g, '$1').replace(/['"]/g, ''), strip: h[1] === '-' });
          out += h[0];
          k += h[0].length;
          continue;
        }
      }
      // A case only in its own shape, `case WORD in` (R1264y/z D1: `grep -c case f` holds none).
      if (wordAt(k) && /^case[ \t]+(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|()]+)[ \t]+in(?=[\s;&|()]|$)/.test(text.slice(k, k + 200))) t.cases++;
      if (wordAt(k) && /^esac(?=[\s;&|()]|$)/.test(text.slice(k, k + 5))) t.cases = Math.max(0, t.cases - 1);
      if (c === '\\') { out += text.slice(k, k + 2); k += 2; continue; }
      if (c === '$' && text[k + 1] === '(' && text[k + 2] === '(') { st.push({ q: 'arith', depth: 0, cases: 0 }); out += '$(('; k += 3; continue; }
      if (c === '(' && text[k + 1] === '(' && wordAt(k)) { st.push({ q: 'arith', depth: 0, cases: 0 }); out += '(('; k += 2; continue; }
      if (c === '$' && text[k + 1] === '{') { st.push({ q: 'brace', depth: 0, cases: 0, masked: false }); out += '${'; k += 2; continue; }
      if (c === '$' && text[k + 1] === '(') { st.push({ q: 'sub', depth: 0, cases: 0 }); out += '$('; k += 2; continue; }
      if (c === '(' ) { t.depth++; out += c; k++; continue; }
      // Parens pair as in bash (a `(pattern)`, a subshell or an array in a case arm too, R1264z D1); at depth 0, a `)`
      // inside case … esac ends a pattern, and otherwise closes the substitution.
      if (c === ')') { if (t.depth > 0) t.depth--; else if (t.q === 'sub' && t.cases === 0) st.pop(); out += c; k++; continue; }
      if (c === '`') { if (t.q === 'bq') st.pop(); else st.push({ q: 'bq', depth: 0, cases: 0 }); out += c; k++; continue; }
      if (c === '$' && text[k + 1] === "'") { st.push({ q: "$'", depth: 0, cases: 0 }); out += "$'"; k += 2; continue; }
      if (c === "'" || c === '"') { st.push({ q: c, depth: 0, cases: 0 }); out += c; k++; continue; }
      out += c;
      k++;
      continue;
    }
    // Inside a quote.
    if (t.q === "'") { if (c === "'") { st.pop(); out += c; } else out += c === '\n' ? '\n' : ' '; k++; continue; }
    if (c === '\\') { out += text.slice(k, k + 2).replace(/[^\n]/g, ' '); k += 2; continue; }
    if (t.q === "$'") { if (c === "'") { st.pop(); out += c; } else out += c === '\n' ? '\n' : ' '; k++; continue; }
    // "…": `$((`, `$(` and `` ` `` open an unquoted context.
    if (c === '"') { st.pop(); out += c; k++; continue; }
    if (c === '$' && text[k + 1] === '(' && text[k + 2] === '(') { st.push({ q: 'arith', depth: 0, cases: 0 }); out += '   '; k += 3; continue; }
    if (c === '$' && text[k + 1] === '{') { st.push({ q: 'brace', depth: 0, cases: 0, masked: true }); out += '  '; k += 2; continue; }
    if (c === '$' && text[k + 1] === '(') { st.push({ q: 'sub', depth: 0, cases: 0 }); out += '  '; k += 2; continue; }
    if (c === '`') { st.push({ q: 'bq', depth: 0, cases: 0 }); out += ' '; k++; continue; }
    out += c === '\n' ? '\n' : ' ';
    k++;
  }
  const names: Record<string, string> = { "'": "a '…' quote", "$'": "a $'…' quote", '"': 'a "…" quote', sub: 'a $(…)', bq: 'a `…`', arith: 'a ((…))', brace: 'a ${…}' };
  const open = unfinished ?? (docs.length ? `a heredoc to ${docs[0]!.word}` : st.length > 1 ? names[String(top().q)]! : null);
  return { out, open };
}

/** A substitution's text that looks the binary up: its output is the binary. */
const LOOKUP = /^\s*(?:command\s+-[vV]|which|type\s+-[Pp])\s+["']?(?:\S*\/)?claude["']?\s*$/;

/** Where the `)` closing a `$(` that opens at `from` (just past its `(`) is: quotes and nested parens skipped. */
function closeParen(t: string, from: number): number {
  let depth = 1;
  let q: Quote = null;
  for (let k = from; k < t.length; ) {
    const c = t[k]!;
    if (!q && c === '(') depth++;
    else if (!q && c === ')' && --depth === 0) return k;
    const r = quoteStep(t, k, q);
    q = r.q;
    k += r.n;
  }
  return t.length;
}

/**
 * A line's commands: split at `;`, `&&`, `||`, `|`, `(`, `)`, `{`, `}` outside quotes. A substitution (`$(…)`, a
 * backtick pair), outside single quotes, is a command list of its own, read recursively; in its place the outer
 * command holds a placeholder word, so the quotes around it stay whole.
 */
function commands(t: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: Quote = null;
  let braces = 0;
  for (let k = 0; k < t.length; k++) {
    const c = t[k]!;
    const two = t.slice(k, k + 2);
    if (q === "'") {
      cur += c;
      if (c === "'") q = null;
      continue;
    }
    // A backslash takes the next character, outside quotes and inside `$'…'` and `"…"` (R1264j D2).
    if (c === '\\') {
      cur += two;
      k++;
      continue;
    }
    if (q === "$'") {
      cur += c;
      if (c === "'") q = null;
      continue;
    }
    if (two === '$(') {
      const end = closeParen(t, k + 2);
      out.push(...commands(t.slice(k + 2, end)));
      // R1264h D3: a lookup of the binary (`"$(command -v claude)"`, `$(which claude)`) stands for the binary.
      cur += LOOKUP.test(t.slice(k + 2, end)) ? '/claude' : 'X';
      k = end;
      continue;
    }
    if (c === '`') {
      let end = k + 1;
      while (end < t.length && !(t[end] === '`' && t[end - 1] !== '\\')) end++;
      out.push(...commands(t.slice(k + 1, end)));
      cur += LOOKUP.test(t.slice(k + 1, end)) ? '/claude' : 'X';
      k = end;
      continue;
    }
    if (two === '${') {
      braces++;
      cur += two;
      k++;
      continue;
    }
    if (braces && c === '}') {
      braces--;
      cur += c;
      continue;
    }
    if (q === '"') {
      cur += c;
      if (c === '"') q = null;
      continue;
    }
    if (two === "$'") {
      q = "$'";
      cur += two;
      k++;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
    } else if (two === '&&' || two === '||') {
      out.push(cur);
      cur = '';
      k++;
    } else if (!braces && ';|(){}'.includes(c)) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * A command's words, quotes kept together; `${x:+…}` stays one word, nested quotes and `${…}` inside it too
 * (`${a[@]+"${a[@]}"}`: a regex that can't nest them glued the words after it into one, hiding a claude word).
 * `quoted`: the whole word is one quoted string.
 */
function wordsOf(cmd: string): Word[] {
  const raw: string[] = [];
  const stack: string[] = [];
  let cur = '';
  for (let k = 0; k < cmd.length; k++) {
    const c = cmd[k]!;
    const top = stack.at(-1);
    if (top === "'") {
      cur += c;
      if (c === "'") stack.pop();
    } else if (c === '\\') {
      cur += c + (cmd[k + 1] ?? '');
      k++;
    } else if (top === "$'") {
      cur += c;
      if (c === "'") stack.pop();
    } else if (c === '$' && cmd[k + 1] === "'" && top !== '"') {
      stack.push("$'");
      cur += "$'";
      k++;
    } else if (c === '$' && cmd[k + 1] === '{') {
      stack.push('{');
      cur += '${';
      k++;
    } else if (top === '{' && c === '}') {
      stack.pop();
      cur += c;
    } else if (c === '"') {
      if (top === '"') stack.pop();
      else stack.push('"');
      cur += c;
    } else if (c === "'" && top !== '"') {
      stack.push("'");
      cur += c;
    } else if (/\s/.test(c) && !stack.length) {
      if (cur) raw.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur) raw.push(cur);
  return raw.map((w) => ({ text: w, quoted: /^(['"]).*\1$/s.test(w) }));
}
const unquote = (w: string) => w.replace(/^(['"])(.*)\1$/s, '$2');

/** Where the `}` closing a `{` that opens just before `from` is: quotes, escapes, `${…}` and comments read. */
function closeBrace(t: string, from: number): number {
  let depth = 1;
  let q: Quote = null;
  for (let k = from; k < t.length; ) {
    const c = t[k]!;
    if (!q && c === '#' && (k === 0 || /\s/.test(t[k - 1]!))) {
      k = t.indexOf('\n', k) < 0 ? t.length : t.indexOf('\n', k);
      continue;
    }
    if (!q && c === '{') depth++;
    else if (!q && c === '}' && --depth === 0) return k;
    const r = quoteStep(t, k, q);
    q = r.q;
    k += r.n;
  }
  return t.length;
}

/**
 * The text a pin's digest holds (R1264e D1, R1264f D4, R1264h D1): for a workflow step, the whole step (its callers,
 * and the folders they fill, are in it); else the innermost shell function around physical line `line` of `text`
 * (`name() {…}`, `function name {…}`), or all of `text` when the call is top-level, and with it every line, anywhere in
 * `text`, that assigns a variable the call's logical line reads (`NAME=`, `NAME+=`, `NAME[i]=`, `local`/`export`/
 * `declare NAME`, `read`/`mapfile`/`readarray … NAME`, `for NAME in`, `unset NAME`). Positional parameters (`$1`, `$@`)
 * aren't followed outside a workflow step: a named limit.
 */
export function pinScope(path: string, text: string, line: number): string {
  if (path.startsWith('.github/')) return text;
  const at = text.split('\n').slice(0, line - 1).reduce((a, l) => a + l.length + 1, 0);
  let best: [number, number] | null = null;
  for (const m of text.matchAll(/(^|\n)[ \t]*(?:function[ \t]+[A-Za-z_][\w-]*(?:[ \t]*\([ \t]*\))?|[A-Za-z_][\w-]*[ \t]*\([ \t]*\))[ \t]*\{/g)) {
    const start = m.index! + m[1]!.length;
    const end = closeBrace(text, m.index! + m[0].length) + 1;
    if (start <= at && at < end && (!best || start >= best[0])) best = [start, end];
  }
  const scope = best ? text.slice(best[0], best[1]) : text;
  if (!best) return scope;
  const call = logicalLines(text).find((l) => l.line <= line && line <= l.end)?.text ?? '';
  const names = [...new Set([...call.matchAll(/\$\{?#?!?([A-Za-z_]\w*)/g)].map((m) => m[1]!))].sort();
  const sets = text.split('\n').filter((l) =>
    names.some((n) => new RegExp(`(?:^|[\\s;&|(])(?:${n}(?:\\[[^\\]]*\\])?\\+?=|(?:local|export|declare|typeset|readonly|unset)(?:\\s+-\\w+)*(?:\\s+\\w+)*\\s+${n}\\b|(?:read|mapfile|readarray)\\b[^;&|]*\\s${n}\\b|for\\s+${n}\\s+in\\b)`).test(l)),
  );
  return [scope, ...sets].join('\n');
}
export const scopeDigest = (path: string, text: string, line: number) => createHash('sha256').update(pinScope(path, text, line)).digest('hex');

/** Each claude call a shell text starts other than through claude_guarded, unpinned, as `<path>:<line>: <why>`. */
export function shellLaunchProblems(path: string, text: string, pinned = new Map<Pin, number>()): string[] {
  const lines = logicalLines(text);
  // Variables this file sets to claude.
  const vars = new Set<string>();
  for (const { text: t } of lines) {
    for (const part of t.split(/;\s*/)) {
      const v = /^(?:(?:export|local|readonly|declare|typeset)(?:\s+-\w+)*\s+)?([A-Za-z_]\w*)(\+?)=(.*)$/.exec(part.trim());
      // Fail closed (R1264d D4): a variable whose value names the binary anywhere is the binary.
      if (v && VALUE_CLAUDE(unquote(v[3]!.trim()))) vars.add(v[1]!);
      // `printf -v NAME <format> <args>` assigns too (R1264l D4 l03x).
      const pv = /^printf\s+-v\s+([A-Za-z_]\w*)\s+(.*)$/.exec(part.trim());
      if (pv && wordsOf(pv[2]!).some((w) => VALUE_CLAUDE(unquote(w.text)))) vars.add(pv[1]!);
    }
  }
  const out: string[] = [];
  // R1264g/h: claude_guarded is lib.sh's alone; a script that defines its own (or an alias) can't borrow its name.
  if (path !== 'scripts/setup/lib.sh')
    for (const { line, text: t } of lines)
      if (/(?:^|[\s;&|{(])(?:function\s+claude_guarded\b|claude_guarded\s*\(\s*\)|alias\s+claude_guarded=)/.test(t)) out.push(`${path}:${line}: defines claude_guarded: only scripts/setup/lib.sh's may run, so source it`);
  // R1264l D3: a function or alias named for a command a launch runs through (`sudo`, `env`, `timeout`, …) rewrites
  // a pinned call, or a script that sources this file, unseen: refused anywhere.
  // A function bash runs for a command named by that exact path (`/usr/bin/env() {…}`, `function /usr/bin/sudo {…}`)
  // shadows it too: any name with a `/` is refused, and a listed name after any `…/` (R1264m D2, n D1).
  // Quoted text masked across the whole file, so a quote that spans lines (a multi-line awk or `node -e` program) is
  // masked on every line it covers (R1264t D2); comments cut in the same pass (an apostrophe in one opens no quote).
  const mask = maskFile(text);
  const masked = mask.out.split('\n');
  // Fail-safe (R1264w/x): a file the mask ends still inside a quote, substitution or heredoc is one this lint lost sync
  // with; it is refused, rather than read with the rest of it masked unseen.
  if (mask.open) out.push(`${path}: the lint can't follow this file's quoting to its end (it ends inside ${mask.open}); a definition after the point it lost sync would go unread: refused (R1264w/x)`);
  for (const { line, end, text: t } of lines) {
    // Read with quoted text masked (a regex's ` [()]` in grep, tr or sed is no definition, R1264r D3), and a definition
    // only with a body after the `()`: any compound command (`{`, `(`, `[[`, if, for, while, until, case, select) or
    // the line's end (R1264s D1); `alias name=` reads quoted text too.
    // A line continued with `\` reads as one (`sudo() \⏎{`, `function \⏎ sudo`, R1264v D1).
    const bare = masked.slice(line - 1, end).map((l) => l.replace(/\\\s*$/, ' ')).join(' ');
    for (const m of bare.matchAll(/(?:^|[\s;&|{(])(?:function\s+([A-Za-z0-9_./:+@[-]+)|([A-Za-z0-9_./:+@[-]+)\s*\(\s*\)\s*(?=[{(]|\[\[|(?:if|for|while|until|case|select)\b|$)|alias\s+([A-Za-z0-9_./:+@[-]+)=)/g)) {
      const name = m[1] ?? m[2] ?? m[3]!;
      if (name.includes('/') || SHADOWED.has(name)) out.push(`${path}:${line}: defines ${name}, ${name.includes('/') ? 'a function named by a path (bash runs it for that path)' : 'a command a claude launch runs through'}: refused (R1264l D3, R1264m D2)`);
    }
    // R1264o D2, p D2: `enable -n` turns a builtin claude_guarded relies on (builtin, read, local, cd) into a PATH lookup.
    // Only `enable` as a command's first word, with -n among its own options (before its first non-option word).
    const disables = commands(t).some((c) => {
      const w = wordsOf(c).map((x) => x.text);
      let k = 0;
      // Past assignments, reserved words (then, do, else, !, time), `command` and `{` (R1264s D1).
      while (k < w.length && (/^[A-Za-z_]\w*\+?=/.test(w[k]!) || KEYWORDS.has(w[k]!) || w[k] === 'command' || w[k] === '{')) k++;
      if (!/^(?:builtin\s+)?enable$/.test(w[k] ?? '') && !(w[k] === 'builtin' && w[k + 1] === 'enable')) return false;
      for (const o of w.slice(w[k] === 'builtin' ? k + 2 : k + 1)) {
        if (!/^-/.test(o) || o === '--') return false;
        if (/^-[a-zA-Z]*n/.test(o)) return true;
      }
      return false;
    });
    if (disables) out.push(`${path}:${line}: disables a builtin (enable -n), which claude_guarded runs by name: refused (R1264o D2)`);
    // R1264o D3: claude_guarded's test PATH marker is the tests' alone: a script that names it can write one.
    // lib.sh reads it; the installer (engine.sh) names it only to refuse a tree that holds one.
    if (!['scripts/setup/lib.sh', 'scripts/setup/engine.sh'].includes(path) && /claude-guarded-test-path/.test(t)) out.push(`${path}:${line}: names claude_guarded's test PATH marker (.claude-guarded-test-path), which only the tests may write: refused (R1264o D3)`);
    // A DEBUG or RETURN trap, extdebug or functrace runs code inside claude_guarded's own function (R1264m D2).
    if (/(?:^|[\s;&|{(])trap\b[^;&|]*\b(?:DEBUG|RETURN)\b|\bshopt\s+-s\b[^;&|]*\bextdebug\b|\bset\s+(?:-[A-Za-z]*T\b|-o\s+functrace\b)/.test(t)) out.push(`${path}:${line}: sets a DEBUG or RETURN trap, extdebug or functrace, which run code inside claude_guarded: refused (R1264m D2)`);
  }
  // claude_guarded's own variables are lib.sh's: a script that sets one (CLAUDE_GUARDED_PATH is the tests') points it elsewhere.
  if (path !== 'scripts/setup/lib.sh')
    for (const { line, text: t } of lines)
      if (/(?:^|[\s;&|(])(?:(?:export|local|declare|readonly|typeset)(?:\s+-\w+)*\s+)?CLAUDE_GUARDED_\w*\+?=|\bread\b[^;&|]*\bCLAUDE_GUARDED_\w*/.test(t)) out.push(`${path}:${line}: sets one of claude_guarded's own variables (CLAUDE_GUARDED_*): refused`);
  const isClaude = (w: Word) => {
    const u = unquote(w.text);
    const m = /^\$\{?([A-Za-z_]\w*)(?:[:-][^}]*)?\}?$/.exec(u);
    if (m && vars.has(m[1]!)) return true;
    // A glob that matches the binary's name (R1264l D4 l02a: `/usr/local/bin/claud[e]`).
    const last = u.split('/').at(-1) ?? '';
    // Only a glob aimed at it: one that matches no other name (`*`, `*e`, a case pattern, `**` in an expression don't).
    if (!w.quoted && /[*?[]/.test(last) && globMatches(last, 'claude') && !['x', 'sh', 'bash', 'node', 'git', 'true', 'code'].some((n) => globMatches(last, n))) return true;
    return BINARY.test(u) || isClaudeToken(u);
  };
  // The physical lines of the logical line being judged, and the lines each pin has covered so far.
  const raw = text.split('\n');
  let phys: number[] = [];
  const judge = (line: number, cmd: string) => {
    const words = wordsOf(cmd);
    // Strings run as commands, recursively: after `-c` (`bash -c`, `bash -lc`, `su -c`), `-c --`, `eval`,
    // `--command` (su, runuser) and `env -S`/`--split-string`, or joined to one of those by `=`; and every quoted word
    // of a command that `tmux` or `ssh` runs (R1264j D3: `tmux new-session -d "claude …"`, `ssh host 'claude …'`).
    const remote = (i: number) => words.slice(0, i).some((x) => !x.quoted && /^(?:\S*\/)?(?:tmux|ssh|watch)$/.test(x.text));
    words.forEach((w, i) => {
      const prev = words[i - 1]?.text;
      const prev2 = words[i - 2]?.text ?? '';
      const joined = /^(?:--command|--split-string|-S)=(.*)$/s.exec(w.text) ?? /^-[a-z]*c((["']).*\2)$/s.exec(w.text);
      if (joined) scan(line, unquote(joined[1]!));
      else if (
        w.quoted &&
        prev &&
        (/^-[a-z]*c$/.test(prev) || prev === 'eval' || (prev === '--' && /^-[a-z]*c$/.test(prev2)) || ['--command', '-S', '--split-string'].includes(prev) || remote(i))
      )
        scan(line, unquote(w.text));
    });
    let k = 0;
    while (k < words.length && (/^[A-Za-z_]\w*\+?=/.test(words[k]!.text) || KEYWORDS.has(words[k]!.text))) k++;
    if (k >= words.length) return;
    // A known non-launcher anywhere before a claude word (`sudo rm -f …/claude`, `[ "$c" != …/claude ]`) makes it
    // data; `command` is one only as `command -v`/`-V`.
    const dataFrom = (i: number) => words.slice(k, i).some((w, j, a) => !w.quoted && (NON_LAUNCHERS.has(w.text) ? w.text !== 'command' || /^-[vV]$/.test(a[j + 1]?.text ?? '') : false));
    for (let i = k; i < words.length; i++) {
      if (!isClaude(words[i]!) || dataFrom(i)) continue;
      // Its argument words, trailing redirections and `&` dropped.
      const args = words.slice(i + 1).map((w) => w.text);
      for (;;) {
        if (args.length && /^(?:\d*[<>]+&?\S+|&|\\;|;|\+)$/.test(args.at(-1)!)) args.pop();
        else if (args.length >= 2 && /^\d*[<>]{1,2}&?$/.test(args.at(-2)!)) args.splice(-2);
        else break;
      }
      const plain = args.map(unquote);
      const joined = plain.join(' ');
      if (EXEMPT_ARGV.test(joined)) return;
      // A pin (the spike's, or an exception) covers exactly one call (R1264c D2, R1264d D1): a second call on its
      // line, on the lines continued into it, or a copy of the line anywhere in the file, is refused. And only while
      // its scope (pinScope) is the one pinned, by digest (R1264e D1, R1264f D4, R1264h D1): no edit to a line it is
      // continued from, a wrapper, or the assignment of a variable it reads moves or widens it unseen.
      const onLine = [...SHELL_PINS, ...SHELL_EXCEPTIONS].flatMap((p) => (p[0] === path ? phys.filter((n) => raw[n - 1]?.trim() === p[1]).map((n) => [p, n] as const) : []));
      const pin = onLine.find(([p, n]) => scopeDigest(path, text, n) === p[3])?.[0];
      if (!pin && onLine.length) {
        const [p, n] = onLine[0]!;
        out.push(`${path}:${line}: a pinned line (\`${p[1].slice(0, 80)}\`) whose scope changed: its digest is now ${scopeDigest(path, text, n)}, the pin holds ${p[3]}; a changed pin is a change to the test`);
        return;
      }
      if (pin) {
        const n = (pinned.get(pin) ?? 0) + 1;
        pinned.set(pin, n);
        if (n > 1) out.push(`${path}:${line}: a second claude call under a pinned line (\`${pin[1].slice(0, 100)}\`): a pin covers one call; start it through claude_guarded`);
        return;
      }
      out.push(`${path}:${line}: starts claude (\`${cmd.slice(0, 140)}\`) directly: start it through claude_guarded (scripts/setup/lib.sh: an empty environment, only safe flags, the launch's guards last), or pin it`);
      return;
    }
  };
  function scan(line: number, t: string) {
    for (const l of logicalLines(t)) for (const part of commands(l.text.replace(/^[^()\s]+\)(?=\s|$)/, ''))) judge(line, part);
  }
  for (const { line, end, text: t } of lines) {
    phys = Array.from({ length: end - line + 1 }, (_, k) => line + k);
    scan(line, t);
  }
  return out;
}

/** A workflow's or composite action's `run:` steps as shell, and any `uses:` of a claude action. */
export function workflowLaunchProblems(path: string, text: string): string[] {
  const out: string[] = [];
  const steps: Record<string, unknown>[] = [];
  const walk = (x: unknown) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      if ('run' in o || 'uses' in o) steps.push(o);
      Object.values(o).forEach(walk);
    }
  };
  walk(parse(text) as unknown);
  // One count of each pin's calls for the whole file, across its steps (a pin covers one call).
  const pinned = new Map<Pin, number>();
  for (const s of steps) {
    const where = `${path} (step ${typeof s.name === 'string' ? JSON.stringify(s.name.slice(0, 60)) : '(unnamed)'})`;
    if (typeof s.uses === 'string' && /claude/i.test(s.uses)) out.push(`${where}: uses ${s.uses}, which starts claude with the repo's own settings: not allowed`);
    if (typeof s.run === 'string') out.push(...shellLaunchProblems(path, s.run, pinned).map((p) => p.replace(`${path}:`, `${where}:`)));
  }
  return out;
}

/** Makefile recipes, package.json scripts and Dockerfile RUN lines, as shell. */
export function otherLaunchProblems(path: string, text: string): string[] {
  if (/(^|\/)package\.json$/.test(path)) {
    const scripts = (JSON.parse(text) as { scripts?: Record<string, string> }).scripts ?? {};
    const pinned = new Map<Pin, number>();
    return Object.entries(scripts).flatMap(([k, v]) => shellLaunchProblems(`${path} (scripts.${k})`, v, pinned));
  }
  if (/(^|\/)Dockerfile[^/]*$/.test(path)) return shellLaunchProblems(path, text.split('\n').map((l) => (/^\s*RUN\s/.test(l) ? l.replace(/^\s*RUN\s+/, '') : '')).join('\n'));
  if (/(^|\/)(?:GNU)?[Mm]akefile$|\.mk$/.test(path)) return shellLaunchProblems(path, text.split('\n').map((l) => (l.startsWith('\t') ? l.slice(1).replace(/^[@-]+/, '') : '')).join('\n'));
  return [];
}

/** JavaScript lines that name the claude binary without starting it, pinned by file and line text, each with why. */
// check-table: never-grow
export const JS_NAMES: [string, string, string][] = [
  ['scripts/bench/auth.ts', "export function requireSubscription(env: NodeJS.ProcessEnv, bin = 'claude'", "the binary's default; its only call is `bin auth status --json` (exempt), in this function"],
  ['scripts/bench/auth.ts', "export function requireClaudePin(env: NodeJS.ProcessEnv, bin = 'claude'", "the binary's default; its only call is `bin --version` (exempt), in this function"],
  ['scripts/bench/cli.ts', "claude: deps.claude ?? 'claude',", "the bench's claude binary, handed to its CliRunner (src/claude-launch.ts's launch) and to auth.ts's two exempt probes"],
  ['scripts/dev/control-dashboard.mjs', "key: 'claude'", 'an event field (a login key), not a binary'],
  ['scripts/dev/control-dashboard.mjs', "source: 'claude'", "an event field (a usage limit's source), not a binary"],
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TsNode = any;
const ts = createRequire(join(repoRoot, 'package.json'))('typescript') as TsNode;

/**
 * JavaScript and TypeScript the repo runs (scripts/), read with typescript's parser (comments aren't code): the claude
 * binary as a string literal is a call. With a literal argv array right after it (`spawn('claude', [...])`,
 * `asUser(u, 'claude', [...])`), or the elements after it in its array (`'npx', ['@anthropic-ai/claude-code', ...]`),
 * that argv must start exempt (`--version`, `auth status`); a script starts a session only through claude_guarded
 * (R1264g/h). A string a shell runs is read as shell (a template's text with its holes as words): `exec`/`execSync`'s
 * command, the one after `'-c'`/`'-lc'`, and any string that starts with the binary and a space, wherever it stands
 * (`run('claude -p hi')` with a promisified exec, `spawnSync('claude -p hi', { shell: true })`, `'claude -p ' + p`;
 * R1264h D4) and a flag, quote, `$`, redirect or separator next; a plain word next ('claude doctor' handed to a
 * promisified exec) is a named limit, read only as exec's command or after '-c'. Any other literal claude is refused unless its line is pinned (JS_NAMES).
 */
export function jsLaunchProblems(path: string, text: string): string[] {
  const out: string[] = [];
  // R1264o D3, q D1: the tests' marker for claude_guarded's PATH, named in JavaScript under scripts/ too; the updater
  // (worklane-update.cjs) names it only to refuse a tree that holds one.
  if (path !== 'scripts/machine/worklane-update.cjs')
    text.split('\n').forEach((l, i) => {
      if (/claude-guarded-test-path/.test(l)) out.push(`${path}:${i + 1}: names claude_guarded's test PATH marker (.claude-guarded-test-path), which only the tests may write: refused (R1264o D3)`);
    });
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const lineOf = (n: TsNode) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const lines = text.split('\n');
  const textOf = (n: TsNode): string | null =>
    ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : ts.isTemplateExpression(n) ? [n.head.text, ...n.templateSpans.map((x: TsNode) => `X${x.literal.text}`)].join('') : null;
  const literalArgv = (els: TsNode[]): string[] | null => (els.every((e: TsNode) => textOf(e) !== null) ? els.map((e: TsNode) => textOf(e)!) : null);
  const visit = (n: TsNode) => {
    const s = textOf(n);
    if (s !== null) {
      const at = lineOf(n);
      const pinned = JS_NAMES.some(([f, l]) => f === path && lines[at - 1]!.includes(l));
      const p = n.parent;
      if (BINARY.test(s) && !pinned) {
        let argv: string[] | null = null;
        if (ts.isCallExpression(p)) {
          const next = p.arguments[p.arguments.indexOf(n) + 1];
          argv = next && ts.isArrayLiteralExpression(next) ? literalArgv(next.elements) : null;
        } else if (ts.isArrayLiteralExpression(p)) argv = literalArgv(p.elements.slice(p.elements.indexOf(n) + 1));
        if (argv === null) out.push(`${path}:${at}: names the claude binary (${n.getText(sf)}) where its argv can't be read: start a session through claude_guarded (scripts/setup/lib.sh), or pin the line in JS_NAMES`);
        else if (!EXEMPT_ARGV.test(argv.join(' '))) out.push(`${path}:${at}: starts claude (${p.getText(sf).replace(/\s+/g, ' ').slice(0, 140)}) directly: a script starts a session only through claude_guarded (scripts/setup/lib.sh)`);
      } else if (!BINARY.test(s)) {
        // A string a shell runs: exec/execSync's command, the string after '-c' (or '-lc'), or one that starts with the
        // binary and a space, wherever it stands (R1264h D4).
        const callee = ts.isCallExpression(p) ? p.expression.getText(sf) : '';
        const afterC = ts.isArrayLiteralExpression(p) && /^-[a-z]*c$/.test(textOf(p.elements[p.elements.indexOf(n) - 1] ?? n) ?? '') && p.elements.indexOf(n) > 0;
        // A string that starts with the binary, then a flag, a quote, `$`, a redirect or a separator (prose such as
        // 'claude reports …' doesn't: a plain word after it is a named limit outside exec and '-c').
        const startsBinary = /^\s*(\S+)\s+(?:[-"'$<>|;&]|$)/.test(s) && BINARY.test(/^\s*(\S+)/.exec(s)![1]!);
        if ((/(?:^|\.)exec(?:Sync)?$/.test(callee) && p.arguments[0] === n) || afterC || startsBinary) out.push(...shellLaunchProblems(path, s).map((x) => x.replace(/^[^:]+:\d+:/, `${path}:${at}:`)));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const tracked = (): string[] => execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' }).split('\0').filter(Boolean);
const shebang = (f: string) => {
  try {
    return readFileSync(join(repoRoot, f), 'utf8').slice(0, 120);
  } catch {
    return '';
  }
};

/** Every place the lint reads, by kind. */
export function lintedFiles(files: string[], head: (f: string) => string = shebang): { shell: string[]; workflow: string[]; other: string[]; js: string[] } {
  const live = files.filter((f) => !/(^|\/)(node_modules|dist)\//.test(f) && !f.startsWith('test/fixtures/'));
  return {
    shell: live.filter((f) => /\.(?:sh|bash|zsh|ksh|fish)$/.test(f) || f.startsWith('.githooks/') || (!/\.\w+$/.test(f) && /^#!.*\b(?:ba|z|k|da|fi)?sh\b/.test(head(f)))),
    workflow: live.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f) || /^\.github\/actions\/.+\/action\.ya?ml$/.test(f)),
    other: live.filter((f) => /(^|\/)package\.json$|(^|\/)Dockerfile[^/]*$|(^|\/)(?:GNU)?[Mm]akefile$|\.mk$/.test(f)),
    js: live.filter((f) => /^scripts\/.+\.(?:mjs|cjs|js|ts)$/.test(f) && !f.endsWith('.d.ts')),
  };
}

test("#1262 (R1264g/h): every claude a script starts goes through claude_guarded, or is a pinned exception", () => {
  const f = lintedFiles(tracked());
  const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');
  // One count of each pin's calls across the tree (R1264e D1): each covers exactly one live call.
  const pinned = new Map<(typeof SHELL_PINS)[number], number>();
  const problems = [
    ...f.shell.flatMap((p) => shellLaunchProblems(p, read(p), pinned)),
    ...f.workflow.flatMap((p) => workflowLaunchProblems(p, read(p))),
    ...f.other.flatMap((p) => otherLaunchProblems(p, read(p))),
    ...f.js.flatMap((p) => jsLaunchProblems(p, read(p))),
  ];
  assert.deepEqual(problems, []);
  // Each pin still names one line that is there, once.
  for (const [p, l] of SHELL_PINS) assert.equal(read(p).split('\n').filter((x) => x.trim() === l).length, 1, `${p}: its pinned line is there once: ${l.slice(0, 80)}`);
  for (const pin of [...SHELL_PINS, ...SHELL_EXCEPTIONS].filter(([p]) => !p.startsWith('.github/'))) assert.equal(pinned.get(pin), 1, `${pin[0]}: its pin covers one live call: ${pin[1].slice(0, 80)}`);
});

/** Each pin with the shell text it is linted in (a workflow's step, or the file) and its physical line there. */
function pinSites(): { pin: (typeof SHELL_PINS)[number]; text: string; line: number }[] {
  return [...SHELL_PINS, ...SHELL_EXCEPTIONS].map((pin) => {
    const file = readFileSync(join(repoRoot, pin[0]), 'utf8');
    const texts: string[] = [];
    if (pin[0].startsWith('.github/')) {
      const walk = (x: unknown) => {
        if (Array.isArray(x)) x.forEach(walk);
        else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x as Record<string, unknown>)) (k === 'run' && typeof v === 'string' ? texts.push(v) : walk(v));
      };
      walk(parse(file) as unknown);
    } else texts.push(file);
    const text = texts.find((t) => t.split('\n').some((l) => l.trim() === pin[1]))!;
    assert.ok(text, `${pin[0]}: its pinned line is there: ${pin[1].slice(0, 80)}`);
    return { pin, text, line: text.split('\n').findIndex((l) => l.trim() === pin[1]) + 1 };
  });
}

test('#1262 (R1264h D1): a pin\'s scope holds the assignments of the variables its call reads, wherever they are, and a workflow pin holds its whole step', () => {
  const text = 'ARGS=(-p hi)\nX=one\nf() {\n  local Y=two\n  claude "${ARGS[@]}" "$X" "$Y"\n}\nZ=unread\n';
  const scope = pinScope('scripts/x.sh', text, 5);
  for (const l of ['ARGS=(-p hi)', 'X=one', 'local Y=two', 'claude "${ARGS[@]}" "$X" "$Y"']) assert.ok(scope.includes(l), `the scope holds ${l}`);
  assert.ok(!scope.includes('Z=unread'), 'not a variable the call does not read');
  const digest = scopeDigest('scripts/x.sh', text, 5);
  for (const edit of [text.replace('ARGS=(-p hi)', 'ARGS=(-p hi --plugin-dir p)'), text.replace('X=one', 'X=two'), `${text}ARGS+=(--agents a)\n`, `${text}read -r X < f\n`]) assert.notEqual(scopeDigest('scripts/x.sh', edit, 5), digest, `an assignment edit breaks it: ${edit.slice(-40)}`);
  assert.equal(scopeDigest('scripts/x.sh', text.replace('Z=unread', 'Z=other'), 5), digest, 'an unrelated line does not');
  const step = 'h=/tmp/a\ninit() { claude -p "$1"; }\ninit x\n';
  assert.equal(pinScope('.github/workflows/w.yml', step, 2), step, "a workflow pin's scope is its whole step");
});

test('#1262 (R1264e D1, R1264f D4): a pin holds its scope by digest: an edit to its function (or its top-level script) breaks it', () => {
  for (const { pin, text, line } of pinSites()) {
    assert.equal(scopeDigest(pin[0], text, line), pin[3], `${pin[0]}: the pin's digest is its scope's: ${pin[1].slice(0, 60)}`);
    const scope = pinScope(pin[0], text, line);
    assert.ok(scope.includes('\n'), `${pin[0]}: a pin's scope is more than its own line (a workflow pin holds its whole step)`);
    // A line added inside the scope (after its first line), as a wrapper or an assignment edit would be.
    const at = text.indexOf(scope.split('\n')[0]!) + scope.indexOf('\n') + 1;
    const edited = `${text.slice(0, at)}: edited\n${text.slice(at)}`;
    assert.ok(shellLaunchProblems(pin[0], edited).some((p) => /whose scope changed/.test(p)), `${pin[0]}: an edit inside its scope breaks the pin`);
  }
  // R1264e D1's attack on the spike: the line continued into the pinned one starts its own call and makes the pinned
  // one an echo's data.
  const spike = pinSites()[0]!;
  const lines = spike.text.split('\n');
  lines[spike.line - 2] = `  (cd "$wt" && claude -p "$(cat "$probe/prompt")" --setting-sources user,project,local --dangerously-skip-permissions && echo \\`;
  assert.ok(shellLaunchProblems(spike.pin[0], lines.join('\n')).length > 0, 'a call moved onto the line before the pin is refused');
});

/** The lines after claude_guarded's template that fill it in (R1264m D1): no variable is left to point it elsewhere. */
const WRAPPER_RESOLVE = [
  'case "${BASH_SOURCE[0]}" in */*) cg_here="${BASH_SOURCE[0]%/*}" ;; *) cg_here=. ;; esac',
  'cg_here="$(builtin cd -P -- "$cg_here" && builtin pwd)" || cg_here=""',
  "# A copy of scripts/setup alone (a CI probe, a test's tree) has no helper: claude_guarded refuses there, and lib.sh still loads.",
  'cg_helper="$(builtin cd -P -- "$cg_here/../lib" 2>/dev/null && builtin pwd)/claude-guarded.sh" || cg_helper=""',
  "# The paths go into the function's text as quoted values (printf %q), never as code: a folder name with a space, a",
  "# quote, `;` or `$(…)` in it is only a name (R1264t D1). The template is split once, at both placeholders, before",
  "# either value goes in, so a value is never read again for a placeholder (a folder named like one, R1264v D2); and",
  "# not by ${//}, whose replacement reads `&` (bash 5.2) as the matched text.",
  "builtin printf -v cg_here '%q' \"$cg_here\"",
  "builtin printf -v cg_helper '%q' \"$cg_helper\"",
  'cg_a="${cg_def%%@HERE@*}" cg_b="${cg_def#*@HERE@}"',
  'cg_def="$cg_a$cg_here${cg_b%%@HELPER@*}$cg_helper${cg_b#*@HELPER@}"',
  'builtin eval "$cg_def"',
  'builtin readonly -f claude_guarded',
  'builtin unset cg_def cg_here cg_helper cg_a cg_b',
].join('\n');
/** The digest of lib.sh's claude_guarded template (R1264l D2). */
const WRAPPER_DIGEST = '1b761ff69d43c872cae958eaa9c1db35c1ad484d02c8e198abd51e1189c778ac';

test('#1262 (R1264l D2, m D1): which file claude_guarded runs, and the wrapper itself, are held by digest: a widened copy at another path is refused', () => {
  const text = readFileSync(join(repoRoot, 'scripts', 'setup', 'lib.sh'), 'utf8');
  const at = text.split('\n').findIndex((l) => /^\s*builtin command \/usr\/bin\/env -i "PATH=\$cg_path" "HOME=\$HOME" \/bin\/bash --norc --noprofile "\$cg_sh" "\$@"$/.test(l)) + 1;
  assert.ok(at > 0, "lib.sh's claude_guarded runs its helper in a clean bash, by builtin command and absolute paths");
  assert.equal(scopeDigest('scripts/setup/lib.sh', text, at), WRAPPER_DIGEST, 'the wrapper is the one this test holds: a changed wrapper is a change to this test');
  // Where its two paths come from: resolved as lib.sh is sourced, written into the function's text, the function read-only.
  assert.ok(text.includes(WRAPPER_RESOLVE), 'lib.sh resolves its own folder and the helper as it is sourced, writes them into claude_guarded, and makes it read-only');
  assert.equal(text.match(/@HELPER@/g)?.length, 3, 'the helper path goes into the template in one place (its placeholder, and the one split around it)');
  // A copy of the helper, widened and named otherwise, with the template pointed at it: the digest or the resolution moves.
  const widened = text.replace('cg_helper="$(builtin cd -P -- "$cg_here/../lib" 2>/dev/null && builtin pwd)/claude-guarded.sh"', 'cg_helper="$(builtin cd -P -- "$cg_here/../lib" 2>/dev/null && builtin pwd)/claude-guarded.inc"');
  assert.notEqual(widened, text);
  assert.ok(!widened.includes(WRAPPER_RESOLVE));
  const retemplated = text.replace('cg_sh=@HELPER@', 'cg_sh=/tmp/claude-guarded.inc');
  assert.notEqual(scopeDigest('scripts/setup/lib.sh', retemplated, at), WRAPPER_DIGEST);
});


test('#1262 (R1264a/b): the places a script can live are all read', () => {
  const heads: Record<string, string> = { 'tools/run': '#!/bin/zsh\n', 'bin/x': '#!/usr/bin/env bash\n' };
  const f = lintedFiles(['a.zsh', 'b.ksh', 'c.fish', 'tools/run', 'bin/x', '.githooks/pre-commit', '.claude/hooks/h.sh', '.github/workflows/w.yml', '.github/actions/a/action.yaml', 'Makefile', 'sub/package.json', 'Dockerfile.ci', 'scripts/bench/x.ts', 'scripts/y.mjs', 'docs/a.md', 'test/fixtures/x.sh', 'node_modules/p/x.sh'], (p) => heads[p] ?? '');
  assert.deepEqual(f, {
    shell: ['a.zsh', 'b.ksh', 'c.fish', 'tools/run', 'bin/x', '.githooks/pre-commit', '.claude/hooks/h.sh'],
    workflow: ['.github/workflows/w.yml', '.github/actions/a/action.yaml'],
    other: ['Makefile', 'sub/package.json', 'Dockerfile.ci'],
    js: ['scripts/bench/x.ts', 'scripts/y.mjs'],
  });
});

const textOf = (text: string) => {
  const n = /^# text of <pin (\d+)>$/m.exec(text)?.[1];
  return n ? readFileSync(join(repoRoot, SHELL_PINS[Number(n) - 1]![0]), 'utf8') : text;
};
const asPath = (as: string | undefined) => (as === undefined ? undefined : /^<pin (\d+)>$/.test(as) ? SHELL_PINS[Number(/\d+/.exec(as)![0]) - 1]![0] : as);

test('#1262: the pinned exceptions are the owner\'s one, by its exact file, line and reason (a new or moved pin is a change to this test)', () => {
  // R1264c D1, R1264d D2: the whole list by its digest (no spike path named here, #673): its file, its exact line and
  // its reason. Moving, widening or adding a pin changes the digest, so the change shows in this test in review.
  assert.equal(createHash('sha256').update(JSON.stringify(SHELL_PINS)).digest('hex'), '7484a560900494d4afa1fb4b08958095a8cd5c938392879c1959a15787c3db3b');
  assert.deepEqual(SHELL_PINS.map(([f, , why]) => [f.split('/').at(-1), why]), [['worktree-commit.sh', 'a sandbox probe whose project-settings load is the point (the owner, 2026-11-11, "spikes: b")'], ['agent-messaging.sh', 'a spike that needs stream-json input (a second message mid-turn, an interrupt), which claude_guarded refuses (R1264j D1): its guards end the argv, and its stdin\'s printfs are in the file its digest holds (the owner\'s "spikes: b")'], ['agent-messaging.sh', 'a spike that needs stream-json input (a second message mid-turn, an interrupt), which claude_guarded refuses (R1264j D1): its guards end the argv, and its stdin\'s printfs are in the file its digest holds (the owner\'s "spikes: b")'], ['agent-messaging.sh', 'a spike that needs stream-json input (a second message mid-turn, an interrupt), which claude_guarded refuses (R1264j D1): its guards end the argv, and its stdin\'s printfs are in the file its digest holds (the owner\'s "spikes: b")']]);
});

test('#1262: every way a script can start claude other than through claude_guarded is refused (fixtures), and the controls pass', () => {
  const dir = join(repoRoot, 'test', 'fixtures', 'claude-launch-shell');
  const all = readdirSync(dir).sort();
  const nameOf = (f: string) => f.replace(/\.(?:sh|yml|mjs|mk|json|docker)\.txt$/, '');
  // Every fixture by name: one deleted fails here.
  // check-table: never-shrink
  const MUST_FAIL = [
    'after-and',
    'case-array-arm-then-sudo',
    'case-posix-pattern-then-sudo',
    'case-regex-paren-then-sudo',
    'case-resync-then-local',
    'case-subshell-arm-then-sudo',
    'grep-case-then-sudo',
    'param-pattern-dquote-then-sudo',
    'param-pattern-squote-then-sudo',
    'param-pattern-suffix-then-local',
    'arith-dollar-shift-then-test',
    'arith-if-shift-then-sudo',
    'arith-shift-then-local',
    'case-in-subst-then-sudo',
    'heredoc-backslash-then-read',
    'heredoc-partly-quoted-then-sudo',
    'herestring-bare-then-read',
    'herestring-sq-then-test',
    'herestring-word-then-test',
    'unclosed-quote-failsafe',
    'comment-after-case-then-test',
    'comment-after-semicolon-then-enable',
    'continued-definition',
    'heredoc-apostrophe-then-sudo',
    'heredoc-dash-then-alias',
    'heredoc-lone-dquote-then-read',
    'heredoc-quoted-then-local',
    'subst-in-dquotes-then-read',
    'enable-n-after-bang-time',
    'enable-n-after-command',
    'enable-n-after-else',
    'enable-n-after-then',
    'enable-n-in-for',
    'shadow-enable-for-body',
    'shadow-local-if-body',
    'shadow-read-while-body',
    'shadow-test-case-body',
    'shadow-test-dbracket-body',
    'js-test-path-marker',
    'shadow-enable',
    'shadow-read-alias',
    'shadow-test',
    'enable-n',
    'shadow-bracket',
    'shadow-local',
    'test-path-marker',
    'extdebug-functrace',
    'shadow-absolute-env',
    'shadow-absolute-sudo',
    'trap-debug',
    'default-no-colon',
    'default-no-colon-variable',
    'glob-binary',
    'guarded-path-set',
    'printf-v',
    'shadow-command',
    'shadow-sudo',
    'su-attached-c',
    'watch-command',
    'ansi-c-quote',
    'bash-c-dashdash',
    'env-split-string',
    'escaped-backslash-dq',
    'lone-backslash-sq-then-hash',
    'ssh-command',
    'su-command-equals',
    'tmux-command',
    'nested-expansion',
    'array-in-array',
    'array-quoted-variable',
    'claude-guarded-redefined',
    'command-v-backticks',
    'command-v-substitution',
    'flag-in-variable',
    'js-bash-lc',
    'js-concat',
    'js-plugin-template',
    'js-promisified-exec',
    'js-shell-true',
    'plugin-dir-backslash',
    'plugin-dir-spliced-quotes',
    'plugin-dirs-env',
    'prompt-variable',
    'add-dir',
    'agents-file',
    'array-after-call',
    'array-by-index',
    'array-default-in-if',
    'array-mapfile',
    'array-two-functions',
    'js-plugin-dir',
    'native-installer-binary',
    'plugin-dir',
    'plugin-url',
    'settings-helper-braced-variable',
    'settings-helper-variable',
    'array-append',
    'array-unguarded',
    'backticks',
    'bash-lc',
    'command-builtin',
    'command-v-variable',
    'assigning-default',
    'continued-line',
    'default-expansion',
    'exception-copied',
    'exception-in-prompt',
    'exception-widened',
    'local-array-override',
    'lookup-in-default',
    'pin-second-call',
    'quoted-cli-js',
    'quoted-npx-package',
    'quoted-path-after-sudo',
    'quoted-path-after-timeout',
    'settings-file',
    'settings-hooks',
    'variable-with-flags',
    'copied-spike-pin',
    'spike-pin-other-file',
    'spike-unguarded',
    'default-variable',
    'direct',
    'dockerfile-run',
    'dollar-paren',
    'env-wrapper',
    'eval-string',
    'exec',
    'find-exec',
    'guards-in-prompt',
    'guards-then-later-settings',
    'guards-then-later-sources',
    'helper',
    'heredoc',
    'in-a-case-arm',
    'js-bare-binary',
    'js-exec-string',
    'js-later-sources',
    'js-npx',
    'makefile-recipe',
    'node-cli-js',
    'npx',
    'one-guard-only',
    'optional-env',
    'package-json-script',
    'path',
    'setsid-stdbuf',
    'sh-c',
    'su-c',
    'sudo-iu',
    'sudo-usr-bin-env',
    'sudo-wrapper',
    'timeout-k',
    'timeout-wrapper',
    'variable',
    'workflow-composite-uses',
    'workflow-one-line-run',
    'xargs',
  ];
  // check-table: never-shrink
  const CONTROLS = ['ok-api-key-helper', 'ok-auth-status', 'ok-case-label', 'ok-comment', 'ok-continued-guards', 'ok-for-list', 'ok-grep-regex', 'ok-guarded', 'ok-guarded-array', 'ok-install-path', 'ok-js-auth-status', 'ok-js-guarded', 'ok-other-tool', 'ok-prose', 'ok-spike-pin', 'ok-version', 'ok-workflow-block-guarded', 'ok-brackets-and-enable', 'ok-multiline-awk-node', 'ok-arith-herestring-controls', 'ok-case-word-and-subshells'];
  assert.deepEqual(all.map(nameOf).sort(), [...MUST_FAIL, ...CONTROLS].sort(), 'every fixture, by name');
  for (const f of all) {
    const n = nameOf(f);
    const text = readFileSync(join(dir, f), 'utf8');
    const problems = f.endsWith('.yml.txt')
      ? workflowLaunchProblems(`.github/workflows/${n}.yml`, text)
      : f.endsWith('.mjs.txt')
        ? jsLaunchProblems(`scripts/${n}.mjs`, text)
        : f.endsWith('.mk.txt')
          ? otherLaunchProblems('Makefile', text)
          : f.endsWith('.json.txt')
            ? otherLaunchProblems('package.json', text)
            : f.endsWith('.docker.txt')
              ? otherLaunchProblems('Dockerfile', text)
              : // A shell fixture may name where it stands in its first line after the shebang: `# as <path>`.
                // `# as <pin N>`: the file of SHELL_PINS' Nth entry (1-based), so no fixture names a spike (#673).
                // `# text of <pin N>`: the fixture is that pinned file's own text (a pin holds its scope by digest).
                shellLaunchProblems(asPath(/^(?:#!.*\n)?# as (.+)/.exec(text)?.[1]?.trim()) ?? `scripts/${n}.sh`, textOf(text));
    if (n.startsWith('ok-')) assert.deepEqual(problems, [], `${n}: a control passes`);
    else assert.ok(problems.length > 0, `${n}: refused`);
  }
});
