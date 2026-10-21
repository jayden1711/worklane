// Round 3 of #927: the push limits read one checked view of the history, whatever an agent does to the shared repo
// while they run, and the views git trusts that an agent can write (a shallow file, a commit-graph) can't hide a commit.
// - git reads a shallow file more loosely than an exact match: an uppercase id, text after the id, and a line over
//   1 KB each cut a range (measured on git 2.43 by the round-2 check), and the old check took them as "no cut";
// - a shallow file toggled every few ms beat the old before-and-after checks (23 of 150 runs; 5 of 80 pushes landed
//   the refused file, measured): every walk now reads one gitSnapshot, taken and checked once;
// - a forged commit-graph parent link made the walk skip the commit that added the file, and the push then landed it
//   (measured): the commit-graph is off for every git the engine runs, gitleaks' included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkedPush, DEFAULT_PUSH_LIMITS, pushProblems } from '../src/push-check.js';
import { findTool } from '../src/tool-path.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const LIMITS = { ...DEFAULT_PUSH_LIMITS, refuse_paths: ['**/*.pem'] };
const guard = { defaultBranch: 'main', blocked: () => undefined };
const TOKEN = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';

/** base, K (adds keys/secret.pem and a token), D (drops both), H (a note): the net diff is clean, the history isn't. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'push-snapshot-'));
  const work = join(root, 'work');
  const remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(root, 'init', '-q', '-b', 'main', work);
  for (const [k, v] of [['user.email', 'bot@example.com'], ['user.name', 'bot'], ['commit.gpgsign', 'false']]) git(work, 'config', k!, v!);
  writeFileSync(join(work, 'README.md'), 'hello\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'base');
  const base = git(work, 'rev-parse', 'HEAD');
  git(work, 'push', '-q', remote, 'main');
  mkdirSync(join(work, 'keys'));
  writeFileSync(join(work, 'keys', 'secret.pem'), 'k\n');
  writeFileSync(join(work, 'c.js'), `export const token = '${TOKEN}';\n`);
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'add a key');
  git(work, 'rm', '-q', 'keys/secret.pem', 'c.js');
  git(work, 'commit', '-q', '-m', 'drop it');
  const drop = git(work, 'rev-parse', 'HEAD');
  writeFileSync(join(work, 'notes.txt'), 'n\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'notes');
  const head = git(work, 'rev-parse', 'HEAD');
  return { work, remote, base, drop, head, shallow: join(work, '.git', 'shallow') };
}

const keyFound = (p: string[]) => p.some((x) => /keys\/secret\.pem/.test(x));
const pushedKey = (remote: string, head: string) => {
  try {
    git(remote, 'cat-file', '-e', `${head}~2:keys/secret.pem`);
    return true;
  } catch {
    return false;
  }
};

// ---- The shallow file, read at least as loosely as git reads it.

for (const [what, line] of [
  ['an uppercase id', (id: string) => id.toUpperCase()],
  ['text right after the id', (id: string) => `${id}zz`],
  ['a word after the id', (id: string) => `${id} comment`],
  ['a line over 1 KB', (id: string) => `${id}${' '.repeat(1100)}x`],
] as const) {
  test(`a shallow file line with ${what} is refused, never read as "no cut"`, () => {
    const r = repo();
    writeFileSync(r.shallow, `${line(r.drop)}\n`);
    const p = pushProblems(r.work, r.base, r.head, LIMITS);
    assert.equal(p.length, 1, p.join('\n'));
    assert.match(p[0]!, /history is cut inside the range \(its shallow file has a line that isn't exactly a full lowercase object id/);
  });
}

// ---- One snapshot for every walk: a shallow file written mid-check changes nothing.

/** Runs `fn` with node:child_process's execFileSync wrapped: `during(args)` runs before each call it is handed. */
async function withExecHook<T>(during: (args: string[]) => (() => void) | void, fn: () => T): Promise<T> {
  const cp = createRequire(import.meta.url)('node:child_process') as Record<string, (...a: unknown[]) => unknown>;
  const orig = cp.execFileSync!;
  cp.execFileSync = (...a: unknown[]) => {
    const after = during(Array.isArray(a[1]) ? a[1].map(String) : []);
    try {
      return orig(...a);
    } finally {
      after?.();
    }
  };
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    cp.execFileSync = orig;
    syncBuiltinESMExports();
  }
}

/** A cut at D written into the repo while the range's `log` walk runs, and removed again as soon as it ends. */
const toggleDuringLog = (r: ReturnType<typeof repo>) => (args: string[]) => {
  if (!(args.includes('log') && args.includes('--name-only'))) return;
  writeFileSync(r.shallow, `${r.drop}\n`);
  return () => rmSync(r.shallow, { force: true });
};

test('a shallow file written while the walks run, and removed before they end, can\'t hide the key from pushProblems', async () => {
  const r = repo();
  const p = await withExecHook(toggleDuringLog(r), () => pushProblems(r.work, r.base, r.head, LIMITS));
  assert.ok(keyFound(p), p.join('\n'));
  assert.ok(!existsSync(r.shallow));
});

test('the same toggle can\'t get checkedPush to land the key on the remote', async () => {
  const r = repo();
  const res = await withExecHook(toggleDuringLog(r), () => checkedPush({ cwd: r.work, remote: r.remote, base: r.base, head: r.head, ref: 'refs/heads/task', limits: LIMITS, guard, force: true }));
  assert.ok(!res.ok && 'refused' in res && keyFound(res.refused), JSON.stringify(res));
  assert.equal(pushedKey(r.remote, r.head), false);
});

// ---- A forged commit-graph.

/** Writes the repo's commit-graph, then makes it say D's first parent is the base: K, which added the key, is skipped. */
function forgeGraph(r: ReturnType<typeof repo>) {
  git(r.work, 'commit-graph', 'write', '--reachable', '--no-progress');
  const file = join(r.work, '.git', 'objects', 'info', 'commit-graph');
  const buf = Buffer.from(readFileSync(file));
  const chunks: Record<string, number> = {};
  for (let i = 0; i < buf[6]!; i++) {
    const o = 8 + i * 12;
    chunks[buf.toString('latin1', o, o + 4)] = Number(buf.readBigUInt64BE(o + 4));
  }
  const n = buf.readUInt32BE(chunks.OIDF! + 255 * 4);
  const idx = (hex: string) => [...Array(n).keys()].find((i) => buf.toString('hex', chunks.OIDL! + i * 20, chunks.OIDL! + i * 20 + 20) === hex)!;
  buf.writeUInt32BE(idx(r.base), chunks.CDAT! + idx(r.drop) * 36 + 20);
  createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest().copy(buf, buf.length - 20);
  chmodSync(file, 0o644);
  writeFileSync(file, buf);
  // Plain git now believes it.
  assert.equal(git(r.work, 'rev-list', `${r.base}..${r.head}`).split('\n').length, 2, 'the forged graph hides K from plain git');
}

test('a forged commit-graph parent link can\'t hide the key from pushProblems or let checkedPush land it', () => {
  const r = repo();
  forgeGraph(r);
  assert.ok(keyFound(pushProblems(r.work, r.base, r.head, LIMITS)));
  const res = checkedPush({ cwd: r.work, remote: r.remote, base: r.base, head: r.head, ref: 'refs/heads/task', limits: LIMITS, guard, force: true });
  assert.ok(!res.ok && 'refused' in res && keyFound(res.refused), JSON.stringify(res));
  assert.equal(pushedKey(r.remote, r.head), false);
});

test('gitleaks, which runs git itself, reads past a forged commit-graph too', { skip: !findTool('gitleaks') && 'gitleaks not installed' }, async () => {
  const { scanRange } = await import('../src/scan/secrets.js');
  const r = repo();
  assert.equal((await scanRange(r.work, `${r.base}..${r.head}`)).status, 'leaks');
  forgeGraph(r);
  assert.equal((await scanRange(r.work, `${r.base}..${r.head}`)).status, 'leaks');
});

test('gitleaks under a shallow cut inside the range is never "clean"; a ref name in the range still works', { skip: !findTool('gitleaks') && 'gitleaks not installed' }, async () => {
  const { scanRange } = await import('../src/scan/secrets.js');
  const r = repo();
  assert.equal((await scanRange(r.work, `${r.base}..HEAD`)).status, 'leaks');
  writeFileSync(r.shallow, `${r.drop}\n`);
  const cut = await scanRange(r.work, `${r.base}..${r.head}`);
  assert.equal(cut.status, 'unavailable', JSON.stringify(cut));
});
