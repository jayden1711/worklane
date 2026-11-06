// #959: a lane's sandbox settings turned each denyRead entry into a directory-shaped Read rule only (`Read(//x/**)`).
// A denied entry may be one file (a credential, a config), which a directory rule may not match, so the Read tool
// could read it. Every denied path becomes both forms, through the one function that writes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDenyRules, sandboxSettings, withDeniedReads } from '../src/sandbox.js';
import { repoRoot } from './helpers.js';

const FILES = ['/srv/inst/shop/credentials.yaml', '/home/user/.npmrc', '/home/user/.docker/config.json', '/srv/inst/shop'];
const both = (deny: string[], p: string) => deny.includes(`Read(/${p})`) && deny.includes(`Read(/${p}/**)`);

test('#959: a lane\'s sandbox settings deny every denyRead entry to the Read tool by its exact path and as a directory', () => {
  const deny = sandboxSettings({ lane: { allowedDomains: [] }, denyRead: FILES }).permissions.deny;
  assert.deepEqual(FILES.filter((p) => !both(deny, p)), []);
});

test('#959: a run\'s added denials, on settings with and without a sandbox, are denied in both forms too', () => {
  const lane = sandboxSettings({ lane: { allowedDomains: [] }, denyRead: [] });
  for (const s of [withDeniedReads(lane, FILES), withDeniedReads({} as { permissions?: { deny?: string[] } }, FILES)]) assert.deepEqual(FILES.filter((p) => !both(s.permissions?.deny ?? [], p)), []);
  assert.deepEqual(readDenyRules(['relative/x', '/abs/y']), ['Read(//relative/x/**)', 'Read(//abs/y/**)', 'Read(//relative/x)', 'Read(//abs/y)']);
});

test('#959: no source but readDenyRules writes a Read rule for a denied absolute path', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.ts')) readFileSync(p, 'utf8').split('\n').forEach((l, i) => {
        // An absolute-path rule built from a variable: `Read(/${...`.
        if (/`Read\(\/\$\{/.test(l) && !(p.endsWith(join('src', 'sandbox.ts')) && /readDenyRules|all\.map/.test(l))) offenders.push(`${p.slice(repoRoot.length)}:${i + 1}`);
      });
    }
  };
  walk(join(repoRoot, 'src'));
  assert.deepEqual(offenders, []);
});
