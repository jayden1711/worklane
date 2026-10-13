// A coordinator as the service runs it (runSite), in its own process, for test/shutdown.test.ts to signal: a file
// backlog with one ready task, and a worker that runs until it is aborted ("abortable") or ignores the abort
// ("stubborn"). It prints RUNNING once the worker is under way. Not a test file itself.
// Usage: node shutdown-child.js <base dir> <abortable|stubborn> <shutdown ms>
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { FakeRunner } from '../src/runner.js';
import { runSite } from '../src/service.js';
import { repoRoot } from './helpers.js';

const [base, mode, shutdownMs] = process.argv.slice(2) as [string, 'abortable' | 'stubborn', string];
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const remote = join(base, 'remote.git');
const seed = join(base, 'seed');
cpSync(join(repoRoot, 'examples', 'basic'), seed, { recursive: true });
writeFileSync(join(seed, '.gitignore'), '.claude/worktrees/\n');
// A file backlog, and a governor that never holds for this machine's load or disk (a CI runner's are not the point).
const cfgFile = join(seed, BRAND.configDir, 'config.yaml');
writeFileSync(cfgFile, readFileSync(cfgFile, 'utf8').replace('backlog: github', 'backlog: file') + 'governor: { max_load: 100000, min_free_disk_pct: 1 }\n');
const testsFile = join(seed, BRAND.configDir, 'tests.yaml');
writeFileSync(testsFile, readFileSync(testsFile, 'utf8').replace('  est_size_gb: 1\n', '  est_size_gb: 0.001\n'));
git(base, 'init', '-q', '--bare', '-b', 'main', remote);
git(seed, 'init', '-q', '-b', 'main');
git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', 'add', '-A');
git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
git(seed, 'remote', 'add', 'origin', remote);
git(seed, 'push', '-q', 'origin', 'main');
const repo = join(base, 'clone');
git(base, 'clone', '-q', remote, repo);
for (const [k, v] of [['user.email', 'coordinator@example.com'], ['user.name', 'coordinator'], ['commit.gpgsign', 'false']]) git(repo, 'config', k!, v!);

const stateDir = join(base, 'state');
mkdirSync(stateDir, { recursive: true });
const slots = join(base, 'slots');
mkdirSync(slots);
writeFileSync(join(slots, 'config.json'), JSON.stringify({ max_agents: 2 }));
process.env.AGENT_SLOTS_DIR = slots;
new FileBacklog(join(stateDir, 'backlog.json')).open({ title: 'Add a.js', body: 'Add a.js.\n\n```done_when\n- test: test/price.test.js\n```\n', author: 'example-owner', labels: ['ready'] });

// The worker: a long call that returns only when aborted (or never, when stubborn).
const runner = new FakeRunner(async (req) => {
  if (req.role !== 'worker') return { reason: 'canceled_by_reconciliation' };
  process.stdout.write('RUNNING\n');
  await new Promise<void>((res) => {
    if (mode === 'abortable') req.signal?.addEventListener('abort', () => res());
  });
  return { reason: 'canceled_by_reconciliation' };
});

const cfg = loadConfig(repo);
const code = await runSite({ cfg, root: repo, stateDir, logPath: join(stateDir, 'events.db') }, { label: 'coordinator', backupDir: join(base, 'backups'), shutdownMs: Number(shutdownMs) }, runner);
process.exit(code);
