// An instance's agents billed to an API key: the key file reaches claude only through apiKeyHelper, for runs as
// the agent user, never through an environment; spend caps are on the command line as before; doctor checks it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectConfig } from '../src/config/schema.js';
import { apiKeyCheck } from '../src/doctor.js';
import { fileAccess } from '../src/os/index.js';
import { apiKeyHelperCommand, CliRunner, type RunRequest } from '../src/runner.js';
import { instanceEnv, instanceRuntime } from '../src/service.js';
import type { Instance } from '../src/instance.js';

const posixOnly = process.platform === 'win32' && 'POSIX modes and a POSIX stand-in for claude';
const KEY_FILE = '/home/user/.config/x-claude-key/api_key';

/** A stand-in claude that reports `auth` as asked and records its argv and environment. */
function standIn(authMethod: string) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-key-'));
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
if (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: ${JSON.stringify(authMethod)} })); process.exit(0); }
fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'got.json'), JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
// As claude does with a --settings it applied (#626): the init event reports its outputStyle.
const at = process.argv.indexOf('--settings');
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', output_style: (at >= 0 && JSON.parse(process.argv[at + 1]).outputStyle) || 'default' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0.01 }) + '\\n');
process.stdin.on('data', () => {}); process.stdin.on('end', () => process.exit(0));
setTimeout(() => process.exit(0), 200);
`,
  );
  chmodSync(bin, 0o755);
  return { dir, bin, got: () => JSON.parse(readFileSync(join(dir, 'got.json'), 'utf8')) as { argv: string[]; env: Record<string, string> } };
}

const req = (cwd: string): RunRequest => ({ role: 'worker', prompt: 'p', cwd, model: 'm', allowedTools: [], maxTurns: 5, maxBudgetUsd: 1.25, stallMs: 30_000, timeoutMs: 30_000 });
const settingsOf = (argv: string[]) => {
  const i = argv.indexOf('--settings');
  return i >= 0 ? (JSON.parse(argv[i + 1]!) as { apiKeyHelper?: string }) : null;
};

test('instance billing: an API key only when credentials.yaml names one; the environment never carries a key', () => {
  const fake = (extra: object) => ({ name: 'x', home: '/tmp/x-home', stateDir: '/tmp/x', credentials: { version: 1, github: { kind: 'gh-config-dir', path: '/tmp/gh' }, ...extra } }) as unknown as Instance;
  assert.deepEqual(instanceRuntime(fake({})), { runtime: 'cli' });
  assert.deepEqual(instanceRuntime(fake({ agent_api_key: KEY_FILE })), { runtime: 'api_key', apiKeyFile: KEY_FILE });
  const base = { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-' + 'x'.repeat(30), ANTHROPIC_AUTH_TOKEN: 't' };
  for (const i of [fake({}), fake({ agent_api_key: KEY_FILE })]) {
    const env = instanceEnv(i, base);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  }
});

test('the runner gives claude the key through apiKeyHelper (a path, never the key) and keeps --max-budget-usd; a login runner gives none', { skip: posixOnly }, async () => {
  const key = standIn('api_key_helper');
  const keyed = await new CliRunner('api_key', { PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: join(key.dir, 'cfg'), ANTHROPIC_API_KEY: 'sk-ant-' + 'y'.repeat(30) }, key.bin, undefined, undefined, undefined, {}, undefined, KEY_FILE).run(req(key.dir));
  assert.equal(keyed.reason, 'succeeded', keyed.detail);
  const got = key.got();
  assert.equal(settingsOf(got.argv)?.apiKeyHelper, `cat -- ${KEY_FILE}`);
  const budget = got.argv.indexOf('--max-budget-usd');
  assert.equal(got.argv[budget + 1], '1.25', 'the run is still capped by its budget');
  assert.equal(got.env.ANTHROPIC_API_KEY, undefined, 'the helper is the only way in: no key from the environment');
  assert.ok(!JSON.stringify(got).includes('y'.repeat(30)), 'the key value appears nowhere in what claude was given');

  const login = standIn('claude.ai');
  const plain = await new CliRunner('cli', { PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: join(login.dir, 'cfg'), ANTHROPIC_API_KEY: 'sk-ant-' + 'z'.repeat(30) }, login.bin, undefined, undefined, undefined, {}, undefined, KEY_FILE).run(req(login.dir));
  assert.equal(plain.reason, 'succeeded', plain.detail);
  assert.equal(settingsOf(login.got().argv)?.apiKeyHelper, undefined, 'a login runner never gets the helper');
  assert.equal(login.got().env.ANTHROPIC_API_KEY, undefined, 'nor a key in its environment');
});

test('an API-key runner refuses to start when claude reports a login: no silent billing switch', { skip: posixOnly }, async () => {
  const s = standIn('claude.ai');
  const r = await new CliRunner('api_key', { PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: join(s.dir, 'cfg') }, s.bin, undefined, undefined, undefined, {}, undefined, KEY_FILE).run(req(s.dir));
  assert.equal(r.reason, 'auth_mismatch');
});

test('apiKeyHelperCommand: only an absolute, plain path becomes a command', () => {
  assert.equal(apiKeyHelperCommand(KEY_FILE), `cat -- ${KEY_FILE}`);
  for (const bad of ['relative/key', '/a b/key', "/a'b", '/a;rm -rf ~', '/a$(x)']) assert.throws(() => apiKeyHelperCommand(bad), /must be absolute/, bad);
});

test('the key file: 0400 is the agent user\'s only; any group or other bit is open (real files)', { skip: posixOnly }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'key-mode-'));
  const f = join(dir, 'api_key');
  writeFileSync(f, 'k');
  chmodSync(f, 0o400);
  const shut = fileAccess(f);
  assert.ok(shut.kind === 'file' && !shut.openToOthers && shut.mode === '0400');
  chmodSync(f, 0o640);
  const open = fileAccess(f);
  assert.ok(open.kind === 'file' && open.openToOthers);
  assert.equal(fileAccess(join(dir, 'none')).kind, 'missing');
});

test('doctor: the key file must exist, be the agent user\'s and open to nobody else; a file it can\'t see is a warning, not a pass', () => {
  const uid = () => 1001;
  const file = (uid: number, openToOthers: boolean) => () => ({ kind: 'file' as const, uid, openToOthers, mode: openToOthers ? '0644' : '0400' });
  assert.equal(apiKeyCheck(KEY_FILE, 'wl-x-agent', file(1001, false), uid).level, 'ok');
  assert.match(apiKeyCheck(KEY_FILE, 'wl-x-agent', file(1001, true), uid).detail, /mode 0644: only wl-x-agent may read it/);
  assert.match(apiKeyCheck(KEY_FILE, 'wl-x-agent', file(0, false), uid).detail, /not owned by wl-x-agent/);
  assert.equal(apiKeyCheck(KEY_FILE, 'wl-x-agent', () => ({ kind: 'missing' }), uid).level, 'fail');
  const hidden = apiKeyCheck(KEY_FILE, 'wl-x-agent', () => ({ kind: 'hidden' }), uid);
  assert.deepEqual([hidden.level, /run doctor as root/.test(hidden.detail)], ['warn', true]);
  assert.equal(apiKeyCheck(KEY_FILE, null).level, 'fail', 'an API key needs agents to run as their own user');
});

test('agent_runtime: api_key, with sdk accepted as its old name', () => {
  const kind = (v: object) => ProjectConfig.shape.agent_runtime.parse(v).kind;
  assert.equal(kind({ kind: 'sdk' }), 'api_key');
  assert.equal(kind({ kind: 'api_key' }), 'api_key');
  assert.equal(kind({}), 'cli');
});
