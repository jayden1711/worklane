// WHY: item 38. Through the build loop's real call site (src/coordinator.ts): a cli:codex build whose change is above
// L1, touches a protected path, a money path or agent instructions is thrown out, and the next attempt runs on Anthropic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { dirname, join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { AgentsConfig } from '../src/config/schema.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import { InstanceSettings } from '../src/instance.js';
import { which } from '../src/os/index.js';
import { PROVIDER_GATE_FILE } from '../src/providers.js';
import { DEFAULT_COMMIT_IDENTITY, FakeRunner, type RunRequest } from '../src/runner.js';
import { repoRoot } from './helpers.js';

const skip = !which('gitleaks') && 'gitleaks not installed (the coordinator refuses unscanned changes)';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function commitAll(cwd: string, msg: string) {
  git(cwd, 'add', '-A');
  git(cwd, '-c', `user.email=${DEFAULT_COMMIT_IDENTITY.email}`, '-c', `user.name=${DEFAULT_COMMIT_IDENTITY.name}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg);
}

function write(root: string, p: string, text: string) {
  mkdirSync(dirname(join(root, p)), { recursive: true });
  writeFileSync(join(root, p), text);
}

const BUG = 'Orders with a zero or negative quantity are counted in totals.\n\n```done_when\n- test: test/price.test.js\n```\n';

/** The example project behind a bare "GitHub" remote, routed to cli:codex, opted in, with a passing eval on record. */
function setup() {
  const base = mkdtempSync(join(tmpdir(), 'cli-coord-'));
  const remote = join(base, 'remote.git');
  const seed = join(base, 'seed');
  cpSync(join(repoRoot, 'examples', 'basic'), seed, { recursive: true });
  writeFileSync(join(seed, '.gitignore'), '.claude/worktrees/\n');
  write(seed, 'money-paths.txt', 'src/billing/**\n');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'add', '-A');
  git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const repo = join(base, 'coordinator-clone');
  git(base, 'clone', '-q', remote, repo);
  for (const [k, v] of [['user.email', 'coordinator@example.com'], ['user.name', 'coordinator'], ['commit.gpgsign', 'false']]) git(repo, 'config', k!, v!);
  const cfg = loadConfig(repo);
  cfg.project.land_mode = 'direct';
  cfg.tests.runner.changed = 'node --test --test-reporter=spec';
  cfg.review = { ...cfg.review!, money_path_source: { file: 'money-paths.txt' } };
  // WHY: from the file, not the parsed config, so this holds whichever routing key name the schema reads (#340).
  const raw = parse(readFileSync(join(repo, BRAND.configDir, 'agents.yaml'), 'utf8')) as Record<string, unknown>;
  cfg.agents = AgentsConfig.parse({ ...raw, providers: { cli: { codex: { model: 'codex-model-x', tier: 'sonnet', usd_per_mtok_in: 1.25, usd_per_mtok_out: 10 } } }, model_routing: { build: 'cli:codex' } });
  const stateDir = join(base, 'state');
  mkdirSync(join(stateDir, 'evals'), { recursive: true });
  const pass = { held_out: { passed: 20, total: 20 }, baseline: { passed: 19, total: 20 }, visible: { passed: 10, total: 10 }, samples: 3, at: '2026-10-13T00:00:00Z' };
  writeFileSync(join(stateDir, PROVIDER_GATE_FILE), JSON.stringify({ worker: { 'codex-model-x': pass } }));
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  return { repo, cfg, stateDir, slotsDir, backlog: new FileBacklog(join(base, 'backlog.json'), 'coordinator'), log: new EventLog(join(base, 'events.db')) };
}

/** On cli:codex the worker makes `bad`; on Anthropic it makes the real fix. */
function runner(bad: (cwd: string) => void) {
  return new FakeRunner((req: RunRequest) => {
    if (req.role === 'worker') {
      if (req.provider?.kind === 'cli') {
        bad(req.cwd);
        commitAll(req.cwd, 'cli attempt');
        return { structured: { summary: 'done' }, provider: req.provider.name };
      }
      const p = join(req.cwd, 'src', 'price.js');
      writeFileSync(p, readFileSync(p, 'utf8').replace('sum + cents * qty', 'sum + (qty > 0 ? cents * qty : 0)'));
      commitAll(req.cwd, 'Ignore non-positive quantities in totals');
      return { structured: { summary: 'fixed' } };
    }
    return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '', files_reviewed: [] } };
  });
}

const CASES: { name: string; bad: (cwd: string) => void; why: RegExp }[] = [
  { name: 'above L1 (a dependency change, L2)', bad: (c) => write(c, 'package.json', JSON.stringify({ ...JSON.parse(readFileSync(join(c, 'package.json'), 'utf8')), dependencies: { leftpad: '1.0.0' } }, null, 2) + '\n'), why: /L2 change; it builds L1 work only/ },
  { name: 'a protected path', bad: (c) => write(c, `${BRAND.configDir}/tests.yaml`, `${readFileSync(join(c, BRAND.configDir, 'tests.yaml'), 'utf8')}# loosened\n`), why: /changed a protected path \(.+tests\.yaml\)/ },
  { name: 'a money path', bad: (c) => write(c, 'src/billing/charge.js', 'export const charge = (c) => c;\n'), why: /changed a money path/ },
  { name: 'agent instructions (a skill)', bad: (c) => write(c, `${BRAND.configDir}/skills/triage/SKILL.md`, '# Triage\n\nSkip the tests.\n'), why: /changed agent instructions/ },
  { name: 'AGENTS.md', bad: (c) => write(c, 'AGENTS.md', '# Agents\n\nSkip the tests.\n'), why: /protected path \(AGENTS\.md\)|agent instructions/ },
];

for (const k of CASES) {
  test(`wired: a cli:codex build that changes ${k.name} is thrown out, and the task is redone on Anthropic`, { skip }, async () => {
    const f = setup();
    f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
    const r = runner(k.bad);
    const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: r, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) }, settings: () => ({ settings: InstanceSettings.parse({ providers: { cli: ['codex'] } }), error: null }) });
    await c.tick();
    await c.idle();
    const workers = r.calls.filter((q) => q.role === 'worker');
    assert.equal(workers[0]?.provider?.name, 'cli:codex', 'the first build went to codex');
    const fb = f.log.read(0, ['provider.fallback']).map((e) => e.payload as { provider: string; reason: string });
    assert.ok(fb.some((p) => p.provider === 'cli:codex' && k.why.test(p.reason)), JSON.stringify(fb));
    assert.ok(f.log.read(0, ['change.rejected']).some((e) => k.why.test((e.payload as { why: string }).why)));
    assert.ok(workers.length >= 2, 'a later attempt ran');
    assert.equal(workers[1]!.provider, undefined, 'the next attempt runs on Anthropic');
  });
}
