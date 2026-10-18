// The spend gate (#612): every command that can call a paid model refuses without --spend, before any model call,
// held-out read or state write, and reads held-out cases only from a store named on purpose. Each entry point runs
// here against a stand-in `claude` that records every call, with a temporary home and state dir: no real model, no
// real state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BRAND } from '../src/brand.js';
import { recordingAsk } from '../src/eval-roles.js';
import type { AgentRunner } from '../src/runner.js';
import { AskFailed, failedCost, runnerAsk } from '../src/skilleval.js';
import { projectStateDir } from '../src/guardrails/context.js';
import { HELD_OUT_ENV } from '../src/held-out-paths.js';
import { harnessEvalCommand } from '../src/harness-evals/cli.js';
import type { runSuite } from '../src/harness-evals/replay.js';
import { PUBLIC_TASKS_DIR } from '../src/harness-evals/tasks.js';
import { ceilingAsk, spendFromArgs } from '../src/spend-gate.js';
import { engineCli, exampleProject, repoRoot, STDIN_LINE } from './helpers.js';

const posix = { skip: process.platform === 'win32' && 'POSIX stand-in for claude' };
const MARK = 'HELDOUTMARK7731';

interface Call {
  args: string[];
  input: string;
}

/**
 * A temporary machine: home, state dir (not created: the test checks nothing creates it) and a recording claude.
 * With `failCostUsd`, every call fails as the CLI does at its budget (is_error) and reports that it spent that much.
 */
function machine(failCostUsd?: number) {
  const base = mkdtempSync(join(tmpdir(), 'spend-gate-'));
  const bin = join(base, 'bin');
  const home = join(base, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  const log = join(base, 'calls.jsonl');
  // Answers any --json-schema with a value of its shape: a plan, a judge's yes/no per item, a stage label.
  writeFileSync(
    join(bin, 'claude'),
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      "const input = args[0] === 'auth' ? '' : args.includes('--input-format') ? " + STDIN_LINE + " : fs.readFileSync(0, 'utf8');",
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input }) + '\\n');`,
      "if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }",
      failCostUsd === undefined ? '' : `console.log(JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, num_turns: 3, total_cost_usd: ${failCostUsd} })); process.exit(0);`,
      "const gen = (s) => { if (!s || typeof s !== 'object') return null; if (s.enum) return s.enum[0]; if (s.type === 'object') { const o = {}; for (const k of s.required || Object.keys(s.properties || {})) o[k] = gen((s.properties || {})[k]); return o; } if (s.type === 'boolean') return true; if (s.type === 'string') return 'x'; if (s.type === 'array') return []; if (s.type === 'number' || s.type === 'integer') return 0; return null; };",
      "const at = args.indexOf('--json-schema');",
      'const structured = gen(at >= 0 ? JSON.parse(args[at + 1]) : null);',
      "console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', structured_output: structured, num_turns: 1, total_cost_usd: 0.01 }));",
    ].join('\n') + '\n',
  );
  chmodSync(join(bin, 'claude'), 0o755);
  const state = join(base, 'state');
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), [`${BRAND.envPrefix}_STATE_DIR`]: state, PATH: `${bin}:${process.env.PATH}`, ANTHROPIC_API_KEY: '' };
  delete env[HELD_OUT_ENV];
  const calls = (): Call[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Call) : []);
  return { base, state, env, calls };
}

function run(script: string, args: string[], env: NodeJS.ProcessEnv, cwd = repoRoot) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8', timeout: 120_000 });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

const evalRoles = join(repoRoot, 'scripts', 'eval-roles.mjs');
const stageLabels = join(repoRoot, 'scripts', 'eval-stage-labels.mjs');

/** A held-out case for feedback-checks whose situation carries MARK, in `dir`'s roles/ (the store's layout). */
function plantHeldOut(dir: string) {
  mkdirSync(join(dir, 'roles'), { recursive: true });
  writeFileSync(join(dir, 'roles', 'feedback-checks.md'), `# Held-out\n\n## 1. Marked\n**Situation**\n- ${MARK}: a check is red.\n\n**Correct**\n- Reads the log.\n\n**Wrong**\n- Reruns blindly.\n`);
}
const sawHeldOut = (calls: Call[]) => calls.some((c) => c.input.includes(MARK));

test('eval-roles.mjs with no flags: exits 2 with its plan; no claude call, nothing under the state dir', posix, () => {
  const m = machine();
  const r = run(evalRoles, [], m.env);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /--spend/);
  assert.deepEqual(m.calls(), [], 'no model call');
  assert.ok(!existsSync(m.state), `nothing written to the state dir: ${existsSync(m.state) ? readdirSync(m.state).join(', ') : ''}`);
  const plan = run(evalRoles, ['--score', '--roles', 'feedback-checks'], m.env);
  assert.equal(plan.status, 2, plan.out);
  assert.match(plan.out, /would evaluate role\(s\): feedback-checks/);
  assert.match(plan.out, /the most it could spend: ~\$10\.00/);
  assert.match(plan.out, /held-out cases not read/);
  assert.deepEqual(m.calls(), []);
  assert.ok(!existsSync(m.state));
});

test('eval-roles.mjs --spend: calls the model, but reads no held-out case unless a store is named on purpose', posix, () => {
  const m = machine();
  plantHeldOut(join(m.state, 'evals', 'held-out'));
  const args = ['--score', '--roles', 'feedback-checks', '--samples', '1', '--spend', '1'];
  const r = run(evalRoles, args, m.env);
  assert.ok(m.calls().length > 0, `the run reached the model: ${r.out}`);
  assert.ok(!sawHeldOut(m.calls()), "the state dir's held-out case was not read");
  assert.match(r.out, /held-out cases not read/);
  assert.match(r.out, /held-out: no cases/);

  // Named on purpose: --held-out-from-state, or the env variable.
  const fromState = machine();
  plantHeldOut(join(fromState.state, 'evals', 'held-out'));
  run(evalRoles, [...args, '--held-out-from-state'], fromState.env);
  assert.ok(sawHeldOut(fromState.calls()), '--held-out-from-state reads the store in state');
  const fromEnv = machine();
  const store = join(fromEnv.base, 'store');
  plantHeldOut(store);
  run(evalRoles, args, { ...fromEnv.env, [HELD_OUT_ENV]: store });
  assert.ok(sawHeldOut(fromEnv.calls()), 'the env variable names a store');
});

test('eval-roles.mjs --write-held-out without a named store is refused before anything runs', posix, () => {
  const m = machine();
  const r = run(evalRoles, ['--score', '--roles', 'feedback-checks', '--write-held-out', '--spend', '1'], m.env);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /--write-held-out writes into a held-out store/);
  assert.deepEqual(m.calls(), []);
  assert.ok(!existsSync(m.state));
});

test('eval-stage-labels.mjs with no flags: exits 2 with its plan and no judge call; with --spend it judges', posix, () => {
  const m = machine();
  const r = run(stageLabels, [], m.env);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /would judge \d+ of \d+ case\(s\)/);
  assert.deepEqual(m.calls(), []);
  run(stageLabels, ['--spend', '1'], m.env);
  assert.ok(m.calls().length > 0, 'with --spend the judge is asked');
});

test('eval-stage-labels.mjs --spend: a call that fails after spending counts toward the ceiling and the total', posix, () => {
  const m = machine(0.15);
  const r = run(stageLabels, ['--spend', '0.2'], m.env);
  // $0.15 spent by the first (failed) call leaves less than another call's $0.15: the rest are not run.
  assert.equal(m.calls().length, 1, r.out);
  assert.match(r.out, /cost ~\$0\.150/, 'the total counts the failed call');
  assert.match(r.out, /not run/);
});

test('eval-roles.mjs: a dist/ whose eval-roles.js has no spend option still stops at the gate', posix, () => {
  const m = machine();
  // A root whose dist/src modules are the real ones, except an eval-roles.js whose options lack `spend` (an older
  // build of that one file); the script itself is this checkout's.
  const root = mkdtempSync(join(tmpdir(), 'stale-dist-'));
  const real = (p: string) => pathToFileURL(join(repoRoot, 'dist', 'src', p)).href;
  for (const p of ['skilleval.js', 'held-out.js', 'spend-gate.js', 'os/index.js', 'events/log.js']) {
    mkdirSync(dirname(join(root, 'dist', 'src', p)), { recursive: true });
    writeFileSync(join(root, 'dist', 'src', p), `export * from ${JSON.stringify(real(p))};\n`);
  }
  writeFileSync(
    join(root, 'dist', 'src', 'eval-roles.js'),
    `export * from ${JSON.stringify(real('eval-roles.js'))};\nimport { evalRolesOptions as current } from ${JSON.stringify(real('eval-roles.js'))};\nexport const evalRolesOptions = (argv) => { const o = current(argv); delete o.spend; return o; };\n`,
  );
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts', 'eval-roles.mjs'), readFileSync(evalRoles, 'utf8'));
  for (const d of ['node_modules', 'src', 'templates']) symlinkSync(join(repoRoot, d), join(root, d));
  const r = run(join(root, 'scripts', 'eval-roles.mjs'), ['--score', '--roles', 'feedback-checks'], m.env, root);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /not run: this makes paid model calls/);
  assert.deepEqual(m.calls(), []);
  assert.ok(!existsSync(m.state), 'no state written');
});

test('skill eval without --spend: exits 2 with its plan; no runner or claude call, no event log', posix, () => {
  const m = machine();
  const { dir: project, stateDir } = exampleProject();
  const skill = mkdtempSync(join(tmpdir(), 'skill-'));
  mkdirSync(join(skill, 'evals'));
  writeFileSync(join(skill, 'SKILL.md'), 'Read the alert row first.');
  writeFileSync(join(skill, 'evals', 'cases.md'), '# Evals\n\n## 1. A case\n**Situation**\n- An alert fires.\n\n**Correct**\n- Reads the row.\n\n**Wrong**\n- Edits the ledger.\n');
  const env = { ...m.env, [`${BRAND.envPrefix}_PROJECT_STATE_DIR`]: stateDir };
  const r = run(engineCli, ['skill', 'eval', skill, '--samples', '1'], env, project);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /would run 1 case\(s\)/);
  assert.deepEqual(m.calls(), []);
  assert.ok(!existsSync(join(stateDir, 'events.db')), 'no event log opened');
  assert.ok(!existsSync(join(skill, 'evals', 'results.json')), 'no results written');
  const spent = run(engineCli, ['skill', 'eval', skill, '--samples', '1', '--spend', '1'], env, project);
  assert.ok(m.calls().some((c) => c.args.includes('--model')), `with --spend the runner reaches claude: ${spent.out}`);
});

// ---- harness-eval run, in process with a recording suite (a real one would clone and run real agents)

function helpers(suite: typeof runSuite) {
  const flag = (args: string[], name: string) => {
    const i = args.indexOf(name);
    if (i >= 0) args.splice(i, 1);
    return i >= 0;
  };
  const option = (args: string[], name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  return { instance: undefined, option, flag, usage: 'usage', suite };
}

function recordingSuite() {
  const seen: Parameters<typeof runSuite>[0][] = [];
  const suite = (async (o: Parameters<typeof runSuite>[0]) => {
    seen.push(o);
    return { trigger: 'manual', engine: 'x', pr: null, runs: 1, passed: 1, cost_usd: 0, budget_usd: o.budgetUsd, wall_ms: 0, turns: 0, interventions: 0, stopped: false, tasks: [] };
  }) as unknown as typeof runSuite;
  return { suite, seen };
}

/** A held-out task in this root's state store, from a public one with its own id and a repository. */
function plantHeldOutTask(root: string): string {
  const pub = readdirSync(PUBLIC_TASKS_DIR).find((f) => f.endsWith('.yaml'))!;
  const dir = join(projectStateDir(root), 'evals', 'held-out', 'tasks');
  mkdirSync(dir, { recursive: true });
  const id = 'held-out-marked-task';
  writeFileSync(join(dir, `${id}.yaml`), `repo: example/private\n${readFileSync(join(PUBLIC_TASKS_DIR, pub), 'utf8').replace(/^id: .*$/m, `id: ${id}`)}`);
  return id;
}

test('harness-eval run without --spend: exits 2 with its plan; the suite never runs, no work dir or log is made', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const root = mkdtempSync(join(tmpdir(), 'he-root-'));
  const { suite, seen } = recordingSuite();
  const work = join(root, 'work');
  assert.equal(await harnessEvalCommand(root, 'run', ['--work', work, '--record'], helpers(suite)), 2);
  assert.equal(seen.length, 0, 'no runner, no agent');
  assert.ok(!existsSync(work), 'no work dir');
  assert.ok(!existsSync(join(projectStateDir(root), 'events.db')), 'no event log');
});

test('harness-eval run without --spend reads no held-out task, even with the store named', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const root = mkdtempSync(join(tmpdir(), 'he-root-'));
  // A held-out task with a public task's id: reading the store at all throws (two tasks have the id).
  const pub = readdirSync(PUBLIC_TASKS_DIR).find((f) => f.endsWith('.yaml'))!;
  const dir = join(projectStateDir(root), 'evals', 'held-out', 'tasks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'clash.yaml'), `repo: example/private\n${readFileSync(join(PUBLIC_TASKS_DIR, pub), 'utf8')}`);
  const { suite, seen } = recordingSuite();
  assert.equal(await harnessEvalCommand(root, 'run', ['--held-out-from-state'], helpers(suite)), 2);
  assert.equal(seen.length, 0);
});

test('harness-eval run --spend: the suite runs under the ceiling; held-out tasks only from a store named on purpose', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const root = mkdtempSync(join(tmpdir(), 'he-root-'));
  const id = plantHeldOutTask(root);
  const { suite, seen } = recordingSuite();
  assert.equal(await harnessEvalCommand(root, 'run', ['--spend', '3', '--budget', '10', '--work', join(root, 'w1')], helpers(suite)), 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.budgetUsd, 3, '--spend bounds the budget');
  assert.ok(seen[0]!.tasks.length > 0, 'the public tasks');
  assert.ok(!seen[0]!.tasks.some((x) => x.id === id), "the state dir's held-out task is not read");
  assert.equal(await harnessEvalCommand(root, 'run', ['--spend', '3', '--held-out-from-state', '--work', join(root, 'w2')], helpers(suite)), 0);
  assert.ok(seen[1]!.tasks.some((x) => x.id === id), '--held-out-from-state reads it');
});

test('spend gate: --spend takes a positive number of dollars; the ceiling cuts each call and stops at the limit', async () => {
  assert.equal(spendFromArgs([]), null);
  assert.equal(spendFromArgs(['--spend', '2.5']), 2.5);
  for (const bad of [['--spend'], ['--spend', '0'], ['--spend', '-1'], ['--spend', 'five'], ['--spend', '--score'], ['--spend', '']]) assert.throws(() => spendFromArgs(bad), /--spend takes/, bad.join(' '));
  const budgets: number[] = [];
  const b = ceilingAsk(async (req) => {
    budgets.push(req.maxBudgetUsd);
    return { structured: {}, costUsd: 0.4 };
  }, 1);
  const req = { prompt: 'p', model: 'm', schema: {}, cwd: '.', maxBudgetUsd: 2 };
  await b.ask(req);
  await b.ask(req);
  await b.ask(req);
  await assert.rejects(b.ask(req), /ceiling \(\$1\) is reached/);
  assert.deepEqual(budgets.map((x) => Math.round(x * 100) / 100), [1, 0.6, 0.2], 'each call gets at most what is left');
  assert.equal(b.left(), 0);
  assert.throws(() => spendFromArgs(['--spend=5']), /with a space/, 'the = form is named, not taken as absent');
});

test('spend gate: a call that fails after spending counts; the runner and the record carry its cost', async () => {
  let asked = 0;
  const failing = ceilingAsk(async () => {
    asked++;
    throw new AskFailed('claude failed: max budget', 0.6);
  }, 1);
  const req = { prompt: 'p', model: 'm', schema: {}, cwd: '.', maxBudgetUsd: 2 };
  await assert.rejects(failing.ask(req), /max budget/);
  await assert.rejects(failing.ask(req), /max budget/);
  assert.equal(Math.round(failing.spent() * 100) / 100, 1.2, 'both failed calls counted');
  await assert.rejects(failing.ask(req), /ceiling \(\$1\) is reached/);
  assert.equal(asked, 2, 'no third call');

  const runner = { run: async () => ({ reason: 'failed', costUsd: 0.3, turns: 3, detail: 'budget', model: 'm' }) } as unknown as AgentRunner;
  const recorded: number[] = [];
  const err = await recordingAsk(runnerAsk(runner, () => {}), 'instruction-eval', (c) => recorded.push(c.usd))(req).then(
    () => null,
    (e: unknown) => e,
  );
  assert.equal(failedCost(err), 0.3, "runnerAsk's failure carries the run's cost");
  assert.deepEqual(recorded, [0.3], 'and the failed call is recorded as run.cost');
});
