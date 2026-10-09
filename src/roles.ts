// Default role prompts and output schemas. A project overrides a prompt by
// adding <config dir>/roles/<role>.md; schemas are fixed (code reads them).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DoneWhenList, Issue } from './backlog/types.js';

export const WORKER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary'],
  properties: {
    summary: { type: 'string', description: 'What you changed and how you verified it, in 2-5 sentences.' },
    blocked: { type: 'string', description: 'Set only if you could not finish: what blocks you.' },
    ask: {
      type: 'object',
      description: 'Set only for a real decision the owner must make.',
      additionalProperties: false,
      required: ['question', 'options', 'recommendation'],
      properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } }, recommendation: { type: 'string' } },
    },
    raise_review: { type: 'string', enum: ['L1', 'L2', 'L3'], description: 'Ask for more review than the computed level, with your reason in summary.' },
  },
} as const;

export const REPRO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['test_path', 'explanation'],
  properties: {
    test_path: { type: 'string', description: 'Repo-relative path of the reproduction test you wrote.' },
    explanation: { type: 'string', description: 'Why this test fails on the current code for the reason the issue describes.' },
    not_reproducible: { type: 'string', description: 'Set instead of writing a test if the issue cannot be reproduced by a test (and why).' },
  },
} as const;

export const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['patch_correct', 'test_correct', 'confidence', 'advice'],
  properties: {
    patch_correct: { type: 'boolean', description: 'The change does what the issue and done_when ask, without breaking anything else you can see.' },
    test_correct: { type: 'boolean', description: 'The reproduction test checks the right behavior (false if the test itself is wrong).' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    advice: { type: 'string', description: 'What is wrong and how to fix it (patch or test). Empty if nothing.' },
  },
} as const;

export const INVESTIGATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'findings', 'recommendation', 'confidence'],
  properties: {
    summary: { type: 'string', description: 'The answer in 2-4 sentences.' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'evidence'],
        properties: {
          claim: { type: 'string' },
          evidence: { type: 'string', description: 'file:line, a command and its output, or a query and its result. No claim without evidence.' },
        },
      },
    },
    recommendation: { type: 'string', description: 'What should happen next (a fix, more investigation, or nothing), for the owner to decide.' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    unverified: { type: 'array', items: { type: 'string' }, description: 'Anything you could not confirm.' },
  },
} as const;

const DEFAULTS: Record<string, string> = {
  investigator: `You are investigating a question on a real codebase. This is READ-ONLY work: do not edit, create or delete files, do not commit, and never write to any database. Your output is findings, not a change.
- Every claim needs evidence: file:line, or a command or query and what it returned. Mark anything you couldn't confirm as unverified.
- Trust the code over docs; treat docs as unverified until checked against the code.
- Use the project's skills where they apply. Production data only through the sanctioned read path, if one is configured.
- End with a recommendation for the owner. You don't decide; they do.`,
  worker: `You are a worker agent on a real codebase, working one GitHub issue in your own git worktree.
- Read the issue and its done_when contract below. You are done only when every done_when check passes; a Stop gate runs them and will not let you finish otherwise.
- If a frozen reproduction test is named below, it must pass when you're done. Never edit it.
- Make the smallest change that fully solves the issue. Follow the repository's CLAUDE.md and conventions.
- Commit your work on the current branch with clear messages (git add, git commit). Never push, never open PRs, never change labels: the coordinator does that after independent review.
- Never weaken, skip or delete tests to get green. Never edit harness config.
- If docs disagree with the code, trust the code; treat docs as unverified.
- If you hit a real decision only the owner can make, set "ask". If you're blocked, set "blocked". Otherwise finish the work.`,
  'evaluator-repro': `You are an independent evaluator. You have NOT seen any fix. Write ONE reproduction test for the issue below that FAILS on the current code because of the bug or missing behavior the issue describes (an assertion failure, not an import or setup error), and will pass once it's correctly fixed.
- Follow the project's test conventions; put the test where the project's runner finds it.
- Change nothing except the new test file. Commit it.
- If the issue can't be reproduced by an automated test (pure docs, visual polish), set not_reproducible with the reason instead.`,
  'evaluator-verdict': `You are an independent evaluator with fresh context and read-only access. Judge the change on this branch against the issue and its done_when contract. Assume the author took the shortest path that compiles; look for what it misses.
- Inspect the diff from the base commit (git diff BASE..HEAD), the reproduction test, and the check results below.
- patch_correct: does the change actually do what the issue asks, without regressions you can see?
- test_correct: does the reproduction test check the right behavior? You may conclude the TEST is wrong rather than the patch.
- Be specific in advice. Do not edit anything.`,
};

export function rolePrompt(projectDir: string, role: string): string {
  const custom = join(projectDir, 'roles', `${role}.md`);
  return existsSync(custom) ? readFileSync(custom, 'utf8') : DEFAULTS[role] ?? '';
}

export function issueBrief(issue: Issue, doneWhen: DoneWhenList, extra: string[] = []): string {
  return [
    `Issue #${issue.number}: ${issue.title}`,
    '',
    issue.body.replace(/```done_when[\s\S]*?```/, '').trim(),
    '',
    'done_when (all must pass):',
    ...doneWhen.map((d) => `- ${JSON.stringify(d)}`),
    ...(extra.length ? ['', ...extra] : []),
  ].join('\n');
}
