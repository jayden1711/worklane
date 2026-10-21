// #890, second adversarial review round 4: repository layouts where the main checkout isn't <x>/.git's parent, and
// submodules, whose objects live in their own stores. The main checkout is the instance's repository path when the
// runner has it; otherwise it is found from git's own record (a submodule's core.worktree), and a run whose main
// checkout can't be found doesn't start. A run that hides anything is denied every submodule's store too. Each entry
// is checked with sandbox-runtime's own read-deny expansion (the library Claude Code's sandbox is built on).
import { engineCli, repoRoot, STDIN_LINE } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReadDenials } from '../src/read-denials.js';
import { agentSettings } from '../src/install.js';
import { laneRuns, PolicyFile, type Instance } from '../src/instance.js';
import { CliRunner, type RunRequest } from '../src/runner.js';

const skip = process.platform !== 'linux' && "sandbox-runtime's Linux read-deny rules, where CI runs";
const SRT = join(repoRoot, 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'dist', 'sandbox');

type Opts = Parameters<typeof runReadDenials>[0];
/** runReadDenials with the instance's repository path, an option older builds don't have (so they ignore it). */
const withRepo = (o: Opts & { repo: string }) => runReadDenials(o as Opts);

function task(hidden: string[]) {
  const f = join(mkdtempSync(join(tmpdir(), 'task-')), 't.json');
  writeFileSync(f, JSON.stringify({ id: 't', done_when: [{ manual: 'x' }], hidden }));
  return f;
}

const paths = (r: ReturnType<typeof runReadDenials>) => {
  if ('error' in r) assert.fail(r.error);
  return r.paths;
};

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Does the sandbox these denyRead entries describe hide `target`? Resolved as sandbox-runtime resolves them (Linux). */
async function hides(entries: string[], target: string): Promise<boolean> {
  const utils = await import(join(SRT, 'sandbox-utils.js'));
  const glob = await import(join(SRT, 'read-deny-glob.js'));
  const mounts: string[] = [];
  for (const e of entries) {
    const stripped: string = utils.removeTrailingGlobSuffix(e);
    if (utils.containsGlobChars(stripped)) mounts.push(...(glob.expandReadDenyGlobLinux(e, [], new Set()) as string[]));
    else if (existsSync(stripped)) mounts.push(real(stripped));
  }
  return mounts.some((m) => utils.isAtOrUnder(real(target), m));
}

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** The example project with its scorer committed, made by `git init <init args>` in `dir`; `.env` left untracked. */
function project(dir: string, ...init: string[]) {
  cpSync(join(repoRoot, 'examples', 'basic'), dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main', ...init);
  for (const [k, v] of [['user.email', 'ada@example.com'], ['user.name', 'Ada'], ['commit.gpgsign', 'false'], ['maintenance.auto', 'false'], ['gc.auto', '0']]) git(dir, 'config', k!, v!);
  mkdirSync(join(dir, 'evals-secret'));
  writeFileSync(join(dir, 'evals-secret', 'score.py'), 'SECRET_SCORER\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  writeFileSync(join(dir, '.env'), 'TOKEN=main\n');
  return dir;
}

const HIDDEN = ['evals-secret/**', 'evals-secret/score.py'];

test('#890: a main checkout whose git directory is elsewhere (--separate-git-dir) is covered from the instance\'s repository path, and refused without it', { skip }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'sep-'));
  const main = project(join(base, 'main'), '--separate-git-dir', join(base, 'store.git'));
  // Not beside the main checkout: a glob over the linked worktree's parent mustn't be what covers it.
  const linked = join(base, 'wts', 'exp');
  git(main, 'worktree', 'add', '-q', '-b', 'exp', linked);
  const p = paths(withRepo({ cwd: linked, home: '/h', taskFile: task(HIDDEN), repo: main }));
  for (const t of [join(main, '.env'), join(main, 'evals-secret', 'score.py')]) assert.ok(await hides(p, t), `${t} hidden: ${JSON.stringify(p)}`);
  const r = runReadDenials({ cwd: linked, home: '/h', taskFile: task(HIDDEN) });
  assert.ok('error' in r && /main checkout/.test(r.error), JSON.stringify(r));
});

/** A stand-in claude that records the --settings it was given; nothing else. */
function standIn(dir: string) {
  const bin = join(dir, 'claude');
  const out = join(dir, 'settings.json');
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
${STDIN_LINE};
const at = args.indexOf('--settings');
const text = at >= 0 ? args[at + 1] : '{}';
fs.writeFileSync(${JSON.stringify(out)}, text);
// The runner checks claude applied its --settings by the output style it reports.
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', tools: [], mcp_servers: [], plugins: [], output_style: JSON.parse(text).outputStyle || 'default' }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0, num_turns: 1 }));
`,
  );
  chmodSync(bin, 0o755);
  return { bin, settings: () => (existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as { sandbox?: { filesystem?: { denyRead?: string[] } } }) : null) };
}

test('#890: the runner passes the instance\'s repository path, so a separate git dir\'s main checkout is denied to the run', { skip }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'seprun-'));
  const main = project(join(base, 'main'), '--separate-git-dir', join(base, 'store.git'));
  const linked = join(base, 'wts', 'exp');
  git(main, 'worktree', 'add', '-q', '-b', 'exp', linked);
  const inst = {
    name: 'fixture',
    runAs: null,
    evalAs: null,
    home: join(base, 'inst-home'),
    stateDir: join(base, 'inst-home', 'state'),
    repo: { path: main, repo: 'example/fixture' },
    policy: PolicyFile.parse({ version: 1, budget: { daily_usd: 20 }, agents: { max_workers: 2 }, land_mode: 'pr', sandbox: true }),
    credentials: { claude: { config_dir: join(base, 'agent-claude') } },
  } as unknown as Instance;
  const home = join(base, 'agent-home');
  mkdirSync(home);
  const req: RunRequest = { env: {}, role: 'experimenter', prompt: 'p', cwd: linked, model: 'm', allowedTools: ['Read'], disallowedTools: ['Bash'], maxTurns: 1, maxBudgetUsd: 0.01, taskFile: task(HIDDEN), stallMs: 30_000, timeoutMs: 30_000 };
  const runner = (bin: string, repoPath?: string) => {
    const args: ConstructorParameters<typeof CliRunner> = ['cli', { PATH: process.env.PATH, HOME: home }, bin, undefined, laneRuns(inst), undefined, {}, () => agentSettings(engineCli, [], [], [])];
    // The repository path is the constructor's last option (after apiKeyFile, login, plugins and mcp).
    return new (CliRunner as unknown as new (...a: unknown[]) => CliRunner)(...args, undefined, undefined, undefined, undefined, repoPath);
  };
  const s = standIn(mkdtempSync(join(tmpdir(), 'stand-in-')));
  const r = await runner(s.bin, main).run(req);
  assert.equal(r.reason, 'succeeded', r.detail);
  const denyRead = s.settings()!.sandbox!.filesystem!.denyRead!;
  for (const t of [join(main, '.env'), join(main, 'evals-secret', 'score.py')]) assert.ok(await hides(denyRead, t), `${t} hidden: ${JSON.stringify(denyRead)}`);
  const none = standIn(mkdtempSync(join(tmpdir(), 'stand-in-')));
  const refused = await runner(none.bin).run(req);
  assert.equal(refused.reason, 'failed');
  assert.match(refused.detail, /main checkout .* can't be found.*not starting/);
  assert.equal(none.settings(), null, 'the stand-in never started');
});

test('#890: a project that is a submodule checkout: its main checkout is found from git\'s own record and covered', { skip }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'subproj-'));
  const src = project(join(base, 'src'));
  const sup = join(base, 'super');
  mkdirSync(sup);
  git(sup, 'init', '-q', '-b', 'main');
  git(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', src, 'proj');
  const main = join(sup, 'proj');
  writeFileSync(join(main, '.env'), 'TOKEN=main\n');
  const linked = join(base, 'exp');
  git(main, 'worktree', 'add', '-q', '-b', 'exp', linked);
  const p = paths(runReadDenials({ cwd: linked, home: '/h', taskFile: task(HIDDEN) }));
  for (const t of [join(main, '.env'), join(main, 'evals-secret', 'score.py')]) assert.ok(await hides(p, t), `${t} hidden: ${JSON.stringify(p)}`);
});

test('#890: a run that hides anything is denied every submodule\'s object store, so `git -C sub show` has nothing to read', { skip }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'subst-'));
  const src = join(base, 'src');
  mkdirSync(join(src, 'evals'), { recursive: true });
  git(src, 'init', '-q', '-b', 'main');
  writeFileSync(join(src, 'evals', 'score.py'), 'SECRET_SCORER\n');
  git(src, 'add', '-A');
  git(src, '-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-q', '-m', 'eval');
  const dir = project(join(base, 'repo'));
  git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', src, 'sub');
  git(dir, 'commit', '-q', '-m', 'sub');
  const sub = join(dir, 'sub');
  assert.match(git(sub, 'show', 'HEAD:evals/score.py'), /SECRET_SCORER/, 'precondition: git reads the scorer through the submodule');
  const store = join(git(sub, 'rev-parse', '--absolute-git-dir'), 'objects');
  const p = paths(runReadDenials({ cwd: dir, home: '/h', taskFile: task(['sub/evals/**']) }));
  assert.ok(await hides(p, store), `${store} hidden: ${JSON.stringify(p)}`);
  assert.ok(await hides(p, join(sub, 'evals', 'score.py')));
});
