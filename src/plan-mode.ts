// Plan mode for size:M and size:L issues: before building, a read-only run
// writes a plan (the approach, the files it expects to change, risks, open
// questions). The plan is posted on the issue and recorded, and the build
// proceeds with it in the worker's brief. The owner can object by comment:
// an objection stops the task before its next attempt and before anything is
// proposed. By default the build does not wait for an approval of the plan.
import { BRAND } from './brand.js';

/** Labels that ask for a plan before building. */
export const PLAN_LABELS = ['size:M', 'size:L'];

export const needsPlan = (labels: string[]) => labels.some((l) => PLAN_LABELS.includes(l));

/** The plan run may read the repo and run read-only git, nothing else. */
export const PLAN_TOOLS = ['Read', 'Glob', 'Grep', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)', 'Bash(git grep:*)'];
export const PLAN_DISALLOWED = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['approach', 'steps', 'files', 'risks'],
  properties: {
    approach: { type: 'string', description: 'The approach in 2-4 sentences: what you will change and why that meets the issue and its done_when.' },
    steps: { type: 'array', items: { type: 'string' }, description: 'The steps, in order, each small enough to check.' },
    files: { type: 'array', items: { type: 'string' }, description: 'Repo-relative files you expect to change or add.' },
    risks: { type: 'array', items: { type: 'string' }, description: 'What could go wrong or break, and how the steps guard against it.' },
    questions: { type: 'array', items: { type: 'string' }, description: 'Open questions for the owner, only if a real decision is needed; the build proceeds with your best answer.' },
  },
} as const;

export interface Plan {
  approach: string;
  steps: string[];
  files: string[];
  risks: string[];
  questions?: string[];
}

/** A plan from the run's structured output, or why there is none. */
export function readPlan(s: unknown): Plan | { invalid: string } {
  const p = s as Partial<Plan> | undefined;
  if (!p || typeof p.approach !== 'string' || !p.approach.trim()) return { invalid: 'the plan run gave no approach' };
  const list = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : []);
  if (!list(p.steps).length) return { invalid: 'the plan run gave no steps' };
  return { approach: p.approach.trim(), steps: list(p.steps), files: list(p.files), risks: list(p.risks), ...(list(p.questions).length ? { questions: list(p.questions) } : {}) };
}

/** The plan run's brief, after the issue: plan, don't build. */
export function planExtra(): string[] {
  return [
    'This issue is large enough to plan first. Read the code you would change and write a plan: the approach, the steps in order, the files you expect to change, and the risks. Do not edit anything; a worker builds from your plan next.',
    'Ask a question only for a real decision the owner must make; otherwise choose and say why in the approach.',
  ];
}

const bullets = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n');

/** The plan as posted on the issue, with how to object. */
export function planComment(plan: Plan, owner: string): string {
  return [
    `[${BRAND.cli}] Plan for this issue (it is size:M/L, so it is planned before building). The build starts now with this plan; @${owner} if it's wrong, reply \`/${BRAND.cli} object <why>\` and the task stops before its next step.`,
    '',
    `**Approach.** ${plan.approach}`,
    '',
    '**Steps**',
    plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    ...(plan.files.length ? ['', '**Files it expects to change**', bullets(plan.files.map((f) => `\`${f}\``))] : []),
    ...(plan.risks.length ? ['', '**Risks**', bullets(plan.risks)] : []),
    ...(plan.questions?.length ? ['', '**Open questions** (the build goes ahead with the approach above; answer to change it)', bullets(plan.questions)] : []),
  ].join('\n');
}

/** The plan in the worker's brief. */
export function planBrief(plan: Plan): string[] {
  return [
    'The plan for this issue (posted on it). Build to it; if you must depart from it, say where and why in your summary.',
    `Approach: ${plan.approach}`,
    'Steps:',
    ...plan.steps.map((s, i) => `${i + 1}. ${s}`),
    ...(plan.files.length ? [`Files expected to change: ${plan.files.join(', ')}`] : []),
    ...(plan.risks.length ? ['Risks to guard against:', ...plan.risks.map((r) => `- ${r}`)] : []),
  ];
}

/**
 * The owner's (or a writer's) objection to the plan: a `/<cli> object` comment after the plan was posted.
 * `comments` in order; `after`: how many there were when the plan was posted.
 */
export function objection(comments: { author: string; body: string }[], after: number, people: string[]): { by: string; why: string } | null {
  const who = new Set(people.map((p) => p.toLowerCase()));
  const re = new RegExp(`^\\s*/${BRAND.cli}\\s+object\\b\\s*(.*)$`, 'im');
  for (const c of comments.slice(after)) {
    if (!who.has(c.author.toLowerCase())) continue;
    const m = re.exec(c.body);
    if (m) return { by: c.author, why: m[1]!.trim() || 'no reason given' };
  }
  return null;
}
