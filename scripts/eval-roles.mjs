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
//   node scripts/eval-roles.mjs [--base origin/main] [--roles worker,evaluator-verdict] [--model sonnet]
//                               [--judge opus] [--runs 3] [--samples 3] [--cap 10] [--write-held-out] [--score]
//                               [--fix [3]] [--fixer opus] [--fix-cap 10]
//   --write-held-out: write a held-out set for each role that has none (one case-writer run per role, from its
//                     contract only); --score: score the current prompts once, no base (no --runs, no --fix).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = async (p) => import(pathToFileURL(join(root, 'dist', 'src', p)).href);
if (!existsSync(join(root, 'dist', 'src', 'skilleval.js'))) {
  console.error('build first: npm run build');
  process.exit(2);
}
const { cliAsk, compareInstructions, parseCases } = await load('skilleval.js');
const { evalRoleRuns, evalRolesOptions, fixLoop, fixReport, recordingAsk, redactHeldOut, roleReport, runsReport } = await load('eval-roles.js');
const { heldOutDir, readHeldOut, writeHeldOut, writeHeldOutCases } = await load('held-out.js');
const { stateDir } = await load('os/index.js');
const { EventLog } = await load('events/log.js');
const ts = (await import('typescript')).default;

let o;
try {
  o = evalRolesOptions(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

// Every model call is recorded as run.cost, in this machine's coordinator state.
mkdirSync(join(stateDir(), 'evals'), { recursive: true, mode: 0o700 });
const log = new EventLog(join(stateDir(), 'evals', 'events.db'));
const record = (c) => log.append('run.cost', { issue: null, ...c }, 'eval-roles');
const ask = recordingAsk(cliAsk, 'instruction-eval', record);
const writerAsk = recordingAsk(cliAsk, 'eval-case-writer', record);
const heldDir = heldOutDir(stateDir());

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
if (!o.scoreOnly) {
  let baseSource;
  try {
    baseSource = execFileSync('git', ['show', `${o.base}:src/roles.ts`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    console.error(`no src/roles.ts at ${o.base}`);
    process.exit(2);
  }
  before = await promptsOf(baseSource, 'base');
}

const casesDir = join(root, 'templates', 'evals', 'roles');
const withCases = readdirSync(casesDir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
const changed = o.scoreOnly ? withCases : withCases.filter((r) => before(r) !== after(r));
const roles = o.roles.length ? o.roles : changed.length ? changed : withCases;
if (!o.roles.length && !o.scoreOnly) console.log(changed.length ? `role prompts changed since ${o.base}: ${changed.join(', ')}` : `no role prompt changed since ${o.base}; evaluating all: ${roles.join(', ')}`);

let total = 0;
let bad = false;
for (const role of roles) {
  const file = join(casesDir, `${role}.md`);
  if (!existsSync(file)) {
    console.log(`role ${role}: no eval cases (${file})`);
    bad = true;
    continue;
  }
  let heldOut = readHeldOut(heldDir, role);
  if (!heldOut && o.writeHeldOut) {
    // The writer sees the role's contract only: the base prompt's (the one not being changed), else the current one.
    const { md, costUsd } = await writeHeldOutCases({ role, prompt: before(role) || after(role), ask: writerAsk, model: o.judge });
    writeHeldOut(heldDir, role, md);
    total += costUsd;
    heldOut = readHeldOut(heldDir, role);
    console.log(`role ${role}: wrote ${heldOut?.length ?? 0} held-out case(s) (~$${costUsd.toFixed(2)})`);
  }
  const cases = parseCases(readFileSync(file, 'utf8'));
  const compareOf = (baseText, headText) => (capUsd) => compareInstructions({ target: `role ${role}`, baseText, headText, cases, heldOut, model: o.model, judge: o.judge, samples: o.samples, capUsd, ask });
  let r;
  let loop = null;
  if (o.scoreOnly) {
    const c = await compareOf(null, after(role))(o.cap);
    total += c.costUsd;
    r = roleReport(c);
  } else {
    const runs = await evalRoleRuns({ target: `role ${role}`, runs: o.runs, capUsd: o.cap, samples: o.samples, compare: compareOf(before(role) || null, after(role)) });
    total += runs.costUsd;
    r = runsReport(runs);
    if (o.fixAttempts) {
      // The head's report first, so a fixer or rerun that throws doesn't take it with it.
      for (const line of r.lines) console.log(line);
      r = { ...r, lines: [] };
      // The held-out cases stay inside `rerun`; the loop gets their scores, ids and outcomes with the titles blanked
      // (redactHeldOut), and the fixer's prompt gets nothing of them. The proposal is printed, never written.
      const rerun = async (text, capUsd) => redactHeldOut(await evalRoleRuns({ target: `role ${role}`, runs: o.runs, capUsd, samples: o.samples, compare: compareOf(null, text) }));
      loop = await fixLoop({ role, prompt: after(role), start: redactHeldOut(runs), visible: cases, rerun, fixer: ask, fixerModel: o.fixer, maxAttempts: o.fixAttempts, capUsd: o.fixCap });
      total += loop.costUsd;
    }
  }
  for (const line of r.lines) console.log(line);
  if (loop) for (const line of fixReport(loop)) console.log(line);
  if (!heldOut) console.log(`  no held-out cases for ${role} in ${heldDir}: run with --write-held-out`);
  if (r.fails) bad = true;
}
console.log(`total: ~$${total.toFixed(2)} (the CLI's estimate; model ${o.model}, judge ${o.judge}, ${o.scoreOnly ? '1 run' : `${o.runs} run(s) per side`}, ${o.samples} sample(s) per case${o.fixAttempts ? `, fix loop of up to ${o.fixAttempts} attempt(s) by ${o.fixer}` : ''}; recorded as run.cost in ${join(stateDir(), 'evals', 'events.db')})`);
process.exit(bad ? 1 : 0);
