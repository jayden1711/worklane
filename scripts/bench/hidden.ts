// What a task may show and what it must hide (#748). A task container and the agents see only taskView(): the base
// commit, the problem statement and which test runner its repo uses. The hidden fields (the gold patch, the test
// patch, FAIL_TO_PASS, PASS_TO_PASS, the hints, the difficulty, and the instance id, which names the upstream PR) stay
// in the bench's held-out store on the host. That is the first wall, and the one that matters: no hidden field is
// ever handed to an agent or a container.
//
// The second wall (container.ts) is a narrow text scan of what is sent to a container, for a driver bug that would
// pass a hidden field on. It is a UTF-8 substring search, and it checks only these:
// - every docker argv (hiddenLeaks): the added lines of the gold patch and the test patch that are at least 24
//   characters long, the FAIL_TO_PASS and PASS_TO_PASS test ids of at least 12, the hints, the instance id, and a
//   difficulty key;
// - a command's stdin, a worktree's tar stream included (stdinCarriesHidden): only what an agent can't plausibly
//   write itself (owner, 2026-10-18): the instance id, the hints, and the test patch as a run of STDIN_RUN or more
//   consecutive added lines, applied or still in diff form (`+`-prefixed lines, LF or CRLF). Not the gold patch's
//   lines and not test names or ids: an agent's own correct fix or test may match those, nor a run made only of
//   import lines (an agent's own test file may start with the same imports). A piece the task's base tree already
//   holds, or the problem statement holds (the id, the hints), doesn't count: the container or the agents have it
//   anyway.
// It can't see: compressed or binary content (a gzip member, a .git object pack), other encodings (UTF-16), shorter
// lines (a changed expected value in an existing test), single test-patch lines or shorter runs on stdin, a run
// split across files or reordered, and the gold patch on stdin (owner, 2026-10-18). Those rely on the first wall.

/** One SWE-bench Verified row, as the pinned download writes it (one JSON object per line). */
export interface TaskRow {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  patch: string;
  test_patch: string;
  FAIL_TO_PASS: string;
  PASS_TO_PASS: string;
  hints_text: string;
  difficulty: string;
  version?: string;
  environment_setup_commit?: string;
  created_at?: string;
  /** The task's prebuilt image (the newer dataset copy names it). */
  image?: string;
}

/** How a task's repo runs one test file: Django's own runner, SymPy's bin/test, or pytest (SWE-bench's test_cmd). */
export type TestRunner = 'django' | 'sympy' | 'pytest';
export const testRunnerOf = (repo: string): TestRunner => (repo === 'django/django' ? 'django' : repo === 'sympy/sympy' ? 'sympy' : 'pytest');

/** Everything a task container is given. `key` is opaque (t01, t02, ...): no instance id, no upstream link. */
export interface TaskView {
  key: string;
  base_commit: string;
  title: string;
  problem_statement: string;
  tests: TestRunner;
}

/** The container's view of a row: an allowlist, so a field the dataset adds later never reaches a container. */
export function taskView(row: TaskRow, key: string): TaskView {
  const title = (row.problem_statement.split('\n').find((l) => l.trim()) ?? key).trim().slice(0, 120);
  return { key, base_commit: row.base_commit, title, problem_statement: row.problem_statement, tests: testRunnerOf(row.repo) };
}

/** The fields no container, agent or evaluator may see (design section 6.1), plus the instance id (it names the upstream PR). */
export const HIDDEN_FIELDS = ['patch', 'test_patch', 'FAIL_TO_PASS', 'PASS_TO_PASS', 'hints_text', 'instance_id', 'difficulty'] as const;

/** A hunk's header, `@@ -a,b +c,d @@`: b and d (1 when left out) are its old-side and new-side line counts. */
const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * Which lines of a patch are added lines (`+x`).
 * INVARIANT: a `+++ ` line is a file name only right after its file's `--- ` line, outside any hunk (#797).
 * In a hunk it is an added line starting "++ ". A hunk ends where its counts say, so a `--- ` line in it opens no header.
 * One with no name after it is added too, as it was before (#804): git never writes it, so treating it as added fails closed.
 */
function addedLines(lines: readonly string[]): boolean[] {
  let old = 0;
  let neu = 0;
  let afterOldName = false;
  return lines.map((l) => {
    const nameLine = afterOldName;
    afterOldName = false;
    if (old > 0 || neu > 0) {
      if (l.startsWith('+')) return (neu--, true);
      if (l.startsWith('-')) return (old--, false);
      // A context line; a blank one may have lost its leading space (CR too).
      if (l.startsWith(' ') || l.trimEnd() === '') return (old--, neu--, false);
      if (l.startsWith('\\')) return false;
      // WHY: a line no hunk holds (a hand-cut patch's counts ran long): the hunk ends here, and this line is read as outside one.
      old = neu = 0;
    }
    const h = HUNK.exec(l);
    if (h) [old, neu] = [Number(h[1] ?? 1), Number(h[2] ?? 1)];
    else if (l.startsWith('--- ')) afterOldName = true;
    return !h && l.startsWith('+') && !(nameLine && l.startsWith('+++ ') && l.slice(4).trim() !== '');
  });
}

/**
 * Pieces of a hidden value the argv scan looks for: the whole value (at least 8 characters), each added line of a
 * patch (at least 24), each test id (at least 12).
 */
function pieces(field: (typeof HIDDEN_FIELDS)[number], value: string): string[] {
  if (field === 'patch' || field === 'test_patch') {
    const lines = value.split('\n');
    const added = addedLines(lines);
    return lines
      // Added lines only: a removed line is in the base commit, which the container already holds.
      .filter((_, i) => added[i])
      .map((l) => l.slice(1).trim())
      .filter((l) => l.length >= 24);
  }
  if (field === 'FAIL_TO_PASS' || field === 'PASS_TO_PASS') {
    try {
      return (JSON.parse(value) as string[]).filter((t) => typeof t === 'string' && t.length >= 12);
    } catch {
      return [value];
    }
  }
  if (field === 'difficulty') return [];
  return value.trim().length >= 8 ? [value.trim()] : [];
}

/**
 * The hidden fields of `row` whose content appears in `text`, a docker argv about to reach a container (the pieces
 * above, as UTF-8 substrings). A piece the problem statement itself contains doesn't count: the agents see that text
 * anyway.
 */
export function hiddenLeaks(text: string, row: TaskRow): string[] {
  const leaks: string[] = [];
  const seen = (p: string) => text.includes(p) && !row.problem_statement.includes(p);
  for (const f of HIDDEN_FIELDS) {
    const v = row[f];
    if (typeof v !== 'string') continue;
    if (pieces(f, v).some(seen)) leaks.push(f);
  }
  if (row.difficulty && /"[a-z_]*difficulty[a-z_]*"/i.test(text)) leaks.push('difficulty');
  return [...new Set(leaks)];
}

/** How many consecutive test-patch lines on a command's stdin count as the test patch (owner, 2026-10-18). */
export const STDIN_RUN = 3;
/** A run's lines together must hold at least this many non-space characters: three closing brackets are no patch. */
const RUN_CHARS = 24;

/**
 * A tar stream as text for the stdin scan, with a NUL before each header block: a file whose content fills its last
 * 512-byte block exactly, with no trailing newline, would otherwise run its last line into the next file's name.
 */
export function tarText(stream: Buffer): string {
  const parts: Buffer[] = [];
  let from = 0;
  for (let at = 512; at + 262 <= stream.length; at += 512) {
    if (stream.toString('latin1', at + 257, at + 262) !== 'ustar') continue;
    parts.push(stream.subarray(from, at), Buffer.from([0]));
    from = at;
  }
  parts.push(stream.subarray(from));
  return Buffer.concat(parts).toString('utf8');
}

/** `text` cut into lines: at a line end or a NUL (tar padding, a header field). */
const rawLines = (text: string): string[] => text.split(/[\n\0]/);
/** The non-blank lines, trailing space (a CR too) dropped; with `plus`, one leading `+` dropped first (a diff's form). */
const textLines = (raw: readonly string[], plus = false): string[] =>
  raw.map((l) => (plus && l.startsWith('+') ? l.slice(1) : l).trimEnd()).filter((l) => l.trim() !== '');

/**
 * Each STDIN_RUN consecutive lines of `lines`, joined: the keys a run is matched on. With `imports` (whether each line
 * is an import line), a window made only of import lines is left out.
 */
function windows(lines: readonly string[], imports?: readonly boolean[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + STDIN_RUN <= lines.length; i++) {
    if (imports && imports.slice(i, i + STDIN_RUN).every(Boolean)) continue;
    const w = lines.slice(i, i + STDIN_RUN);
    if (w.join('').replace(/\s/g, '').length >= RUN_CHARS) out.push(w.join('\n'));
  }
  return out;
}

/** An import statement's first line: Python's `import a` / `from a import b` (and an ES module's `import ...`). */
const IMPORT = /^(import\s+\S|from\s+\S+\s+import\b)/;
/** Whether an import statement is still open: inside `from a import (` until its `)`, or after a trailing `\`. */
type ImportOpen = 'paren' | 'slash' | undefined;
/** A line inside an open `from a import (`: names (`a`, `a as b`) and commas, maybe its `)`, maybe a comment. */
const NAME = String.raw`[A-Za-z_]\w*(?:\s+as\s+[A-Za-z_]\w*)?`;
const PAREN_NAMES = new RegExp(String.raw`^(?:${NAME}\s*,\s*)*(?:${NAME}\s*)?\)?\s*(?:#.*)?$`);
/** Whether `line` is part of an import statement, given what is open above it; and what is open after it. */
function importStep(line: string, open: ImportOpen): [boolean, ImportOpen] {
  const t = line.trim();
  // WHY: only names or the `)` go on in an open paren; any other line (code, a stray "(" in a comment) ends it (#804).
  if (open === 'paren' && PAREN_NAMES.test(t)) return [true, t.includes(')') ? undefined : 'paren'];
  if (open !== 'slash' && !IMPORT.test(t)) return [false, undefined];
  return [true, t.endsWith('\\') ? 'slash' : t.includes('(') && !t.includes(')') ? 'paren' : undefined];
}

/**
 * The test patch's runs of STDIN_RUN consecutive added lines, blank lines left out (a blank context line too: the
 * tree side drops blank lines, so it doesn't end a run). Any other context or removed line, or a new hunk or file,
 * ends a run. A window made only of import lines is left out (owner, 2026-10-18): an agent's own test file may well
 * start with the same imports as a new upstream test file. Whether a line is an import line is read from the new
 * side of the hunk (context and added lines), so the names inside an open `from a import (` count too.
 */
function testPatchRuns(patch: string): Set<string> {
  const out = new Set<string>();
  let run: string[] = [];
  let imports: boolean[] = [];
  let open: ImportOpen;
  const flush = () => {
    for (const w of windows(run, imports)) out.add(w);
    run = [];
    imports = [];
  };
  const lines = patch.split('\n');
  const isAdded = addedLines(lines);
  for (const [i, raw] of lines.entries()) {
    const l = raw.trimEnd();
    if (l === '') continue;
    const added = isAdded[i]!;
    if (!added) flush();
    if (!added && !l.startsWith(' ')) {
      // A removed line isn't on the new side; a hunk or file header starts a new one.
      if (!l.startsWith('-')) open = undefined;
      continue;
    }
    const line = l.slice(1);
    if (line.trim() === '') continue;
    let isImport: boolean;
    [isImport, open] = importStep(line, open);
    if (!added) continue;
    run.push(line);
    imports.push(isImport);
  }
  flush();
  return out;
}

/**
 * Whether `text` (a command's stdin: a worktree's tar stream) carries hidden content of `row` that `base` (the text
 * of the task's base tree, a tar stream of its base commit) lacks. Only what an agent can't plausibly write itself
 * counts (owner, 2026-10-18), as UTF-8 text:
 * - the instance id, or the hints, as a substring (at least 8 characters, and not in the problem statement);
 * - the test patch as STDIN_RUN or more consecutive added lines, matched as whole lines in a row (blank lines left
 *   out on both sides): what a driver bug that applied the test patch would carry. The lines are matched as they
 *   stand and again with one leading `+` dropped: a driver bug that copied the test patch file itself, as a diff,
 *   carries them in that form. A window made only of import lines doesn't count.
 * Not the gold patch's lines, nor test names or ids: an agent's correct fix may equal the gold line, and its own
 * regression test may share the upstream test's name. A run the base tree holds, in either form, doesn't count. The
 * answer is yes or no, never which field: a refusal relayed to an agent must not tell it which of its lines match
 * the hidden patch. `text` and `base` are tar streams as tarText makes them.
 */
export function stdinCarriesHidden(text: string, row: TaskRow, base: string): boolean {
  for (const v of [row.instance_id, row.hints_text]) {
    const p = typeof v === 'string' ? v.trim() : '';
    if (p.length >= 8 && text.includes(p) && !row.problem_statement.includes(p) && !base.includes(p)) return true;
  }
  const runs = testPatchRuns(row.test_patch);
  if (!runs.size) return false;
  const firsts = new Set([...runs].map((w) => w.split('\n')[0]!));
  const raw = rawLines(text);
  let baseWindows: Set<string> | undefined;
  const inBase = (w: string) => {
    if (!baseWindows) {
      const b = rawLines(base);
      baseWindows = new Set([...windows(textLines(b)), ...windows(textLines(b, true))]);
    }
    return baseWindows.has(w);
  };
  for (const plus of [false, true]) {
    if (plus && !raw.some((l) => l.startsWith('+'))) break;
    const lines = textLines(raw, plus);
    for (let i = 0; i + STDIN_RUN <= lines.length; i++) {
      if (!firsts.has(lines[i]!)) continue;
      const w = lines.slice(i, i + STDIN_RUN).join('\n');
      if (runs.has(w) && !inBase(w)) return true;
    }
  }
  return false;
}
