// #890 round 9 (second adversarial review, A1): runReadDenials runs inside the coordinator's own process and reads
// files in the run's own checkout, which its agent can write: the worktree's .git, the commondir and gitdir files it
// leads to, and .worklane/*.yaml. readFileSync on a FIFO nobody writes to waits forever, which would freeze the
// coordinator's event loop (every run, every stop). Each such file is read only when it is a regular file of bounded
// size; anything else refuses the run, at once. Each call runs in a child process with a hard limit, so a hang fails
// the test rather than the test runner.
import { exampleProject } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const skip = process.platform !== 'linux' && 'FIFOs made with mkfifo, on Linux where CI runs';
const LIMIT_MS = 10_000;

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const fifo = (p: string) => execFileSync('mkfifo', [p], { stdio: 'ignore' });

/** The example project, and a linked worktree of it with its own `.env` (the run's checkout). */
function fixture() {
  const { dir } = exampleProject();
  const wt = join(dirname(dir), 'wt');
  git(dir, 'worktree', 'add', '-q', '-b', 'exp', wt, 'HEAD');
  writeFileSync(join(wt, '.env'), 'TOKEN=wt\n');
  return { dir, wt };
}

/** `call(args)` from the built module `mod`, in a child process killed after LIMIT_MS. */
function inChild(mod: string, call: string, args: unknown) {
  const href = new URL(mod, import.meta.url).href;
  const script = `const m = await import(${JSON.stringify(href)}); const t = performance.now(); let out; try { out = { result: m.${call}(${JSON.stringify(args)}) }; } catch (e) { out = { threw: String(e && e.message || e) }; } process.stdout.write(JSON.stringify({ ms: performance.now() - t, ...out }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: LIMIT_MS });
  assert.equal(r.status, 0, `finished within ${LIMIT_MS} ms (signal ${r.signal}): ${(r.stderr ?? '').slice(0, 300)}`);
  return JSON.parse(r.stdout) as { ms: number; result?: { paths?: string[]; error?: string }; threw?: string };
}

const denials = (wt: string, dir: string) => inChild('../src/read-denials.js', 'runReadDenials', { cwd: wt, home: '/h', repo: dir });

function refusedPromptly(out: ReturnType<typeof denials>, why: RegExp) {
  assert.ok(out.result && typeof out.result.error === 'string', `refused: ${JSON.stringify(out)}`);
  assert.match(out.result.error!, why);
  assert.ok(out.ms < 2_000, `took ${out.ms} ms`);
}

test('#890 r9: control: a worktree with regular files works its denials out, promptly', { skip, timeout: 60_000 }, () => {
  const { dir, wt } = fixture();
  const out = denials(wt, dir);
  assert.ok(out.result?.paths, JSON.stringify(out));
  assert.ok(out.result.paths.includes(join(wt, '.env')), JSON.stringify(out.result.paths));
  assert.ok(out.result.paths.includes(join(dir, '.env')), JSON.stringify(out.result.paths));
  assert.ok(out.ms < 2_000, `took ${out.ms} ms`);
});

test('#890 r9: a FIFO at the worktree\'s .git refuses the run at once, never hangs the coordinator', { skip, timeout: 60_000 }, () => {
  const { dir, wt } = fixture();
  renameSync(join(wt, '.git'), join(wt, '.git-was'));
  fifo(join(wt, '.git'));
  refusedPromptly(denials(wt, dir), /\.git isn't a regular file/);
});

test('#890 r9: a FIFO at .worklane/guardrails.yaml refuses the run at once, never hangs the coordinator', { skip, timeout: 60_000 }, () => {
  const { dir, wt } = fixture();
  renameSync(join(wt, '.worklane', 'guardrails.yaml'), join(wt, 'guardrails-was.yaml'));
  fifo(join(wt, '.worklane', 'guardrails.yaml'));
  refusedPromptly(denials(wt, dir), /guardrails\.yaml isn't a regular file/);
});

test('#890 r9: a FIFO at the commondir file the worktree\'s .git leads to refuses the run at once', { skip, timeout: 60_000 }, () => {
  const { dir, wt } = fixture();
  // The agent points its .git at a git directory of its own making, inside its checkout.
  mkdirSync(join(wt, 'fake'));
  writeFileSync(join(wt, 'fake', 'HEAD'), 'ref: refs/heads/exp\n');
  fifo(join(wt, 'fake', 'commondir'));
  writeFileSync(join(wt, '.git'), 'gitdir: fake\n');
  refusedPromptly(denials(wt, dir), /commondir isn't a regular file/);
});

test('#890 r9: a FIFO at a worktrees/*/gitdir file the worktree\'s .git leads to refuses the run at once', { skip, timeout: 60_000 }, () => {
  const { wt } = fixture();
  mkdirSync(join(wt, 'sub', '.git', 'worktrees', 'x'), { recursive: true });
  writeFileSync(join(wt, 'sub', '.git', 'HEAD'), 'ref: refs/heads/exp\n');
  fifo(join(wt, 'sub', '.git', 'worktrees', 'x', 'gitdir'));
  writeFileSync(join(wt, '.git'), 'gitdir: sub/.git\n');
  // Without the instance's repository (a runner built outside an instance), the agent's git directory is read.
  refusedPromptly(inChild('../src/read-denials.js', 'runReadDenials', { cwd: wt, home: '/h' }), /gitdir isn't a regular file/);
});

test('#890 r9: a worktree whose .git leads to a git directory of the agent\'s own is refused before git runs on it', { skip, timeout: 60_000 }, () => {
  const { dir, wt } = fixture();
  // Its config a FIFO: git would wait on it until its own timeout, holding the coordinator.
  const fake = join(wt, 'fake');
  mkdirSync(join(fake, 'objects', 'info'), { recursive: true });
  mkdirSync(join(fake, 'refs', 'heads'), { recursive: true });
  writeFileSync(join(fake, 'HEAD'), 'ref: refs/heads/exp\n');
  fifo(join(fake, 'config'));
  writeFileSync(join(wt, '.git'), 'gitdir: fake\n');
  refusedPromptly(denials(wt, dir), /not the repository's own/);
});

test('#890 r9: a config file over the size cap refuses the run', { skip, timeout: 60_000 }, () => {
  const { dir, wt } = fixture();
  const g = join(wt, '.worklane', 'guardrails.yaml');
  writeFileSync(g, readFileSync(g, 'utf8') + `# ${'x'.repeat(2 * 1024 * 1024)}\n`);
  refusedPromptly(denials(wt, dir), /guardrails\.yaml is \d+ bytes, over \d+/);
});

test('#890 r9: loadConfig (the hook\'s and every other caller\'s) refuses a FIFO config file at once', { skip, timeout: 60_000 }, () => {
  const { wt } = fixture();
  renameSync(join(wt, '.worklane', 'agents.yaml'), join(wt, 'agents-was.yaml'));
  fifo(join(wt, '.worklane', 'agents.yaml'));
  const out = inChild('../src/config/load.js', 'loadConfig', wt);
  assert.ok(out.threw, JSON.stringify(out));
  assert.match(out.threw, /agents\.yaml.*isn't a regular file/);
  assert.ok(out.ms < 2_000, `took ${out.ms} ms`);
});
