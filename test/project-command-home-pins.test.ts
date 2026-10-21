// Issue #798, round 4: what an allowed link in the agent's home reaches is pinned all the way, as walk() pins a
// credential's way. `~/.profile -> W/D/c`, W root's and writable by everyone (not sticky), D and c root's: pinning
// only W left D free to be renamed away, recreated, and c planted (S1); the same with a dangling link (S2). The
// planted file is what an agent-user process outside the sandbox reads through ~/.profile later.
//
// Root-owned, world-writable, non-sticky directories can't be made without root, so the test runs in a user
// namespace (`unshare --user --map-root-user --map-auto --mount`): its uid 0 (this user) stands in for root, its uid
// 1000 for the agent user, and every file lives on a tmpfs over /mnt in that private mount namespace. Nothing real is
// touched, and no sudo. Skipped where such a namespace, or bubblewrap inside it, isn't available.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as osAdapter from '../src/os/index.js';

const posix = process.platform === 'linux';
const NS = ['--user', '--map-root-user', '--map-auto', '--mount'];
const nsRuns = posix && spawnSync('unshare', [...NS, '/bin/sh', '-c', 'mount -t tmpfs none /mnt'], { stdio: 'ignore' }).status === 0;
const skip = !posix ? 'Linux only' : !nsRuns && 'needs `unshare --map-auto` (subordinate ids) to stand in for root and a second user';

/** The wrapper's argv after `sudo -n -u <agent> --`, NUL-separated, for the stand-in agent to run. */
function argsFile(dir: string, name: string, home: string, command: string): string {
  const pc = osAdapter.projectCommand(command, { user: 'shop-agent', home, hide: [] }, {});
  const f = join(dir, name);
  writeFileSync(f, `${pc.args.slice(4).join('\0')}\0`);
  return f;
}

// Run as the namespace's root: lay out each case on /mnt, run the wrapper as uid 1000 there, and print what the
// command's status was and what ~/.profile (or ~/.npmrc) reads afterwards, outside the sandbox.
const SCRIPT = String.raw`set -u
mount -t tmpfs -o mode=0755 none /mnt || { echo NOMOUNT; exit 0; }
setpriv --reuid=1000 --regid=1000 --clear-groups /usr/bin/bwrap --dev-bind / / --unshare-user --unshare-pid --proc /proc -- /bin/true 2>/dev/null || { echo NOSANDBOX; exit 0; }
run() { mapfile -d '' a < "$2"; ( cd "$1/work" && setpriv --reuid=1000 --regid=1000 --clear-groups "${'$'}{a[@]}" ) > "$1/out" 2> "$1/err"; echo "$3 status=$?"; }
lay() { mkdir -p "$1/agent" "$1/work" "$1/W/D"; chown 1000:1000 "$1/agent" "$1/work"; chmod 0777 "$1/W"; chmod 0755 "$1/W/D"; }
S=/mnt/s1; lay $S; printf '# root\n' > $S/W/D/c; chmod 0644 $S/W/D/c; ln -s $S/W/D/c $S/agent/.profile
run $S "$1" S1; echo "S1 reads=$(cat $S/agent/.profile)"; echo "S1 err=$(head -c 300 $S/err | tr '\n' ' ')"
S=/mnt/s2; lay $S; ln -s $S/W/D/missing $S/agent/.npmrc
run $S "$2" S2; echo "S2 reads=$(cat $S/agent/.npmrc 2>/dev/null)"; echo "S2 err=$(head -c 300 $S/err | tr '\n' ' ')"
`;

/** Both cases, run once in one namespace: each line the script printed, by key; null where it couldn't run there. */
let ran: ((k: string) => string) | null | undefined;
function results(): ((k: string) => string) | null {
  if (ran !== undefined) return ran;
  const dir = mkdtempSync(join(tmpdir(), 'wl-798-pin-'));
  const s1 = argsFile(dir, 's1', '/mnt/s1/agent', 'echo ran > ran.txt; mv /mnt/s1/W/D /mnt/s1/W/D.old && mkdir /mnt/s1/W/D && echo PLANTED > /mnt/s1/W/D/c; true');
  const s2 = argsFile(dir, 's2', '/mnt/s2/agent', 'echo ran > ran.txt; mv /mnt/s2/W/D /mnt/s2/W/D.old && mkdir /mnt/s2/W/D && echo PLANTED > /mnt/s2/W/D/missing; true');
  const script = join(dir, 'pins.sh');
  writeFileSync(script, SCRIPT);
  const r = spawnSync('unshare', [...NS, '/bin/bash', script, s1, s2], { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
  ran = /NOSANDBOX|NOMOUNT/.test(r.stdout) ? null : (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(r.stdout)?.[1] ?? `(no ${k}: ${r.stdout}${r.stderr})`;
  return ran;
}

test('S1: a link into a root-owned directory inside a writable one is allowed, and no directory on its way can be renamed away to plant the target', { skip }, (t) => {
  const line = results();
  if (!line) return t.skip('no bubblewrap or tmpfs inside the user namespace');
  // The link is allowed (a skeleton's shape), and the rename is refused: ~/.profile still reads root's file.
  assert.equal(line('S1 status'), '0', line('S1 err'));
  assert.equal(line('S1 reads'), '# root', `S1 planted: ${line('S1 err')}`);
});

test('S2: a dangling link through a writable directory is refused before the command runs: nothing can create its target', { skip }, (t) => {
  const line = results();
  if (!line) return t.skip('no bubblewrap or tmpfs inside the user namespace');
  assert.equal(line('S2 reads'), '', `S2 planted: ${line('S2 err')}`);
  assert.equal(line('S2 status'), String(osAdapter.SANDBOX_UNAVAILABLE), line('S2 err'));
});
