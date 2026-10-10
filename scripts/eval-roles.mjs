#!/usr/bin/env node
// Before/after eval of the engine's role prompts (src/roles.ts): the same cases
// (templates/evals/roles/<role>.md) against the prompt at a base commit and in
// the working tree, through the installed `claude` CLI on its own login (API
// keys are stripped: subscription runs, never per-token billing). Prints each
// role's score at both ends, the cases that changed, and the cost (the CLI's
// estimate). Exits 1 when a score drops or the cost cap cuts an eval short.
// Needs a build first (npm run build).
//   node scripts/eval-roles.mjs [--base origin/main] [--roles worker,evaluator-verdict]
//                               [--model sonnet] [--judge opus] [--samples 1] [--cap 5]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const base = arg('base', 'origin/main');
const model = arg('model', 'sonnet');
const judge = arg('judge', 'opus');
const samples = Number(arg('samples', '1'));
const cap = Number(arg('cap', '5'));

const dist = join(root, 'dist', 'src', 'skilleval.js');
if (!existsSync(dist)) {
  console.error('build first: npm run build');
  process.exit(2);
}
const { cliAsk, compareInstructions, comparisonDiff, comparisonLine, parseCases } = await import(pathToFileURL(dist).href);
const ts = (await import('typescript')).default;

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

let baseSource;
try {
  baseSource = execFileSync('git', ['show', `${base}:src/roles.ts`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch {
  console.error(`no src/roles.ts at ${base}`);
  process.exit(2);
}
const before = await promptsOf(baseSource, 'base');
const after = await promptsOf(readFileSync(join(root, 'src', 'roles.ts'), 'utf8'), 'head');

const casesDir = join(root, 'templates', 'evals', 'roles');
const withCases = readdirSync(casesDir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
const asked = arg('roles', '');
const changed = withCases.filter((r) => before(r) !== after(r));
const roles = asked ? asked.split(',') : changed.length ? changed : withCases;
if (!asked) console.log(changed.length ? `role prompts changed since ${base}: ${changed.join(', ')}` : `no role prompt changed since ${base}; evaluating all: ${roles.join(', ')}`);

let total = 0;
let bad = false;
for (const role of roles) {
  const file = join(casesDir, `${role}.md`);
  if (!existsSync(file)) {
    console.log(`role ${role}: no eval cases (${file})`);
    bad = true;
    continue;
  }
  const c = await compareInstructions({ target: `role ${role}`, baseText: before(role) || null, headText: after(role), cases: parseCases(readFileSync(file, 'utf8')), model, judge, samples, capUsd: cap, ask: cliAsk });
  total += c.costUsd;
  console.log(comparisonLine(c));
  for (const d of comparisonDiff(c)) console.log(`  ${d}`);
  if (c.dropped || c.incomplete) bad = true;
}
console.log(`total: ~$${total.toFixed(2)} (the CLI's estimate; model ${model}, judge ${judge}, ${samples} sample(s) per case)`);
process.exit(bad ? 1 : 0);
