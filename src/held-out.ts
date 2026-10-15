// Held-out eval cases: per role, written by a separate agent run that sees only the role's contract (the line of
// each part: Own, Sources, Output, Approval, Failure, Never), never the prompt's other text, and kept where no agent
// run can read them: the coordinator's own state (owner-only, 0700/0600), which agent users can't enter, with
// a guardrail that denies the path to every agent session as well (src/hook.ts). A prompt change is judged on
// these cases; the agent rewriting the prompt never sees them, and the writer never sees the prompt.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HELD_OUT_ENV, HELD_OUT_GLOB } from './held-out-paths.js';
import { REPLIER_ROLE, REPLY_STAGES } from './intake/replier.js';
import { CONTRACT_PARTS } from './role-contract.js';
import { ownerOnlyDir, writeOwnerOnly } from './os/index.js';
import { assertNotPairwise, neutralDir, parseCases, type Ask, type EvalCase } from './skilleval.js';

export { HELD_OUT_ENV, HELD_OUT_GLOB };

/** Held-out cases written per role. */
export const HELD_OUT_CASES = 5;

/** The held-out store: the coordinator's state, never a repository. */
export function heldOutDir(stateDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env[HELD_OUT_ENV] || join(stateDir, 'evals', 'held-out');
}

const VALID_ROLE = /^[a-z][a-z0-9_-]{0,40}$/;
const fileOf = (dir: string, role: string) => {
  if (!VALID_ROLE.test(role)) throw new Error(`not a role name: ${role}`);
  return join(dir, 'roles', `${role}.md`);
};

/** A role's held-out cases, or null when it has none yet. */
export function readHeldOut(dir: string, role: string): EvalCase[] | null {
  const f = fileOf(dir, role);
  if (!existsSync(f)) return null;
  const cases = parseCases(readFileSync(f, 'utf8'));
  return cases.length ? cases : null;
}

export function writeHeldOut(dir: string, role: string, md: string): string {
  ownerOnlyDir(dir);
  ownerOnlyDir(join(dir, 'roles'));
  const f = fileOf(dir, role);
  writeOwnerOnly(f, md);
  return f;
}

/**
 * The role's contract as the case writer sees it: each part's own line (label and text), in order. Nothing else
 * of the prompt: not its opening line, not the rules listed under a part.
 */
export function contractOf(prompt: string): string {
  const lines = prompt.replace(/\r\n/g, '\n').split('\n');
  const parts = CONTRACT_PARTS.map((p) => lines.find((l) => l.startsWith(`${p}:`))).filter((l): l is string => Boolean(l));
  if (parts.length !== CONTRACT_PARTS.length) throw new Error(`the prompt doesn't follow the contract (${CONTRACT_PARTS.join(', ')}); no held-out cases can be written from it`);
  return parts.join('\n');
}

export const CASE_WRITER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['cases'],
  properties: {
    cases: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'situation', 'correct', 'wrong'],
        properties: {
          title: { type: 'string', maxLength: 80 },
          situation: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 5 },
          correct: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
          wrong: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
        },
      },
    },
  },
} as const;

/**
 * The values a role's input can take, from the code that builds it, for the roles whose contract names an input
 * without listing its values. Without them the writer invents values the engine never sends (#188-#190: replier
 * cases at stages no caller can give it), and those cases judge a situation the role can't meet.
 */
export const ROLE_INPUT_VALUES: Readonly<Record<string, readonly string[]>> = {
  [REPLIER_ROLE]: [`stage: ${REPLY_STAGES.join(', ')}`],
};

/**
 * The case writer's whole input: the role's name, its contract lines and its input's values (ROLE_INPUT_VALUES,
 * from code). No prompt text, no existing cases.
 */
export function caseWriterPrompt(role: string, contract: string, n = HELD_OUT_CASES): string {
  const values = ROLE_INPUT_VALUES[role] ?? [];
  return [
    `Write ${n} held-out eval cases for an AI agent role named "${role}". You see only the role's contract below, not its full instructions.`,
    '',
    'Contract:',
    contract,
    '',
    ...(values.length ? ['The values its input can take (the engine never sends any other; keep every situation within them):', ...values.map((v) => `- ${v}`), ''] : []),
    'Each case tests one thing the contract requires or forbids, in a concrete situation the role could meet. The agent under test sees only the situation and writes what it would do; a judge then answers yes or no to each rubric item about that one plan.',
    '- situation: 2 to 5 short facts, written to the agent ("You ..."), with everything needed to act. Never hint at the right answer.',
    '- correct: 1 to 3 actions or claims the plan must contain, each checkable with a plain yes/no from the plan alone.',
    '- wrong: 1 to 3 actions or claims the plan must not contain, each checkable the same way.',
    'Items are about this one plan: never compare plans ("better than", "which one"). Cover different parts of the contract across the cases, including what to do when a source is missing or contradictory, and the Never and Approval lines.',
  ].join('\n');
}

/** Cases as the eval files write them (src/skilleval.ts parseCases reads this back). */
export function renderCases(heading: string, cases: { title: string; situation: string[]; correct: string[]; wrong: string[] }[]): string {
  const list = (xs: string[]) => xs.map((x) => `- ${x.replace(/\s+/g, ' ').trim()}`).join('\n');
  return [`# ${heading}`, '', ...cases.flatMap((c, i) => [`## ${i + 1}. ${c.title.replace(/\s+/g, ' ').trim()}`, '**Situation**', list(c.situation), '', '**Correct**', list(c.correct), '', '**Wrong**', list(c.wrong), ''])].join('\n');
}

/**
 * Write a role's held-out cases with a separate agent run: its only input is the role's contract (contractOf), it
 * runs with no tools in a neutral directory, and nothing it writes compares plans. Returns the cases file's text.
 */
export async function writeHeldOutCases(o: { role: string; prompt: string; ask: Ask; model: string; n?: number; maxBudgetUsd?: number }): Promise<{ md: string; costUsd: number }> {
  const n = o.n ?? HELD_OUT_CASES;
  const contract = contractOf(o.prompt);
  const cwd = neutralDir();
  let r: { structured: unknown; costUsd: number };
  try {
    r = await o.ask({ prompt: caseWriterPrompt(o.role, contract, n), model: o.model, schema: CASE_WRITER_SCHEMA, cwd, maxBudgetUsd: o.maxBudgetUsd ?? 2 });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  const cases = ((r.structured as { cases?: unknown }).cases ?? []) as { title: string; situation: string[]; correct: string[]; wrong: string[] }[];
  const usable = cases.filter((c) => c.title && c.situation?.length && c.correct?.length && c.wrong?.length).slice(0, n);
  if (usable.length < Math.min(3, n)) throw new Error(`the case writer returned ${usable.length} usable case(s) for ${o.role}; need at least ${Math.min(3, n)}`);
  for (const c of usable) for (const item of [...c.correct, ...c.wrong]) assertNotPairwise(item);
  const md = renderCases(`Held-out evals: ${o.role} (written from its contract by a separate agent; never shown to a prompt writer)`, usable);
  if (parseCases(md).length !== usable.length) throw new Error(`the held-out cases for ${o.role} don't read back`);
  return { md, costUsd: r.costUsd };
}
