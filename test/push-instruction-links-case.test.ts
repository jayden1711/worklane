// #951 items 4 and 5, measured by #928's round-3 review: a directory symlink under .claude/skills added no SKILL.md
// name, so a failing skill came in unlinted; and `SECRETS/k.key` against `secrets/**`, `.GitHub/Workflows/x.yml`
// against the workflows check, got through. Links where the agents' instructions are read are refused, and the
// refused paths and the workflows directory are matched case folded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { DEFAULT_PUSH_LIMITS, pushProblems } from '../src/push-check.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const BAD = '## When to use\nx\n';
const posix = { skip: process.platform === 'win32' && 'symlinks' };
const LIMITS = { ...DEFAULT_PUSH_LIMITS, max_changed_lines: 1_000_000, max_file_mb: 100 };

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'push-links-case-'));
  git(dir, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 'bot@example.com'], ['user.name', 'bot'], ['commit.gpgsign', 'false'], ['core.symlinks', 'true'], ['core.ignorecase', 'false']]) git(dir, 'config', k!, v!);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return { dir, base: git(dir, 'rev-parse', 'HEAD') };
}

/** Commit the working tree; files are added by name from the index so a case variant is kept as written. */
const commit = (dir: string) => {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'change');
  return git(dir, 'rev-parse', 'HEAD');
};
const linkProblems = (p: string[]) => p.filter((x) => x.includes("where the agents' instructions are read"));

test('#951: a directory symlink under .claude/skills, to a skill that fails the lint, is refused', posix, () => {
  const r = repo();
  mkdirSync(join(r.dir, 'docs', 'evil'), { recursive: true });
  writeFileSync(join(r.dir, 'docs', 'evil', 'SKILL.md'), BAD);
  mkdirSync(join(r.dir, '.claude', 'skills'), { recursive: true });
  symlinkSync('../../docs/evil', join(r.dir, '.claude', 'skills', 'x'));
  const p = linkProblems(pushProblems(r.dir, r.base, commit(r.dir), LIMITS));
  assert.equal(p.length, 1, p.join('\n'));
  assert.match(p[0]!, /\.claude\/skills\/x/);
});

test('#951: a link at or above any place the agents\' instructions are read is refused', posix, () => {
  const letThrough: string[] = [];
  for (const at of ['.claude/skills', `${BRAND.configDir}/skills/s`, `${BRAND.configDir}/roles`, 'AGENTS.md', 'pkg/CLAUDE.md', 'lib/x/SKILL.md', '.claude/commands/c']) {
    const r = repo();
    mkdirSync(join(r.dir, 'docs'), { recursive: true });
    writeFileSync(join(r.dir, 'docs', 'any.md'), BAD);
    const parts = at.split('/');
    mkdirSync(join(r.dir, ...parts.slice(0, -1)), { recursive: true });
    symlinkSync(join(...parts.slice(0, -1).map(() => '..'), 'docs', 'any.md'), join(r.dir, ...parts));
    if (!linkProblems(pushProblems(r.dir, r.base, commit(r.dir), LIMITS)).length) letThrough.push(at);
  }
  assert.deepEqual(letThrough, []);
});

test('#951: a symlink elsewhere, and regular files in the instruction places, are not refused as links', posix, () => {
  const r = repo();
  mkdirSync(join(r.dir, 'docs'), { recursive: true });
  writeFileSync(join(r.dir, 'docs', 'a.md'), 'a\n');
  symlinkSync('a.md', join(r.dir, 'docs', 'b.md'));
  mkdirSync(join(r.dir, `${BRAND.configDir}`, 'roles'), { recursive: true });
  writeFileSync(join(r.dir, `${BRAND.configDir}`, 'roles', 'worker.md'), 'be careful\n');
  writeFileSync(join(r.dir, 'CLAUDE.md'), 'notes\n');
  assert.deepEqual(linkProblems(pushProblems(r.dir, r.base, commit(r.dir), LIMITS)), []);
});

test('#951: refuse_paths and the workflows directory are matched case folded', () => {
  const cases: [string, string[]][] = [
    ['SECRETS/k.key', ['secrets/**']],
    ['secrets/k.key', ['Secrets/**']],
    ['Keys/ID.PEM', ['**/*.pem']],
  ];
  const letThrough: string[] = [];
  for (const [path, refuse] of cases) {
    const r = repo();
    const parts = path.split('/');
    mkdirSync(join(r.dir, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(join(r.dir, ...parts), 'k\n');
    const p = pushProblems(r.dir, r.base, commit(r.dir), { ...LIMITS, refuse_paths: refuse });
    if (!p.some((x) => x.includes('push.refuse_paths'))) letThrough.push(`${path} vs ${refuse.join(',')}`);
  }
  const r = repo();
  mkdirSync(join(r.dir, '.GitHub', 'Workflows'), { recursive: true });
  writeFileSync(join(r.dir, '.GitHub', 'Workflows', 'x.yml'), 'on: push\n');
  if (!pushProblems(r.dir, r.base, commit(r.dir), LIMITS).some((x) => x.includes('changes CI workflows'))) letThrough.push('.GitHub/Workflows/x.yml');
  assert.deepEqual(letThrough, []);
  const plain = repo();
  writeFileSync(join(plain.dir, 'Secretary.md'), 'x\n');
  assert.ok(!pushProblems(plain.dir, plain.base, commit(plain.dir), { ...LIMITS, refuse_paths: ['secrets/**'] }).some((x) => x.includes('push.refuse_paths')));
});
