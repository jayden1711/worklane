// #847: a task's hidden paths (an experiment's eval and scorer, the harness's config) are refused for every tool
// that can read them or list them, not for Read alone. The secret check takes each call's paths from one function
// (src/guardrails/access.ts), so a tool it doesn't know is checked on every string it is given, never let through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { runHook } from '../src/hook.js';
import { GuardrailsConfig } from '../src/config/schema.js';
import { exampleContext } from '../src/guardrails/check.js';
import { evaluate } from '../src/guardrails/engine.js';
import { exampleProject } from './helpers.js';

const AGENT = `${BRAND.envPrefix}_AGENT`;
const TASK = `${BRAND.envPrefix}_TASK_FILE`;
const STATE = `${BRAND.envPrefix}_STATE_DIR`;

type Answer = { permissionDecision: string; permissionDecisionReason: string } | null;
const answer = (out: { stdout?: string }): Answer => (out.stdout ? (JSON.parse(out.stdout) as { hookSpecificOutput: NonNullable<Answer> }).hookSpecificOutput : null);

/** A project (examples/basic) holding a hidden directory, and a task file that hides it. */
function setup() {
  const { dir, stateDir } = exampleProject();
  mkdirSync(join(dir, 'evals-secret', 'deep'), { recursive: true });
  writeFileSync(join(dir, 'evals-secret', 'score.py'), 'EXPECTED = 42\n');
  writeFileSync(join(dir, 'evals-secret', 'deep', 'cases.json'), '[]\n');
  writeFileSync(join(dir, 'evals-secret', 'nb.ipynb'), '{}\n');
  symlinkSync(join(dir, 'evals-secret'), join(dir, 'peek'));
  const tasks = mkdtempSync(join(tmpdir(), 'tasks-'));
  const taskFile = join(tasks, 'exp-1.json');
  writeFileSync(taskFile, JSON.stringify({ id: 'exp-1', done_when: [{ manual: 'checked by the coordinator' }], frozen: [], hidden: ['evals-secret/**'] }));
  const call = async (tool: string, input: Record<string, unknown>, opts: { cwd?: string; task?: boolean } = {}) =>
    answer(await runHook('pre-tool-use', { hook_event_name: 'PreToolUse', cwd: opts.cwd ?? dir, tool_name: tool, tool_input: input, session_id: 's' }, { ...process.env, [AGENT]: '1', [STATE]: stateDir, ...(opts.task === false ? {} : { [TASK]: taskFile }) }));
  return { dir, call };
}

test('a task\'s hidden directory is refused to Read, Glob, Grep, NotebookRead, LS, Bash and a tool the guard does not know', async () => {
  const { dir, call } = setup();
  const refused: [string, string, Record<string, unknown>][] = [
    ['Read a file in it', 'Read', { file_path: join(dir, 'evals-secret', 'score.py') }],
    ['Read the directory', 'Read', { file_path: 'evals-secret' }],
    ['Glob its pattern', 'Glob', { pattern: 'evals-secret/**' }],
    ['Glob an absolute pattern into it', 'Glob', { pattern: join(dir, 'evals-secret', '*') }],
    ['Glob with its path', 'Glob', { pattern: '*', path: 'evals-secret' }],
    ['Glob with its path, absolute', 'Glob', { pattern: '**/*', path: join(dir, 'evals-secret') }],
    ['Glob a pattern that climbs into it', 'Glob', { pattern: 'src/../evals-secret/*' }],
    ['Glob a brace pattern that names it', 'Glob', { pattern: '{src,evals-secret}/**' }],
    ['Glob from the root, its files match', 'Glob', { pattern: '**/*.py' }],
    ['Glob through a symlink to it', 'Glob', { pattern: '*', path: 'peek' }],
    ['Glob with its file as the path, and a pattern that climbs out', 'Glob', { path: 'evals-secret/score.py', pattern: '../../src/*' }],
    ['Glob with a backslash escape', 'Glob', { pattern: 'evals\\-secret/*' }],
    ['Grep its path', 'Grep', { pattern: 'EXPECTED', path: 'evals-secret' }],
    ['Grep a file in it', 'Grep', { pattern: 'EXPECTED', path: join(dir, 'evals-secret', 'score.py') }],
    ['Grep with no path (the root holds it)', 'Grep', { pattern: 'EXPECTED' }],
    ['Grep the root', 'Grep', { pattern: 'EXPECTED', path: dir }],
    ['Grep a path that climbs to the root', 'Grep', { pattern: 'EXPECTED', path: 'src/..' }],
    ['Grep a path outside it whose glob reaches into it', 'Grep', { pattern: 'EXPECTED', path: '.', glob: 'evals-secret/**' }],
    ['Grep the root with a glob its files match', 'Grep', { pattern: 'EXPECTED', path: '.', glob: '*.py' }],
    ['Grep the root with a brace glob that names it', 'Grep', { pattern: 'EXPECTED', glob: '{src,evals-secret}/**' }],
    ['Grep the root with a glob it cannot read', 'Grep', { pattern: 'EXPECTED', glob: '[es]*/**' }],
    ['Grep through a symlink to it', 'Grep', { pattern: 'EXPECTED', path: 'peek' }],
    ['Grep the root with a backslash escape in its glob', 'Grep', { pattern: 'EXPECTED', glob: 'score\\.py' }],
    ['Grep the root with a glob that may be split at a space', 'Grep', { pattern: 'EXPECTED', glob: '*.ts *.py' }],
    ['Grep the root with a glob that may be split at a comma', 'Grep', { pattern: 'EXPECTED', glob: '*.md,score.py' }],
    ['NotebookRead in it', 'NotebookRead', { notebook_path: 'evals-secret/nb.ipynb' }],
    ['LS it', 'LS', { path: join(dir, 'evals-secret') }],
    ['LS the root', 'LS', { path: dir }],
    ['Bash ls it', 'Bash', { command: 'ls evals-secret' }],
    ['Bash grep -r it', 'Bash', { command: 'grep -r EXPECTED evals-secret' }],
    ['Bash cat a file in it', 'Bash', { command: 'cat evals-secret/score.py' }],
    ['Bash with it as an option value', 'Bash', { command: 'tar --directory=evals-secret -cf /tmp/x.tar .' }],
    ['Bash reading a file in it by redirect', 'Bash', { command: 'wc -l < evals-secret/score.py' }],
    ['Bash running a script in it', 'Bash', { command: './evals-secret/score.py' }],
    ['Bash with a wildcard the shell expands into it', 'Bash', { command: 'cat evals-secre?/score.py' }],
    ['Bash with a wildcard directory', 'Bash', { command: 'cat */score.py' }],
    ['Bash with a class', 'Bash', { command: 'ls [e]vals-*' }],
    ['Bash with braces', 'Bash', { command: 'cat ev{x,als-secret}/score.py' }],
    ['Bash in a nested shell', 'Bash', { command: 'bash -c "head -n1 evals-secret/deep/cases.json"' }],
    ['an unknown tool given its path as a key', 'SomeNewTool', { files: { 'evals-secret/score.py': true } }],
    ['an unknown tool given its path', 'mcp__files__list_directory', { path: 'evals-secret' }],
    ['an unknown tool given the root', 'mcp__files__search', { root: dir, query: 'EXPECTED' }],
    ['an unknown tool with the path nested', 'SomeNewTool', { targets: [{ where: join(dir, 'evals-secret', 'score.py') }] }],
  ];
  const letThrough: string[] = [];
  for (const [what, tool, input] of refused) {
    const a = await call(tool, input);
    if (a?.permissionDecision !== 'deny' || !/secret-path/.test(a.permissionDecisionReason)) letThrough.push(`${what}: ${tool} ${JSON.stringify(input)}`);
  }
  assert.deepEqual(letThrough, [], `${letThrough.length} of ${refused.length} calls over the hidden directory were not refused`);
});

test('a task\'s hidden directory leaves every other read alone', async () => {
  const { dir, call } = setup();
  const allowed: [string, string, Record<string, unknown>][] = [
    ['Read a source file', 'Read', { file_path: join(dir, 'src', 'price.js') }],
    ['Glob the source', 'Glob', { pattern: 'src/**/*.js' }],
    ['Glob from the root, no hidden file matches', 'Glob', { pattern: '**/*.js' }],
    ['Grep the source', 'Grep', { pattern: 'price', path: 'src' }],
    ['Grep the root with a glob no hidden file matches', 'Grep', { pattern: 'price', glob: '*.js' }],
    ['Grep the root with an anchored glob elsewhere', 'Grep', { pattern: 'price', glob: 'src/**' }],
    ['Grep the root with a comma inside braces', 'Grep', { pattern: 'price', glob: '*.{js,md}' }],
    ['Grep a sibling whose name starts the same', 'Grep', { pattern: 'price', path: 'evals' }],
    ['LS the source', 'LS', { path: join(dir, 'src') }],
    ['Bash ls the source', 'Bash', { command: 'ls src' }],
    ['Bash grep the source', 'Bash', { command: 'grep -r price src' }],
    ['Bash with wildcards elsewhere', 'Bash', { command: 'cat src/*.js *.md && ls test/*' }],
    ['Bash with a regex and a stray brace', 'Bash', { command: "grep -E 'pr.*ce' src/price.js | sed 's/{/x/' | awk '{print $1}'" }],
    ['Bash with a dot-name wildcard', 'Bash', { command: 'ls -d .*' }],
    ['Edit a source file', 'Edit', { file_path: join(dir, 'src', 'price.js'), old_string: 'evals-secret', new_string: 'evals-secret/score.py' }],
    ['WebFetch an allowed host', 'WebFetch', { url: 'https://nodejs.org/api', prompt: 'evals-secret' }],
  ];
  const refusedNow: string[] = [];
  for (const [what, tool, input] of allowed) {
    const a = await call(tool, input);
    if (a?.permissionDecision === 'deny') refusedNow.push(`${what}: ${tool} ${JSON.stringify(input)}: ${a.permissionDecisionReason}`);
  }
  assert.deepEqual(refusedNow, [], `${refusedNow.length} of ${allowed.length} ordinary calls were refused`);
  // Hidden is the task's: an agent run with no task file reads the directory as any other.
  assert.notEqual((await call('Grep', { pattern: 'EXPECTED', path: 'evals-secret' }, { task: false }))?.permissionDecision, 'deny');
  assert.notEqual((await call('Glob', { pattern: 'evals-secret/**' }, { task: false }))?.permissionDecision, 'deny');
});

test('a project\'s secret files: a Glob or Grep that would list or search them is refused, an exclusion still applies', () => {
  const p = mkdtempSync(join(tmpdir(), 'secrets-'));
  mkdirSync(join(p, 'src'));
  writeFileSync(join(p, 'src', 'a.ts'), 'x\n');
  writeFileSync(join(p, '.env.example'), 'TOKEN=\n');
  const g = GuardrailsConfig.parse({ version: 1, rules: [], secret_paths: ['./.env', './.env.*', '!./.env.example'], examples: { must_block: [], must_ask: [], must_allow: [] } });
  const decide = (tool: string, input: Record<string, unknown>) => evaluate({ tool, input, cwd: p }, g, { ...exampleContext(g, p, true), home: join(p, 'no-home') }).decision;
  // Only .env.example (excluded) is there: nothing to refuse.
  assert.equal(decide('Grep', { pattern: 'TOKEN' }), 'none');
  assert.equal(decide('Glob', { pattern: '.env*' }), 'none');
  writeFileSync(join(p, '.env.production'), 'TOKEN=real\n');
  assert.equal(decide('Grep', { pattern: 'TOKEN' }), 'deny', 'a Grep over the root would print .env.production');
  assert.equal(decide('Glob', { pattern: '.env*' }), 'deny', 'a Glob would list it');
  assert.equal(decide('Grep', { pattern: 'TOKEN', glob: '*.ts' }), 'none', 'a glob that leaves it out');
  assert.equal(decide('Grep', { pattern: 'TOKEN', path: 'src' }), 'none', 'a directory that does not hold it');
  assert.equal(decide('Grep', { pattern: 'TOKEN', path: '.env.production' }), 'deny');
  assert.equal(decide('Bash', { command: 'cat < .env.production' }), 'deny', 'read by an input redirect');
  assert.equal(decide('Bash', { command: 'cat < .env.example' }), 'none');
  assert.equal(decide('Bash', { command: 'cat .env*' }), 'deny', 'a wildcard the shell expands to it');
  assert.equal(decide('Bash', { command: 'ls *' }), 'none', "the shell's * does not start a dot-name");
});

/** A tree of `dirs` directories of 1,000 empty files each. */
function bigTree(dirs: number): string {
  const p = mkdtempSync(join(tmpdir(), 'big-'));
  for (let d = 0; d < dirs; d++) {
    mkdirSync(join(p, `d${d}`));
    for (let f = 0; f < 1000; f++) writeFileSync(join(p, `d${d}`, `f${f}`), '');
  }
  return p;
}

test('a directory too large to check is refused for a Glob or Grep over it when a secret could be in it, never let through', () => {
  const p = bigTree(21);
  const g = GuardrailsConfig.parse({ version: 1, rules: [], secret_paths: ['**/.env'], examples: { must_block: [], must_ask: [], must_allow: [] } });
  const decide = (input: Record<string, unknown>) => evaluate({ tool: 'Grep', input, cwd: p }, g, { ...exampleContext(g, p, true), home: join(p, 'no-home') });
  const v = decide({ pattern: 'x' });
  assert.equal(v.decision, 'deny');
  assert.match(v.reason ?? '', /too large to check/);
  assert.equal(decide({ pattern: 'x', path: 'd3' }).decision, 'none', 'a narrower path is checked and let through');
});

// WHY (#887 review): the agent hook times out at 30 s, and a hook that times out doesn't block the call. So one call's
// walks share one budget: many wildcard words over a tree just under the cap are refused fast, never walked one by one.
test('one call\'s walks share one budget: many wildcard words over a large tree are refused, well within the hook\'s timeout', () => {
  const p = bigTree(18);
  // `**/.env` matches anywhere (as the built-in held-out and dashboard-key globs do), so each word walks the tree.
  const g = GuardrailsConfig.parse({ version: 1, rules: [], secret_paths: ['evals-secret/**', '**/.env'], examples: { must_block: [], must_ask: [], must_allow: [] } });
  const command = `ls ${Array.from({ length: 100 }, () => '*/*').join(' ')} ; cat evals-secre?/score.py`;
  const started = Date.now();
  const v = evaluate({ tool: 'Bash', input: { command }, cwd: p }, g, { ...exampleContext(g, p, true), home: join(p, 'no-home') });
  const ms = Date.now() - started;
  assert.equal(v.decision, 'deny', v.reason);
  assert.match(v.reason ?? '', /too large to check/);
  assert.ok(ms < 10_000, `the check took ${ms} ms`);
});

test('a secret glob with a literal start is walked whole: its files under node_modules are found from above, at and below it', () => {
  const p = mkdtempSync(join(tmpdir(), 'cfg-'));
  mkdirSync(join(p, 'cfg', 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(p, 'cfg', 'node_modules', 'x', 'token'), 'secret\n');
  mkdirSync(join(p, 'src'));
  writeFileSync(join(p, 'src', 'a.ts'), 'x\n');
  const g = GuardrailsConfig.parse({ version: 1, rules: [], secret_paths: ['cfg/**/token', '**/.env'], examples: { must_block: [], must_ask: [], must_allow: [] } });
  const decide = (tool: string, input: Record<string, unknown>) => evaluate({ tool, input, cwd: p }, g, { ...exampleContext(g, p, true), home: join(p, 'no-home') }).decision;
  assert.equal(decide('Grep', { pattern: 'secret', glob: 'token' }), 'deny', 'from the root');
  assert.equal(decide('Grep', { pattern: 'secret', path: 'cfg' }), 'deny', 'at its start');
  assert.equal(decide('Glob', { pattern: '**/token', path: 'cfg' }), 'deny', 'a Glob at its start');
  assert.equal(decide('Grep', { pattern: 'secret', path: 'cfg/node_modules' }), 'deny', 'below its start');
  assert.equal(decide('Grep', { pattern: 'secret', path: 'src' }), 'none', 'elsewhere');
});
