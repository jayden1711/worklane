// Attack cases for the tool guard's protected-path writes (#972): the guard decides on the file a write really
// reaches, refuses a write when it can't tell which file that is, and an agent never makes a link to harness config.
// Each case runs the guard's own evaluate on a scratch project; nothing a case names is ever written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../../src/brand.js';
import { GuardrailsConfig } from '../../src/config/schema.js';
import { exampleContext } from '../../src/guardrails/check.js';
import { evaluate, type Verdict } from '../../src/guardrails/engine.js';

const cfg = GuardrailsConfig.parse({
  version: 1,
  rules: [{ id: 'migrations', action: 'block', reason: 'migrations are reviewed', applies_to: ['agent', 'interactive'], match: { path: { globs: ['db/migrations/**'] } } }],
  protected_paths: ['vendor/**'],
  examples: { must_block: [], must_ask: [], must_allow: [] },
});

/** A scratch project with harness config, a protected folder of its own, and plain folders; `out` is outside it. */
function project() {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'guard-writes-')));
  const root = join(top, 'proj');
  const out = join(top, 'outside');
  for (const d of ['.claude/sub', `${BRAND.configDir}/roles`, 'vendor', 'db/migrations', 'src', 'docs', '.git/hooks']) mkdirSync(join(root, d), { recursive: true });
  mkdirSync(out);
  writeFileSync(join(root, '.claude/settings.json'), '{}\n');
  writeFileSync(join(root, BRAND.configDir, 'config.yaml'), 'x: 1\n');
  writeFileSync(join(root, 'AGENTS.md'), '# agents\n');
  writeFileSync(join(root, 'src/a.ts'), 'export {};\n');
  writeFileSync(join(out, 'scratch.txt'), 'x\n');
  return { top, root, out };
}

const call = (root: string, tool: string, input: Record<string, unknown>, agent = true, cwd = root): Verdict => evaluate({ tool, input, cwd }, cfg, exampleContext(cfg, root, agent));
const write = (root: string, path: string, tool = 'Write', agent = true) => call(root, tool, tool === 'NotebookEdit' ? { notebook_path: path, new_source: 'x' } : { file_path: path, content: 'x' }, agent);
const bash = (root: string, command: string, agent = true, cwd = root) => call(root, 'Bash', { command }, agent, cwd);

test('tool guard writes: every write tool and parsed shell write is judged by the file it reaches, for every protected path', () => {
  const { root, top } = project();
  symlinkSync('.claude', join(root, 'l1'));
  symlinkSync(BRAND.configDir, join(root, 'l2'));
  symlinkSync('vendor', join(root, 'l3'));
  symlinkSync('.claude/settings.json', join(root, 'l4'));
  symlinkSync('.claude/new.json', join(root, 'l5'));
  symlinkSync('.claude/sub', join(root, 'l6'));
  symlinkSync(root, join(top, 'l7'));
  symlinkSync(join(root, 'docs'), join(root, 'l8'));
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    for (const p of ['l1/settings.json', join(root, 'l1/settings.json'), 'l2/config.yaml', 'l3/x.js', 'l4', 'l5', 'l6/../x.json', join(top, 'l7/.claude/settings.json'), 'l8/../.claude/x.json']) {
      const v = write(root, p, tool);
      assert.equal(v.decision, 'deny', `${tool} ${p}`);
      assert.equal(v.rule, 'protected-path', `${tool} ${p}`);
    }
  }
  for (const command of ['echo {} > l1/settings.json', 'cp /dev/null l1/', 'printf x | tee l2/config.yaml', 'touch l4', 'mv src/a.ts l6/../b.json', "sed -i 's/a/b/' l5", `mkdir -p l1/${'d/'.repeat(2500)}x`]) {
    assert.equal(bash(root, command).decision, 'deny', command);
  }
  // The agents' own instructions under the config folder stay theirs, whatever name reaches them.
  assert.equal(write(root, 'l2/roles/builder.md').decision, 'none');
});

test('tool guard writes: AGENTS.md and a project path rule are judged by the file reached too', () => {
  const { root } = project();
  symlinkSync('AGENTS.md', join(root, 'notes.md'));
  symlinkSync('db/migrations', join(root, 'm'));
  const v = write(root, 'notes.md');
  assert.equal(v.decision, 'deny');
  assert.equal(v.rule, 'agents-md');
  // A path rule applies to people's sessions too.
  for (const agent of [true, false]) assert.equal(write(root, 'm/001.sql', 'Write', agent).decision, 'deny', `agent: ${agent}`);
});

test('tool guard writes: git hooks are judged by the file reached', () => {
  const { root } = project();
  symlinkSync('.git/hooks', join(root, 'h'));
  const v = write(root, 'h/pre-push');
  assert.equal(v.decision, 'deny');
  assert.equal(v.rule, 'push-hook-bypass');
  assert.equal(bash(root, 'cp /dev/null h/pre-push').rule, 'push-hook-bypass');
});

test('tool guard writes: a write whose file the guard cannot tell is refused', () => {
  const { root } = project();
  symlinkSync('loop', join(root, 'loop'));
  for (let i = 0; i < 45; i++) symlinkSync(i === 44 ? 'src' : `c${i + 1}`, join(root, `c${i}`));
  for (const p of ['loop/x.ts', 'c0/a.ts']) {
    const v = write(root, p);
    assert.equal(v.decision, 'deny', p);
    assert.equal(v.rule, 'protected-path');
  }
  assert.equal(bash(root, 'echo x > loop/y').decision, 'deny');
  // A name whose meaning depends on the process reading it: the guard would read its own, not the tool's.
  if (process.platform === 'linux') assert.equal(write(root, '/proc/self/cwd/src/a.ts').decision, 'deny');
  // A process's standard streams stay writable.
  assert.equal(bash(root, 'echo x | tee /dev/stderr').decision, 'none');
});

test('tool guard writes: a file with more than one hard link is refused', () => {
  const { root } = project();
  linkSync(join(root, '.claude/settings.json'), join(root, 'docs/settings.json'));
  linkSync(join(root, 'src/a.ts'), join(root, 'src/b.ts'));
  for (const p of ['docs/settings.json', 'src/a.ts', 'src/b.ts']) assert.equal(write(root, p).decision, 'deny', p);
  assert.equal(bash(root, 'echo x >> docs/settings.json').decision, 'deny');
});

test('tool guard writes: an agent never makes a link to harness config', () => {
  const { root } = project();
  for (const command of [
    'ln -s .claude lk',
    `ln -s ${BRAND.configDir}/config.yaml lk`,
    'ln -s ../.claude src/lk',
    'ln -sf .claude/settings.json',
    'ln .claude/settings.json lk',
    'link .claude/settings.json lk',
    'cp -s .claude/settings.json lk',
    'cp -al .claude bk',
    'cp --link .claude/settings.json lk',
    'rsync -a --link-dest=../.claude src/ bk/',
    'ln -s vendor lk',
  ]) assert.equal(bash(root, command).decision, 'deny', command);
  assert.equal(bash(root, 'ln -s ../.claude lk', true, join(root, 'src')).decision, 'deny');
});

test('tool guard writes: a link-making command is read however its options are spelled, and one the guard cannot read is refused', () => {
  const { root } = project();
  for (const command of [
    'cp --sym .claude lk',
    'cp --symbolic .claude/settings.json lk',
    'cp --li .claude/settings.json lk',
    'cp -R --sym .claude bk',
    'cp --sym .claude lk && echo x > lk/settings.json',
    'ln -s --target=src ../.claude',
    'ln -s --t=src ../.claude',
    'ln -s --target src ../.claude',
    'ln -st src ../.claude',
    'rsync -a --link-d=../.claude src/ bk/',
    'cp --no-such-option src/a.ts docs/',
    'ln --s src/a.ts b.ts',
  ]) assert.equal(bash(root, command).decision, 'deny', command);
  for (const command of ['cp --recursive --preserve=mode src docs/', 'cp --verb src/a.ts docs/', 'ln --symbolic src/a.ts b.ts', 'cp -- -x y', 'rsync -a --links src/ bk/']) {
    assert.equal(bash(root, command).decision, 'none', command);
  }
});

test('tool guard writes: a link-making command is judged in every order it may read its words, and where its links are made', () => {
  const { root } = project();
  for (const command of [
    'POSIXLY_CORRECT=1 ln -s x -t ../.claude lk0',
    'POSIXLY_CORRECT=1 ln -s x --suffix ../.claude lk0',
    'env POSIXLY_CORRECT=1 ln -s x -t ../.claude lk0 && echo x > lk0/.claude/settings.json',
    'export POSIXLY_CORRECT=1; ln -s x -t ../.claude lk0',
    'POSIXLY_CORRECT=1 cp -s src/a.ts -t .claude/settings.json lk0',
    `POSIXLY_CORRECT=1 cp -s ${root}/src/a.ts -t ${root}/.claude/settings.json ${root}/lk0 && echo x > ${root}/lk0/settings.json`,
    'cp -s src/a.ts --target-directory=.claude',
    `ln -s src/a.ts --target-directory=${BRAND.configDir}`,
  ]) assert.equal(bash(root, command).decision, 'deny', command);
  for (const command of ['ln -s src/a.ts b.ts', 'ln -s ../src/a.ts docs/', 'cp -s src/a.ts docs/', `ln -s ../../src/a.ts ${BRAND.configDir}/roles/`]) {
    assert.equal(bash(root, command).decision, 'none', command);
  }
});

test('tool guard writes: a link made inside harness config is refused even when its text leads out of the destination', () => {
  const { root } = project();
  // Each source's text, read from the destination folder, names a plain file (or nothing), so only the check on
  // where the link is made refuses these.
  for (const command of [
    'ln -s -t .claude ../src/a.ts',
    'ln -st .claude ../evil/settings.json',
    `ln -s -t ${BRAND.configDir} ../evil/config.yaml`,
    'ln -s --target-directory=.claude ../evil/settings.json',
    'cp -s -t .claude ../evil/settings.json',
  ]) {
    const v = bash(root, command);
    assert.equal(v.decision, 'deny', command);
    assert.match(v.reason ?? '', /agents never make a link in it/, command);
  }
  for (const command of ['ln -s -t docs ../src/a.ts', 'ln -st docs ../evil/settings.json', `ln -s -t ${BRAND.configDir}/roles ../../src/a.ts`]) {
    assert.equal(bash(root, command).decision, 'none', command);
  }
});

test('tool guard writes: plain writes, links to plain files, reads and people sessions are unchanged', () => {
  const { root, out } = project();
  symlinkSync('src', join(root, 'code'));
  symlinkSync('.claude', join(root, 'l1'));
  symlinkSync(out, join(root, 'ext'));
  for (const p of ['src/a.ts', 'src/new/b.ts', 'code/a.ts', 'code/../docs/x.md', join(out, 'scratch.txt'), 'ext/y.txt', 'ext/../docs/y.md']) assert.equal(write(root, p).decision, 'none', p);
  for (const command of ['ln -s src/a.ts b.ts', `ln -s ${BRAND.configDir}/roles r`, 'cp .claude/settings.json /dev/null', 'cp -r src docs/', 'echo x > src/c.ts', 'cat l1/settings.json', 'mkdir -p src/d/e']) {
    assert.equal(bash(root, command).decision, 'none', command);
  }
  // A person's own session: the harness-file block is agents' only.
  assert.equal(write(root, 'l1/settings.json', 'Write', false).decision, 'none');
  assert.equal(bash(root, 'ln -s .claude lk', false).decision, 'none');
});
