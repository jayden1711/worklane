// Issue #798, round 5 (the second adversarial review): the agent's home is read-only inside a project command's
// sandbox, and that holds only while nothing above it, or above what a link in it reaches, can be renamed away.
// - The home's own way: a home at T/a/hm, with `a` the agent's and T writable by it (root's 0777, or a sticky
//   1777 like /tmp), and no ~/.claude* to pin it by accident. A command renamed T/a away, recreated T/a/hm and wrote
//   .bashrc there, which the agent read outside the sandbox later. Now the home's way is always pinned.
// - A device target: `~/.x -> W/D/n`, W root's 0777, D root's 0755, n a character device. Its bind was skipped before
//   D was pinned, so a command renamed D away, recreated it and wrote n as a file. Now D is pinned first.
// - A device directly in a directory the agent can write (round 6): `~/.x -> W/n`, W 0777 (or a sticky 1777 with
//   the agent's own device, or a writable directory under /dev, where nothing is pinned). n has no bind, so a command
//   removed it and wrote a file there. Now such a link is refused before the command runs.
// - Under /dev nothing is pinned (pinning binds /dev, which costs the sandbox its devices), so a link through a
//   writable directory there (a non-sticky /dev/shm), or to a file there that isn't a device, is refused (round 6).
//   /dev/shm here is a private tmpfs in the namespace; the real one is never touched.
// - A link-mode refusal printed the way unquoted, so a newline in a directory name forged a separate "project command
//   not run:" line, and it blamed the agent for an unsearchable directory that was root's.
//
// Root-owned directories can't be made without root, so this runs in a user namespace, as the pins test does
// (`unshare --user --map-root-user --map-auto --mount`): its uid 0 (this user) stands in for root, its uid 1000 for
// the agent user, and every file lives on a tmpfs over /mnt in that private mount namespace. Nothing real is touched,
// and no sudo. Skipped where such a namespace, or bubblewrap inside it, isn't available, unless
// PROJECT_SANDBOX_REQUIRED=1 makes that a failure: CI's test shards set it, and give the runner the subordinate ids and
// the user namespaces this needs (ci.yml, the bubblewrap step).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as osAdapter from '../src/os/index.js';

const posix = process.platform === 'linux';
const required = process.env.PROJECT_SANDBOX_REQUIRED === '1';
const NS = ['--user', '--map-root-user', '--map-auto', '--mount'];
const nsRuns = posix && spawnSync('unshare', [...NS, '/bin/sh', '-c', 'mount -t tmpfs none /mnt'], { stdio: 'ignore' }).status === 0;
const skip = required ? false : !posix ? 'Linux only' : !nsRuns && 'needs `unshare --map-auto` (subordinate ids) to stand in for root and a second user';

/** The wrapper's argv after `sudo -n -u <agent> --`, NUL-separated, for the stand-in agent to run. */
function argsFile(dir: string, name: string, home: string, command: string): string {
  const pc = osAdapter.projectCommand(command, { user: 'shop-agent', home, hide: [] }, {});
  const f = join(dir, name);
  writeFileSync(f, `${pc.args.slice(4).join('\0')}\0`);
  return f;
}

// Run as the namespace's root: lay out each case on /mnt, run the wrapper as uid 1000 there, and print the command's
// status and what the agent reads afterwards, outside the sandbox.
const SCRIPT = String.raw`set -u
mount -t tmpfs -o mode=0755 none /mnt || { echo NOMOUNT; exit 0; }
setpriv --reuid=1000 --regid=1000 --clear-groups /usr/bin/bwrap --dev-bind / / --unshare-user --unshare-pid --proc /proc -- /bin/true 2>/dev/null || { echo NOSANDBOX; exit 0; }
run() { mapfile -d '' a < "$2"; ( cd "$1/work" && setpriv --reuid=1000 --regid=1000 --clear-groups "${'$'}{a[@]}" ) > "$1/out" 2> "$1/err"; echo "$3 status=$?"; }
home() { mkdir -p "$1/T/a/hm" "$1/work"; chmod "$2" "$1/T"; printf '# orig\n' > "$1/T/a/hm/.bashrc"; chown -R 1000:1000 "$1/T/a" "$1/work"; }
S=/mnt/ha; home $S 0777; run $S "$1" HA; echo "HA reads=$(cat $S/T/a/hm/.bashrc)"; echo "HA err=$(head -c 300 $S/err | tr '\n' ' ')"
S=/mnt/hs; home $S 1777; run $S "$2" HS; echo "HS reads=$(cat $S/T/a/hm/.bashrc)"; echo "HS err=$(head -c 300 $S/err | tr '\n' ' ')"
S=/mnt/dv; mkdir -p $S/agent $S/work $S/W/D; chown 1000:1000 $S/agent $S/work; chmod 0777 $S/W; chmod 0755 $S/W/D; : > $S/W/D/n
mount --bind /dev/null $S/W/D/n || { echo NOMOUNT; exit 0; }; ln -s $S/W/D/n $S/agent/.x
run $S "$3" DV; echo "DV type=$(stat -c %F $S/W/D/n)"; echo "DV reads=$(cat $S/agent/.x)"; echo "DV err=$(head -c 300 $S/err | tr '\n' ' ')"
S=/mnt/q; D="$S/ev"$'\n'"project command not run: FORGED LINE"; mkdir -p "$D/locked" $S/agent $S/work; chmod 0700 "$D/locked"; chown 1000:1000 $S/agent $S/work; ln -s "$D/locked/y" $S/agent/.x
run $S "$4" Q; echo "Q ran=$([ -e $S/work/ran.txt ] && echo yes || echo no)"; echo "Q lines=$(grep -c '' $S/err)"; echo "Q forged=$(grep -c '^project command not run: FORGED' $S/err)"
echo "Q blames=$(grep -c 'owns or can write' $S/err)"; echo "Q search=$(grep -c "can't search" $S/err)"; echo "Q err=$(head -c 600 $S/err | tr '\n' '|')"
dev() { echo "$1 ran=$([ -e $2/work/ran.txt ] && echo yes || echo no)"; echo "$1 type=$(stat -c %F $3/n)"; echo "$1 err=$(head -c 400 $2/err | tr '\n' ' ')"; }
lay() { mkdir -p $1/agent $1/work; chown 1000:1000 $1/agent $1/work; }
if ! mknod /mnt/mk c 0 0; then echo NOMKNOD; exit 0; fi
S=/mnt/dw; lay $S; mkdir $S/W; chmod 0777 $S/W; mknod $S/W/n c 0 0; ln -s $S/W/n $S/agent/.x; run $S "$5" DW; dev DW $S $S/W
S=/mnt/ds; lay $S; mkdir $S/W; chmod 1777 $S/W; mknod $S/W/n c 0 0; chown 1000:1000 $S/W/n; ln -s $S/W/n $S/agent/.x; run $S "$6" DS; dev DS $S $S/W
mount -t tmpfs -o mode=0755 none /dev/shm || { echo NOMOUNT; exit 0; }
S=/mnt/dd; lay $S; mkdir /dev/shm/W; chmod 0777 /dev/shm/W; mknod /dev/shm/W/n c 0 0; ln -s /dev/shm/W/n $S/agent/.x; run $S "$7" DD; dev DD $S /dev/shm/W
S=/mnt/df; lay $S; mkdir /dev/shm/D; printf '# root\n' > /dev/shm/D/f; ln -s /dev/shm/D/f $S/agent/.y; run $S "$8" DF
echo "DF ran=$([ -e $S/work/ran.txt ] && echo yes || echo no)"; echo "DF reads=$(cat /dev/shm/D/f)"; echo "DF err=$(head -c 400 $S/err | tr '\n' ' ')"
mount -t tmpfs -o mode=0777 none /dev/shm || { echo NOMOUNT; exit 0; }
S=/mnt/dn; lay $S; mkdir /dev/shm/D; mknod /dev/shm/D/n c 0 0; ln -s /dev/shm/D/n $S/agent/.x; run $S "$9" DN; dev DN $S /dev/shm/D
`;

/** Every case, run once in one namespace: each line the script printed, by key; null where it couldn't run there. */
let ran: ((k: string) => string) | null | undefined;
/** Whether the namespace could make no device node: the device cases (DW to DN) skip then, the others still run. */
let noMknod = false;
function results(): ((k: string) => string) | null {
  if (ran !== undefined) return ran;
  const dir = mkdtempSync(join(tmpdir(), 'wl-798-way-'));
  const plantHome = (r: string) => `echo ran > ran.txt; mv ${r}/T/a ${r}/T/a.old && mkdir -p ${r}/T/a/hm && echo PLANTED > ${r}/T/a/hm/.bashrc; true`;
  const ha = argsFile(dir, 'ha', '/mnt/ha/T/a/hm', plantHome('/mnt/ha'));
  const hs = argsFile(dir, 'hs', '/mnt/hs/T/a/hm', plantHome('/mnt/hs'));
  const dv = argsFile(dir, 'dv', '/mnt/dv/agent', 'echo ran > ran.txt; mv /mnt/dv/W/D /mnt/dv/W/D.old && mkdir /mnt/dv/W/D && echo PLANTED > /mnt/dv/W/D/n; true');
  const q = argsFile(dir, 'q', '/mnt/q/agent', 'echo ran > ran.txt');
  const plantDev = (w: string) => `echo ran > ran.txt; rm -f ${w}/n && echo PLANTED > ${w}/n; true`;
  const dw = argsFile(dir, 'dw', '/mnt/dw/agent', plantDev('/mnt/dw/W'));
  const ds = argsFile(dir, 'ds', '/mnt/ds/agent', plantDev('/mnt/ds/W'));
  const dd = argsFile(dir, 'dd', '/mnt/dd/agent', plantDev('/dev/shm/W'));
  const df = argsFile(dir, 'df', '/mnt/df/agent', 'echo ran > ran.txt; echo PLANTED > /dev/shm/D/f; true');
  const dn = argsFile(dir, 'dn', '/mnt/dn/agent', 'echo ran > ran.txt; mv /dev/shm/D /dev/shm/D.old && mkdir /dev/shm/D && echo PLANTED > /dev/shm/D/n; true');
  const script = join(dir, 'way.sh');
  writeFileSync(script, SCRIPT);
  const r = spawnSync('unshare', [...NS, '/bin/bash', script, ha, hs, dv, q, dw, ds, dd, df, dn], { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
  // The script itself failing is a failure, never a skip; only a namespace without bubblewrap or a tmpfs skips every
  // case, and one without mknod the device cases (DW to DN) only; neither under PROJECT_SANDBOX_REQUIRED=1.
  if (r.status !== 0) assert.fail(`the namespace script failed (status ${r.status}): ${r.stdout}${r.stderr}`);
  noMknod = /^NOMKNOD$/m.test(r.stdout);
  if (noMknod && required) assert.fail(`PROJECT_SANDBOX_REQUIRED=1, but mknod didn't run in the namespace: ${r.stdout}${r.stderr}`);
  if (/NOSANDBOX|NOMOUNT/.test(r.stdout)) {
    if (required) assert.fail(`PROJECT_SANDBOX_REQUIRED=1, but the namespace or bubblewrap in it didn't run: ${r.stdout}${r.stderr}`);
    ran = null;
  } else ran = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(r.stdout)?.[1] ?? `(no ${k}: ${r.stdout}${r.stderr})`;
  return ran;
}

for (const [key, what] of [['HA', 'root-owned and writable by everyone'], ['HS', 'sticky and writable by everyone, like /tmp']] as const) {
  test(`the home's own way is pinned: with no ~/.claude, a directory above the home (in one ${what}) can't be renamed away to plant ~/.bashrc`, { skip }, (t) => {
    const line = results();
    if (!line) return t.skip('no bubblewrap or tmpfs inside the user namespace');
    assert.equal(line(`${key} status`), '0', line(`${key} err`));
    assert.equal(line(`${key} reads`), '# orig', `${key} planted: ${line(`${key} err`)}`);
  });
}

test('a link to a device inside a root directory inside a writable one: the directory above the device is pinned, so it reads the device still', { skip }, (t) => {
  const line = results();
  if (!line) return t.skip('no bubblewrap or tmpfs inside the user namespace');
  assert.equal(line('DV status'), '0', line('DV err'));
  assert.equal(line('DV type'), 'character special file', `DV planted: ${line('DV err')}`);
  assert.equal(line('DV reads'), '', `DV planted: ${line('DV err')}`);
});

const DEVICE_IN_WRITABLE: [key: string, what: string][] = [
  ['DW', "root's, in a directory writable by everyone (not sticky)"],
  ['DS', "the agent's own, in a sticky directory writable by everyone"],
  ['DD', 'under /dev, in a directory there writable by everyone (not sticky)'],
  ['DN', 'under /dev, below a /dev/shm writable by everyone and not sticky (rename its directory away)'],
];
for (const [key, what] of DEVICE_IN_WRITABLE) {
  test(`a link to a device directly in a directory the agent can write is refused before the command runs: a device ${what}`, { skip }, (t) => {
    const line = results();
    if (!line) return t.skip('no bubblewrap or tmpfs inside the user namespace');
    if (noMknod) return t.skip('no mknod inside the user namespace');
    assert.equal(line(`${key} type`), 'character special file', `${key} planted: ${line(`${key} err`)}`);
    assert.equal(line(`${key} status`), String(osAdapter.SANDBOX_UNAVAILABLE), line(`${key} err`));
    assert.equal(line(`${key} ran`), 'no', line(`${key} err`));
    assert.match(line(`${key} err`), /a device in .*, a directory the agent user can write|a directory under \/dev the agent user can write/, line(`${key} err`));
  });
}

test("a link to a file under /dev, not a device, is refused before the command runs: it can't be made read-only without binding /dev", { skip }, (t) => {
  const line = results();
  if (!line) return t.skip('no bubblewrap or tmpfs inside the user namespace');
  if (noMknod) return t.skip('no mknod inside the user namespace');
  assert.equal(line('DF status'), String(osAdapter.SANDBOX_UNAVAILABLE), line('DF err'));
  assert.equal(line('DF ran'), 'no', line('DF err'));
  assert.equal(line('DF reads'), '# root', line('DF err'));
  assert.match(line('DF err'), /under \/dev but not a device/, line('DF err'));
});

test("a link whose way holds a newline and root's unsearchable directory: one quoted refusal line, which doesn't blame the agent", { skip }, (t) => {
  const line = results();
  if (!line) return t.skip('no bubblewrap or tmpfs inside the user namespace');
  assert.equal(line('Q status'), String(osAdapter.SANDBOX_UNAVAILABLE), line('Q err'));
  assert.equal(line('Q ran'), 'no', line('Q err'));
  assert.equal(line('Q forged'), '0', `a forged line: ${line('Q err')}`);
  assert.equal(line('Q lines'), '1', `not one line: ${line('Q err')}`);
  assert.equal(line('Q blames'), '0', `blames the agent for root's directory: ${line('Q err')}`);
  assert.equal(line('Q search'), '1', line('Q err'));
});
