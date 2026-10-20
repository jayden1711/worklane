// The bench's task selection (#748, slice 3): seeded and deterministic, pinned in scripts/bench/pins.json as (dataset
// revision, rule, seed, rows digest), never as instance ids; the manifest and every task's image reference live in the
// held-out store, and the run gets them from there, never from a command line. Stand-ins only: fixture rows with
// synthetic ids (example__proj-NNNN), a temp bench root, no network, no docker, no model, no real store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentUser } from '../src/os/index.js';
import { BENCH_USER_ENV } from '../scripts/bench/auth.js';
import { benchLayout, type BenchLayout } from '../scripts/bench/paths.js';
// WHY: the isolation-preload guard: this file's process stops unless test/isolate.ts made its machine.
import { repoRoot } from './helpers.js';

const linux = { skip: process.platform !== 'linux' && 'the bench is Linux only' };

// WHY: loaded when a test runs, not at the top, so each test fails on its own on code from before these modules
// (the fail-without run).
const pinsMod = () => import('../scripts/bench/pins.js');
const sel = () => import('../scripts/bench/select.js');
const cli = () => import('../scripts/bench/cli.js');

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const uid = process.getuid?.() ?? 1000;

/** Anything shaped like an instance id or an instance image name: never in what the bench prints or throws. */
const TASKISH = /__|_1776_/;

/** The downloaded dataset file: a stand-in for the pinned parquet, never a task. */
const DATA = Buffer.from('fixture stand-in for the pinned dataset file, never a task\n');
const DATA_SHA = sha256(DATA);
const REV = '0123456789abcdef0123456789abcdef01234567';
const HOST = 'data.example.org';
const BASE = `https://${HOST}/datasets/fixture/resolve/`;
const DATA_FILE = `${DATA_SHA}-verified.parquet`;
const SEED = 20261018;
const RULE = 'sha256-rank-v1';

/** Synthetic instance ids in SWE-bench's shape (the repo's convention: never a real task's). */
const IDS = Array.from({ length: 60 }, (_, i) => `example__proj-${4200 + i}`);
const FAKE_ID = 'example__proj-4242';

interface Row {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  patch: string;
  test_patch: string;
  FAIL_TO_PASS: string | string[];
  PASS_TO_PASS: string | string[];
  hints_text: string;
  difficulty: string;
  version?: string;
  [k: string]: unknown;
}

const row = (id: string, i: number): Row => ({
  instance_id: id,
  repo: 'example/proj',
  base_commit: sha256(`base ${i}`).slice(0, 40),
  problem_statement: `Fixture problem ${i}: the widget is wrong.`,
  patch: `--- a/w.py\n+++ b/w.py\n@@ -1 +1 @@\n-x = ${i}\n+x = ${i + 1}\n`,
  test_patch: `--- a/t.py\n+++ b/t.py\n@@ -0,0 +1 @@\n+def test_w_${i}(): assert True\n`,
  FAIL_TO_PASS: JSON.stringify([`t.py::test_w_${i}`]),
  PASS_TO_PASS: '[]',
  hints_text: '',
  difficulty: '<15 min fix',
  version: '1.0',
});

const ROWS: Row[] = IDS.map(row);
const jsonl = (rows: readonly object[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const ROWS_TEXT = jsonl(ROWS);

/** The test's own statement of the rule: rank by sha256("<seed>:<instance id>"), ascending (ties by id). */
function ranked(ids: readonly string[], seed: number): string[] {
  const key = new Map(ids.map((id) => [id, sha256(`${seed}:${id}`)]));
  return [...ids].sort((a, b) => (key.get(a)! < key.get(b)! ? -1 : key.get(a)! > key.get(b)! ? 1 : a < b ? -1 : 1));
}

/** Image digests: one per fixture task, plus more, so the pinned set holds at least 100 (never a selection). */
const digestOf = (id: string): string => `sha256:${sha256(`image ${id}`)}`;
const DIGESTS = [...IDS.map(digestOf), ...Array.from({ length: 60 }, (_, i) => `sha256:${sha256(`other image ${i}`)}`)].sort();
const imageOf = (id: string): string => `swebench/sweb.eval.x86_64.${id.split('__').join('_1776_')}@${digestOf(id)}`;
const IMAGES: Record<string, string> = Object.fromEntries(IDS.map((id) => [id, imageOf(id)]));

interface PinsOver {
  selection?: Record<string, unknown> | null;
  rows?: string | null;
  seed?: unknown;
  rule?: unknown;
  dataset?: Record<string, unknown> | null;
  digests?: string[];
}

/** A pins file's text in its canonical form, pinned to the fixtures unless told otherwise. */
function pinsText(o: PinsOver = {}, rowsText = ROWS_TEXT): string {
  const dataset = o.dataset === null ? { base: BASE, path: 'data/verified.parquet', revision: null, sha256: null, max_bytes: 1024 * 1024, hosts: [HOST] } : { base: BASE, path: 'data/verified.parquet', revision: REV, sha256: DATA_SHA, max_bytes: 1024 * 1024, hosts: [HOST], ...o.dataset };
  const selection = o.selection === null ? null : { rule: o.rule ?? RULE, seed: o.seed ?? SEED, rows_sha256: o.rows === undefined ? canonicalSha(rowsText) : o.rows, ...o.selection };
  return `${JSON.stringify({ dataset, image_digests: o.digests ?? DIGESTS, selection }, null, 2)}\n`;
}

/**
 * The canonical digest the test expects: rows sorted by instance id, each with the known fields in a fixed order, the
 * test lists as compact JSON text, nothing else; one JSON object per line.
 */
function canonicalSha(text: string): string {
  const FIELDS = ['instance_id', 'repo', 'base_commit', 'problem_statement', 'patch', 'test_patch', 'FAIL_TO_PASS', 'PASS_TO_PASS', 'hints_text', 'difficulty', 'version', 'environment_setup_commit'];
  const rows = text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .map((r) => {
      const o: Record<string, unknown> = {};
      for (const k of FIELDS) {
        let v = r[k];
        if (v === undefined || v === null) continue;
        if (k === 'FAIL_TO_PASS' || k === 'PASS_TO_PASS') v = JSON.stringify(typeof v === 'string' ? JSON.parse(v) : v);
        o[k] = v;
      }
      return o;
    })
    .sort((a, b) => ((a.instance_id as string) < (b.instance_id as string) ? -1 : 1));
  return sha256(rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/** A temp bench root with the held-out store made (0700) and the pinned dataset file, the rows and the images in it. */
function store(o: { rows?: string | null; data?: Buffer | null; images?: Record<string, string> | null } = {}): { base: string; home: string; layout: BenchLayout } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'bench-select-')));
  const home = join(base, 'home');
  mkdirSync(home);
  const layout = benchLayout(join(home, 'bench'));
  for (const d of [layout.root, layout.state, join(layout.state, 'evals'), join(layout.state, 'evals', 'held-out'), layout.heldOut, layout.data]) {
    mkdirSync(d, { mode: 0o700 });
    chmodSync(d, 0o700);
  }
  const put = (f: string, data: string | Buffer) => {
    writeFileSync(f, data, { mode: 0o600 });
    chmodSync(f, 0o600);
  };
  if (o.data !== null) put(join(layout.data, DATA_FILE), o.data ?? DATA);
  if (o.rows !== null) put(join(layout.data, 'rows.jsonl'), o.rows ?? ROWS_TEXT);
  if (o.images !== null) put(join(layout.heldOut, 'images.json'), JSON.stringify(o.images ?? IMAGES));
  return { base, home, layout };
}

const manifestPath = (l: BenchLayout) => join(l.heldOut, 'manifest.json');

/** The bench command's deps on a temp bench machine: the bench user and its home. */
function cliDeps(b: { home: string }, out: string[], over: Record<string, unknown> = {}) {
  const env: NodeJS.ProcessEnv = { PATH: '/nonexistent', HOME: b.home, [BENCH_USER_ENV]: currentUser() };
  return { env, user: currentUser(), uid, euid: process.geteuid?.() ?? uid, passwdHome: () => b.home, out: (l: string) => out.push(l), ...over };
}

// ---- The rows ----

test('rows: one canonical digest for the same rows, whatever the order, spacing, list spelling or extra fields', async () => {
  const { canonicalRows } = await sel();
  const a = canonicalRows(ROWS_TEXT);
  assert.equal(a.rows.length, 60);
  assert.equal(a.sha256, canonicalSha(ROWS_TEXT), 'the canonical form the test states');
  // Reversed, pretty-spaced, lists as lists, CRLF line ends, extra fields a converter adds: the same rows.
  const other = [...ROWS]
    .reverse()
    .map((r) => JSON.stringify({ created_at: '2020-01-01T00:00:00', image: 'ignored', ...r, FAIL_TO_PASS: JSON.parse(r.FAIL_TO_PASS as string) as string[], PASS_TO_PASS: [] }, null, 1).replace(/\n/g, ' '))
    .join('\r\n');
  const b = canonicalRows(other);
  assert.equal(b.sha256, a.sha256, 'the same rows, spelled differently');
  assert.deepEqual(b.rows, a.rows);
  for (const r of b.rows) {
    assert.ok(!('image' in r) && !('created_at' in r), 'only the fields the digest covers reach the run');
    assert.equal(typeof r.FAIL_TO_PASS, 'string');
  }
  // One changed byte in a hidden field: another digest.
  const changed = jsonl(ROWS.map((r, i) => (i === 7 ? { ...r, test_patch: `${r.test_patch} ` } : r)));
  assert.notEqual(canonicalRows(changed).sha256, a.sha256);
});

test('rows: a missing or mistyped field, a repeated instance id, bad UTF-8 or no rows refuses the whole file, naming no task', async () => {
  const { canonicalRows } = await sel();
  const bad: [string | Buffer, string][] = [
    [jsonl(ROWS.map((r, i) => (i === 3 ? { ...r, patch: undefined } : r))), 'a row without its patch'],
    [jsonl(ROWS.map((r, i) => (i === 3 ? { ...r, hints_text: 7 } : r))), 'a number for the hints'],
    [jsonl(ROWS.map((r, i) => (i === 3 ? { ...r, FAIL_TO_PASS: 'not json' } : r))), 'a test list that is not JSON'],
    [jsonl(ROWS.map((r, i) => (i === 3 ? { ...r, PASS_TO_PASS: [1, 2] } : r))), 'a test list of numbers'],
    [jsonl(ROWS.map((r, i) => (i === 3 ? { ...r, instance_id: '' } : r))), 'an empty instance id'],
    [jsonl([...ROWS, ROWS[42]!]), 'an instance id twice'],
    [`${ROWS_TEXT}[1, 2]\n`, 'a line that is not an object'],
    [`${ROWS_TEXT}{not json\n`, 'a line that is not JSON'],
    [Buffer.concat([Buffer.from(ROWS_TEXT), Buffer.from([0xff, 0xfe, 0x0a])]), 'bytes that are not UTF-8'],
    ['\n\n', 'no rows'],
  ];
  for (const [text, why] of bad) {
    let msg = '';
    assert.throws(() => canonicalRows(text), (e: Error) => ((msg = e.message), true), why);
    assert.doesNotMatch(msg, TASKISH, `${why}: the refusal names no task (${msg})`);
  }
});

// ---- The rule ----

test('the rule: sha256 of "<seed>:<instance id>", ascending, the first 50; order-free, seed-bound, the smoke a prefix of the baseline', async () => {
  const { parsePins } = await pinsMod();
  const { canonicalRows, selectTasks, MODE_TASKS } = await sel();
  const { MIN_DIGEST_SET } = await pinsMod();
  assert.deepEqual({ ...MODE_TASKS }, { smoke: 4, baseline: 50 }, "the owner's 4-task smoke and 50-task baseline");
  assert.ok(MODE_TASKS.baseline < MIN_DIGEST_SET, 'the pinned digest set is larger than any selection');
  const pin = parsePins(pinsText()).selection!;
  const { rows } = canonicalRows(ROWS_TEXT);
  const picked = selectTasks(rows, pin);
  assert.deepEqual(picked.map((t) => t.row.instance_id), ranked(IDS, SEED).slice(0, 50), "the rule as the test states it");
  assert.deepEqual(picked.map((t) => t.key), Array.from({ length: 50 }, (_, i) => `t${String(i + 1).padStart(2, '0')}`), 'keys t01..t50, in rank order');
  // The file's order doesn't matter.
  assert.deepEqual(selectTasks(canonicalRows(jsonl([...ROWS].reverse())).rows, pin), picked);
  // Another seed picks another set (the same rule).
  const other = selectTasks(rows, parsePins(pinsText({ seed: SEED + 1 })).selection!);
  assert.deepEqual(other.map((t) => t.row.instance_id), ranked(IDS, SEED + 1).slice(0, 50));
  assert.notDeepEqual(other.slice(0, 4).map((t) => t.row.instance_id), picked.slice(0, 4).map((t) => t.row.instance_id));
  // A row ranked after the 50th, added or removed, changes nothing chosen: each row's rank is its own.
  const last = ranked(IDS, SEED).at(-1)!;
  const without = canonicalRows(jsonl(ROWS.filter((r) => r.instance_id !== last))).rows;
  assert.deepEqual(selectTasks(without, pin).map((t) => t.row.instance_id), picked.map((t) => t.row.instance_id));
  // Too few rows for the baseline: refused.
  assert.throws(() => selectTasks(rows.slice(0, 49), pin), /50/);
  // A hand-made selection pin is refused.
  assert.throws(() => selectTasks(rows, { ...pin } as typeof pin), /pins file/);
});

// ---- The pins ----

test('pins: the selection is (rule, seed, rows digest) and nothing else; the repo pins a rule and a seed and names no task', async () => {
  const { parsePins, loadPins, PINS_FILE, SelectionPin } = await pinsMod();
  const p = parsePins(pinsText());
  assert.ok(p.selection instanceof SelectionPin);
  assert.equal(p.selection.rule, RULE);
  assert.equal(p.selection.seed, SEED);
  assert.equal(p.selection.rowsSha256, canonicalSha(ROWS_TEXT));
  assert.throws(() => ((p.selection as unknown as { seed: number }).seed = 1), TypeError, 'frozen');
  assert.equal(parsePins(pinsText({ selection: null })).selection, null, 'unpinned: nothing selected');
  assert.equal(parsePins(pinsText({ rows: null })).selection!.rowsSha256, null, 'a seed before the rows: allowed (pre-registered)');
  for (const [text, why] of [
    [pinsText({ rule: 'first-n' }), 'an unknown rule'],
    [pinsText({ seed: -1 }), 'a negative seed'],
    [pinsText({ seed: 1.5 }), 'a fractional seed'],
    [pinsText({ seed: '7' }), 'a seed as text'],
    [pinsText({ seed: 2 ** 32 }), 'a seed over 32 bits'],
    [pinsText({ rows: 'abc' }), 'a short rows digest'],
    [pinsText({ selection: { tasks: ['t01'] } }), 'an unknown selection key'],
    [pinsText({ selection: { count: 4 } }), 'a count: the owner set it in code'],
    [pinsText().replace(`"seed": ${SEED},\n`, ''), 'no seed'],
  ] as const) assert.throws(() => parsePins(text), Error, why);
  // The repo's file.
  const text = readFileSync(PINS_FILE, 'utf8');
  assert.equal(PINS_FILE, join(repoRoot, 'scripts', 'bench', 'pins.json'));
  const repo = loadPins();
  assert.ok(repo.selection, 'the repo pins a selection');
  assert.equal(repo.selection.rule, RULE);
  assert.ok(Number.isSafeInteger(repo.selection.seed));
  assert.doesNotMatch(text, /__|_1776_|:latest|swebench\//, 'no instance id, image name or tag');
});

// ---- bench select: the manifest ----

test('select: the manifest is written only from the pinned rows, as a 0600 file in the store, and never over a different one', linux, async () => {
  const { parsePins } = await pinsMod();
  const { writeSelection } = await sel();
  const b = store();
  const pins = parsePins(pinsText());
  const s = writeSelection(b.layout, uid, pins);
  assert.equal(s.written, true);
  assert.equal(s.rows, 60);
  assert.deepEqual(s.keys, Array.from({ length: 50 }, (_, i) => `t${String(i + 1).padStart(2, '0')}`));
  assert.doesNotMatch(JSON.stringify(s), TASKISH, 'what select reports names no task');
  const f = manifestPath(b.layout);
  const m = JSON.parse(readFileSync(f, 'utf8')) as { dataset_revision: string; seed: number; rule: string; rows_sha256: string; tasks: { key: string; instance_id: string }[] };
  assert.equal(m.dataset_revision, REV);
  assert.equal(m.seed, SEED);
  assert.equal(m.rule, RULE);
  assert.equal(m.rows_sha256, canonicalSha(ROWS_TEXT));
  assert.deepEqual(m.tasks.map((t) => t.instance_id), ranked(IDS, SEED).slice(0, 50));
  assert.equal((await import('node:fs')).lstatSync(f).mode & 0o7777, 0o600);
  assert.deepEqual((await import('node:fs')).readdirSync(b.layout.heldOut).filter((n) => n.startsWith('.')), [], 'no temporary file left behind');
  assert.equal((await import('node:fs')).lstatSync(f).nlink, 1, 'the fresh name is gone: the manifest has one link');
  // Again, the same pins: the same manifest, kept.
  const before = readFileSync(f, 'utf8');
  assert.equal(writeSelection(b.layout, uid, pins).written, false);
  assert.equal(readFileSync(f, 'utf8'), before);
  // Another seed: refused, the manifest unchanged (grading maps a run's keys through it).
  assert.throws(() => writeSelection(b.layout, uid, parsePins(pinsText({ seed: SEED + 1 }))), /manifest/);
  assert.equal(readFileSync(f, 'utf8'), before);
});

test('select: refuses before writing anything: unpinned rows (it reports their digest), another digest, the dataset file missing or changed, a link, a store that fails its check', linux, async () => {
  const { parsePins } = await pinsMod();
  const { writeSelection, RowsUnpinned } = await sel();
  const nothing = (b: { layout: BenchLayout }, why: string) => assert.ok(!existsSync(manifestPath(b.layout)), `${why}: no manifest`);
  // Unpinned rows: the error carries the digest to record, and nothing is written.
  const u = store();
  assert.throws(() => writeSelection(u.layout, uid, parsePins(pinsText({ rows: null }))), (e: unknown) => e instanceof RowsUnpinned && e.sha256 === canonicalSha(ROWS_TEXT));
  nothing(u, 'unpinned rows');
  const cases: [string, () => { layout: BenchLayout }, string, RegExp][] = [
    ['rows that are not the pinned ones', () => store({ rows: jsonl(ROWS.slice(1)) }), pinsText(), /sha256/],
    ['no rows file', () => store({ rows: null }), pinsText(), /rows/],
    ['the dataset file missing', () => store({ data: null }), pinsText(), /bench download/],
    ['the dataset file changed', () => store({ data: Buffer.from('other bytes') }), pinsText(), /sha256/],
    ['no dataset pin', () => store(), pinsText({ dataset: null }), /not pinned/],
    ['no selection pin', () => store(), pinsText({ selection: null }), /not pinned/],
  ];
  for (const [why, make, text, re] of cases) {
    const b = make();
    assert.throws(() => writeSelection(b.layout, uid, parsePins(text)), re, why);
    nothing(b, why);
  }
  // The rows file as a link to the very same bytes: refused (never followed).
  const l = store({ rows: null });
  const elsewhere = join(l.base, 'rows-elsewhere.jsonl');
  writeFileSync(elsewhere, ROWS_TEXT, { mode: 0o600 });
  symlinkSync(elsewhere, join(l.layout.data, 'rows.jsonl'));
  assert.throws(() => writeSelection(l.layout, uid, parsePins(pinsText())), /link|ELOOP/);
  nothing(l, 'a linked rows file');
  // A rows file others can read: refused.
  const g = store();
  chmodSync(join(g.layout.data, 'rows.jsonl'), 0o644);
  assert.throws(() => writeSelection(g.layout, uid, parsePins(pinsText())), /0600/);
  nothing(g, 'a 0644 rows file');
  // A link where the manifest goes: refused, the place it names untouched.
  const m = store();
  const target = join(m.base, 'target');
  symlinkSync(target, manifestPath(m.layout));
  assert.throws(() => writeSelection(m.layout, uid, parsePins(pinsText())), /link/);
  assert.ok(!existsSync(target), 'nothing written through the link');
  // A store that fails the preflight's check (0750): refused as it is.
  const s = store();
  chmodSync(s.layout.heldOut, 0o750);
  assert.throws(() => writeSelection(s.layout, uid, parsePins(pinsText())), /0700/);
  nothing(s, 'a 0750 store');
  // A hand-made set of pins: refused.
  const h = store();
  const forged = { ...parsePins(pinsText()) } as ReturnType<typeof parsePins>;
  assert.throws(() => writeSelection(h.layout, uid, forged), /pins file/);
  nothing(h, 'hand-made pins');
});

test('select: a pinned JSON-lines dataset file is the rows itself, and a rows file beside it is not read', linux, async () => {
  const { parsePins } = await pinsMod();
  const { writeSelection, loadTasks } = await sel();
  const b = store({ data: null, rows: jsonl(ROWS.slice(5)) });
  const file = join(b.layout.data, `${sha256(ROWS_TEXT)}-verified.jsonl`);
  writeFileSync(file, ROWS_TEXT, { mode: 0o600 });
  chmodSync(file, 0o600);
  const pins = parsePins(pinsText({ dataset: { path: 'data/verified.jsonl', sha256: sha256(ROWS_TEXT) } }));
  const s = writeSelection(b.layout, uid, pins);
  assert.equal(s.rows, 60, 'the pinned file, not the 55-row decoy beside it');
  assert.deepEqual(loadTasks(b.layout, uid, pins, 'smoke').map((t) => t.row.instance_id), ranked(IDS, SEED).slice(0, 4));
});

// ---- The hand-over to the run ----

test('the run gets its tasks from the store: the rows re-verified, the manifest re-derived, each image a pinned digest that names its task', linux, async () => {
  const { parsePins, ImageRef } = await pinsMod();
  const { writeSelection, loadTasks } = await sel();
  const b = store();
  const pins = parsePins(pinsText());
  writeSelection(b.layout, uid, pins);
  const smoke = loadTasks(b.layout, uid, pins, 'smoke');
  const want = ranked(IDS, SEED);
  assert.deepEqual(smoke.map((t) => t.key), ['t01', 't02', 't03', 't04']);
  assert.deepEqual(smoke.map((t) => t.row.instance_id), want.slice(0, 4));
  for (const t of smoke) {
    assert.ok(t.ref instanceof ImageRef);
    assert.equal(t.image, imageOf(t.row.instance_id), 'name@digest, from the store');
    assert.equal(`${t.ref.name}@${t.ref.digest}`, t.image);
  }
  assert.throws(() => ((smoke as unknown as unknown[]).push({}), TypeError));
  const baseline = loadTasks(b.layout, uid, pins, 'baseline');
  assert.equal(baseline.length, 50);
  assert.deepEqual(baseline.slice(0, 4).map((t) => t.row.instance_id), smoke.map((t) => t.row.instance_id), 'the smoke is the first 4 of the baseline');
  assert.throws(() => loadTasks(b.layout, uid, pins, 'constructor' as never), /smoke or baseline/);
});

test('the hand-over refuses a changed manifest, a changed pin and any image not pinned for its task; every refusal names keys, never a task', linux, async () => {
  const { parsePins } = await pinsMod();
  const { writeSelection, loadTasks } = await sel();
  const pins = parsePins(pinsText());
  const want = ranked(IDS, SEED);
  const refuses = (b: { layout: BenchLayout }, re: RegExp, why: string, p = pins) => {
    let msg = '';
    assert.throws(() => loadTasks(b.layout, uid, p, 'smoke'), (e: Error) => ((msg = e.message), re.test(msg)), why);
    assert.doesNotMatch(msg, TASKISH, `${why}: the refusal names no task (${msg})`);
  };
  // No manifest yet.
  refuses(store(), /bench select/, 'no manifest');
  // The manifest edited by hand: two tasks swapped (still a 0600 file of this user).
  const t = store();
  writeSelection(t.layout, uid, pins);
  const f = manifestPath(t.layout);
  const m = JSON.parse(readFileSync(f, 'utf8')) as { tasks: { key: string; instance_id: string }[] };
  [m.tasks[0]!.instance_id, m.tasks[1]!.instance_id] = [m.tasks[1]!.instance_id, m.tasks[0]!.instance_id];
  writeFileSync(f, `${JSON.stringify(m, null, 2)}\n`);
  refuses(t, /manifest/, 'a swapped manifest');
  // The pins changed since select (another seed): refused, select again.
  const c = store();
  writeSelection(c.layout, uid, pins);
  refuses(c, /manifest/, 'another seed since select', parsePins(pinsText({ seed: SEED + 1 })));
  // Images: each case on a fresh store.
  const withImages = (images: Record<string, string> | null): { layout: BenchLayout } => {
    const s = store({ images });
    writeSelection(s.layout, uid, pins);
    return s;
  };
  const [a, b2] = [want[0]!, want[1]!];
  const unpinned = `swebench/sweb.eval.x86_64.${a.split('__').join('_1776_')}@sha256:${sha256('not pinned')}`;
  refuses(withImages(null), /images/, 'no images file');
  refuses(withImages({ ...IMAGES, [b2]: undefined as unknown as string }), /t02/, 'no reference for the second task');
  refuses(withImages({ ...IMAGES, [a]: unpinned }), /t01.*pinned/, 'a digest not pinned');
  refuses(withImages({ ...IMAGES, [a]: `swebench/sweb.eval.x86_64.${a.split('__').join('_1776_')}:latest` }), /t01/, 'a tag');
  refuses(withImages({ ...IMAGES, [a]: IMAGES[b2]! }), /t01.*name/, "another task's image");
  refuses(withImages({ ...IMAGES, [b2]: `swebench/sweb.eval.x86_64.${b2.split('__').join('_1776_')}@${digestOf(a)}` }), /t02.*digest/, 'two tasks, one digest');
  refuses(withImages({ ...IMAGES, [a]: 7 as unknown as string }), /t01/, 'a number');
  // The images file as a link, or readable by others.
  const l = store({ images: null });
  writeSelection(l.layout, uid, pins);
  const elsewhere = join(l.base, 'images-elsewhere.json');
  writeFileSync(elsewhere, JSON.stringify(IMAGES), { mode: 0o600 });
  symlinkSync(elsewhere, join(l.layout.heldOut, 'images.json'));
  refuses(l, /link|ELOOP/, 'a linked images file');
  const g = withImages(IMAGES);
  chmodSync(join(g.layout.heldOut, 'images.json'), 0o644);
  refuses(g, /0600/, 'a 0644 images file');
  // The rows changed since select (the pin not): refused on the rows' digest.
  const r = store();
  writeSelection(r.layout, uid, pins);
  unlinkSync(join(r.layout.data, 'rows.jsonl'));
  writeFileSync(join(r.layout.data, 'rows.jsonl'), jsonl(ROWS.slice(1)), { mode: 0o600 });
  refuses(r, /sha256/, 'rows changed since select');
});

// ---- The bench command ----

test('bench select: takes no argument, prints keys and the smoke run plan, never an instance id', linux, async () => {
  const { parsePins } = await pinsMod();
  const { main, select } = await cli();
  const help: string[] = [];
  assert.equal(main(['help'], { out: (l: string) => help.push(l) }), 0);
  assert.match(help.join('\n'), /select/);
  const b = store();
  const out: string[] = [];
  const code = select(cliDeps(b, out) as never, () => parsePins(pinsText()));
  assert.equal(code, 0, out.join('\n'));
  const text = out.join('\n');
  assert.match(text, /PASS +rows/);
  assert.match(text, /PASS +selection.*t01\.\.t50/);
  assert.match(text, /PASS +images/);
  assert.match(text, /smoke.*t01 t02 t03 t04/);
  assert.match(text, /\$40/);
  assert.match(text, /\$15/);
  assert.doesNotMatch(text, TASKISH, 'no instance id or image name printed');
  assert.ok(existsSync(manifestPath(b.layout)));
  // Unpinned rows: one FAIL line with the digest to record, exit 1, nothing written.
  const u = store();
  const un: string[] = [];
  assert.equal(select(cliDeps(u, un) as never, () => parsePins(pinsText({ rows: null }))), 1);
  assert.match(un.join('\n'), new RegExp(`FAIL.*${canonicalSha(ROWS_TEXT)}`));
  assert.ok(!existsSync(manifestPath(u.layout)));
  // Images missing: the selection is written, the images line FAILs, exit 1.
  const i = store({ images: null });
  const im: string[] = [];
  assert.equal(select(cliDeps(i, im) as never, () => parsePins(pinsText())), 1);
  assert.match(im.join('\n'), /FAIL +images/);
  assert.doesNotMatch(im.join('\n'), TASKISH);
});

test("adversarial pass: the sink's backstop withholds the whole word, through quotes, a zero-width space or a no-break space", async () => {
  const { withholdTasks, WITHHELD, main } = await cli();
  for (const [text, why] of [
    [`refused: "${FAKE_ID}", next`, 'quoted, with a comma'],
    [`x:${FAKE_ID},y`, 'inside punctuation'],
    [JSON.stringify({ a: FAKE_ID }), 'inside JSON'],
    [IMAGES[FAKE_ID]!, 'an instance image name'],
    [FAKE_ID.toUpperCase(), 'upper case'],
    ['example​__proj-4242', 'a zero-width space before the underscores'],
    ['example__pr​oj-4242', 'a zero-width space inside'],
    ['example __proj-4242', 'a no-break space splitting the word'],
  ] as const) {
    const got = withholdTasks(text);
    assert.match(got, new RegExp(WITHHELD.replace(/[[\]]/g, '\\$&')), why);
    assert.doesNotMatch(got.replace(/[\p{Cc}\p{Cf}]/gu, ''), /__|_1776_/, `${why}: ${got}`);
  }
  assert.equal(withholdTasks('t01 t02: def __init__(self) and a_b'), 't01 t02: def __init__(self) and a_b', 'nothing else is touched');
  const out: string[] = [];
  assert.equal(main(['example​__proj-4242'], { out: (l: string) => out.push(l) }), 2);
  assert.doesNotMatch(out.join('\n'), /__proj|_1776_/, 'nothing of the tail through the real sink');
});

test('round 2: through main(), the backstop runs before any space or cut: zero-width, soft hyphen, bidi marks and a long argument', async () => {
  const { main } = await cli();
  const cases: [string, string][] = [
    ['example__pr​oj-4242', 'a zero-width space inside the repo'],
    ['example_​_proj-4242', 'a zero-width space between the underscores'],
    ['example__proj-​4242', 'a zero-width space before the digits'],
    ['example__pr­oj-4242', 'a soft hyphen inside'],
    ['example__pr‏oj-4242', 'a right-to-left mark inside'],
    ['swebench/sweb.eval.x86_64.example_17​76_proj-4242', 'an image name with a zero-width space in 1776'],
    [`${'x'.repeat(190)}${FAKE_ID}`, 'an argument longer than the 200-character cut'],
  ];
  for (const [arg, why] of cases) {
    for (const argv of [[arg], ['select', arg]]) {
      const out: string[] = [];
      assert.equal(main(argv, { out: (l: string) => out.push(l) }), 2, why);
      const text = out.join('\n');
      assert.doesNotMatch(text, /proj|_1776_|_17 76_|example__/, `${why} (${argv[0] === 'select' ? 'select <arg>' : 'unknown command'}): ${text.split('\n')[0]}`);
    }
  }
});

test('round 2: look-alike and encoded spellings are withheld through main(): fullwidth, Cyrillic, other digits, percent, backslash and entity escapes', async () => {
  const { main, withholdTasks, WITHHELD } = await cli();
  const cases: [string, string][] = [
    ['example＿＿proj-4242', 'fullwidth underscores'],
    ['example__proj-４２４２', 'fullwidth digits'],
    ['example__prоj-4242', 'a Cyrillic o'],
    ['example__proj-٤٢٤٢', 'Arabic-Indic digits'],
    ['example＿＿prоj-٤٢٤٢', 'fullwidth underscores, a Cyrillic o and Arabic-Indic digits together'],
    ['example‗‗proj-4242', 'a look-alike underscore NFKC keeps'],
    ['example%5F%5Fproj-4242', 'percent-escaped underscores'],
    ['example%255F%255Fproj-4242', 'percent-escaped twice'],
    ['example\\u005f\\u005fproj-4242', 'backslash-u escapes'],
    ['example\\x5f\\x5fproj-4242', 'backslash-x escapes'],
    ['example&#95;&#x5f;proj-4242', 'HTML entities'],
    ['sweb.eval.x86_64.example%5F1776%5Fproj-4242', 'an escaped image name'],
  ];
  for (const [arg, why] of cases) {
    assert.equal(withholdTasks(arg), WITHHELD, why);
    const out: string[] = [];
    assert.equal(main([arg], { out: (l: string) => out.push(l) }), 2, why);
    assert.doesNotMatch(out.join('\n'), /proj|prоj/, `${why}: ${out[0]}`);
  }
  // Words that only look a little like one stay as they are: plain non-ASCII text, a dunder, keys, digests.
  for (const s of ['日本語の文章', 'café-1', 'def __init__(self)', 't01..t50', `sha256:${sha256('x')}`, '__pycache__']) assert.equal(withholdTasks(s), s, s);
});

test('round 3: mixed-role look-alikes, named entities and deep encodings are withheld through main(); a word too long to check is withheld unjudged', async () => {
  const { main, withholdTasks, WITHHELD, WITHHELD_LONG, WORD_MAX } = await cli();
  /** `_` percent-escaped `n` times: `%5F`, `%255F`, `%25255F`, ... */
  const deep = (n: number): string => `${'%'}${'25'.repeat(n - 1)}5F`;
  const cases: [string, string][] = [
    ['example‗‗proj‐4242', 'double low lines with a Unicode hyphen'],
    ['exampleˍˍproj‐4242', 'modifier low macrons (a letter) with a Unicode hyphen'],
    ['example‗‗proj-́4242', 'a combining acute after the hyphen'],
    ['example&lowbar;&lowbar;proj&hyphen;4242', 'named entities'],
    ['example&UnderBar;&UnderBar;proj&minus;4242', 'other named entities'],
    ['example%2525255F%2525255Fproj-4242', 'percent-escaped four times'],
    [`example${deep(7)}${deep(7)}proj-4242`, 'percent-escaped seven times'],
  ];
  for (const [arg, why] of cases) {
    assert.equal(withholdTasks(arg), WITHHELD, why);
    for (const argv of [[arg], ['select', arg]]) {
      const out: string[] = [];
      assert.equal(main(argv, { out: (l: string) => out.push(l) }), 2, why);
      assert.doesNotMatch(out.join('\n'), /proj/, `${why}: ${out[0]}`);
    }
  }
  // Still decoding after the bound: withheld (fail closed), whatever it decodes to.
  assert.equal(withholdTasks(`a${deep(20)}b`), WITHHELD, 'twenty rounds of percent-encoding');
  // Longer than WORD_MAX: withheld without being judged, whatever it holds.
  assert.equal(withholdTasks('x'.repeat(WORD_MAX + 1)), WITHHELD_LONG);
  assert.equal(withholdTasks('x'.repeat(WORD_MAX)), 'x'.repeat(WORD_MAX), 'a word at the bound is judged, and kept');
  const huge = 'a__'.repeat(43_691);
  assert.equal(withholdTasks(`ok ${huge} ok`), `ok ${WITHHELD_LONG} ok`);
  const out: string[] = [];
  assert.equal(main([huge], { out: (l: string) => out.push(l) }), 2);
  assert.match(out[0]!, /word too long to check/);
  // Ordinary words stay as they are.
  for (const s of ['x86_64', '__main__.py', 'résumé—2024', 'Zürich-2', '10–20', 'v1.2.3-rc1', 'my_var__x', 'foo%20bar', '&amp;', 'São_Paulo-3', '2026‑10‑20', 'naïve', 'node_modules/.bin']) assert.equal(withholdTasks(s), s, s);
});

test('round 2: the repo pins this seed and rule: a change to either is a change to this test, which the owner reviews', async () => {
  const { loadPins } = await pinsMod();
  const s = loadPins().selection!;
  assert.equal(s.rule, 'sha256-rank-v1');
  assert.equal(s.seed, 20261018, 'the seed recorded on 2026-10-20, before any rows digest');
});

test('bench select: no id, seed or count from the command line, no other user, and the repo pins write nothing', linux, async () => {
  const { parsePins } = await pinsMod();
  const { main, select } = await cli();
  const b = store();
  for (const argv of [['select', FAKE_ID], ['select', '--seed', '7'], ['select', '--tasks', 'smoke'], [FAKE_ID]]) {
    const out: string[] = [];
    assert.equal(main(argv, cliDeps(b, out) as never), 2, argv.join(' '));
    assert.doesNotMatch(out.join('\n'), TASKISH, `${argv.join(' ')}: nothing shaped like a task is echoed`);
  }
  assert.ok(!existsSync(manifestPath(b.layout)));
  // Another user: refused before the pins are read.
  const other: string[] = [];
  let read = false;
  assert.equal(select(cliDeps(b, other, { user: 'someone-else' }) as never, () => ((read = true), parsePins(pinsText()))), 1);
  assert.match(other.join('\n'), /FAIL/);
  assert.equal(read, false);
  assert.ok(!existsSync(manifestPath(b.layout)));
  // The real command, with the repo's pins (no rows digest yet): refused, nothing written.
  const real: string[] = [];
  assert.equal(main(['select'], cliDeps(b, real) as never), 1, real.join('\n'));
  assert.ok(!existsSync(manifestPath(b.layout)));
});
