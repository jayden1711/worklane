// The updater's release channel: it installs only a newer release tag that verifies against the owner's allowed
// signers, cut from main with only dist/ added, with green required checks on that main commit. The channel is
// "release" for a new install and stays "main" for an existing updates.json without one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateChannel, updateSettings } from '../src/updates.js';
import { repoRoot } from './helpers.js';

type Verified = { ok: true; base: string; object: string; commit: string } | { ok: false; reason: string };
const u = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', 'worklane-update.cjs')) as {
  channelOf(cfg: unknown): string;
  newer(a: string, b: string): boolean;
  parseTags(s: string): { tag: string; version: string; commit: string; annotated: boolean }[];
  newestRelease(t: { version: string }[]): { tag: string; version: string; commit: string } | null;
  verifyRelease(repoUrl: string, tag: string, signers: string, exec: (f: string, a: string[]) => string, gitDir?: string): Verified;
  run(deps: object): Promise<string>;
};

const posix = process.platform === 'win32' && 'ssh signing in POSIX shells';
const run = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const exec = (file: string, args: string[]) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** An origin with a main commit and release tags on top of it: signed by `key`, unsigned, lightweight, or changing more than dist/. */
function origin() {
  const dir = mkdtempSync(join(tmpdir(), 'rel-origin-'));
  const key = join(dir, '..', `${dir.split(/[\\/]/).pop()}-key`);
  spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'release', '-f', key]);
  const other = `${key}-other`;
  spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'someone-else', '-f', other]);
  const signers = join(dir, '..', `${dir.split(/[\\/]/).pop()}-allowed_signers`);
  writeFileSync(signers, `owner@example.com namespaces="git" ${execFileSync('cat', [`${key}.pub`], { encoding: 'utf8' }).trim()}\n`);
  run(dir, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.name', 'Owner'], ['user.email', 'owner@example.com'], ['commit.gpgsign', 'false'], ['gpg.format', 'ssh'], ['user.signingkey', key]]) run(dir, 'config', k!, v!);
  writeFileSync(join(dir, 'package.json'), '{"version":"1.0.0"}\n');
  run(dir, 'add', '-A');
  run(dir, 'commit', '-q', '-m', 'main');
  const main = run(dir, 'rev-parse', 'HEAD');
  /** A release commit on top of main (detached) tagged `tag`; `extra` adds a file outside dist/. */
  const release = (tag: string, how: 'signed' | 'unsigned' | 'lightweight' | 'other-key', extra = false) => {
    run(dir, 'checkout', '-q', '--detach', main);
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'cli.js'), `// ${tag}\n`);
    if (extra) writeFileSync(join(dir, 'README.md'), 'changed\n');
    run(dir, 'add', '-f', 'dist', ...(extra ? ['README.md'] : []));
    run(dir, 'commit', '-q', '-m', `Release ${tag}`);
    if (how === 'signed') run(dir, 'tag', '-s', tag, '-m', tag);
    else if (how === 'other-key') run(dir, '-c', `user.signingkey=${other}`, 'tag', '-s', tag, '-m', tag);
    else if (how === 'unsigned') run(dir, 'tag', '-a', tag, '-m', tag);
    else run(dir, 'tag', tag);
    const commit = run(dir, 'rev-parse', 'HEAD');
    run(dir, 'checkout', '-q', 'main');
    return commit;
  };
  return { dir, signers, main, release };
}

const verify = (o: ReturnType<typeof origin>, tag: string, signers = o.signers) => u.verifyRelease(o.dir, tag, signers, exec, join(mkdtempSync(join(tmpdir(), 'verify-')), 'v.git'));

test('an unsigned release tag is refused; so is a lightweight one, one signed by a key not allowed, and one without an allowed signers file', { skip: posix }, () => {
  const o = origin();
  o.release('v1.0.1', 'unsigned');
  o.release('v1.0.2', 'lightweight');
  o.release('v1.0.3', 'other-key');
  const unsigned = verify(o, 'v1.0.1');
  assert.equal(unsigned.ok, false);
  assert.match((unsigned as { reason: string }).reason, /v1\.0\.1's signature doesn't verify against/);
  assert.match((verify(o, 'v1.0.2') as { reason: string }).reason, /lightweight tag/);
  assert.match((verify(o, 'v1.0.3') as { reason: string }).reason, /signature doesn't verify/);
  assert.match((verify(o, 'v1.0.1', join(o.dir, 'nope')) as { reason: string }).reason, /no allowed signers file/);
});

test('a release tag signed by an allowed key, cut from main with only dist/ added, verifies; its main commit is the one whose checks count', { skip: posix }, () => {
  const o = origin();
  const commit = o.release('v1.1.0', 'signed');
  o.release('v1.1.1', 'signed', true);
  assert.deepEqual(verify(o, 'v1.1.0'), { ok: true, base: o.main, object: run(o.dir, 'rev-parse', 'refs/tags/v1.1.0'), commit }, 'the one tag object verified, and the commit it points at');
  assert.match((verify(o, 'v1.1.1') as { reason: string }).reason, /changes more than dist\/: README\.md/);
});

test('run, release channel: an unsigned newest tag is refused and nothing is built; a verified one is installed with checks read on its main commit', async () => {
  const listing = (commit: string) => `${'1'.repeat(40)}\trefs/tags/v0.4.1\n${'2'.repeat(40)}\trefs/tags/v0.4.1^{}\n${'3'.repeat(40)}\trefs/tags/v0.5.0\n${commit}\trefs/tags/v0.5.0^{}\n`;
  const NEW = 'b'.repeat(40);
  const BASE = 'c'.repeat(40);
  const machine = (verified: Verified, installedVersion = '0.4.1') => {
    const calls: string[] = [];
    const logs: Record<string, unknown>[] = [];
    const checked: Record<string, unknown>[] = [];
    let current = 'a'.repeat(40);
    let clock = 0;
    const deps = {
      config: () => ({ enabled: true, channel: 'release', repo_url: 'https://github.com/example-org/engine.git', required_checks: ['test'] }),
      installed: () => current,
      installedVersion: () => installedVersion,
      verifyRelease: (_url: string, tag: string) => (calls.push(`verify ${tag}`), verified),
      exec: (file: string, args: string[]) => {
        calls.push([file, ...args].join(' ').slice(0, 60));
        if (file === 'git') return listing(NEW);
        if (file === 'systemctl' && args[0] === 'list-units') return 'worklane-x.service loaded active running x\n';
        if (file === 'systemctl' && args[0] === 'show') return 'ActiveState=active\nSubState=running\nNRestarts=0\nResult=success\n';
        return '';
      },
      fetchJson: async (url: string) => (calls.push(`fetch ${url.split('/repos/')[1]}`), { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success', started_at: '1', id: 1 }] }),
      slots: () => [],
      alive: () => false,
      installTree: (sha: string) => calls.push(`installTree ${sha.slice(0, 4)}`),
      syncHelpers: () => [],
      switchTo: (sha: string) => ((current = sha), calls.push(`switchTo ${sha.slice(0, 4)}`)),
      now: () => clock,
      sleep: async (ms: number) => void (clock += ms),
      log: (e: Record<string, unknown>) => logs.push(e),
      held: () => null,
      hold: () => {},
      configChangedAt: () => 0,
      note: (event: string, sha: string | null, reason: string) => (logs.push({ event, to: sha, reason }), event),
      checked: (s: Record<string, unknown>) => checked.push(s),
    };
    return { deps, calls, logs, checked };
  };
  const refused = machine({ ok: false, reason: "v0.5.0's signature doesn't verify against /etc/worklane/allowed_signers: no signature found" });
  assert.equal(await u.run(refused.deps), 'refused');
  assert.match(String(refused.logs.at(-1)!.reason), /signature doesn't verify/);
  assert.ok(!refused.calls.some((c) => /^(systemd-run|installTree|switchTo)/.test(c)), 'nothing built or switched');
  const ok = machine({ ok: true, base: BASE, object: '3'.repeat(40), commit: NEW });
  assert.equal(await u.run(ok.deps), 'installed');
  assert.ok(ok.calls.includes('verify v0.5.0'), 'the newest tag');
  assert.ok(ok.calls.includes(`fetch example-org/engine/commits/${BASE}/check-runs?per_page=100`), 'checks on the main commit the release was cut from');
  assert.ok(!ok.calls.some((c) => c.includes('/compare/')), 'no fast-forward compare: releases are ordered by version');
  assert.ok(ok.calls.includes('switchTo bbbb'));
  assert.equal(ok.logs.find((l) => l.event === 'attempt')!.tag, 'v0.5.0');
  // Not newer than the installed version: nothing to do, never a downgrade.
  const same = machine({ ok: true, base: BASE, object: '3'.repeat(40), commit: NEW }, '0.5.0');
  assert.equal(await u.run(same.deps), 'current');
  assert.deepEqual(same.calls.filter((c) => c.startsWith('verify')), []);
  // Recorded with its time and channel in the state file, not as a line in the log (#465).
  assert.deepEqual(same.checked, [{ event: 'current', at: new Date(0).toISOString(), channel: 'release', sha: 'a'.repeat(40), version: '0.5.0', newest: 'v0.5.0' }]);
  assert.deepEqual(same.logs, []);
  assert.deepEqual(ok.checked, [], 'an install is not an up-to-date check');
});

test('the channel: release only when updates.json says so; an existing file without one keeps main; a new install writes release', () => {
  assert.equal(u.channelOf({ channel: 'release' }), 'release');
  assert.equal(u.channelOf({}), 'main', 'an existing install keeps following main');
  assert.equal(u.channelOf({ channel: 'nightly' }), 'main');
  assert.equal(updateChannel({ channel: 'release' }), 'release');
  assert.equal(updateChannel({}), 'main');
  const dir = mkdtempSync(join(tmpdir(), 'upd-'));
  writeFileSync(join(dir, 'old.json'), JSON.stringify({ enabled: true, repo_url: 'r', required_checks: ['test'] }));
  assert.equal(updateSettings(join(dir, 'old.json'))!.channel, 'main');
  const fresh = spawnSync('bash', ['-c', `source "${join(repoRoot, 'scripts', 'setup', 'lib.sh')}"; updates_config_json https://github.com/example-org/engine.git test`], { encoding: 'utf8' });
  if (process.platform !== 'win32') {
    assert.equal(fresh.status, 0, fresh.stderr);
    const j = JSON.parse(fresh.stdout) as { channel: string; allowed_signers: string; enabled: boolean };
    assert.deepEqual([j.channel, j.allowed_signers, j.enabled], ['release', '/etc/worklane/allowed_signers', false]);
  }
  assert.equal(u.newer('0.10.0', '0.9.9'), true);
  assert.equal(u.newer('0.4.1', '0.4.1'), false);
  const tags = u.parseTags(`${'1'.repeat(40)}\trefs/tags/v0.9.0\n${'2'.repeat(40)}\trefs/tags/v0.9.0^{}\n${'3'.repeat(40)}\trefs/tags/v0.10.0\n${'4'.repeat(40)}\trefs/tags/v0.10.0^{}\n${'5'.repeat(40)}\trefs/tags/other\n`);
  assert.deepEqual(u.newestRelease(tags), { tag: 'v0.10.0', version: '0.10.0', object: '3'.repeat(40), commit: '4'.repeat(40), annotated: true });
});
