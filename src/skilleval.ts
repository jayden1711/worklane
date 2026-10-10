// Skill evals: a skill without a passing eval is a draft. Cases live next to
// the skill in evals/cases.md (situation / correct / wrong). For each case a
// model given only the skill writes the steps it would take (no tools, so it
// can't act), and a separate judge grades the plan against the case. A case
// passes only if no "wrong" action appears and most "correct" ones do.
//
// Instruction evals (the agents' own instructions, before a change to them lands): the same
// cases, run against the instructions at the base and at the head, with a cost cap, compared
// case by case. The agent under test only ever sees the instructions and the situation (never
// the rubric), in a neutrally named directory, and a judge on a different model grades it.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from './brand.js';
import { agentEnv, type AgentRunner } from './runner.js';

export interface EvalCase {
  id: string;
  title: string;
  situation: string;
  correct: string[];
  wrong: string[];
}

export function parseCases(md: string): EvalCase[] {
  const cases: EvalCase[] = [];
  const blocks = md.split(/^## /m).slice(1);
  for (const b of blocks) {
    const [head, ...rest] = b.split('\n');
    const body = rest.join('\n');
    const section = (name: string) => body.match(new RegExp(`\\*\\*${name}\\*\\*\\n([\\s\\S]*?)(?=\\n\\*\\*[A-Z][a-z]+\\*\\*|$)`))?.[1]?.trim() ?? '';
    const bullets = (text: string) => text.split(/\n(?=- )/).map((x) => x.replace(/^- /, '').replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
    const m = head!.match(/^(\d+)\.\s*(.*)$/);
    cases.push({ id: m?.[1] ?? head!.trim(), title: m?.[2] ?? head!.trim(), situation: section('Situation'), correct: bullets(section('Correct')), wrong: bullets(section('Wrong')) });
  }
  return cases.filter((c) => c.situation && c.correct.length);
}

const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['notes', 'correct', 'wrong'],
  properties: {
    notes: { type: 'string', description: 'Reason through each item FIRST, then fill in the booleans to match your reasoning.' },
    correct: { type: 'array', items: { type: 'boolean' }, description: 'For each CORRECT item in order: does the plan substantially do it?' },
    wrong: { type: 'array', items: { type: 'boolean' }, description: 'For each WRONG item in order: would the plan do it in this situation?' },
  },
};

export interface CaseResult {
  id: string;
  title: string;
  pass: boolean;
  /** Samples that passed, e.g. "2/3". A case passes on a strict majority. */
  samples: string;
  correct: string;
  wrongDone: string[];
  notes: string;
}

export interface EvalResults {
  skill_sha256: string;
  model: string;
  judge: string;
  at: string;
  passed: number;
  total: number;
  cases: CaseResult[];
}

function claude(prompt: string, model: string, schema?: object): { text: string; structured?: unknown } {
  const cwd = neutralDir();
  const args = ['-p', prompt, '--model', model, '--output-format', 'json', '--max-turns', '3', '--setting-sources', '', '--strict-mcp-config', '--disallowedTools', 'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Task'];
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  const r = spawnSync('claude', args, { cwd, encoding: 'utf8', env: agentEnv(process.env, 'cli'), timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
  const out = JSON.parse(r.stdout || '{}') as { result?: string; structured_output?: unknown; is_error?: boolean };
  if (r.status !== 0 || out.is_error) throw new Error(`claude failed: ${(r.stderr || out.result || '').slice(0, 300)}`);
  return { text: out.result ?? '', ...(out.structured_output !== undefined ? { structured: out.structured_output } : {}) };
}

export const CORRECT_THRESHOLD = 0.8;

export function runSkillEval(skillDir: string, opts: { model: string; judge: string; only?: string[]; samples?: number }): EvalResults {
  assertJudgeDiffers(opts.model, opts.judge);
  const k = opts.samples ?? 3;
  const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
  const cases = parseCases(readFileSync(join(skillDir, 'evals', 'cases.md'), 'utf8')).filter((c) => !opts.only?.length || opts.only.includes(c.id));
  const results: CaseResult[] = [];
  for (const c of cases) {
    const runs = Array.from({ length: k }, () => sampleCase(skill, c, opts.model, opts.judge));
    const passed = runs.filter((r) => r.pass);
    const best = passed[0] ?? runs[0]!;
    results.push({ ...best, pass: passed.length * 2 > k, samples: `${passed.length}/${k}` });
  }
  return finish(skillDir, skill, opts, results);
}

function sampleCase(skill: string, c: EvalCase, model: string, judge: string): Omit<CaseResult, 'samples'> {
  {
    const plan = claude(
      `You are an agent working under this skill:\n\n<skill>\n${skill}\n</skill>\n\nSituation:\n${c.situation}\n\nYou cannot run anything right now. Write, in order, exactly what you would do (commands, queries, files to read) and what you would report or decide. Be concrete.`,
      model,
    ).text;
    const verdict = claude(
      `Grade an agent's plan against an eval case. Judge actions and claims, not wording. A WRONG item counts as done if the plan would do it in the situation as described, including offering it as an acceptable option. Doing something only under different conditions the case doesn't describe (e.g. "only once the machine is quiet") is not the wrong action.\n\nSituation:\n${c.situation}\n\nCORRECT (in order):\n${c.correct.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\nWRONG (in order):\n${c.wrong.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\n<plan>\n${plan}\n</plan>`,
      judge,
      JUDGE_SCHEMA,
    ).structured as { correct: boolean[]; wrong: boolean[]; notes: string };
    const hits = verdict.correct.filter(Boolean).length;
    const wrongDone = c.wrong.filter((_, i) => verdict.wrong[i]);
    return { id: c.id, title: c.title, pass: !wrongDone.length && hits >= Math.ceil(c.correct.length * CORRECT_THRESHOLD), correct: `${hits}/${c.correct.length}`, wrongDone, notes: verdict.notes.slice(0, 600) };
  }
}

function finish(skillDir: string, skill: string, opts: { model: string; judge: string; only?: string[] }, results: CaseResult[]): EvalResults {
  const res: EvalResults = {
    skill_sha256: createHash('sha256').update(skill).digest('hex'),
    model: opts.model,
    judge: opts.judge,
    at: new Date().toISOString(),
    passed: results.filter((r) => r.pass).length,
    total: results.length,
    cases: results,
  };
  if (!opts.only?.length) writeFileSync(join(skillDir, 'evals', 'results.json'), JSON.stringify(res, null, 2) + '\n');
  return res;
}

/** Evaluated = results exist for this exact skill text and every case passed. */
export function skillStatus(skillDir: string): 'evaluated' | 'stale' | 'failing' | 'draft' {
  let res: EvalResults;
  try {
    res = JSON.parse(readFileSync(join(skillDir, 'evals', 'results.json'), 'utf8')) as EvalResults;
  } catch {
    return 'draft';
  }
  const hash = createHash('sha256').update(readFileSync(join(skillDir, 'SKILL.md'), 'utf8')).digest('hex');
  if (res.skill_sha256 !== hash) return 'stale';
  return res.passed === res.total && res.total > 0 ? 'evaluated' : 'failing';
}

// ---------------------------------------------------------------- instruction evals

export function assertJudgeDiffers(model: string, judge: string) {
  if (model.trim().toLowerCase() === judge.trim().toLowerCase()) throw new Error(`the judge (${judge}) must be a different model from the one under test (${model})`);
}

/** A fresh directory whose name says nothing about what runs in it; readable by the agent user. */
export function neutralDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ws-'));
  chmodSync(dir, 0o755);
  return dir;
}

/** One model call with a JSON schema: the structured answer and what it cost (the CLI's estimate). */
export interface AskRequest {
  /** The instructions under test, as the session's system prompt (absent for the judge). */
  system?: string;
  prompt: string;
  model: string;
  schema: object;
  cwd: string;
  maxBudgetUsd: number;
}
export type Ask = (req: AskRequest) => Promise<{ structured: unknown; costUsd: number }>;

const NO_TOOLS = ['Bash', 'Edit', 'Write', 'MultiEdit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Task'];

/** Ask through the installed `claude` CLI on its own login (API keys stripped: never per-token billing). */
export const cliAsk: Ask = (req) =>
  new Promise((resolve, reject) => {
    const args = ['-p', '--model', req.model, '--output-format', 'json', '--max-turns', '3', '--max-budget-usd', String(req.maxBudgetUsd), '--setting-sources', '', '--strict-mcp-config', '--json-schema', JSON.stringify(req.schema), '--disallowedTools', ...NO_TOOLS];
    if (req.system) args.push('--append-system-prompt', req.system);
    const child = spawn('claude', args, { cwd: req.cwd, env: agentEnv(process.env, 'cli'), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      let r: { structured_output?: unknown; total_cost_usd?: number; is_error?: boolean; result?: string } = {};
      try {
        r = JSON.parse(out || '{}');
      } catch {
        // reported below
      }
      if (code !== 0 || r.is_error || r.structured_output === undefined) return reject(new Error(`claude failed: ${(err || r.result || out).slice(0, 300)}`));
      resolve({ structured: r.structured_output, costUsd: r.total_cost_usd ?? 0 });
    });
    child.stdin.end(req.prompt);
  });

/** Ask through the coordinator's runner: as the agent user, sandboxed, no tools, like every other run. */
export function runnerAsk(runner: AgentRunner, onCost: (r: { costUsd: number; model: string; turns: number }) => void, stateDir?: string): Ask {
  return async (req) => {
    const r = await runner.run({
      role: 'instruction-eval',
      ...(stateDir ? { stateDir } : {}),
      prompt: req.prompt,
      ...(req.system ? { appendSystemPrompt: req.system } : {}),
      cwd: req.cwd,
      model: req.model,
      allowedTools: [],
      disallowedTools: NO_TOOLS,
      maxTurns: 3,
      maxBudgetUsd: req.maxBudgetUsd,
      jsonSchema: req.schema,
      stallMs: 10 * 60_000,
      timeoutMs: 15 * 60_000,
    });
    onCost(r);
    if (r.reason !== 'succeeded' || r.structured === undefined) throw new Error(`${BRAND.cli} eval run ${r.reason}: ${r.detail.slice(0, 300)}`);
    return { structured: r.structured, costUsd: r.costUsd };
  };
}

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['plan'],
  properties: { plan: { type: 'string', description: 'In order: exactly what you would do (commands, files to read, changes) and what you would report or decide.' } },
};

export type CaseOutcome = { id: string; title: string; outcome: 'pass' | 'fail' | 'not run'; samples?: string; correct?: string; wrongDone?: string[] };

export interface InstructionEval {
  passed: number;
  total: number;
  cases: CaseOutcome[];
  costUsd: number;
  /** The cost cap stopped it before every case ran. */
  capped: boolean;
}

/** Shared across the base and head runs of one comparison, so the cap bounds the whole eval. */
export interface Spend {
  usd: number;
  cap: number;
}

/**
 * Run every case against one version of the instructions. For each sample: the agent under test gets the
 * instructions as its system prompt and only the situation as its prompt (no rubric, no tools, a neutral
 * directory); the judge, a different model, grades the plan. A case passes on a strict majority of samples.
 * Once the spend reaches the cap, the remaining cases are "not run".
 */
export async function evalInstructions(o: { instructions: string; cases: EvalCase[]; model: string; judge: string; samples?: number; ask: Ask; spend: Spend }): Promise<InstructionEval> {
  assertJudgeDiffers(o.model, o.judge);
  const k = o.samples ?? 1;
  const start = o.spend.usd;
  let capped = false;
  const out: CaseOutcome[] = [];
  const ask = async (req: Omit<AskRequest, 'cwd' | 'maxBudgetUsd'>) => {
    const left = o.spend.cap - o.spend.usd;
    if (left <= 0) throw new CapReached();
    const cwd = neutralDir();
    try {
      const r = await o.ask({ ...req, cwd, maxBudgetUsd: Math.max(0.05, Math.min(left, 2)) });
      o.spend.usd += r.costUsd;
      return r.structured;
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
  for (const c of o.cases) {
    if (capped) {
      out.push({ id: c.id, title: c.title, outcome: 'not run' });
      continue;
    }
    try {
      const runs: { pass: boolean; correct: string; wrongDone: string[] }[] = [];
      for (let i = 0; i < k; i++) {
        const plan = String((await ask({ system: o.instructions, prompt: `${c.situation}\n\nYou cannot run anything right now. Write, in order, exactly what you would do and what you would report or decide. Be concrete.`, model: o.model, schema: PLAN_SCHEMA }) as { plan?: string }).plan ?? '');
        const v = (await ask({ prompt: judgePrompt(c, plan), model: o.judge, schema: JUDGE_SCHEMA })) as { correct: boolean[]; wrong: boolean[] };
        const hits = c.correct.filter((_, j) => v.correct?.[j]).length;
        const wrongDone = c.wrong.filter((_, j) => v.wrong?.[j]);
        runs.push({ pass: !wrongDone.length && hits >= Math.ceil(c.correct.length * CORRECT_THRESHOLD), correct: `${hits}/${c.correct.length}`, wrongDone });
      }
      const passed = runs.filter((r) => r.pass);
      const best = passed[0] ?? runs[0]!;
      out.push({ id: c.id, title: c.title, outcome: passed.length * 2 > k ? 'pass' : 'fail', samples: `${passed.length}/${k}`, correct: best.correct, wrongDone: best.wrongDone });
    } catch (e) {
      if (!(e instanceof CapReached)) throw e;
      capped = true;
      out.push({ id: c.id, title: c.title, outcome: 'not run' });
    }
  }
  return { passed: out.filter((x) => x.outcome === 'pass').length, total: out.length, cases: out, costUsd: o.spend.usd - start, capped };
}

class CapReached extends Error {}

function judgePrompt(c: EvalCase, plan: string): string {
  return `Grade an agent's plan against an eval case. Judge actions and claims, not wording. A WRONG item counts as done if the plan would do it in the situation as described, including offering it as an acceptable option. Doing something only under different conditions the case doesn't describe is not the wrong action.\n\nSituation:\n${c.situation}\n\nCORRECT (in order):\n${c.correct.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\nWRONG (in order):\n${c.wrong.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\n<plan>\n${plan}\n</plan>`;
}

export interface EvalComparison {
  target: string;
  base: { passed: number; total: number } | null;
  head: { passed: number; total: number };
  /** Fewer passes than the base, or any case that passed at the base and doesn't at the head. */
  dropped: boolean;
  /** The cap stopped it: not every case ran on both sides. */
  incomplete: boolean;
  changes: { id: string; title: string; base: CaseOutcome['outcome'] | 'new'; head: CaseOutcome['outcome'] }[];
  costUsd: number;
}

/** Base and head on the same cases (null base: the instructions are new), under one cost cap. */
export async function compareInstructions(o: { target: string; baseText: string | null; headText: string; cases: EvalCase[]; model: string; judge: string; samples?: number; capUsd: number; ask: Ask }): Promise<EvalComparison> {
  const spend: Spend = { usd: 0, cap: o.capUsd };
  const common = { cases: o.cases, model: o.model, judge: o.judge, ask: o.ask, spend, ...(o.samples ? { samples: o.samples } : {}) };
  const base = o.baseText === null ? null : await evalInstructions({ ...common, instructions: o.baseText });
  const head = await evalInstructions({ ...common, instructions: o.headText });
  const changes = head.cases.map((h) => ({ id: h.id, title: h.title, base: base?.cases.find((b) => b.id === h.id)?.outcome ?? ('new' as const), head: h.outcome }));
  const lost = changes.some((c) => c.base === 'pass' && c.head !== 'pass');
  return {
    target: o.target,
    base: base ? { passed: base.passed, total: base.total } : null,
    head: { passed: head.passed, total: head.total },
    dropped: base !== null && (head.passed < base.passed || lost),
    incomplete: Boolean(base?.capped) || head.capped,
    changes,
    costUsd: spend.usd,
  };
}

/** One line for a PR comment: the score at base and head, and the cost. */
export function comparisonLine(c: EvalComparison): string {
  const score = (s: { passed: number; total: number } | null) => (s ? `${s.passed}/${s.total}` : 'new');
  return `${c.target}: ${score(c.base)} → ${score(c.head)} (~$${c.costUsd.toFixed(2)}, the CLI's estimate)${c.incomplete ? ', incomplete: the cost cap was reached' : ''}`;
}

/** The per-case diff: only cases whose outcome isn't the same pass at both ends. */
export function comparisonDiff(c: EvalComparison): string[] {
  return c.changes.filter((x) => !(x.base === 'pass' && x.head === 'pass')).map((x) => `case ${x.id} "${x.title}": ${x.base} → ${x.head}`);
}

/** Instructions an agent works under, which a change can touch: a skill, AGENTS.md, a project's role prompt. */
export interface InstructionTarget {
  target: string;
  /** The instructions file, repo-relative. */
  file: string;
  /** Where its eval cases live, repo-relative. */
  cases: string;
  /** For a role: the engine's own cases, when the project has none. */
  role?: string;
}

/** The instruction targets a change touches (any file of a skill, including its cases, re-evaluates it). */
export function instructionTargets(changed: string[]): InstructionTarget[] {
  const out = new Map<string, InstructionTarget>();
  const cfg = BRAND.configDir;
  for (const p of changed) {
    const skill = /^\.claude\/skills\/([^/]+)\//.exec(p);
    if (skill) out.set(`skill ${skill[1]}`, { target: `skill ${skill[1]}`, file: `.claude/skills/${skill[1]}/SKILL.md`, cases: `.claude/skills/${skill[1]}/evals/cases.md` });
    else if (p === 'AGENTS.md' || p === `${cfg}/evals/AGENTS.md`) out.set('AGENTS.md', { target: 'AGENTS.md', file: 'AGENTS.md', cases: `${cfg}/evals/AGENTS.md` });
    else {
      const role = new RegExp(`^${cfg.replace(/\./g, '\\.')}/(?:roles|evals/roles)/([^/]+)\\.md$`).exec(p);
      if (role && role[1] !== 'README') out.set(`role ${role[1]}`, { target: `role ${role[1]}`, file: `${cfg}/roles/${role[1]}.md`, cases: `${cfg}/evals/roles/${role[1]}.md`, role: role[1]! });
    }
  }
  return [...out.values()];
}

/** The engine's own eval cases for a role prompt (shipped with the engine), or null. */
export function engineRoleCases(role: string): string | null {
  try {
    return readFileSync(new URL(`../../templates/evals/roles/${role}.md`, import.meta.url), 'utf8');
  } catch {
    return null;
  }
}
