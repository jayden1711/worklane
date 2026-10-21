// Issue #798, round 7 (the round-6 final check): a refusal for a link whose way enters /proc or /sys, or goes
// through a symlink under /dev, names the path at fault, not the directory above it ("(at '/')" for /proc, "(at
// '/dev')" for /dev/stdout), so the admin sees which hop to fix.
//
// No sudo, no namespace and no real state: the current user stands in for the agent user, its "home" is a temp dir,
// and the refusals come before the sandbox starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as osAdapter from '../src/os/index.js';

const skip = process.platform !== 'linux' && 'the Linux wrapper';

for (const [target, at] of [['/proc/1/comm', '/proc'], ['/sys/kernel', '/sys'], ['/dev/stdout', '/dev/stdout'], ['/dev/fd/0', '/dev/fd']] as const) {
  test(`a refused link to ${target} names ${at}, the path at fault`, { skip }, () => {
    const root = mkdtempSync(join(tmpdir(), 'wl-798-at-'));
    const home = join(root, 'agent');
    const work = join(root, 'work');
    for (const d of [home, work]) mkdirSync(d);
    symlinkSync(target, join(home, '.x'));
    const pc = osAdapter.projectCommand('echo ran > ran.txt', { user: 'shop-agent', home, hide: [] }, {});
    const r = spawnSync(pc.args[4]!, pc.args.slice(5), { cwd: work, env: {}, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(r.status, osAdapter.SANDBOX_UNAVAILABLE, `not refused: ${r.stdout}${r.stderr}`);
    assert.ok(r.stderr.includes(`(at '${at}')`), `doesn't name ${at}: ${r.stderr}`);
  });
}
