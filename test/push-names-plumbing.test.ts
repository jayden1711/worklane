// The push limits' names come from plumbing, whatever the repo's log config says, and a name no checkout would write
// is refused (#724, round 4 of #928). An agent can write its repo's config:
// - log.showSignature=true with an ssh-signed commit glued the signature check's text to the first name
//   ("No signature\nsecrets/k.key"), so the refused path, workflow and skill checks each gave 0 where main gave 1
//   (measured by #928's adversarial review); log.showRoot=false hid an orphan root's files once a merge brought it in
//   with an "ours" tree (main misses that too);
// - a crafted tree with a ".", "..", ".git" or empty segment gave `./secrets/x.pem`, which no `secrets/**` glob
//   matched (measured);
// - a `git replace` of a 3 MB blob with a small one got past the size limit (measured).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PUSH_LIMITS, pushProblems } from '../src/push-check.js';
import { findTool } from '../src/tool-path.js';

const g = (dir: string, args: string[], input?: string | Buffer) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...(input !== undefined ? { input } : {}) }).trim();
const BAD = '## When to use\nx\n';
const LIMITS = { ...DEFAULT_PUSH_LIMITS, max_changed_lines: 1_000_000, refuse_paths: ['secrets/**'] };

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'push-plumbing-'));
  g(dir, ['init', '-q', '-b', 'main']);
  for (const [k, v] of [['user.email', 'probe@example.com'], ['user.name', 'probe'], ['commit.gpgsign', 'false']]) g(dir, ['config', k!, v!]);
  const readme = blob(dir, 'hello\n');
  const base = commit(dir, mktree(dir, [['100644', 'blob', readme, 'README.md']]), []);
  return { dir, base, readme };
}
const blob = (dir: string, text: string) => g(dir, ['hash-object', '-w', '--stdin'], text);
const mktree = (dir: string, entries: [string, string, string, string][]) => g(dir, ['mktree'], `${entries.map(([m, t, s, n]) => `${m} ${t} ${s}\t${n}`).join('\n')}\n`);
const commit = (dir: string, tree: string, parents: string[], sign = false) => g(dir, ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), ...(sign ? ['-S'] : []), '-m', 'c']);
const nest = (dir: string, path: string[], leaf: [string, string, string, string]) =>
  path.reduceRight<[string, string, string, string]>((inner, name) => ['040000', 'tree', mktree(dir, [inner]), name], leaf);

/** The three guarded changes, each its commit's only path. */
function guarded(r: ReturnType<typeof repo>) {
  const withTop = (top: [string, string, string, string]) => mktree(r.dir, [['100644', 'blob', r.readme, 'README.md'], top]);
  return {
    'a refused path': { tree: withTop(nest(r.dir, ['secrets'], ['100644', 'blob', blob(r.dir, 'SECRET\n'), 'k.key'])), want: /touches paths that are never pushed \(secrets\/k\.key\)/ },
    'a workflow': { tree: withTop(nest(r.dir, ['.github', 'workflows'], ['100644', 'blob', blob(r.dir, 'on: push\n'), 'ci.yml'])), want: /changes CI workflows \(\.github\/workflows\/ci\.yml\)/ },
    'a failing skill': { tree: withTop(nest(r.dir, ['.claude', 'skills', 'x'], ['100644', 'blob', blob(r.dir, BAD), 'SKILL.md'])), want: /skill lint: \.claude\/skills\/x\/SKILL\.md/ },
  };
}

test('log.showSignature in the repo config, with ssh-signed commits, hides none of the three checks', { skip: !findTool('ssh-keygen') && 'needs ssh-keygen' }, () => {
  const r = repo();
  const key = join(mkdtempSync(join(tmpdir(), 'push-plumbing-key-')), 'k');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'probe', '-f', key], { stdio: 'ignore' });
  g(r.dir, ['config', 'gpg.format', 'ssh']);
  g(r.dir, ['config', 'user.signingkey', `${key}.pub`]);
  g(r.dir, ['config', 'log.showSignature', 'true']);
  for (const [what, c] of Object.entries(guarded(r))) {
    const head = commit(r.dir, c.tree, [r.base], true);
    assert.match(g(r.dir, ['cat-file', 'commit', head]), /^gpgsig /m, `${what}: signed`);
    const p = pushProblems(r.dir, r.base, head, LIMITS);
    assert.ok(p.some((x) => c.want.test(x)), `${what}: ${p.join('\n')}`);
  }
});

test('log.showRoot=false hides no file of an orphan root a merge brings in with an "ours" tree', () => {
  const r = repo();
  g(r.dir, ['config', 'log.showRoot', 'false']);
  const root = commit(r.dir, guarded(r)['a refused path'].tree, []);
  const merge = commit(r.dir, g(r.dir, ['rev-parse', `${r.base}^{tree}`]), [r.base, root]);
  const p = pushProblems(r.dir, r.base, merge, LIMITS);
  assert.ok(p.some((x) => /touches paths that are never pushed \(secrets\/k\.key\)/.test(x)), p.join('\n'));
});

/** A tree written byte for byte, with no check of its names. */
function rawTree(dir: string, entries: [string, string, string][]) {
  const body = Buffer.concat(entries.map(([m, n, s]) => Buffer.concat([Buffer.from(`${m} ${n}\0`), Buffer.from(s, 'hex')])));
  return g(dir, ['hash-object', '-t', 'tree', '-w', '--literally', '--stdin'], body);
}

test('a crafted tree with an empty name stops the push limits: git itself won\'t read it, so nothing is judged clean', () => {
  const r = repo();
  const secrets = mktree(r.dir, [nest(r.dir, ['secrets'], ['100644', 'blob', blob(r.dir, 'SECRET\n'), 'x.pem'])]);
  const head = commit(r.dir, rawTree(r.dir, [['40000', '', secrets], ['100644', 'README.md', r.readme]]), [r.base]);
  assert.throws(() => pushProblems(r.dir, r.base, head, LIMITS), /empty filename in tree entry/);
});

for (const segment of ['.', '..', '.git', '.GIT']) {
  test(`a crafted tree whose path has a "${segment}" part is refused, never matched as another name`, () => {
    const r = repo();
    const secrets = mktree(r.dir, [nest(r.dir, ['secrets'], ['100644', 'blob', blob(r.dir, 'SECRET\n'), 'x.pem'])]);
    const tree = rawTree(r.dir, [['100644', 'README.md', r.readme], ['40000', segment, secrets]].sort((a, b) => (a[1]! < b[1]! ? -1 : 1)) as [string, string, string][]);
    const head = commit(r.dir, tree, [r.base]);
    const p = pushProblems(r.dir, r.base, head, LIMITS);
    assert.ok(p.some((x) => /has paths no checkout would write/.test(x)), p.join('\n'));
  });
}

test('a replace ref swapping a big blob for a small one doesn\'t get it past the size limit', () => {
  const r = repo();
  const big = blob(r.dir, `${'y'.repeat(3 * 1024 * 1024)}\n`);
  const head = commit(r.dir, mktree(r.dir, [['100644', 'blob', r.readme, 'README.md'], ['100644', 'blob', big, 'data.bin']]), [r.base]);
  const limits = { ...LIMITS, max_file_mb: 1 };
  assert.match(pushProblems(r.dir, r.base, head, limits).join('\n'), /over the 1 MB limit \(data\.bin/);
  g(r.dir, ['replace', big, blob(r.dir, 'small\n')]);
  assert.match(pushProblems(r.dir, r.base, head, limits).join('\n'), /over the 1 MB limit \(data\.bin/);
});
