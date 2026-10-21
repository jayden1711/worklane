// Issue #798, round 7 (the round-6 adversarial review, A1): each symlink directly in ~/.config is walked hop by hop,
// as one directly in the home is. When ~/.config itself led outside the home (a root-owned home the agent can't
// write, `~/.config -> C`, C root's), its links were walked as if under the home: `<home>/<C>/<name>`, a path that
// doesn't exist, so the link passed as dangling inside the home, unchecked and unpinned. `C/git -> A/git`, A the
// agent's own, let a command plant `A/git/config`, which the agent's git read outside the sandbox later. Now such a
// link is walked from /, and refused as any link through an agent-owned directory is.
//
// Root-owned homes can't be made without root, so this runs in a user namespace, as the pins and way tests do
// (`unshare --user --map-root-user --map-auto --mount`): its uid 0 (this user) stands in for root, its uid 1000 for
// the agent user, and every file lives on a tmpfs over /mnt in that private mount namespace. Nothing real is touched,
// and no sudo. Skipped where such a namespace, or bubblewrap inside it, isn't available, unless
// PROJECT_SANDBOX_REQUIRED=1 makes that a failure (CI's test shards set it); a failing namespace script always fails.
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

// CF: a root-owned home, ~/.config -> C (root's, outside the home), C/git -> A/git, A the agent's own.
// CO: the same shape with C/ok -> R/ok, R and ok root's: an allowed link, so the command runs.
const SCRIPT = String.raw`set -u
mount -t tmpfs -o mode=0755 none /mnt || { echo NOMOUNT; exit 0; }
setpriv --reuid=1000 --regid=1000 --clear-groups /usr/bin/bwrap --dev-bind / / --unshare-user --unshare-pid --proc /proc -- /bin/true 2>/dev/null || { echo NOSANDBOX; exit 0; }
run() { mapfile -d '' a < "$2"; ( cd "$1/work" && setpriv --reuid=1000 --regid=1000 --clear-groups "${'$'}{a[@]}" ) > "$1/out" 2> "$1/err"; echo "$3 status=$?"; }
S=/mnt/cf; mkdir -p $S/hm $S/C $S/A $S/work; chown 1000:1000 $S/A $S/work; ln -s $S/C $S/hm/.config; ln -s $S/A/git $S/C/git
run $S "$1" CF; echo "CF ran=$([ -e $S/work/ran.txt ] && echo yes || echo no)"; echo "CF reads=$(cat $S/hm/.config/git/config 2>/dev/null)"; echo "CF err=$(head -c 400 $S/err | tr '\n' ' ')"
S=/mnt/co; mkdir -p $S/hm $S/C $S/R $S/work; chown 1000:1000 $S/work; printf '# root\n' > $S/R/ok; ln -s $S/C $S/hm/.config; ln -s $S/R/ok $S/C/ok
run $S "$2" CO; echo "CO ran=$([ -e $S/work/ran.txt ] && echo yes || echo no)"; echo "CO reads=$(cat $S/hm/.config/ok)"; echo "CO err=$(head -c 400 $S/err | tr '\n' ' ')"
`;

let ran: ((k: string) => string) | null | undefined;
function results(): ((k: string) => string) | null {
  if (ran !== undefined) return ran;
  const dir = mkdtempSync(join(tmpdir(), 'wl-798-cfg-'));
  const cf = argsFile(dir, 'cf', '/mnt/cf/hm', 'echo ran > ran.txt; mkdir -p /mnt/cf/A/git && echo PLANTED > /mnt/cf/A/git/config; true');
  const co = argsFile(dir, 'co', '/mnt/co/hm', 'echo ran > ran.txt; echo PLANTED > /mnt/co/R/ok; true');
  const script = join(dir, 'cfg.sh');
  writeFileSync(script, SCRIPT);
  const r = spawnSync('unshare', [...NS, '/bin/bash', script, cf, co], { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) assert.fail(`the namespace script failed (status ${r.status}): ${r.stdout}${r.stderr}`);
  if (/NOSANDBOX|NOMOUNT/.test(r.stdout)) {
    if (required) assert.fail(`PROJECT_SANDBOX_REQUIRED=1, but the namespace or bubblewrap in it didn't run: ${r.stdout}${r.stderr}`);
    ran = null;
  } else ran = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(r.stdout)?.[1] ?? `(no ${k}: ${r.stdout}${r.stderr})`;
  return ran;
}

test("a link in a ~/.config that leads outside the home is walked from there: one through the agent's own directory is refused, nothing planted", { skip }, (t) => {
  const line = results();
  if (!line) return t.skip('no bubblewrap or tmpfs inside the user namespace');
  assert.equal(line('CF reads'), '', `CF planted: ${line('CF err')}`);
  assert.equal(line('CF status'), String(osAdapter.SANDBOX_UNAVAILABLE), line('CF err'));
  assert.equal(line('CF ran'), 'no', line('CF err'));
  assert.match(line('CF err'), /'\/mnt\/cf\/C\/git'.*which the agent user owns/, line('CF err'));
});

test("a link in a ~/.config outside the home to root's file is allowed, and what it reaches stays read-only", { skip }, (t) => {
  const line = results();
  if (!line) return t.skip('no bubblewrap or tmpfs inside the user namespace');
  assert.equal(line('CO status'), '0', line('CO err'));
  assert.equal(line('CO ran'), 'yes', line('CO err'));
  assert.equal(line('CO reads'), '# root', line('CO err'));
});
