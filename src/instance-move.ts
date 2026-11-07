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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { openWaiting } from './events/open.js';
import { BRAND } from './brand.js';
import { writeGroupOnly, writeOwnerOnly } from './os/index.js';
import { isNativeGuardPath } from './slot-file.js';

export const BUNDLE_FORMAT = `${BRAND.cli}-bundle`;
const EVENTS = 'events.db';

/** Left out of a bundle: secrets, and what only makes sense on the machine it was made on. */
const LEAVE_OUT: [RegExp, string][] = [
  [/(^|\/)dashboard-token$|token|secret|credential|\.pem$|\.key$/i, 'a secret'],
  [/\.lock$|\.lock\/|(^|\/)locks?\//, 'a lock'],
  [/\.log(\.\d+)?$/, 'a log'],
  [/(^|\/)(worktrees|slots|tasks|dep-cache|chat\/pending)\//, "this machine's working files"],
  [/\.tmp$|-wal$|-shm$|-journal$|(^|\/)\.[^/]+\.[0-9a-f]{16}\.new$/, 'a temporary file'],
  // Removed with Siri (#743): its device store is never carried, so no bundle brings a live device to an older engine.
  [/^siri(\/|$)|^siri-gateway-token$/, 'removed with Siri (#743)'],
];

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
    const why = isNativeGuardPath(p) ? 'a machine-local native lock guard' : LEAVE_OUT.find(([re]) => re.test(p))?.[1];
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
    if (!/^(state|config)\//.test(f.path) || f.path.split('/').some((s) => s === '..' || s === '') || f.path.includes('\\')) throw new Error(`${file}: refused, a path outside the bundle's places: ${f.path}`);
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
      const to = join(o.stateDir, rel);
      mkdirSync(dirname(to), { recursive: true });
      writeGroupOnly(to, data);
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
