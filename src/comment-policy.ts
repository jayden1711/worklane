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
  const raw: (Block & { own: boolean; kind: 'line' | 'block' })[] = [];
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
    } else out.push({ start: r.start, lines: [...r.lines], jsdoc: r.jsdoc });
    prev = r;
  }
  return out;
}

/** A `#` comment scanner for shell, fed line by line (quotes and heredocs carry across lines). */
function shScanner() {
  let quote: "'" | '"' | null = null;
  let heredoc: { word: string; tabs: boolean } | null = null;
  return (text: string): string | null => {
    if (heredoc) {
      if ((heredoc.tabs ? text.replace(/^\t+/, '') : text) === heredoc.word) heredoc = null;
      return null;
    }
    let comment: string | null = null;
    let j = 0;
    for (; j < text.length; j++) {
      const c = text[j]!;
      if (quote === "'") {
        if (c === "'") quote = null;
      } else if (quote === '"') {
        if (c === '\\') j++;
        else if (c === '"') quote = null;
      } else if (c === '\\') j++;
      else if (c === "'" || c === '"') quote = c;
      else if (c === '#' && (j === 0 || /\s/.test(text[j - 1]!))) {
        comment = text.slice(j);
        break;
      }
    }
    const h = quote ? null : /<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/.exec(text.slice(0, comment === null ? text.length : j));
    if (h) heredoc = { word: h[3]!, tabs: h[1] === '-' };
    return comment;
  };
}

const stripHash = (s: string) => s.replace(/^#+/, '').replace(/^ /, '').trimEnd();

/** Group `#` comments: consecutive own-line ones form one block; a trailing one is a block of its own. */
function hashBlocks(found: { line: number; text: string; own: boolean }[]): Block[] {
  const out: Block[] = [];
  let lastOwn = false;
  for (const f of found) {
    const last = out[out.length - 1];
    if (last && f.own && lastOwn && f.line === last.lines[last.lines.length - 1]!.line + 1) last.lines.push({ line: f.line, text: stripHash(f.text) });
    else out.push({ start: f.line, lines: [{ line: f.line, text: stripHash(f.text) }], jsdoc: false });
    lastOwn = f.own;
  }
  return out;
}

function scanSh(src: string): Block[] {
  const next = shScanner();
  const found: { line: number; text: string; own: boolean }[] = [];
  src.split('\n').forEach((text, k) => {
    if (k === 0 && text.startsWith('#!')) return;
    const c = next(text);
    if (c !== null) found.push({ line: k + 1, text: c, own: text.trim() === c.trim() });
  });
  return hashBlocks(found);
}

/** YAML `#` comments; a `run:` block scalar is scanned as shell (a workflow's script), any other block scalar is text. */
function scanYaml(src: string): Block[] {
  const found: { line: number; text: string; own: boolean }[] = [];
  let scalar: { indent: number; sh: ReturnType<typeof shScanner> | null } | null = null;
  src.split('\n').forEach((text, k) => {
    const indent = text.length - text.trimStart().length;
    if (scalar && (text.trim() === '' || indent > scalar.indent)) {
      const c = scalar.sh?.(text) ?? null;
      if (c !== null) found.push({ line: k + 1, text: c, own: text.trim() === c.trim() });
      return;
    }
    scalar = null;
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
    if (m && (m[2] !== undefined || /-\s+$/.test(m[1]!))) scalar = { indent: m[2] !== undefined ? m[1]!.length : indent, sh: m[2] === 'run' ? shScanner() : null };
  });
  return hashBlocks(found);
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
const DIRECTIVE = /^(@ts-|eslint[- ]|prettier-ignore|biome-ignore|istanbul ignore|c8 ignore|v8 ignore|shellcheck |<reference |#?region\b|#?endregion\b|SPDX-License-Identifier:|yaml-language-server:|@vite-ignore|[#@]__PURE__|global |jshint |v?\d+(\.\d+)+$)/;
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
    const prose = b.lines.filter((l) => l.text !== '' && !DIRECTIVE.test(l.text));
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
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) {
      const p = l.slice(4).replace(/^"(.*)"$/, '$1');
      cur = p === '/dev/null' ? null : new Set();
      if (cur) out.set(p.replace(/^b\//, ''), cur);
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) next = Number(h[1]);
    else if (cur && l.startsWith('+')) cur.add(next++);
    else if (cur && l.startsWith(' ')) next++;
  }
  return out;
}

const git = (cwd: string, args: string[]) => spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const DIFF = ['diff', '--no-ext-diff', '--no-color', '--relative', '--find-renames', '-U0'];

function gitOut(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  if (r.error) throw r.error;
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

/** The hook's check: one working-tree file against HEAD (an untracked file, or a repo with no commit, is all new). */
export function checkWorkingFile(root: string, file: string, policy: CommentPolicy): CommentFinding[] {
  if (!languageOf(file)) return [];
  const path = join(root, file);
  if (!existsSync(path)) return [];
  const src = readFileSync(path, 'utf8');
  const tracked = git(root, ['ls-files', '--error-unmatch', '--', file]).status === 0;
  const hasHead = git(root, ['rev-parse', '-q', '--verify', 'HEAD']).status === 0;
  const added = tracked && hasHead ? (addedLines(gitOut(root, [...DIFF, 'HEAD', '--', file])).get(file) ?? new Set<number>()) : new Set(src.split('\n').map((_, k) => k + 1));
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
