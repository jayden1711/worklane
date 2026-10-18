import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from '../src/brand.js';
import { checkRange, formatFindings } from '../src/comment-policy.js';
import { loadConfig } from '../src/config/load.js';
import { runHook } from '../src/hook.js';
import { exampleProject } from './helpers.js';

const script = fileURLToPath(new URL('../../scripts/check-comments.mjs', import.meta.url));
const AGENT = { [`${BRAND.envPrefix}_AGENT`]: '1' };
const hook = (dir: string, file: string, tool = 'Write') => runHook('post-tool-use', { hook_event_name: 'PostToolUse', cwd: dir, tool_name: tool, tool_input: { file_path: join(dir, file) } }, { ...process.env, ...AGENT });
const ctx = (out: { stdout?: string }) => (out.stdout ? (JSON.parse(out.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext : '');
/** The `file:line: reasons` lines of a report, whoever printed it. */
const findingLines = (text: string) => text.split('\n').filter((l) => /^\S+:\d+: /.test(l)).sort();

/** The example project with the policy on (and post_edit, when given), committed: CI reads the base's config. */
function project(postEdit?: string) {
  const { dir } = exampleProject();
  appendFileSync(join(dir, BRAND.configDir, 'config.yaml'), 'comment_policy: { enabled: true }\n');
  if (postEdit) appendFileSync(join(dir, BRAND.configDir, 'tests.yaml'), `post_edit: ${JSON.stringify(postEdit)}\n`);
  writeFileSync(join(dir, 'src', 'old.ts'), '// an old untagged comment\nexport const a = 1;\n');
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  git('add', '-A');
  git('commit', '-q', '-m', 'policy on');
  return { dir, git, base: git('rev-parse', 'HEAD') };
}

test('the post-edit hook and the CI check give the same verdict on the same change', async () => {
  const { dir, git, base } = project();
  const files: Record<string, string> = {
    'src/old.ts': '// an old untagged comment\nexport const a = 1;\n// WHY: added the b export\nexport const b = 2;\n',
    'scripts/go.sh': '# INVARIANT: runs from the repo root\nx=1 # set x\n',
    'src/long.ts': `// WHY: one\n${'// more\n'.repeat(5)}export const l = 1;\n`,
    'src/fine.ts': '// WHY: the API counts from 1 (#4)\nexport const c = 1;\n',
  };
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  const fromHook: string[] = [];
  for (const [file, text] of Object.entries(files)) {
    writeFileSync(join(dir, file), text);
    const out = await hook(dir, file);
    assert.equal(out.exitCode, 0, 'never blocks');
    fromHook.push(ctx(out));
  }
  assert.equal(fromHook[3], '', 'a passing file: the hook says nothing');
  assert.match(fromHook[0]!, /the comment policy refuses a new comment in src\/old\.ts/);
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
  const ci = spawnSync('node', [script, '--base', base, '--head', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  assert.equal(ci.status, 1, ci.stderr);
  assert.deepEqual(findingLines(fromHook.join('\n')), findingLines(ci.stderr));
  assert.deepEqual(findingLines(ci.stderr), ['scripts/go.sh:2: no WHY:, INVARIANT: or issue/decision id', 'src/long.ts:1: 6 lines (at most 4)', 'src/old.ts:3: narration ("added")']);
  for (const f of checkRange(dir, base, 'HEAD', loadConfig(dir).project.comment_policy)) assert.ok(fromHook.join('\n').includes(formatFindings([f])), `the hook reports ${f.file}:${f.line} word for word`);
});

test('off (the default): the hook says nothing about comments', async () => {
  const { dir } = exampleProject();
  assert.equal(loadConfig(dir).project.comment_policy.enabled, false);
  writeFileSync(join(dir, 'src', 'x.ts'), '// untagged, added now\nexport const x = 1;\n');
  assert.deepEqual(await hook(dir, 'src/x.ts'), { exitCode: 0 });
});

test('with post_edit too: both findings go back together; Read and files outside the project stay silent', async () => {
  const { dir } = project('node --check {file}');
  writeFileSync(join(dir, 'src', 'broken.js'), '// untagged\nexport function total( {\n');
  const text = ctx(await hook(dir, 'src/broken.js', 'Edit'));
  assert.match(text, /comment policy refuses a new comment in src\/broken\.js/);
  assert.match(text, /post-edit check found problems in src\/broken\.js/);
  assert.deepEqual(await hook(dir, 'src/broken.js', 'Read'), { exitCode: 0 });
});

test('a comment check that cannot run fails open: the edit stands and the agent is told CI will check', async () => {
  const { dir } = project();
  mkdirSync(join(dir, 'src', 'odd.ts'));
  const out = await hook(dir, 'src/odd.ts');
  assert.equal(out.exitCode, 0);
  assert.match(ctx(out), /the comment policy could not check src\/odd\.ts \(.+\); CI checks the PR/);
  assert.equal(readFileSync(join(dir, 'src', 'old.ts'), 'utf8'), '// an old untagged comment\nexport const a = 1;\n', 'nothing was touched');
});
