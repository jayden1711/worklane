// Plan mode for size:M and size:L issues: before building, a read-only run
// writes a plan (the approach, the files it expects to change, risks, open
// questions). The plan is posted on the issue and recorded, and the build
// proceeds with it in the worker's brief. The owner can object by comment:
// an objection stops the task before its next attempt and before anything is
// proposed. By default the build does not wait for an approval of the plan,
// except when the plan touches what the merge policy would never merge on its
// own (high-risk categories, design-level changes): then it is held as a
// decision for the owner (approve / revise with a note / reject), judged with
// the merge policy's own checks.
import { BRAND } from './brand.js';
import type { ReviewConfig } from './config/schema.js';
import { riskAndDesignReasons, waitCategoriesOf } from './merge-policy.js';
import { computeLevel } from './review.js';

/** Labels that ask for a plan before building. */
export const PLAN_LABELS = ['size:M', 'size:L'];

export const needsPlan = (labels: string[]) => labels.some((l) => PLAN_LABELS.includes(l));

/** The plan run may read the repo and run read-only git, nothing else. */
export const PLAN_TOOLS = ['Read', 'Glob', 'Grep', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)', 'Bash(git grep:*)'];
export const PLAN_DISALLOWED = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['approach', 'steps', 'files', 'risks', 'design_change'],
  properties: {
    approach: { type: 'string', description: 'The approach in 2-4 sentences: what you will change and why that meets the issue and its done_when.' },
    steps: { type: 'array', items: { type: 'string' }, description: 'The steps, in order, each small enough to check.' },
    files: { type: 'array', items: { type: 'string' }, description: 'Repo-relative files you expect to change or add.' },
    risks: { type: 'array', items: { type: 'string' }, description: 'What could go wrong or break, and how the steps guard against it.' },
    questions: { type: 'array', items: { type: 'string' }, description: 'Open questions for the owner, only if a real decision is needed; the build proceeds with your best answer.' },
    design_change: {
      type: 'boolean',
      description: 'true if the plan is design-level: a new top-level module or package, a change to a public CLI or API surface or to a file format, a new dependency, or an architecture change. The owner then approves the plan before anything is built.',
    },
    design_reason: { type: 'string', description: 'When design_change is true: what about the design changes, in one sentence.' },
  },
} as const;

export interface Plan {
  approach: string;
  steps: string[];
  files: string[];
  risks: string[];
  questions?: string[];
  /** The plan's own design-level flag (binding); undefined: it gave no answer, which holds the plan. */
  design_change?: boolean;
  design_reason?: string;
}

/** A plan from the run's structured output, or why there is none. */
export function readPlan(s: unknown): Plan | { invalid: string } {
  const p = s as Partial<Plan> | undefined;
  if (!p || typeof p.approach !== 'string' || !p.approach.trim()) return { invalid: 'the plan run gave no approach' };
  const list = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : []);
  if (!list(p.steps).length) return { invalid: 'the plan run gave no steps' };
  return {
    approach: p.approach.trim(),
    steps: list(p.steps),
    files: list(p.files),
    risks: list(p.risks),
    ...(list(p.questions).length ? { questions: list(p.questions) } : {}),
    ...(typeof p.design_change === 'boolean' ? { design_change: p.design_change } : {}),
    ...(typeof p.design_reason === 'string' && p.design_reason.trim() ? { design_reason: p.design_reason.trim() } : {}),
  };
}

/** The plan run's brief, after the issue: plan, don't build. */
export function planExtra(): string[] {
  return [
    'This issue is large enough to plan first. Read the code you would change and write a plan: the approach, the steps in order, the files you expect to change, and the risks. Do not edit anything; a worker builds from your plan next.',
    'Ask a question only for a real decision the owner must make; otherwise choose and say why in the approach.',
  ];
}

const bullets = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n');

/** The plan as posted on the issue: the build starts now (with how to object), or it waits for approval (`held`). */
export function planComment(plan: Plan, owner: string, held: string[] = []): string {
  const head = held.length
    ? `[${BRAND.cli}] Plan for this issue (it is size:M/L, so it is planned before building). @${owner} it waits for your approval before anything is built, because ${held.join('; ')}.`
    : `[${BRAND.cli}] Plan for this issue (it is size:M/L, so it is planned before building). The build starts now with this plan; @${owner} if it's wrong, reply \`/${BRAND.cli} object <why>\` and the task stops before its next step.`;
  return [
    head,
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

/**
 * Why a plan waits for the owner before anything is built: the merge policy's high-risk categories and
 * design-level checks, over the files the plan expects to change, plus its own design flag. Empty: post and
 * proceed. `existsAtBase` tells a new top-level module from an existing one.
 */
export function planHoldReasons(plan: Plan, o: { review: ReviewConfig; moneyPaths: RegExp[]; existsAtBase: (path: string) => boolean }): string[] {
  const files = plan.files.map((path) => ({ path: path.replace(/^\.\//, ''), added: 0, removed: 0 }));
  const level = computeLevel({ files, labels: [], moneyPaths: o.moneyPaths }, o.review);
  const tops = [...new Set(files.map((f) => f.path.split('/')).filter((s) => s.length > 1).map((s) => s[0]!))];
  const newTopLevel = tops.filter((d) => !o.existsAtBase(d)).map((d) => `${d}/`);
  const reasons = riskAndDesignReasons({ level, waitCategories: waitCategoriesOf(o.review), design: { flag: plan.design_change, reason: plan.design_reason, by: 'the plan' }, newTopLevel });
  if (plan.design_change === undefined) reasons.push('design: the plan gave no design-change answer');
  return reasons;
}

export const PLAN_OPTIONS = ['approve', 'revise', 'reject'] as const;
export type PlanAnswer = (typeof PLAN_OPTIONS)[number];

/** The owner's decision on a held plan. */
export function planDecision(reasons: string[]) {
  return {
    question: 'Approve this plan before it is built?',
    options: [...PLAN_OPTIONS],
    recommendation: 'approve' as PlanAnswer,
    receipts: [
      ...reasons.map((r) => `holds because ${r}`),
      'approve: the build starts with this plan',
      `revise: the plan is written again with your note (reply \`/${BRAND.cli} revise <note>\`)`,
      'reject: the task stops; nothing is built',
    ],
  };
}

/** What an answer to a held plan does: build with it, plan again with a note, or stop. */
export function planAnswer(answer: string, comment = ''): { act: 'build' } | { act: 'replan'; note: string } | { act: 'stop' } {
  if (answer === 'approve') return { act: 'build' };
  if (answer === 'revise') {
    const m = new RegExp(`/${BRAND.cli}\\s+revise\\b\\s*([\\s\\S]*)$`, 'im').exec(comment);
    return { act: 'replan', note: (m?.[1] ?? '').trim() || 'no note given; plan it again with the risks in mind' };
  }
  return { act: 'stop' };
}
