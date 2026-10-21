// A plan's Decisions section: the recorded decisions it rests on, the recorded ones that argue against it (each
// with why the plan goes ahead anyway), or exactly "nothing recorded on this". Every citation is checked against
// the decisions index: the decisions already made (the event log's answered questions) and the sections of the
// decision records the checkout keeps (a decisions file or folder, and docs/design.md). A plan that cites what
// isn't there, or has no section, is refused before plan review; plan review then checks the plan against what
// it cites and against the index (src/coordinator/decisions.ts).
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import { redactString } from './events/redact.js';
import type { EventPayload, StoredEvent } from './events/types.js';
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
 * part or reworded: in the engine's repo every decision record path, and this file, is self-modification instead
 * (src/review.ts), so a PR that adds or changes one waits for the owner's process like the page itself.
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

/**
 * The decision records the checkout keeps, as index entries. Fails closed: a record is indexed only when its real path
 * is inside the checkout (a symlink out of it, say from a planning worktree nested in a clone to the clone's own
 * files, is not) and is itself a record path (a link to any other file is not), it isn't docs/process.md under another
 * name, and all of that could be told. When the page exists but can't be read (EACCES, ELOOP, ...), no record is
 * indexed, since any of them could be it.
 */
export function recordEntries(repo: string): DecisionEntry[] {
  const out: DecisionEntry[] = [];
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
    if (!DECISION_FILES.includes(at) && !DECISION_DIRS.includes(posix.dirname(at))) return false;
    const id = identity(join(repo, rel));
    return id !== null && id !== ABSENT && id !== page;
  };
  for (const file of DECISION_FILES) {
    if (!present(repo, file) || !indexable(file)) continue;
    for (const s of sectionsOf(readFileSync(join(repo, file), 'utf8'))) out.push({ ref: `${file} § ${s.heading}`, aliases: headingAliases(file, s.heading), title: s.heading, text: s.text });
  }
  for (const dir of DECISION_DIRS) {
    let names: string[];
    try {
      names = statSync(join(repo, dir)).isDirectory() ? readdirSync(join(repo, dir)).filter((n) => n.endsWith('.md') && n.toLowerCase() !== 'readme.md').sort() : [];
    } catch {
      continue;
    }
    for (const name of names) {
      const file = `${dir}/${name}`;
      if (!indexable(file)) continue;
      const md = readFileSync(join(repo, file), 'utf8');
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

/** The decisions index a plan is checked against: the decisions already made, then the checkout's records. */
export function decisionIndex(repo: string, events: readonly StoredEvent[]): DecisionEntry[] {
  return [...madeEntries(events), ...recordEntries(repo)];
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
