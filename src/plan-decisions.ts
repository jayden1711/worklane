// A plan's Decisions section: the recorded decisions it rests on, the recorded ones that argue against it (each
// with why the plan goes ahead anyway), or exactly "nothing recorded on this". Every citation is checked against
// the decisions index: the decisions already made (the event log's answered questions) and the sections of the
// decision records the checkout keeps (a decisions file or folder, and docs/design.md). A plan that cites what
// isn't there, or has no section, is refused before plan review; plan review then checks the plan against what
// it cites and against the index (src/coordinator/decisions.ts).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import { redactString } from './events/redact.js';
import type { EventPayload, StoredEvent } from './events/types.js';
import { spawnSync } from './os/child-process.js';
import { DECISION_DIRS, DECISION_FILES } from './review.js';

/** The whole section when nothing recorded bears on the plan. Never beside citations. */
export const NOTHING_RECORDED = 'nothing recorded on this';

/**
 * Decision record files, repo-relative; each one present (exact name) is indexed by its headings. Decision record
 * folders: each markdown file in one is an entry (one decision per file). Both lists live in src/review.ts, where the
 * same lists lock every record path as self-modification in the engine's repo (#920).
 */
export { DECISION_DIRS, DECISION_FILES };

export interface DecisionEntry {
  /** How a plan cites it: `decision <id>` or `<file> § <heading>` (or `<file>` for a one-decision file). */
  ref: string;
  /** Every accepted citation of it, normalized (see normRef). */
  aliases: string[];
  /** One line: the heading, or the question and the answer that stands. */
  title: string;
  /** Its text, for plan review (capped). */
  text: string;
}

/** A citation as compared: case, markup, spacing, a trailing period and `#` vs `§` don't matter. */
export function normRef(s: string): string {
  return s
    .replace(/[`*_]/g, '')
    .replace(/\s*[§#]\s*/, ' § ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.:]+$/, '')
    .toLowerCase();
}

const slug = (h: string) => h.toLowerCase().replace(/[`*_]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');

/** A file's exact name is present (not just a case-insensitive match, as on macOS or Windows). */
function present(repo: string, rel: string): boolean {
  try {
    return readdirSync(join(repo, dirname(rel))).includes(basename(rel)) && statSync(join(repo, rel)).isFile();
  } catch {
    return false;
  }
}

const TEXT_CAP = 2000;

/**
 * The sections of a markdown file: each heading (outside code fences) and its text up to the next heading. The
 * document's title (a level-1 heading) is not a section when the file has deeper headings.
 */
export function sectionsOf(md: string): { heading: string; text: string }[] {
  const out: { level: number; heading: string; text: string[] }[] = [];
  let fence = false;
  for (const line of md.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) out.push({ level: h[1]!.length, heading: h[2]!.trim(), text: [] });
    else out.at(-1)?.text.push(line);
  }
  const deeper = out.some((s) => s.level > 1);
  return out.filter((s) => !deeper || s.level > 1).map((s) => ({ heading: s.heading, text: s.text.join('\n').trim().slice(0, TEXT_CAP) }));
}

/** The ways one heading of `file` may be cited: the whole heading, its number or id, its words, its anchor. */
function headingAliases(file: string, heading: string): string[] {
  const at = (x: string) => `${file} § ${x}`;
  const a = [at(heading), at(slug(heading))];
  const num = /^(\d+(?:\.\d+)*[a-z]?)\.?\s+(.+)$/i.exec(heading);
  if (num) a.push(at(num[1]!), at(num[2]!));
  const id = /^([A-Za-z]{1,10}-?\d+)\s*[:.—–-]\s*(.+)$/.exec(heading);
  if (id) a.push(id[1]!, at(id[1]!), at(id[2]!));
  return [...new Set(a.map(normRef))];
}

/**
 * How the engine repo's own PRs are merged (owner, 2026-10-21): process, never a recorded decision. A decisions file
 * or folder entry that is this file under another name (a symlink, a hard link) is not indexed, so a plan can't cite
 * it to let the engine merge more. This code can't recognise a copy of the page's text under another name, whole, in
 * part or reworded. Instead it indexes only records committed at the plan's base (committedRecords), and in the
 * engine's repo every decision record path, and this file, is self-modification (src/review.ts): a copy reaches the
 * index only through a PR that adds or changes a committed record, which waits like the page itself.
 */
export const PROCESS_DOC = 'docs/process.md';

/** No file at the path (ENOENT): the one stat error that is a sure answer. */
const ABSENT = 'absent';

/** The file's identity (device and inode, through symlinks); ABSENT when there is none; null on any other error. */
function identity(path: string): string | null {
  try {
    const s = statSync(path, { bigint: true });
    return `${s.dev}:${s.ino}`;
  } catch (e) {
    return (e as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? ABSENT : null;
  }
}

const GIT_LIMITS = { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 };

/** Whether a tree entry's path is a record path: a decisions file, or a file directly in a decisions folder. */
const isRecordPath = (path: string) => DECISION_FILES.includes(path) || DECISION_DIRS.includes(posix.dirname(path));

/** A full object id: SHA-1 (40 hex) or SHA-256 (64 hex). */
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The objects with these ids, each of the type asked for, read with `git cat-file --batch` in `cwd`'s repository, and
 * each one's id recomputed from its content (`<type> <size>\0<content>`, hashed as the id's length says): or null when
 * any is missing, of another type, or doesn't hash to its id. git doesn't check a packed object's hash when it reads it,
 * so a pack whose index maps a real id to other content would otherwise be read as that id (#920 round 8).
 */
function verifiedObjects(cwd: string, wanted: { oid: string; type: 'commit' | 'tree' | 'blob' }[]): Map<string, Buffer> | null {
  const out = new Map<string, Buffer>();
  if (!wanted.length) return out;
  if (!wanted.every((w) => OBJECT_ID.test(w.oid))) return null;
  // Replace refs (refs/replace) could stand another object in for the one asked for: never read through them.
  const r = spawnSync('git', ['--no-replace-objects', 'cat-file', '--batch'], { cwd, input: `${wanted.map((w) => w.oid).join('\n')}\n`, ...GIT_LIMITS });
  if (r.error || r.status !== 0) return null;
  const buf = r.stdout as Buffer;
  let at = 0;
  for (const w of wanted) {
    const nl = buf.indexOf(0x0a, at);
    if (nl < 0) return null;
    const head = /^([0-9a-f]+) ([a-z]+) (\d+)$/.exec(buf.subarray(at, nl).toString('utf8'));
    if (!head || head[1] !== w.oid || head[2] !== w.type) return null;
    const start = nl + 1;
    const end = start + Number(head[3]);
    if (end >= buf.length || buf[end] !== 0x0a) return null;
    const body = buf.subarray(start, end);
    const id = createHash(w.oid.length === 40 ? 'sha1' : 'sha256').update(`${w.type} ${body.length}\0`).update(body).digest('hex');
    if (id !== w.oid) return null;
    out.set(w.oid, body);
    at = end + 1;
  }
  return out;
}

/** A tree object's entries, by name: mode and id. null when it can't be read as a tree. */
function treeEntries(body: Buffer, idBytes: number): Map<string, { mode: string; oid: string }> | null {
  const out = new Map<string, { mode: string; oid: string }>();
  let at = 0;
  while (at < body.length) {
    const sp = body.indexOf(0x20, at);
    const nul = sp < 0 ? -1 : body.indexOf(0x00, sp);
    if (sp < 0 || nul < 0 || nul + 1 + idBytes > body.length) return null;
    const mode = body.subarray(at, sp).toString('latin1');
    if (!/^[0-7]{5,6}$/.test(mode)) return null;
    out.set(body.subarray(sp + 1, nul).toString('utf8'), { mode, oid: body.subarray(nul + 1, nul + 1 + idBytes).toString('hex') });
    at = nul + 1 + idBytes;
  }
  return out;
}

/** Regular files only: a symlink (120000) or a submodule (160000) at a record path is no record. */
const REGULAR = new Set(['100644', '100755']);

/**
 * The records committed at `rev`, by path, with each one's text; or null when that can't be told. `rev` is the plan's
 * base commit, as the coordinator gives it; HEAD only when no base is given (then resolved in `checkout`, which must be
 * its repository's top). The objects are read from `objects`, the instance's own clone when the coordinator says so,
 * never through a worktree's .git file, which a setup step could point elsewhere (#920 round 8).
 *
 * Every object read, the commit, each tree down to a record and each record's blob, is checked against its id
 * (verifiedObjects), so no object store, however written, can change what a base commit's records say. The working tree
 * is never read for a record's text: a file left there untracked, or an edit not committed, is no record. Paths are the
 * tree's exact bytes, whatever the filesystem's case. Any failure or mismatch: null, and no record is indexed.
 */
function committedRecords(checkout: string, rev: string, objects: string): Map<string, string> | null {
  let base = rev;
  if (rev === 'HEAD') {
    const git = (args: string[]) => spawnSync('git', ['--no-replace-objects', ...args], { cwd: checkout, encoding: 'utf8', ...GIT_LIMITS });
    const top = git(['rev-parse', '--show-cdup']);
    if (top.error || top.status !== 0 || top.stdout.trim() !== '') return null;
    const head = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (head.error || head.status !== 0) return null;
    base = head.stdout.trim();
  }
  if (!OBJECT_ID.test(base)) return null;
  const idBytes = base.length / 2;
  const commit = verifiedObjects(objects, [{ oid: base, type: 'commit' }])?.get(base);
  const treeLine = commit && /^tree ([0-9a-f]+)\n/.exec(commit.toString('utf8'));
  if (!treeLine || treeLine[1]!.length !== base.length) return null;
  // Walk down from the root tree to every folder a record path names, one level per read.
  const folders = new Set<string>(['']);
  for (const p of [...DECISION_FILES.map((f) => posix.dirname(f)), ...DECISION_DIRS]) {
    for (let d = p; d !== '.' && d !== ''; d = posix.dirname(d)) folders.add(d);
  }
  const trees = new Map<string, Map<string, { mode: string; oid: string }>>();
  let level: { path: string; oid: string }[] = [{ path: '', oid: treeLine[1]! }];
  while (level.length) {
    const got = verifiedObjects(objects, level.map((t) => ({ oid: t.oid, type: 'tree' as const })));
    if (!got) return null;
    const next: { path: string; oid: string }[] = [];
    for (const t of level) {
      const entries = treeEntries(got.get(t.oid)!, idBytes);
      if (!entries) return null;
      trees.set(t.path, entries);
      for (const [name, e] of entries) {
        const path = t.path ? `${t.path}/${name}` : name;
        if (e.mode === '40000' && folders.has(path)) next.push({ path, oid: e.oid });
      }
    }
    level = next;
  }
  const blobs: { path: string; oid: string }[] = [];
  for (const file of DECISION_FILES) {
    const dir = posix.dirname(file);
    const e = trees.get(dir === '.' ? '' : dir)?.get(posix.basename(file));
    if (e && REGULAR.has(e.mode)) blobs.push({ path: file, oid: e.oid });
  }
  for (const dir of DECISION_DIRS) {
    for (const [name, e] of trees.get(dir) ?? []) if (REGULAR.has(e.mode)) blobs.push({ path: `${dir}/${name}`, oid: e.oid });
  }
  const got = verifiedObjects(objects, blobs.map((b) => ({ oid: b.oid, type: 'blob' as const })));
  if (!got) return null;
  return new Map(blobs.map((b) => [b.path, got.get(b.oid)!.toString('utf8')]));
}

/**
 * The decision records of the plan's base commit, as index entries. Fails closed. A record is indexed only when it is a
 * regular file at a record path in the base commit (`rev`; the checkout's HEAD only when no base is given), with its
 * text read from git objects whose ids are checked, never from the working tree (committedRecords). Then, as a second
 * check on the working tree: its real path is inside the checkout (a symlink out of it, say from a planning worktree
 * nested in a clone to the clone's own files, is not) and is itself a record path, it isn't docs/process.md under
 * another name (a hard link), and all of that could be told. When git can't tell, or the page exists but can't be read
 * (EACCES, ELOOP, ...), no record is indexed.
 */
export function recordEntries(repo: string, rev = 'HEAD', objects = repo): DecisionEntry[] {
  const out: DecisionEntry[] = [];
  const committed = committedRecords(repo, rev, objects);
  if (!committed) return out;
  let root: string;
  try {
    root = realpathSync(repo);
  } catch {
    return out;
  }
  const page = identity(join(repo, PROCESS_DOC));
  if (page === null) return out;
  const indexable = (rel: string): boolean => {
    let real: string;
    try {
      real = realpathSync(join(repo, rel));
    } catch {
      return false;
    }
    const inside = relative(root, real);
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return false;
    // A link inside the checkout counts only when it leads to another record path: those are locked in the engine's
    // repo, and any other file isn't, so a later change to it would change the record with nothing holding it.
    const at = inside.split(sep).join('/');
    if (!isRecordPath(at)) return false;
    const id = identity(join(repo, rel));
    return id !== null && id !== ABSENT && id !== page;
  };
  for (const file of DECISION_FILES) {
    const md = committed.get(file);
    if (md === undefined || !present(repo, file) || !indexable(file)) continue;
    for (const s of sectionsOf(md)) out.push({ ref: `${file} § ${s.heading}`, aliases: headingAliases(file, s.heading), title: s.heading, text: s.text });
  }
  for (const dir of DECISION_DIRS) {
    const names = [...committed.keys()].filter((p) => posix.dirname(p) === dir).map((p) => p.slice(dir.length + 1)).filter((n) => n.endsWith('.md') && n.toLowerCase() !== 'readme.md').sort();
    for (const name of names) {
      const file = `${dir}/${name}`;
      if (!indexable(file)) continue;
      const md = committed.get(file)!;
      const title = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(md)?.[1] ?? name.slice(0, -3);
      const id = /^([A-Za-z]{0,10}-?\d+)[-_ ]/.exec(name)?.[1];
      out.push({ ref: file, aliases: [...new Set([file, file.slice(0, -3), ...(id ? [`${dir}/${id}`] : [])].map(normRef))], title, text: md.trim().slice(0, TEXT_CAP) });
    }
  }
  return out;
}

/** The decisions already made: each answered question (the first answer stands), redacted, citable by id. */
export function madeEntries(events: readonly StoredEvent[]): DecisionEntry[] {
  const asked = new Map<string, EventPayload<'decision.asked'>>();
  const out = new Map<string, DecisionEntry>();
  for (const e of events) {
    if (e.type === 'decision.asked') asked.set((e.payload as { id: string }).id, e.payload as EventPayload<'decision.asked'>);
    else if (e.type === 'decision.answered') {
      const a = e.payload as EventPayload<'decision.answered'>;
      const q = asked.get(a.id);
      if (!q || out.has(a.id)) continue;
      const title = `${redactString(q.question).replace(/\s+/g, ' ').slice(0, 300)} -> ${a.answer}${q.issue !== null ? ` (#${q.issue})` : ''}`;
      out.set(a.id, { ref: `decision ${a.id}`, aliases: [normRef(`decision ${a.id}`), normRef(a.id)], title, text: title });
    }
  }
  return [...out.values()];
}

/**
 * The decisions index a plan is checked against: the decisions made, then the records of the plan's base commit `rev`
 * (HEAD when not given), read from the repository at `objects` (the instance's clone; the checkout when not given).
 */
export function decisionIndex(repo: string, events: readonly StoredEvent[], rev = 'HEAD', objects = repo): DecisionEntry[] {
  return [...madeEntries(events), ...recordEntries(repo, rev, objects)];
}

/** The entry a citation names, or null. */
export function resolveRef(index: readonly DecisionEntry[], ref: string): DecisionEntry | null {
  const n = normRef(ref);
  return index.find((e) => e.aliases.includes(n)) ?? null;
}

/** The index as the planner and the plan reviewer see it: one line per entry, each with the exact way to cite it. */
export function indexLines(index: readonly DecisionEntry[], max = 200): string[] {
  if (!index.length) return ['Decisions index: nothing is recorded (no decisions made yet, and no decision records or docs/design.md in this checkout).'];
  const lines = index.slice(0, max).map((e) => (e.ref.startsWith('decision ') ? `- [${e.ref}] ${e.title}` : e.ref.endsWith(` § ${e.title}`) ? `- [${e.ref}]` : `- [${e.ref}] ${e.title}`));
  return ['Decisions index (cite an entry exactly as it appears in brackets; the files are in this checkout):', ...lines, ...(index.length > max ? [`- … and ${index.length - max} more sections in the same files`] : [])];
}

export interface Citation {
  /** The entry's canonical ref (DecisionEntry.ref). */
  ref: string;
  /** How the plan relies on it (rests on), or why it goes ahead anyway (argues against). */
  note: string;
}

export type DecisionsSection = { nothing: true } | { nothing: false; restsOn: Citation[]; arguesAgainst: Citation[] };

/** The section's format, as the planner is told it and as a refusal repeats it. */
export const DECISIONS_FORMAT = `"Rests on:" then one line per entry, "- [<entry>] how the plan relies on it"; "Argues against:" then one line per recorded entry that cuts against the plan, "- [<entry>] why the plan goes ahead anyway"; "- none" under a part with nothing. Or, when nothing recorded bears on the plan, the whole section is exactly "${NOTHING_RECORDED}".`;

const NONE = /^(?:[-*]\s*)?none\.?$/i;

/**
 * The plan contract's Decisions check: the section parsed, every citation found in the index, or why the plan is
 * refused. "nothing recorded on this" passes only as the whole section.
 */
export function checkDecisions(text: unknown, index: readonly DecisionEntry[]): DecisionsSection | { invalid: string } {
  const refuse = (why: string) => ({ invalid: `the plan's Decisions section ${why}. Its format: ${DECISIONS_FORMAT}` });
  if (typeof text !== 'string' || !text.trim()) return refuse('is missing');
  const body = text.replace(/\r\n/g, '\n').trim();
  if (normRef(body) === NOTHING_RECORDED) return { nothing: true };
  if (body.toLowerCase().includes(NOTHING_RECORDED)) return refuse(`says "${NOTHING_RECORDED}" beside other content; that line is the whole section or not in it`);
  const parts: Record<'rests' | 'against', string[] | null> = { rests: null, against: null };
  let cur: 'rests' | 'against' | null = null;
  const stray: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim().replace(/^\*\*(.+?)\*\*/, '$1');
    const label = /^(rests on|argues against)\s*:\s*(.*)$/i.exec(line);
    if (label) {
      cur = label[1]!.toLowerCase() === 'rests on' ? 'rests' : 'against';
      if (parts[cur]) return refuse(`names "${label[1]}:" twice`);
      parts[cur] = [];
      if (label[2]!.trim()) parts[cur]!.push(label[2]!.trim());
    } else if (line) (cur ? parts[cur]! : stray).push(line);
  }
  if (stray.length) return refuse(`has text before "Rests on:" (${JSON.stringify(stray[0]!.slice(0, 80))})`);
  if (!parts.rests || !parts.against) return refuse(`has no "${!parts.rests ? 'Rests on' : 'Argues against'}:" part`);
  const unknown: string[] = [];
  const read = (lines: string[], part: string, needNote: boolean): Citation[] | { invalid: string } => {
    const out: Citation[] = [];
    for (const l of lines) {
      if (NONE.test(l)) continue;
      const m = /^(?:[-*]\s*)?\[([^\]]+)\]\s*[:—–-]?\s*(.*)$/.exec(l);
      if (!m) return refuse(`has a line under "${part}:" that isn't a citation (${JSON.stringify(l.slice(0, 80))}); each is "- [<entry>] ..."`);
      const entry = resolveRef(index, m[1]!);
      if (!entry) {
        unknown.push(m[1]!.trim());
        continue;
      }
      if (needNote && !m[2]!.trim()) return refuse(`cites [${entry.ref}] under "${part}:" without saying why the plan goes ahead anyway`);
      out.push({ ref: entry.ref, note: m[2]!.trim() });
    }
    return out;
  };
  const restsOn = read(parts.rests, 'Rests on', false);
  if ('invalid' in restsOn) return restsOn;
  const arguesAgainst = read(parts.against, 'Argues against', true);
  if ('invalid' in arguesAgainst) return arguesAgainst;
  if (unknown.length) return refuse(`cites what isn't recorded: ${unknown.map((u) => `[${u}]`).join(', ')} (not a decision made, nor a section of ${DECISION_FILES.filter((f) => !f.includes('DECISIONS')).join(', ')} or a file in ${DECISION_DIRS.join(', ')} in this checkout)`);
  if (!restsOn.length && !arguesAgainst.length) return refuse(`cites nothing; when nothing recorded bears on the plan, the whole section is exactly "${NOTHING_RECORDED}"`);
  return { nothing: false, restsOn, arguesAgainst };
}

/** The section as posted and as briefed: one line per citation, with the entry's canonical ref. */
export function decisionsLines(s: DecisionsSection | undefined): string[] {
  if (!s) return ['(a plan from before plans cited decisions)'];
  if (s.nothing) return [NOTHING_RECORDED];
  const part = (xs: Citation[]) => (xs.length ? xs.map((c) => `- [${c.ref}]${c.note ? ` ${c.note}` : ''}`) : ['- none']);
  return ['Rests on:', ...part(s.restsOn), 'Argues against:', ...part(s.arguesAgainst)];
}
