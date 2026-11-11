import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeArgv, launchClaudeSync, launchEnv, launchGuards, LAUNCH_ENV } from '../src/claude-launch.js';
import { PermissionRule } from '../src/config/permission-rule.js';
import { claudeProbeRun, LOGIN_PROOF, proveClaudeLogin } from '../src/setup-steps.js';

const posix = process.platform !== 'win32';
const base = { settings: { hooks: {} }, mode: 'stream' as const, model: 'm', maxTurns: 1, maxBudgetUsd: 1, allowedTools: ['Read'] };

test('R1185aa D1: no value a launch is given can be read as a flag; the guards end the argv', () => {
  // Each list field: an element starting with `-` (or not text) is refused, before anything starts.
  for (const k of ['allowedTools', 'disallowedTools', 'pluginDirs'] as const) {
    for (const bad of ['--setting-sources=user,project,local', '--settings={}', '-x', 3 as unknown as string]) assert.throws(() => claudeArgv({ ...base, [k]: ['Read', bad] }), /would be read as a flag \(or isn't text\): refused/, `${k}: ${String(bad)}`);
  }
  // Each value given as an argument of its own.
  for (const k of ['model', 'effort', 'resume', 'mcpConfigFile', 'appendSystemPromptFile'] as const) assert.throws(() => claudeArgv({ ...base, [k]: '--setting-sources=project' }), new RegExp(`${k} .* would be read as a flag`), k);
  // Free text: one argument, never a flag of its own, whatever it starts with (a skill's `---` frontmatter).
  const sys = claudeArgv({ ...base, mode: 'json', appendSystemPrompt: '---\nname: s\n---\n--setting-sources=user' });
  assert.ok(sys.includes('--append-system-prompt=---\nname: s\n---\n--setting-sources=user'));
  assert.ok(!sys.includes('--append-system-prompt'), 'never as a flag and a separate value');
  // The guards are the last five arguments, each once, in both modes.
  for (const mode of ['stream', 'json'] as const) {
    const a = claudeArgv({ ...base, mode, disallowedTools: ['Bash'], resume: '0b1e3f4a-1111-4222-8333-444455556666' });
    assert.deepEqual(a.slice(-5), launchGuards(base.settings), mode);
    assert.deepEqual(a.slice(-5), ['--settings', '{"hooks":{}}', '--setting-sources', '', '--strict-mcp-config']);
    for (const f of ['--settings', '--setting-sources', '--strict-mcp-config']) assert.equal(a.filter((x) => x === f).length, 1, `${mode}: ${f} once`);
    assert.equal(a[0], '-p', `${mode}: the prompt mode first`);
  }
});

test("R1185aa D1: pre_approved takes only a permission rule (a repo's guardrails.yaml, an instance's policy)", () => {
  for (const ok of ['Read', 'Bash(npm test:*)', 'Bash(git diff:*)', 'mcp__srv-1__tool_2', 'WebFetch(domain:docs.example.com)']) assert.ok(PermissionRule.safeParse(ok).success, ok);
  for (const bad of ['--setting-sources=user,project,local', '-x', '', ' Read', 'Bash(x)\n--settings={}', '(Read)']) assert.ok(!PermissionRule.safeParse(bad).success, JSON.stringify(bad));
});

test('R1185z D1: the login proof goes through the launch, in an empty folder of its own, with the prompt on stdin', { skip: !posix && 'a POSIX stand-in claude' }, () => {
  // The proof's spec: empty settings, no tools, every tool disallowed, one turn.
  assert.deepEqual([LOGIN_PROOF.settings, LOGIN_PROOF.mode, LOGIN_PROOF.allowedTools, LOGIN_PROOF.maxTurns], [{}, 'json', [], 1]);
  assert.ok(LOGIN_PROOF.disallowedTools!.includes('Bash') && LOGIN_PROOF.disallowedTools!.includes('Read'));
  const dir = mkdtempSync(join(tmpdir(), 'login-proof-test-'));
  const log = join(dir, 'seen.json');
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst input = fs.readFileSync(0, 'utf8');\nfs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), entries: fs.readdirSync(process.cwd()), input, mem: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY }));\nconsole.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }));\n`);
  chmodSync(bin, 0o755);
  const env = { PATH: process.env.PATH ?? '', HOME: dir };
  const r = claudeProbeRun(LOGIN_PROOF, env, 30_000, bin);
  assert.equal(r.status, 0, r.stderr);
  const seen = JSON.parse(readFileSync(log, 'utf8')) as { args: string[]; cwd: string; entries: string[]; input: string; mem: string };
  assert.deepEqual(seen.args.slice(-5), launchGuards({}), "the launch's guards, last");
  assert.equal(seen.input, LOGIN_PROOF.prompt, 'the prompt on stdin, never on the command line');
  assert.ok(!seen.args.includes(LOGIN_PROOF.prompt));
  assert.notEqual(seen.cwd, process.cwd(), "not the caller's folder");
  assert.deepEqual(seen.entries, [], 'an empty folder of its own: no checkout around it');
  assert.equal(seen.mem, LAUNCH_ENV.CLAUDE_CODE_DISABLE_AUTO_MEMORY);
  // And proveClaudeLogin reads that answer.
  assert.equal(proveClaudeLogin({ claude: (spec) => claudeProbeRun(spec, env, 30_000, bin) }).done, true);
  // launchClaudeSync itself: the same argv and environment as launchClaude.
  const s = launchClaudeSync({ ...LOGIN_PROOF, bin, cwd: dir, env: { PATH: process.env.PATH ?? '' } }, { timeoutMs: 30_000, input: 'x' });
  assert.equal(s.status, 0, s.stderr);
});

test('R1185ac D1/D3: the launch owns its environment: no CLAUDE_*/ANTHROPIC_* it doesn\'t name, and PATH only absolute', { skip: !posix && 'a POSIX stand-in claude' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'launch-env-'));
  const bins = join(dir, 'bin');
  const checkout = join(dir, 'checkout');
  mkdirSync(bins);
  mkdirSync(checkout);
  const log = join(dir, 'seen.json');
  const standIn = (file: string, who: string) => {
    writeFileSync(file, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify({ who: ${JSON.stringify(who)}, env: process.env }));\nconsole.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }));\n`);
    chmodSync(file, 0o755);
  };
  standIn(join(bins, 'claude'), 'the claude on PATH');
  // The checkout's own `claude`, which an empty PATH entry (the working directory) would run (D3).
  standIn(join(checkout, 'claude'), "the checkout's claude");
  const env = {
    PATH: `:${bins}:.:relative/bin:${process.env.PATH ?? ''}`,
    HOME: dir,
    CLAUDE_CONFIG_DIR: join(dir, 'login'),
    ANTHROPIC_BASE_URL: 'https://models.example.test',
    CLAUDE_CODE_PLUGIN_DIRS: join(dir, 'planted-plugin'),
    CLAUDE_CODE_PLUGIN_SEED_DIR: join(dir, 'seed'),
    CLAUDE_CODE_MANAGED_SETTINGS_PATH: join(dir, 'managed.json'),
    claude_code_plugin_dirs: join(dir, 'lower'),
    ANTHROPIC_CUSTOM_HEADERS: 'x: y',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    KEEP_ME: 'yes',
  };
  const seen = () => JSON.parse(readFileSync(log, 'utf8')) as { who: string; env: Record<string, string> };
  // P1: a launch given the variables.
  assert.equal(launchClaudeSync({ ...LOGIN_PROOF, bin: 'claude', cwd: checkout, env }, { timeoutMs: 30_000 }).status, 0);
  const s = seen();
  assert.equal(s.who, 'the claude on PATH', "an empty or relative PATH entry never runs the checkout's own claude");
  assert.deepEqual(Object.keys(s.env).filter((k) => /^(?:claude|anthropic)_/i.test(k)).sort(), ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CONFIG_DIR']);
  assert.equal(s.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1', "the launch's own, over the caller's");
  assert.equal(s.env.KEEP_ME, 'yes', 'anything else passes');
  assert.ok(s.env.PATH!.split(':').every((d) => d.startsWith('/')), `PATH holds absolute entries only: ${s.env.PATH}`);
  assert.deepEqual(launchEnv(env).CLAUDE_CODE_PLUGIN_DIRS, undefined);
  // The launch's own variables keep the caller's place (a sudo `env -i` list keeps its order: runner-golden).
  assert.deepEqual(Object.keys(launchEnv({ A: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0', B: '2' })), ['A', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'B']);
  // P1b: the login proof, with the variable in the environment the probe hands it (probeEnv: the process's own).
  assert.equal(claudeProbeRun(LOGIN_PROOF, env, 30_000, join(bins, 'claude')).status, 0);
  assert.equal(seen().env.CLAUDE_CODE_PLUGIN_DIRS, undefined, 'the login proof drops it too');
  // A relative binary path is refused.
  assert.throws(() => launchClaudeSync({ ...LOGIN_PROOF, bin: './claude', cwd: checkout, env }, { timeoutMs: 30_000 }), /relative path/);
});

test('R1185ac (the organizer, 2026-11-11): the plugin cache folder is the launch\'s own field; a caller\'s environment never names it', { skip: !posix && 'a POSIX stand-in claude' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'launch-cache-'));
  const log = join(dir, 'seen.json');
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.env));\nconsole.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }));\n`);
  chmodSync(bin, 0o755);
  const env = { PATH: process.env.PATH ?? '', HOME: dir, CLAUDE_CODE_PLUGIN_CACHE_DIR: join(dir, 'planted-cache') };
  const seen = () => JSON.parse(readFileSync(log, 'utf8')) as Record<string, string>;
  // A caller's value (the login proof's process environment, a planted one) never reaches the child.
  assert.equal(launchClaudeSync({ ...LOGIN_PROOF, bin, cwd: dir, env }, { timeoutMs: 30_000 }).status, 0);
  assert.equal(seen().CLAUDE_CODE_PLUGIN_CACHE_DIR, undefined, "a caller's CLAUDE_CODE_PLUGIN_CACHE_DIR is dropped");
  assert.equal(claudeProbeRun(LOGIN_PROOF, env, 30_000, bin).status, 0);
  assert.equal(seen().CLAUDE_CODE_PLUGIN_CACHE_DIR, undefined, 'the login proof passes none');
  // The field sets it, over a caller's.
  const root = join(dir, 'plugins-root');
  assert.equal(launchClaudeSync({ ...LOGIN_PROOF, bin, cwd: dir, env, pluginCacheDir: root }, { timeoutMs: 30_000 }).status, 0);
  assert.equal(seen().CLAUDE_CODE_PLUGIN_CACHE_DIR, root, "the launch's own field");
  assert.throws(() => launchEnv(env, 'relative/root'), /isn't an absolute path/);
});
