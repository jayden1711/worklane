import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { apiKeyHelperCommand, CliRunner } from '../src/runner.js';

const posix = process.platform !== 'win32';
const helper = apiKeyHelperCommand as (file: string, installed?: { instance: string; user: string }) => string;
const identity = { instance: 'alpha', user: 'wl-alpha-agent' };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'installed-key-'));
  const home = join(dir, 'home');
  const key = join(home, '.config', 'alpha-claude-key', 'api_key');
  mkdirSync(dirname(key), { recursive: true });
  writeFileSync(key, 'fixture-api-key', { mode: 0o400 });
  const privateFile = join(home, 'private-file');
  writeFileSync(privateFile, 'private-fixture-must-not-be-read', { mode: 0o400 });
  const preload = join(dir, 'passwd.cjs');
  writeFileSync(preload, `require('node:os').userInfo = () => (${JSON.stringify({ username: identity.user, homedir: home, uid: process.getuid?.() ?? -1 })});`);
  return { dir, home, key, privateFile, preload };
}
function run(command: string, f: ReturnType<typeof fixture>) {
  // Only the fixture subprocess gets a fake passwd identity; the production helper's code and arguments stay intact.
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const tested = command.replace(q(process.execPath), `${q(process.execPath)} --require ${q(f.preload)}`);
  return spawnSync('/bin/sh', ['-c', tested], { encoding: 'utf8', timeout: 3000, env: { PATH: process.env.PATH ?? '' } });
}

test('installed-key helper never reads an arbitrary private file or another instance key', { skip: !posix }, () => {
  const f = fixture();
  for (const path of [f.privateFile, join(f.home, '.config', 'other-claude-key', 'api_key'), `${dirname(f.key)}/../alpha-claude-key/api_key`]) {
    const r = run(helper(path, identity), f);
    assert.notEqual(r.status, 0, path);
    assert.equal(r.stdout, '', 'refused key sends no file bytes');
  }
});

test('installed-key helper accepts its own installed private file and refuses links, permissions and owner mismatch', { skip: !posix }, () => {
  const good = fixture();
  const accepted = run(helper(good.key, identity), good);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout, 'fixture-api-key');
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => chmodSync(f.key, 0o440),
    (f: ReturnType<typeof fixture>) => linkSync(f.key, join(f.home, 'second-link')),
    (f: ReturnType<typeof fixture>) => writeFileSync(f.preload, `require('node:os').userInfo = () => (${JSON.stringify({ username: identity.user, homedir: f.home, uid: (process.getuid?.() ?? 0) + 1 })});`),
    (f: ReturnType<typeof fixture>) => { renameSync(f.key, f.key + '-old'); symlinkSync(f.privateFile, f.key); },
    (f: ReturnType<typeof fixture>) => { chmodSync(f.key, 0o600); writeFileSync(f.key, 'x'.repeat(65537)); chmodSync(f.key, 0o400); },
  ]) {
    const f = fixture();
    mutate(f);
    const r = run(helper(f.key, identity), f);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, '');
  }
  const linked = fixture();
  const link = join(linked.home, '.config', 'alias-claude-key');
  symlinkSync(dirname(linked.key), link);
  writeFileSync(linked.preload, `require('node:os').userInfo = () => (${JSON.stringify({ username: 'wl-alias-agent', homedir: linked.home, uid: process.getuid?.() ?? -1 })});`);
  const r = run(helper(join(link, 'api_key'), { instance: 'alias', user: 'wl-alias-agent' }), linked);
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, '');
});

test('an installed-key FIFO is refused without waiting for a writer', { skip: !posix }, () => {
  const f = fixture();
  renameSync(f.key, f.key + '-old');
  const made = spawnSync('mkfifo', ['-m', '0600', f.key], { encoding: 'utf8', timeout: 3000 });
  assert.equal(made.status, 0, made.stderr);
  const r = run(helper(f.key, identity), f);
  assert.notEqual(r.status, 0);
  assert.equal(r.signal, null, 'helper exits itself, before the subprocess timeout');
  assert.equal(r.stdout, '');
});

test('an instance key without identity never starts claude, even if credentials names an otherwise plain private path', { skip: !posix }, async () => {
  const f = fixture();
  const bin = join(f.dir, 'claude');
  writeFileSync(bin, `#!/usr/bin/env node
if(process.argv[2] === 'auth') { console.log(JSON.stringify({loggedIn:true,authMethod:'api_key_helper'})); process.exit(0); }
require('node:fs').writeFileSync(${JSON.stringify(join(f.dir, 'started'))}, 'yes');
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok',num_turns:1,total_cost_usd:0}));
process.stdin.resume();
`, { mode: 0o755 });
  for (const [runAs, instance] of [[undefined, undefined], [undefined, 'alpha'], [{ user: 'wrong-user', home: f.home }, 'alpha']] as const) {
    const result = await new CliRunner('api_key', { PATH: process.env.PATH ?? '' }, bin, runAs, undefined, undefined, {}, undefined, f.privateFile, undefined, undefined, undefined, undefined, undefined, undefined, undefined, instance).run({ role: 'worker', prompt: 'p', cwd: f.dir, model: 'fixture', allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, stallMs: 2000, timeoutMs: 3000 });
    assert.equal(result.reason, 'failed');
    assert.match(result.detail ?? '', /instance|identity|agent user/);
    assert.throws(() => readFileSync(join(f.dir, 'started')));
  }
});
