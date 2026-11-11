// lint-test
// #1262 (the owner's decision, 2026-11-10): the one-launch rule (#958, test/claude-launch-lint.test.ts) reaches the
// repo's scripts. Every `claude` a script the repo runs starts must END with the launch's guards
// (`--settings <json> --setting-sources '' --strict-mcp-config`: Claude Code takes the last of each, so nothing after
// them may name either, nor `--mcp-config`), or be a pinned exception (file and argv), which starts no session.
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
// shell and JavaScript. src/'s own launches are held by the AST lint, test/claude-launch-lint.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parse } from 'yaml';
import { repoRoot } from './helpers.js';

/** The claude binary as a word: its name, a path to it, its package (with a version), or its cli.js. */
const BINARY = /^(?:\S*\/)?claude$|^@anthropic-ai\/claude-code(?:@\S*)?$|\/claude-code\/cli\.js$/;
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
/** Pinned exceptions: file, then text the command holds, each with why. */
// check-table: never-grow
export const SHELL_EXCEPTIONS: [string, string, string][] = [
  [
    '.github/workflows/ci-slow.yml',
    '-p --output-format stream-json --verbose --max-turns 1 --setting-sources project --strict-mcp-config',
    "a CI probe of Claude Code's own MCP policy (managed allowedMcpServers): the real CLI in a throwaway HOME with a stand-in key, its project source on purpose; no session gets past its init event",
  ],
  ['.github/workflows/ci-slow.yml', 'scripts/setup/credentials.sh probe claude', "credentials.sh's `probe claude` names the login to check: the script, not claude, runs"],
];

/**
 * Unguarded calls pinned by file and the exact text of the physical line that holds them (trimmed), with why. A pin
 * covers one line: a copy of it elsewhere in the file, or in any other file, is refused.
 */
// check-table: never-grow
export const SHELL_PINS: [string, string, string][] = [
  [
    'scripts/spikes/worktree-commit.sh',
    "claude -p --max-budget-usd \"$SPIKE_CALL_BUDGET\" --settings \"$settings\" --model haiku --max-turns 3 --permission-mode dontAsk --allowedTools Bash --setting-sources project) | tail -6",
    'a sandbox probe whose project-settings load is the point (the owner, 2026-11-11, "spikes: b")',
  ],
];

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
 * `--mcp-config` anywhere: so no later flag, and no earlier one a reader might take for the one that counts.
 */
export function guardsLast(argv: string[]): boolean {
  const tail = argv.slice(-5);
  const si = tail.indexOf('--settings');
  const ss = tail.indexOf('--setting-sources');
  const sm = tail.indexOf('--strict-mcp-config');
  const once = (f: string) => argv.filter((a) => a === f || a.startsWith(`${f}=`)).length === 1;
  return (
    tail.length === 5 && si >= 0 && si < 4 && ss >= 0 && ss < 4 && tail[ss + 1] === '' && sm >= 0 && new Set([si, si + 1, ss, ss + 1, sm]).size === 5 &&
    once('--settings') && once('--setting-sources') && once('--strict-mcp-config') && !argv.some((a) => a === '--mcp-config' || a.startsWith('--mcp-config='))
  );
}

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

/** Each claude call a shell text starts without the guards at its end, as `<path>:<line>: <why>`. */
export function shellLaunchProblems(path: string, text: string): string[] {
  const lines = logicalLines(text);
  // Variables this file sets to claude; arrays' words (with `+=` appends).
  const vars = new Set<string>();
  const arrays = new Map<string, string[]>();
  for (const { text: t } of lines) {
    for (const part of t.split(/;\s*/)) {
      const v = /^(?:export\s+|local\s+|readonly\s+|declare\s+(?:-\w+\s+)?)?([A-Za-z_]\w*)(\+?)=(.*)$/.exec(part.trim());
      if (!v) continue;
      const val = v[3]!.trim();
      if (val.startsWith('(')) {
        const inner = val.replace(/^\(|\)\s*$/g, '');
        arrays.set(v[1]!, [...(v[2] ? (arrays.get(v[1]!) ?? []) : []), ...wordsOf(inner).map((w) => w.text)]);
      } else {
        const u = unquote(val);
        if (BINARY.test(u) || /^\$\{\w+:-(?:\S*\/)?claude\}$/.test(u) || /^\$\((?:command -v|which|type -P) claude\)$/.test(u)) vars.add(v[1]!);
      }
    }
  }
  const isClaude = (w: Word, first: boolean) => {
    const m = /^\$\{?([A-Za-z_]\w*)\}?$/.exec(unquote(w.text));
    if (m && vars.has(m[1]!)) return true;
    if (w.quoted) return first && BINARY.test(unquote(w.text));
    return BINARY.test(w.text);
  };
  const out: string[] = [];
  // The physical lines of the logical line being judged, and the lines each pin has covered so far.
  const raw = text.split('\n');
  let phys: number[] = [];
  const pinned = new Map<(typeof SHELL_PINS)[number], Set<number>>();
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
      if (!isClaude(words[i]!, i === k) || dataFrom(i)) continue;
      // Its argument words: arrays expanded, trailing redirections and `&` dropped.
      const args: string[] = [];
      for (const w of words.slice(i + 1)) {
        const a = /^"?\$\{([A-Za-z_]\w*)\[@\]\}"?$/.exec(w.text);
        if (a && arrays.has(a[1]!)) args.push(...arrays.get(a[1]!)!);
        else args.push(w.text);
      }
      for (;;) {
        if (args.length && /^(?:\d*[<>]+&?\S+|&|\\;|;|\+)$/.test(args.at(-1)!)) args.pop();
        else if (args.length >= 2 && /^\d*[<>]{1,2}&?$/.test(args.at(-2)!)) args.splice(-2);
        else break;
      }
      const plain = args.map(unquote);
      const joined = plain.join(' ');
      if (EXEMPT_ARGV.test(joined) || SHELL_EXCEPTIONS.some(([f, a]) => f === path && cmd.includes(a))) return;
      const guarded = guardsLast(plain);
      const pin = guarded ? undefined : SHELL_PINS.find(([f, l]) => f === path && phys.some((n) => raw[n - 1]?.trim() === l));
      if (pin) {
        const at = phys.find((n) => raw[n - 1]?.trim() === pin[1])!;
        const seen = pinned.get(pin) ?? new Set<number>();
        seen.add(at);
        pinned.set(pin, seen);
        if (seen.size > 1) out.push(`${path}:${at}: a copy of a pinned line (\`${pin[1].slice(0, 100)}\`): its pin covers one line; end it with the launch's guards`);
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
  for (const s of steps) {
    const where = `${path} (step ${typeof s.name === 'string' ? JSON.stringify(s.name.slice(0, 60)) : '(unnamed)'})`;
    if (typeof s.uses === 'string' && /claude/i.test(s.uses)) out.push(`${where}: uses ${s.uses}, which starts claude with the repo's own settings: not allowed`);
    if (typeof s.run === 'string') out.push(...shellLaunchProblems(path, s.run).map((p) => p.replace(`${path}:`, `${where}:`)));
  }
  return out;
}

/** Makefile recipes, package.json scripts and Dockerfile RUN lines, as shell. */
export function otherLaunchProblems(path: string, text: string): string[] {
  if (/(^|\/)package\.json$/.test(path)) {
    const scripts = (JSON.parse(text) as { scripts?: Record<string, string> }).scripts ?? {};
    return Object.entries(scripts).flatMap(([k, v]) => shellLaunchProblems(`${path} (scripts.${k})`, v));
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
  const problems = [
    ...f.shell.flatMap((p) => shellLaunchProblems(p, read(p))),
    ...f.workflow.flatMap((p) => workflowLaunchProblems(p, read(p))),
    ...f.other.flatMap((p) => otherLaunchProblems(p, read(p))),
    ...f.js.flatMap((p) => jsLaunchProblems(p, read(p))),
  ];
  assert.deepEqual(problems, []);
  // Each pin still names one line that is there, once.
  for (const [p, l] of SHELL_PINS) assert.equal(read(p).split('\n').filter((x) => x.trim() === l).length, 1, `${p}: its pinned line is there once: ${l.slice(0, 80)}`);
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

test('#1262: every way a script can start claude without the guards at its end is refused (fixtures), and the controls pass', () => {
  const dir = join(repoRoot, 'test', 'fixtures', 'claude-launch-shell');
  const all = readdirSync(dir).sort();
  const nameOf = (f: string) => f.replace(/\.(?:sh|yml|mjs|mk|json|docker)\.txt$/, '');
  // Every fixture by name: one deleted fails here.
  // check-table: never-shrink
  const MUST_FAIL = [
    'after-and',
    'array-append',
    'array-unguarded',
    'backticks',
    'bash-lc',
    'command-builtin',
    'command-v-variable',
    'continued-line',
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
  const CONTROLS = ['ok-auth-status', 'ok-case-label', 'ok-comment', 'ok-continued-guards', 'ok-for-list', 'ok-grep-regex', 'ok-guarded', 'ok-guarded-array', 'ok-install-path', 'ok-js-auth-status', 'ok-js-guarded', 'ok-other-tool', 'ok-prose', 'ok-spike-pin', 'ok-version', 'ok-workflow-block-guarded'];
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
                shellLaunchProblems(/^(?:#!.*\n)?# as (\S+)/.exec(text)?.[1] ?? `scripts/${n}.sh`, text);
    if (n.startsWith('ok-')) assert.deepEqual(problems, [], `${n}: a control passes`);
    else assert.ok(problems.length > 0, `${n}: refused`);
  }
});
