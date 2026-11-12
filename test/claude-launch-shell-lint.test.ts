// lint-test
// #1262 (the owner's decision, 2026-11-10): the one-launch rule (#958, test/claude-launch-lint.test.ts) reaches the
// repo's scripts. Every `claude` a script the repo runs starts must END with the launch's guards
// (`--settings <json> --setting-sources '' --strict-mcp-config`: Claude Code takes the last of each, so nothing after
// them may name either, nor `--mcp-config`, nor anywhere a flag that loads more: `--plugin-dir`, `--plugin-url`,
// `--agents`, `--add-dir`), or be a pinned exception (file, line and its scope's digest), which starts no session.
// Else a setup, CI or spike script reopens #958's route: a planted hook or CLAUDE.md, loaded as root or the agent.
//
// It fails closed (R1264a/b): it doesn't list the launchers claude can sit behind. In each command (a line split at
// `;`, `&&`, `||`, `|`, `(`, `)`, `{`, `}`, `$(`, a backtick, quote-aware), ANY unquoted word that is `claude`,
// `…/claude`, `@anthropic-ai/claude-code[@…]` or `…/claude-code/cli.js`, or a variable this file sets to one
// (`C=claude`, `C="${X:-claude}"`, `C=$(command -v claude)`), in any position (after `sudo`, `/usr/bin/env -i`,
// `timeout -k`, `xargs`, `find -exec`, `npx`, `node`, a helper of the repo's own), is a claude call, and so is a quoted
// literal one as a command's first word. Only a command whose first word is a known non-launcher (`command -v`,
// `which`, `install`, `ln`, `echo`, a `for` list, …) names claude without starting it. A string after `-c` (`bash -c`,
// `bash -lc`, `su -c`) or `eval` is read as commands of its own, recursively.
// A call passes only when its argument WORDS (a quoted prompt is one word: guards inside it don't count; an array it
// expands is read from this file's `NAME=(…)` and `NAME+=(…)`; trailing redirections dropped) end with exactly the
// guards, in any order among themselves, or when it is a pinned exception.
//
// What it reads: every tracked file whose shebang names a shell, `*.sh`, `*.bash`, `*.zsh`, `*.ksh`, `*.fish`,
// `.githooks/*`; every workflow's and composite action's `run:` steps (parsed as YAML) and any `uses:` of a claude
// action; Makefile recipes; package.json scripts; Dockerfile RUN lines; and, as text, JavaScript and TypeScript under
// scripts/ (jsLaunchProblems).
//
// What it can't see (named limits): an alias or function defined elsewhere that hides the word claude, a variable set
// in another file or the environment (`$CLAUDE_BIN` from the caller), a command built at run time (a name from parts,
// `eval "$x"` of a variable, `"$@"` handed claude by a caller), a script fetched at run time, and languages other than
// shell and JavaScript; a non-launcher word as an option's value (`sudo -u test claude …`, `docker run --name test
// img claude …`) still makes the call data (R1264f D5 f05); a command string handed to a shell on stdin
// (`echo 'claude -p hi' | bash`, `bash <<<'claude -p hi'`, R1264f D5 f06). src/'s own launches are held by the AST
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
const ENDS_CLAUDE = /(?:^|[^A-Za-z0-9._-]|:[-=])claude(?:\.exe|\.cmd)?[}"')\]]*$|@anthropic-ai\/claude-code|claude-code\/cli\.js/;
const isClaudeToken = (u: string) => CLAUDE_WORD.test(u) && ENDS_CLAUDE.test(u);
/** A variable's value that is the binary (R1264d D4): its first token is, or a default or lookup of it is anywhere. */
const VALUE_CLAUDE = (v: string) => isClaudeToken(v.split(/\s+/)[0] ?? '') || /\$\{\w+:[-=](?:[^}\s]*\/)?claude\}|\$\((?:command -v|which|type -P) claude\)/.test(v);
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
    'd845afd69f37a4f814608e00544bb64b8de2cead08246a01a305da190f2ef447',
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
    'scripts/setup/lib.sh',
    'out="$( (cd "$dir" && sudo -H -u "$1" timeout 120 env CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 ${2:+"CLAUDE_CONFIG_DIR=$2"} claude "${CLAUDE_PROOF_ARGS[@]}" --settings "$settings" --setting-sources \'\' --strict-mcp-config 2>&1) || true)"',
    "the login proof's API-key call (R1264e/f D2): its --settings value is the one apiKeyHelper key, built by a JSON encoder from the key path, which claude_api_check checks again (^/[A-Za-z0-9._/-]+$, no //, /./ or /../) before the call; the guards end it",
    'e831cb1074e3c62624836d790afd6e252b8fc41a468865dd9b9d64e8243a0747',
  ],
];

/**
 * Unguarded calls pinned by file and the exact text of the physical line that holds them (trimmed), with why:
 * scripts/ci/claude-launch-shell-pins.json (data, so no test names a spike: #673). A pin covers one line: a copy of it
 * elsewhere in the file, or in any other file, is refused.
 */
export const SHELL_PINS = (JSON.parse(readFileSync(join(repoRoot, 'scripts', 'ci', 'claude-launch-shell-pins.json'), 'utf8')) as { pins: Pin[] }).pins;

type Word = { text: string; quoted: boolean };
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

/**
 * Whether an argv (its words, unquoted) ends with exactly the launch's guards: `--settings <x>`, `--setting-sources
 * ''` and `--strict-mcp-config`, in any order among themselves, each the only one of its flag in the argv, and no
 * `--mcp-config` anywhere: so no later flag, and no earlier one a reader might take for the one that counts. Nor,
 * anywhere in the call, a flag that loads more than the guards hold back (R1264f D1): `--plugin-dir`, `--plugin-url`
 * (a plugin's hooks and skills), `--agents` (agents) or `--add-dir` (its CLAUDE.md, with the env switch); a pin aside.
 */
// check-table: never-shrink
const LOADING_FLAGS = ['--mcp-config', '--plugin-dir', '--plugin-url', '--agents', '--add-dir'];
export function guardsLast(argv: string[]): boolean {
  const tail = argv.slice(-5);
  const si = tail.indexOf('--settings');
  // Its value: `{}`, or the one setting an API-key login needs (R1264d D5: a settings file's hooks run; R1264c D3).
  if (si < 0 || !SETTINGS_VALUE.test((tail[si + 1] ?? '').replace(/\\"/g, '"'))) return false;
  const ss = tail.indexOf('--setting-sources');
  const sm = tail.indexOf('--strict-mcp-config');
  const once = (f: string) => argv.filter((a) => a === f || a.startsWith(`${f}=`)).length === 1;
  return (
    tail.length === 5 && si >= 0 && si < 4 && ss >= 0 && ss < 4 && tail[ss + 1] === '' && sm >= 0 && new Set([si, si + 1, ss, ss + 1, sm]).size === 5 &&
    once('--settings') && once('--setting-sources') && once('--strict-mcp-config') && !argv.some((a) => LOADING_FLAGS.some((f) => a === f || a.startsWith(`${f}=`)))
  );
}

/**
 * The only `--settings` values a script's call may give (R1264d D5): none at all (`{}`), or an API-key login's
 * apiKeyHelper as the engine writes it (`cat -- <plain absolute path>`), written out: no variable anywhere in it
 * (R1264e D2, R1264f D2: a variable's value can close the JSON string and add hooks). lib.sh's own call, whose path is
 * known only at run time, builds its value with a JSON encoder after re-checking the path, and is an exception.
 */
const SETTINGS_VALUE = /^\{\s*\}$|^\{\s*"apiKeyHelper"\s*:\s*"cat -- \/[A-Za-z0-9._\/-]+"\s*\}$/;

/** Joins continued lines and drops comments (a `#` at a word's start outside quotes) and blank lines. */
function logicalLines(text: string): { line: number; end: number; text: string }[] {
  const out: { line: number; end: number; text: string }[] = [];
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
    if (t) out.push({ line: start + 1, end: i + 1, text: t });
  }
  return out;
}

/** Where the `)` closing a `$(` that opens at `from` (just past its `(`) is: quotes and nested parens skipped. */
function closeParen(t: string, from: number): number {
  let depth = 1;
  let q: string | null = null;
  for (let k = from; k < t.length; k++) {
    const c = t[k]!;
    if (q) {
      if (c === q && t[k - 1] !== '\\') q = null;
    } else if (c === "'" || c === '"') q = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return k;
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
  let q: string | null = null;
  let braces = 0;
  for (let k = 0; k < t.length; k++) {
    const c = t[k]!;
    const two = t.slice(k, k + 2);
    if (q === "'") {
      cur += c;
      if (c === "'") q = null;
      continue;
    }
    if (two === '$(') {
      const end = closeParen(t, k + 2);
      out.push(...commands(t.slice(k + 2, end)));
      cur += 'X';
      k = end;
      continue;
    }
    if (c === '`') {
      let end = k + 1;
      while (end < t.length && !(t[end] === '`' && t[end - 1] !== '\\')) end++;
      out.push(...commands(t.slice(k + 1, end)));
      cur += 'X';
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
    } else if (!braces && ';|(){}'.includes(c)) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** A command's words, quotes kept together; `${x:+…}` stays one word. `quoted`: the whole word is one quoted string. */
function wordsOf(cmd: string): Word[] {
  const raw = cmd.match(/(?:\$\{[^}]*\}|'[^']*'|"(?:[^"\\]|\\.)*"|[^\s'"$]|\$(?!\{))+/g) ?? [];
  return raw.map((w) => ({ text: w, quoted: /^(['"]).*\1$/s.test(w) }));
}
const unquote = (w: string) => w.replace(/^(['"])(.*)\1$/s, '$2');

/** Where the `}` closing a `{` that opens just before `from` is: quotes, `${…}` and comments read. */
function closeBrace(t: string, from: number): number {
  let depth = 1;
  let q: string | null = null;
  for (let k = from; k < t.length; k++) {
    const c = t[k]!;
    if (q) {
      if (c === q && (q === "'" || t[k - 1] !== '\\')) q = null;
    } else if (c === "'" || c === '"') q = c;
    else if (c === '#' && (k === 0 || /\s/.test(t[k - 1]!))) k = t.indexOf('\n', k) < 0 ? t.length : t.indexOf('\n', k) - 1;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return k;
  }
  return t.length;
}

/**
 * The text a pin's digest holds (R1264e D1, R1264f D4): the innermost shell function around physical line `line` of
 * `text` (`name() {…}`, `function name {…}`), or all of `text` when the call is top-level (a spike, a workflow step).
 */
export function pinScope(text: string, line: number): string {
  const at = text.split('\n').slice(0, line - 1).reduce((a, l) => a + l.length + 1, 0);
  let best: [number, number] | null = null;
  for (const m of text.matchAll(/(^|\n)[ \t]*(?:function[ \t]+[A-Za-z_][\w-]*(?:[ \t]*\([ \t]*\))?|[A-Za-z_][\w-]*[ \t]*\([ \t]*\))[ \t]*\{/g)) {
    const start = m.index! + m[1]!.length;
    const end = closeBrace(text, m.index! + m[0].length) + 1;
    if (start <= at && at < end && (!best || start >= best[0])) best = [start, end];
  }
  return best ? text.slice(best[0], best[1]) : text;
}
export const scopeDigest = (text: string, line: number) => createHash('sha256').update(pinScope(text, line)).digest('hex');

/** Each claude call a shell text starts without the guards at its end, as `<path>:<line>: <why>`. */
export function shellLaunchProblems(path: string, text: string, pinned = new Map<Pin, number>()): string[] {
  const lines = logicalLines(text);
  // Variables this file sets to claude; arrays' words (with `+=` appends).
  const vars = new Set<string>();
  const arrays = new Map<string, string[]>();
  // R1264f D3: where each array is assigned (`NAME=(…)`; a `+=` extends it), and the arrays changed any other way (by
  // index, mapfile/readarray/read -a, unset). An array assigned more than once, changed so, or only after the call
  // can't be read from this file, so a call that expands it is refused.
  const assignedAt = new Map<string, number[]>();
  const changed = new Set<string>();
  for (const { line, text: t } of lines) {
    for (const m of t.matchAll(/(?:^|[\s;&|(])([A-Za-z_]\w*)\[[^\]]*\]\+?=/g)) changed.add(m[1]!);
    for (const m of t.matchAll(/\b(?:mapfile|readarray)\b[^;&|]*?\s([A-Za-z_]\w*)\s*(?:[;&|<]|$)/g)) changed.add(m[1]!);
    for (const m of t.matchAll(/\bread\b(?:\s+-\w+)*\s+-\w*a\w*\s+([A-Za-z_]\w*)/g)) changed.add(m[1]!);
    for (const m of t.matchAll(/\bunset\b((?:\s+(?:-\w+|['"]?[A-Za-z_]\w*(?:\[[^\]]*\])?['"]?))+)/g)) for (const n of m[1]!.matchAll(/([A-Za-z_]\w*)/g)) changed.add(n[1]!);
    for (const part of t.split(/;\s*/)) {
      const v = /^(?:(?:export|local|readonly|declare|typeset)(?:\s+-\w+)*\s+)?([A-Za-z_]\w*)(\+?)=(.*)$/.exec(part.trim());
      if (!v) continue;
      const val = v[3]!.trim();
      if (val.startsWith('(')) {
        const inner = val.replace(/^\(|\)\s*$/g, '');
        arrays.set(v[1]!, [...(v[2] ? (arrays.get(v[1]!) ?? []) : []), ...wordsOf(inner).map((w) => w.text)]);
        if (!v[2]) assignedAt.set(v[1]!, [...(assignedAt.get(v[1]!) ?? []), line]);
      } else {
        // Fail closed (R1264d D4): a variable whose value names the binary anywhere is the binary.
        if (VALUE_CLAUDE(unquote(val))) vars.add(v[1]!);
      }
    }
  }
  const isClaude = (w: Word) => {
    const u = unquote(w.text);
    const m = /^\$\{?([A-Za-z_]\w*)(?:[:-][^}]*)?\}?$/.exec(u);
    if (m && vars.has(m[1]!)) return true;
    return BINARY.test(u) || isClaudeToken(u);
  };
  const out: string[] = [];
  // The physical lines of the logical line being judged, and the lines each pin has covered so far.
  const raw = text.split('\n');
  let phys: number[] = [];
  const judge = (line: number, cmd: string) => {
    const words = wordsOf(cmd);
    // Strings run as commands: after `-c` (`bash -c`, `bash -lc`, `su -c`) or `eval`, recursively.
    words.forEach((w, i) => {
      const prev = words[i - 1]?.text;
      if (w.quoted && prev && (/^-[a-z]*c$/.test(prev) || prev === 'eval')) scan(line, unquote(w.text));
    });
    let k = 0;
    while (k < words.length && (/^[A-Za-z_]\w*\+?=/.test(words[k]!.text) || KEYWORDS.has(words[k]!.text))) k++;
    if (k >= words.length) return;
    // A known non-launcher anywhere before a claude word (`sudo rm -f …/claude`, `[ "$c" != …/claude ]`) makes it
    // data; `command` is one only as `command -v`/`-V`.
    const dataFrom = (i: number) => words.slice(k, i).some((w, j, a) => !w.quoted && (NON_LAUNCHERS.has(w.text) ? w.text !== 'command' || /^-[vV]$/.test(a[j + 1]?.text ?? '') : false));
    for (let i = k; i < words.length; i++) {
      if (!isClaude(words[i]!) || dataFrom(i)) continue;
      // Its argument words: arrays expanded, trailing redirections and `&` dropped.
      const args: string[] = [];
      for (const w of words.slice(i + 1)) {
        const a = /^"?\$\{([A-Za-z_]\w*)\[@\]\}"?$/.exec(w.text);
        if (a && arrays.has(a[1]!)) {
          const at = assignedAt.get(a[1]!) ?? [];
          if (at.length !== 1 || changed.has(a[1]!) || at[0]! > line) {
            out.push(`${path}:${line}: starts claude with the array ${a[1]} (\`${cmd.slice(0, 100)}\`), which this file assigns ${at.length === 1 ? (changed.has(a[1]!) ? 'and then changes' : 'only after the call') : `${at.length} times`}: its words can't be read here; assign it once, before the call (R1264f D3)`);
            return;
          }
          args.push(...arrays.get(a[1]!)!);
        } else args.push(w.text);
      }
      for (;;) {
        if (args.length && /^(?:\d*[<>]+&?\S+|&|\\;|;|\+)$/.test(args.at(-1)!)) args.pop();
        else if (args.length >= 2 && /^\d*[<>]{1,2}&?$/.test(args.at(-2)!)) args.splice(-2);
        else break;
      }
      const plain = args.map(unquote);
      const joined = plain.join(' ');
      if (EXEMPT_ARGV.test(joined)) return;
      const guarded = guardsLast(plain);
      // A pin (the spike's, or an exception) covers exactly one call (R1264c D2, R1264d D1): a second call on its
      // line, on the lines continued into it, or a copy of the line anywhere in the file, is refused. And only while
      // its scope (the function around it, or the whole script) is the one pinned, by digest (R1264e D1, R1264f D4):
      // no edit to a line it is continued from, a wrapper, or a variable it expands moves or widens it unseen.
      const onLine = guarded ? [] : [...SHELL_PINS, ...SHELL_EXCEPTIONS].flatMap((p) => (p[0] === path ? phys.filter((n) => raw[n - 1]?.trim() === p[1]).map((n) => [p, n] as const) : []));
      const pin = onLine.find(([p, n]) => scopeDigest(text, n) === p[3])?.[0];
      if (!pin && onLine.length) {
        const [p, n] = onLine[0]!;
        out.push(`${path}:${line}: a pinned line (\`${p[1].slice(0, 80)}\`) whose scope changed: its digest is now ${scopeDigest(text, n)}, the pin holds ${p[3]}; a changed pin is a change to the test`);
        return;
      }
      if (pin) {
        const n = (pinned.get(pin) ?? 0) + 1;
        pinned.set(pin, n);
        if (n > 1) out.push(`${path}:${line}: a second claude call under a pinned line (\`${pin[1].slice(0, 100)}\`): a pin covers one call; end it with the launch's guards`);
        return;
      }
      if (!guarded) out.push(`${path}:${line}: starts claude (\`${cmd.slice(0, 140)}\`) without the launch's guards at its end (--settings <json> --setting-sources '' --strict-mcp-config, nothing after them)`);
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
 * that argv must end with the guards (guardsLast), or start exempt. A string a shell runs (`exec`/`execSync`'s
 * command, or the one after `'-c'`; a template's text with its holes as words) is read as shell. Any other literal
 * claude is refused unless its line is pinned (JS_NAMES): what it starts can't be read here.
 */
export function jsLaunchProblems(path: string, text: string): string[] {
  const out: string[] = [];
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
        if (argv === null) out.push(`${path}:${at}: names the claude binary (${n.getText(sf)}) where its argv can't be read: start it with a literal argv ending with the guards, or pin the line in JS_NAMES`);
        else if (!EXEMPT_ARGV.test(argv.join(' ')) && !guardsLast(argv)) out.push(`${path}:${at}: starts claude (${p.getText(sf).replace(/\s+/g, ' ').slice(0, 140)}) without the launch's guards at its end`);
      } else if (!BINARY.test(s)) {
        // A string a shell runs: exec/execSync's command, or the string after '-c'.
        const callee = ts.isCallExpression(p) ? p.expression.getText(sf) : '';
        const afterC = ts.isArrayLiteralExpression(p) && textOf(p.elements[p.elements.indexOf(n) - 1] ?? n) === '-c' && p.elements.indexOf(n) > 0;
        if ((/(?:^|\.)exec(?:Sync)?$/.test(callee) && p.arguments[0] === n) || afterC) out.push(...shellLaunchProblems(path, s).map((x) => x.replace(/^[^:]+:\d+:/, `${path}:${at}:`)));
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

test("#1262: every claude a script starts ends with the launch's guards, or is a pinned exception", () => {
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

test('#1262 (R1264e D1, R1264f D4): a pin holds its scope by digest: an edit to its function (or its top-level script) breaks it', () => {
  for (const { pin, text, line } of pinSites()) {
    assert.equal(scopeDigest(text, line), pin[3], `${pin[0]}: the pin's digest is its scope's: ${pin[1].slice(0, 60)}`);
    const scope = pinScope(text, line);
    if (!scope.includes('\n')) continue; // a one-line function: its only line is the pinned one, held by its text
    // A line added inside the scope (after its first line), as a wrapper or an assignment edit would be.
    const at = text.indexOf(scope) + scope.indexOf('\n') + 1;
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
  assert.equal(createHash('sha256').update(JSON.stringify(SHELL_PINS)).digest('hex'), '765a9f8f663c830f2d158af30fb489e86125a2055f22a9c7792758f5b5eb0f66');
  assert.deepEqual(SHELL_PINS.map(([f, , why]) => [f.split('/').at(-1), why]), [['worktree-commit.sh', 'a sandbox probe whose project-settings load is the point (the owner, 2026-11-11, "spikes: b")']]);
});

test('#1262: every way a script can start claude without the guards at its end is refused (fixtures), and the controls pass', () => {
  const dir = join(repoRoot, 'test', 'fixtures', 'claude-launch-shell');
  const all = readdirSync(dir).sort();
  const nameOf = (f: string) => f.replace(/\.(?:sh|yml|mjs|mk|json|docker)\.txt$/, '');
  // Every fixture by name: one deleted fails here.
  // check-table: never-shrink
  const MUST_FAIL = [
    'after-and',
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
  const CONTROLS = ['ok-api-key-helper', 'ok-auth-status', 'ok-case-label', 'ok-comment', 'ok-continued-guards', 'ok-for-list', 'ok-grep-regex', 'ok-guarded', 'ok-guarded-array', 'ok-install-path', 'ok-js-auth-status', 'ok-js-guarded', 'ok-other-tool', 'ok-prose', 'ok-spike-pin', 'ok-version', 'ok-workflow-block-guarded'];
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
