// The guard's answer reaches Claude Code whole, or the hook exits 2 (#894 round 2).
// WHY: the guard denies with exit 0 and a JSON deny on stdout. The holder wrote stdout and exited at once, and a pipe
// takes 64 KiB before a write has to wait, so a deny the agent made long (a padded path quoted in the reason) arrived
// cut at 65,536 bytes: invalid JSON with exit 0, which Claude Code without onFailure "block" lets through (#894 review).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BRAND } from '../src/brand.js';
import { exampleProject, repoRoot } from './helpers.js';

const P = BRAND.envPrefix;
const HOOK_MAIN = join(repoRoot, 'dist', 'src', 'hook-main.js');

interface Read { status: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: string; ms: number }

/**
 * Runs node with `args`, `input` on stdin. With `reader` (a shell command), node's stdout is a real pipe into it, as a
 * hook's is (`| cat`, or `| { sleep 1; cat; }` for a slow reader), and the exit code is node's (pipefail). Without, it
 * is node's own socket pair, left unread for `pauseMs` first.
 */
function run(args: string[], o: { input?: string; env?: NodeJS.ProcessEnv; reader?: string; pauseMs?: number; killAfterMs?: number } = {}): Promise<Read> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const [file, argv] = o.reader ? ['bash', ['-c', `set -o pipefail; "$@" | ${o.reader}`, 'bash', process.execPath, ...args]] : [process.execPath, args];
    const child = spawn(file, argv, { env: o.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    if (o.pauseMs) {
      child.stdout.pause();
      setTimeout(() => child.stdout.resume(), o.pauseMs);
    }
    const kill = setTimeout(() => child.kill('SIGKILL'), o.killAfterMs ?? 40_000);
    let ms = 0;
    child.on('error', reject);
    // The time the process ended, not when a late reader finished reading.
    child.on('exit', () => (ms = performance.now() - t0));
    child.on('close', (status, signal) => {
      clearTimeout(kill);
      resolve({ status, signal, stdout: Buffer.concat(out), stderr, ms });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(o.input ?? '');
  });
}

/** Claude Code acts on an exit-0 answer's stdout as JSON: it must parse. An exit 2 blocks whatever stdout holds. */
function blocksOrIsWhole(r: Read, what: string): void {
  assert.equal(r.signal, null, `${what}: the hook answered`);
  if (r.status === 2) return;
  assert.equal(r.status, 0, `${what}: exit 0 or 2 (got ${r.status}: ${r.stderr.slice(0, 300)})`);
  let decision: string | undefined;
  try {
    decision = (JSON.parse(r.stdout.toString('utf8')) as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;
  } catch {
    assert.fail(`${what}: exit 0 with stdout that isn't JSON (${r.stdout.length} bytes): Claude Code without onFailure "block" would run the call`);
  }
  assert.equal(decision, 'deny', `${what}: the deny arrives`);
}

test('a deny the agent makes long (a .env path padded with 40,000 ./) reaches the reader as whole JSON, or as exit 2: never cut short with exit 0', async () => {
  const { dir: project, stateDir } = exampleProject();
  const env = { ...process.env, [`${P}_AGENT`]: '1', [`${P}_STATE_DIR`]: stateDir };
  const padded = `${'./'.repeat(40_000)}.env`;
  const calls: [string, object][] = [
    ['Bash cat', { hook_event_name: 'PreToolUse', cwd: project, tool_name: 'Bash', tool_input: { command: `cat ${padded}` }, session_id: 's' }],
    ['Read', { hook_event_name: 'PreToolUse', cwd: project, tool_name: 'Read', tool_input: { file_path: padded }, session_id: 's' }],
  ];
  for (const [name, input] of calls) {
    for (const reader of ['cat', '{ sleep 1; cat; }']) {
      const r = await run([HOOK_MAIN, 'pre-tool-use'], { input: JSON.stringify(input), env, reader });
      blocksOrIsWhole(r, `${name}, read by ${reader}`);
      // The reason quotes the word cut short, so the deny fits one page (a pipe Linux shrank to 4 KiB included).
      assert.ok(r.stdout.length < 4096, `${name}: a small deny whatever the agent sends (${r.stdout.length} bytes)`);
    }
  }
});

test("the deadline's holder delivers an answer of any size whole before it exits, or exits 2 when it can't", async () => {
  const url = pathToFileURL(join(repoRoot, 'dist', 'src', 'hook-deadline.js')).href;
  const big = 200_000;
  const deliver = (code: number, size: number) => [
    '--input-type=module',
    '-e',
    `const { deliver } = await import(${JSON.stringify(url)}); deliver({ stdout: 'x'.repeat(${size}), stderr: 'why\\n', exitCode: ${code} });`,
  ];
  // A reader on a pipe, at once or 1 s late, gets all of it, with the answer's own exit code.
  for (const code of [0, 2]) {
    for (const reader of ['cat', '{ sleep 1; cat; }']) {
      const r = await run(deliver(code, big), { reader });
      assert.equal(r.status, code, `exit ${code} kept, read by ${reader} (${r.stderr.slice(0, 300)})`);
      assert.equal(r.stdout.length, big, `all ${big} bytes delivered before the exit, read by ${reader} (got ${r.stdout.length})`);
    }
  }
  // A reader that doesn't read in time (4 MB, past any pipe's or socket's buffer): the holder can't deliver, so it
  // exits 2, which blocks whatever arrived.
  const stuck = await run(deliver(0, 4_000_000), { pauseMs: 9_000 });
  assert.equal(stuck.status, 2, `undeliverable: exit 2 (got ${stuck.status}, ${stuck.stdout.length} bytes read)`);
  assert.ok(stuck.ms < 8_000, `within the delivery bound (${Math.round(stuck.ms)} ms)`);
});
