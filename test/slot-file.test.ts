// writeSlotFile (#661), the one way to write a file in the slot dir: whole or not at all, over a 0444 file, and
// nothing left behind. test/slot-dir-writes.test.ts checks that nothing else writes there.
//
// The helper itself is judged by what it does, not by its syntax: the last tests record every fs call writeSlotFile
// makes, in each mode and on each failure, and assert the exact sequence (one exclusive create, everything else
// through the descriptor it returned, then the rename or link). They see each call of a function of node:fs or
// node:fs/promises, however the helper got it, a module-level alias included (the helper is loaded with the
// recording wrappers in place). They don't see fs reached past those modules (process.binding), and they check only
// the paths they drive: another export of the helper, or a branch none of the cases takes, is not checked (Known gap
// in #766, and #772).
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { type SlotWrite, writeSlotFile } from '../src/slot-file.js';
import './helpers.js';

const skip = process.platform === 'win32' ? 'file modes' : process.getuid?.() === 0 ? 'root ignores file modes' : false;

/** A fresh dir inside the test's own (temporary) AGENT_SLOTS_DIR. */
const slotDir = () => mkdtempSync(join(process.env.AGENT_SLOTS_DIR!, 'slot-file-'));

const temps = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.tmp'));

type Fns = Record<string, (...a: never[]) => unknown>;

/** Run `fn` with some functions of a built-in module replaced (its ESM bindings too, as the helper imports them). */
function patched<T>(mod: 'node:fs' | 'node:crypto', with_: Record<string, (real: (...a: never[]) => unknown) => (...a: never[]) => unknown>, fn: () => T): T {
  const m = createRequire(import.meta.url)(mod) as Fns;
  const saved = new Map(Object.keys(with_).map((n) => [n, m[n]!]));
  for (const [n, make] of Object.entries(with_)) m[n] = make(saved.get(n)!);
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    for (const [n, real] of saved) m[n] = real;
    syncBuiltinESMExports();
  }
}

/** A file of the writer's own, outside the slot dir: what a swapped-in symlink would point at. */
function ownFile(): string {
  const f = join(mkdtempSync(join(process.env.AGENT_SLOTS_DIR!, 'own-')), 'secret');
  writeFileSync(f, 'secret', { mode: 0o600 });
  chmodSync(f, 0o600);
  return f;
}

test('writeSlotFile replaces a 0444 file, with exactly the mode asked for, and leaves no temp file', { skip }, () => {
  const dir = slotDir();
  const file = join(dir, 'state.json');
  writeSlotFile(file, 'one');
  chmodSync(file, 0o444);
  writeSlotFile(file, 'two', { mode: 0o660, exactMode: true });
  assert.equal(readFileSync(file, 'utf8'), 'two');
  assert.equal(statSync(file).mode & 0o777, 0o660);
  assert.deepEqual(temps(dir), []);
});

test('writeSlotFile with replace false creates a file only when there is none (a lock), and leaves no temp file', { skip }, () => {
  const dir = slotDir();
  const lock = join(dir, 'x.lock');
  writeSlotFile(lock, 'mine', { replace: false });
  assert.equal(readFileSync(lock, 'utf8'), 'mine');
  assert.throws(() => writeSlotFile(lock, 'theirs', { replace: false }), { code: 'EEXIST' });
  assert.equal(readFileSync(lock, 'utf8'), 'mine', 'a lock already there is left as it is');
  assert.deepEqual(temps(dir), []);
});

test('exactMode sets the mode through its own descriptor: a temp file swapped for a symlink before the chmod leaves the link target as it was', { skip }, () => {
  const dir = slotDir();
  const own = ownFile();
  let swapped = 0;
  // The slot dir is group-writable without the sticky bit: another member can replace the temp file's name with a
  // symlink between its creation and its chmod. Whichever call the helper sets the mode with, the swap is done first.
  const swapFirst =
    (real: (...a: never[]) => unknown) =>
    (...a: never[]) => {
      for (const t of temps(dir)) {
        unlinkSync(join(dir, t));
        symlinkSync(own, join(dir, t));
        swapped++;
      }
      return real(...a);
    };
  patched('node:fs', { chmodSync: swapFirst, fchmodSync: swapFirst }, () => writeSlotFile(join(dir, 'github-budget-k.json'), '{}', { mode: 0o660, exactMode: true }));
  assert.equal(swapped, 1, 'the temp file was swapped before its mode was set');
  assert.equal((statSync(own).mode & 0o777).toString(8), '600', "the writer's own file keeps its mode");
  assert.equal(readFileSync(own, 'utf8'), 'secret', 'and its content');
});

test('a temp name that is taken (here a planted symlink) is skipped: never opened, written or removed', { skip }, () => {
  const dir = slotDir();
  const own = ownFile();
  const fixed = Buffer.alloc(8, 0xab);
  const planted = join(dir, `f.json.${process.pid}.${fixed.toString('hex')}.tmp`);
  symlinkSync(own, planted);
  let calls = 0;
  patched('node:crypto', { randomBytes: (real) => (...a: never[]) => (calls++ === 0 ? Buffer.from(fixed) : real(...a)) }, () => writeSlotFile(join(dir, 'f.json'), 'new'));
  assert.equal(calls, 2, 'a second name was drawn');
  assert.equal(readFileSync(join(dir, 'f.json'), 'utf8'), 'new');
  assert.equal(lstatSync(join(dir, 'f.json')).isSymbolicLink(), false);
  assert.equal(lstatSync(planted).isSymbolicLink(), true, 'the planted link is left where it is');
  assert.equal(readFileSync(own, 'utf8'), 'secret', 'and what it points at is not written');
  assert.deepEqual(temps(dir), [planted.slice(dir.length + 1)], 'no temp file of its own left');
});

test('a failed rename or link leaves no temp file', { skip }, () => {
  const dir = slotDir();
  const fail = (code: string) => () => () => {
    throw Object.assign(new Error(`simulated ${code}`), { code });
  };
  patched('node:fs', { renameSync: fail('EXDEV'), linkSync: fail('EPERM') }, () => {
    assert.throws(() => writeSlotFile(join(dir, 'a.json'), 'x'), { code: 'EXDEV' });
    assert.throws(() => writeSlotFile(join(dir, 'b.lock'), 'x', { replace: false }), { code: 'EPERM' });
  });
  assert.deepEqual(readdirSync(dir), []);
});

test('writeSlotFile into a missing directory throws and creates nothing', () => {
  const dir = slotDir();
  assert.throws(() => writeSlotFile(join(dir, 'missing', 'x.json'), 'x'), { code: 'ENOENT' });
  assert.equal(existsSync(join(dir, 'missing')), false);
  assert.deepEqual(readdirSync(dir), []);
});

// ---------------------------------------------------------------------------------------------------------------
// Every fs call writeSlotFile makes (#766 review, round 4: this replaces the lint's syntax rule for the helper).

type Write = typeof writeSlotFile;

interface Call {
  name: string;
  args: unknown[];
  /** What an openSync returned. */
  fd?: number;
  /** The code of what it threw. */
  error?: string;
}

/** Make the first `times` calls of fs's `name` throw `code` instead of running. */
type Fail = { name: string; code: string; times?: number };

const DATA = 'slot-file-call-test-data';

/** The recording under way, if any. */
let recording: { calls: Call[]; depth: number; fail: Fail | undefined; failed: number } | null = null;

/**
 * Every function of node:fs and node:fs/promises, with a wrapper that records its calls while `recording` is set and
 * otherwise just calls it. Classes (Stats, ReadStream, ...) are left as they are. A call made inside another fs call
 * (writeFileSync calling writeSync) is fs's own, not the caller's, and is not recorded. The wrappers are made once:
 * a module loaded while they are in place keeps them in anything it took from fs then (`const w = writeFileSync`).
 */
const WRAPPERS = (() => {
  const req = createRequire(import.meta.url);
  const out: { mod: Fns; name: string; real: Fns[string]; wrapper: Fns[string] }[] = [];
  for (const mod of [req('node:fs'), req('node:fs/promises')] as Fns[]) {
    for (const name of Object.keys(mod)) {
      const real = mod[name];
      if (typeof real !== 'function' || /^[A-Z]/.test(name)) continue;
      const wrapper = function (this: unknown, ...args: never[]): unknown {
        const r = recording;
        if (!r || r.depth > 0) return Reflect.apply(real, this, args);
        const c: Call = { name, args: [...args] };
        r.calls.push(c);
        r.depth++;
        try {
          if (r.fail?.name === name && r.failed < (r.fail.times ?? 1)) {
            r.failed++;
            throw Object.assign(new Error(`simulated ${r.fail.code}`), { code: r.fail.code });
          }
          const result = Reflect.apply(real, this, args);
          if (name === 'openSync') c.fd = result as number;
          return result;
        } catch (e) {
          c.error = (e as NodeJS.ErrnoException).code ?? String(e);
          throw e;
        } finally {
          r.depth--;
        }
      };
      out.push({ mod, name, real, wrapper: Object.assign(wrapper, real) });
    }
  }
  return out;
})();

/** Put the wrappers in place of fs's functions (their ESM bindings too, which is how the helper imports them), or back. */
function wrappers(on: boolean): void {
  for (const w of WRAPPERS) w.mod[w.name] = on ? w.wrapper : w.real;
  syncBuiltinESMExports();
}

/** Load a module (a fresh instance) while the wrappers are in place. */
async function loadWrapped(url: string): Promise<Write> {
  wrappers(true);
  try {
    return ((await import(url)) as { writeSlotFile: Write }).writeSlotFile;
  } finally {
    wrappers(false);
  }
}

/** The helper under test: a fresh instance of src/slot-file.ts, loaded with the wrappers in place. */
const helper = await loadWrapped(new URL('../src/slot-file.js?fs-calls', import.meta.url).href);

/** Run `write` and return the fs calls it made, in order, and the code of what it threw. */
function recordCalls(write: Write, file: string, o: SlotWrite, fail?: Fail): { calls: Call[]; error?: string } {
  const r = (recording = { calls: [], depth: 0, fail, failed: 0 });
  wrappers(true);
  try {
    write(file, DATA, o);
    return { calls: r.calls };
  } catch (e) {
    return { calls: r.calls, error: (e as NodeJS.ErrnoException).code ?? String(e) };
  } finally {
    wrappers(false);
    recording = null;
  }
}

/**
 * The calls as text: the temp names TMP, TMP2, ... in the order they appear; the target FILE; the content DATA; the
 * descriptor the first open returned FD, any other `fd <n>`; any other number (a mode) in octal.
 */
function render(calls: Call[], file: string): string[] {
  const tmpName = new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.${process.pid}\\.[0-9a-f]{16}\\.tmp$`);
  const tmps: string[] = [];
  const fd = calls.find((c) => c.name === 'openSync' && c.fd !== undefined)?.fd;
  const showFd = (n: number) => (n === fd ? 'FD' : `fd ${n}`);
  const show = (v: unknown, i: number): string => {
    if (typeof v === 'number') return i === 0 ? showFd(v) : `0o${v.toString(8)}`;
    if (typeof v !== 'string') return v === undefined ? 'undefined' : JSON.stringify(v);
    if (v === file) return 'FILE';
    if (v === DATA) return 'DATA';
    if (!tmpName.test(v)) return JSON.stringify(v);
    if (!tmps.includes(v)) tmps.push(v);
    return tmps.indexOf(v) === 0 ? 'TMP' : `TMP${tmps.indexOf(v) + 1}`;
  };
  return calls.map((c) => `${c.name}(${c.args.map(show).join(', ')})${c.error ? ` throws ${c.error}` : c.fd !== undefined ? ` -> ${showFd(c.fd)}` : ''}`);
}

/**
 * Which of the helper's rules a call sequence breaks, one line per offending call ([] when it keeps them all):
 * - every call on a descriptor uses the one the exclusive open returned;
 * - every open is an exclusive create (flag 'wx') of a new temp name beside the file;
 * - nothing touches a file by name (the temp file, the target or any other) before the rename or link, but the
 *   open and, once something has failed, the removal of its own temp file;
 * - after the close, only the rename or link of the temp file to the target, and the removal of the temp file.
 */
function broken(calls: Call[], shown: string[], file: string): string[] {
  const out: string[] = [];
  const opened = calls.findIndex((c) => c.name === 'openSync' && c.fd !== undefined);
  const fd = calls[opened]?.fd;
  const tmp = calls[opened]?.args[0];
  const place = calls.findIndex((c) => c.name === 'renameSync' || c.name === 'linkSync');
  const closed = calls.findIndex((c) => c.name === 'closeSync' && c.args[0] === fd);
  const cleanup = (c: Call, i: number) => c.name === 'rmSync' && c.args[0] === tmp && calls.slice(opened + 1, i).some((x) => x.error);
  calls.forEach((c, i) => {
    const byName = typeof c.args[0] !== 'number';
    if (!byName && c.args[0] !== fd) out.push(`${shown[i]}: a descriptor other than the one its exclusive open returned`);
    if (c.name === 'openSync' && (c.args[1] !== 'wx' || typeof c.args[0] !== 'string' || !shown[i]!.startsWith('openSync(TMP'))) out.push(`${shown[i]}: not an exclusive create (flag "wx") of a new temp name`);
    if (byName && c.name !== 'openSync' && (place === -1 || i < place) && !cleanup(c, i)) out.push(`${shown[i]}: touches a file by name before the rename or link`);
    if (closed !== -1 && i > closed && !(((c.name === 'renameSync' || c.name === 'linkSync') && c.args[0] === tmp && c.args[1] === file) || (c.name === 'rmSync' && c.args[0] === tmp))) out.push(`${shown[i]}: after its descriptor is closed`);
  });
  if (fd !== undefined && closed === -1) out.push('its descriptor is never closed');
  return out;
}

interface Case {
  name: string;
  o: SlotWrite;
  expected: string[];
  fail?: Fail;
  throws?: string;
  /** The target exists before the write. */
  exists?: boolean;
}

const OPEN = 'openSync(TMP, "wx", 0o666) -> FD';
const RM = 'rmSync(TMP, {"force":true})';
const CASES: Case[] = [
  { name: 'by default: create, write, close, rename', o: {}, expected: [OPEN, 'writeFileSync(FD, DATA)', 'closeSync(FD)', 'renameSync(TMP, FILE)'] },
  { name: 'with a mode: it goes to the open (the umask applies)', o: { mode: 0o640 }, expected: ['openSync(TMP, "wx", 0o640) -> FD', 'writeFileSync(FD, DATA)', 'closeSync(FD)', 'renameSync(TMP, FILE)'] },
  { name: 'exactMode: fchmod on the descriptor, before the write', o: { mode: 0o660, exactMode: true }, expected: ['openSync(TMP, "wx", 0o660) -> FD', 'fchmodSync(FD, 0o660)', 'writeFileSync(FD, DATA)', 'closeSync(FD)', 'renameSync(TMP, FILE)'] },
  { name: 'replace false: link, then remove the temp name', o: { replace: false }, expected: [OPEN, 'writeFileSync(FD, DATA)', 'closeSync(FD)', 'linkSync(TMP, FILE)', RM] },
  { name: 'the open fails: nothing else', o: {}, fail: { name: 'openSync', code: 'EACCES' }, throws: 'EACCES', expected: ['openSync(TMP, "wx", 0o666) throws EACCES'] },
  { name: 'the temp name is taken: a new one, the taken one never touched', o: {}, fail: { name: 'openSync', code: 'EEXIST' }, expected: ['openSync(TMP, "wx", 0o666) throws EEXIST', 'openSync(TMP2, "wx", 0o666) -> FD', 'writeFileSync(FD, DATA)', 'closeSync(FD)', 'renameSync(TMP2, FILE)'] },
  { name: 'three taken names: it gives up', o: {}, fail: { name: 'openSync', code: 'EEXIST', times: 3 }, throws: 'EEXIST', expected: ['TMP', 'TMP2', 'TMP3'].map((t) => `openSync(${t}, "wx", 0o666) throws EEXIST`) },
  { name: 'the fchmod fails: close, remove the temp file', o: { mode: 0o660, exactMode: true }, fail: { name: 'fchmodSync', code: 'EPERM' }, throws: 'EPERM', expected: ['openSync(TMP, "wx", 0o660) -> FD', 'fchmodSync(FD, 0o660) throws EPERM', 'closeSync(FD)', RM] },
  { name: 'the write fails: close, remove the temp file', o: {}, fail: { name: 'writeFileSync', code: 'ENOSPC' }, throws: 'ENOSPC', expected: [OPEN, 'writeFileSync(FD, DATA) throws ENOSPC', 'closeSync(FD)', RM] },
  { name: 'the rename fails: remove the temp file', o: {}, fail: { name: 'renameSync', code: 'EXDEV' }, throws: 'EXDEV', expected: [OPEN, 'writeFileSync(FD, DATA)', 'closeSync(FD)', 'renameSync(TMP, FILE) throws EXDEV', RM] },
  { name: 'replace false and the file exists (a lock held): remove the temp file', o: { replace: false }, exists: true, throws: 'EEXIST', expected: [OPEN, 'writeFileSync(FD, DATA)', 'closeSync(FD)', 'linkSync(TMP, FILE) throws EEXIST', RM] },
];

/** Run one case against `write` in a fresh slot dir; throws an AssertionError naming what is wrong. */
function checkCase(write: Write, c: Case): void {
  const dir = slotDir();
  const file = join(dir, 'f.json');
  if (c.exists) writeFileSync(file, 'held');
  const { calls, error } = recordCalls(write, file, c.o, c.fail);
  const shown = render(calls, file);
  const bad = broken(calls, shown, file);
  assert.deepEqual(bad, [], `${c.name}:\n${bad.join('\n')}\n-- the calls:\n${shown.join('\n')}`);
  assert.deepEqual(shown, c.expected, c.name);
  assert.equal(error, c.throws, c.name);
  assert.deepEqual(temps(dir), [], `${c.name}: no temp file left`);
}

for (const c of CASES) test(`writeSlotFile's fs calls, ${c.name}`, () => checkCase(helper, c));

/**
 * A wrong helper, for the check to fail: the compiled helper with each `from` swapped for `to`, written as a module
 * of its own in a temp dir (src/ is untouched) and loaded the way the helper under test is.
 */
async function variant(name: string, swaps: [from: string, to: string][]): Promise<Write> {
  let text = readFileSync(new URL('../src/slot-file.js', import.meta.url), 'utf8').replace(/^\/\/# sourceMappingURL=.*$/m, '');
  for (const [from, to] of swaps) {
    assert.equal(text.split(from).length, 2, `${name}: ${from} is in the compiled helper exactly once (if the helper changed, update this variant)`);
    text = text.replace(from, () => to);
  }
  const f = join(mkdtempSync(join(process.env.AGENT_SLOTS_DIR!, 'variant-')), `${name}.mjs`);
  writeFileSync(f, text);
  return loadWrapped(pathToFileURL(f).href);
}

const checkAll = (write: Write) => {
  for (const c of CASES) checkCase(write, c);
};

test('the fs-call check passes an unchanged copy of the helper, loaded the way the wrong variants below are (a control)', async () => {
  checkAll(await variant('copy', []));
});

test('the fs-call check fails a helper that sets the mode by name (chmodSync(tmp))', async () => {
  const w = await variant('chmod-by-name', [
    ['import { closeSync, fchmodSync,', 'import { chmodSync, closeSync, fchmodSync,'],
    ['fchmodSync(fd, exact);', 'chmodSync(tmp, exact);'],
  ]);
  assert.throws(() => checkAll(w), /chmodSync\(TMP, 0o660\): touches a file by name before the rename or link/);
});

test('the fs-call check fails a helper that writes to another descriptor', async () => {
  const w = await variant('other-fd', [['writeFileSync(fd, data);', "{ const other = openSync(tmp, 'r+'); writeFileSync(other, data); closeSync(other); }"]]);
  assert.throws(() => checkAll(w), /writeFileSync\(fd \d+, DATA\): a descriptor other than the one its exclusive open returned/);
});

test('the fs-call check fails a helper that uses its descriptor after closing it', async () => {
  const w = await variant('op-after-close', [['closeSync(fd);', 'closeSync(fd); fchmodSync(fd, mode);']]);
  assert.throws(() => checkAll(w), /fchmodSync\(FD, 0o666\) throws EBADF: after its descriptor is closed/);
});

test("the fs-call check fails a helper whose open is not exclusive (flag 'w', not 'wx')", async () => {
  const w = await variant('no-wx', [["openSync(tmp, 'wx', mode)", "openSync(tmp, 'w', mode)"]]);
  assert.throws(() => checkAll(w), /openSync\(TMP, "w", 0o666\) -> FD: not an exclusive create \(flag "wx"\) of a new temp name/);
});

test('the fs-call check fails a helper that keeps an fs function from load time and calls it through Reflect.apply', async () => {
  const w = await variant('kept-chmod', [
    ['import { closeSync, fchmodSync,', 'import { chmodSync, closeSync, fchmodSync,'],
    ["from 'node:fs';", "from 'node:fs';\nconst keptChmod = chmodSync;"],
    ['fchmodSync(fd, exact);', '{ fchmodSync(fd, exact); Reflect.apply(keptChmod, undefined, [tmp, exact]); }'],
  ]);
  assert.throws(() => checkAll(w), /chmodSync\(TMP, 0o660\): touches a file by name before the rename or link/);
});
