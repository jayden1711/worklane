import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeArgv, launchClaudeSync, launchGuards, LAUNCH_ENV } from '../src/claude-launch.js';
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
