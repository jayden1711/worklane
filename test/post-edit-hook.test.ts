import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { runHook } from '../src/hook.js';
import { HOOK_MARKER, install } from '../src/install.js';
import { shellCommand } from '../src/os/index.js';
import { exampleProject } from './helpers.js';

type Hooks = { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };

const AGENT = { [`${BRAND.envPrefix}_AGENT`]: '1' };

/** The example project with tests.yaml `post_edit` set (or left out when null). */
function project(postEdit: string | null) {
  const { dir, stateDir } = exampleProject();
  const tests = join(dir, BRAND.configDir, 'tests.yaml');
  if (postEdit !== null) writeFileSync(tests, `${readFileSync(tests, 'utf8')}\npost_edit: ${JSON.stringify(postEdit)}\n`);
  return { dir, stateDir };
}

const edit = (dir: string, file: string, tool = 'Edit') => ({ hook_event_name: 'PostToolUse', cwd: dir, tool_name: tool, tool_input: { file_path: join(dir, file) } });
const context = (out: { stdout?: string }) => (out.stdout ? (JSON.parse(out.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }).hookSpecificOutput : null);

test('a seeded syntax error: the post-edit check\'s findings go back to the agent, and the edit is not blocked', async () => {
  const { dir } = project('node --check {file}');
  writeFileSync(join(dir, 'src', 'broken.js'), 'export function total( {\n  return 1;\n}\n');
  const out = await runHook('post-tool-use', edit(dir, 'src/broken.js'), { ...process.env, ...AGENT });
  assert.equal(out.exitCode, 0, 'never blocks');
  const ctx = context(out);
  assert.equal(ctx?.hookEventName, 'PostToolUse');
  assert.match(ctx!.additionalContext, /post-edit check found problems in src\/broken\.js/);
  assert.match(ctx!.additionalContext, /SyntaxError/);
});

test('a passing check, a non-edit tool or a file outside the project says nothing', async () => {
  const { dir } = project('node --check {file}');
  writeFileSync(join(dir, 'src', 'fine.js'), 'export const one = 1;\n');
  for (const input of [edit(dir, 'src/fine.js'), edit(dir, 'src/fine.js', 'Read'), { ...edit(dir, 'x'), tool_input: { file_path: join(tmpdir(), 'elsewhere.js') } }]) {
    const out = await runHook('post-tool-use', input, { ...process.env, ...AGENT });
    assert.deepEqual(out, { exitCode: 0 });
  }
});

test('no post_edit in tests.yaml: a silent no-op', async () => {
  const { dir } = project(null);
  writeFileSync(join(dir, 'src', 'broken.js'), 'export function total( {\n');
  assert.deepEqual(await runHook('post-tool-use', edit(dir, 'src/broken.js'), { ...process.env, ...AGENT }), { exitCode: 0 });
});

test('a check that runs past its time is ignored: a silent no-op, not a wait', async () => {
  const { dir } = project('sleep 5; node --check {file}');
  writeFileSync(join(dir, 'src', 'broken.js'), 'export function total( {\n');
  const started = Date.now();
  const out = await runHook('post-tool-use', edit(dir, 'src/broken.js'), { ...process.env, ...AGENT }, { postEditTimeoutMs: 300 });
  assert.deepEqual(out, { exitCode: 0 });
  assert.ok(Date.now() - started < 4000, 'did not wait for the check');
});

test('a broken config or a crashing check is a no-op too, and the file name is one shell word', async () => {
  const { dir } = project('node --check {file}');
  writeFileSync(join(dir, 'src', "it's here; touch pwned.js"), 'export const x = 1;\n');
  assert.deepEqual(await runHook('post-tool-use', edit(dir, "src/it's here; touch pwned.js"), { ...process.env, ...AGENT }), { exitCode: 0 });
  assert.equal(spawnSync('git', ['ls-files', '--others', 'pwned.js'], { cwd: dir, encoding: 'utf8' }).stdout.trim(), '', 'the name was not run as a command');
  writeFileSync(join(dir, BRAND.configDir, 'tests.yaml'), 'version: 1\nnot: [valid\n');
  assert.deepEqual(await runHook('post-tool-use', edit(dir, 'src/fine.js'), { ...process.env, ...AGENT }), { exitCode: 0 });
});

test('installed: the post-edit hook never exits 2, even with the engine missing; the PreToolUse guard still fails closed', () => {
  const { dir, stateDir } = exampleProject();
  install({ root: dir, engineCli: join(dir, 'node_modules', 'gone', 'cli.js') });
  const s = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')) as Hooks;
  const ours = (event: string) => s.hooks[event]!.find((e) => e.hooks.some((h) => h.command.includes(HOOK_MARKER)))!;
  const post = ours('PostToolUse');
  assert.equal(post.matcher, 'Edit|Write|MultiEdit');
  assert.doesNotMatch(post.hooks[0]!.command, /exit 2/);
  const run = (cmd: string) => {
    const [bin, args] = shellCommand(cmd);
    return spawnSync(bin, args, { cwd: dir, input: JSON.stringify(edit(dir, 'src/x.js')), encoding: 'utf8', env: { ...process.env, ...AGENT, CLAUDE_PROJECT_DIR: dir, [`${BRAND.envPrefix}_STATE_DIR`]: stateDir } });
  };
  assert.equal(run(post.hooks[0]!.command).status, 0, 'feedback only: a missing engine stays silent');
  assert.equal(run(ours('PreToolUse').hooks[0]!.command).status, 2, 'the guard still blocks agents without an engine');
});
