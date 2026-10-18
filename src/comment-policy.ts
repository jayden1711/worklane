// The comment policy (#330): a comment added or changed in a diff must start with WHY: or INVARIANT:, or cite an
// issue or decision id; narration is refused even when tagged; at most `max_lines` lines of text. One rule
// function, checkComments, for the PR diff check (checkRange, scripts/check-comments.mjs) and the agents' post-edit
// hook (checkWorkingFile, wired in #330's second part), so the two can't drift. Comments are found by a line
// scanner per language (no parser dependency).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import type { z } from 'zod';
import { BRAND } from './brand.js';
import { CommentPolicyConfig } from './config/schema.js';

export type CommentPolicy = z.infer<typeof CommentPolicyConfig>;

export interface CommentFinding {
  file: string;
  /** The block's first line, 1-based. */
  line: number;
  reasons: string[];
  /** The block's first line of text, for the report. */
  text: string;
}

type Lang = 'c' | 'sh' | 'yaml';

/** One comment block: consecutive own-line comments, a block comment, or one trailing comment. */
interface Block {
  start: number;
  /** Source line numbers the block covers, each with its text (comment markers removed). */
  lines: { line: number; text: string }[];
  jsdoc: boolean;
  /** A `/* *\/` comment (where `global a, b` is an ESLint directive). */
  starred: boolean;
}

export function languageOf(file: string): Lang | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(file)?.[1]?.toLowerCase();
  if (!ext) return null;
  if (['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'c';
  if (ext === 'sh' || ext === 'bash') return 'sh';
  if (ext === 'yml' || ext === 'yaml') return 'yaml';
  return null;
}

// ---------- the scanners ----------

/** Text of a `//` comment or one line of a block comment, markers removed. */
const stripLine = (s: string) => s.replace(/^\/{2,}/, '').replace(/^ /, '').trimEnd();

/** Comments in JS/TS: tracks strings, template literals (with nested `${}`) and regex literals so `//` in them is code. */
function scanC(src: string): Block[] {
  const raw: (Omit<Block, 'starred'> & { own: boolean; kind: 'line' | 'block' })[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  let mode: 'code' | 'sq' | 'dq' | 'tpl' = 'code';
  let depth = 0;
  const tplStack: number[] = [];
  const n = src.length;
  const step = (k = 1) => {
    for (let j = 0; j < k && i < n; j++, i++) {
      if (src[i] === '\n') {
        line++;
        lineStart = i + 1;
      }
    }
  };
  const lastCode = () => {
    let j = i - 1;
    while (j >= 0 && /\s/.test(src[j]!)) j--;
    if (j < 0) return '';
    if (/[\w$]/.test(src[j]!)) {
      let k = j;
      while (k > 0 && /[\w$]/.test(src[k - 1]!)) k--;
      return src.slice(k, j + 1);
    }
    return src[j]!;
  };
  const regexAllowed = () => {
    const p = lastCode();
    return p === '' || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(p) || /^(return|typeof|case|in|of|void|delete|throw|new|yield|await|else|do)$/.test(p);
  };
  while (i < n) {
    const c = src[i]!;
    if (mode === 'sq' || mode === 'dq') {
      if (c === '\\') step(2);
      else if (c === '\n') {
        mode = 'code';
        step();
      } else {
        if (c === (mode === 'sq' ? "'" : '"')) mode = 'code';
        step();
      }
      continue;
    }
    if (mode === 'tpl') {
      if (c === '\\') step(2);
      else if (c === '`') {
        mode = 'code';
        step();
      } else if (c === '$' && src[i + 1] === '{') {
        tplStack.push(depth);
        depth = 0;
        mode = 'code';
        step(2);
      } else step();
      continue;
    }
    if (c === "'" || c === '"') {
      mode = c === "'" ? 'sq' : 'dq';
      step();
    } else if (c === '`') {
      mode = 'tpl';
      step();
    } else if (c === '{') {
      depth++;
      step();
    } else if (c === '}') {
      if (depth === 0 && tplStack.length) {
        depth = tplStack.pop()!;
        mode = 'tpl';
      } else depth--;
      step();
    } else if (c === '/' && src[i + 1] === '/') {
      const own = src.slice(lineStart, i).trim() === '';
      const end = src.indexOf('\n', i);
      const text = src.slice(i, end < 0 ? n : end);
      raw.push({ kind: 'line', own, start: line, lines: [{ line, text: stripLine(text) }], jsdoc: false });
      step(text.length);
    } else if (c === '/' && src[i + 1] === '*') {
      const own = src.slice(lineStart, i).trim() === '';
      const close = src.indexOf('*/', i + 2);
      const body = src.slice(i, close < 0 ? n : close + 2);
      const parts = body.split('\n');
      const lines = parts.map((p, k) => {
        let t = p;
        if (k === 0) t = t.replace(/^\/\*+/, '');
        if (k === parts.length - 1) t = t.replace(/\*+\/$/, '');
        if (k > 0) t = t.replace(/^\s*\*?/, '');
        return { line: line + k, text: t.trim() };
      });
      raw.push({ kind: 'block', own, start: line, lines, jsdoc: /^\/\*\*(?!\/)/.test(body) });
      step(body.length);
    } else if (c === '/' && regexAllowed()) {
      step();
      let inClass = false;
      while (i < n && src[i] !== '\n') {
        const r = src[i];
        if (r === '\\') {
          step(2);
          continue;
        }
        if (r === '/' && !inClass) break;
        if (r === '[') inClass = true;
        if (r === ']') inClass = false;
        step();
      }
      step();
    } else step();
  }
  // Consecutive own-line `//` comments are one block.
  const out: Block[] = [];
  let prev: (typeof raw)[number] | null = null;
  for (const r of raw) {
    const last = out[out.length - 1];
    if (prev && last && r.kind === 'line' && r.own && prev.kind === 'line' && prev.own && r.start === last.lines[last.lines.length - 1]!.line + 1) {
      last.lines.push(...r.lines);
    } else out.push({ start: r.start, lines: [...r.lines], jsdoc: r.jsdoc, starred: r.kind === 'block' });
    prev = r;
  }
  return out;
}

/** WHY: bash's heredoc delimiter is the whole shell word after `<<`, quotes removed (#634: `<<END-X`, `<<EOF.txt`). */
function heredocWord(text: string, from: number): { word: string; end: number } | null {
  let j = from;
  while (text[j] === ' ' || text[j] === '\t') j++;
  let word = '';
  for (; j < text.length && !/[\s;&|<>()]/.test(text[j]!); j++) {
    const c = text[j]!;
    if (c === '\\') word += text[++j] ?? '';
    else if (c === "'" || c === '"') {
      const close = text.indexOf(c, j + 1);
      if (close < 0) return null;
      word += text.slice(j + 1, close);
      j = close;
    } else word += c;
  }
  return word ? { word, end: j } : null;
}

/** WHY: nesting counts (#634: `$(( $((a)) << b ))`): the index past the bracket closing the one at `from`, else -1. */
function closing(text: string, from: number, open: string, close: string): number {
  let depth = 0;
  for (let j = from; j < text.length; j++) {
    if (text[j] === open) depth++;
    else if (text[j] === close && --depth === 0) return j + 1;
  }
  return -1;
}

/**
 * INVARIANT: an opener whose `line:column` key is in `ignored` is read as plain code (scanShLines' rescan, #634).
 * A `#` comment scanner for shell, fed line by line (quotes and heredocs carry across lines).
 */
function shScanner(ignored: ReadonlySet<string>) {
  let quote: { kind: "'" | '"' | "$'"; key: string } | null = null;
  // INVARIANT: heredocs open on one line are read in order, each body until its own word (#628: `<<A <<B`).
  const heredocs: { word: string; tabs: boolean; key: string }[] = [];
  const next = (raw: string, line: number): string | null => {
    // WHY: a CRLF file's terminator is `EOF\r`; without this the heredoc never ends (#628).
    const text = raw.replace(/\r$/, '');
    const open = heredocs[0];
    if (open) {
      if ((open.tabs ? text.replace(/^\t+/, '') : text) === open.word) heredocs.shift();
      return null;
    }
    for (let j = 0; j < text.length; j++) {
      const c = text[j]!;
      const key = `${line}:${j}`;
      if (quote) {
        // WHY: `\'` is an escaped quote inside bash's $'…' but not inside '…' (#634).
        if (c === '\\' && quote.kind !== "'") j++;
        else if (c === quote.kind.slice(-1)) quote = null;
      } else if (c === '\\') j++;
      else if (c === '$' && text[j + 1] === "'" && !ignored.has(key)) {
        quote = { kind: "$'", key };
        j++;
      } else if ((c === "'" || c === '"') && !ignored.has(key)) quote = { kind: c, key };
      else if (c === '#' && (j === 0 || /\s/.test(text[j - 1]!))) return text.slice(j);
      else if ((c === '(' && text[j + 1] === '(') || (c === '$' && text[j + 1] === '{')) {
        // WHY: `<<` inside (( )), $(( )) or ${…} is a shift or text, never a heredoc (#618, #634).
        const end = c === '$' ? closing(text, j + 1, '{', '}') : closing(text, j, '(', ')');
        if (end > 0) j = end - 1;
      } else if (c === '<' && text[j + 1] === '<') {
        // WHY: only an unquoted `<<` starts a heredoc (#628); `<<<` is a here-string.
        if (text[j + 2] === '<') {
          j += 2;
          continue;
        }
        const tabs = text[j + 2] === '-';
        const h = ignored.has(key) ? null : heredocWord(text, j + (tabs ? 3 : 2));
        if (h) {
          heredocs.push({ word: h.word, tabs, key });
          j = h.end - 1;
        } else j++;
      }
    }
    return null;
  };
  /** WHY: what the rescan must ignore (#634): the quote, or the heredoc whose word never came, still open at the end. */
  const unclosed = () => quote?.key ?? heredocs[0]?.key ?? null;
  return { next, unclosed };
}

type Found = { line: number; text: string; own: boolean };

/**
 * INVARIANT: fails closed (#634): when a quote or heredoc never closes, the scan is redone with that opener read as
 * code, so a misread construct can't leave the rest of the script unchecked.
 */
function scanShLines(lines: { line: number; text: string }[]): Found[] {
  const ignored = new Set<string>();
  for (;;) {
    const sh = shScanner(ignored);
    const found: Found[] = [];
    for (const l of lines) {
      const c = sh.next(l.text, l.line);
      if (c !== null) found.push({ line: l.line, text: c, own: l.text.trim() === c.trim() });
    }
    const open = sh.unclosed();
    if (open === null || ignored.has(open) || ignored.size >= 100) return found;
    ignored.add(open);
  }
}

const stripHash = (s: string) => s.replace(/^#+/, '').replace(/^ /, '').trimEnd();

/** Group `#` comments: consecutive own-line ones form one block; a trailing one is a block of its own. */
function hashBlocks(found: { line: number; text: string; own: boolean }[]): Block[] {
  const out: Block[] = [];
  let lastOwn = false;
  for (const f of found) {
    const last = out[out.length - 1];
    if (last && f.own && lastOwn && f.line === last.lines[last.lines.length - 1]!.line + 1) last.lines.push({ line: f.line, text: stripHash(f.text) });
    else out.push({ start: f.line, lines: [{ line: f.line, text: stripHash(f.text) }], jsdoc: false, starred: false });
    lastOwn = f.own;
  }
  return out;
}

function scanSh(src: string): Block[] {
  const lines = src.split(/\r?\n/).map((text, k) => ({ line: k + 1, text }));
  return hashBlocks(scanShLines(lines[0]?.text.startsWith('#!') ? lines.slice(1) : lines));
}

/** YAML `#` comments; a `run:` block scalar is scanned as shell (a workflow's script), any other block scalar is text. */
function scanYaml(src: string): Block[] {
  const found: Found[] = [];
  let scalar: { indent: number; body: number | null; script: { line: number; text: string }[] | null } | null = null;
  const endScalar = () => {
    if (scalar?.script) found.push(...scanShLines(scalar.script));
    scalar = null;
  };
  src.split(/\r?\n/).forEach((text, k) => {
    const indent = text.length - text.trimStart().length;
    if (scalar && (text.trim() === '' || indent > scalar.indent)) {
      // WHY: the script is the block without its YAML indent; a heredoc's closing word is matched at column 0.
      if (text.trim() !== '') scalar.body ??= indent;
      scalar.script?.push({ line: k + 1, text: text.slice(Math.min(scalar.body ?? 0, indent)) });
      return;
    }
    endScalar();
    let quote: "'" | '"' | null = null;
    let at = -1;
    for (let j = 0; j < text.length; j++) {
      const c = text[j]!;
      if (quote === "'") {
        if (c === "'") quote = null;
      } else if (quote === '"') {
        if (c === '\\') j++;
        else if (c === '"') quote = null;
      } else if ((c === "'" || c === '"') && (j === 0 || /[\s[{,:]/.test(text[j - 1]!))) quote = c;
      else if (c === '#' && (j === 0 || /\s/.test(text[j - 1]!))) {
        at = j;
        break;
      }
    }
    const code = at < 0 ? text : text.slice(0, at);
    if (at >= 0) found.push({ line: k + 1, text: text.slice(at), own: code.trim() === '' });
    const m = /^(\s*(?:-\s+)?)(?:([^\s#'"][^#]*?)\s*:\s+)?[|>][1-9]?[+-]?[1-9]?\s*$/.exec(code);
    if (m && (m[2] !== undefined || /-\s+$/.test(m[1]!))) scalar = { indent: m[2] !== undefined ? m[1]!.length : indent, body: null, script: m[2] === 'run' ? [] : null };
  });
  endScalar();
  return hashBlocks(found.sort((a, b) => a.line - b.line));
}

/** Every comment block in a file, or [] for a language the policy doesn't know. */
export function commentBlocks(file: string, src: string): Block[] {
  const lang = languageOf(file);
  if (lang === 'c') return scanC(src);
  if (lang === 'sh') return scanSh(src);
  if (lang === 'yaml') return scanYaml(src);
  return [];
}

// ---------- the rule ----------

/** Tool directives, not prose: a lint or type-check switch, a license id, a bundler hint, a pinned action's version. */
const DIRECTIVE = new RegExp(
  [
    /^@ts-(expect-error|ignore|nocheck|check)\b/,
    /^eslint-(disable|enable)(-next-line|-line)?(\s|$)/,
    /^eslint [\w@/-]+\s*:\s*(off|warn|error|[012]|\[)/,
    /^eslint-env [\w-]+(\s*,\s*[\w-]+)*\s*$/,
    /^(prettier-ignore|biome-ignore|@vite-ignore|[#@]__PURE__)\b/,
    /^(istanbul|c8|v8) ignore\b/,
    /^shellcheck (disable|enable|source|shell|external-sources)=/,
    /^<reference \w+=/,
    /^#(end)?region\b/,
    /^(SPDX-License-Identifier|yaml-language-server):/,
    /^jshint \w+:/,
    /^v?\d+(\.\d+)+$/,
  ]
    .map((r) => r.source)
    .join('|'),
);
/** ESLint's `/* global a, b: readonly *\/`: only in a block comment, and only a list of names. */
const GLOBALS = /^globals? [\w$]+(\s*:\s*\w+)?(\s*,\s*[\w$]+(\s*:\s*\w+)?)*,?$/;
const TAG = /^(WHY|INVARIANT):/;
/** An issue (#123, .../issues/123, .../pull/123), a decision (D-12) or a design-doc section (docs/design.md §4). */
const CITES = /(?<![\w&/])#\d+\b|\/(?:issues|pull)\/\d+\b|\bD-\d+\b|[\w./-]+\.md\s*§\s*\d/;
const JSDOC_API = /^@(param|returns?)\b/;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function narrationIn(text: string, words: string[]): string | null {
  for (const w of words) {
    const m = new RegExp(`(?<![\\w.-])${escape(w).replace(/\s+/g, '\\s+')}(?![\\w-])`, 'i').exec(text);
    if (m) return m[0];
  }
  return null;
}

/**
 * The verdict on one file: each comment block with a prose line in `added` (1-based line numbers of `src` the
 * change added) that breaks the policy. A block no added line touches is never judged. In a block that mixes old
 * and new lines, the new lines are judged: the tag may be the block's or theirs, narration is looked for in them
 * only, and they may not exceed max_lines nor push a block that fit over it. A JSDoc block of only
 * @param/@returns lines is API documentation and exempt (the issue's proposed default).
 */
export function checkComments(file: string, src: string, added: ReadonlySet<number>, policy: CommentPolicy): CommentFinding[] {
  const out: CommentFinding[] = [];
  for (const b of commentBlocks(file, src)) {
    const prose = b.lines.filter((l) => l.text !== '' && !DIRECTIVE.test(l.text) && !(b.starred && GLOBALS.test(l.text)));
    const fresh = prose.filter((l) => added.has(l.line));
    if (!fresh.length) continue;
    if (b.jsdoc && prose.every((l) => JSDOC_API.test(l.text))) continue;
    const reasons: string[] = [];
    if (!TAG.test(prose[0]!.text) && !TAG.test(fresh[0]!.text) && !prose.some((l) => CITES.test(l.text))) reasons.push('no WHY:, INVARIANT: or issue/decision id');
    const word = narrationIn(fresh.map((l) => l.text).join('\n'), policy.narration);
    if (word) reasons.push(`narration ("${word}")`);
    const old = prose.length - fresh.length;
    if (fresh.length > policy.max_lines) reasons.push(`${fresh.length} lines (at most ${policy.max_lines})`);
    else if (prose.length > policy.max_lines && old <= policy.max_lines) reasons.push(`${prose.length} lines with the new ones (at most ${policy.max_lines})`);
    if (reasons.length) out.push({ file, line: fresh[0]!.line, reasons, text: fresh[0]!.text });
  }
  return out;
}

/** One finding per line, `file:line: reasons` then the comment's first line: the same text from CI and the hook. */
export function formatFindings(findings: CommentFinding[]): string {
  return findings.map((f) => `${f.file}:${f.line}: ${f.reasons.join('; ')}\n    ${f.text.length > 120 ? `${f.text.slice(0, 120)}…` : f.text}`).join('\n');
}

// ---------- the diff: which lines were added ----------

/** Added line numbers per file (new-side paths) from `git diff -U0` output. */
export function addedLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let cur: Set<number> | null = null;
  let next = 0;
  let header = false;
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git ')) {
      header = true;
      cur = null;
      continue;
    }
    // INVARIANT: a `+++ ` line is a path only in a file's header; in a hunk it is an added line starting "++ ".
    if (header && l.startsWith('+++ ')) {
      const p = l.slice(4).replace(/^"(.*)"$/, '$1');
      cur = p === '/dev/null' ? null : new Set();
      if (cur) out.set(p.replace(/^b\//, ''), cur);
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) header = false;
    if (h) next = Number(h[1]);
    else if (cur && l.startsWith('+')) cur.add(next++);
    else if (cur && l.startsWith(' ')) next++;
  }
  return out;
}

// INVARIANT: no command a checkout's or user's git config names runs here (#330): fsmonitor off, no textconv or external diff.
const git = (cwd: string, args: string[], timeoutMs?: number) =>
  spawnSync('git', ['-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...(timeoutMs ? { timeout: timeoutMs } : {}) });
// INVARIANT: the hook and CI read the same new lines whatever the user's git config (prefixes, algorithm, context).
const DIFF = [
  ...['-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.interHunkContext=0', '-c', 'diff.suppressBlankEmpty=false'],
  ...['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--relative', '--find-renames', '-U0', '--src-prefix=a/', '--dst-prefix=b/'],
  ...['--diff-algorithm=myers', '--indent-heuristic'],
  // WHY: a `binary` or `-diff` attribute would print "Binary files differ" and judge nothing, in CI too (#634).
  '--text',
];
/**
 * WHY: one deadline for all the hook's git calls (#628), so with post_edit's 20 s it stays inside the hook's 30 s;
 * past it the hook says "could not check" instead of losing both reports.
 */
export const WORKING_CHECK_BUDGET_MS = 8000;

function gitOut(cwd: string, args: string[], timeoutMs?: number): string {
  const r = git(cwd, args, timeoutMs);
  if (r.error) throw r.error;
  if (r.signal) throw new Error(`git ${args.join(' ')}: stopped (${r.signal})`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr ?? '').trim().split('\n')[0]}`);
  return r.stdout;
}

/**
 * The PR check: every file `head` added or changed since its merge base with `base` (so commits `base` gained
 * meanwhile are not counted as the change's), judged on the lines it added, read at `head`.
 */
export function checkRange(root: string, base: string, head: string, policy: CommentPolicy): CommentFinding[] {
  const out: CommentFinding[] = [];
  for (const [file, added] of addedLines(gitOut(root, [...DIFF, '--diff-filter=ACMR', `${base}...${head}`]))) {
    if (!added.size || !languageOf(file)) continue;
    out.push(...checkComments(file, gitOut(root, ['show', `${head}:./${file}`]), added, policy));
  }
  return out;
}

/** INVARIANT: exit 0 is yes and exit 1 no; anything else (no git, no repo, a refusal, a timeout) throws (#330). */
function gitYes(cwd: string, args: string[], timeoutMs: number): boolean {
  const r = git(cwd, args, timeoutMs);
  if (r.error) throw r.error;
  if (r.status === 0 || r.status === 1) return r.status === 0;
  throw new Error(`git ${args.join(' ')}: ${r.signal ? `stopped (${r.signal})` : (r.stderr ?? '').trim().split('\n')[0]}`);
}

/**
 * INVARIANT: a git that can't answer throws, so old lines are never reported as new (the hook says it couldn't check).
 * The hook's check: one working-tree file against HEAD (an untracked file, or a repo with no commit, is all new).
 */
export function checkWorkingFile(root: string, file: string, policy: CommentPolicy, budgetMs = WORKING_CHECK_BUDGET_MS): CommentFinding[] {
  if (!languageOf(file)) return [];
  const path = join(root, file);
  if (!existsSync(path)) return [];
  const src = readFileSync(path, 'utf8');
  const deadline = performance.now() + budgetMs;
  const left = () => {
    const ms = Math.floor(deadline - performance.now());
    if (ms <= 0) throw new Error(`git took longer than ${budgetMs} ms`);
    return ms;
  };
  // WHY: a clean filter (git-lfs, for one) makes git diff number other lines than the file's (#628); don't guess.
  const attr = gitOut(root, ['check-attr', '-z', 'filter', '--', file], left()).split('\0')[2] ?? '';
  if (attr !== '' && attr !== 'unspecified' && attr !== 'unset') throw new Error(`git filter "${attr}" rewrites ${file}, so its lines can't be compared with HEAD`);
  const hasHead = gitYes(root, ['rev-parse', '-q', '--verify', 'HEAD'], left());
  const tracked = gitYes(root, ['ls-files', '--error-unmatch', '--', file], left());
  const added = tracked && hasHead ? (addedLines(gitOut(root, [...DIFF, 'HEAD', '--', file], left())).get(file) ?? new Set<number>()) : new Set(src.split('\n').map((_, k) => k + 1));
  left();
  return checkComments(file, src, added, policy);
}

/**
 * The policy in the config committed at `rev` (the PR's base, so a PR can't switch it off for itself); null when
 * that commit has no config.yaml. Only `comment_policy` is read, so the rest of the file can't break the check.
 */
export function policyAt(root: string, rev: string): CommentPolicy | null {
  gitOut(root, ['rev-parse', '--verify', `${rev}^{commit}`]);
  const path = `${rev}:./${BRAND.configDir}/config.yaml`;
  if (git(root, ['cat-file', '-e', path]).status !== 0) return null;
  const doc = parseDocument(gitOut(root, ['show', path]));
  if (doc.errors.length) throw new Error(`config.yaml at ${rev}: ${doc.errors[0]!.message.split('\n')[0]}`);
  const raw = doc.toJS() as { comment_policy?: unknown } | null;
  const r = CommentPolicyConfig.safeParse(raw?.comment_policy);
  if (!r.success) throw new Error(`config.yaml at ${rev}: comment_policy: ${r.error.issues.map((e) => `${e.path.join('.')} ${e.message}`).join('; ')}`);
  return r.data;
}

export interface CheckRun {
  /** INVARIANT: 0 is off or every new comment passes, 1 findings, 2 couldn't check: CI's exit code (#330). */
  code: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

/**
 * INVARIANT: the one PR check (#330): the CLI's `check-comments` and scripts/check-comments.mjs both print this, so
 * a managed repo's CI and this repo's give the same words and exit code. The policy is the one committed at `base`.
 */
export function runCommentCheck(root: string, base: string, head = 'HEAD'): CheckRun {
  try {
    const policy = policyAt(root, base);
    if (!policy?.enabled) return { code: 0, stdout: `comment policy: off in the config at ${base} (config.yaml comment_policy.enabled); nothing checked\n`, stderr: '' };
    const findings = checkRange(root, base, head, policy);
    if (!findings.length) return { code: 0, stdout: `comment policy: every comment added in ${base}..${head} passes\n`, stderr: '' };
    const why = `start with WHY: or INVARIANT:, or cite an issue or decision id; no narration; at most ${policy.max_lines} lines`;
    return { code: 1, stdout: '', stderr: `comment policy: ${findings.length} comment(s) added in ${base}..${head} break it (${why}):\n${formatFindings(findings)}\n` };
  } catch (e) {
    return { code: 2, stdout: '', stderr: `comment policy: could not check ${base}..${head}: ${(e as Error).message}\n` };
  }
}
