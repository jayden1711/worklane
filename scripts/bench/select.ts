// The bench's task selection (#748, slice 3): which SWE-bench Verified tasks a run uses, chosen by a fixed rule from a
// seed, and handed to the run from the held-out store, never from the repo or a command line.
//
// What is pinned (pins.ts, scripts/bench/pins.json): the dataset's revision and sha256, and the selection's rule, seed
// and the canonical digest of the rows the rule reads. Never an instance id: the agents can read the bench user's
// clone, and an id names the upstream PR. The same pins always choose the same tasks, so a rerun on each release uses
// the same task set.
//
// The rows. The rule reads JSON lines (one task per line) with no new dependency. The pinned file upstream is parquet
// (a guess, until the owner pins it), which nothing here reads: the owner converts it once into `rows.jsonl` beside it
// in the store (README step 8), or pins an upstream JSON-lines file, which is then read as it is. Either way the rows
// are pinned by their canonical digest (canonicalRows): each row with only the fields the bench uses, in a fixed order,
// the test lists as compact JSON text, sorted by instance id. So the converter's spelling doesn't matter, and a row the
// digest doesn't cover never reaches the run (the run gets the canonical rows, nothing else).
//
// The rule, sha256-rank-v1: every row's rank is sha256("<seed>:<instance id>") as hex, ascending (ties, which need a
// sha256 collision, by instance id). The first MODE_TASKS.baseline rows, in rank order, are t01, t02, ...; the smoke
// round runs the first MODE_TASKS.smoke of them. A row's rank depends on its own id and the seed only, so the order of
// the file, and rows ranked after the last one taken, change nothing taken.
//
// `bench select` (writeSelection) writes the manifest (each key and its instance id, and the pins it came from) into
// the store, 0600, and never over a different one: grading maps a run's keys to instance ids through it (grade.ts).
// The run (loadTasks) re-reads the rows, re-derives the selection, refuses a manifest that differs, and takes each
// task's image reference from the store's images file (`bench images` writes it, images.ts), through pins.ts pinnedImage (a pinned digest, no tag), only
// when the name is the task's own. Nothing takes an instance id, a seed or a count as an argument.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, linkSync, lstatSync, openSync, readSync, unlinkSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { isMode, type Mode } from './caps.js';
import { alreadyThere, writeVerified } from './download.js';
import type { BenchTask } from './driver.js';
import type { TaskRow } from './hidden.js';
import type { BenchLayout } from './paths.js';
import { pinnedImage, PINS_FILE, requirePinned, type ImageRef, type Pins, type SelectionPin } from './pins.js';
import { heldOutCheck, MANIFEST, type Manifest } from './store.js';

/** How many tasks each kind of run uses (owner, 2026-10-18): a 4-task smoke, a 50-task baseline. The smoke's are the baseline's first. */
export const MODE_TASKS: Readonly<Record<Mode, number>> = Object.freeze({ smoke: 4, baseline: 50 });

/** The converted rows, beside the pinned file in the store's dataset folder (unless that file is JSON lines itself). */
export const ROWS_FILE = 'rows.jsonl';
/** Each task's image reference, `{"<instance id>": "<name>@sha256:<digest>"}`, in the store. */
export const IMAGES_FILE = 'images.json';
/** The most the rows file may hold. */
export const ROWS_MAX_BYTES = 2 ** 30;
/** The most the manifest or the images file may hold. */
const SMALL_MAX_BYTES = 64 * 2 ** 20;

/** The fields every row must have, as text; then the test lists; then the optional ones. The canonical order. */
const TEXT_FIELDS = ['instance_id', 'repo', 'base_commit', 'problem_statement', 'patch', 'test_patch'] as const;
const LIST_FIELDS = ['FAIL_TO_PASS', 'PASS_TO_PASS'] as const;
const MORE_TEXT_FIELDS = ['hints_text', 'difficulty'] as const;
const OPTIONAL_FIELDS = ['version', 'environment_setup_commit'] as const;

/** The manifest as select writes it: the store's Manifest, with the rule and the rows' digest. */
export interface SelectionManifest extends Manifest {
  rule: string;
  rows_sha256: string;
}

/** A task as the run gets it: its key, its canonical row, and its pinned image (as text, and as the checked reference). */
export interface SelectedTask extends BenchTask {
  ref: ImageRef;
}

/** The rows' canonical digest when none is pinned yet: what the owner records, once the rows are checked. */
export class RowsUnpinned extends Error {
  constructor(
    readonly sha256: string,
    readonly rows: number,
  ) {
    super(`the rows are not pinned yet: their canonical sha256 is ${sha256} (${rows} rows). Once you've checked the rows file came from the pinned dataset file, record it as selection.rows_sha256 in ${PINS_FILE} (a reviewed change); nothing selected`);
  }
}

/** A file the store doesn't have. */
class Missing extends Error {}

const hex = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const utf8 = (b: Buffer, what: string): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    throw new Error(`${what} is not UTF-8 text`);
  }
};

/**
 * The bytes of `p`: a regular file of `uid`, mode exactly 0600, at most `max` bytes, opened without following a link.
 * Refuses (throws) anything else; a missing file throws Missing.
 */
function readOwnFile(p: string, uid: number, max: number, what: string): Buffer {
  let fd: number;
  try {
    fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Missing(`${what} is not in the store (${p})`);
    if (code === 'ELOOP') throw new Error(`${what} (${p}) is a link: refused (never followed)`);
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${what} (${p}) is not a regular file`);
    if (st.uid !== uid || (st.mode & 0o7777) !== 0o600) throw new Error(`${what} (${p}) is not a 0600 file of this user: refused (chmod 600 it)`);
    if (st.size > max) throw new Error(`${what} (${p}) is over ${max} bytes`);
    const buf = Buffer.alloc(st.size + 1);
    let n = 0;
    for (let r; n < buf.length && (r = readSync(fd, buf, n, buf.length - n, null)) > 0; ) n += r;
    if (n > st.size) throw new Error(`${what} (${p}) grew while it was read`);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/** A test list (FAIL_TO_PASS, PASS_TO_PASS): a list of text, or JSON text of one; as compact JSON text. */
function testList(v: unknown, field: string, line: number): string {
  let list: unknown = v;
  if (typeof v === 'string') {
    try {
      list = JSON.parse(v);
    } catch {
      throw new Error(`rows line ${line}: ${field} is not a list of tests`);
    }
  }
  if (!Array.isArray(list) || !list.every((t) => typeof t === 'string')) throw new Error(`rows line ${line}: ${field} is not a list of tests`);
  return JSON.stringify(list);
}

/**
 * The rows in `input` (JSON lines), canonical, and their digest. Refuses (throws) the whole file on a line that isn't
 * a JSON object, a missing or mistyped field, an empty instance id, an instance id twice, text that isn't UTF-8, or
 * no rows. Its messages name lines, never a task.
 */
export function canonicalRows(input: string | Buffer): { rows: readonly TaskRow[]; sha256: string } {
  const text = typeof input === 'string' ? input : utf8(input, 'the rows file');
  const rows: TaskRow[] = [];
  const lineOf = new Map<string, number>();
  for (const [i, raw] of text.split('\n').entries()) {
    if (!raw.trim()) continue;
    const line = i + 1;
    let r: unknown;
    try {
      r = JSON.parse(raw);
    } catch {
      throw new Error(`rows line ${line} is not JSON`);
    }
    if (!isObject(r)) throw new Error(`rows line ${line} is not a JSON object`);
    const o: Record<string, string> = {};
    for (const k of TEXT_FIELDS) {
      if (typeof r[k] !== 'string') throw new Error(`rows line ${line}: ${k} is missing or not text`);
      o[k] = r[k];
    }
    for (const k of LIST_FIELDS) o[k] = testList(r[k], k, line);
    for (const k of MORE_TEXT_FIELDS) {
      if (typeof r[k] !== 'string') throw new Error(`rows line ${line}: ${k} is missing or not text`);
      o[k] = r[k];
    }
    for (const k of OPTIONAL_FIELDS) {
      const v = r[k];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'string') throw new Error(`rows line ${line}: ${k} is not text`);
      o[k] = v;
    }
    const id = o.instance_id!;
    if (!id.trim()) throw new Error(`rows line ${line}: the instance id is empty`);
    const first = lineOf.get(id);
    if (first !== undefined) throw new Error(`rows line ${line} repeats the instance id of line ${first}`);
    lineOf.set(id, line);
    rows.push(Object.freeze(o) as unknown as TaskRow);
  }
  if (!rows.length) throw new Error('the rows file has no rows');
  rows.sort((a, b) => (a.instance_id < b.instance_id ? -1 : a.instance_id > b.instance_id ? 1 : 0));
  return { rows: Object.freeze(rows), sha256: hex(rows.map((r) => JSON.stringify(r)).join('\n') + '\n') };
}

/** A task's key: t01, t02, ... (store.ts TASK_KEY). */
const keyOf = (i: number): string => `t${String(i + 1).padStart(2, '0')}`;

/**
 * The tasks `pin` chooses from `rows` (canonicalRows'): the first MODE_TASKS.baseline in its rule's order, keyed t01,
 * t02, ... Refuses (throws) a pin pins.ts didn't build, and too few rows.
 */
export function selectTasks(rows: readonly TaskRow[], pin: SelectionPin): readonly { key: string; row: TaskRow }[] {
  requirePinned(pin, 'selection pin');
  const want = MODE_TASKS.baseline;
  if (rows.length < want) throw new Error(`only ${rows.length} rows: the baseline needs ${want}`);
  let order: TaskRow[];
  switch (pin.rule) {
    case 'sha256-rank-v1': {
      const rank = new Map(rows.map((r) => [r, hex(`${pin.seed}:${r.instance_id}`)]));
      order = [...rows].sort((a, b) => {
        const [x, y] = [rank.get(a)!, rank.get(b)!];
        return x < y ? -1 : x > y ? 1 : a.instance_id < b.instance_id ? -1 : 1;
      });
      break;
    }
    default:
      throw new Error(`selection rule ${String(pin.rule)} is not one this code implements`);
  }
  return Object.freeze(order.slice(0, want).map((row, i) => Object.freeze({ key: keyOf(i), row })));
}

interface Computed {
  tasks: readonly { key: string; row: TaskRow }[];
  /** The manifest's text, as select writes it. */
  text: string;
  rows: number;
  rowsSha256: string;
  revision: string;
  pin: SelectionPin;
}

/**
 * The selection the pins make from the store, as a manifest's text. Refuses (throws) when anything isn't pinned, the
 * store fails the preflight's check, the pinned dataset file isn't there verified, or the rows aren't the pinned ones.
 * Reads only.
 */
function computeSelection(layout: BenchLayout, uid: number, pins: Pins): Computed {
  requirePinned(pins, 'set of pins');
  const dataset = pins.dataset;
  if (!dataset) throw new Error(`the dataset is not pinned yet (${PINS_FILE}): nothing selected`);
  const pin = pins.selection;
  if (!pin) throw new Error(`the selection is not pinned (selection is null in ${PINS_FILE}): nothing selected`);
  heldOutCheck(layout, uid);
  if (!alreadyThere(layout, uid, dataset)) throw new Error('the pinned dataset file is not in the store: run bench download first');
  // A pinned JSON-lines file is the rows itself; anything else (parquet) is converted into ROWS_FILE beside it.
  const rowsFile = join(layout.data, dataset.file.endsWith('.jsonl') ? dataset.file : ROWS_FILE);
  const { rows, sha256 } = canonicalRows(readOwnFile(rowsFile, uid, ROWS_MAX_BYTES, 'the rows file'));
  if (pin.rowsSha256 === null) throw new RowsUnpinned(sha256, rows.length);
  if (sha256 !== pin.rowsSha256) throw new Error(`the rows' canonical sha256 is ${sha256}, not the pinned ${pin.rowsSha256}: nothing selected`);
  const tasks = selectTasks(rows, pin);
  const manifest: SelectionManifest = { dataset_revision: dataset.revision, rule: pin.rule, seed: pin.seed, rows_sha256: sha256, tasks: tasks.map((t) => ({ key: t.key, instance_id: t.row.instance_id })) };
  return { tasks, text: `${JSON.stringify(manifest, null, 2)}\n`, rows: rows.length, rowsSha256: sha256, revision: dataset.revision, pin };
}

/** What `bench select` did: counts, digests and keys only, never an instance id. */
export interface SelectionSummary {
  rows: number;
  rowsSha256: string;
  revision: string;
  rule: string;
  seed: number;
  keys: readonly string[];
  /** false: the same manifest was already there, and was kept. */
  written: boolean;
}

/**
 * `bench select`: the pinned selection's manifest into the store (0600, a verified file under a fresh name, then
 * link()ed to the manifest's name, which never replaces anything), unless the same one is there. Refuses (throws), writing nothing, when computeSelection does, or when a different manifest (or a
 * link) is already at its name: grading maps each run's keys through it, so it is never replaced.
 */
export function writeSelection(layout: BenchLayout, uid: number, pins: Pins): SelectionSummary {
  const c = computeSelection(layout, uid, pins);
  const written = writeOnce(layout, uid, MANIFEST, c.text, { what: 'manifest', why: "grading maps each run's keys through it, so it is never replaced", again: 'select again', command: 'bench select' });
  heldOutCheck(layout, uid);
  return { rows: c.rows, rowsSha256: c.rowsSha256, revision: c.revision, rule: c.pin.rule, seed: c.pin.seed, keys: c.tasks.map((t) => t.key), written };
}

/** How writeOnce's refusals name the file: what it is, why it is never replaced, and what to do after moving it aside. */
export interface OnceWords {
  what: string;
  why: string;
  again: string;
  command: string;
}

/**
 * `text` into the store as `name`, unless the same text is already there: true when it wrote, false when it kept the
 * same file. Refuses (throws) a link at that name, anything there but a 0600 regular file of this user, and a file
 * with other text: it is never replaced. By design, never over anything (#884 round 2): the verified file
 * (download.ts writeVerified: created exclusively, never through a link, 0600, read back) is made under a fresh name,
 * then linked to `name`, which fails if anything (a file, a link, a dangling link) has appeared there since the lstat.
 */
export function writeOnce(layout: BenchLayout, uid: number, name: string, text: string, words: OnceWords): boolean {
  const f = join(layout.heldOut, name);
  let st: Stats | null = null;
  try {
    st = lstatSync(f);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (st) {
    if (st.isSymbolicLink()) throw new Error(`${f} is a link: refused (never followed); look at it, then move it aside`);
    if (readOwnFile(f, uid, SMALL_MAX_BYTES, `the ${words.what}`).toString('utf8') !== text) {
      throw new Error(`the store already has a different ${words.what} (${f}): ${words.why}; move it aside to ${words.again}`);
    }
    return false;
  }
  const fresh = join(layout.heldOut, `.${name}.${randomBytes(8).toString('hex')}.new`);
  writeVerified(fresh, layout.heldOut, Buffer.from(text), hex(text), uid);
  try {
    linkSync(fresh, f);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${f} appeared while ${words.command} ran: refused, never replaced; look at it, then move it aside`);
    throw e;
  } finally {
    unlinkSync(fresh);
  }
  return true;
}

/**
 * The selection's tasks, in key order, as the store's manifest holds them: the rows re-read and checked against their
 * pin, the selection re-derived, and the manifest `bench select` wrote checked to be exactly that. Refuses (throws) when
 * computeSelection does, when there is no manifest, or when it differs. Reads only. The run (loadTasks) and
 * `bench images` (images.ts) both take their tasks here.
 */
export function selectedTasks(layout: BenchLayout, uid: number, pins: Pins): readonly { key: string; row: TaskRow }[] {
  const c = computeSelection(layout, uid, pins);
  let manifest: string;
  try {
    manifest = readOwnFile(join(layout.heldOut, MANIFEST), uid, SMALL_MAX_BYTES, 'the manifest').toString('utf8');
  } catch (e) {
    if (e instanceof Missing) throw new Error('no task manifest in the store: run bench select first');
    throw e;
  }
  if (manifest !== c.text) throw new Error("the store's manifest is not what the pins select now (another seed, rule or rows since bench select, or an edit): move it aside and run bench select");
  return c.tasks;
}

/** Whether image `name` is the one SWE-bench names after `instanceId`: its last part is, or ends in `.`, the id in lower case with `__` as `_1776_`. */
export function imageNamesTask(name: string, instanceId: string): boolean {
  const last = name.split('/').at(-1) ?? '';
  const want = instanceId.toLowerCase().split('__').join('_1776_');
  return last === want || last.endsWith(`.${want}`);
}

/**
 * The run's tasks (`mode`: the first MODE_TASKS[mode] of the selection), from the store only: the rows re-read and
 * checked against their pin, the selection re-derived and checked against the manifest `bench select` wrote, and each
 * task's image reference read from the images file and taken only through pinnedImage (a pinned digest, no tag), when
 * its name is the task's own and no other task of the run has its digest. Refuses (throws) otherwise; its messages
 * name keys, never a task. Nothing here comes from a command line.
 */
export function loadTasks(layout: BenchLayout, uid: number, pins: Pins, mode: Mode): readonly SelectedTask[] {
  if (!isMode(mode)) throw new Error('the task set is smoke or baseline');
  const tasks = selectedTasks(layout, uid, pins);
  let images: unknown;
  try {
    images = JSON.parse(utf8(readOwnFile(join(layout.heldOut, IMAGES_FILE), uid, SMALL_MAX_BYTES, 'the images file'), 'the images file'));
  } catch (e) {
    if (e instanceof SyntaxError) throw new Error('the images file is not JSON');
    throw e;
  }
  if (!isObject(images)) throw new Error('the images file is not a JSON object of instance id to image reference');
  const byDigest = new Map<string, string>();
  const out = tasks.slice(0, MODE_TASKS[mode]).map((t): SelectedTask => {
    const id = t.row.instance_id;
    const v = Object.hasOwn(images as object, id) ? (images as Record<string, unknown>)[id] : undefined;
    if (typeof v !== 'string') throw new Error(`${t.key}: the images file has no image reference for this task`);
    let ref: ImageRef;
    try {
      ref = pinnedImage(v, pins);
    } catch {
      // pinnedImage's own message quotes the reference, which names the task: never passed on.
      throw new Error(`${t.key}: its image reference is refused: only <name>@sha256:<digest>, with the digest one of the pinned image_digests`);
    }
    if (!imageNamesTask(ref.name, id)) throw new Error(`${t.key}: its image's name is not this task's (SWE-bench names a task's image after its instance id)`);
    const other = byDigest.get(ref.digest);
    if (other) throw new Error(`${t.key}: its image digest is ${other}'s too: each task has its own image`);
    byDigest.set(ref.digest, t.key);
    return Object.freeze({ key: t.key, row: t.row, image: `${ref.name}@${ref.digest}`, ref });
  });
  return Object.freeze(out);
}
