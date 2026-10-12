#!/usr/bin/env node
// Before/after eval of the engine's role prompts (src/roles.ts), through the installed `claude` CLI on its own
// login (API keys are stripped: subscription runs, never per-token billing). Each role is scored on two sets:
// its visible cases (templates/evals/roles/<role>.md) and its held-out cases (written from the role's contract
// by a separate agent and kept in this machine's coordinator state, never in the repo: src/held-out.ts). The
// judge answers yes/no per rubric item; a score is the items met. Prints `visible a/b → c/d` and
// `held-out a/b → c/d` per role, the cases that changed, and the cost (the CLI's estimate); every model call is
// recorded as run.cost in <state>/evals/events.db. 3 samples per case unless fewer are asked for (then noted).
// Exits 1 when a role's held-out score drops, is incomplete or is missing, or its visible score drops.
// Needs a build first (npm run build).
//   node scripts/eval-roles.mjs [--base origin/main] [--roles worker,evaluator-verdict] [--model sonnet]
//                               [--judge opus] [--samples 3] [--cap 10] [--write-held-out] [--score]
//   --write-held-out: write a held-out set for each role that has none (one case-writer run per role, from its
//                     contract only); --score: score the current prompts only, no base.
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
const { evalRolesOptions, recordingAsk, roleReport } = await load('eval-roles.js');
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
  const c = await compareInstructions({ target: `role ${role}`, baseText: o.scoreOnly ? null : before(role) || null, headText: after(role), cases: parseCases(readFileSync(file, 'utf8')), heldOut, model: o.model, judge: o.judge, samples: o.samples, capUsd: o.cap, ask });
  total += c.costUsd;
  const r = roleReport(c);
  for (const line of r.lines) console.log(line);
  if (!heldOut) console.log(`  no held-out cases for ${role} in ${heldDir}: run with --write-held-out`);
  if (r.fails) bad = true;
}
console.log(`total: ~$${total.toFixed(2)} (the CLI's estimate; model ${o.model}, judge ${o.judge}, ${o.samples} sample(s) per case; recorded as run.cost in ${join(stateDir(), 'evals', 'events.db')})`);
process.exit(bad ? 1 : 0);
