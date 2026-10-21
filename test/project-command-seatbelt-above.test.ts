// Issue #798, round 13 (the round-12 second review, H): on macOS the sandbox profile denied writes under the agent's
// home, but had no rule above it. With a home under a directory the agent owns (/Volumes/x/wl/agent, wl the
// agent's), a command could rename wl away and put a directory holding a planted .bashrc in its place: the A24 shape,
// closed on Linux by pinning the home's way. The profile now denies writes to each directory above the home itself
// (`literal`: the directory, not what it holds). Checked on the profile text, through projectCommand's macOS branch
// with an injected resolver; whether seatbelt enforces it is untested on a real macOS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as osAdapter from '../src/os/index.js';

type Opts = { platform?: 'linux' | 'darwin'; realpath?: (p: string) => string };
function profile(home: string): string {
  const pc = (osAdapter.projectCommand as unknown as (c: string, r: osAdapter.ProjectRunAs, e: Record<string, string>, o: Opts) => { args: string[] })('true', { user: 'shop-agent', home, hide: [] }, {}, { platform: 'darwin', realpath: (p) => p });
  const i = pc.args.indexOf('-p');
  assert.ok(i >= 0, `no profile: ${pc.args.join(' ')}`);
  return pc.args[i + 1]!;
}

test('macOS: the profile denies writes to every directory above the home, so none can be renamed away and replaced', () => {
  const s = profile('/Volumes/x/wl/agent');
  for (const d of ['/Volumes/x/wl', '/Volumes/x', '/Volumes']) assert.ok(s.includes(`(literal "${d}")`), `${d} isn't pinned: ${s}`);
  assert.match(s, /\(deny file-write\* \(literal "\/Volumes\/x\/wl"\)/, s);
  // Only the directories themselves: nothing under them but the home is denied, and / isn't named.
  assert.ok(!s.includes('(subpath "/Volumes/x/wl")'), s);
  assert.ok(!s.includes('(literal "/")'), s);
  assert.ok(s.includes('(deny file-write* (subpath "/Volumes/x/wl/agent"))'), s);
});

test('macOS: a home directly under / has no directory above it to pin', () => {
  const s = profile('/agent');
  assert.ok(!s.includes('(literal '), s);
  assert.ok(s.includes('(deny file-write* (subpath "/agent"))'), s);
});
