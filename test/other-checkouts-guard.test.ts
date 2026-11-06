// #939: the tool guard holds a run's relative secret patterns in the repository's other checkouts too (the main one,
// each linked worktree, each directory in a place worktrees are made), a worktree made after the run started among
// them, with each pattern's exceptions relative to that checkout's own root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { runHook } from '../src/hook.js';
import { otherCheckouts } from '../src/guardrails/checkouts.js';
import { WORKTREE_NAME_PREFIX } from '../src/worktrees.js';
import { exampleProject } from './helpers.js';

const AGENT = `${BRAND.envPrefix}_AGENT`;
const STATE = `${BRAND.envPrefix}_STATE_DIR`;

type Answer = { permissionDecision: string; permissionDecisionReason: string } | null;
const answer = (out: { stdout?: string }): Answer => (out.stdout ? (JSON.parse(out.stdout) as { hookSpecificOutput: NonNullable<Answer> }).hookSpecificOutput : null);

/**
 * examples/basic (secret_paths `./.env`, `./.env.*`, `!./.env.example`) with the run in a linked worktree under
 * .claude/worktrees. After the run's start: a linked worktree elsewhere, and a directory in .claude/worktrees git no
 * longer lists. Each checkout holds a `.env.local` and a `.env.example`.
 */
function setup() {
  const { dir, stateDir } = exampleProject();
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  const run = join(dir, '.claude', 'worktrees', 'run');
  mkdirSync(dirname(run), { recursive: true });
  git('worktree', 'add', '-q', '-b', 'run', run, 'HEAD');
  const linked = join(dirname(dir), 'side', 'late');
  git('worktree', 'add', '-q', '-b', 'late', linked, 'HEAD');
  const unlisted = join(dir, '.claude', 'worktrees', 'gone');
  mkdirSync(unlisted, { recursive: true });
  const outside = join(dirname(dir), 'elsewhere');
  mkdirSync(outside, { recursive: true });
  for (const c of [dir, run, linked, unlisted, outside]) {
    writeFileSync(join(c, '.env.local'), 'TOKEN=x\n');
    writeFileSync(join(c, '.env.example'), 'TOKEN=\n');
  }
  const call = async (tool: string, input: Record<string, unknown>) =>
    answer(await runHook('pre-tool-use', { hook_event_name: 'PreToolUse', cwd: run, tool_name: tool, tool_input: input, session_id: 's' }, { ...process.env, CLAUDE_PROJECT_DIR: run, [AGENT]: '1', [STATE]: stateDir }));
  const denied = (a: Answer) => a?.permissionDecision === 'deny' && /secret-path/.test(a.permissionDecisionReason);
  return { dir, run, linked, unlisted, outside, call, denied };
}

test('#939: another checkout\'s .env.local is refused to Read, Bash and Grep, a late worktree\'s and the main one\'s alike', async () => {
  const { dir, linked, unlisted, call, denied } = setup();
  const letThrough: string[] = [];
  for (const c of [dir, linked, unlisted]) {
    const f = join(c, '.env.local');
    for (const [tool, input] of [
      ['Read', { file_path: f }],
      ['Bash', { command: `cat ${f}` }],
      ['Grep', { pattern: 'TOKEN', path: c }],
    ] as const) {
      if (!denied(await call(tool, input))) letThrough.push(`${tool} ${JSON.stringify(input)}`);
    }
  }
  assert.deepEqual(letThrough, []);
});

test('#939: each checkout\'s exception holds in it: .env.example stays readable there and in the run\'s own checkout', async () => {
  const { dir, run, linked, unlisted, call, denied } = setup();
  for (const c of [run, dir, linked, unlisted]) {
    const a = await call('Read', { file_path: join(c, '.env.example') });
    assert.ok(!denied(a), `${c}/.env.example: ${JSON.stringify(a)}`);
  }
  assert.ok(denied(await call('Read', { file_path: join(run, '.env.local') })), 'the run\'s own .env.local is still refused');
});

test('#939: a directory in no checkout of the repository keeps the run\'s patterns relative to its own checkout only', async () => {
  const { outside, call, denied } = setup();
  assert.ok(!denied(await call('Read', { file_path: join(outside, '.env.local') })));
});

test('#939: in a place that holds the main checkout, only the engine\'s own worktrees count as checkouts', () => {
  const { dir } = exampleProject();
  const parent = dirname(dir);
  const engine = join(parent, `${WORKTREE_NAME_PREFIX}task-1`);
  const project = join(parent, 'another-project');
  mkdirSync(engine);
  mkdirSync(project);
  const found = otherCheckouts(dir, '..');
  assert.equal(found.of(join(engine, '.env.local')), engine);
  assert.equal(found.of(join(project, '.env.local')), null);
  const under = found.under(parent);
  assert.ok(Array.isArray(under) && under.includes(engine) && !under.includes(project), JSON.stringify(under));
});
