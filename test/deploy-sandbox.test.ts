// Issue #799: a project's deploy trigger and verify commands come from its deploy.yaml, which an approved PR can
// change. They are project commands: run as the agent user, in the sandbox that hides the coordinator's and the
// agent's credentials, with the project's environment only, under the command timeout, and redacted (#713). A
// command that is refused, times out or is stopped never counts as a done deploy.
//
// No real sudo and no real state: a stand-in `sudo` first on PATH records the user it was asked for, then runs the
// command as this user (the current user stands in for the agent user), whose "home" is a temp dir holding planted
// stand-in keys. The real sandbox (bubblewrap at /usr/bin/bwrap) runs where it can, as in
// test/project-command-isolation.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ProjectRunAs } from '../src/os/index.js';
import { agents, coordinator, fixture } from './repro-state-graph/harness.js';

const posix = process.platform === 'linux';
const sandboxRuns = posix && spawnSync('/usr/bin/bwrap', ['--dev-bind', '/', '/', '--unshare-user', '--unshare-pid', '--proc', '/proc', '--', '/bin/sh', '-c', ':']).status === 0;
// CI installs bubblewrap and sets PROJECT_SANDBOX_REQUIRED=1: there a missing sandbox fails instead of skipping.
const required = process.env.PROJECT_SANDBOX_REQUIRED === '1';
const realSkip = required ? false : !posix ? 'bubblewrap is Linux only' : !sandboxRuns && 'no usable /usr/bin/bwrap here (CI runs this with it)';

const SHA = 'a'.repeat(40);

/** A stand-in `sudo`, first on PATH: records who it was asked to run as, drops `-n -u <user> --`, runs the rest as this user. */
function standInSudo(root: string): () => string[] {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const record = join(root, 'sudo-calls');
  writeFileSync(join(bin, 'sudo'), `#!/bin/sh\nprintf '%s\\n' "$3" >> '${record}'\n[ "$1" = -n ] && [ "$2" = -u ] && [ "$4" = -- ] || exit 1\nshift 4\nexec "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`;
  return () => (existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean) : []);
}

/** Stand-in secrets: the agent's Claude login and API key in its home, and a coordinator-only key outside it. */
function planted() {
  const root = mkdtempSync(join(tmpdir(), 'wl-799-'));
  const home = join(root, 'agent');
  const key = (p: string) => {
    const v = `PLANTED-${randomBytes(12).toString('hex')}`;
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, `${v}\n`, { mode: 0o600 });
    return v;
  };
  const appKey = join(root, 'coordinator', 'app.pem');
  const keys = {
    login: key(join(home, '.claude', '.credentials.json')),
    apiKey: key(join(home, '.config', 'shop-claude-key', 'api_key')),
    app: key(appKey),
  };
  writeFileSync(join(home, 'notes.txt'), 'ordinary\n');
  const paths = [join(home, '.claude', '.credentials.json'), join(home, '.config', 'shop-claude-key', 'api_key'), appKey];
  return { root, home, keys, appKey, paths, out: join(root, 'deploy-out.txt'), ran: join(root, 'ran.txt') };
}

type Deployer = { deploy(env: string, trigger: string, verify: string, sha: string, issue?: number, polls?: number, pollMs?: number): Promise<boolean> };
const deployer = (c: unknown) => c as Deployer;

test('a deploy trigger and verify run as the agent user, sandboxed: a planted command reads no coordinator key, no agent credential and none of the coordinator\'s environment', { skip: !posix && 'POSIX shell' }, async () => {
  const p = planted();
  const calls = standInSudo(p.root);
  const envSecret = `PLANTED-${randomBytes(12).toString('hex')}`;
  process.env.WL799_COORDINATOR_SECRET = envSecret;
  try {
    const f = fixture();
    const commandsAs: ProjectRunAs = { user: 'shop-agent', home: p.home, hide: [p.appKey] };
    const c = coordinator(f, agents(), { commandsAs });
    const steal = `for x in ${p.paths.map((x) => JSON.stringify(x)).join(' ')}; do cat "$x"; done; grep -rh PLANTED "$HOME"; echo "env:$WL799_COORDINATOR_SECRET"; cat ~/notes.txt`;
    const ok = await deployer(c).deploy('staging', `{ ${steal}; } > ${JSON.stringify(p.out)} 2>&1; true`, `{ ${steal}; } >> ${JSON.stringify(p.out)} 2>&1; echo ${SHA}`, SHA, 7, 2, 10);
    const seen = existsSync(p.out) ? readFileSync(p.out, 'utf8') : '';
    for (const [what, v] of Object.entries({ ...p.keys, env: envSecret })) assert.ok(!seen.includes(v), `the deploy command read the ${what} stand-in: ${seen}`);
    assert.deepEqual(calls(), ['shop-agent', 'shop-agent'], 'the trigger and the verify each ran through sudo as the agent user, never as the coordinator');
    if (required || sandboxRuns) {
      assert.equal(ok, true, 'a deploy that needs none of them still triggers and verifies');
      assert.match(seen, /ordinary/, 'the command ran, with the agent home\'s ordinary files');
    } else {
      // No sandbox here: the command is refused, and a refused deploy is never a done one.
      assert.equal(ok, false);
    }
  } finally {
    delete process.env.WL799_COORDINATOR_SECRET;
  }
});

test('a deploy whose sandbox refuses to start (a symlink the agent could swap on the way to its API key) fails closed: nothing runs, deploy.failed, not verified', { skip: !posix && 'POSIX shell' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-799-'));
  standInSudo(root);
  const home = join(root, 'agent');
  mkdirSync(join(home, 'realcfg', 'shop-claude-key'), { recursive: true });
  writeFileSync(join(home, 'realcfg', 'shop-claude-key', 'api_key'), 'PLANTED-key\n');
  symlinkSync(join(home, 'realcfg'), join(home, '.config'));
  const f = fixture();
  const c = coordinator(f, agents(), { commandsAs: { user: 'shop-agent', home, hide: [] } });
  const ran = join(root, 'ran.txt');
  const ok = await deployer(c).deploy('staging', `echo ran > ${JSON.stringify(ran)}`, `echo ran >> ${JSON.stringify(ran)}; echo ${SHA}`, SHA, 7, 2, 10);
  assert.equal(ok, false, 'a refused deploy is never a done one');
  assert.ok(!existsSync(ran), 'neither the trigger nor the verify ran');
  const failed = f.log.read(0, ['deploy.failed']).at(-1)?.payload as { why: string; issue?: number } | undefined;
  assert.equal(failed?.issue, 7);
  assert.match(failed?.why ?? '', /project command not run/, 'deploy.failed says why');
  assert.equal(f.log.read(0, ['deploy.verified']).length, 0);
});

test('a deploy for an agent user without its sandbox\'s hide list is refused, never run unsandboxed', { skip: !posix && 'POSIX shell' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-799-'));
  const calls = standInSudo(root);
  const f = fixture();
  // A runAs from outside the type (an older job file, a caller that dropped it): projectCommand refuses it.
  const commandsAs = { user: 'shop-agent', home: join(root, 'agent') } as unknown as ProjectRunAs;
  const c = coordinator(f, agents(), { commandsAs });
  const ran = join(root, 'ran.txt');
  const ok = await deployer(c).deploy('staging', `echo ran > ${JSON.stringify(ran)}`, `echo ${SHA}`, SHA, 7, 2, 10);
  assert.equal(ok, false);
  assert.ok(!existsSync(ran), 'the trigger never ran');
  assert.deepEqual(calls(), [], 'nothing was started as anyone');
  const failed = f.log.read(0, ['deploy.failed']).at(-1)?.payload as { why: string } | undefined;
  assert.match(failed?.why ?? '', /hide list/, 'deploy.failed names the refusal');
});

test('a deploy trigger past the command timeout fails the deploy; a verify past it never verifies', { skip: !posix && 'POSIX shell' }, async () => {
  const f = fixture();
  f.cfg.tests.command_timeout_s = 1;
  const c = coordinator(f, agents());
  const t0 = performance.now();
  assert.equal(await deployer(c).deploy('staging', 'sleep 6; true', `echo ${SHA}`, SHA, 7, 2, 10), false, 'a trigger that timed out is a failed deploy');
  assert.match((f.log.read(0, ['deploy.failed']).at(-1)?.payload as { why: string }).why, /^trigger failed: no exit code \(timed out after 1 s/, 'deploy.failed says it timed out');
  assert.equal(await deployer(c).deploy('staging', 'true', `sleep 6; echo ${SHA}`, SHA, 7, 2, 10), false, 'a verify that timed out never counts as serving the sha');
  const took = performance.now() - t0;
  assert.ok(took < 10_000, `each command was stopped at the timeout (${Math.round(took)} ms)`);
  assert.equal(f.log.read(0, ['deploy.verified']).length, 0);
  // The same commands within the timeout still deploy (no regression for an install without an agent user).
  assert.equal(await deployer(c).deploy('staging', 'true', `echo ${SHA}`, SHA, 7, 2, 10), true);
});

test('a deploy asked for while the coordinator shuts down runs nothing and is not done', { skip: !posix && 'POSIX shell' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-799-'));
  const f = fixture();
  const c = coordinator(f, agents());
  (c as unknown as { shutdown: AbortController }).shutdown.abort();
  const ran = join(root, 'ran.txt');
  assert.equal(await deployer(c).deploy('staging', `echo ran > ${JSON.stringify(ran)}`, `echo ${SHA}`, SHA, 7, 2, 10), false);
  assert.ok(!existsSync(ran), 'the trigger never ran');
});

for (const stage of ['trigger', 'verify'] as const) {
  test(`a shutdown that stops a running deploy ${stage} fails the deploy and says why`, { skip: !posix && 'POSIX shell' }, async () => {
    const f = fixture();
    const c = coordinator(f, agents());
    const started = join(mkdtempSync(join(tmpdir(), 'wl-799-')), 'started');
    const slow = `touch ${JSON.stringify(started)}; sleep 20`;
    const run = deployer(c).deploy('staging', stage === 'trigger' ? slow : 'true', stage === 'verify' ? `${slow}; echo ${SHA}` : `echo ${SHA}`, SHA, 7, 2, 10);
    const t0 = performance.now();
    while (!existsSync(started) && performance.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 20));
    assert.ok(existsSync(started), `the ${stage} started`);
    (c as unknown as { shutdown: AbortController }).shutdown.abort();
    assert.equal(await run, false, 'stopped by a shutdown, never done');
    assert.ok(performance.now() - t0 < 15_000, 'the command was stopped, not waited out');
    const why = (f.log.read(0, ['deploy.failed']).at(-1)?.payload as { why: string }).why;
    assert.match(why, new RegExp(`^${stage === 'trigger' ? 'trigger failed' : 'verify refused or stopped'}: stopped: the coordinator is shutting down`), why);
    assert.equal(f.log.read(0, ['deploy.verified']).length, 0);
  });
}

test('a key a sandboxed deploy trigger prints reaches no event: deploy.failed carries it redacted', { skip: realSkip }, async () => {
  const p = planted();
  standInSudo(p.root);
  const f = fixture();
  const c = coordinator(f, agents(), { commandsAs: { user: 'shop-agent', home: p.home, hide: [p.appKey] } });
  const t = `sk-ant-oat01-${randomBytes(24).toString('base64url')}Ab1`;
  const ok = await deployer(c).deploy('staging', `echo "deploy auth failed for ${t.slice(0, 7)}""${t.slice(7)}" >&2; exit 1`, `echo ${SHA}`, SHA, 7, 2, 10);
  assert.equal(ok, false);
  const why = (f.log.read(0, ['deploy.failed']).at(-1)?.payload as { why: string }).why;
  assert.ok(!why.includes(t), why);
  assert.match(why, /deploy auth failed for sk-\[REDACTED\]/);
});
