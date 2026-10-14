// WHY: a goal issue (label type:goal) is too big for one task; the goal planner splits it into child
// issues whose "Depends on #n" lines are the task graph's edges (src/task-graph.ts), so dispatch runs
// them in order and in parallel where nothing orders them.
// INVARIANT: a split is checked here before any issue is filed: a bad one files nothing.
import { createHash } from 'node:crypto';
import { parseContract } from './backlog/types.js';
import { findCycle } from './task-graph.js';

export const GOAL_LABEL = 'type:goal';
/** WHY: a goal that was split is not split again; this label says so on the tracker. */
export const GOAL_SPLIT_LABEL = 'goal:split';
export const MIN_CHILDREN = 2;
export const MAX_CHILDREN = 10;

export const GOAL_SPLIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'children'],
  properties: {
    summary: { type: 'string', description: 'How the goal splits and why in that order, in 2-4 sentences.' },
    not_splittable: { type: 'string', description: 'Set only if the goal is one task or cannot be split well: why. Leave children empty then.' },
    children: {
      type: 'array',
      description: `The child issues, ${MIN_CHILDREN} to ${MAX_CHILDREN}, each one task a worker can finish and check on its own.`,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'title', 'body', 'done_when', 'depends_on'],
        properties: {
          key: { type: 'string', description: 'A short unique id for this child, used only in depends_on (e.g. "schema").' },
          title: { type: 'string', description: 'The child issue title.' },
          body: { type: 'string', description: 'What to build and why, for a worker who has not read the goal: the files or areas, and what is out of scope.' },
          done_when: {
            type: 'array',
            items: { type: 'string' },
            description: 'The checks that show this child is done, one per item, in done_when form: test: <path>, command: <cmd>, or manual: "<what a person checks>".',
          },
          depends_on: { type: 'array', items: { type: 'string' }, description: 'Keys of the children that must be finished before this one can start. Empty when nothing orders it.' },
        },
      },
    },
  },
} as const;

export interface GoalChild {
  key: string;
  title: string;
  body: string;
  done_when: string[];
  depends_on: string[];
}

export type GoalSplit = { summary: string; children: GoalChild[] } | { summary: string; notSplittable: string } | { invalid: string };

const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '');
const list = (x: unknown) => (Array.isArray(x) ? x.map(str).filter(Boolean) : []);

/** INVARIANT: the same block parseContract reads, so a child's contract is checked before it is filed. */
export const doneWhenBlock = (items: readonly string[]) => ['```done_when', ...items.map((d) => `- ${yamlItem(d)}`), '```'].join('\n');

/** WHY: a command or note with a colon in it is not valid YAML unquoted; each value is quoted once here. */
function yamlItem(d: string): string {
  const m = /^(test|command|suite|manual|browser)\s*:\s*(.*)$/s.exec(d);
  if (!m) return d;
  const v = m[2]!.trim();
  return `${m[1]}: ${/^".*"$/s.test(v) ? v : JSON.stringify(v)}`;
}

/** INVARIANT: children come back in an order where each one's dependencies come before it. */
export function readGoalSplit(s: unknown): GoalSplit {
  const o = (s ?? {}) as Record<string, unknown>;
  const summary = str(o.summary);
  if (str(o.not_splittable)) return { summary, notSplittable: str(o.not_splittable) };
  const raw = Array.isArray(o.children) ? (o.children as Record<string, unknown>[]) : [];
  if (raw.length < MIN_CHILDREN || raw.length > MAX_CHILDREN) return { invalid: `the split gave ${raw.length} child issue(s); it takes ${MIN_CHILDREN} to ${MAX_CHILDREN}` };
  const children: GoalChild[] = raw.map((c) => ({ key: str(c.key), title: str(c.title), body: str(c.body), done_when: list(c.done_when), depends_on: [...new Set(list(c.depends_on))] }));
  const keys = children.map((c) => c.key);
  for (const c of children) {
    if (!c.key || !c.title || !c.body) return { invalid: `a child issue has no ${!c.key ? 'key' : !c.title ? 'title' : 'body'}` };
    if (keys.filter((k) => k === c.key).length > 1) return { invalid: `two child issues share the key "${c.key}"` };
    const contract = parseContract(doneWhenBlock(c.done_when));
    if (!c.done_when.length || !contract.ok) return { invalid: `child "${c.key}" has no valid done_when${contract.ok ? '' : `: ${contract.why}`}` };
    const unknown = c.depends_on.find((d) => !keys.includes(d));
    if (unknown !== undefined) return { invalid: `child "${c.key}" depends on "${unknown}", which is not one of the children` };
  }
  const idx = new Map(keys.map((k, i) => [k, i]));
  const edges = (i: number) => children[i]!.depends_on.map((d) => idx.get(d)!);
  for (let i = 0; i < children.length; i++) {
    const cycle = findCycle(i, edges);
    if (cycle) return { invalid: `the children's depends_on form a cycle: ${[...cycle, cycle[0]!].map((j) => keys[j]).join(' -> ')}` };
  }
  const ordered: GoalChild[] = [];
  const placed = new Set<string>();
  while (ordered.length < children.length) {
    for (const c of children) {
      if (placed.has(c.key) || !c.depends_on.every((d) => placed.has(d))) continue;
      ordered.push(c);
      placed.add(c.key);
    }
  }
  return { summary, children: ordered };
}

/** WHY: the body names the goal and its dependencies by number, so the dispatch loop reads the edges from the tracker. */
export function childBody(c: GoalChild, goal: number, deps: readonly number[]): string {
  return [c.body, '', `Part of #${goal}.`, ...(deps.length ? [`Depends on ${deps.map((d) => `#${d}`).join(', ')}.`] : []), '', doneWhenBlock(c.done_when), ''].join('\n');
}

/** INVARIANT: a child counts as split by this instance only while its body is exactly what was filed. */
export const bodyHash = (body: string) => createHash('sha256').update(body).digest('hex').slice(0, 16);

/** WHY: the goal's owner sees each child and its order on the goal itself. */
export function splitComment(cli: string, summary: string, filed: { number: number; title: string; deps: number[] }[]): string {
  return [
    `[${cli}] Split this goal into ${filed.length} issues. Each starts on its own once the issues it depends on close.`,
    '',
    summary,
    '',
    ...filed.map((f) => `- #${f.number} ${f.title}${f.deps.length ? ` (after ${f.deps.map((d) => `#${d}`).join(', ')})` : ''}`),
  ].join('\n');
}
