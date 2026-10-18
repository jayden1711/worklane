#!/usr/bin/env node
// Before/after eval of the engine's role prompts (src/roles.ts), through the installed `claude` CLI on its own
// login (API keys are stripped: subscription runs, never per-token billing). Each role is scored on two sets:
// its visible cases (templates/evals/roles/<role>.md) and its held-out cases (written from the role's contract
// by a separate agent and kept in this machine's coordinator state, never in the repo: src/held-out.ts). The
// judge answers yes/no per rubric item; a score is the items met. Prints `visible a/b → c/d` and
// `held-out a/b → c/d` per role, the cases that changed, and the cost (the CLI's estimate); every model call is
// recorded as run.cost in <state>/evals/events.db. 3 samples per case unless fewer are asked for (then noted).
// Base and head each run --runs times (default 3; --samples stays samples per case within one run), and each role's
// line gives the mean and min-max of its visible and held-out scores per side: one run's delta is noise.
// A score drops when head's mean falls below base's mean by more than base's min-max spread.
// Exits 1 when a role's held-out score drops, is incomplete or is missing, or its visible score drops.
// --cap is dollars per role, the TOTAL across its N runs (cost grows with --runs): once reached, the remaining
// runs don't start and the role is incomplete, which fails it.
// The judge must be a different model from --model: the same one is refused before anything runs.
// --fix [n] (default 3 attempts): for a role whose head has a failing case, a fixer (--fixer, default opus) proposes
// a revised prompt from the failing visible cases only (never a held-out case, score or outcome), the proposal is
// rerun (visible and held-out, --runs runs) and this repeats up to n attempts or until every case passes. An attempt
// whose held-out score drops is rejected; held-out never ranks attempts (the best is the highest visible mean).
// Each attempt's diff, scores and cost are printed, then the best attempt.
// It only proposes: this script never edits src/roles.ts; apply the diff by hand and rerun. --fix-cap is dollars per
// role for the loop (fixer calls and reruns), on top of --cap. The exit code is the head's verdict, as without --fix.
// Needs a build first (npm run build).
// Nothing is spent without --spend <usd> (#612, src/spend-gate.ts): the most this run may spend in all, which bounds
// --cap and --fix-cap. Without it the script prints its plan (the roles, the most it could spend) and exits 2, before
// any model call, held-out read or state write. Held-out cases are read (and written) only from a store named on
// purpose: WORKLANE_HELD_OUT_DIR, or --held-out-from-state for the one in this machine's state; without either, the
// visible cases are scored alone and the report says so (a role without held-out scores still fails the verdict).
//   node scripts/eval-roles.mjs --spend <usd> [--held-out-from-state] [--base origin/main]
//                               [--roles worker,evaluator-verdict] [--model sonnet] [--judge opus] [--runs 3]
//                               [--samples 3] [--cap 10] [--write-held-out] [--score] [--fix [3]] [--fixer opus]
//                               [--fix-cap 10]
//   --write-held-out: write a held-out set for each role that has none (one case-writer run per role, from its
//                     contract only); --score: score the current prompts once, no base (no --runs, no --fix).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = async (p) => import(pathToFileURL(join(root, 'dist', 'src', p)).href);
// A build without the spend gate (an old dist/) would run unguarded: refuse it.
if (!existsSync(join(root, 'dist', 'src', 'skilleval.js')) || !existsSync(join(root, 'dist', 'src', 'spend-gate.js'))) {
  console.error('build first: npm run build');
  process.exit(2);
}
const { cliAsk, compareInstructions, parseCases } = await load('skilleval.js');
const { evalRoleRuns, evalRolesMaxSpend, evalRolesOptions, fixLoop, fixReport, recordingAsk, redactHeldOut, roleReport, runsReport, WRITER_BUDGET_USD } = await load('eval-roles.js');
const { heldOutDir, readHeldOut, writeHeldOut, writeHeldOutCases } = await load('held-out.js');
const { ceilingAsk, HELD_OUT_NOT_ASKED, heldOutAllowed, SPEND_FLAG, spendFromArgs, spendRefusal, SPEND_REFUSED } = await load('spend-gate.js');
const { stateDir } = await load('os/index.js');
const { EventLog } = await load('events/log.js');
const ts = (await import('typescript')).default;
// An eval-roles.js older than the gate (a partly stale dist/) has no evalRolesMaxSpend: refuse it too.
if (typeof evalRolesMaxSpend !== 'function') {
  console.error('build first: npm run build (dist/ is older than this script)');
  process.exit(2);
}

let o;
// The ceiling is read here, from spend-gate.js, never from the options: an older eval-roles.js in dist/ has no
// `spend` field, and the gate must not depend on it.
let spend;
try {
  spend = spendFromArgs(process.argv.slice(2));
  o = evalRolesOptions(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

/** The role prompts of one version of src/roles.ts, by transpiling it (it imports only node built-ins and types). */
async function promptsOf(source, label) {
  const dir = mkdtempSync(join(tmpdir(), 'roles-'));
  try {
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    const file = join(dir, `roles-${label}.mjs`);
    writeFileSync(file, js);
    const m = await import(pathToFileURL(file).href);
    const empty = join(dir, 'no-project');
    return (role) => m.rolePrompt(empty, role);
  } finally {
    // the module is loaded; its file can go
    rmSync(dir, { recursive: true, force: true });
  }
}

const after = await promptsOf(readFileSync(join(root, 'src', 'roles.ts'), 'utf8'), 'head');
let before = () => null;
let noBase = false;
if (!o.scoreOnly) {
  let baseSource;
  try {
    baseSource = execFileSync('git', ['show', `${o.base}:src/roles.ts`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    console.error(`no src/roles.ts at ${o.base}`);
    // Without --spend the plan still prints (and the run stops there anyway).
    if (spend !== null) process.exit(2);
    noBase = true;
  }
  if (!noBase) before = await promptsOf(baseSource, 'base');
}

const casesDir = join(root, 'templates', 'evals', 'roles');
const withCases = readdirSync(casesDir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
const changed = o.scoreOnly ? withCases : withCases.filter((r) => before(r) !== after(r));
const roles = o.roles.length ? o.roles : changed.length ? changed : withCases;
if (!o.roles.length && !o.scoreOnly && !noBase) console.log(changed.length ? `role prompts changed since ${o.base}: ${changed.join(', ')}` : `no role prompt changed since ${o.base}; evaluating all: ${roles.join(', ')}`);

// The held-out store, only when the caller named one (#612): never this machine's by default.
const heldDir = heldOutAllowed(process.argv.slice(2)) ? heldOutDir(stateDir()) : null;

// The spend gate: no model call, held-out read or state write before it passes.
if (spend === null) {
  const plan = [
    `would evaluate role(s): ${roles.join(', ')}`,
    `  ${o.scoreOnly ? 'the current prompts, once' : `base ${o.base} against the working tree, ${o.runs} run(s) per side`}; model ${o.model}, judge ${o.judge}, ${o.samples} sample(s) per case`,
    `  --cap $${o.cap} per role${o.fixAttempts ? `, fix loop of up to ${o.fixAttempts} attempt(s) by ${o.fixer} under --fix-cap $${o.fixCap} per role` : ''}${o.writeHeldOut ? `, a held-out case writer ($${WRITER_BUDGET_USD}) per role that has none` : ''}`,
    `  ${heldDir ? `held-out cases from ${heldDir}` : HELD_OUT_NOT_ASKED}`,
  ];
  console.error(spendRefusal(plan, evalRolesMaxSpend(o, roles.length)));
  process.exit(SPEND_REFUSED);
}

// Every model call is recorded as run.cost, in this machine's coordinator state, and the whole run stays under --spend.
mkdirSync(join(stateDir(), 'evals'), { recursive: true, mode: 0o700 });
const log = new EventLog(join(stateDir(), 'evals', 'events.db'));
const record = (c) => log.append('run.cost', { issue: null, ...c }, 'eval-roles');
const bounded = ceilingAsk(cliAsk, spend);
const ask = recordingAsk(bounded.ask, 'instruction-eval', record);
const writerAsk = recordingAsk(bounded.ask, 'eval-case-writer', record);
if (!heldDir) console.log(`${HELD_OUT_NOT_ASKED}; scoring the visible cases only (the verdict needs held-out scores)`);

let total = 0;
let bad = false;
for (const role of roles) {
  const file = join(casesDir, `${role}.md`);
  if (!existsSync(file)) {
    console.log(`role ${role}: no eval cases (${file})`);
    bad = true;
    continue;
  }
  const spentOut = () => {
    console.log(`role ${role}: not run: the ${SPEND_FLAG} ceiling ($${spend}) is reached`);
    bad = true;
  };
  if (!(bounded.left() > 0)) {
    spentOut();
    continue;
  }
  let heldOut = heldDir ? readHeldOut(heldDir, role) : null;
  if (!heldOut && heldDir && o.writeHeldOut) {
    // The writer sees the role's contract only: the base prompt's (the one not being changed), else the current one.
    const { md, costUsd } = await writeHeldOutCases({ role, prompt: before(role) || after(role), ask: writerAsk, model: o.judge, maxBudgetUsd: WRITER_BUDGET_USD });
    writeHeldOut(heldDir, role, md);
    total += costUsd;
    heldOut = readHeldOut(heldDir, role);
    console.log(`role ${role}: wrote ${heldOut?.length ?? 0} held-out case(s) (~$${costUsd.toFixed(2)})`);
  }
  // The role's cap, bounded by what is left of --spend.
  const cap = Math.min(o.cap, bounded.left());
  if (!(cap > 0)) {
    spentOut();
    continue;
  }
  const cases = parseCases(readFileSync(file, 'utf8'));
  const compareOf = (baseText, headText) => (capUsd) => compareInstructions({ target: `role ${role}`, baseText, headText, cases, heldOut, model: o.model, judge: o.judge, samples: o.samples, capUsd, ask });
  let r;
  let loop = null;
  if (o.scoreOnly) {
    const c = await compareOf(null, after(role))(cap);
    total += c.costUsd;
    r = roleReport(c);
  } else {
    const runs = await evalRoleRuns({ target: `role ${role}`, runs: o.runs, capUsd: cap, samples: o.samples, compare: compareOf(before(role) || null, after(role)) });
    total += runs.costUsd;
    r = runsReport(runs);
    if (o.fixAttempts) {
      // The head's report first, so a fixer or rerun that throws doesn't take it with it.
      for (const line of r.lines) console.log(line);
      r = { ...r, lines: [] };
      // The held-out cases stay inside `rerun`; the loop gets their scores, ids and outcomes with the titles blanked
      // (redactHeldOut), and the fixer's prompt gets nothing of them. The proposal is printed, never written.
      const rerun = async (text, capUsd) => redactHeldOut(await evalRoleRuns({ target: `role ${role}`, runs: o.runs, capUsd, samples: o.samples, compare: compareOf(null, text) }));
      loop = await fixLoop({ role, prompt: after(role), start: redactHeldOut(runs), visible: cases, rerun, fixer: ask, fixerModel: o.fixer, maxAttempts: o.fixAttempts, capUsd: Math.min(o.fixCap, bounded.left()) });
      total += loop.costUsd;
    }
  }
  for (const line of r.lines) console.log(line);
  if (loop) for (const line of fixReport(loop)) console.log(line);
  if (!heldOut && heldDir) console.log(`  no held-out cases for ${role} in ${heldDir}: run with --write-held-out`);
  if (r.fails) bad = true;
}
// The total through the ceiling: every call, including any that failed after spending.
total = Math.max(total, bounded.spent());
console.log(`total: ~$${total.toFixed(2)} (the CLI's estimate; model ${o.model}, judge ${o.judge}, ${o.scoreOnly ? '1 run' : `${o.runs} run(s) per side`}, ${o.samples} sample(s) per case${o.fixAttempts ? `, fix loop of up to ${o.fixAttempts} attempt(s) by ${o.fixer}` : ''}; ${SPEND_FLAG} $${spend}; recorded as run.cost in ${join(stateDir(), 'evals', 'events.db')})`);
process.exit(bad ? 1 : 0);
