import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSite, type Site } from '../src/service.js';

// #958, the owner's decision (2026-11-10): an instance's coordinator runs only with its runner (the instance's agent
// settings, through src/claude-launch.ts). A local site keeps a runner of its own through the same launch, with no
// instance guardrail hooks: test/coordinator-start-lock.test.ts starts one.
test("#958: an instance's coordinator given no runner doesn't start, naming the instance; nothing is touched", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'coordinator-agents-'));
  const site = { cfg: {} as Site['cfg'], root: join(dir, 'repo'), stateDir: join(dir, 'state'), logPath: join(dir, 'state', 'events.db') };
  const said: string[] = [];
  t.mock.method(console, 'error', (m: unknown) => void said.push(String(m)));
  assert.equal(await runSite(site, { instance: 'shop', once: true }), 1);
  assert.match(said.join('\n'), /coordinator not started: no agent settings for instance shop; reinstall it \(\S+ install --instance shop\)/);
});
