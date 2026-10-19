// #760: the root updater keeps itself in step with the engine it installs, from a signed release tag only. With
// stand-ins: temp directories for its paths, this user as "root" (owner: our uid; chown a no-op), real git and real
// ssh signatures for the verified source. The run-level order (only after a healthy release install, never on main
// or a rollback) is in test/engine-update.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

type Src = { version: string; tag: string; commit: string; bytes: Buffer };
type Result = { state: string; reason?: string; prev?: string; from: { version: string | null; sha256: string | null }; to: { version: string; sha256: string; tag: string } };
type Inspect = (f: string, max?: number) => { kind: string; uid?: number; mode?: number; bytes?: Buffer };
type Opts = { dest: string; prev: string; record: string; off: string; owner: number; chown: () => void; chmod?: (f: string, m: number) => void; exec?: (f: string, a: string[], o?: object) => unknown; inspect?: Inspect; src?: string; version?: string | null; print?: (l: string) => void };
const updaterSrc = join(repoRoot, 'scripts', 'machine', 'worklane-update.cjs');
const u = createRequire(import.meta.url)(updaterSrc) as {
  syncSelf(src: Src, o: Partial<Opts>): Result;
  verifiedUpdater(signers: string, tag: string, commit: string, exec: (f: string, a: string[]) => Buffer, gitDir?: string): { ok: true; version: string; tag: string; commit: string; bytes: Buffer } | { ok: false; reason: string };
  verifyRelease(repoUrl: string, tag: string, signers: string, exec: (f: string, a: string[]) => string, gitDir?: string): { ok: boolean; reason?: string };
  readRootFile: Inspect;
  setupBefore(o: Partial<Opts>): number;
  setupRecord(o: Partial<Opts>): void;
  SELF: string;
  SELF_PREV: string;
  SELF_RECORD: string;
  SELF_OFF: string;
  SELF_ROLLBACK: string;
};
const posix = process.platform === 'win32' && 'POSIX owners, modes and ssh signing';
const uid = process.getuid ? process.getuid() : 0;
const hash = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const OLD = '// the running updater\n';
const NEW = '// the release\'s updater\n';
const COMMIT = 'c'.repeat(40);

/** A machine's updater paths in a temp dir: the running updater (0755), its record, no .prev, no off switch. */
function box(record: object | null = { version: '0.5.0', sha256: hash(OLD) }) {
  const dir = mkdtempSync(join(tmpdir(), 'self-'));
  mkdirSync(join(dir, 'libexec'));
  mkdirSync(join(dir, 'etc'));
  const o: Opts = { dest: join(dir, 'libexec', 'worklane-update'), prev: join(dir, 'libexec', 'worklane-update.prev'), record: join(dir, 'updater.json'), off: join(dir, 'etc', 'updater-no-self-update'), owner: uid, chown: () => {} };
  writeFileSync(o.dest, OLD, { mode: 0o755 });
  chmodSync(o.dest, 0o755);
  if (record) writeFileSync(o.record, JSON.stringify(record), { mode: 0o644 });
  /** The running updater is still the old one, nothing kept, nothing left beside it. */
  const untouched = () => {
    assert.equal(readFileSync(o.dest, 'utf8'), OLD, 'the running updater is untouched');
    assert.equal(existsSync(o.prev), false, 'nothing kept: nothing was replaced');
    assert.deepEqual(readdirSync(join(dir, 'libexec')).filter((f) => f.startsWith('.')), [], 'no temp file left');
  };
  return { dir, o, untouched };
}
const release = (version: string, body = NEW): Src => ({ version, tag: `v${version}`, commit: COMMIT, bytes: Buffer.from(body) });

test('self-update: a newer verified release\'s updater replaces the running one atomically; the old one is kept as .prev (0755) and both versions and hashes are recorded', { skip: posix }, () => {
  const b = box();
  const r = u.syncSelf(release('0.5.1'), b.o);
  assert.equal(r.state, 'updated', r.reason);
  assert.equal(readFileSync(b.o.dest, 'utf8'), NEW);
  assert.equal(statSync(b.o.dest).mode & 0o7777, 0o755);
  // The previous copy, for a manual rollback.
  assert.equal(readFileSync(b.o.prev, 'utf8'), OLD);
  assert.equal(statSync(b.o.prev).mode & 0o7777, 0o755);
  assert.equal(r.prev, b.o.prev);
  assert.deepEqual([r.from.version, r.from.sha256, r.to.version, r.to.sha256, r.to.tag], ['0.5.0', hash(OLD), '0.5.1', hash(NEW), 'v0.5.1']);
  const rec = JSON.parse(readFileSync(b.o.record, 'utf8')) as Record<string, unknown>;
  assert.deepEqual([rec.version, rec.sha256, rec.tag, rec.commit, rec.previous], ['0.5.1', hash(NEW), 'v0.5.1', COMMIT, { version: '0.5.0', sha256: hash(OLD) }]);
  assert.deepEqual(readdirSync(join(b.dir, 'libexec')).filter((f) => f.startsWith('.')), [], 'no temp file left');
  // The same release again: nothing to do.
  assert.equal(u.syncSelf(release('0.5.1'), b.o).state, 'same');
  // The fixed paths and the rollback command.
  assert.deepEqual([u.SELF, u.SELF_PREV, u.SELF_RECORD, u.SELF_OFF], ['/usr/local/libexec/worklane-update', '/usr/local/libexec/worklane-update.prev', '/var/lib/worklane/updater.json', '/etc/worklane/updater-no-self-update']);
  assert.equal(u.SELF_ROLLBACK, 'sudo install -o root -g root -m 0755 /usr/local/libexec/worklane-update.prev /usr/local/libexec/worklane-update');
});

test('self-update: never a downgrade: a release older than, or equal to, the running updater\'s recorded version is refused (versions, not hashes)', { skip: posix }, () => {
  for (const v of ['0.4.9', '0.5.0']) {
    const b = box();
    const r = u.syncSelf(release(v), b.o);
    assert.equal(r.state, 'refused', v);
    assert.match(r.reason!, new RegExp(`v${v.replace(/\./g, '\\.')}'s updater \\(${v.replace(/\./g, '\\.')}\\) isn't newer than the running one \\(0\\.5\\.0\\)`));
    b.untouched();
  }
  // An engine rollback after a self-update: the older release's updater is refused too.
  const b = box();
  assert.equal(u.syncSelf(release('0.5.1'), b.o).state, 'updated');
  const back = u.syncSelf(release('0.5.0', OLD), b.o);
  assert.equal(back.state, 'refused');
  assert.equal(readFileSync(b.o.dest, 'utf8'), NEW);
  // A running updater whose version isn't recorded (none, or a record of another file) is never replaced.
  for (const rec of [null, { version: '0.1.0', sha256: hash('another file') }, { version: 'x', sha256: hash(OLD) }]) {
    const c = box(rec);
    const r = u.syncSelf(release('9.9.9'), c.o);
    assert.equal(r.state, 'refused');
    assert.match(r.reason!, /the running updater's version isn't known/);
    c.untouched();
  }
});

test('self-update: root\'s off switch is honoured, and anything at its path keeps it off (fail closed)', { skip: posix }, () => {
  const b = box();
  writeFileSync(b.o.off, '', { mode: 0o644 });
  const r = u.syncSelf(release('0.5.1'), b.o);
  assert.equal(r.state, 'off');
  assert.match(r.reason!, /self-update is off \(.*updater-no-self-update, root's switch\)/);
  b.untouched();
  const s = box();
  symlinkSync(join(s.dir, 'nowhere'), s.o.off);
  const sr = u.syncSelf(release('0.5.1'), s.o);
  assert.equal(sr.state, 'off');
  assert.match(sr.reason!, /is a symlink; self-update stays off until root removes it/);
  s.untouched();
  // Default on: no flag, it updates.
  assert.equal(u.syncSelf(release('0.5.1'), box().o).state, 'updated');
});

test('self-update: a new updater that fails node --check, or has the wrong owner, mode or type, or is a symlink, leaves the running one untouched and says why', { skip: posix }, () => {
  const tmpOf = (o: Opts) => join(o.dest, '..', '.worklane-update.new.cjs');
  const realCheck = (f: string, a: string[], o?: object) => execFileSync(f, a, o);
  const cases: [string, (o: Opts) => Partial<Opts>, RegExp, string?][] = [
    ['node --check', () => ({}), /node --check failed/, 'this is { not javascript\n'],
    ['wrong owner', (o) => ({ inspect: (f: string, m?: number) => (f === tmpOf(o) ? { ...u.readRootFile(f, m), uid: uid + 1 } : u.readRootFile(f, m)) }), /is owned by uid \d+, not \d+/],
    ['wrong mode', () => ({ chmod: (f: string) => chmodSync(f, 0o775) }), /writable by group or others \(mode 775\)/],
    ['mode 700', () =>({ chmod: (f: string) => chmodSync(f, 0o700) }), /has mode 700, not 755/],
    ['a symlink', (o) => ({ exec: (f: string, a: string[], x?: object) => (realCheck(f, a, x), rmSync(tmpOf(o)), symlinkSync(o.dest, tmpOf(o))) }), /is a symlink/],
    ['a directory', (o) => ({ exec: (f: string, a: string[], x?: object) => (realCheck(f, a, x), rmSync(tmpOf(o)), mkdirSync(tmpOf(o))) }), /is not a regular file/],
    ['other bytes', (o) => ({ exec: (f: string, a: string[], x?: object) => (realCheck(f, a, x), writeFileSync(tmpOf(o), '// swapped\n')) }), /isn't the bytes written/],
  ];
  for (const [what, over, why, body] of cases) {
    const b = box();
    const r = u.syncSelf(release('0.5.1', body), { ...b.o, ...over(b.o) });
    assert.equal(r.state, 'refused', what);
    assert.match(r.reason!, /^the new updater wasn't installed, the running one is as it was: /, what);
    assert.match(r.reason!, why, what);
    assert.equal(readFileSync(b.o.dest, 'utf8'), OLD, `${what}: the running updater is untouched`);
    assert.equal(existsSync(b.o.prev), false, `${what}: nothing replaced, nothing kept`);
    if (what !== 'a directory') assert.deepEqual(readdirSync(join(b.dir, 'libexec')).filter((f) => f.startsWith('.')), [], `${what}: no temp file left`);
  }
  // The running updater itself not root's regular file: never replaced.
  const s = box();
  renameSync(s.o.dest, `${s.o.dest}.real`);
  symlinkSync(`${s.o.dest}.real`, s.o.dest);
  const sr = u.syncSelf(release('0.5.1'), s.o);
  assert.equal(sr.state, 'refused');
  assert.match(sr.reason!, /is a symlink; not replacing it/);
});

// ---------- the verified source: real git, real ssh signatures ----------

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const bufExec = (f: string, a: string[]) => execFileSync(f, a, { stdio: ['ignore', 'pipe', 'pipe'] });
const strExec = (f: string, a: string[]) => execFileSync(f, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** An origin whose main has the updater, and release commits on it (dist/ only) tagged signed or unsigned. */
function origin() {
  const dir = mkdtempSync(join(tmpdir(), 'self-origin-'));
  const keys = mkdtempSync(join(tmpdir(), 'self-keys-'));
  const key = join(keys, 'release');
  spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'release', '-f', key]);
  const signers = join(keys, 'allowed_signers');
  writeFileSync(signers, `owner@example.com namespaces="git" ${readFileSync(`${key}.pub`, 'utf8').trim()}\n`);
  git(dir, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.name', 'Owner'], ['user.email', 'owner@example.com'], ['commit.gpgsign', 'false'], ['gpg.format', 'ssh'], ['user.signingkey', key]]) git(dir, 'config', k!, v!);
  mkdirSync(join(dir, 'scripts', 'machine'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'machine', 'worklane-update.cjs'), NEW);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'main');
  const main = git(dir, 'rev-parse', 'HEAD');
  const tag = (name: string, signed: boolean) => {
    git(dir, 'checkout', '-q', '--detach', main);
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'cli.js'), `// ${name}\n`);
    git(dir, 'add', '-f', 'dist');
    git(dir, 'commit', '-q', '-m', `Release ${name}`);
    git(dir, 'tag', signed ? '-s' : '-a', name, '-m', name);
    const commit = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'checkout', '-q', 'main');
    return commit;
  };
  /** The root-owned clone the updater verifies in, fetched as verifyRelease fetches it. */
  const clone = (name: string) => {
    const gitDir = join(mkdtempSync(join(tmpdir(), 'self-verify-')), 'v.git');
    u.verifyRelease(dir, name, signers, strExec, gitDir);
    return gitDir;
  };
  return { dir, signers, tag, clone };
}

test('the verified source: only a release tag whose signature verifies, pointing at the engine just installed and naming itself, gives an updater; an unverified one is refused', { skip: posix }, () => {
  const o = origin();
  const signed = o.tag('v0.5.1', true);
  const unsigned = o.tag('v0.5.2', false);
  const gitDir = o.clone('v0.5.1');
  const good = u.verifiedUpdater(o.signers, 'v0.5.1', signed, bufExec, gitDir);
  assert.equal(good.ok, true, (good as { reason?: string }).reason);
  assert.deepEqual(good.ok && [good.version, good.tag, good.commit, good.bytes.toString()], ['0.5.1', 'v0.5.1', signed, NEW], 'from the tag\'s commit, in the verified clone');
  // Unsigned: refused, and syncSelf is never reached (realDeps.selfUpdate passes only an ok source).
  const bad = u.verifiedUpdater(o.signers, 'v0.5.2', unsigned, bufExec, o.clone('v0.5.2'));
  assert.equal(bad.ok, false);
  assert.match((bad as { reason: string }).reason, /v0\.5\.2's signature doesn't verify against/);
  // No signers file, or another commit than the one installed: refused.
  assert.match((u.verifiedUpdater(join(o.dir, 'none'), 'v0.5.1', signed, bufExec, gitDir) as { reason: string }).reason, /no allowed signers file/);
  assert.match((u.verifiedUpdater(o.signers, 'v0.5.1', 'd'.repeat(40), bufExec, gitDir) as { reason: string }).reason, /v0\.5\.1 points at .{7}, not at the engine just installed \(ddddddd\)/);
  // A signed tag object put under a higher version's name: its signature verifies, but it names itself v0.5.1.
  git(o.dir, 'update-ref', 'refs/tags/v9.9.9', git(o.dir, 'rev-parse', 'refs/tags/v0.5.1'));
  const renamed = u.verifiedUpdater(o.signers, 'v9.9.9', signed, bufExec, o.clone('v9.9.9'));
  assert.equal(renamed.ok, false);
  assert.match((renamed as { reason: string }).reason, /v9\.9\.9's signed tag object names itself v0\.5\.1/);
});

test('updates.sh\'s steps: never over a newer updater taken from a release; otherwise the installed one kept as .prev and the new one recorded', { skip: posix }, () => {
  // A checkout: scripts/machine/worklane-update.cjs and package.json two levels up.
  const checkout = mkdtempSync(join(tmpdir(), 'self-checkout-'));
  mkdirSync(join(checkout, 'scripts', 'machine'), { recursive: true });
  const src = join(checkout, 'scripts', 'machine', 'worklane-update.cjs');
  writeFileSync(src, '// the checkout\'s updater\n');
  writeFileSync(join(checkout, 'package.json'), '{"version":"0.5.0"}\n');
  const said: string[] = [];
  const install = (o: Opts) => (writeFileSync(o.dest, readFileSync(src)), chmodSync(o.dest, 0o755));
  // The installed one came from release 0.5.1 (recorded): kept (3), nothing changed.
  const b = box({ version: '0.5.1', sha256: hash(OLD), tag: 'v0.5.1' });
  assert.equal(u.setupBefore({ ...b.o, src, print: (l) => said.push(l) }), 3);
  assert.match(said.at(-1)!, /^kept the installed updater: v0\.5\.1's \(0\.5\.1\), newer than this checkout's \(0\.5\.0\)\. To go back by hand: sudo install /);
  b.untouched();
  // An older or unrecorded one: replaced, the one it replaces kept, and the new one recorded with the checkout's version.
  for (const rec of [{ version: '0.4.0', sha256: hash(OLD) }, null]) {
    const c = box(rec);
    assert.equal(u.setupBefore({ ...c.o, src, print: (l) => said.push(l) }), 0);
    assert.equal(readFileSync(c.o.prev, 'utf8'), OLD);
    assert.equal(statSync(c.o.prev).mode & 0o7777, 0o755);
    install(c.o);
    u.setupRecord({ ...c.o, src });
    const r = JSON.parse(readFileSync(c.o.record, 'utf8')) as Record<string, unknown>;
    assert.deepEqual([r.version, r.sha256, r.source], ['0.5.0', hash(readFileSync(src)), 'updates.sh']);
  }
  // A first install: nothing to keep.
  const f = box(null);
  rmSync(f.o.dest);
  assert.equal(u.setupBefore({ ...f.o, src }), 0);
  assert.equal(existsSync(f.o.prev), false);
  // updates.sh runs both steps, with the record after /var/lib/worklane exists, and skips its install on a 3.
  const sh = readFileSync(join(repoRoot, 'scripts', 'setup', 'updates.sh'), 'utf8');
  assert.match(sh, /require\(process\.argv\[1\]\)\.setupBefore\(\)' "\$updater_steps" \|\| self_step=\$\?/);
  assert.match(sh, /if \[ "\$self_step" -eq 0 \]; then\n[\s\S]*?\nmv -f "\$tmp" \/usr\/local\/libexec\/worklane-update\n[\s\S]*?\nfi\n/);
  assert.ok(sh.indexOf('install -d -o root -g root -m 0755 /var/lib/worklane') < sh.indexOf('.setupRecord()'), 'the record is written once its directory exists');
});
