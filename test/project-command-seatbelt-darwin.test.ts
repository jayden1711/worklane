// Issue #798, round 12 (the round-11 delta check): projectCommand's macOS branch itself must build its profile with
// seatbeltProfileFor, which refuses a home that isn't its own canonical path (seatbelt matches canonical paths). Had
// the branch gone back to seatbeltProfile, no test failed. And the resolver must be the OS's own (realpathSync.native):
// Node's JS realpath keeps the case it was given, so on a case-insensitive disk `/Volumes/Agent` could pass for the real
// `/Volumes/agent`. Driven on any platform: the platform and the resolver are injected, as sandboxTool is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Namespace import: on the code before this change a name it lacks is undefined, not a load error.
import * as osAdapter from '../src/os/index.js';

type Opts = { platform?: 'linux' | 'darwin'; realpath?: (p: string) => string };
const darwin = (home: string, o: Opts = {}) =>
  (osAdapter.projectCommand as unknown as (c: string, r: osAdapter.ProjectRunAs, e: Record<string, string>, o: Opts) => { file: string; args: string[] })('true', { user: 'shop-agent', home, hide: [] }, {}, { platform: 'darwin', ...o });

function canonicalHome(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wl-798-dw-')));
  mkdirSync(join(root, 'agent'));
  return join(root, 'agent');
}

test("projectCommand on macOS refuses a home reached through a symlink: the sandbox's write rule wouldn't match it", () => {
  const home = canonicalHome();
  const link = join(home, '..', 'link-agent');
  symlinkSync(home, link);
  assert.throws(() => darwin(link), /isn't its canonical path/);
});

test("projectCommand on macOS refuses a home that can't be resolved", () => {
  assert.throws(() => darwin(join(canonicalHome(), 'missing')), /can't be resolved/);
});

test('projectCommand on macOS refuses a home whose case differs from the case the disk stores (a case-insensitive disk)', () => {
  assert.throws(() => darwin('/Volumes/Agent', { realpath: (p) => p.toLowerCase() }), /isn't its canonical path.*\/volumes\/agent/);
});

test('projectCommand on macOS runs a canonical home under sandbox-exec, with the profile that denies every write under it', () => {
  const home = canonicalHome();
  const pc = darwin(home);
  const i = pc.args.indexOf('/usr/bin/sandbox-exec');
  assert.ok(i >= 0, `no sandbox-exec: ${pc.file} ${pc.args.join(' ')}`);
  assert.equal(pc.args[i + 1], '-p');
  assert.equal(pc.args[i + 2], osAdapter.seatbeltProfile(home, []));
});

test("seatbeltProfileFor resolves the home with the OS's own realpath (realpathSync.native), not Node's JS one", () => {
  const native = fs.realpathSync.native;
  const seen: string[] = [];
  (fs.realpathSync as unknown as { native: (p: string) => string }).native = (p: string) => {
    seen.push(p);
    return p.toLowerCase();
  };
  try {
    assert.throws(() => osAdapter.seatbeltProfileFor('/Volumes/Agent', []), /isn't its canonical path/);
    assert.deepEqual(seen, ['/Volumes/Agent']);
  } finally {
    (fs.realpathSync as unknown as { native: (p: string) => string }).native = native;
  }
});
