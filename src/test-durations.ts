// Per-test durations, read from what a test runner prints: the slow-tests list of the metrics (src/merge-metrics.ts
// deliveryMetrics) and the weekly digest (src/trust.ts metricsDigest). Pure: text in, durations out.
//
// Conservative on purpose: only formats whose duration belongs to one named test without guessing, and only leaf
// tests (a test or suite with subtests is the sum of them, so it would crowd out the real slow ones):
//   - node:test TAP       `ok 3 - name` followed by its `duration_ms: 12.3` (a suite, `type: 'suite'`, is skipped)
//   - node:test spec      `✔ name (12.3ms)` / `✖ name (12.3ms)` (a `▶ name` line opens a test with subtests)
//   - pytest --durations  `0.52s call     tests/test_x.py::test_y` (the call phase only)
//   - go test -v          `--- PASS: TestX (0.12s)` (a test followed by deeper `---` lines has subtests)
//   - jest / vitest       `✓ name (12 ms)` / `✓ name 12ms` (U+2713; node's spec mark is U+2714)
// Anything else prints no durations here: a runner this doesn't read shows "not measured yet", never 0.
// GitHub Actions' log lines (a timestamp first) and colour codes are stripped before reading.

export interface TestDuration {
  name: string;
  ms: number;
}

/** A test name is cut to this many characters. */
export const NAME_CHARS = 300;
/** How many of a run's slowest tests are recorded (testrun.durations, ci.test_durations). */
export const RECORD_SLOWEST = 100;
/** A duration over a day is a misread, not a test. */
const MAX_MS = 86_400_000;

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const ACTIONS_TS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;

const clean = (line: string) => line.replace(ACTIONS_TS, '').replace(ANSI, '').replace(/\r$/, '');
const indentOf = (line: string) => line.length - line.trimStart().length;
const named = (parts: string[]) => parts.filter(Boolean).join(' > ').slice(0, NAME_CHARS);
const ok = (ms: number) => Number.isFinite(ms) && ms >= 0 && ms < MAX_MS;

/** node:test's TAP: each leaf `ok`/`not ok` line and the duration_ms in the YAML block under it. */
function nodeTap(lines: string[]): TestDuration[] {
  const out: TestDuration[] = [];
  // Per indent: the open `# Subtest:` name, and whether a deeper result was seen since it opened.
  const open = new Map<number, { name: string; child: boolean }>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const sub = /^(\s*)# Subtest: (.+)$/.exec(line);
    if (sub) {
      open.set(sub[1]!.length, { name: sub[2]!.trim(), child: false });
      continue;
    }
    const m = /^(\s*)(?:not )?ok \d+ - (.+?)(\s+#\s*(?:SKIP|TODO)\b.*)?$/.exec(line);
    if (!m) continue;
    const ind = m[1]!.length;
    const leaf = !(open.get(ind)?.child ?? false);
    for (const [k, v] of open) if (k < ind) v.child = true;
    // The YAML block right under it: `---` ... `...`, at a deeper indent.
    let ms: number | null = null;
    let suite = false;
    if (lines[i + 1]?.trim() === '---') {
      for (let j = i + 2; j < lines.length && lines[j]!.trim() !== '...'; j++) {
        const d = /^\s*duration_ms: ([\d.]+)\s*$/.exec(lines[j]!);
        if (d) ms = Number(d[1]);
        if (/^\s*type: '?suite'?\s*$/.test(lines[j]!)) suite = true;
      }
    }
    const parents = [...open].filter(([k]) => k < ind).sort((a, b) => a[0] - b[0]).map(([, v]) => v.name);
    open.delete(ind);
    for (const k of [...open.keys()]) if (k > ind) open.delete(k);
    if (leaf && !suite && !m[3] && ms !== null && ok(ms)) out.push({ name: named([...parents, m[2]!.trim()]), ms });
  }
  return out;
}

/**
 * node:test's spec reporter: leaf ✔/✖ lines with "(12.3ms)". A `▶ name` line opens a test with subtests (or a
 * suite); the `✔ name (Xms)` (or older Node's `▶ name (Xms)`) at the same indent after its children closes it.
 */
function nodeSpec(lines: string[]): TestDuration[] {
  const out: TestDuration[] = [];
  const open: { indent: number; name: string }[] = [];
  const popTo = (ind: number) => {
    while (open.length && open.at(-1)!.indent >= ind) open.pop();
  };
  for (const line of lines) {
    const ind = indentOf(line);
    const t = line.trim();
    const parent = /^▶ (.+?)( \([\d.]+ms\))?$/.exec(t);
    if (parent) {
      popTo(ind);
      if (!parent[2]) open.push({ indent: ind, name: parent[1]!.trim() });
      continue;
    }
    const m = /^[✔✖] (.+?) \(([\d.]+)ms\)( # .*)?$/.exec(t);
    if (!m) continue;
    const name = m[1]!.trim();
    const top = open.at(-1);
    if (top && top.indent === ind && top.name === name) {
      open.pop();
      continue;
    }
    popTo(ind);
    if (/^ # (SKIP|TODO)\b/i.test(m[3] ?? '')) continue;
    const ms = Number(m[2]);
    if (ok(ms)) out.push({ name: named([...open.map((o) => o.name), name]), ms });
  }
  return out;
}

/** pytest's `--durations` table: the call phase of each test. */
function pytest(lines: string[]): TestDuration[] {
  const out: TestDuration[] = [];
  for (const line of lines) {
    const m = /^\s*([\d.]+)s call\s+(\S+::\S.*?)\s*$/.exec(line);
    if (m && ok(Number(m[1]) * 1000)) out.push({ name: m[2]!.slice(0, NAME_CHARS), ms: Math.round(Number(m[1]) * 1000) });
  }
  return out;
}

/** go test -v: `--- PASS: Name (0.12s)`; one followed by deeper `---` lines has subtests. */
function goTest(lines: string[]): TestDuration[] {
  const rows = lines.map((l) => /^(\s*)--- (?:PASS|FAIL|SKIP): (\S+) \(([\d.]+)s\)\s*$/.exec(l)).filter((m): m is RegExpExecArray => !!m);
  const out: TestDuration[] = [];
  rows.forEach((m, i) => {
    const next = rows[i + 1];
    if (next && next[1]!.length > m[1]!.length) return;
    const ms = Math.round(Number(m[3]) * 1000);
    if (ok(ms)) out.push({ name: m[2]!.slice(0, NAME_CHARS), ms });
  });
  return out;
}

/** jest's and vitest's verbose lines: ✓/✕/× name (12 ms), or vitest's ✓ name 12ms. */
function jest(lines: string[]): TestDuration[] {
  const out: TestDuration[] = [];
  for (const line of lines) {
    const m = /^\s*[✓✕×] (.+?) (?:\((\d+(?:\.\d+)?) ?(ms|s)\)|(\d+(?:\.\d+)?)ms)\s*$/.exec(line);
    if (!m) continue;
    const ms = m[2] !== undefined ? Number(m[2]) * (m[3] === 's' ? 1000 : 1) : Number(m[4]);
    if (ok(ms)) out.push({ name: m[1]!.trim().slice(0, NAME_CHARS), ms });
  }
  return out;
}

/**
 * Every leaf test's duration the output prints, in any of the formats above, slowest first. A test named twice
 * (a retry, or two formats) keeps its longest. Empty when nothing is recognised.
 */
export function parseTestDurations(output: string): TestDuration[] {
  const lines = output.split('\n').map(clean);
  const best = new Map<string, number>();
  for (const d of [...nodeTap(lines), ...nodeSpec(lines), ...pytest(lines), ...goTest(lines), ...jest(lines)]) {
    if (!d.name) continue;
    best.set(d.name, Math.max(best.get(d.name) ?? 0, Math.round(d.ms * 10) / 10));
  }
  return [...best].map(([name, ms]) => ({ name, ms })).sort((a, b) => b.ms - a.ms || a.name.localeCompare(b.name));
}

/** What a run records: its slowest RECORD_SLOWEST tests, and how many it printed durations for in all. */
export function recordable(output: string): { tests: TestDuration[]; parsed: number } {
  const all = parseTestDurations(output);
  return { tests: all.slice(0, RECORD_SLOWEST), parsed: all.length };
}
