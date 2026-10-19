// What a task may show and what it must hide (#748). A task container and the agents see only taskView(): the base
// commit, the problem statement and which test runner its repo uses. The hidden fields (the gold patch, the test
// patch, FAIL_TO_PASS, PASS_TO_PASS, the hints, the difficulty, and the instance id, which names the upstream PR) stay
// in the bench's held-out store on the host. Everything sent to a container is also checked against the row's hidden
// fields (hiddenLeaks, used by container.ts): a second wall, for a field taskView never had.

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

/** Pieces of a hidden value worth looking for: the whole value, each added line of a patch, each test name. */
function pieces(field: (typeof HIDDEN_FIELDS)[number], value: string): string[] {
  if (field === 'patch' || field === 'test_patch') {
    return value
      .split('\n')
      // Added lines only: a removed line is in the base commit, which the container already holds.
      .filter((l) => /^\+[^+]/.test(l))
      .map((l) => l.slice(1).trim())
      .filter((l) => l.length >= 24);
  }
  if (field === 'FAIL_TO_PASS' || field === 'PASS_TO_PASS') {
    try {
      return (JSON.parse(value) as string[]).filter((t) => t.length >= 12);
    } catch {
      return [value];
    }
  }
  if (field === 'difficulty') return [];
  return value.trim().length >= 8 ? [value.trim()] : [];
}

/**
 * The hidden fields of `row` whose content appears in `text` (what is about to reach a container). A piece the
 * problem statement itself contains doesn't count: the agents see that text anyway.
 */
export function hiddenLeaks(text: string, row: TaskRow): string[] {
  const leaks: string[] = [];
  for (const f of HIDDEN_FIELDS) {
    const v = row[f];
    if (typeof v !== 'string') continue;
    if (pieces(f, v).some((p) => text.includes(p) && !row.problem_statement.includes(p))) leaks.push(f);
  }
  if (row.difficulty && /"[a-z_]*difficulty[a-z_]*"/i.test(text)) leaks.push('difficulty');
  return [...new Set(leaks)];
}
