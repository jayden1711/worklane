import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliRunner, cliArgs } from '../src/runner.js';

const req = { prompt: 'Fix issue #11: the secret plan', appendSystemPrompt: 'You are the worker.', model: 'm', cwd: '.', allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, stallMs: 60_000, timeoutMs: 60_000, role: 'worker' };

test('regression: the prompt never goes on the claude command line (sudo logs command lines to the journal)', () => {
  const args = cliArgs(req, undefined, '/tmp/x/system-prompt.md');
  assert.ok(!args.some((a) => a.includes('secret plan')), args.join(' '));
  assert.ok(!args.includes('--append-system-prompt'));
  assert.deepEqual(args.slice(args.indexOf('--append-system-prompt-file'), args.indexOf('--append-system-prompt-file') + 2), ['--append-system-prompt-file', '/tmp/x/system-prompt.md']);
  assert.equal(args[0], '-p');
});

test('a run hands claude its prompt on stdin and its system prompt in a readable file, removed afterwards', { skip: process.platform === 'win32' && 'POSIX shell stand-in' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
  const log = join(dir, 'log.json');
  const bin = join(dir, 'claude');
  // Stand-in claude: reports a claude.ai login, records what it was given, and prints a result.
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
const file = args[args.indexOf('--append-system-prompt-file') + 1];
const stdin = fs.readFileSync(0, 'utf8');
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args, stdin, file, system: fs.readFileSync(file, 'utf8'), mode: (fs.statSync(file).mode & 0o777).toString(8) }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0, num_turns: 1 }));
`,
  );
  chmodSync(bin, 0o755);
  const r = await new CliRunner('cli', process.env, bin).run(req);
  assert.equal(r.reason, 'succeeded', r.detail);
  const seen = JSON.parse(readFileSync(log, 'utf8')) as { args: string[]; stdin: string; file: string; system: string; mode: string };
  assert.equal(seen.stdin, req.prompt);
  assert.ok(!seen.args.join(' ').includes('secret plan'));
  assert.equal(seen.system, req.appendSystemPrompt);
  assert.equal(seen.mode, '644', 'readable by the agent user');
  assert.equal(existsSync(seen.file), false, 'removed when the run ends');
});
