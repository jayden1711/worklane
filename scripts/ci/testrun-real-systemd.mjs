#!/usr/bin/env node
// CI only (the "test-run sandbox (real systemd)" job in .github/workflows/ci-slow.yml): the coordinator's own sandbox
// host (dist/src/testrun/host.js), against the installed helper, the real sudoers rule and real systemd-run, run as
// the instance's coordinator user. No mocks: what this checks is exactly what the coordinator sees on a server.
//
//   node testrun-real-systemd.mjs <dir with dist/src> <instance> <db image@sha256:...|-> <fixture dir> <ids file>
//   node testrun-real-systemd.mjs --wipe <dir with dist/src> <instance> <ids file>
//
// Prints systemd-run's raw stderr for one plain exec (the text test/fixtures/systemd-run-255/ holds), and fails
// if its summary isn't the shape the fixture has. With a database image it starts the run's database, checks
// Postgres answers on its port, writes the container's name to "<ids file>.db" and leaves the run in place, so the
// job can look at the container's cgroup as root; --wipe then wipes every run in the ids file.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const step = (s) => console.log(`\n== ${s}`);
const load = (dist, m) => import(pathToFileURL(join(dist, 'src', m)).href);

if (process.argv[2] === '--wipe') {
  const [dist, instance, idsFile] = process.argv.slice(3);
  if (!dist || !instance || !idsFile) {
    console.error('usage: testrun-real-systemd.mjs --wipe <dist dir> <instance> <ids file>');
    process.exit(2);
  }
  const { sandboxHost } = await load(dist, 'testrun/host.js');
  const { wipeWorkspace } = await load(dist, 'testrun/workspace.js');
  const host = sandboxHost(instance);
  for (const id of readFileSync(idsFile, 'utf8').split('\n').filter(Boolean)) {
    step(`wipe ${id}`);
    await wipeWorkspace(host, id);
    assert.deepEqual(await host.wipe(id), { ok: true, left: [] }, 'a second wipe finds nothing');
  }
  console.log('\nOK: wiped');
  process.exit(0);
}

const [dist, instance, dbImage, fixtures, idsFile] = process.argv.slice(2);
if (!dist || !instance || !dbImage || !fixtures || !idsFile) {
  console.error('usage: testrun-real-systemd.mjs <dist dir> <instance> <db image|-> <fixture dir> <ids file>');
  process.exit(2);
}
const { sandboxHost, newRunId, systemdRunStats, SANDBOX_HELPER } = await load(dist, 'testrun/host.js');
const { createWorkspace, wipeWorkspace } = await load(dist, 'testrun/workspace.js');
const { checkHelper, HELPER_PROTOCOL } = await load(dist, 'testrun/helper.js');

// Postgres itself answers on the port: an SSLRequest gets its one-byte reply, 'S' or 'N'.
const postgresAnswers = (port) => new Promise((resolve, reject) => {
  const sock = connect({ host: '127.0.0.1', port }, () => sock.write(Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f])));
  sock.setTimeout(10_000, () => sock.destroy(new Error('no reply in 10 s')));
  sock.once('data', (b) => { sock.destroy(); resolve(String.fromCharCode(b[0])); });
  sock.once('error', reject);
});

// A repo of this user's own: main, and a head commit on top of it.
const repo = mkdtempSync(join(homedir(), 'repo-'));
const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=ci', '-c', 'user.email=ci@example.com', ...a], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: homedir(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
git('init', '-q', '-b', 'main');
writeFileSync(join(repo, 'a.txt'), 'main\n');
mkdirSync(join(repo, 'art'));
writeFileSync(join(repo, 'art', 'cards.bin'), 'binary\n');
git('add', 'a.txt', 'art');
git('commit', '-q', '-m', 'main');
writeFileSync(join(repo, 'b.txt'), 'the change\n');
git('add', 'b.txt');
git('commit', '-q', '-m', 'the change');
const sha = git('rev-parse', 'HEAD');

const host = sandboxHost(instance);
const id = newRunId('fast', sha);

step('the helper\'s protocol, asked through sudo as the coordinator asks it at start');
const proto = await checkHelper(host, instance);
console.log(JSON.stringify(proto));
assert.deepEqual([proto.ok, proto.have], [true, HELPER_PROTOCOL], proto.detail);
appendFileSync(idsFile, `${id}\n`);

step(`create ${id} from a bundle`);
const ws = await createWorkspace(host, repo, sha, id);
console.log(ws.workdir);
assert.match(ws.workdir, new RegExp(`/runs/${id}/work$`));

step('systemd-run\'s raw output for a plain exec (the fixture\'s text)');
const raw = spawnSync('sudo', ['-n', SANDBOX_HELPER, instance, 'exec', id, '60', '--', 'echo probed'], { encoding: 'utf8', env: { PATH: '/usr/local/bin:/usr/bin:/bin' } });
console.log(`exit ${raw.status}\n--- stdout\n${raw.stdout}--- stderr\n${raw.stderr}--- stderr, as JSON\n${JSON.stringify(raw.stderr)}`);
assert.equal(raw.status, 0);
assert.equal(raw.stdout, 'probed\n', 'the run\'s stdout is its own: systemd-run prints nothing there');
const keys = (stderr) => stderr.slice(stderr.lastIndexOf('Finished with result: ')).trimEnd().split('\n').map((l) => l.slice(0, l.indexOf(': ')));
assert.deepEqual(keys(raw.stderr), keys(readFileSync(join(fixtures, 'probe.stderr'), 'utf8')), 'the summary has the fixture\'s lines, in its order');
assert.match(raw.stderr, /^Running as unit: \S+\.service(?:; invocation ID: [0-9a-f]{32})?\n/, 'the unit line is first (with or without its invocation ID, as systemd 255 builds differ)');
const own = systemdRunStats(raw.stderr);
let rest = '';
let at = 0;
for (const [s, e] of own.own) (rest += raw.stderr.slice(at, s)), (at = e);
rest += raw.stderr.slice(at);
assert.equal(rest, '', 'every line of systemd-run\'s is recognised');
assert.ok(own.stats.memPeakMb !== null && own.stats.cpuS !== null, JSON.stringify(own.stats));

step('exec: a tier command\'s shell-only ${...} is bash\'s, not systemd\'s');
const shellVars = await host.exec(id, 'x=hello; set -- one two; echo "got ${x} ${x%lo} ${#x} ${2} $x ${HOME:+home}"', {}, 60_000);
console.log(JSON.stringify(shellVars.out));
assert.equal(shellVars.code, 0);
assert.match(shellVars.out, /^got hello hel 5 two hello home$/m, 'every ${...} expanded by bash');

step('exec: stdout, stderr and planted summary-like lines, through the coordinator\'s host');
const cmd = [
  'echo out-line',
  'echo err-line >&2',
  'echo "Memory peak: 999G" >&2',
  'echo "CPU time consumed: 1h" >&2',
  'head -c 400000000 /dev/zero | sha256sum',
  'echo out-done',
  "printf 'no newline at the end' >&2",
].join('; ');
const r = await host.exec(id, cmd, { SOME_VAR: 'x' }, 120_000);
console.log(JSON.stringify(r, null, 2));
assert.equal(r.code, 0);
for (const l of ['out-line', 'err-line', 'Memory peak: 999G', 'CPU time consumed: 1h', 'out-done', 'no newline at the end']) assert.ok(r.out.includes(l), `the run's own "${l}" is kept`);
assert.match(r.out, /^[0-9a-f]{64} {2}-$/m, 'sha256sum\'s line');
assert.doesNotMatch(r.out, /Running as unit:|Finished with result:|Main processes terminated with:|Service runtime:|Memory swap peak:/, 'systemd-run\'s own lines are taken out');
assert.equal(r.out.match(/Memory peak:/g)?.length, 1, 'only the run\'s own Memory peak line is left');
const { cpuS, memPeakMb } = r.stats;
assert.ok(typeof cpuS === 'number' && cpuS >= 0.1 && cpuS < 60, `CPU ${cpuS}s: from systemd, not the planted 1h`);
assert.ok(typeof memPeakMb === 'number' && memPeakMb > 0 && memPeakMb < 2048, `memory ${memPeakMb} MB: from systemd, not the planted 999G`);

step('the object store: a second run of the commit gets no bundle, reads the store, leaves art/ out, and can\'t write the store');
assert.ok((await host.storeTips()).includes(sha), 'the first run\'s commit is one of the store\'s tips');
const id2 = newRunId('fast', sha);
appendFileSync(idsFile, `${id2}\n`);
const ws2 = await createWorkspace(host, repo, sha, id2, ['art']);
console.log(JSON.stringify(ws2));
assert.equal(ws2.bundleRefs, 0, 'the store has the commit and main: nothing sent');
const store = `/var/lib/worklane-test/${instance}/store`;
const probe = await host.exec(id2, [
  's="$(dirname "$(cat .git/objects/info/alternates)")"; echo "store $s"',
  'git cat-file -e HEAD:b.txt && echo read-ok',
  'test ! -e art && echo art-left-out',
  'echo "art in the commit: $(git ls-tree -r --name-only HEAD | grep -c "^art/")"',
  'test -z "$(git status --porcelain)" && echo clean',
  'for w in "$s/objects/probe" "$s/objects/pack/probe" "$s/refs/keep/probe" "$s/probe" "$s/HEAD"; do if ( : >> "$w" ) 2>/dev/null; then echo "WROTE $w"; else echo "refused $w"; fi; done',
  'git --git-dir="$s" update-ref refs/keep/evil HEAD 2>/dev/null && echo "WROTE a ref"',
  'true',
].join('\n'), {}, 60_000);
console.log(probe.out);
assert.equal(probe.code, 0);
assert.match(probe.out, new RegExp(`^store ${store}$`, 'm'), 'the workspace reads the instance\'s own store');
for (const want of ['read-ok', 'art-left-out', 'art in the commit: 1', 'clean']) assert.match(probe.out, new RegExp(`^${want}$`, 'm'), want);
assert.doesNotMatch(probe.out, /WROTE/, 'a run never writes the store');
assert.equal(probe.out.match(/^refused /gm)?.length, 5);
assert.throws(() => readdirSync(store), /EACCES/, 'the coordinator user can\'t read the test user\'s store');

if (dbImage !== '-') {
  step(`db-start ${dbImage}, max_connections 250`);
  // Not the default (200) nor the image's (100): the job checks SHOW max_connections is 250 inside the database.
  const db = await host.startDb(id, { image: dbImage, name: 'test', readyS: 90, maxConnections: 250 });
  console.log(db.url.replace(/:[0-9a-f]{32}@/, ':***@'), db.container);
  assert.ok(db.port > 0 && db.port < 65536);
  assert.match(db.url, new RegExp(`^postgres://postgres:[0-9a-f]{32}@127\\.0\\.0\\.1:${db.port}/test$`));
  const reply = await postgresAnswers(db.port);
  console.log(`Postgres on 127.0.0.1:${db.port} answers an SSLRequest with '${reply}'`);
  assert.ok(reply === 'S' || reply === 'N', `Postgres's reply: ${JSON.stringify(reply)}`);
  writeFileSync(`${idsFile}.db`, `${db.container}\n`);
  console.log(`\nOK: the sandbox host works against real systemd-run; run ${id} and its database are left for the cgroup check`);
} else {
  step(`wipe ${id}`);
  await wipeWorkspace(host, id);
  assert.deepEqual(await host.wipe(id), { ok: true, left: [] }, 'a second wipe finds nothing');
  console.log('\nOK: the sandbox host works against real systemd-run');
}
