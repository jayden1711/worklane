// What a superfan reads since its last pass, as digest items: each one line of redacted text with a stable key (an
// event's id, an incident's id and state, a test run's id, a journal line's hash, an update line's time), so a
// later pass can tell what it already posted about. Pure: the sources come in already read (read-only) by the
// caller, and nothing here reads a file, the environment or a credential.
//
// The instance's superfan reads its event log (only the kinds that say something went wrong or changed course),
// its incidents, its test-run results, its health suggestions and its own service log; the machine's (the engine
// and updater channel) reads the machine's incidents and the updater's log.
import { createHash } from 'node:crypto';
import type { StoredEvent } from '../events/types.js';
import type { Incident } from '../watchdog/incidents.js';
import { testRunStatus } from '../testrun/status.js';
import type { UpdateEntry } from '../updates.js';

export interface DigestItem {
  key: string;
  line: string;
}

/** Where the last pass stopped: the newest event read, its time, the incidents open then, the health suggestions then (null: none read yet). */
export interface Cursor {
  since: string;
  eventId: number;
  open: string[] | null;
  health: string[] | null;
}

/** A service log as the dashboard's reader returns it (src/dashboard.ts readServiceLog), read as the coordinator's own user. */
export interface JournalRead {
  entries: { at: string | null; priority: number | null; message: string }[];
  problem: string | null;
}

export interface DigestSources {
  /** The instance's whole event log (test runs are folded from it); events after the cursor become items. */
  events?: StoredEvent[];
  /** The incidents this superfan watches (the instance's, or the machine's). */
  incidents?: Incident[];
  /** The health view's suggestions (src/health.ts), the test runs' problems among them. */
  health?: string[];
  journal?: JournalRead | null;
  /** The updater's log (the machine's superfan). */
  updates?: UpdateEntry[];
}

/** The most items one digest carries (the newest kept); the most characters one line does. */
export const MAX_ITEMS = 120;
const LINE_CHARS = 400;

/** Event kinds worth a look: something failed, stopped, was refused or held, or changed course. Everything else is routine. */
export const NOTABLE_EVENTS = new Set<string>([
  'run.startup_failed',
  'run.stuck',
  'issue.blocked',
  'issue.claim_lost',
  'config.invalid',
  'usage.limit_hit',
  'usage.paused',
  'provider.fallback',
  'push.refused',
  'push.blocked',
  'secret.detected',
  'merge.failed',
  'merge.stopped',
  'merge.resumed',
  'wait.capped',
  'main_watch.direct_push',
  'main_watch.unaccounted',
  'ci_fix.gave_up',
  'deploy.failed',
  'deploy_gate.moved',
  'deploy_gate.held',
  'deploy_gate.refused',
  'deploy_gate.override',
  'coordinator.error',
  'coordinator.started',
  'emergency.stop',
  'emergency.resume',
  'governor.hold',
  'testrun.checks_failed',
  'testrun.wipe_failed',
  'testrun.sandbox',
  'testrun.helper',
  'machine.finished',
]);

/** Update-log lines that are routine steps of every update, not news. */
const ROUTINE_UPDATES = new Set(['attempt', 'waiting', 'chose']);

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const clip = (s: string, n = LINE_CHARS) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
/** A suggestion's identity: its words, not its numbers (a figure that moves each pass is not a new suggestion). */
const shape = (s: string) => hash(s.toLowerCase().replace(/[0-9.,%$]+/g, '#'));

function notable(e: StoredEvent): boolean {
  if (e.type === 'run.finished') return (e.payload as { reason: string }).reason !== 'succeeded';
  if (e.type === 'machine.finished') return (e.payload as { outcome: string }).outcome !== 'done';
  if (e.type === 'testrun.sandbox') return (e.payload as { ok?: boolean }).ok === false;
  return NOTABLE_EVENTS.has(e.type);
}

/**
 * The items since `cursor`, and the cursor to keep after a pass that judged them. `redact` is applied to every line
 * (the caller's redaction: secret shapes, the project's names and patterns). Notes: what couldn't be read (the
 * journal), for the pass's record only, never the digest.
 */
export function buildDigest(src: DigestSources, cursor: Cursor, now: Date, redact: (s: string) => string): { items: DigestItem[]; cursor: Cursor; notes: string[] } {
  const items: DigestItem[] = [];
  const notes: string[] = [];
  const add = (key: string, line: string) => items.push({ key, line: redact(clip(redact(line))) });
  let eventId = cursor.eventId;
  for (const e of src.events ?? []) {
    eventId = Math.max(eventId, e.id);
    if (e.id <= cursor.eventId || e.ts < cursor.since || !notable(e)) continue;
    add(`event:${e.id}`, `${e.ts} ${e.type}: ${JSON.stringify(e.payload)}`);
  }
  if (src.events) {
    for (const r of testRunStatus(src.events).recent) {
      if (!r.finishedAt || r.finishedAt <= cursor.since) continue;
      const tiers = r.tiers.map((t) => `${t.tier} ${t.ok ? 'passed' : `FAILED${t.summary ? ` (${t.summary})` : ''}`}`).join('; ');
      add(`testrun:${r.id}`, `${r.finishedAt} test run ${r.kind} at ${r.sha.slice(0, 7)}${r.prs.length ? ` for ${r.prs.map((p) => `#${p}`).join(', ')}` : ''}: ${r.state}${tiers ? `; ${tiers}` : ''}`);
    }
  }
  const open: string[] = [];
  for (const x of src.incidents ?? []) {
    if (!x.resolvedAt) {
      open.push(x.id);
      const isNew = cursor.open ? !cursor.open.includes(x.id) : x.since >= cursor.since;
      if (isNew) add(`incident:${x.id}:open`, `${x.since} incident opened (${x.severity}) on ${x.instance ?? 'the machine'}: ${x.title}. ${x.detail} Fix: ${x.fix}`);
    } else if (x.resolvedAt > cursor.since) {
      add(`incident:${x.id}:resolved`, `${x.resolvedAt} incident resolved on ${x.instance ?? 'the machine'}: ${x.title} (open since ${x.since})`);
    }
  }
  let health = cursor.health;
  if (src.health) {
    const now = src.health.filter((s) => !/^Nothing to suggest/.test(s));
    const shapes = now.map(shape);
    // The first pass only learns what is already there.
    if (cursor.health) for (const [i, s] of now.entries()) if (!cursor.health.includes(shapes[i]!)) add(`health:${shapes[i]}`, `health: ${s}`);
    health = shapes;
  }
  if (src.journal) {
    if (src.journal.problem) notes.push(`journal skipped: ${clip(src.journal.problem, 200)}`);
    for (const j of src.journal.entries) {
      if (!j.at || j.at <= cursor.since) continue;
      const bad = (j.priority !== null && j.priority <= 4) || /\b(?:error|fail(?:ed|ure)?|fatal|panic|exception|refused|crash(?:ed)?)\b/i.test(j.message);
      if (bad) add(`journal:${hash(`${j.at} ${j.message}`)}`, `${j.at} service log: ${j.message}`);
    }
  }
  for (const u of src.updates ?? []) {
    if (u.at <= cursor.since || ROUTINE_UPDATES.has(u.event)) continue;
    const move = u.from || u.to ? ` ${u.from?.slice(0, 7) ?? '?'} -> ${u.to?.slice(0, 7) ?? '?'}` : '';
    add(`update:${u.at}:${u.event}`, `${u.at} engine update ${u.event}${move}${u.reason ? `: ${u.reason}` : ''}${u.failed?.length ? ` (failed: ${u.failed.join(', ')})` : ''}`);
  }
  return { items: items.slice(-MAX_ITEMS), cursor: { since: now.toISOString(), eventId, open: src.incidents ? open : cursor.open, health }, notes };
}
