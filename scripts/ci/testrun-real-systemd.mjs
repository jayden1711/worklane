#!/usr/bin/env node
// CI only (the "test-run sandbox (real systemd)" job in .github/workflows/ci.yml): the coordinator's own sandbox
// host (dist/src/testrun/host.js), against the installed helper, the real sudoers rule and real systemd-run, run as
// the instance's coordinator user. No mocks: what this checks is exactly what the coordinator sees on a server.
//
//   node testrun-real-systemd.mjs <dir with dist/src> <instance> <db image@sha256:...|-> <fixture dir> <ids file>
//
// Prints systemd-run's raw stderr for one plain exec (the text test/fixtures/systemd-run-255/ holds), and fails
// if its summary isn't the shape the fixture has.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [dist, instance, dbImage, fixtures, idsFile] = process.argv.slice(2);
if (!dist || !instance || !dbImage || !fixtures || !idsFile) {
  console.error('usage: testrun-real-systemd.mjs <dist dir> <instance> <db image|-> <fixture dir> <ids file>');
  process.exit(2);
}
const load = (m) => import(pathToFileURL(join(dist, 'src', m)).href);
const { sandboxHost, newRunId, systemdRunStats, SANDBOX_HELPER } = await load('testrun/host.js');
const { createWorkspace, wipeWorkspace } = await load('testrun/workspace.js');
const step = (s) => console.log(`\n== ${s}`);

// A repo of this user's own: main, and a head commit on top of it.
const repo = mkdtempSync(join(homedir(), 'repo-'));
const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=ci', '-c', 'user.email=ci@example.com', ...a], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: homedir(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
git('init', '-q', '-b', 'main');
writeFileSync(join(repo, 'a.txt'), 'main\n');
git('add', 'a.txt');
git('commit', '-q', '-m', 'main');
writeFileSync(join(repo, 'b.txt'), 'the change\n');
git('add', 'b.txt');
git('commit', '-q', '-m', 'the change');
const sha = git('rev-parse', 'HEAD');

const host = sandboxHost(instance);
const id = newRunId('fast', sha);
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
assert.match(raw.stderr, /^Running as unit: \S+\.service; invocation ID: [0-9a-f]{32}\n/, 'the unit line is first, in the fixture\'s format');
const own = systemdRunStats(raw.stderr);
let rest = '';
let at = 0;
for (const [s, e] of own.own) (rest += raw.stderr.slice(at, s)), (at = e);
rest += raw.stderr.slice(at);
assert.equal(rest, '', 'every line of systemd-run\'s is recognised');
assert.ok(own.stats.memPeakMb !== null && own.stats.cpuS !== null, JSON.stringify(own.stats));

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

if (dbImage !== '-') {
  step(`db-start ${dbImage}`);
  const db = await host.startDb(id, { image: dbImage, name: 'test', readyS: 90 });
  console.log(db.url.replace(/:[0-9a-f]{32}@/, ':***@'), db.container);
  assert.ok(db.port > 0 && db.port < 65536);
  assert.match(db.url, new RegExp(`^postgres://postgres:[0-9a-f]{32}@127\\.0\\.0\\.1:${db.port}/test$`));
}

step(`wipe ${id}`);
await wipeWorkspace(host, id);
assert.deepEqual(await host.wipe(id), { ok: true, left: [] }, 'a second wipe finds nothing');
console.log('\nOK: the sandbox host works against real systemd-run');
