// Skill evals: a skill without a passing eval is a draft. Cases live next to
// the skill in evals/cases.md (situation / correct / wrong). For each case a
// model given only the skill writes the steps it would take (no tools, so it
// can't act), and a separate judge grades the plan against the case. A case
// passes only if no "wrong" action appears and most "correct" ones do.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentEnv } from './runner.js';

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
  const cwd = mkdtempSync(join(tmpdir(), 'skill-eval-'));
  const args = ['-p', prompt, '--model', model, '--output-format', 'json', '--max-turns', '3', '--setting-sources', '', '--strict-mcp-config', '--disallowedTools', 'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Task'];
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  const r = spawnSync('claude', args, { cwd, encoding: 'utf8', env: agentEnv(process.env, 'cli'), timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
  const out = JSON.parse(r.stdout || '{}') as { result?: string; structured_output?: unknown; is_error?: boolean };
  if (r.status !== 0 || out.is_error) throw new Error(`claude failed: ${(r.stderr || out.result || '').slice(0, 300)}`);
  return { text: out.result ?? '', ...(out.structured_output !== undefined ? { structured: out.structured_output } : {}) };
}

export const CORRECT_THRESHOLD = 0.8;

export function runSkillEval(skillDir: string, opts: { model: string; judge: string; only?: string[]; samples?: number }): EvalResults {
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
