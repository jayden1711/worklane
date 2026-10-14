// No value of a run's variables in any argv. sudo logs its whole command line to the journal, any user on the machine
// reads a process's argv (ps, /proc/<pid>/cmdline), and systemctl show prints a transient unit's Environment=. The
// run's DATABASE_URL carries its database password. The coordinator passes the variables on stdin; the helper hands
// them to systemd in a root-only EnvironmentFile=, and the database password to docker in an --env-file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { runVars } from '../src/testrun/host.js';
import { repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const helperSrc = join(repoRoot, 'scripts', 'machine', 'worklane-testrun.sh');
// Everything systemd's EnvironmentFile= parser and a shell treat specially, and a non-ASCII letter.
const CANARY = `wl-canary can't "q" \\b $HOME \${X} \`id\` #h =e ü;|&<>*?`;
const pin = 'postgres:16@sha256:' + 'a'.repeat(64);

/** systemd's EnvironmentFile= reading of one KEY="value" line (src/basic/env-file.c, its double-quoted state). */
function systemdValue(line: string): [string, string] {
  const eq = line.indexOf('=');
  const key = line.slice(0, eq);
  const raw = line.slice(eq + 1);
  assert.ok(raw.startsWith('"') && raw.endsWith('"'), line);
  let v = '';
  for (let i = 1; i < raw.length - 1; i++) {
    const c = raw[i]!;
    if (c === '"') assert.fail(`an unescaped " ends the value early: ${line}`);
    if (c !== '\\') {
      v += c;
      continue;
    }
    const n = raw[++i]!;
    v += '"\\`$'.includes(n) ? n : `\\${n}`;
  }
  return [key, v];
}

/** The helper, runnable as this user: root-only tools stubbed, its paths in a temp dir, systemd-run and docker recording. */
async function helperCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'tr-env-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const stub = (n: string, body: string) => {
    writeFileSync(join(bin, n), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, n), 0o755);
  };
  const real = (t: string) => ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].map((d) => join(d, t)).find((p) => existsSync(p));
  const me = userInfo().username;
  const sdArgv = join(dir, 'systemd-run.argv');
  const sdEnv = join(dir, 'systemd-run.envfile');
  // systemd-run: its argv, and the EnvironmentFile it was given as it was while the unit ran (and its mode).
  stub('systemd-run', `[ "$1" = --version ] && { echo 'systemd 255 (test)'; exit 0; }
printf '%s\\n' "$@" > "${sdArgv}"
for a in "$@"; do case "$a" in EnvironmentFile=*) f="\${a#EnvironmentFile=}"; cp "$f" "${sdEnv}"; stat -c '%a' "$f" > "${sdEnv}.mode" 2>/dev/null || stat -f '%Lp' "$f" > "${sdEnv}.mode" ;; esac; done
echo ran`);
  for (const t of ['systemctl', 'getent', 'chown']) stub(t, 'exit 0');
  stub('id', `[ "$1" = -un ] && { echo '${me}'; exit 0; }; exit 0`);
  stub('runuser', 'while [ "$1" != -- ]; do shift; done; shift; exec "$@"');
  stub('rm', `a=(); for x in "$@"; do [ "$x" = --one-file-system ] || a+=("$x"); done; exec ${real('rm')} "\${a[@]}"`);
  stub('install', `a=(); while [ "$#" -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) a+=("$1"); shift ;; esac; done; exec ${real('install')} "\${a[@]}"`);
  const gnuStat = spawnSync(real('stat')!, ['--version']).status === 0;
  stub('stat', gnuStat ? `exec ${real('stat')} "$@"` : `[ "$1" = -c ] || exit 9; f="$2"; f="\${f//%U/%Su}"; f="\${f//%a/%Lp}"; shift 2; exec ${real('stat')} -f "$f" "$@"`);
  for (const t of ['git', 'cp', 'sha256sum', 'cut', 'mkdir', 'sh', 'cat', 'env', 'awk', 'sed', 'grep', 'tr', 'head', 'tail', 'od', 'seq', 'sleep', 'ls', 'dirname']) {
    const p = real(t);
    if (p) symlinkSync(p, join(bin, t));
  }
  // docker: its argv, and an --env-file's content and mode as they were when it read it.
  const dkArgv = join(dir, 'docker.argv');
  const dkEnv = join(dir, 'docker.envfile');
  const docker = join(dir, 'docker');
  writeFileSync(docker, `#!/bin/bash
printf '%s\\n' "$*" >> "${dkArgv}"
prev=; for a in "$@"; do [ "$prev" = --env-file ] && { cp "$a" "${dkEnv}"; }; prev="$a"; done
case "$1" in run) echo cid ;; port) echo 127.0.0.1:45678 ;; esac
exit 0
`);
  chmodSync(docker, 0o755);
  const base = join(dir, 'base');
  const tmpBase = join(dir, 't');
  const envDir = join(dir, 'env');
  const sock = join(dir, 's');
  mkdirSync(sock);
  let src = readFileSync(helperSrc, 'utf8');
  // A helper with no variables file has no ENV_DIR to move (one from before this change, for a fail-without).
  if (!/^ENV_DIR=\S+$/m.test(src)) mkdirSync(envDir);
  for (const [re, to] of [
    [/^export PATH=\S+$/m, `export PATH=${bin}`],
    [/^BASE=\S+$/m, `BASE=${base}`],
    [/^TMP_BASE=\S+$/m, `TMP_BASE=${tmpBase}`],
    [/^ENV_DIR=\S+$/m, `ENV_DIR=${envDir}`],
    [/^DOCKER=\S+$/m, `DOCKER=${docker}`],
    [/^sock_dir=.*$/m, `sock_dir=${sock}`],
    [/^user="wl-test-\$name"$/m, `user=${me}`],
  ] as const) {
    if (re.source.startsWith('^ENV_DIR') && !re.test(src)) continue;
    assert.match(src, re);
    src = src.replace(re, to);
  }
  const server = createServer();
  await new Promise<void>((res) => server.listen(join(sock, 'docker.sock'), res));
  const helper = join(dir, 'worklane-testrun');
  writeFileSync(helper, src);
  const name = 'shop';
  const id = 'fast-abc-1';
  // A run as create leaves it: its directory, and its TMPDIR (this user's, 0700) under a 0711 base.
  mkdirSync(join(base, name, 'runs', id, 'work'), { recursive: true });
  mkdirSync(tmpBase);
  chmodSync(tmpBase, 0o711);
  const hash = execFileSync('bash', ['-c', `printf '%s/%s' ${name} ${id} | ${real('sha256sum') ?? 'sha256sum'} | cut -c1-8`], { encoding: 'utf8' }).trim();
  mkdirSync(join(tmpBase, hash), { mode: 0o700 });
  chmodSync(join(tmpBase, hash), 0o700);
  const run = (args: string[], input?: string) => spawnSync('/bin/bash', [helper, name, ...args], { encoding: 'utf8', input, env: { PATH: '/usr/bin:/bin' }, timeout: 30_000 });
  const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  const done = () => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { id, envDir, run, sdArgv: () => read(sdArgv), sdEnv: () => read(sdEnv), sdEnvMode: () => read(`${sdEnv}.mode`).trim(), dkArgv: () => read(dkArgv), dkEnv: () => read(dkEnv), runDir: join(base, name, 'runs', id), done };
}

test('regression: the coordinator passes a run\'s variables to the helper on stdin, never in its argv', () => {
  assert.equal(runVars({ DATABASE_URL: 'postgres://postgres:pw@127.0.0.1:5/test', X: CANARY }), `DATABASE_URL=postgres://postgres:pw@127.0.0.1:5/test\0X=${CANARY}\0`);
  assert.throws(() => runVars({ X: 'a\nb' }), /one line/);
  assert.throws(() => runVars({ X: 'a\0b' }), /no NUL/);
  assert.throws(() => runVars({ 'BAD-NAME': 'x' }), /not a variable name/);
  // The host's exec: the only things in its argv are the run id, the cap and the command (the sandbox test checks
  // the call itself); the source never builds an --env argument.
  const host = readFileSync(join(repoRoot, 'src', 'testrun', 'host.ts'), 'utf8');
  const exec = host.slice(host.indexOf('    async exec(id, command, env, timeoutMs, signal) {'), host.indexOf('    async check() {'));
  assert.match(exec, /call\(\['exec', id, String\(.*\), '--', command\], \{ stdin: vars,/);
  assert.doesNotMatch(exec, /'--env'/);
});

test('regression: the helper hands a run\'s variables to systemd in a root-only EnvironmentFile, never on systemd-run\'s argv, and removes it', { skip: !posix && 'bash' }, async () => {
  const h = await helperCopy();
  try {
    const r = h.run(['exec', h.id, '60', '--', 'npm test'], runVars({ CANARY_VAR: CANARY, DATABASE_URL: 'postgres://postgres:sekrit@127.0.0.1:5/test' }));
    assert.equal(r.status, 0, r.stderr);
    const argv = h.sdArgv();
    assert.ok(argv.includes('npm test'), 'systemd-run ran the command');
    for (const v of ['wl-canary', 'sekrit', 'CANARY_VAR', 'DATABASE_URL']) assert.ok(!argv.includes(v), `${v} is not in systemd-run's argv`);
    const envfile = argv.split('\n').find((a) => a.startsWith('EnvironmentFile='));
    assert.ok(envfile?.startsWith(`EnvironmentFile=${h.envDir}/shop.${h.id}.`), argv);
    // As systemd read it: 0600, and each value exactly as given once systemd has parsed it.
    assert.equal(h.sdEnvMode(), '600');
    const lines = h.sdEnv().trim().split('\n');
    assert.deepEqual(lines.map(systemdValue), [['CANARY_VAR', CANARY], ['DATABASE_URL', 'postgres://postgres:sekrit@127.0.0.1:5/test']]);
    assert.deepEqual(readdirSync(h.envDir), [], 'removed once the run\'s command ended');
    // No variables: no file.
    assert.equal(h.run(['exec', h.id, '60', '--', 'true'], '').status, 0);
    assert.ok(!h.sdArgv().includes('EnvironmentFile='));
  } finally {
    h.done();
  }
});

test('the helper refuses variables in argv, an unended one on stdin, and the names it always refused', { skip: !posix && 'bash' }, async () => {
  const h = await helperCopy();
  try {
    const old = h.run(['exec', h.id, '60', '--env', `X=${CANARY}`, '--', 'true'], '');
    assert.equal(old.status, 2);
    assert.match(old.stderr, /usage: exec <id> <timeout_s> -- <command> \(the run's variables on stdin/);
    assert.equal(h.run(['exec', h.id, '60', '--', 'true'], 'X=no-nul').status, 2);
    for (const bad of ['GITHUB_TOKEN=x', 'PATH=/tmp', 'LD_PRELOAD=/x.so', 'STRIPE_SECRET=x', 'BAD-NAME=x']) {
      const r = h.run(['exec', h.id, '60', '--', 'true'], `${bad}\0`);
      assert.equal(r.status, 2, bad);
    }
    assert.equal(h.sdArgv(), '', 'systemd-run never ran');
  } finally {
    h.done();
  }
});

test('regression: wipe removes a run\'s variables file that an exec killed early left behind, and only that run\'s', { skip: !posix && 'bash' }, async () => {
  const h = await helperCopy();
  try {
    mkdirSync(h.envDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(h.envDir, `shop.${h.id}.123`), 'X="y"\n', { mode: 0o600 });
    writeFileSync(join(h.envDir, `shop.${h.id}-2.456`), 'X="y"\n', { mode: 0o600 });
    const w = h.run(['wipe', h.id]);
    assert.equal(w.status, 0, w.stderr);
    assert.deepEqual(readdirSync(h.envDir), [`shop.${h.id}-2.456`]);
  } finally {
    h.done();
  }
});

test('regression: db-start gives docker the database password in an --env-file, never in its argv, and removes the file', { skip: !posix && 'bash' }, async () => {
  const h = await helperCopy();
  try {
    const r = h.run(['db-start', h.id, pin, 'test', '5', '250']);
    assert.equal(r.status, 0, r.stderr);
    const m = /^45678 ([0-9a-f]{32})$/m.exec(r.stdout);
    assert.ok(m, r.stdout);
    const pw = m[1]!;
    assert.ok(!h.dkArgv().includes(pw), 'the password is in no docker argv');
    assert.match(h.dkArgv(), / --env-file \S+\/\.db-env -e POSTGRES_DB=test /);
    assert.equal(h.dkEnv(), `POSTGRES_PASSWORD=${pw}\n`);
    assert.ok(!existsSync(join(h.runDir, '.db-env')), 'and the file is gone');
  } finally {
    h.done();
  }
});
