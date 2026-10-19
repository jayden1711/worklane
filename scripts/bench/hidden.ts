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
//   consecutive added lines. Not the gold patch's lines and not test names or ids: an agent's own correct fix or test
//   may match those. A piece the task's base tree already holds doesn't count (it is in the container's image anyway).
// It can't see: compressed or binary content (a gzip member, a .git object pack), other encodings (UTF-16), shorter
// lines (a changed expected value in an existing test), single test-patch lines or shorter runs on stdin. Those rely
// on the first wall.

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

/** A patch's added lines (`+x`, not the `+++ b/file` header), without the `+`. */
const isAdded = (l: string) => l.startsWith('+') && !l.startsWith('+++ ');

/**
 * Pieces of a hidden value the argv scan looks for: the whole value (at least 8 characters), each added line of a
 * patch (at least 24), each test id (at least 12).
 */
function pieces(field: (typeof HIDDEN_FIELDS)[number], value: string): string[] {
  if (field === 'patch' || field === 'test_patch') {
    return value
      .split('\n')
      // Added lines only: a removed line is in the base commit, which the container already holds.
      .filter(isAdded)
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

/** The non-blank lines of `text`, trailing space dropped; a NUL (tar padding, a header field) ends a line too. */
const textLines = (text: string): string[] => text.split(/[\n\0]/).map((l) => l.trimEnd()).filter((l) => l.trim() !== '');

/** Each STDIN_RUN consecutive lines of `lines`, joined: the keys a run is matched on. */
function windows(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + STDIN_RUN <= lines.length; i++) {
    const w = lines.slice(i, i + STDIN_RUN);
    if (w.join('').replace(/\s/g, '').length >= RUN_CHARS) out.push(w.join('\n'));
  }
  return out;
}

/**
 * The test patch's runs of STDIN_RUN consecutive added lines, blank lines left out: a context or removed line, or a
 * new hunk or file, ends a run.
 */
function testPatchRuns(patch: string): Set<string> {
  const out = new Set<string>();
  let run: string[] = [];
  const flush = () => {
    for (const w of windows(run)) out.add(w);
    run = [];
  };
  for (const l of patch.split('\n')) {
    if (!isAdded(l)) {
      flush();
      continue;
    }
    const line = l.slice(1).trimEnd();
    if (line.trim() !== '') run.push(line);
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
 *   out on both sides): what a driver bug that applied the test patch would carry.
 * Not the gold patch's lines, nor test names or ids: an agent's correct fix may equal the gold line, and its own
 * regression test may share the upstream test's name. The answer is yes or no, never which field: a refusal relayed
 * to an agent must not tell it which of its lines match the hidden patch.
 */
export function stdinCarriesHidden(text: string, row: TaskRow, base: string): boolean {
  for (const v of [row.instance_id, row.hints_text]) {
    const p = typeof v === 'string' ? v.trim() : '';
    if (p.length >= 8 && text.includes(p) && !row.problem_statement.includes(p) && !base.includes(p)) return true;
  }
  const runs = testPatchRuns(row.test_patch);
  if (!runs.size) return false;
  const firsts = new Set([...runs].map((w) => w.split('\n')[0]!));
  const lines = textLines(text);
  let inBase: Set<string> | undefined;
  for (let i = 0; i + STDIN_RUN <= lines.length; i++) {
    if (!firsts.has(lines[i]!)) continue;
    const w = lines.slice(i, i + STDIN_RUN).join('\n');
    if (!runs.has(w)) continue;
    inBase ??= new Set(windows(textLines(base)));
    if (!inBase.has(w)) return true;
  }
  return false;
}
