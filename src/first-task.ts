// WHY (#468): a new person's first issue had no ```done_when block and no `ready` label, and the harness ignored it
// without a word. Two halves, one module:
//   - the first-run page's "Your first task" files an issue shaped as the coordinator takes it: an Outcome, a
//     ```done_when block checked with the coordinator's own parser (parseContract) before anything is filed, and the
//     `ready` label; and shows the same shape as a template to copy;
//   - the Issues page says, for each open issue the harness isn't working on, why: what the coordinator decided
//     (issue.seen, contract.missing, dependency.held, hotspot.held, governor.hold, issue.blocked), or for an issue it
//     never looked at (no `ready`), that. Read from the events and one listing of open issues; nothing here writes.
import { BRAND } from './brand.js';
import { LABELS, parseContract, type Issue } from './backlog/types.js';
import type { StoredEvent } from './events/types.js';

export class FirstTaskError extends Error {}

/** One done_when check the form builds: a test (by file or name), or a command and, optionally, text its output must hold. */
export type DoneWhenPick = { test: string } | { command: string; expect?: string };

export interface FirstTaskInput {
  title: string;
  outcome: string;
  done_when: DoneWhenPick[];
  context?: string;
}

const oneLine = (s: unknown, what: string, max: number) => {
  const v = String(s ?? '').trim();
  if (!v) throw new FirstTaskError(`${what}: required`);
  if (/[\r\n]/.test(v)) throw new FirstTaskError(`${what}: one line`);
  if (v.length > max) throw new FirstTaskError(`${what}: at most ${max} characters`);
  return v;
};

/** A string as one single-quoted shell word. */
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A YAML block scalar (`|`) of one or more lines, indented under its key. */
const block = (text: string, indent: string) => `|\n${text.split('\n').map((l) => `${indent}${l}`).join('\n')}`;

/**
 * The issue body for these answers: the Outcome, the done_when block (each test as `- test:`, each command as a YAML
 * block scalar; an expected output becomes `<command> | grep -qF -- '<text>'`), and any context. Checked with
 * parseContract, the coordinator's own parser: a body it would refuse is never returned.
 */
export function firstTaskBody(given: Partial<Record<keyof FirstTaskInput, unknown>>): { title: string; body: string } {
  const title = oneLine(given.title, 'title', 200);
  const outcome = oneLine(given.outcome, 'outcome', 500);
  const picks = Array.isArray(given.done_when) ? (given.done_when as unknown[]) : [];
  if (!picks.length) throw new FirstTaskError('done_when: at least one test or command');
  if (picks.length > 10) throw new FirstTaskError('done_when: at most 10 checks');
  const items = picks.map((p, i) => {
    const o = (p ?? {}) as Record<string, unknown>;
    if (typeof o.test === 'string') return `- test: ${JSON.stringify(oneLine(o.test, `check ${i + 1}: the test`, 300))}`;
    if (typeof o.command === 'string') {
      const cmd = String(o.command).trim();
      if (!cmd) throw new FirstTaskError(`check ${i + 1}: the command is empty`);
      if (cmd.length > 2000) throw new FirstTaskError(`check ${i + 1}: the command is too long`);
      const expect = typeof o.expect === 'string' && o.expect.trim() ? oneLine(o.expect, `check ${i + 1}: the expected output`, 300) : null;
      return `- command: ${block(expect ? `${cmd} | grep -qF -- ${sq(expect)}` : cmd, '    ')}`;
    }
    throw new FirstTaskError(`check ${i + 1}: a test or a command`);
  });
  const context = String(given.context ?? '').trim().slice(0, 5000);
  const body = [`**Outcome:** ${outcome}`, '', '```done_when', ...items, '```', ...(context ? ['', '**Context:**', context] : []), '', `_Filed from the ${BRAND.name} first-run page._`].join('\n');
  const c = parseContract(body);
  if (!c.ok) throw new FirstTaskError(`the done_when block wouldn't be taken: ${c.why}`);
  return { title, body };
}

/** The shape to copy by hand: the label to add, and a body with the fenced done_when block. */
export const FIRST_TASK_TEMPLATE = {
  label: 'ready',
  body: ['**Outcome:** <one sentence: what is true when this is done>', '', '```done_when', '- test: "<a test file or test name your runner knows>"', '- command: |', '    <a command that exits 0 when it is done>', '```', '', '**Context:** <anything that helps; optional>'].join('\n'),
};

/** The `ready` label as the CLI's `labels` command creates it. */
export const READY_LABEL = LABELS.find((l) => l.name === 'ready')!;

export type IgnoreKind = 'no-ready' | 'contract' | 'not-writer' | 'waiting' | 'blocked' | 'held';

export interface IgnoreReason {
  kind: IgnoreKind;
  text: string;
  /** A one-click fix where safe: add the `ready` label (a writer's, as the coordinator counts it). */
  fix: 'add-ready' | 'edit' | null;
}

export interface IgnoredIssue {
  issue: number;
  title: string;
  url: string;
  author: string;
  labels: string[];
  reasons: IgnoreReason[];
}

const last = <T extends StoredEvent['type']>(events: StoredEvent[], type: T, issue?: number) => events.filter((e) => e.type === type && (issue === undefined || (e.payload as { issue?: number }).issue === issue)).at(-1) as StoredEvent<T> | undefined;
const after = (a: StoredEvent | undefined, b: StoredEvent | undefined) => !!a && (!b || a.id > b.id);

/**
 * Why each open issue isn't being worked on, as the coordinator decided it (its events), or, for one it never lists
 * (no `ready`), that. An issue the coordinator is working on (claimed, not released or blocked since) has none and is
 * left out, as is one with no reason found.
 */
export function ignoredIssues(open: Issue[], events: StoredEvent[], o: { repo: string }): IgnoredIssue[] {
  const hold = last(events, 'governor.hold');
  const holdOn = after(hold, last(events, 'governor.release'));
  const out: IgnoredIssue[] = [];
  for (const i of open) {
    const reasons: IgnoreReason[] = [];
    const claimed = last(events, 'issue.claimed', i.number);
    const ended = [last(events, 'issue.released', i.number), last(events, 'issue.blocked', i.number), last(events, 'issue.closed', i.number)].filter(Boolean).sort((a, b) => b!.id - a!.id)[0];
    if (after(claimed, ended)) continue;
    if (!i.labels.includes('ready')) {
      reasons.push({ kind: 'no-ready', text: "no ready label: the coordinator only looks at issues labelled ready", fix: 'add-ready' });
    } else {
      const seen = last(events, 'issue.seen', i.number);
      // The coordinator's own decision (who added ready is GitHub's to say, read on its pass, never guessed here).
      if (seen && !seen.payload.actionable && /not a writer/.test(seen.payload.why)) reasons.push({ kind: 'not-writer', text: seen.payload.why, fix: 'add-ready' });
    }
    // The contract, by the coordinator's own parser on the body as it is now (its contract.missing says the same).
    const c = parseContract(i.body);
    if (!c.ok) reasons.push({ kind: 'contract', text: c.why, fix: 'edit' });
    const dep = last(events, 'dependency.held', i.number);
    if (after(dep, last(events, 'dependency.unblocked', i.number))) reasons.push({ kind: 'waiting', text: `waits on ${dep!.payload.on.map((n) => `#${n}`).join(', ')}: ${dep!.payload.reason}`, fix: null });
    const blocked = last(events, 'issue.blocked', i.number);
    if (blocked && (!claimed || blocked.id > claimed.id)) reasons.push({ kind: 'blocked', text: blocked.payload.why, fix: null });
    const hot = last(events, 'hotspot.held', i.number);
    if (after(hot, last(events, 'hotspot.released', i.number))) reasons.push({ kind: 'held', text: `held: ${hot!.payload.reason} (#${hot!.payload.by} is changing ${hot!.payload.files.slice(0, 3).join(', ')})`, fix: null });
    if (!reasons.length && holdOn && i.labels.includes('ready') && c.ok) reasons.push({ kind: 'held', text: `held: ${hold!.payload.reason}`, fix: null });
    if (reasons.length) out.push({ issue: i.number, title: i.title, url: `https://github.com/${o.repo}/issues/${i.number}`, author: i.author, labels: i.labels, reasons });
  }
  return out;
}
