import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { MANAGED_APPS_FILE, readLockScope, readManagedApps } from '../src/managed-apps.js';
import { lockScopeOf } from '../src/coordinator/shared.js';
import { evalLevel } from '../src/coordinator/eval-routing.js';
import { ReviewConfig } from '../src/config/schema.js';
import { repoRoot } from './helpers.js';
import { onRealMachine } from './isolate.js';

const posix = process.platform !== 'win32';
const me = typeof process.getuid === 'function' ? process.getuid() : 0;
const setup = join(repoRoot, 'scripts', 'setup');
const dir = () => mkdtempSync(join(tmpdir(), 'managed-apps-'));
/** Root's file as the script writes it, this user's (who stands in for root here), 0644. */
const rootFile = (body: string, mode = 0o644) => {
  const f = join(dir(), 'managed-apps.json');
  writeFileSync(f, body, { mode });
  chmodSync(f, mode);
  return f;
};
const scope = (file: string, instance = 'shop', repo = 'example-org/shop') => readLockScope(instance, repo, { file, rootUid: me });

test("root's managed apps file is the engine's /etc path, and the setup scripts write that one", () => {
  assert.equal(onRealMachine(MANAGED_APPS_FILE()), `/etc/${BRAND.cli}/managed-apps.json`);
  const lib = readFileSync(join(setup, 'lib.sh'), 'utf8');
  assert.match(lib, new RegExp(`^MANAGED_APPS=${onRealMachine(MANAGED_APPS_FILE()).replace(/[.]/g, '\\.')}$`, 'm'));
});

test("a managed app only where root's file names the instance with exactly its repo; anything else is the engine's (every lock)", { skip: !posix && 'owners and modes' }, () => {
  const good = rootFile('{"version":1,"apps":{"shop":"example-org/shop","docs-site":"example-org/site"}}\n');
  assert.deepEqual(readManagedApps(good, me), { apps: { shop: 'example-org/shop', 'docs-site': 'example-org/site' }, problem: null });
  assert.equal(scope(good).scope, 'managed-app');
  assert.equal(scope(good, 'shop', 'Example-Org/Shop').scope, 'managed-app', 'GitHub names compare without case');
  assert.match(scope(good).why, /is a managed app, not the engine/);
  // Not this instance, or not this repo: the engine's.
  assert.equal(scope(good, 'blog').scope, 'engine');
  assert.match(scope(good, 'shop', 'example-org/engine').why, /names instance shop for example-org\/shop, not example-org\/engine/);
  assert.equal(scope(good, 'constructor').scope, 'engine', 'only its own names');
  // No file: the engine's, and that's not a problem with the file.
  const none = join(dir(), 'managed-apps.json');
  assert.deepEqual(readManagedApps(none, me), { apps: {}, problem: null });
  assert.equal(scope(none).scope, 'engine');
});

test("a managed apps file root can't vouch for, or not in the script's form, names no app: every lock applies", { skip: !posix && 'owners and modes' }, () => {
  const body = '{"version":1,"apps":{"shop":"example-org/shop"}}\n';
  const cases: [string, string, RegExp][] = [
    ['group-writable', rootFile(body, 0o664), /isn't root's alone/],
    ['world-writable', rootFile(body, 0o666), /isn't root's alone/],
    ['not JSON', rootFile('{'), /not JSON/],
    ['another version', rootFile('{"version":2,"apps":{"shop":"example-org/shop"}}'), /not in the form/],
    ['an extra key', rootFile('{"version":1,"apps":{"shop":"example-org/shop"},"engine":"x"}'), /not in the form/],
    ['apps a list', rootFile('{"version":1,"apps":["shop"]}'), /not in the form/],
    ['a bad instance name', rootFile('{"version":1,"apps":{"Shop!":"example-org/shop","shop":"example-org/shop"}}'), /not in the form/],
    ['a bad repo', rootFile('{"version":1,"apps":{"shop":"example-org/shop/x"}}'), /not in the form/],
    ['a repo not a string', rootFile('{"version":1,"apps":{"shop":1}}'), /not in the form/],
    ['too big', rootFile(`{"version":1,"apps":{"shop":"example-org/shop"}}${' '.repeat(70 * 1024)}`), /too-big/],
  ];
  const link = join(dir(), 'managed-apps.json');
  symlinkSync(rootFile(body), link);
  cases.push(['a symlink', link, /symlink/]);
  const folder = join(dir(), 'managed-apps.json');
  mkdirSync(folder);
  cases.push(['a directory', folder, /not-file|missing/]);
  for (const [what, file, why] of cases) {
    const r = readManagedApps(file, me);
    assert.deepEqual(r.apps, {}, what);
    assert.match(r.problem ?? '', why, what);
    const s = scope(file);
    assert.equal(s.scope, 'engine', what);
    assert.match(s.why, /^every self-modification lock applies/, what);
  }
  // A file this user owns is not root's: as root's file, it names nothing.
  if (me !== 0) assert.equal(readLockScope('shop', 'example-org/shop', { file: rootFile(body), rootUid: 0 }).scope, 'engine');
});

test("the coordinator's lock scope: the engine's when it is given none, or asking for it fails", () => {
  assert.equal(lockScopeOf({}), 'engine');
  assert.equal(lockScopeOf({ lockScope: () => 'managed-app' }), 'managed-app');
  assert.equal(lockScopeOf({ lockScope: () => { throw new Error('EACCES'); } }), 'engine');
  // The evaluator's routing level follows it: the app's own src/contract.ts is app code there, the guard otherwise.
  const review = ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: [] }, L1_evaluator: { when: ['app-non-money'] }, L2_notify: { when: [] }, L3_human: { when: [] } } });
  const routed = (s?: 'engine' | 'managed-app') => evalLevel({ files: [{ path: 'src/contract.ts', added: 1, removed: 0, addedLines: ['export const terms = 1;'], removedLines: [] }], labels: [], moneyPaths: () => [], review, tampered: [], ...(s ? { scope: s } : {}) });
  assert.equal(routed('managed-app'), 'L1');
  assert.equal(routed('engine'), 'L3');
  assert.equal(routed(), 'L3');
});

/** lib.sh's managed-apps functions, as root would run them, with chown a stand-in that records what it was asked. */
function libSh() {
  const d = dir();
  const bin = join(d, 'bin');
  const etc = join(d, 'etc');
  for (const x of [bin, etc]) mkdirSync(x);
  const chownLog = join(d, 'chown.log');
  writeFileSync(join(bin, 'chown'), `#!/bin/sh\necho "$*" >> "${chownLog}"\n`);
  chmodSync(join(bin, 'chown'), 0o755);
  const file = join(etc, 'managed-apps.json');
  const updates = join(etc, 'updates.json');
  const run = (...args: string[]) => spawnSync('bash', ['-c', 'umask 000; source "$1"; shift; install_managed_apps "$@"', '_', join(setup, 'lib.sh'), file, ...args], { encoding: 'utf8', env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` } });
  return { file, updates, chownLog, run };
}

test('managed-apps.sh writes root:root 0644 in exactly the form the engine reads; it refuses a bad name or repo, a file not in its form, and the repo the engine updates from', { skip: !posix && 'bash' }, () => {
  const s = libSh();
  writeFileSync(s.updates, `${JSON.stringify({ enabled: false, repo_url: 'https://github.com/Example-Org/Engine.git', branch: 'main' })}\n`);
  let r = s.run('add', 'shop', 'example-org/shop', s.updates);
  assert.equal(r.status, 0, r.stderr);
  r = s.run('add', 'docs-site', 'example-org/site', s.updates);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(s.file, 'utf8'), '{"version":1,"apps":{"docs-site":"example-org/site","shop":"example-org/shop"}}\n');
  assert.equal((statSync(s.file).mode & 0o777).toString(8), '644', 'set, not inherited from umask 000');
  assert.deepEqual([...new Set(readFileSync(s.chownLog, 'utf8').trim().split('\n'))], [`root:root ${join(dirname(s.file), '.managed-apps.json.tmp')}`], 'root:root, on the temp file before it is moved into place');
  assert.equal(readLockScope('shop', 'example-org/shop', { file: s.file, rootUid: me }).scope, 'managed-app', 'the engine reads what the script wrote');
  const before = readFileSync(s.file, 'utf8');
  // The engine's own repo (updates.json's), in any case or URL form: never a managed app.
  for (const repo of ['example-org/engine', 'Example-Org/Engine']) {
    const e = s.run('add', 'engine', repo, s.updates);
    assert.equal(e.status, 2, `${repo}: ${e.stderr}`);
    assert.match(e.stderr, /the repo the engine on this machine updates from/);
  }
  writeFileSync(s.updates, `${JSON.stringify({ repo_url: 'https://github.com/example-org/engine/' })}\n`);
  assert.equal(s.run('add', 'engine', 'example-org/engine', s.updates).status, 2);
  // Bad names and repos.
  for (const [name, repo] of [['Shop', 'example-org/shop'], ['hub', 'example-org/shop'], ['shop', 'example-org'], ['shop', 'example-org/shop/x'], ['shop', '-x/shop']]) {
    const e = s.run('add', name!, repo!, s.updates);
    assert.equal(e.status, 2, `${name} ${repo}: ${e.stderr}`);
  }
  assert.equal(readFileSync(s.file, 'utf8'), before, 'a refusal changes nothing');
  // remove takes one back (and again is nothing to do).
  for (let i = 0; i < 2; i++) assert.equal(s.run('remove', 'shop').status, 0);
  assert.equal(readFileSync(s.file, 'utf8'), '{"version":1,"apps":{"docs-site":"example-org/site"}}\n');
  assert.equal(readLockScope('shop', 'example-org/shop', { file: s.file, rootUid: me }).scope, 'engine');
  // A file not in its form: it stops, changing nothing.
  writeFileSync(s.file, '{"version":1,"apps":{"shop":"example-org/shop"},"note":"x"}\n');
  const bad = s.run('add', 'blog', 'example-org/blog', s.updates);
  assert.equal(bad.status, 2, bad.stderr);
  assert.match(bad.stderr, /not in the form managed-apps\.sh writes/);
});

test('managed-apps.sh: only a root shell changes the file, never a coordinator, and show reads without root', () => {
  const sh = readFileSync(join(setup, 'managed-apps.sh'), 'utf8');
  // add and remove go through root (as_root) and refuse a coordinator's sudo; show doesn't need root.
  assert.match(sh, /  add\|remove\)\n    as_root "\$@"\n    \[\[ "\$\{SUDO_USER:-\}" != wl-\* \]\] \|\| \{/);
  assert.ok(sh.indexOf('as_root') > sh.indexOf('  show)'), 'show runs before any as_root');
  assert.match(sh, /install_managed_apps "\$MANAGED_APPS" add "\$2" "\$3" "\$UPDATES_JSON"/);
  // No machine helper command reaches it (the helper's sudoers rule runs only the helper).
  assert.doesNotMatch(readFileSync(join(setup, 'machine-helper.sh'), 'utf8'), /managed-apps/);
  assert.doesNotMatch(readFileSync(join(repoRoot, 'scripts', 'machine', `${BRAND.cli}-machine.cjs`), 'utf8'), /managed-apps/);
});
