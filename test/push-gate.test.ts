import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { which } from '../src/os/index.js';
import { repoRoot } from './helpers.js';

const gate = fileURLToPath(new URL('../../scripts/push-gate.mjs', import.meta.url));
const skip = !which('gitleaks') && 'gitleaks not installed';
const sha = (t: string) => execFileSync('node', ['-e', `console.log(require('crypto').createHash('sha256').update(${JSON.stringify(t)}).digest('hex'))`], { encoding: 'utf8' }).trim();

/** A repo with this repo's real patterns, one hashed private term, a bare remote and the pre-push hook. */
function repo() {
  const base = mkdtempSync(join(tmpdir(), 'pushgate-'));
  const dir = join(base, 'work');
  const remote = join(base, 'remote.git');
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  mkdirSync(dir);
  git('init', '-q', '-b', 'main');
  for (const [k, v] of [['user.name', 'Ada'], ['user.email', 'ada@example.com'], ['commit.gpgsign', 'false']]) git('config', k!, v!);
  const real = JSON.parse(readFileSync(join(repoRoot, '.denylist.json'), 'utf8')) as { patterns: string[] };
  writeFileSync(join(dir, '.denylist.json'), JSON.stringify({ hashed: [sha('secretproject')], patterns: real.patterns }));
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', 'main');
  mkdirSync(join(dir, '.githooks'));
  writeFileSync(join(dir, '.githooks', 'pre-push'), `#!/bin/sh\nexec node ${JSON.stringify(gate)} "$@"\n`);
  chmodSync(join(dir, '.githooks', 'pre-push'), 0o755);
  git('config', 'core.hooksPath', '.githooks');
  const commit = (file: string, text: string, msg = 'change') => {
    writeFileSync(join(dir, file), text);
    git('add', file);
    git('commit', '-q', '-m', msg);
  };
  const push = () => spawnSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/feature'], { cwd: dir, encoding: 'utf8' });
  return { dir, git, commit, push };
}

const blocked = [
  ['a hashed private name in a file', 'notes.md', 'deployed by secretproject\n', 'add notes'],
  ['a home directory path', 'notes.md', 'see /Users/ada/work/x\n', 'add notes'],
  ['a Tailscale address', 'notes.md', 'ssh 100.101.102.103\n', 'add notes'],
  ['a MagicDNS host', 'notes.md', 'box.tail1234.ts.net\n', 'add notes'],
  ['an ntfy topic', 'notes.md', 'curl ntfy.sh/my-alerts-x\n', 'add notes'],
  ['an email', 'notes.md', 'mail bob@corp.dev\n', 'add notes'],
  ['a private name in the commit message', 'ok.md', 'fine\n', 'fix the secretproject deploy'],
];

for (const [what, file, text, msg] of blocked) {
  test(`push gate refuses ${what}`, { skip }, () => {
    const r = repo();
    r.commit(file!, text!, msg);
    const p = r.push();
    assert.notEqual(p.status, 0, 'push must be refused');
    assert.match(p.stderr, /push gate: REFUSED/);
    assert.equal(spawnSync('git', ['ls-remote', 'origin', 'refs/heads/feature'], { cwd: r.dir, encoding: 'utf8' }).stdout, '', 'nothing reached the remote');
  });
}

test('push gate allows a clean push; the author\'s own sign-off is not a leak; placeholders are fine', { skip }, () => {
  const r = repo();
  r.commit('docs.md', 'paths like /home/example/x and /Users/you/x are placeholders; 192.0.2.5 is documentation\n', 'Add docs\n\nSigned-off-by: Ada <ada@example.com>');
  const p = r.push();
  assert.equal(p.status, 0, p.stderr);
});

test('push gate refuses a committed secret (gitleaks)', { skip }, () => {
  const r = repo();
  r.commit('config.js', `const key = "AKIA${'Z'.repeat(4)}${'Q7W2E9R4T6Y8'}";\nconst secret = "${'wJalrXUtnFEMI/K7MDENG/bPxRfiCY'}EXAMPLEKEY";\n`, 'add config');
  const p = r.push();
  assert.notEqual(p.status, 0);
  assert.match(p.stderr, /gitleaks found a secret/);
});

test('push gate fails closed: no gitleaks, no push', { skip: process.platform === 'win32' && 'PATH surgery is POSIX-only here' }, () => {
  const r = repo();
  r.commit('ok.md', 'fine\n', 'fine');
  const node = process.execPath;
  const p = spawnSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/feature'], { cwd: r.dir, encoding: 'utf8', env: { ...process.env, PATH: [join(node, '..'), '/usr/bin', '/bin'].join(delimiter) } });
  assert.notEqual(p.status, 0);
  assert.match(p.stderr, /gitleaks could not run/);
});

test('push gate --range checks exactly the given commits (CI mode)', { skip }, () => {
  const r = repo();
  const base = r.git('rev-parse', 'HEAD');
  r.commit('notes.md', 'deployed by secretproject\n');
  const p = spawnSync('node', [gate, '--range', `${base}..HEAD`], { cwd: r.dir, encoding: 'utf8' });
  assert.notEqual(p.status, 0);
  assert.match(p.stderr, /denied term "secretproject"/);
  assert.equal(spawnSync('node', [gate, '--range', 'nonsense..HEAD'], { cwd: r.dir, encoding: 'utf8' }).status, 1, 'an unresolvable range refuses');
});
