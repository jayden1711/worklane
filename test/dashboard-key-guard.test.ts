// WHY (#508): in local mode the agents run as the person's own OS user, so the dashboard key's 0600 file doesn't keep
// them out. The guardrails do: an agent session is denied the key, by tool and by shell argument; the person is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { runHook } from '../src/hook.js';
import { exampleProject } from './helpers.js';

const posix = process.platform !== 'win32';

test("an agent session is denied a dashboard key, by Read and by a shell argument; other files and the person aren't", { skip: !posix && 'POSIX paths' }, async () => {
  const { dir, stateDir } = exampleProject();
  // Where a checkout's key lives (<state>/projects/<hash>/dashboard-token), as written.
  const key = join(mkdtempSync(join(tmpdir(), 'state-')), 'projects', 'abc123', 'dashboard-token');
  mkdirSync(join(key, '..'), { recursive: true });
  writeFileSync(key, 'k'.repeat(32), { mode: 0o600 });
  const decision = (out: { stdout?: string }) => (out.stdout ? (JSON.parse(out.stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision : 'none');
  const call = (tool: string, input: Record<string, unknown>, agent: boolean) =>
    runHook('pre-tool-use', { hook_event_name: 'PreToolUse', cwd: dir, tool_name: tool, tool_input: input }, { ...process.env, [`${BRAND.envPrefix}_STATE_DIR`]: stateDir, ...(agent ? { [`${BRAND.envPrefix}_AGENT`]: '1' } : {}) });
  assert.equal(decision(await call('Read', { file_path: key }, true)), 'deny', 'Read');
  assert.equal(decision(await call('Bash', { command: `cat ${key}` }, true)), 'deny', 'a shell argument');
  assert.notEqual(decision(await call('Read', { file_path: join(dir, 'README.md') }, true)), 'deny', 'other files are untouched');
  assert.notEqual(decision(await call('Read', { file_path: key }, false)), 'deny', 'the person reads their own key');
});
