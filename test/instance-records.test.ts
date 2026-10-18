// The registry of what holds an instance's name outside its users' homes (scripts/setup/instance-records.cjs), and
// instance-remove.sh's way of taking one instance's records out of root's shared files. The real users, units and
// sudoers are proven on a real host as root: .github/workflows/ci-slow.yml, add-project (real systemd).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { BRAND } from '../src/brand.js';
import { repoRoot } from './helpers.js';
import { createDevice, readDevices, revokeAllDevices, verifyToken } from '../src/siri/tokens.js';

interface Item { kind: string; what: string; when?: string[]; by: string; rename: string }
const reg = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'setup', 'instance-records.cjs')) as {
  ITEMS: Item[];
  NOT_RECORDS: { what: string; why: string }[];
  SHARED_FILES: { at: string; item?: string; why?: string }[];
  plan: (name: string, prefix?: string) => Record<string, unknown>;
  remove: (name: string, archive: string, prefix?: string) => Record<string, unknown>;
  rekey: (old: string, nu: string, archive: string, prefix?: string) => string[];
  carry: (h: Record<string, string>, from: string, to: string) => ({ from: string; to: string } | { skipped: string })[];
  moveText: (text: string, h: Record<string, string>) => string;
};
const cli = BRAND.cli;
const posix = process.platform !== 'win32';

// --- the registry is whole

function files(dir: string, keep: (f: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? files(p, keep) : keep(p) ? [p] : [];
  });
}
/** What the registry looks at: the root setup scripts, the machine's helpers, and the engine (never the CI fixtures). */
const scanned = () => [
  ...files(join(repoRoot, 'scripts', 'setup'), (f) => /\.(sh|cjs|mjs)$/.test(f)),
  ...files(join(repoRoot, 'scripts', 'machine'), () => true),
  ...files(join(repoRoot, 'src'), (f) => f.endsWith('.ts')),
];
/** The variable names that hold an instance's name in the scripts. */
const INSTANCE_VARS = new Set(['name', 'n', 'm', '1', 'inst', 'instance', 'for_inst', 'for_instance', 'asker', 'token_from', 'old', 'new']);

/** Each path or name in a script line that is built from an instance's name, with that name written <name>. */
function instanceNames(line: string): string[] {
  const out: string[] = [];
  const tokens = line.match(new RegExp(`[A-Za-z0-9_./\${}-]*(?:${cli}|wl-)[A-Za-z0-9_./\${}-]*`, 'g')) ?? [];
  for (const t of tokens) {
    let hit = false;
    const norm = t
      .replace(/\$\{([A-Za-z_]\w*)[^}]*\}?|\$([A-Za-z_]\w*|\d)/g, (_m, a: string | undefined, b: string | undefined) => {
        const v = a ?? b ?? '';
        if (INSTANCE_VARS.has(v)) {
          hit = true;
          return '<name>';
        }
        return '<var>';
      })
      .replace(/^(<var>)+/, '')
      .replace(/^[^A-Za-z0-9/<]+/, '')
      .replace(/\/{2,}/g, '/')
      .replace(/[}./-]+$/, '');
    if (hit) out.push(norm);
  }
  // src/: a machine path built from a name, through the system path helpers.
  const roots: Record<string, string> = { etcPath: `/etc/${cli}/`, varLibPath: `/var/lib/${cli}/`, runPath: `/run/${cli}/`, unitPath: '/etc/systemd/system/' };
  for (const m of line.matchAll(/\b(etcPath|varLibPath|runPath|unitPath)\(\s*`([^`]*)`/g)) {
    const body = m[2]!.split('${BRAND.cli}').join(cli);
    if (body.includes('${')) out.push(roots[m[1]!] + body.replace(/\$\{[^}]*\}/g, '<name>'));
  }
  return out;
}

/** Each file or directory directly under /etc/<cli> and /var/lib/<cli> (or a /var/lib/<cli>-* root) a line names. */
function rootFiles(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(new RegExp(`/(etc|var/lib)/${cli}(-[a-z]+)?(?:/([A-Za-z0-9_.-]+))?`, 'g'))) {
    if (m[2]) {
      if (m[1] === 'var/lib') out.push(`/var/lib/${cli}${m[2]}`);
      continue;
    }
    if (m[3]) out.push(`/${m[1]}/${cli}/${m[3].replace(/^\./, '').replace(/\.tmp$/, '').replace(/\.$/, '')}`);
  }
  for (const m of line.matchAll(/\b(etcPath|varLibPath)\(\s*['`]([A-Za-z0-9_.-]+)/g)) out.push(`/${m[1] === 'etcPath' ? 'etc' : 'var/lib'}/${cli}/${m[2]}`);
  return out;
}

function known(t: string): boolean {
  // An item's name, and where its kind keeps it: a unit's file, a sudoers file.
  const where = (kind: string, w: string) => [w, ...(kind === 'unit' ? [`/etc/systemd/system/${w}`] : kind === 'sudoers' ? [`/etc/sudoers.d/${w}`] : [])];
  const whats = reg.ITEMS.flatMap((i) => [...where(i.kind, i.what), ...(i.when ?? []).flatMap((w) => where(w.slice(0, w.indexOf(':')), w.slice(w.indexOf(':') + 1)))]);
  // Part of an item (a name inside it, or a path below it), or of something listed as not an instance's record.
  return whats.some((w) => w.includes(t) || t.startsWith(`${w}/`)) || reg.NOT_RECORDS.some((n) => t.startsWith(n.what));
}

test('every per-instance root path or name the scripts and the engine use is in the registry, as an item or as no record of its own', () => {
  const unknown: string[] = [];
  for (const f of scanned()) {
    readFileSync(f, 'utf8')
      .split('\n')
      .forEach((l, i) => {
        for (const t of instanceNames(l)) if (!known(t)) unknown.push(`${relative(repoRoot, f)}:${i + 1}: ${t}`);
      });
  }
  assert.deepEqual(unknown, [], `per-instance root paths or names scripts/setup/instance-records.cjs doesn't list; add each to ITEMS (with how instance-remove.sh takes it away) or to NOT_RECORDS (with why it is none):\n${unknown.join('\n')}`);
});

test('every file under /etc/<cli> and /var/lib/<cli> the scripts and the engine use is classified: the item that takes an instance\'s records out of it, or why it holds none', () => {
  const listed = new Set(reg.SHARED_FILES.map((s) => s.at));
  const unknown: string[] = [];
  for (const f of scanned()) {
    readFileSync(f, 'utf8')
      .split('\n')
      .forEach((l, i) => {
        for (const p of rootFiles(l)) if (!listed.has(p)) unknown.push(`${relative(repoRoot, f)}:${i + 1}: ${p}`);
      });
  }
  assert.deepEqual(unknown, [], `root files scripts/setup/instance-records.cjs doesn't classify; add each to SHARED_FILES:\n${unknown.join('\n')}`);
  for (const s of reg.SHARED_FILES) assert.ok(Boolean(s.item) !== Boolean(s.why), `${s.at}: an item or a why, exactly one`);
  // And every item says what a rename does with it.
  for (const i of reg.ITEMS) assert.ok(['new', 'rekey', 'move', 'drop'].includes(i.rename), `${i.what}: rename is new, rekey, move or drop`);
  // A rename says what it drops: every drop has its note.
  for (const i of reg.ITEMS.filter((x) => x.rename === 'drop')) assert.ok((i as Item & { note?: string }).note, `${i.what}: a drop needs a note`);
});

test('the registry check sees a new feature\'s per-instance root records, in a script and in src/', () => {
  // As a feature not written yet would write them: each must be registered before it can merge.
  assert.ok(!instanceNames('install -d "/var/lib/worklane-future/$name"').every(known));
  assert.ok(!instanceNames('remove_sudoers "worklane-future-$name"').every(known));
  assert.ok(!instanceNames('export const allowlistPath = (instance: string) => etcPath(`future/${instance}.json`);').every(known));
  assert.ok(rootFiles('etc_dir=/etc/worklane/future').includes(`/etc/${cli}/future`));
  assert.ok(rootFiles("export const PENDING = varLibPath('future/pending.json');").includes(`/var/lib/${cli}/future`));
  assert.ok(!rootFiles('x=/etc/worklane/future').every((p) => reg.SHARED_FILES.some((f) => f.at === p)));
  // And the ones it has already.
  assert.ok(instanceNames('install_sudoers "worklane-test-$name" "$(sudoers_rule)"').every(known));
  assert.ok(instanceNames('root="/var/lib/worklane-test/$name"').every(known));
  assert.ok(instanceNames('unit="worklane-test-$name-$id-$$"').every(known));
});

test('instance-remove.sh and the registry are reachable from no sudoers rule and no machine helper command', () => {
  for (const f of ['scripts/machine/worklane-machine.cjs', 'scripts/setup/machine-helper.sh', 'scripts/setup/test-user.sh', 'scripts/setup/console-shell.sh']) {
    const src = readFileSync(join(repoRoot, f), 'utf8');
    assert.doesNotMatch(src, /instance-(remove|rename|records)/, `${f} names the removal`);
  }
  // The machine helper's sudoers rule as lib.sh writes it (every pattern on, as on a new sudo): none of it.
  if (posix) {
    const r = spawnSync('bash', ['-c', `source "$1"; sudo_regex_ok() { return 0; }; machine_sudoers wl-alpha wl-beta`, '_', join(repoRoot, 'scripts', 'setup', 'lib.sh')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^wl-alpha, wl-beta ALL=\(root\) NOPASSWD: WORKLANE_MACHINE$/m);
    assert.doesNotMatch(r.stdout, /instance|setup\//, 'the rule names no setup script and no instance step');
  }
  for (const f of ['instance-remove', 'instance-rename']) {
    const script = readFileSync(join(repoRoot, 'scripts', 'setup', `${f}.sh`), 'utf8');
    assert.match(script, new RegExp(`^\\[\\[ "\\$\\{SUDO_USER:-\\}" != wl-\\* \\]\\] \\|\\| \\{ echo "${f} is an admin's`, 'm'), `${f} refuses a coordinator's sudo`);
  }
});

test('instance-rename.sh takes two names (the new one as add-project takes it) and one of --print, --yes or --abort, before anything else', { skip: !posix && 'bash' }, () => {
  const run = (...a: string[]) => spawnSync('bash', [join(repoRoot, 'scripts', 'setup', 'instance-rename.sh'), ...a], { encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin' } });
  for (const a of [[], ['a'], ['a', 'a'], ['a', 'b', 'c'], ['a', 'b-agent'], ['a', 'b-work'], ['a', 'dash'], ['a', 'B'], ['dash', 'b'], ['a', 'b', '--print', '--yes'], ['a', 'b', '--yes', '--abort'], ['a', 'b', '--force'], ['a', 'b'.repeat(22)]]) {
    const r = run(...a);
    assert.equal(r.status, 2, `${JSON.stringify(a)}: ${r.stderr}`);
  }
});

test("the hub's settings kept for a rewrite: client id, URL, console user and devices, and both gateways", { skip: !posix && 'bash' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-'));
  const unit = join(dir, 'hub.service');
  const keep = (exec: string) => {
    writeFileSync(unit, `[Service]\nExecStart=${exec}\n`);
    const r = spawnSync('bash', ['-c', 'source "$1"; HUB_UNIT="$2"; hub_keep_args', '_', join(repoRoot, 'scripts', 'setup', 'lib.sh'), unit], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim().split('\n');
  };
  assert.deepEqual(keep(`/usr/local/bin/${cli} dashboard --hub a=/x --service --client-id Iv1.abc --public-url https://h.example --signin-dir /d --siri-port 4397 --hooks-port 4396 --console-user admin --console-devices tag:me`), ['--client-id', 'Iv1.abc', '--public-url', 'https://h.example', '--console-user', 'admin', '--console-devices', 'tag:me', '--siri', '--hooks']);
  assert.deepEqual(keep(`/usr/local/bin/${cli} dashboard --hub a=/x --service --client-id Iv1.abc --public-url https://h.example --signin-dir /d`), ['--client-id', 'Iv1.abc', '--public-url', 'https://h.example']);
});

test('instance-remove.sh takes one name and --print or --yes, before anything else', { skip: !posix && 'bash' }, () => {
  const run = (...a: string[]) => spawnSync('bash', [join(repoRoot, 'scripts', 'setup', 'instance-remove.sh'), ...a], { encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin' } });
  for (const a of [[], ['--print'], ['a', 'b'], ['a', '--print', '--yes'], ['a', '--force'], ['Bad'], ['dash'], ['a/b'], ['-a'], ['a'.repeat(22)], ['a', '--exported', '/var/lib/worklane/removed/a-20261015T000000Z.bundle'], ['a', '--yes', '--exported', '/tmp/a.bundle'], ['a', '--yes', '--exported']]) {
    const r = run(...a);
    assert.equal(r.status, 2, `${JSON.stringify(a)}: ${r.stderr}`);
  }
});

// --- taking one instance's records out of the shared files

const NAME = 'alpha';
/** A machine's root files under a temp prefix: alpha's records, and alpha-2's and beta's beside them. */
function machine(): string {
  const root = mkdtempSync(join(tmpdir(), 'records-'));
  const put = (p: string, v: unknown) => {
    const f = join(root, p);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v));
  };
  put(`/etc/${cli}/testrun-gpu.json`, { version: 1, max_minutes: 20, instances: { alpha: { devices: [0] }, 'alpha-2': { devices: [1] } } });
  put(`/etc/${cli}/testrun-network.json`, { version: 1, instances: { alpha: { tiers: ['e2e'] }, 'alpha-2': { tiers: ['e2e'] } } });
  put(`/etc/${cli}/updates.json`, { enabled: true, channel: 'release', canary: { instance: 'alpha', repo: 'o/scratch', time_limit_minutes: 60 }, required_checks: ['a'] });
  put(`/var/lib/${cli}/canary.json`, { running: { issue: 7 }, lastFiledAt: '2026-10-15T00:00:00Z' });
  const rec = (instance: string, user: string) => ({ instance, kind: 'agent', user, api_ok: true });
  put(`/var/lib/${cli}/claude-account/profiles.json`, {
    version: 1,
    profiles: {
      work: { kind: 'token', users: { 'wl-alpha-agent': rec('alpha', 'wl-alpha-agent'), 'wl-alpha-2-agent': rec('alpha-2', 'wl-alpha-2-agent'), 'wl-beta-agent': rec('beta', 'wl-beta-agent') }, staged: false },
      mine: { kind: 'token', users: { 'wl-alpha-agent': rec('alpha', 'wl-alpha-agent') }, staged: true, instance: 'alpha' },
      solo: { kind: 'token', users: { 'wl-alpha-agent': rec('alpha', 'wl-alpha-agent') }, staged: false },
    },
    active: { alpha: { profile: 'work', since: 'x' }, 'alpha-2': { profile: 'work', since: 'y' }, beta: { profile: 'work', since: 'z' } },
    switched_at: { alpha: 'x', 'alpha-2': 'y' },
    failover: { machine: { order: ['default', 'work'], back: true }, instances: { alpha: { order: [], back: false }, beta: { order: [], back: true } } },
  });
  put(`/var/lib/${cli}/claude-account/status.json`, { at: 'now', users: [rec('alpha', 'wl-alpha-agent'), rec('alpha', 'wl-alpha-eval'), rec('alpha-2', 'wl-alpha-2-agent'), rec('beta', 'wl-beta-agent')] });
  put(`/var/lib/${cli}/claude-account/paused`, 'alpha-2\nalpha\nbeta\n');
  const inc = (id: string, instance: string | null, key: string) => ({ id, kind: 'unit_down', key, instance, severity: 'red', title: 't', detail: 'd', fix: 'f', tried: [], since: 's', lastSeen: 's', resolvedAt: null, posted: {} });
  put(`/var/lib/${cli}/agent-slots/incidents.json`, { incidents: [inc('1', 'alpha', `${cli}-alpha.service`), inc('2', 'alpha-2', `${cli}-alpha-2.service`), inc('3', null, 'disk'), inc('4', 'alpha', 'alpha#12')], posts: ['p'] });
  put(`/var/lib/${cli}/plugins/pending.json`, { version: 1, entries: [{ instance: 'alpha', id: 'kit', roles: ['worker'], digest: 'd1', staged_at: 'now' }, { instance: 'alpha-2', id: 'kit', roles: ['worker'], digest: 'd2', staged_at: 'now' }] });
  put(`/var/lib/${cli}/pending-signers.json`, { pending: [{ principal: 'a@example.com', key: 'k1', instance: 'alpha', at: 'now' }, { principal: 'b@example.com', key: 'k2', instance: 'beta', at: 'now' }] });
  return root;
}
const read = (root: string, p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'));

test("remove takes out exactly alpha's records, never alpha-2's or beta's, and keeps what it took in a 0600 archive first", () => {
  const root = machine();
  const archive = join(root, 'archive', 'alpha.records.json');
  const planned = reg.plan(NAME, root);
  assert.deepEqual(Object.keys(planned).sort(), ['canary', 'claude-paused', 'claude-profiles', 'claude-status', 'gpu', 'incidents', 'pending-signers', 'plugin-pending', 'testrun-net']);
  const taken = reg.remove(NAME, archive, root);
  // The GPU grant is testrun-gpu.sh's to take out (its strict form): planned, never written here.
  assert.deepEqual(Object.keys(taken).sort(), ['canary', 'claude-paused', 'claude-profiles', 'claude-status', 'incidents', 'pending-signers', 'plugin-pending']);
  assert.deepEqual(read(root, `/var/lib/${cli}/plugins/pending.json`), { version: 1, entries: [{ instance: 'alpha-2', id: 'kit', roles: ['worker'], digest: 'd2', staged_at: 'now' }] }, "another instance's staged plugin stays");
  assert.deepEqual(read(root, `/etc/${cli}/testrun-gpu.json`).instances, { alpha: { devices: [0] }, 'alpha-2': { devices: [1] } });

  const u = read(root, `/etc/${cli}/updates.json`);
  assert.deepEqual(u, { enabled: true, channel: 'release', required_checks: ['a'] }, 'only the canary goes');
  assert.ok(!existsSync(join(root, `/var/lib/${cli}/canary.json`)), "the canary's run state goes with it");

  const p = read(root, `/var/lib/${cli}/claude-account/profiles.json`);
  assert.deepEqual(Object.keys(p.active), ['alpha-2', 'beta']);
  assert.deepEqual(p.switched_at, { 'alpha-2': 'y' });
  assert.deepEqual(p.failover, { machine: { order: ['default', 'work'], back: true }, instances: { beta: { order: [], back: true } } });
  assert.deepEqual(Object.keys(p.profiles), ['work'], "a profile added for alpha alone, and one only alpha's user was on, go");
  assert.deepEqual(Object.keys(p.profiles.work.users), ['wl-alpha-2-agent', 'wl-beta-agent']);

  assert.deepEqual(read(root, `/var/lib/${cli}/claude-account/status.json`).users.map((x: { user: string }) => x.user), ['wl-alpha-2-agent', 'wl-beta-agent']);
  assert.equal(readFileSync(join(root, `/var/lib/${cli}/claude-account/paused`), 'utf8'), 'alpha-2\nbeta\n');
  const inc = read(root, `/var/lib/${cli}/agent-slots/incidents.json`);
  assert.deepEqual(inc.incidents.map((x: { id: string }) => x.id), ['2', '3']);
  assert.deepEqual(inc.posts, ['p']);
  assert.deepEqual(read(root, `/var/lib/${cli}/pending-signers.json`).pending.map((x: { instance: string }) => x.instance), ['beta']);

  const kept = JSON.parse(readFileSync(archive, 'utf8'));
  assert.equal(kept.instance, 'alpha');
  assert.deepEqual(kept.records.incidents.map((x: { id: string }) => x.id), ['1', '4']);
  assert.deepEqual(kept.taken.canary.canary, { instance: 'alpha', repo: 'o/scratch', time_limit_minutes: 60 });
  assert.equal(kept.taken.canary.state.running.issue, 7);
  if (posix) assert.equal(statSync(archive).mode & 0o777, 0o600);

  // Again: nothing left to take, and nothing else changes.
  const before = readFileSync(join(root, `/var/lib/${cli}/claude-account/profiles.json`), 'utf8');
  assert.deepEqual(reg.remove(NAME, join(root, 'archive', 'again.json'), root), {});
  assert.equal(readFileSync(join(root, `/var/lib/${cli}/claude-account/profiles.json`), 'utf8'), before);
  assert.deepEqual(Object.keys(reg.plan(NAME, root)).sort(), ['gpu', 'testrun-net'], "the GPU and network grants are their scripts' to take out");
});

test('a shared file keeps its mode through a removal', { skip: !posix && 'POSIX modes' }, () => {
  const root = machine();
  const f = join(root, `/var/lib/${cli}/agent-slots/incidents.json`);
  spawnSync('chmod', ['0660', f]);
  reg.remove(NAME, join(root, 'a.json'), root);
  assert.equal(statSync(f).mode & 0o777, 0o660, 'the coordinators can still write the incident store');
});

test("the incident store is changed under its lock: a coordinator's write in progress is waited for", { skip: !posix && 'POSIX' }, async () => {
  const root = machine();
  const dir = join(root, `/var/lib/${cli}/agent-slots`);
  const lock = join(dir, 'incidents.lock');
  // A live holder (as src/locks.ts writes one) that lets go after 400 ms.
  const holder = spawn(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(lock)}, JSON.stringify({ pid: process.pid, owner: 'incidents', acquiredAt: new Date().toISOString() })); setTimeout(() => { require('fs').unlinkSync(${JSON.stringify(lock)}); process.exit(0); }, 400); process.stdout.write('held\\n');`], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((r) => holder.stdout.once('data', () => r()));
  const t0 = Date.now();
  // In a child, so this test's own event loop keeps running while it waits.
  const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(join(repoRoot, 'scripts', 'setup', 'instance-records.cjs'))}).remove('alpha', ${JSON.stringify(join(root, 'a.json'))}, ${JSON.stringify(root)})`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - t0 >= 300, 'it waited for the holder');
  assert.deepEqual(read(root, `/var/lib/${cli}/agent-slots/incidents.json`).incidents.map((x: { id: string }) => x.id), ['2', '3']);
  assert.ok(!existsSync(lock), 'and let go of the lock');
});

// --- moving one instance's records to a new name (instance-rename.sh)

test("rekey moves exactly alpha's records to bravo, never alpha-2's or beta's; a rerun after a stop part way finishes it; two instances' records are never merged", () => {
  const root = machine();
  const init = (n: string) => join(root, `/var/lib/${cli}/init/${n}.json`);
  mkdirSync(dirname(init('alpha')), { recursive: true });
  writeFileSync(init('alpha'), JSON.stringify({ version: 1, mode: 'server', instance: 'alpha' }));
  writeFileSync(join(root, `/var/lib/${cli}/agent-slots/discord-claim-alpha.json`), '{}');
  writeFileSync(join(root, `/var/lib/${cli}/agent-slots/discord-claim-alpha-2.json`), '{}');
  const moved = reg.rekey('alpha', 'bravo', join(root, 'archive', 'r.json'), root);
  assert.deepEqual(moved.sort(), ['canary', 'claude-paused', 'claude-profiles', 'claude-status', 'incidents', 'init', 'pending-signers']);

  const p = read(root, `/var/lib/${cli}/claude-account/profiles.json`);
  assert.deepEqual(Object.keys(p.active).sort(), ['alpha-2', 'beta', 'bravo']);
  assert.deepEqual(p.active.bravo, { profile: 'work', since: 'x' });
  assert.deepEqual(p.switched_at, { 'alpha-2': 'y', bravo: 'x' });
  assert.deepEqual(Object.keys(p.failover.instances).sort(), ['beta', 'bravo']);
  assert.deepEqual(Object.keys(p.profiles.work.users).sort(), ['wl-alpha-2-agent', 'wl-beta-agent', 'wl-bravo-agent']);
  assert.deepEqual([p.profiles.work.users['wl-bravo-agent'].instance, p.profiles.work.users['wl-bravo-agent'].user], ['bravo', 'wl-bravo-agent']);
  assert.equal(p.profiles.mine.instance, 'bravo');
  const st = read(root, `/var/lib/${cli}/claude-account/status.json`).users.map((u: { instance: string; user: string }) => `${u.instance}:${u.user}`);
  assert.deepEqual(st, ['bravo:wl-bravo-agent', 'bravo:wl-bravo-eval', 'alpha-2:wl-alpha-2-agent', 'beta:wl-beta-agent']);
  assert.equal(readFileSync(join(root, `/var/lib/${cli}/claude-account/paused`), 'utf8'), 'alpha-2\nbravo\nbeta\n');
  assert.equal(read(root, `/etc/${cli}/updates.json`).canary.instance, 'bravo');
  assert.ok(existsSync(join(root, `/var/lib/${cli}/canary.json`)), 'the canary run in progress stays: same repo, same canary');
  const inc = read(root, `/var/lib/${cli}/agent-slots/incidents.json`).incidents.map((x: { id: string; instance: string; key: string }) => `${x.id}:${x.instance}:${x.key}`);
  assert.deepEqual(inc, [`1:bravo:${cli}-bravo.service`, `2:alpha-2:${cli}-alpha-2.service`, '3:null:disk', '4:bravo:bravo#12']);
  assert.deepEqual(read(root, `/var/lib/${cli}/pending-signers.json`).pending.map((x: { instance: string }) => x.instance), ['bravo', 'beta']);
  assert.ok(!existsSync(init('alpha')));
  assert.equal(read(root, `/var/lib/${cli}/init/bravo.json`).instance, 'bravo');
  assert.ok(!existsSync(join(root, `/var/lib/${cli}/agent-slots/discord-claim-alpha.json`)) && existsSync(join(root, `/var/lib/${cli}/agent-slots/discord-claim-alpha-2.json`)));
  assert.deepEqual(read(root, `/etc/${cli}/testrun-gpu.json`).instances.alpha, { devices: [0] }, "the GPU grant is testrun-gpu.sh's to move");
  assert.equal(JSON.parse(readFileSync(join(root, 'archive', 'r.json'), 'utf8')).records.canary.canary.instance, 'alpha', 'what alpha had, kept first');

  // Rerun: nothing of alpha's is left to move.
  assert.deepEqual(reg.rekey('alpha', 'bravo', join(root, 'archive', 'r2.json'), root), []);
  // alpha-2 onto beta, which has records in the same files: refused, nothing changes.
  const before = readFileSync(join(root, `/var/lib/${cli}/claude-account/profiles.json`), 'utf8');
  assert.throws(() => reg.rekey('alpha-2', 'beta', join(root, 'archive', 'r3.json'), root), /both have records in .*claude-profiles/);
  assert.equal(readFileSync(join(root, `/var/lib/${cli}/claude-account/profiles.json`), 'utf8'), before);
});

test("carry moves the old instance home's files to the new name's paths and users, never another instance's, and lists the files they name outside it", () => {
  const root = mkdtempSync(join(tmpdir(), 'carry-'));
  const h = { old: 'alpha', nu: 'bravo', oldHome: join(root, 'home/wl-alpha'), newHome: join(root, 'home/wl-bravo'), oldAgent: join(root, 'home/wl-alpha-agent'), newAgent: join(root, 'home/wl-bravo-agent') };
  const from = join(h.oldHome, `.local/state/${cli}/instances/alpha`);
  const to = join(h.newHome, `.local/state/${cli}/instances/bravo`);
  mkdirSync(join(from, 'state'), { recursive: true });
  mkdirSync(join(from, 'git-hooks'), { recursive: true });
  mkdirSync(to, { recursive: true });
  mkdirSync(join(h.oldAgent, 'keys'), { recursive: true });
  writeFileSync(join(h.oldAgent, 'keys', 'api'), 'k');
  writeFileSync(join(from, 'instance.yaml'), `version: 1\nname: alpha\nrepos:\n  - path: /srv/${cli}/alpha/shop\n    repo: o/shop\nrun_as:\n  agent_user: wl-alpha-agent\n  agent_home: ${h.oldAgent}\n`);
  writeFileSync(join(from, 'credentials.yaml'), `github: { kind: app, app_id: 1, installation_id: 2, key_path: ${h.oldHome}/.config/alpha-app/private-key.pem }\nagent_api_key: ${h.oldAgent}/keys/api\nother: /srv/${cli}/alpha-2/x\n`, { mode: 0o600 });
  writeFileSync(join(from, 'policy.yaml'), 'version: 1\nauto_merge: false\n');
  writeFileSync(join(from, 'state', 'events.db'), 'not carried');
  writeFileSync(join(to, 'instance.yaml'), 'version: 1\nname: bravo\n');
  const out = reg.carry(h, from, to);
  assert.deepEqual(out.filter((x) => 'from' in x), [{ from: join(h.oldAgent, 'keys', 'api'), to: join(h.newAgent, 'keys', 'api') }]);
  assert.deepEqual(out.filter((x) => 'skipped' in x), [{ skipped: join(from, 'git-hooks') }]);
  const inst = readFileSync(join(to, 'instance.yaml'), 'utf8');
  assert.match(inst, /^name: bravo$/m);
  assert.match(inst, new RegExp(`path: /srv/${cli}/bravo/shop$`, 'm'));
  assert.match(inst, /agent_user: wl-bravo-agent$/m);
  const cred = readFileSync(join(to, 'credentials.yaml'), 'utf8');
  assert.ok(cred.includes(`${h.newHome}/.config/bravo-app/private-key.pem`) && cred.includes(`${h.newAgent}/keys/api`));
  assert.ok(cred.includes(`/srv/${cli}/alpha-2/x`), "another instance's path stays as it was");
  assert.ok(!existsSync(join(to, 'state')), 'the state comes by import, never by carry');
  if (posix) assert.equal(statSync(join(to, 'credentials.yaml')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(to, 'policy.yaml'), 'utf8'), 'version: 1\nauto_merge: false\n');
});

// --- what instance-remove.sh unmounts, and what refuses it

test("only an experiment job's own output volume is the engine's mount to unmount: its exact place, and a loop device backed by that job's vol.img", { skip: !posix && 'bash' }, () => {
  // findmnt and losetup stood in for: what a machine with these mounts would answer.
  const stubs = `
    findmnt() { case "$*" in *"--mountpoint /var/lib/${cli}-exp/alpha/jobs/j-1/vol"*) echo /dev/loop3 ;; *"--mountpoint /var/lib/${cli}-exp/alpha/jobs/j-2/vol"*) echo /dev/loop4 ;; *"--mountpoint /var/lib/${cli}-exp/alpha/jobs/j-3/vol"*) echo tmpfs ;; *"--mountpoint /var/lib/${cli}-exp/alpha-2/jobs/j-1/vol"*) echo /dev/loop5 ;; *) echo /dev/loop3 ;; esac; }
    losetup() { case "$*" in *loop3*) echo "/var/lib/${cli}-exp/alpha/jobs/j-1/vol.img  " ;; *loop4*) echo /var/lib/${cli}-exp/alpha/jobs/j-1/vol.img ;; *loop5*) echo /var/lib/${cli}-exp/alpha-2/jobs/j-1/vol.img ;; esac; }`;
  const is = (name: string, m: string) => spawnSync('bash', ['-c', `source "$1"; ${stubs}; engine_volume "$2" "$3"`, '_', join(repoRoot, 'scripts', 'setup', 'lib.sh'), name, m], { encoding: 'utf8' }).status === 0;
  assert.equal(is('alpha', `/var/lib/${cli}-exp/alpha/jobs/j-1/vol`), true, "the job's own loop-mounted image");
  assert.equal(is('alpha', `/var/lib/${cli}-exp/alpha/jobs/j-2/vol`), false, "a loop device backed by another job's image");
  assert.equal(is('alpha', `/var/lib/${cli}-exp/alpha/jobs/j-3/vol`), false, 'a tmpfs at the place');
  assert.equal(is('alpha', `/var/lib/${cli}-exp/alpha-2/jobs/j-1/vol`), false, "another instance's volume, named for alpha");
  assert.equal(is('alpha-2', `/var/lib/${cli}-exp/alpha-2/jobs/j-1/vol`), true);
  for (const m of [`/var/lib/${cli}-exp/alpha/jobs/j-1/vol/x`, `/var/lib/${cli}-exp/alpha/jobs/j-1`, `/var/lib/${cli}-exp/alpha/jobs/J-1/vol`, `/srv/elsewhere/vol`]) assert.equal(is('alpha', m), false, m);
});

test("instance-remove.sh revokes the instance's Siri device tokens, as its coordinator, before it exports; none works after", () => {
  const script = readFileSync(join(repoRoot, 'scripts', 'setup', 'instance-remove.sh'), 'utf8');
  const revoke = script.indexOf('instance siri-revoke-all');
  assert.ok(revoke > 0 && revoke < script.indexOf('export --instance'), 'revoked before the export, so the history records it');
  const stateDir = mkdtempSync(join(tmpdir(), 'siri-'));
  const node = { id: 'n1', name: 'phone-node' };
  const a = createDevice({ stateDir, instance: 'alpha', name: 'phone', by: 'owner' });
  const b = createDevice({ stateDir, instance: 'alpha', name: 'tablet', by: 'owner' });
  assert.equal(verifyToken({ stateDir, instance: 'alpha', token: a.token, node }).ok, true);
  assert.deepEqual(revokeAllDevices(stateDir, 'instance removed').sort(), [a.device.id, b.device.id].sort());
  for (const t of [a.token, b.token]) assert.equal(verifyToken({ stateDir, instance: 'alpha', token: t, node }).ok, false);
  assert.ok(readDevices(stateDir).every((d) => d.revokedBy === 'instance removed'));
  assert.deepEqual(revokeAllDevices(stateDir, 'instance removed'), [], 'again: nothing left to revoke');
});

test("a rename keeps the old instance home's directories but state/: archived whole, 0600, and listed by path and size", { skip: !posix && 'bash, tar, find' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'keep-'));
  const home = join(root, 'alpha');
  for (const [p, data] of [['state/events.db', 'history'], ['git-hooks/pre-push', '#!/bin/sh\n'], ['notes/keep-me.txt', 'twelve bytes'], ['.hidden/x', 'x']] as const) {
    mkdirSync(dirname(join(home, p)), { recursive: true });
    writeFileSync(join(home, p), data);
  }
  writeFileSync(join(home, 'instance.yaml'), 'name: alpha\n');
  const tarf = join(root, 'a.tar');
  const list = join(root, 'a.txt');
  const r = spawnSync('bash', ['-c', 'source "$1"; archive_dirs "$2" "$3" "$4"', '_', join(repoRoot, 'scripts', 'setup', 'lib.sh'), home, tarf, list], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const names = spawnSync('tar', ['-tf', tarf], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort();
  assert.ok(names.includes('notes/keep-me.txt') && names.includes('git-hooks/pre-push') && names.includes('.hidden/x'), names.join(' '));
  assert.ok(!names.some((n) => n.startsWith('state')), 'never the state: that is the export');
  assert.ok(!names.includes('instance.yaml'), 'only directories: the files are carried');
  assert.deepEqual(readFileSync(list, 'utf8').trim().split('\n'), ['.hidden/x\t1', 'git-hooks/pre-push\t10', 'notes/keep-me.txt\t12']);
  assert.match(r.stdout, /notes\/keep-me\.txt\t12/);
  for (const f of [tarf, list]) assert.equal(statSync(f).mode & 0o777, 0o600, f);
});

test("orphaned files are given to root:root only in the engine's own places, a link itself and never its target, nothing outside followed into; a refused chown is listed", { skip: !posix && 'bash, find' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'rechown-'));
  const mk = (p: string, data = 'x') => {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), data);
  };
  mk('engine/agent-slots/incidents.json');
  mk('engine/agent-slots/sub/keep.json');
  mk('outside/target.conf');
  mk('outside/dir/inner.txt');
  mk('locks/worklane-full-run.lock');
  mk('locks/other-tool.lock');
  mk('engine/agent-slots/suid-tool');
  // Planted links under an engine path: one at a file outside, one at a directory outside.
  spawnSync('ln', ['-s', join(root, 'outside/target.conf'), join(root, 'engine/agent-slots/link-to-file')]);
  spawnSync('ln', ['-s', join(root, 'outside/dir'), join(root, 'engine/agent-slots/link-to-dir')]);
  const calls = join(root, 'calls');
  const uid = String(process.getuid!());
  // chown and stat stood in for (a test isn't root): each call recorded, and one path refused.
  const chmods = join(root, 'chmods');
  // stat: 6755 for the planted setuid file until chmod strips it, else 640.
  const stubs = `chown() { printf '%s\\n' "$*" >> "${calls}"; case "$*" in *keep.json*) echo "Operation not permitted" >&2; return 1 ;; esac; }; chmod() { printf '%s\\n' "$*" >> "${chmods}"; case "$*" in *suid-tool*) : > "${root}/stripped" ;; esac; }; stat() { case "$*" in *%g*) case "$*" in *incidents.json*) echo 50 ;; *) echo 4242 ;; esac ;; *%U:%G*) case "$*" in *incidents.json*) echo root:agent-slots ;; *) echo root:root ;; esac ;; *suid-tool*) if [ -e "${root}/stripped" ]; then echo 755; else echo 6755; fi ;; *) echo 640 ;; esac; }`;
  const r = spawnSync('bash', ['-c', `source "$1"; ${stubs}; rechown_orphans "$2" "$3" "$4" 'worklane-*.lock' 4242,4243 ${uid}`, '_', join(repoRoot, 'scripts', 'setup', 'lib.sh'), join(root, 'list'), `${join(root, 'engine')}:${join(root, 'missing')}`, join(root, 'locks')], { encoding: 'utf8' });
  assert.equal(r.status, 1, 'a refused chown fails the step');
  const made = readFileSync(calls, 'utf8').trim().split('\n');
  for (const c of made) assert.match(c, /^-h root(:root)? -- /, `every chown is -h, to root: ${c}`);
  // The group goes to root only when it was the instance's (4242): the slot directory's agent-slots group (50) stays.
  assert.ok(made.some((c) => c === `-h root -- ${join(root, 'engine/agent-slots/incidents.json')}`), 'a shared file keeps its group');
  assert.ok(made.some((c) => c === `-h root:root -- ${join(root, 'engine/agent-slots/suid-tool')}`), "the instance's group goes to root");
  const paths = made.map((c) => c.replace(/^-h root(:root)? -- /, '')).sort();
  assert.ok(paths.includes(join(root, 'engine/agent-slots/link-to-file')), 'the link itself');
  assert.ok(paths.includes(join(root, 'locks/worklane-full-run.lock')), "the engine's lock file");
  assert.ok(!paths.some((p) => p.startsWith(join(root, 'outside'))), `nothing outside, never through a link: ${paths.join(' ')}`);
  assert.ok(!paths.some((p) => p.includes('link-to-dir/')), 'never into a linked directory');
  assert.ok(!paths.includes(join(root, 'locks/other-tool.lock')), "another program's lock in the shared directory is left alone");
  const list = readFileSync(join(root, 'list'), 'utf8');
  assert.match(list, new RegExp(`^root:agent-slots 640 -> 640 ${join(root, 'engine/agent-slots/incidents.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.ok(list.includes(`root:root 6755 -> 755 ${join(root, 'engine/agent-slots/suid-tool')}`), 'setuid and setgid stripped, the old mode listed');
  const cm = readFileSync(chmods, 'utf8').trim().split('\n');
  for (const c of cm) assert.match(c, /^u-s,g-s -- /, c);
  assert.ok(!cm.some((c) => c.includes('link-to')), 'never chmod through a link');
  assert.match(list, /^FAILED .*keep\.json: Operation not permitted$/m, 'a refused chown is listed, not hidden');

  // What they own outside the engine's places is listed (read-only), the removed home pruned.
  mk('home/wl-x/secret');
  const l = spawnSync('bash', ['-c', 'source "$1"; left_owned "$2" "$3" "$4" "$5"', '_', join(repoRoot, 'scripts', 'setup', 'lib.sh'), join(root, 'left'), join(root, 'outside'), join(root, 'outside/dir'), uid], { encoding: 'utf8' });
  assert.equal(l.status, 0, l.stderr);
  const listed = readFileSync(join(root, 'left'), 'utf8').trim().split('\n');
  assert.ok(listed.includes(join(root, 'outside/target.conf')), listed.join(' '));
  assert.ok(!listed.some((p) => p.startsWith(join(root, 'outside/dir'))), 'a skipped path is pruned');
});

// --- no process of the removed users left before userdel and the walk; the updater held off meanwhile

/** stop_uids with every system tool stood in for, as a log of what it ran; pgrep finds a process for <busy> passes. */
function stopRun(o: { busy: number; active?: string; passes?: number; noKill?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'stop-'));
  const log = join(root, 'log');
  const n = join(root, 'n');
  writeFileSync(n, '0');
  const stubs = [
    `user_exists() { case "$1" in wl-alpha|wl-alpha-agent) return 0 ;; esac; return 1; }`,
    `id() { case "$2" in wl-alpha) echo 1001 ;; wl-alpha-agent) echo 1002 ;; esac; }`,
    `usermod() { echo "usermod $*" >> "${log}"; }; loginctl() { echo "loginctl $*" >> "${log}"; }; sleep() { :; }`,
    `systemctl() { echo "systemctl $*" >> "${log}"; case "$1 \${3:-}" in "is-active ${o.active ?? '-'}") return 0 ;; "is-active "*) return 1 ;; esac; case "$1" in list-units) echo "worklane-test-alpha_r1_9.service loaded active running x"; echo "worklane-test-beta_r1_9.service loaded active running x" ;; show) case "$*" in *alpha_r1*) echo wl-alpha-agent ;; *beta*) echo wl-beta-agent ;; esac ;; esac; }`,
    // One pass is the first pkill of uid 1001; while fewer passes than <busy> have run, pgrep finds pid 4242 of 1001.
    `pkill() { echo "pkill $*" >> "${log}"; [ "$*" != "-KILL -U 1001" ] || echo $(($(cat "${n}") + 1)) > "${n}"; }`,
    `pgrep() { if [ "\${2:-}" = 1001 ] && [ "$(cat "${n}")" -lt ${o.busy} ]; then echo 4242; return 0; fi; return 1; }`,
  ].join('\n');
  const r = spawnSync('bash', ['-c', `source "$1"; ${stubs}; ${o.passes ? `STOP_PASSES=${o.passes};` : ''} stop_uids alpha wl-alpha wl-alpha-agent`, '_', join(repoRoot, 'scripts', 'setup', 'lib.sh')], { encoding: 'utf8', env: { ...process.env, ...(o.noKill ? { INSTANCE_REMOVE_TEST_NO_KILL: '1' } : {}) } });
  return { r, ran: existsSync(log) ? readFileSync(log, 'utf8') : '' };
}

test("before userdel: the accounts are locked, the users' engine units (User= checked) and slices stopped, then pkill by uid pass after pass until none is left", { skip: !posix && 'bash' }, () => {
  const { r, ran } = stopRun({ busy: 3 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(ran, /usermod -L -e 1 -s \/usr\/sbin\/nologin wl-alpha\n/);
  assert.ok(ran.indexOf('usermod -L') < ran.indexOf('pkill'), 'locked before anything is killed');
  assert.match(ran, /systemctl kill --signal=KILL worklane-test-alpha_r1_9\.service/);
  assert.doesNotMatch(ran, /systemctl (kill|stop)[^\n]*worklane-test-beta/, "another instance's unit is never killed or stopped (only its User= read)");
  assert.match(ran, /systemctl stop user@1001\.service user-1001\.slice/);
  assert.ok((ran.match(/^pkill -KILL -u /gm) ?? []).length >= 3, 'as many passes as it takes');
  assert.doesNotMatch(ran, /pkill .*-f|pkill [a-z]/, 'by uid, never a name');
});

test('a process that outlives every pass refuses the removal, named; one pass alone is not enough for one that forks', { skip: !posix && 'bash' }, () => {
  const { r } = stopRun({ busy: 1000 });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^4242 1001 /m, 'pid, uid, command');
  // The fail-without for the loop: a single pass leaves the forking process.
  assert.equal(stopRun({ busy: 3, passes: 1 }).r.status, 1);
  assert.equal(stopRun({ busy: 3 }).r.status, 0);
  // The test seam only ever finds more: no kill at all, and the process left refuses it.
  const seam = stopRun({ busy: 1, noKill: true });
  assert.equal(seam.r.status, 1);
  assert.doesNotMatch(seam.ran, /pkill|systemctl kill/);
});

test('with its coordinator running at the kill step, the removal refuses and the coordinator is left running: nothing is killed', { skip: !posix && 'bash' }, () => {
  const { r, ran } = stopRun({ busy: 1, active: 'worklane-alpha.service' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /worklane-alpha\.service is running .*sudo systemctl stop worklane-alpha\.service/);
  assert.doesNotMatch(ran, /pkill|systemctl (kill|stop)/, 'no kill and no stop');
  const d = stopRun({ busy: 1, active: 'worklane-dashboard-alpha.service' });
  assert.equal(d.r.status, 1);
  assert.doesNotMatch(d.ran, /pkill|systemctl (kill|stop)/);
});

/**
 * instance_in_flight over a stand-in process table (PROC_DIR), every pid the registry user's: 4242 outside every
 * allowed unit, 4243 exiting (its /proc dir reaped) right after its uid is read, 4244 in the user's own user manager,
 * 4245 still there but its cgroup unreadable, 4246 outside every allowed unit but exiting right after its cgroup read.
 */
function inFlightRun() {
  const root = mkdtempSync(join(tmpdir(), 'inflight-'));
  const proc = join(root, 'proc');
  const uid = process.getuid!();
  const pids: Record<string, [string, string]> = {
    '4242': ['0::/system.slice/cron.service', 'busy'],
    '4243': [`0::/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/forkloop.service`, 'sleep'],
    '4244': [`0::/user.slice/user-${uid}.slice/user@${uid}.service/init.scope`, 'systemd'],
    '4246': ['0::/system.slice/cron.service', 'brief'],
  };
  for (const [pid, [cg, comm]] of Object.entries(pids)) {
    mkdirSync(join(proc, pid), { recursive: true });
    writeFileSync(join(proc, pid, 'cgroup'), `${cg}\n`);
    writeFileSync(join(proc, pid, 'comm'), `${comm}\n`);
  }
  mkdirSync(join(proc, '4245'));
  writeFileSync(join(proc, '4245', 'comm'), 'odd\n');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'node'), `#!/bin/sh\nprintf 'user\\twl-alpha\\n'\n`, { mode: 0o755 });
  const stubs = [
    `user_exists() { [ "$1" = wl-alpha ]; }`,
    `id() { case "$1" in -u) echo ${uid} ;; -nu) echo wl-alpha ;; esac; }`,
    `systemctl() { echo inactive; }`,
    // The race, made certain: 4243 exits and is reaped between the uid read and the cgroup and comm reads.
    `stat() { local o; o="$(command stat "$@")" || return; [ "\${3:-}" != "$PROC_DIR/4243" ] || rm -rf -- "$PROC_DIR/4243"; printf '%s\\n' "$o"; }`,
    // And 4246 between its cgroup read and its comm read.
    `sed() { local rc=0; command sed "$@" || rc=$?; [ "\${3:-}" != "$PROC_DIR/4246/cgroup" ] || rm -rf -- "$PROC_DIR/4246"; return "$rc"; }`,
  ].join('\n');
  return spawnSync('bash', ['-c', `source "$1"; ${stubs}; PROC_DIR="$2"; instance_in_flight alpha`, '_', join(repoRoot, 'scripts', 'setup', 'lib.sh'), proc], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
}

test("work in flight: a process outside the instance's units is named; one that exits between its uid read and its cgroup read is not (a fork loop's short-lived children); one still there is, unreadable or not", { skip: !posix && 'bash, stat -c' }, () => {
  const r = inFlightRun();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'process 4242 (busy) as wl-alpha, in cron.service\nprocess 4245 (odd) as wl-alpha, in \n', 'the live ones outside its units, a failed read never a pass for one still there; the user manager is allowed');
});

test("the removal holds the updater off: an agent slot with its pid, busy to the updater's own quiet check, gone when it lets go", () => {
  const dir = mkdtempSync(join(tmpdir(), 'slots-'));
  const r2 = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'setup', 'instance-records.cjs')) as { holdSlot: (pid: number, owner: string, dir: string) => string; releaseSlot: (f: string, pid: number) => void; updaterQuiet: (dir: string) => { quiet: boolean; why?: string } };
  assert.equal(r2.updaterQuiet(dir).quiet, true);
  const f = r2.holdSlot(process.pid, 'instance-remove alpha', dir);
  assert.match(f, /agent-9\d\d\.lock$/);
  assert.deepEqual(r2.updaterQuiet(dir), { quiet: false, why: 'an agent is running' });
  r2.releaseSlot(f, process.pid + 1);
  assert.equal(r2.updaterQuiet(dir).quiet, false, "another pid can't let it go");
  r2.releaseSlot(f, process.pid);
  assert.equal(r2.updaterQuiet(dir).quiet, true);
  // A run that died: its hold is stale to the updater, and the next run takes it over.
  writeFileSync(f, JSON.stringify({ pid: 999999, owner: 'instance-remove alpha', acquiredAt: 'x' }));
  assert.equal(r2.updaterQuiet(dir).quiet, true);
  assert.equal(r2.holdSlot(process.pid, 'instance-remove alpha', dir), f);
});
