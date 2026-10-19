import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { MANAGED_APPS_FILE, engineRepos, githubRepoOf, readLockScope, readManagedApps } from '../src/managed-apps.js';
import { SYSTEM_ROOT_VAR, TEST_MACHINE_VAR, TEST_MARK_FILE, TEST_RUN_VAR, TEST_TOKEN_VAR, etcPath } from '../src/os/system-paths.js';
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
/**
 * Runs `fn` with `file` (a file, a symlink or a directory, as made here) as root's own managed apps file, under the
 * isolate's etc root, then takes it away. readLockScope reads that one alone (#747): it takes no file.
 */
function asRootsFile<T>(file: string, fn: () => T): T {
  const apps = MANAGED_APPS_FILE();
  mkdirSync(dirname(apps), { recursive: true });
  const st = lstatSync(file, { throwIfNoEntry: false });
  if (st?.isSymbolicLink()) symlinkSync(readlinkSync(file), apps);
  else if (st?.isDirectory()) mkdirSync(apps);
  else if (st) {
    writeFileSync(apps, readFileSync(file));
    chmodSync(apps, st.mode & 0o777);
  }
  try {
    return fn();
  } finally {
    rmSync(apps, { recursive: true, force: true });
  }
}
/** The lock scope with `file` as root's file. In a test process, this user stands in for root (managed-apps.ts rootUid). */
const scope = (file: string, instance = 'shop', repo = 'example-org/shop') => asRootsFile(file, () => readLockScope(instance, repo));
/** Root's updates.json as scripts/setup/updates.sh writes it: the repo the engine on this machine updates from. */
const ENGINE_UPDATES = `${JSON.stringify({ enabled: true, repo_url: 'https://github.com/example-org/engine.git', branch: 'main' })}\n`;
/** Runs `fn` with `body` as root's updates.json (under the isolate's etc root), then takes it away again. */
function withUpdates<T>(body: string, fn: () => T): T {
  const updates = etcPath('updates.json');
  mkdirSync(dirname(updates), { recursive: true });
  writeFileSync(updates, body);
  // As updates.sh leaves it: 0644 (this user stands in for root), whatever the umask.
  chmodSync(updates, 0o644);
  try {
    return fn();
  } finally {
    unlinkSync(updates);
  }
}

test("root's managed apps file is the engine's /etc path, and the setup scripts write that one", () => {
  assert.equal(onRealMachine(MANAGED_APPS_FILE()), `/etc/${BRAND.cli}/managed-apps.json`);
  const lib = readFileSync(join(setup, 'lib.sh'), 'utf8');
  assert.match(lib, new RegExp(`^MANAGED_APPS=${onRealMachine(MANAGED_APPS_FILE()).replace(/[.]/g, '\\.')}$`, 'm'));
});

test("a managed app only where root's file names the instance with exactly its repo; anything else is the engine's (every lock)", { skip: !posix && 'owners and modes' }, () => {
  const good = rootFile('{"version":1,"apps":{"shop":"example-org/shop","docs-site":"example-org/site"}}\n');
  assert.deepEqual(readManagedApps(good), { apps: { shop: 'example-org/shop', 'docs-site': 'example-org/site' }, problem: null });
  // Root's updates.json says which repo is the engine; only then is any repo an app.
  withUpdates(ENGINE_UPDATES, () => {
    assert.equal(scope(good).scope, 'managed-app');
    assert.equal(scope(good, 'shop', 'Example-Org/Shop').scope, 'managed-app', 'GitHub names compare without case');
    assert.match(scope(good).why, /is a managed app, not the engine/);
  });
  // Not this instance, or not this repo: the engine's.
  assert.equal(scope(good, 'blog').scope, 'engine');
  assert.match(scope(good, 'shop', 'example-org/engine').why, /names instance shop for example-org\/shop, not example-org\/engine/);
  assert.equal(scope(good, 'constructor').scope, 'engine', 'only its own names');
  // No file: the engine's, and that's not a problem with the file.
  const none = join(dir(), 'managed-apps.json');
  assert.deepEqual(readManagedApps(none), { apps: {}, problem: null });
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
    const r = readManagedApps(file);
    assert.deepEqual(r.apps, {}, what);
    assert.match(r.problem ?? '', why, what);
    const s = scope(file);
    assert.equal(s.scope, 'engine', what);
    assert.match(s.why, /^every self-modification lock applies/, what);
  }
  // A file this user owns, outside a test process, is not root's: see "outside a test process" below.
});

// WHY (#747): the engine's repo pattern said it took a repo "as lib.sh repo_ok takes it", but it took '.', '..' and
// owners longer than GitHub's 39 characters, which repo_ok refuses. Both now run on the same strings and agree.
test("root's file takes exactly the repos lib.sh repo_ok takes", { skip: !posix && 'bash' }, () => {
  const repos = [
    'example-org/shop', 'a/b', 'example-org/site.github.io', 'example-org/.git', 'example-org/...', 'example-org/_x',
    'example-org/.', 'example-org/..', 'example-org', 'example-org/', '/shop', 'example-org/shop/x', 'example-org/a b',
    '-x/shop', 'x-/shop', 'a--b/shop', 'bad_owner/shop',
    `${'a'.repeat(39)}/shop`, `${'a'.repeat(40)}/shop`, `${'a-'.repeat(19)}a/shop`, `${'a-'.repeat(20)}a/shop`,
    `example-org/${'n'.repeat(100)}`, `example-org/${'n'.repeat(101)}`,
  ];
  for (const repo of repos) {
    const sh = spawnSync('bash', ['-c', 'source "$1"; repo_ok "$2"', '_', join(setup, 'lib.sh'), repo], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    assert.ok(sh.status === 0 || sh.status === 1, `${repo}: ${sh.stderr}`);
    const read = readManagedApps(rootFile(`${JSON.stringify({ version: 1, apps: { shop: repo } })}\n`));
    assert.equal(read.problem === null, sh.status === 0, `${repo}: repo_ok ${sh.status === 0 ? 'takes' : 'refuses'} it; the engine ${read.problem ?? 'takes it'}`);
  }
});

// WHY (#665 review): root marking the engine's own repo as an app (a slip at add, a hand edit) turned the in-code
// engine-source locks off for it. The reader itself refuses that repo, and every app when it can't tell which it is.
test("the engine's own repo is never a managed app, whatever root's file says: the installed package.json's repository, and updates.json's repo_url", { skip: !posix && 'owners and modes' }, () => {
  const naming = (inst: string, repo: string) => rootFile(`${JSON.stringify({ version: 1, apps: { [inst]: repo } })}\n`);
  const pkgUrl = (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { repository: { url: string } }).repository.url;
  const own = githubRepoOf(pkgUrl);
  assert.ok(own, `the engine's package.json names its GitHub repo: ${pkgUrl}`);
  for (const repo of [own, own.toUpperCase()]) {
    const s = withUpdates(ENGINE_UPDATES, () => scope(naming('engine', repo), 'engine', repo));
    assert.equal(s.scope, 'engine', repo);
    assert.match(s.why, /is the engine's own repo/, repo);
  }
  // No updates.json: which repo the engine updates from can't be told, so no repo is an app (every lock applies).
  assert.match(engineRepos().problem ?? '', /updates\.json doesn't exist/);
  const noUpdates = scope(naming('shop', 'example-org/shop'));
  assert.equal(noUpdates.scope, 'engine');
  assert.match(noUpdates.why, /which repo is the engine can't be told: .*updates\.json doesn't exist/);
  const updates = etcPath('updates.json');
  mkdirSync(dirname(updates), { recursive: true });
  try {
    // The repo root's updater follows, in an ssh URL with another case.
    writeFileSync(updates, `${JSON.stringify({ enabled: true, repo_url: 'ssh://github.com/Example-Org/Engine.git' })}\n`);
    chmodSync(updates, 0o644);
    assert.deepEqual(engineRepos(), { repos: [own, 'Example-Org/Engine'], problem: null });
    const e = scope(naming('engine', 'example-org/engine'), 'engine', 'example-org/engine');
    assert.equal(e.scope, 'engine');
    assert.match(e.why, /example-org\/engine is the engine's own repo/);
    assert.equal(scope(naming('shop', 'example-org/shop')).scope, 'managed-app', 'another repo is still an app');
    // An updates.json that doesn't say which repo: no app at all.
    for (const body of ['{', '{"repo_url":"https://git.example.org/engine.git"}', '{}', 'null']) {
      writeFileSync(updates, body);
      const s = scope(naming('shop', 'example-org/shop'));
      assert.equal(s.scope, 'engine', body);
      assert.match(s.why, /which repo is the engine can't be told/, body);
    }
  } finally {
    unlinkSync(updates);
  }
  for (const [url, repo] of [['https://github.com/a-b/c.d.git', 'a-b/c.d'], ['git+https://github.com/a/b/', 'a/b'], ['ssh://github.com/a/b', 'a/b'], ['github.com:a/b', 'a/b'], ['https://example.org/a/b', null], ['https://github.com/a/b/c', null], ['', null]] as const) {
    assert.equal(githubRepoOf(url), repo, url);
  }
});

// WHY (#665, owner decision 2026-10-18): with no updates.json, the engine's own package.json was all that said which
// repo is the engine. That is a field inside the engine's repo, so the engine's code under any other repo name (a
// fork, a rename) that root's file named got the managed-app scope, though managed-apps.sh add refuses every add
// without updates.json. A missing updates.json is "can't tell": every lock applies.
test("no updates.json: the engine's code under another repo name is never a managed app, every lock applies", { skip: !posix && 'owners and modes' }, () => {
  assert.equal(existsSync(etcPath('updates.json')), false, 'root has no updates.json here');
  const fork = rootFile(`${JSON.stringify({ version: 1, apps: { fork: 'someone/engine-fork' } })}\n`);
  const s = scope(fork, 'fork', 'someone/engine-fork');
  assert.equal(s.scope, 'engine', s.why);
  assert.match(s.why, /^every self-modification lock applies: which repo is the engine can't be told: .*updates\.json doesn't exist/);
  // The same root file, once root's updates.json names the engine's repo: an app. Only the missing file held the locks.
  withUpdates(ENGINE_UPDATES, () => assert.equal(scope(fork, 'fork', 'someone/engine-fork').scope, 'managed-app'));
});

// WHY (#747): updates.json's presence decides whether any managed app can exist, but it was read with existsSync and
// readFileSync: a symlink was followed, and a file anyone could write was believed. Now it is read as root's other
// files are, and one root can't vouch for is "can't tell": no app, every lock applies.
test("an updates.json root can't vouch for (a symlink, not a regular file, too big, not root's alone) names no engine repo: no app, every lock applies", { skip: !posix && 'owners and modes' }, () => {
  const updates = etcPath('updates.json');
  mkdirSync(dirname(updates), { recursive: true });
  const app = rootFile(`${JSON.stringify({ version: 1, apps: { shop: 'example-org/shop' } })}\n`);
  const good = join(dir(), 'updates.json');
  writeFileSync(good, ENGINE_UPDATES, { mode: 0o644 });
  chmodSync(good, 0o644);
  const cases: [string, () => void, RegExp][] = [
    ['a symlink to a good one', () => symlinkSync(good, updates), /symlink/],
    ['a directory', () => mkdirSync(updates), /not-file/],
    ['group-writable', () => (writeFileSync(updates, ENGINE_UPDATES), chmodSync(updates, 0o664)), /isn't root's alone/],
    ['world-writable', () => (writeFileSync(updates, ENGINE_UPDATES), chmodSync(updates, 0o666)), /isn't root's alone/],
    ['too big', () => (writeFileSync(updates, `${ENGINE_UPDATES}${' '.repeat(70 * 1024)}`), chmodSync(updates, 0o644)), /too-big/],
  ];
  for (const [what, make, why] of cases) {
    make();
    try {
      const e = engineRepos();
      assert.match(e.problem ?? '', why, what);
      assert.match(e.problem ?? '', /so the repo the engine updates from can't be told/, what);
      const s = scope(app);
      assert.equal(s.scope, 'engine', what);
      assert.match(s.why, /which repo is the engine can't be told/, what);
    } finally {
      rmSync(updates, { recursive: true, force: true });
    }
  }
  // Another owner's (this user's, outside a test process): see "outside a test process" below.
  // The same root file with root's own updates.json: an app. Only the file root couldn't vouch for held the locks.
  withUpdates(ENGINE_UPDATES, () => assert.equal(scope(app).scope, 'managed-app'));
});

// WHY (#747, owner decision 2026-10-18): readLockScope took a third argument, for the tests, with another file and
// another root uid. Any src/ caller could pass it, and a polluted Object.prototype filled it in for the plain
// two-argument call. It takes the instance and its repo and nothing else: root's file is MANAGED_APPS_FILE, and root
// is uid 0 everywhere but a process the test preload ran in, whose system root is honoured (rootUid).
test("readLockScope takes the instance and its repo, nothing else: Object.prototype can't hand it another file or root", { skip: !posix && 'owners and modes' }, () => {
  assert.equal(readLockScope.length, 2);
  // Elsewhere, a file this user owns that names the app: what the old third argument's `file` could point at.
  const elsewhere = rootFile(`${JSON.stringify({ version: 1, apps: { shop: 'example-org/shop' } })}\n`);
  withUpdates(ENGINE_UPDATES, () => {
    assert.equal(existsSync(MANAGED_APPS_FILE()), false, 'root has no managed apps file here');
    const clean = readLockScope('shop', 'example-org/shop');
    assert.equal(clean.scope, 'engine');
    assert.match(clean.why, /doesn't name instance shop/);
    const proto = Object.prototype as Record<string, unknown>;
    proto.file = elsewhere;
    proto.rootUid = me;
    try {
      assert.deepEqual(readLockScope('shop', 'example-org/shop'), clean, 'the same answer, polluted or not');
    } finally {
      delete proto.file;
      delete proto.rootUid;
    }
  });
});

// The other side of rootUid (#747): outside a test process, root is uid 0, whatever variables the environment sets
// short of one that makes node load code (NODE_OPTIONS --import/--require: code in the process, which could set the
// mark). A node process the test preload didn't run in gets every variable the preload sets, a system root with this
// run's mark, and a polluted Object.prototype (the preload's own mark among it), and still holds this user's files as
// not root's.
test("outside a test process, root's files must be uid 0's, whatever the preload's variables say: this user's are refused", { skip: (!posix && 'owners and modes') || (me === 0 && 'runs as root') }, () => {
  const machine = dir();
  const root = join(machine, 'root');
  mkdirSync(root, { mode: 0o700 });
  const token = 'a'.repeat(64);
  writeFileSync(join(root, TEST_MARK_FILE), `${token}\n`, { mode: 0o600 });
  // Root's two files, as the scripts write them, but this user's: what a test process takes as root's.
  const etc = join(root, onRealMachine(dirname(MANAGED_APPS_FILE())));
  mkdirSync(etc, { recursive: true });
  for (const [name, body] of [['managed-apps.json', `${JSON.stringify({ version: 1, apps: { shop: 'example-org/shop' } })}\n`], ['updates.json', ENGINE_UPDATES]]) {
    writeFileSync(join(etc, name!), body!, { mode: 0o644 });
    chmodSync(join(etc, name!), 0o644);
  }
  const elsewhere = rootFile(`${JSON.stringify({ version: 1, apps: { shop: 'example-org/shop' } })}\n`);
  const child = [
    'const m = await import(process.argv[1]);',
    'const p = Object.prototype;',
    "p.file = process.argv[2]; p.rootUid = Number(process.argv[3]); p[Symbol.for('test-isolation')] = 'x';",
    "console.log(JSON.stringify({ scope: m.readLockScope('shop', 'example-org/shop'), apps: m.readManagedApps(), engine: m.engineRepos(), file: m.MANAGED_APPS_FILE() }));",
  ].join('\n');
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: join(machine, 'home'), [SYSTEM_ROOT_VAR]: root, [TEST_TOKEN_VAR]: token, [TEST_MACHINE_VAR]: machine, [TEST_RUN_VAR]: '1' };
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', child, new URL('../src/managed-apps.js', import.meta.url).href, elsewhere, String(me)], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { scope: { scope: string; why: string }; apps: { problem: string | null }; engine: { problem: string | null }; file: string };
  // It read the marked root's files (no machine's own), and took neither as root's.
  assert.equal(out.file, join(etc, 'managed-apps.json'));
  const notRoots = new RegExp(`isn't root's alone \\(owner uid ${me}, mode 0644\\)`);
  assert.match(out.apps.problem ?? '', notRoots);
  assert.match(out.engine.problem ?? '', notRoots);
  assert.equal(out.scope.scope, 'engine', out.scope.why);
  assert.match(out.scope.why, notRoots);
  // In this test process (the preload ran here), the same files in the same form are root's: an app.
  withUpdates(ENGINE_UPDATES, () => assert.equal(scope(join(etc, 'managed-apps.json')).scope, 'managed-app'));
});

// WHY (#747): install.ts and managed-apps.ts each had a githubRepoOf, and they disagreed: install's refused a dot in
// a repo name (`owner/site.github.io`), a trailing slash and `GitHub.com`, and took an owner GitHub doesn't allow
// (`bad_owner`). There is one now, and install's origin (gitRemoteRepo) and setup's origin step take exactly what it does.
test('one githubRepoOf: install\'s origin, setup\'s origin step and the engine\'s repos take exactly the same URLs', async () => {
  const { gitRemoteRepo } = await import('../src/install.js');
  const { SETUP_STEPS } = await import('../src/setup-steps.js');
  const origin = SETUP_STEPS.find((s) => s.id === 'origin')!;
  const table: [string, string | null][] = [
    ['https://github.com/example-org/shop.git', 'example-org/shop'],
    ['https://github.com/example-org/shop', 'example-org/shop'],
    // An scp-like ssh remote (its user left out here: the denylist reads user@host as an email address).
    ['github.com:example-org/shop.git', 'example-org/shop'],
    ['ssh://git@github.com/example-org/shop.git', 'example-org/shop'],
    ['https://github.com/example-org/site.github.io.git', 'example-org/site.github.io'],
    ['https://github.com/example-org/shop/', 'example-org/shop'],
    ['https://GitHub.com/Example-Org/Shop.git', 'Example-Org/Shop'],
    ['https://github.com/bad_owner/shop.git', null],
    // Names GitHub has no repo under (owner decision 2026-10-18): install's old parser refused them, and still none.
    ['https://github.com/example-org/.', null],
    ['https://github.com/example-org/..', null],
    ['https://github.com/example-org/.git', null],
    ['https://github.com/example-org/shop/tree', null],
    ['https://git.example.org/example-org/shop.git', null],
    ['/srv/git/shop.git', null],
  ];
  const repo = dir();
  spawnSync('git', ['init', '-q', repo]);
  for (const [url, want] of table) {
    assert.equal(githubRepoOf(url), want, `githubRepoOf ${url}`);
    // install: git's answer, newline and all.
    spawnSync('git', ['remote', 'remove', 'origin'], { cwd: repo });
    assert.equal(spawnSync('git', ['remote', 'add', 'origin', url], { cwd: repo }).status, 0, url);
    assert.equal(gitRemoteRepo(repo), want, `gitRemoteRepo ${url}`);
    // setup's origin step, with the same answer from git.
    const run = () => ({ status: 0, stdout: `${url}\n`, stderr: '' });
    const d = origin.detect({ c: { root: repo }, p: { run } } as unknown as Parameters<typeof origin.detect>[0])!;
    assert.equal(d.done, want !== null, `origin step ${url}: ${d.detail}`);
    if (want) assert.equal(d.detail, `origin is github.com/${want}`);
  }
});

test("readLockScope never throws: a read that fails is the engine's scope, so the coordinator's start-up line can't crash", () => {
  // A system root whose mark no longer matches: root's file's path itself throws (systemPath, SystemRootRefused).
  const token = process.env[TEST_TOKEN_VAR];
  process.env[TEST_TOKEN_VAR] = '0'.repeat(64);
  let s: ReturnType<typeof readLockScope>;
  try {
    s = readLockScope('shop', 'example-org/shop');
  } finally {
    process.env[TEST_TOKEN_VAR] = token;
  }
  assert.equal(s.scope, 'engine');
  assert.match(s.why, /^every self-modification lock applies: root's managed apps file couldn't be read \(.*doesn't match its test mark/);
});

test("the coordinator's lock scope: the engine's when it is given none, or asking for it fails", () => {
  assert.equal(lockScopeOf({}), 'engine');
  assert.equal(lockScopeOf({ lockScope: () => 'managed-app' }), 'managed-app');
  assert.equal(lockScopeOf({ lockScope: () => { throw new Error('EACCES'); } }), 'engine');
  // The evaluator's routing level follows it: the app's own src/contract.ts is app code there, the guard otherwise.
  const review = ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: [] }, L1_evaluator: { when: ['app-non-money'] }, L2_notify: { when: [] }, L3_human: { when: [] } } });
  const routed = (s?: 'engine' | 'managed-app') => evalLevel({ files: [{ path: 'src/contract.ts', added: 1, removed: 0, addedLines: ['export const terms = 1;'], removedLines: [] }], labels: [], moneyPaths: () => [], review, tampered: [], scope: s });
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
  // The engine's package.json the script ships with (managed-apps.sh passes the one two folders up).
  const pkg = join(d, 'package.json');
  writeFileSync(pkg, `${JSON.stringify({ name: 'engine', repository: { type: 'git', url: 'git+https://github.com/example-org/engine-src.git' } })}\n`);
  const run = (...args: string[]) => spawnSync('bash', ['-c', 'umask 000; source "$1"; shift; install_managed_apps "$@"', '_', join(setup, 'lib.sh'), file, ...args], { encoding: 'utf8', env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` } });
  /** add, as managed-apps.sh calls it: with updates.json and the engine's package.json. */
  const add = (inst: string, repo: string, o: { updates?: string; pkg?: string } = {}) => run('add', inst, repo, o.updates ?? updates, o.pkg ?? pkg);
  return { file, updates, pkg, chownLog, run, add };
}

test('managed-apps.sh writes root:root 0644 in exactly the form the engine reads; it refuses a bad name or repo, a file not in its form, and the repo the engine updates from', { skip: !posix && 'bash' }, () => {
  const s = libSh();
  writeFileSync(s.updates, `${JSON.stringify({ enabled: false, repo_url: 'https://github.com/Example-Org/Engine.git', branch: 'main' })}\n`);
  let r = s.add('shop', 'example-org/shop');
  assert.equal(r.status, 0, r.stderr);
  r = s.add('docs-site', 'example-org/site');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(s.file, 'utf8'), '{"version":1,"apps":{"docs-site":"example-org/site","shop":"example-org/shop"}}\n');
  assert.equal((statSync(s.file).mode & 0o777).toString(8), '644', 'set, not inherited from umask 000');
  assert.deepEqual([...new Set(readFileSync(s.chownLog, 'utf8').trim().split('\n'))], [`root:root ${join(dirname(s.file), '.managed-apps.json.tmp')}`], 'root:root, on the temp file before it is moved into place');
  // The engine reads root's updates.json at its /etc path (here the isolate's), not the script's stand-in.
  assert.equal(withUpdates(readFileSync(s.updates, 'utf8'), () => scope(s.file).scope), 'managed-app', 'the engine reads what the script wrote');
  const before = readFileSync(s.file, 'utf8');
  // The engine's own repo (updates.json's), in any case or URL form: never a managed app.
  for (const repo of ['example-org/engine', 'Example-Org/Engine']) {
    const e = s.add('engine', repo);
    assert.equal(e.status, 2, `${repo}: ${e.stderr}`);
    assert.match(e.stderr, /the repo the engine on this machine updates from/);
  }
  // The engine's own package.json repository, in any case: never a managed app either.
  for (const repo of ['example-org/engine-src', 'Example-Org/Engine-Src']) {
    const e = s.add('engine', repo);
    assert.equal(e.status, 2, `${repo}: ${e.stderr}`);
    assert.match(e.stderr, /is the engine own repo/);
  }
  writeFileSync(s.updates, `${JSON.stringify({ repo_url: 'https://github.com/example-org/engine/' })}\n`);
  assert.equal(s.add('engine', 'example-org/engine').status, 2);
  // Bad names and repos.
  for (const [name, repo] of [['Shop', 'example-org/shop'], ['hub', 'example-org/shop'], ['shop', 'example-org'], ['shop', 'example-org/shop/x'], ['shop', '-x/shop']]) {
    const e = s.add(name!, repo!);
    assert.equal(e.status, 2, `${name} ${repo}: ${e.stderr}`);
  }
  // Which repo is the engine can't be told: it refuses to add anything, rather than skipping the check (#665).
  const etc = dirname(s.updates);
  const noUpdates = join(etc, 'none.json');
  const notJson = join(etc, 'not-json.json');
  writeFileSync(notJson, '{');
  const notGithub = join(etc, 'elsewhere.json');
  writeFileSync(notGithub, `${JSON.stringify({ repo_url: 'https://git.example.org/engine.git' })}\n`);
  const noRepoPkg = join(etc, 'package.json');
  writeFileSync(noRepoPkg, `${JSON.stringify({ name: 'engine' })}\n`);
  const cannotTell: [string, { updates?: string; pkg?: string }, RegExp][] = [
    ['no updates.json', { updates: noUpdates }, /no .*none\.json, so the repo the engine updates from cannot be told/],
    ['no updates.json given', { updates: '' }, /cannot be told/],
    ['updates.json not JSON', { updates: notJson }, /not JSON, so the engine repo it names cannot be told apart/],
    ['updates.json names no GitHub repo', { updates: notGithub }, /names no GitHub repo/],
    ['no engine package.json', { pkg: join(etc, 'missing', 'package.json') }, /package\.json .* cannot be read/],
    ['a package.json with no repository', { pkg: noRepoPkg }, /names no GitHub repository/],
  ];
  for (const [what, o, why] of cannotTell) {
    const e = s.add('blog', 'example-org/blog', o);
    assert.equal(e.status, 2, `${what}: ${e.stderr}`);
    assert.match(e.stderr, why, what);
  }
  assert.equal(readFileSync(s.file, 'utf8'), before, 'a refusal changes nothing');
  // remove takes one back (and again is nothing to do).
  for (let i = 0; i < 2; i++) assert.equal(s.run('remove', 'shop').status, 0);
  assert.equal(readFileSync(s.file, 'utf8'), '{"version":1,"apps":{"docs-site":"example-org/site"}}\n');
  const removed = withUpdates(readFileSync(s.updates, 'utf8'), () => scope(s.file));
  assert.equal(removed.scope, 'engine');
  assert.match(removed.why, /doesn't name instance shop/, 'engine because it was removed, not for want of updates.json');
  // A file not in its form: it stops, changing nothing.
  writeFileSync(s.file, '{"version":1,"apps":{"shop":"example-org/shop"},"note":"x"}\n');
  const bad = s.add('blog', 'example-org/blog');
  assert.equal(bad.status, 2, bad.stderr);
  assert.match(bad.stderr, /not in the form managed-apps\.sh writes/);
});

test('managed-apps.sh: only a root shell changes the file, never a coordinator, and show reads without root', () => {
  const sh = readFileSync(join(setup, 'managed-apps.sh'), 'utf8');
  // add and remove go through root (as_root) and refuse a coordinator's sudo; show doesn't need root.
  assert.match(sh, /  add\|remove\)\n    as_root "\$@"\n    \[\[ "\$\{SUDO_USER:-\}" != wl-\* \]\] \|\| \{/);
  assert.ok(sh.indexOf('as_root') > sh.indexOf('  show)'), 'show runs before any as_root');
  // add passes updates.json and the engine's own package.json (the one two folders up), for the engine-repo refusal.
  assert.match(sh, /install_managed_apps "\$MANAGED_APPS" add "\$2" "\$3" "\$UPDATES_JSON" "\$\(cd "\$\(dirname "\$0"\)\/\.\.\/\.\." && pwd\)\/package\.json"/);
  // No machine helper command reaches it (the helper's sudoers rule runs only the helper).
  assert.doesNotMatch(readFileSync(join(setup, 'machine-helper.sh'), 'utf8'), /managed-apps/);
  assert.doesNotMatch(readFileSync(join(repoRoot, 'scripts', 'machine', `${BRAND.cli}-machine.cjs`), 'utf8'), /managed-apps/);
});
