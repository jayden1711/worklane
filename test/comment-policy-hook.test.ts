import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from '../src/brand.js';
import { checkRange, checkWorkingFile, formatFindings, WORKING_CHECK_BUDGET_MS } from '../src/comment-policy.js';
import { loadConfig } from '../src/config/load.js';
import { POST_EDIT_TIMEOUT_MS, runHook } from '../src/hook.js';
import { install } from '../src/install.js';
import { exampleProject } from './helpers.js';

const script = fileURLToPath(new URL('../../scripts/check-comments.mjs', import.meta.url));
const AGENT = { [`${BRAND.envPrefix}_AGENT`]: '1' };
const hook = (dir: string, file: string, tool = 'Write') => runHook('post-tool-use', { hook_event_name: 'PostToolUse', cwd: dir, tool_name: tool, tool_input: { file_path: join(dir, file) } }, { ...process.env, ...AGENT });
const ctx = (out: { stdout?: string }) => (out.stdout ? (JSON.parse(out.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext : '');
/** WHY: hook and CI word their headers differently; the `file:line: reasons` lines are what must match (#330). */
const findingLines = (text: string) => text.split('\n').filter((l) => /^\S+:\d+: /.test(l)).sort();

/** WHY: committed with the policy on because CI reads the base's config (#330); post_edit too when given. */
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

test('with post_edit too: both findings go back together; a Read or a file outside the project says nothing', async () => {
  const { dir } = project('node --check {file}');
  writeFileSync(join(dir, 'src', 'broken.js'), '// untagged\nexport function total( {\n');
  const text = ctx(await hook(dir, 'src/broken.js', 'Edit'));
  assert.match(text, /comment policy refuses a new comment in src\/broken\.js/);
  assert.match(text, /post-edit check found problems in src\/broken\.js/);
  assert.match(text, /the same rule the PR check uses/);
  assert.deepEqual(await hook(dir, 'src/broken.js', 'Read'), { exitCode: 0 });
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  writeFileSync(join(outside, 'x.ts'), '// untagged\n');
  assert.deepEqual(await runHook('post-tool-use', { hook_event_name: 'PostToolUse', cwd: dir, tool_name: 'Write', tool_input: { file_path: join(outside, 'x.ts') } }, { ...process.env, ...AGENT }), { exitCode: 0 });
});

test('a comment check that cannot run fails open: the edit stands and the agent is told it was not judged', async () => {
  const { dir } = project();
  mkdirSync(join(dir, 'src', 'odd.ts'));
  const out = await hook(dir, 'src/odd.ts');
  assert.equal(out.exitCode, 0);
  assert.match(ctx(out), /the comment policy could not check src\/odd\.ts \(.+\); its comments were not judged/);
  assert.equal(readFileSync(join(dir, 'src', 'old.ts'), 'utf8'), '// an old untagged comment\nexport const a = 1;\n', 'nothing was touched');
});

test('a git that cannot answer (gone, .git moved, GIT_DIR wrong) is "could not check", never old comments reported as new', async () => {
  const { dir } = project();
  writeFileSync(join(dir, 'src', 'old.ts'), '// an old untagged comment\nexport const a = 1;\n// WHY: b is the API name (#4)\nexport const b = 2;\n');
  assert.deepEqual(await hook(dir, 'src/old.ts'), { exitCode: 0 }, 'a working git: the new line passes, the old one is not judged');
  const broken: [string, () => () => void][] = [
    ['git not on PATH', () => withEnv('PATH', mkdtempSync(join(tmpdir(), 'nogit-')))],
    ['GIT_DIR wrong', () => withEnv('GIT_DIR', join(dir, 'nowhere'))],
    [
      '.git moved',
      () => {
        renameSync(join(dir, '.git'), join(dir, '.git-away'));
        return () => renameSync(join(dir, '.git-away'), join(dir, '.git'));
      },
    ],
  ];
  for (const [name, breakIt] of broken) {
    const restore = breakIt();
    let text: string;
    try {
      text = ctx(await hook(dir, 'src/old.ts'));
    } finally {
      restore();
    }
    assert.match(text, /the comment policy could not check src\/old\.ts \(.+\); its comments were not judged/, name);
    assert.doesNotMatch(text, /src\/old\.ts:1:/, `${name}: the old comment is not reported`);
  }
});

test('commands from the checkout\'s git config (core.fsmonitor, a textconv driver) never run, and cannot shift the lines', async () => {
  const { dir, git } = project();
  const marker = join(dir, '..', 'probe-ran');
  const probe = join(dir, '..', 'probe.sh');
  writeFileSync(probe, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\necho '// injected'\n[ -f "$1" ] && cat "$1"\nexit 0\n`);
  chmodSync(probe, 0o755);
  git('config', 'core.fsmonitor', probe);
  git('config', 'diff.probe.textconv', probe);
  writeFileSync(join(dir, '.gitattributes'), '*.ts diff=probe\n');
  writeFileSync(join(dir, 'src', 'old.ts'), '// an old untagged comment\nexport const a = 1;\n// untagged new\n');
  const text = ctx(await hook(dir, 'src/old.ts'));
  assert.deepEqual(findingLines(text), ['src/old.ts:3: no WHY:, INVARIANT: or issue/decision id']);
  assert.equal(existsSync(marker), false, 'the configured command did not run');
});

test('#628: a clean filter on the file is "could not check", never lines from the filtered text', async () => {
  const { dir, git } = project();
  git('config', 'filter.pre.clean', "printf 'one\\ntwo\\n'; cat");
  git('config', 'filter.pre.smudge', 'cat');
  writeFileSync(join(dir, '.gitattributes'), '*.ts filter=pre\n');
  writeFileSync(join(dir, 'src', 'old.ts'), '// an old untagged comment\nexport const a = 1;\n// untagged new\n');
  const text = ctx(await hook(dir, 'src/old.ts'));
  assert.match(text, /the comment policy could not check src\/old\.ts \(git filter "pre" rewrites src\/old\.ts.*\); its comments were not judged/);
  assert.doesNotMatch(text, /src\/old\.ts:1:/);
});

test('#628: one deadline for all the hook\'s git calls, and it fits the hook\'s timeout beside post_edit', () => {
  const { dir } = project();
  writeFileSync(join(dir, 'src', 'old.ts'), '// an old untagged comment\nexport const a = 1;\n// untagged new\n');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const slow = mkdtempSync(join(tmpdir(), 'slowgit-'));
  writeFileSync(join(slow, 'git'), `#!/bin/sh\nsleep 0.4\nexec ${JSON.stringify(realGit)} "$@"\n`);
  chmodSync(join(slow, 'git'), 0o755);
  const restore = withEnv('PATH', `${slow}${delimiter}${process.env.PATH ?? ''}`);
  const started = performance.now();
  try {
    assert.throws(() => checkWorkingFile(dir, 'src/old.ts', { ...loadConfig(dir).project.comment_policy }, 1000), /longer than 1000 ms|stopped|ETIMEDOUT/);
  } finally {
    restore();
  }
  assert.ok(performance.now() - started < 1900, 'gave up at the deadline, not after every call');
  install({ root: dir, engineCli: join(dir, 'node_modules', 'gone', 'cli.js') });
  const s = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')) as { hooks: { PostToolUse: { hooks: { timeout: number }[] }[] } };
  const hookTimeoutMs = Math.min(...s.hooks.PostToolUse.flatMap((e) => e.hooks.map((h) => h.timeout))) * 1000;
  assert.ok(WORKING_CHECK_BUDGET_MS + POST_EDIT_TIMEOUT_MS < hookTimeoutMs, `${WORKING_CHECK_BUDGET_MS} + ${POST_EDIT_TIMEOUT_MS} < ${hookTimeoutMs}`);
});

function withEnv(key: string, value: string): () => void {
  const was = process.env[key];
  process.env[key] = value;
  return () => {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  };
}
