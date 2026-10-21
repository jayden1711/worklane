// A release install can follow main (#895). A release install's engine is the tag's release commit: the main commit it
// was cut from plus dist/ only, so it is never on main and no main commit fast-forwards it. When, and only when, the
// release verifier proves the installed commit is such a release commit (a signed vX.Y.Z tag object that verifies
// against the allowed signers, names itself, and points at it; one parent, on main; a dist/-only diff), the main
// channel compares and walks main's first-parent line from that parent. Everything else on main is as before: green
// required checks, the first-parent line, the lookback, holds and rollback. Any doubt keeps the old refusal.
//
// Real git throughout: an origin with real signed, unsigned and lightweight tags, verified by the updater's own
// verifyRelease in a fresh clone, and GitHub's compare answered from the origin's own history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

type Verified = { ok: true; base: string; object: string; commit: string } | { ok: false; reason: string };
const u = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', 'worklane-update.cjs')) as {
  verifyRelease(repoUrl: string, tag: string, signers: string, exec: (f: string, a: string[]) => string, gitDir?: string): Verified;
  run(deps: object): Promise<string>;
};

const skip = process.platform === 'win32' && 'ssh signing in POSIX shells';
const URL = 'https://github.com/example-org/engine.git';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const exec = (file: string, args: string[]) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** An origin whose main starts at one commit, with release commits (main's commit plus dist/) tagged on top of it. */
function origin() {
  const dir = mkdtempSync(join(tmpdir(), 'r2m-origin-'));
  const key = join(dir, '..', `${dir.split(/[\\/]/).pop()}-key`);
  spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'release', '-f', key]);
  const other = `${key}-other`;
  spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'someone-else', '-f', other]);
  const signers = join(dir, '..', `${dir.split(/[\\/]/).pop()}-allowed_signers`);
  writeFileSync(signers, `owner@example.com namespaces="git" ${execFileSync('cat', [`${key}.pub`], { encoding: 'utf8' }).trim()}\n`);
  git(dir, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.name', 'Owner'], ['user.email', 'owner@example.com'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false'], ['gpg.format', 'ssh'], ['user.signingkey', key]]) git(dir, 'config', k!, v!);
  writeFileSync(join(dir, 'package.json'), '{"version":"1.0.0"}\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'main');
  const main = git(dir, 'rev-parse', 'HEAD');
  let n = 0;
  /** A release commit on `from` (main's first commit by default), dist/ only unless `extra`, tagged `tag` as `how` says. */
  const release = (tag: string | null, how: 'signed' | 'unsigned' | 'lightweight' | 'other-key' = 'signed', o: { extra?: boolean; from?: string } = {}) => {
    git(dir, 'checkout', '-q', '--detach', o.from ?? main);
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'cli.js'), `// ${tag ?? 'untagged'} ${n++}\n`);
    if (o.extra) writeFileSync(join(dir, 'README.md'), `changed ${n}\n`);
    git(dir, 'add', '-f', 'dist', ...(o.extra ? ['README.md'] : []));
    git(dir, 'commit', '-q', '-m', `Release ${tag ?? 'untagged'}`);
    if (tag && how === 'signed') git(dir, 'tag', '-s', tag, '-m', tag);
    else if (tag && how === 'other-key') git(dir, '-c', `user.signingkey=${other}`, 'tag', '-s', tag, '-m', tag);
    else if (tag && how === 'unsigned') git(dir, 'tag', '-a', tag, '-m', tag);
    else if (tag) git(dir, 'tag', tag);
    const commit = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'checkout', '-q', 'main');
    return commit;
  };
  /** One more commit on main; returns it. */
  const advance = (what: string) => {
    writeFileSync(join(dir, `${what}.txt`), `${what}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', what);
    return git(dir, 'rev-parse', 'HEAD');
  };
  /** A commit on a side branch off `from`, not on main (yet). */
  const side = (what: string, from = main) => {
    git(dir, 'checkout', '-q', '--detach', from);
    writeFileSync(join(dir, `${what}.txt`), `${what}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', what);
    const c = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'checkout', '-q', 'main');
    return c;
  };
  /** Merge `c` into main with a merge commit (main first parent, `c` second). */
  const merge = (c: string) => {
    git(dir, 'merge', '-q', '--no-ff', '-m', `merge ${c.slice(0, 7)}`, c);
    return git(dir, 'rev-parse', 'HEAD');
  };
  return { dir, signers, main, release, advance, side, merge };
}

/** GitHub's compare of a...b (status, counts, and the commits reachable from b and not from a, with parents), from the origin. */
function compare(dir: string, a: string, b: string) {
  const ahead = Number(git(dir, 'rev-list', '--count', `${a}..${b}`));
  const behind = Number(git(dir, 'rev-list', '--count', `${b}..${a}`));
  const status = ahead && behind ? 'diverged' : ahead ? 'ahead' : behind ? 'behind' : 'identical';
  const commits = git(dir, 'rev-list', '--reverse', '--parents', `${a}..${b}`)
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, ...parents] = l.split(' ');
      return { sha: sha!, parents: parents.map((p) => ({ sha: p })), commit: { committer: { date: git(dir, 'log', '-1', '--format=%cI', sha!) } } };
    });
  return { status, ahead_by: ahead, behind_by: behind, total_commits: commits.length, commits };
}

type Opts = {
  cfg?: Record<string, unknown>;
  verify?: (tag: string) => Verified;
  red?: string[];
  held?: { sha: string; at: string; failed: string[] } | null;
  signersHold?: { at: string; file: string; from: string; to: string; linesBefore: number; linesAfter: number; added: string[]; removed: string[] } | null;
  unhealthy?: boolean;
};

/** A machine whose engine is `installed`, following the origin's main. Real ls-remote and verifyRelease on the origin. */
function machine(o: ReturnType<typeof origin>, installed: string, opts: Opts = {}) {
  const calls: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const holds: Record<string, unknown>[] = [];
  let current = installed;
  let clock = Date.now();
  const verifyDir = join(mkdtempSync(join(tmpdir(), 'r2m-verify-')), 'v.git');
  const cfg = { enabled: true, repo_url: URL, branch: 'main', required_checks: ['test'], allowed_signers: o.signers, ...opts.cfg };
  const deps = {
    config: () => cfg,
    installed: () => current,
    installedVersion: () => '1.0.0',
    verifyRelease: (url: string, tag: string, signers: string) => {
      calls.push(`verify ${tag}`);
      assert.equal(url, URL);
      assert.equal(signers, o.signers, "updates.json's allowed_signers");
      return opts.verify ? opts.verify(tag) : u.verifyRelease(o.dir, tag, signers, exec, verifyDir);
    },
    exec: (file: string, args: string[]) => {
      calls.push([file, ...args].join(' ').slice(0, 120));
      if (file === 'git' && args[0] === 'ls-remote') return exec('git', args.map((a) => (a === URL ? o.dir : a)));
      if (file === 'systemctl' && args[0] === 'list-units') return 'worklane-x.service loaded active running x\n';
      if (file === 'systemctl' && args[0] === 'show') {
        return opts.unhealthy && current !== installed ? 'ActiveState=failed\nSubState=failed\nNRestarts=0\nResult=exit-code\n' : 'ActiveState=active\nSubState=running\nNRestarts=0\nResult=success\n';
      }
      return '';
    },
    fetchJson: async (url: string) => {
      const path = url.split('/repos/example-org/engine/')[1]!;
      calls.push(`fetch ${path}`);
      const c = /^compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(path);
      if (c) return compare(o.dir, c[1]!, c[2]!);
      const m = /^commits\/([0-9a-f]{40})\/check-runs/.exec(path);
      if (!m) return null;
      return { check_runs: [{ name: 'test', status: 'completed', conclusion: opts.red?.includes(m[1]!) ? 'failure' : 'success', started_at: '1', id: 1 }] };
    },
    slots: () => [],
    alive: () => false,
    installTree: (s: string) => calls.push(`installTree ${s}`),
    syncHelpers: (s: string) => (calls.push(`syncHelpers ${s}`), []),
    switchTo: (s: string) => {
      current = s;
      calls.push(`switchTo ${s}`);
    },
    now: () => clock,
    sleep: async (ms: number) => void (clock += ms),
    log: (e: Record<string, unknown>) => logs.push(e),
    held: () => opts.held ?? null,
    hold: (h: Record<string, unknown>) => holds.push(h),
    note: (event: string, s: string | null, reason: string) => (logs.push({ event, to: s, reason }), event),
    checked: () => {},
    ...(opts.signersHold !== undefined ? { signersHold: () => opts.signersHold } : {}),
  };
  const checked = () => calls.filter((c) => c.includes('/check-runs')).map((c) => c.split('/')[1]!);
  const built = () => calls.filter((c) => c.startsWith('systemd-run') || c.startsWith('installTree') || c.startsWith('switchTo'));
  const last = () => logs.filter((l) => typeof l.reason === 'string').at(-1) as { event: string; reason: string } | undefined;
  return { deps, calls, logs, holds, checked, built, last, current: () => current };
}

test('#895 a verified release install moves to a later green main commit, compared and walked from the main commit it was cut from', { skip }, async () => {
  const o = origin();
  const release = o.release('v1.0.0');
  const m1 = o.advance('one');
  const m2 = o.advance('two');
  const m = machine(o, release);
  assert.equal(await u.run(m.deps), 'installed');
  assert.equal(m.current(), m2, "main's newest green commit");
  assert.ok(m.calls.includes(`fetch compare/${release}...${m2}`), 'the installed commit is compared first, as before');
  assert.deepEqual(m.calls.filter((c) => c.startsWith('verify')), ['verify v1.0.0'], 'the release proven by the release verifier, by the tag that names it');
  assert.ok(m.calls.includes(`fetch compare/${o.main}...${m2}`), 'then main is compared from the release\'s main commit');
  assert.deepEqual(m.checked(), [m2], 'checks read on main\'s commit');
  const attempt = m.logs.find((l) => l.event === 'attempt')!;
  assert.equal(attempt.from, release, 'what is installed (and rolled back to) is the release commit');
  assert.equal(attempt.to, m2);
  assert.deepEqual(attempt.release, { tag: 'v1.0.0', base: o.main });
  assert.ok(!m.calls.some((c) => c.includes(m1) && c.includes('/check-runs')), 'the tip is green: nothing older is asked');
  // Afterwards the engine is a main commit: an ordinary main install, never asked about a release again.
  const m3 = o.advance('three');
  const before = m.calls.length;
  assert.equal(await u.run(m.deps), 'installed');
  assert.equal(m.current(), m3);
  const after = m.calls.slice(before);
  assert.ok(after.includes(`fetch compare/${m2}...${m3}`));
  assert.ok(!after.some((c) => c.startsWith('verify') || c.includes('ls-remote --tags')), 'no release proof once on main');
});

test('#895 refused, as before, with the verifier\'s reason: unsigned, lightweight and other-key tags, a tag object under another name, a non-dist diff, a parent not on main', { skip }, async () => {
  const o = origin();
  const unsigned = o.release('v1.0.1', 'unsigned');
  const lightweight = o.release('v1.0.2', 'lightweight');
  const otherKey = o.release('v1.0.3', 'other-key');
  const nonDist = o.release('v1.0.4', 'signed', { extra: true });
  const offMain = o.release('v1.0.5', 'signed', { from: o.side('not-merged') });
  // A signed tag object (v1.0.6's) published under another ref (v1.0.7), its own ref gone: it names itself v1.0.6.
  const renamed = o.release('v1.0.6');
  git(o.dir, 'tag', 'v1.0.7', 'v1.0.6');
  git(o.dir, 'tag', '-d', 'v1.0.6');
  o.advance('one');
  const cases: [string, string, RegExp][] = [
    ['unsigned', unsigned, /v1\.0\.1's signature doesn't verify against/],
    ['lightweight', lightweight, /v1\.0\.2 is a lightweight tag/],
    ['signed by a key not allowed', otherKey, /v1\.0\.3's signature doesn't verify against/],
    ['a release commit that changes more than dist/', nonDist, /v1\.0\.4's release commit changes more than dist\/: README\.md/],
    ['cut from a commit not on main', offMain, /v1\.0\.5 wasn't cut from main/],
    ['a signed tag object naming itself another tag', renamed, /v1\.0\.7's signed tag object names itself v1\.0\.6/],
  ];
  for (const [what, installed, why] of cases) {
    const m = machine(o, installed);
    assert.equal(await u.run(m.deps), 'refused', what);
    assert.match(m.last()!.reason, /^not a fast-forward of the installed engine \(GitHub compare: diverged, \d+ ahead, \d+ behind\)/, `${what}: today's refusal`);
    assert.match(m.last()!.reason, why, `${what}: the verifier's reason`);
    assert.deepEqual(m.built(), [], `${what}: nothing built or switched`);
    assert.equal(m.current(), installed);
  }
});

test('#895 refused: a tag naming another commit, an installed commit neither on main nor a release, a tag that moved, a held signers file, a branch other than main', { skip }, async () => {
  const o = origin();
  const tagged = o.release('v1.0.0');
  // dist/ only on main's commit, but no tag names it: a signed tag names another commit.
  const untagged = o.release(null);
  // Neither on main nor release-shaped, and untagged.
  const stray = o.side('stray');
  o.advance('one');
  for (const [what, installed] of [['a release-shaped commit no tag names (the signed tag names another)', untagged], ['a commit neither on main nor a release', stray]] as const) {
    const m = machine(o, installed);
    assert.equal(await u.run(m.deps), 'refused', what);
    assert.match(m.last()!.reason, /^not a fast-forward of the installed engine/);
    assert.match(m.last()!.reason, /no release tag vX\.Y\.Z on .* names it/);
    assert.deepEqual(m.calls.filter((c) => c.startsWith('verify')), [], `${what}: nothing to verify`);
    assert.deepEqual(m.built(), []);
  }
  // The tag moved between ls-remote and its verification: the object or commit verified isn't the one listed.
  const object = git(o.dir, 'rev-parse', 'refs/tags/v1.0.0');
  for (const v of [{ ok: true as const, base: o.main, object: 'f'.repeat(40), commit: tagged }, { ok: true as const, base: o.main, object, commit: 'e'.repeat(40) }]) {
    const m = machine(o, tagged, { verify: () => v });
    assert.equal(await u.run(m.deps), 'refused');
    assert.match(m.last()!.reason, /v1\.0\.0 moved between ls-remote and its verification/);
    assert.deepEqual(m.built(), []);
  }
  // A verifier that throws (git missing, a fetch cut off): refused, never an error that skips the refusal.
  const threw = machine(o, tagged, {
    verify: () => {
      throw new Error('git: not found');
    },
  });
  assert.equal(await u.run(threw.deps), 'refused');
  assert.match(threw.last()!.reason, /isn't a verified release commit: couldn't check the release tags: git: not found/);
  assert.deepEqual(threw.built(), []);
  // The signers file changed outside updates.sh and nobody acknowledged it: no tag signature is taken on its say-so.
  const hold = { at: '2026-10-20T00:00:00Z', file: o.signers, from: 'sha256:a', to: 'sha256:b', linesBefore: 1, linesAfter: 2, added: [], removed: [] };
  const held = machine(o, tagged, { signersHold: hold });
  assert.equal(await u.run(held.deps), 'refused');
  assert.match(held.last()!.reason, /the signers file changed outside updates\.sh/);
  assert.deepEqual(held.calls.filter((c) => c.startsWith('verify')), []);
  assert.deepEqual(held.built(), []);
  // Only main's own line: the verifier proves a parent on main, nothing about another branch.
  const branch = machine(o, tagged, { cfg: { branch: 'next' } });
  git(o.dir, 'branch', 'next', 'main');
  assert.equal(await u.run(branch.deps), 'refused');
  assert.match(branch.last()!.reason, /only when following main/);
  assert.deepEqual(branch.calls.filter((c) => c.startsWith('verify')), []);
  // The same verified release, unchanged, then moves (the refusals above were about the proof, not the setup).
  const ok = machine(o, tagged);
  assert.equal(await u.run(ok.deps), 'installed');
});

test('#895 an install already on main never consults the release verifier', { skip }, async () => {
  const o = origin();
  o.release('v1.0.0');
  const m1 = o.advance('one');
  const m2 = o.advance('two');
  const m = machine(o, m1);
  assert.equal(await u.run(m.deps), 'installed');
  assert.equal(m.current(), m2);
  assert.ok(!m.calls.some((c) => c.startsWith('verify') || c.includes('ls-remote --tags')));
});

test('#895 the first-parent line stops at the release\'s main commit: never its second parents, never the release, within the lookback', { skip }, async () => {
  const o = origin();
  const release = o.release('v1.0.0');
  const sideCommit = o.side('feature');
  const merged = o.merge(sideCommit);
  const tip = o.advance('tip');
  // The red tip is skipped for the merge commit; the merged branch's commit and the release's base are never asked.
  const m = machine(o, release, { red: [tip] });
  assert.equal(await u.run(m.deps), 'installed');
  assert.equal(m.current(), merged);
  assert.deepEqual(m.checked(), [tip, merged]);
  assert.ok(!m.checked().includes(sideCommit) && !m.checked().includes(o.main) && !m.checked().includes(release));
  assert.ok(m.logs.some((l) => l.event === 'chose' && l.from === release && l.to === merged));
  // max_lookback 1: only the tip, red, so nothing.
  const one = machine(o, release, { red: [tip], cfg: { max_lookback: 1 } });
  assert.equal(await u.run(one.deps), 'refused');
  assert.deepEqual(one.checked(), [tip]);
  assert.deepEqual(one.built(), []);
  // A held tip is passed over as on any main install.
  const held = machine(o, release, { held: { sha: tip, at: '2026-10-20T00:00:00Z', failed: ['x'] } });
  assert.equal(await u.run(held.deps), 'installed');
  assert.equal(held.current(), merged);
});

test('#895 main has not moved since the release was cut: up to date, nothing built', { skip }, async () => {
  const o = origin();
  const release = o.release('v1.0.0');
  const m = machine(o, release);
  assert.equal(await u.run(m.deps), 'current');
  assert.deepEqual(m.built(), []);
  assert.equal(m.current(), release);
});

test('#895 a crossing that fails its health check rolls back to the release commit and holds the main commit', { skip }, async () => {
  const o = origin();
  const release = o.release('v1.0.0');
  const m1 = o.advance('one');
  const m = machine(o, release, { unhealthy: true });
  assert.equal(await u.run(m.deps), 'rolled_back');
  assert.equal(m.current(), release, 'back on the release it came from');
  assert.ok(m.calls.includes(`syncHelpers ${release}`), "the release's helpers put back");
  assert.equal(m.holds.at(-1)!.sha, m1);
  const rolled = m.logs.find((l) => l.event === 'rolled_back')!;
  assert.deepEqual([rolled.from, rolled.to], [m1, release]);
});
