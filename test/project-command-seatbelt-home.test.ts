// Issue #798, round 11 (the round-10 second review, F): on macOS a project command runs under a seatbelt profile that
// denies every write under the agent's home. Seatbelt matches canonical paths (a profile has to name /private/tmp,
// not /tmp), so a configured home reached through a symlink (/var/... is /private/var/... there) matched nothing:
// the whole home stayed writable. The profile builder now refuses a home that isn't its own canonical path, or that
// can't be resolved, never rewriting it. Pure, on any platform: real temp dirs and an injected resolver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Namespace import: on the code before this change a name it lacks is undefined, not a load error.
import * as osAdapter from '../src/os/index.js';

function build(home: string, real?: (p: string) => string): string {
  const f = (osAdapter as unknown as { seatbeltProfileFor?: (h: string, hide: readonly string[], r?: (p: string) => string) => string }).seatbeltProfileFor;
  assert.equal(typeof f, 'function', 'no seatbeltProfileFor: the macOS profile is built for any configured home');
  return real ? f!(home, [], real) : f!(home, []);
}

test("macOS: a home reached through a symlink is refused, since the sandbox's write rule wouldn't match it", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wl-798-sb-')));
  mkdirSync(join(root, 'real-home'));
  symlinkSync(join(root, 'real-home'), join(root, 'link-home'));
  assert.throws(() => build(join(root, 'link-home')), /isn't its canonical path/);
});

test("macOS: a configured /var home whose canonical path is /private/var is refused (macOS's own layout)", () => {
  assert.throws(() => build('/var/agent', (p) => (p === '/var/agent' ? '/private/var/agent' : p)), /isn't its canonical path.*\/private\/var\/agent/);
});

test("macOS: a home that can't be resolved (missing) is refused", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wl-798-sb-')));
  assert.throws(() => build(join(root, 'missing')), /can't be resolved/);
});

test('macOS: a canonical home gets the profile that denies every write under it', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wl-798-sb-')));
  const home = join(root, 'agent');
  mkdirSync(home);
  const s = build(home);
  assert.ok(s.includes(`(deny file-write* (subpath "${home}"))`), s);
  assert.equal(s, osAdapter.seatbeltProfile(home, []));
});
