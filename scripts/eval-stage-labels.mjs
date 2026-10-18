#!/usr/bin/env node
// Eval of the stage-label judge prompt (src/stage-label.ts) on fixed fixture runs (templates/evals/stage-labels.json).
// Each case has the one label it must get, so scoring is exact, with no grading model. Code labels are applied first,
// as in the coordinator; a case marked codeOnly must be labelled without a judge call. The other cases go through the
// installed `claude` CLI on its own login (API keys stripped: subscription runs, never per-token billing), with the
// same prompt and schema the coordinator uses. Prints each case, the score and the cost (the CLI's estimate).
// Exits 1 when a case fails or the cost cap cuts the eval short. Needs a build first (npm run build).
// Nothing is spent without --spend <usd> (#612, src/spend-gate.ts): the most this run may spend, which bounds --cap.
// Without it the script prints its plan (the cases that need a judge call, the most it could spend) and exits 2.
//   node scripts/eval-stage-labels.mjs --spend <usd> [--model sonnet] [--cap 0.5]
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const model = arg('model', 'sonnet');
let cap = Number(arg('cap', '0.5'));
if (!(cap > 0)) {
  console.error('--cap must be a positive number of dollars');
  process.exit(2);
}

const dist = join(root, 'dist', 'src');
// A build without the spend gate (an old dist/) would run unguarded: refuse it.
if (!existsSync(join(dist, 'stage-label.js')) || !existsSync(join(dist, 'spend-gate.js'))) {
  console.error('build first: npm run build');
  process.exit(2);
}
const { codeStage, JUDGE_STAGES, STAGE_SCHEMA, stagePrompt } = await import(pathToFileURL(join(dist, 'stage-label.js')).href);
const { cliAsk: unbounded, neutralDir } = await import(pathToFileURL(join(dist, 'skilleval.js')).href);
const { ceilingAsk, spendFromArgs, spendRefusal, SPEND_REFUSED } = await import(pathToFileURL(join(dist, 'spend-gate.js')).href);

const { cases } = JSON.parse(readFileSync(join(root, 'templates', 'evals', 'stage-labels.json'), 'utf8'));
let spend;
try {
  spend = spendFromArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
// The spend gate: no judge call before it passes.
if (spend === null) {
  const judged = cases.filter((c) => !c.codeOnly && !codeStage(c.run)).map((c) => c.id);
  console.error(spendRefusal([`would judge ${judged.length} of ${cases.length} case(s) with ${model} (the rest are labelled in code): ${judged.join(', ')}`, `  --cap $${cap}`], Math.min(cap, judged.length * 0.15)));
  process.exit(SPEND_REFUSED);
}
cap = Math.min(cap, spend);
const cliAsk = ceilingAsk(unbounded, spend).ask;
const perCall = Math.min(0.15, cap);
let spent = 0;
let passed = 0;
let cut = false;
for (const c of cases) {
  const known = codeStage(c.run);
  if (c.codeOnly || known) {
    const ok = !!c.codeOnly === !!known && known?.stage === c.expect;
    passed += ok ? 1 : 0;
    console.log(`${ok ? 'pass' : 'FAIL'} ${c.id}: ${known ? `code label ${known.stage}` : 'no code label'} (expected ${c.expect}${c.codeOnly ? ', in code' : ''}), no judge call`);
    continue;
  }
  if (spent + perCall > cap) {
    cut = true;
    console.log(`not run ${c.id}: the cost cap ($${cap}) is reached`);
    continue;
  }
  try {
    const r = await cliAsk({ prompt: stagePrompt(c.run), model, schema: STAGE_SCHEMA, cwd: neutralDir(), maxBudgetUsd: perCall });
    spent += r.costUsd;
    const stage = r.structured?.stage;
    const ok = stage === c.expect && JUDGE_STAGES.includes(stage);
    passed += ok ? 1 : 0;
    console.log(`${ok ? 'pass' : 'FAIL'} ${c.id}: judge said ${stage} (expected ${c.expect}), $${r.costUsd.toFixed(3)}\n  reason: ${String(r.structured?.reason ?? '').slice(0, 300)}`);
  } catch (e) {
    console.log(`FAIL ${c.id}: the judge call failed: ${e.message}`);
  }
}
console.log(`score: ${passed}/${cases.length}, model ${model}, cost ~$${spent.toFixed(3)} (the CLI's estimate; cap $${cap})`);
process.exit(passed === cases.length && !cut ? 0 : 1);
