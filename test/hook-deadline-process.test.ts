// The agents' tool guard answers every PreToolUse call within its budget, through its real process
// (dist/src/hook-main.js, what every installed hook command runs), and refuses a call it can't decide in time.
// WHY (#887 review): Claude Code cancels a command hook that runs past its 30 s timeout and lets the call go ahead, and
// one Bash call kept the guard busy for 43.5 s. A timer in the deciding process can't fire while it's stuck in
// synchronous code, so these tests make the guard's own code hang, and expect the refusal anyway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BRAND } from '../src/brand.js';
import { exampleProject, repoRoot } from './helpers.js';

/** The guard's budget (src/hook-deadline.ts GUARD_BUDGET_MS, held equal there by test/hook-deadline.test.ts). */
const BUDGET_MS = 10_000;
/** Node's start, twice (the deadline's holder and the guard), on a loaded machine: the most a refusal may come after the budget. */
const START_SLACK_MS = 5_000;
const HOOK_MAIN = join(repoRoot, 'dist', 'src', 'hook-main.js');
const P = BRAND.envPrefix;

interface Run { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; ms: number }

/**
 * The guard's process on one call, as Claude Code runs it: the call's JSON on stdin. `keepStdinOpen` writes it and
 * never closes stdin. A run past `killAfterMs` is killed (the hook would have been cancelled).
 */
function runGuard(o: { input: object; env: NodeJS.ProcessEnv; nodeArgs?: string[]; keepStdinOpen?: boolean; killAfterMs: number }): Promise<Run> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [...(o.nodeArgs ?? []), HOOK_MAIN, 'pre-tool-use'], { env: o.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    const kill = setTimeout(() => child.kill('SIGKILL'), o.killAfterMs);
    child.on('error', reject);
    child.on('close', (status, signal) => {
      clearTimeout(kill);
      resolve({ status, signal, stdout, stderr, ms: performance.now() - t0 });
    });
    child.stdin.on('error', () => {});
    if (o.keepStdinOpen) child.stdin.write(JSON.stringify(o.input));
    else child.stdin.end(JSON.stringify(o.input));
  });
}

const decision = (r: Run): string | null => {
  try {
    return (JSON.parse(r.stdout) as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision ?? null;
  } catch {
    return null;
  }
};

/** Whether a process with this pid is still there (signal 0 only checks), after giving the system a moment to reap it. */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test('a guard stuck in synchronous code, or left waiting for its input, is refused at its deadline: deny, exit code 2, never an allow', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-stuck-'));
  const { dir: project, stateDir } = exampleProject();
  const pidFile = join(dir, 'stuck.pid');
  // The injected hang: the guard's own code (src/hook.ts) never finishes loading, in a loop no timer in its thread can
  // interrupt. It writes its pid first, so the test can check it was stopped.
  const preload = join(dir, 'stuck.mjs');
  writeFileSync(preload, [
    "import { registerHooks } from 'node:module';",
    "import { writeFileSync } from 'node:fs';",
    'registerHooks({ load(url, context, next) {',
    "  if (url.endsWith('/dist/src/hook.js')) { writeFileSync(process.env.STUCK_PID_FILE, String(process.pid)); for (;;) {} }",
    '  return next(url, context);',
    '} });',
  ].join('\n'));
  const env = { ...process.env, [`${P}_AGENT`]: '1', [`${P}_STATE_DIR`]: stateDir, STUCK_PID_FILE: pidFile };
  const input = { hook_event_name: 'PreToolUse', cwd: project, tool_name: 'Bash', tool_input: { command: 'cat .env' }, session_id: 's' };
  const killAfterMs = BUDGET_MS + START_SLACK_MS + 10_000;
  const [stuck, waiting] = await Promise.all([
    runGuard({ input, env, nodeArgs: ['--import', pathToFileURL(preload).href], killAfterMs }),
    runGuard({ input, env, keepStdinOpen: true, killAfterMs }),
  ]);
  for (const [name, r] of [['stuck in a loop', stuck], ['waiting for its input', waiting]] as const) {
    assert.equal(r.signal, null, `${name}: the guard answered (it was not killed after ${Math.round(r.ms)} ms)`);
    assert.equal(r.status, 2, `${name}: exit code 2 blocks the call (got ${r.status}: ${r.stderr})`);
    assert.equal(decision(r), 'deny', `${name}: a deny decision`);
    assert.match(r.stderr, /did not decide within 10 s; this tool call is refused/, name);
    assert.ok(r.ms >= BUDGET_MS - 50, `${name}: refused at the deadline, not before (${Math.round(r.ms)} ms)`);
    assert.ok(r.ms < BUDGET_MS + START_SLACK_MS, `${name}: refused within ${BUDGET_MS + START_SLACK_MS} ms (${Math.round(r.ms)} ms)`);
  }
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0 && (await gone(pid)), 'the stuck guard was stopped, not left running');
});

test("the #887 review's slow call (an 18,000-entry tree, ls with 300 */*/* words, then cat of a hidden file) is refused within the budget", async (t) => {
  const { dir: project, stateDir } = exampleProject();
  // 18,000 files: 30 directories of 30 directories of 20 files.
  for (let a = 0; a < 30; a++) {
    for (let b = 0; b < 30; b++) {
      const d = join(project, 'tree', `a${a}`, `b${b}`);
      mkdirSync(d, { recursive: true });
      for (let c = 0; c < 20; c++) writeFileSync(join(d, `f${c}.txt`), '');
    }
  }
  mkdirSync(join(project, 'evals-secret'));
  writeFileSync(join(project, 'evals-secret', 'score.py'), 'EXPECTED = 1\n');
  const taskFile = join(stateDir, '..', 'task.json');
  writeFileSync(taskFile, JSON.stringify({ id: 't1', done_when: [{ manual: 'done' }], hidden: ['evals-secret/**'] }));
  const env = { ...process.env, [`${P}_AGENT`]: '1', [`${P}_STATE_DIR`]: stateDir, [`${P}_TASK_FILE`]: taskFile };
  const command = `ls ${Array.from({ length: 300 }, () => '*/*/*').join(' ')} ; cat evals-secret/score.py`;
  const r = await runGuard({ input: { hook_event_name: 'PreToolUse', cwd: project, tool_name: 'Bash', tool_input: { command }, session_id: 's' }, env, killAfterMs: BUDGET_MS + START_SLACK_MS + 10_000 });
  t.diagnostic(`the slow call answered in ${Math.round(r.ms)} ms (exit ${r.status})`);
  assert.equal(r.signal, null, 'the guard answered');
  assert.equal(decision(r), 'deny', `refused, never allowed (exit ${r.status}: ${r.stdout} ${r.stderr})`);
  assert.ok(r.status === 0 || r.status === 2, `a refusal Claude Code honours: exit 0 with a deny, or exit 2 (got ${r.status})`);
  assert.ok(r.ms < BUDGET_MS + START_SLACK_MS, `within the budget (${Math.round(r.ms)} ms)`);
});
