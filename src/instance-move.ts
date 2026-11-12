// `export` / `import`: move an instance's config and history from one machine to another (a laptop in local mode to
// a server), with no ssh between them: one file, carried however you like.
//
// The bundle (gzipped JSON) holds the state dir (the event log as a consistent snapshot, init's checklist, the main
// watch's place, findings) and the repo's config dir. Never secrets or what belongs to this machine alone: the
// dashboard token, anything named like a token, key or credential, locks, logs, worktrees, slots. What was left out is
// listed, never silently dropped.
//
// Import writes the state into the target's state dir and refuses one that already has history (--force replaces
// it). The config dir is the repo's, kept in git: written only into a checkout that has none; otherwise the files
// that differ are listed, to commit in a PR.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { openWaiting } from './events/open.js';
import { BRAND } from './brand.js';
import { writeGroupOnly, writeOwnerOnly } from './os/index.js';
import { isNativeGuardPath } from './slot-file.js';
import { OFF_FILE } from './flags.js';

export const BUNDLE_FORMAT = `${BRAND.cli}-bundle`;
const EVENTS = 'events.db';

/** Left out of a bundle: secrets, and what only makes sense on the machine it was made on. */
const LEAVE_OUT: [RegExp, string][] = [
  [/(^|\/)dashboard-token$|token|secret|credential|\.pem$|\.key$/i, 'a secret'],
  [/\.lock$|\.lock\/|(^|\/)locks?\//, 'a lock'],
  [/\.log(\.\d+)?$/, 'a log'],
  [/(^|\/)(worktrees|slots|tasks|dep-cache|chat\/pending)\//, "this machine's working files"],
  [/\.tmp$|\.import-old$|-wal$|-shm$|-journal$|(^|\/)\.[^/]+\.[0-9a-f]{16}\.new$/, 'a temporary file'],
  // Removed with Siri (#743): its device store is never carried, so no bundle brings a live device to an older engine.
  [/^siri(\/|$)|^siri-gateway-token$/, 'removed with Siri (#743)'],
];

/** The state files the flags and the log are kept in: never under another name, never a folder (R1173al AL1, R1173an AN2). */
const RESERVED = [EVENTS, OFF_FILE];
/**
 * Why a state path (relative to the state folder) is never in a bundle, or null. One rule for both ends: export leaves
 * such a path out and says why, and import refuses it, so an import accepts only what export writes (R1173am, R1173an:
 * a hand-made bundle's names were each a new way past the import's checks).
 */
export function statePathProblem(p: string): string | null {
  if (isNativeGuardPath(p)) return 'a machine-local native lock guard';
  const lower = p.toLowerCase();
  const left = LEAVE_OUT.find(([re]) => re.test(p) || re.test(lower))?.[1];
  if (left) return left;
  const segs = p.split('/');
  // R1173an AN1, R1173am AM2: plain ASCII names only. A case-insensitive volume folds more than ASCII case (`ſ` is `s`),
  // so a lowercase compare is exact only for ASCII names.
  if (segs.some((s) => !/^[\x20-\x7e]+$/.test(s))) return "a name that isn't plain ASCII";
  if (RESERVED.some((n) => lower === n && p !== n)) return "a case variant of a reserved state file's name";
  // R1173an AN2: a reserved name (or a temporary file's) as a folder: written as one, it lost the bundle's pending offs
  // and blocked every later import.
  if (segs.slice(0, -1).some((s) => RESERVED.includes(s.toLowerCase()) || /\.import-old$|-wal$|-shm$|-journal$/.test(s.toLowerCase()))) return "a reserved state file's name used as a folder";
  return null;
}
/**
 * The subset of statePathProblem an import refuses outright (the whole bundle), not just skips: each would land on, or
 * be read over, the log or its off file (R1173al AL1, AL2, R1173am AM2, R1173an AN1, AN2). Other paths export leaves
 * out (a secret, a lock, an older engine's Siri files) are skipped, with why, as before.
 */
function refusedStatePath(p: string): string | null {
  const why = statePathProblem(p);
  if (!why) return null;
  const lower = p.toLowerCase();
  if (why !== 'a temporary file' && why !== "a name that isn't plain ASCII" && !/reserved/.test(why)) return null;
  if (why === 'a temporary file' && !/\.import-old$|-wal$|-shm$|-journal$/.test(lower)) return null;
  return why;
}

export interface BundleFile {
  /** state/<path> or config/<path>, with forward slashes. */
  path: string;
  data: string;
}
export interface Bundle {
  format: typeof BUNDLE_FORMAT;
  version: 1;
  createdAt: string;
  from: { repo: string | null; host: string };
  files: BundleFile[];
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    const st = statSync(p);
    return st.isDirectory() ? walk(p).map((x) => `${f}/${x}`) : st.isFile() ? [f] : [];
  });
}
const posix = (p: string) => p.split(sep).join('/');

/** The event log as one consistent file, even while a coordinator writes to it. */
function snapshot(db: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'export-'));
  try {
    const d = openWaiting(db);
    try {
      d.exec(`VACUUM INTO '${join(dir, EVENTS).replace(/'/g, "''")}'`);
    } finally {
      d.close();
    }
    return readFileSync(join(dir, EVENTS));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function exportBundle(o: { stateDir: string; root: string | null; repo: string | null; host: string; out: string; now?: Date }): { file: string; files: string[]; left: { path: string; why: string }[] } {
  const files: BundleFile[] = [];
  const left: { path: string; why: string }[] = [];
  for (const p of walk(o.stateDir).map(posix).sort()) {
    // The event log's own WAL and shared-memory files are in its snapshot already.
    if (p === `${EVENTS}-wal` || p === `${EVENTS}-shm`) continue;
    const why = statePathProblem(p);
    if (why) {
      left.push({ path: `state/${p}`, why });
      continue;
    }
    const data = p === EVENTS ? snapshot(join(o.stateDir, p)) : readFileSync(join(o.stateDir, p));
    files.push({ path: `state/${p}`, data: data.toString('base64') });
  }
  const cfgDir = o.root ? join(o.root, BRAND.configDir) : null;
  for (const p of cfgDir ? walk(cfgDir).map(posix).sort() : []) {
    if (isNativeGuardPath(p)) left.push({ path: `config/${p}`, why: 'a machine-local native lock guard' });
    else files.push({ path: `config/${p}`, data: readFileSync(join(cfgDir!, p)).toString('base64') });
  }
  const bundle: Bundle = { format: BUNDLE_FORMAT, version: 1, createdAt: (o.now ?? new Date()).toISOString(), from: { repo: o.repo, host: o.host }, files };
  mkdirSync(dirname(o.out), { recursive: true });
  // The history names people and issues: the bundle is its maker's alone.
  writeOwnerOnly(o.out, gzipSync(JSON.stringify(bundle)).toString('base64'));
  return { file: o.out, files: files.map((f) => f.path), left };
}

export function readBundle(file: string): Bundle {
  let b: Bundle;
  try {
    b = JSON.parse(gunzipSync(Buffer.from(readFileSync(file, 'utf8'), 'base64')).toString('utf8')) as Bundle;
  } catch {
    throw new Error(`${file} is not a ${BRAND.cli} export bundle`);
  }
  if (b.format !== BUNDLE_FORMAT) throw new Error(`${file} is not a ${BRAND.cli} export bundle`);
  if (b.version !== 1) throw new Error(`${file} is a version ${b.version} bundle; this engine reads version 1: update the engine`);
  for (const f of b.files) {
    if (!/^(state|config)\//.test(f.path) || f.path.split('/').some((s) => s === '..' || s === '.' || s === '') || f.path.includes('\\')) throw new Error(`${file}: refused, a path outside the bundle's places: ${f.path}`);
    // Only what export writes (statePathProblem): a case variant of the log or its off file (on a case-insensitive volume
    // the same file, R1173al AL1), the log's -wal, -shm or -journal (read over its log), a reserved name as a folder.
    const why = f.path.startsWith('state/') ? refusedStatePath(f.path.slice('state/'.length)) : null;
    if (why) throw new Error(`${file}: refused, ${why} (an import takes only what export writes): ${f.path}`);
  }
  // A file and a path under it can't both be written (R1173an AN2: the second one is written into the first as a folder).
  const paths = new Set(b.files.map((f) => f.path.toLowerCase()));
  for (const f of b.files) {
    const segs = f.path.toLowerCase().split('/');
    for (let k = 1; k < segs.length; k++) if (paths.has(segs.slice(0, k).join('/'))) throw new Error(`${file}: refused, a path under another file of the bundle: ${f.path}`);
  }
  return b;
}

export interface ImportResult {
  state: string[];
  config: string[];
  /** Config files the target already has, differently: the repo's, to commit in a PR. */
  configDiffers: string[];
  skipped: { path: string; why: string }[];
}

export function importBundle(o: { file: string; stateDir: string; root: string | null; instance: boolean; force?: boolean }): ImportResult {
  const b = readBundle(o.file);
  if (existsSync(join(o.stateDir, EVENTS)) && !o.force) throw new Error(`${o.stateDir} already has history (${EVENTS}): nothing imported. Pass --force to replace it (export it first if it matters)`);
  const r: ImportResult = { state: [], config: [], configDiffers: [], skipped: [] };
  // R1173an AN2c: the target's off file and its aside, when there, are plain files (a folder or a link there, from a
  // bundle before this check, made every import fail midway): refused before anything is written.
  for (const n of [OFF_FILE, `${OFF_FILE}.import-old`]) {
    let st: ReturnType<typeof lstatSync> | null = null;
    try {
      st = lstatSync(join(o.stateDir, n));
    } catch {
      st = null; // not there
    }
    if (st && !st.isFile()) throw new Error(`${join(o.stateDir, n)} is not a plain file: remove it by hand, then import again. Nothing imported`);
  }
  // R1173al AL2: a log replaced while its old WAL remains is read through that WAL (SQLite replays it onto the new file).
  // Fold a dead process's WAL into the old log first; one another process still holds open stays: refuse.
  const db = join(o.stateDir, EVENTS);
  // R1173am AM1: a hot rollback journal (a coordinator killed in its first open, before WAL) is rolled back onto whatever
  // file is at the log's path when it is next opened: opened here first, so it rolls back into the old log, not the new one.
  const sidecars = () => ['-wal', '-shm', '-journal'].some((x) => existsSync(`${db}${x}`));
  if (b.files.some((f) => f.path === `state/${EVENTS}`) && sidecars()) {
    if (existsSync(db)) {
      const d = openWaiting(db);
      try {
        d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } finally {
        d.close();
      }
    }
    // A WAL without its log (the log moved aside by hand) can't be folded in: refused too.
    if (sidecars()) throw new Error(existsSync(db) ? `${db} is open in another process (its -wal, -shm or -journal is still there): stop the coordinator and the dashboard, then import again. Nothing imported` : `${db}-wal, -shm or -journal is there without its log (moved aside?): put the log back, or move them aside with it, then import again. Nothing imported`);
  }
  // The flags' unrecorded offs belong to the log they were made beside (R1173x X2), and an import brings another log, with
  // --force or after the old one was moved aside (R1173y Y-2): gone at every import; the bundle's own, from the log it
  // carries, comes in with that log. R1173aa AA-2: only when the bundle carries a log; one with none leaves the target's
  // log and so its file (a real pending off), and a file the bundle brings without its log is not taken.
  const carriesLog = b.files.some((f) => f.path === `state/${EVENTS}`);
  // R1173aj AJ4: the bundle's own file is written in the log's step, just after the log, whatever the bundle's order.
  const bundleSide = carriesLog ? b.files.find((f) => f.path === `state/${OFF_FILE}`) : undefined;
  const cfgDir = o.root ? join(o.root, BRAND.configDir) : null;
  const hasConfig = cfgDir !== null && existsSync(cfgDir);
  for (const f of b.files) {
    const data = Buffer.from(f.data, 'base64');
    const rel = f.path.slice(f.path.indexOf('/') + 1);
    if (isNativeGuardPath(rel)) {
      r.skipped.push({ path: f.path, why: 'a machine-local native lock guard' });
      continue;
    }
    if (f.path.startsWith('state/')) {
      // init's checklist is the machine's it was walked on; an instance walks its own (server mode).
      if (o.instance && rel === 'init.json') {
        r.skipped.push({ path: f.path, why: "init's checklist from the other machine; run init here" });
        continue;
      }
      // Removed with Siri (#743): an older bundle's device token store and gateway token are never brought back.
      if (rel === 'siri-gateway-token' || rel.startsWith('siri/')) {
        r.skipped.push({ path: f.path, why: 'Siri was removed; its tokens are not imported' });
        continue;
      }
      // Anything else export leaves out (statePathProblem) is skipped, never written: an import takes only what export writes.
      const left = statePathProblem(rel);
      if (left) {
        r.skipped.push({ path: f.path, why: `${left}: export leaves it out` });
        continue;
      }
      if (rel === OFF_FILE && !carriesLog) {
        r.skipped.push({ path: f.path, why: "the flags' unrecorded offs of a log this bundle doesn't carry" });
        continue;
      }
      if (rel === OFF_FILE) continue; // written with the log, below
      const to = join(o.stateDir, rel);
      mkdirSync(dirname(to), { recursive: true });
      // R1173ac AC-4, R1173af AF2: the target's file goes with the log it belongs to, only once that log is replaced.
      // It is moved aside first and put back if the write fails (a full disk, the very fault the file is for), so an
      // import that fails keeps the target's pending offs. A kill between the move and the end of the write leaves it
      // at `<file>.import-old`: a stated limit (docs/feature-flags.md).
      if (rel === EVENTS) {
        const side = join(o.stateDir, OFF_FILE);
        const aside = `${side}.import-old`;
        // R1173ah AH1: only what this import moved goes back (a leftover .import-old is another log's).
        const moved = existsSync(side);
        if (moved) renameSync(side, aside);
        try {
          writeGroupOnly(to, data);
        } catch (e) {
          if (moved) renameSync(aside, side);
          throw e;
        }
        rmSync(aside, { force: true });
        if (bundleSide) {
          writeGroupOnly(side, Buffer.from(bundleSide.data, 'base64'));
          r.state.push(bundleSide.path);
        }
      } else writeGroupOnly(to, data);
      r.state.push(f.path);
    } else if (cfgDir) {
      const to = join(cfgDir, rel);
      if (!hasConfig) {
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, data);
        r.config.push(f.path);
      } else if (!existsSync(to) || !readFileSync(to).equals(data)) r.configDiffers.push(posix(relative(o.root!, to)));
    } else r.skipped.push({ path: f.path, why: 'no checkout to put the config in' });
  }
  return r;
}
