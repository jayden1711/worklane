// The evaluator, wired: the model judging a change is picked from its level (cheap for L0, the evaluator role's
// model above), a cheap verdict that isn't a confident pass goes once to the stronger model, and what the run
// read comes from its run record, never from the files it says it reviewed (#106).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import type { InstanceSettings } from '../src/instance.js';
import { DEFAULT_COMMIT_IDENTITY, FakeRunner, type FakeResult, type RunRequest } from '../src/runner.js';
import { which } from '../src/os/index.js';
import { stageOf } from '../src/throughput.js';
import { repoRoot } from './helpers.js';

const skip = !which('gitleaks') && 'gitleaks not installed (the coordinator refuses unscanned changes)';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ISSUE = 'Totals count non-positive quantities.\n\n```done_when\n- test: test/price.test.js\n```\n';

type Edit = 'code' | 'docs' | 'comment';
const EDITS: Record<Edit, (cwd: string) => void> = {
  code: (cwd) => {
    const p = join(cwd, 'src', 'price.js');
    writeFileSync(p, readFileSync(p, 'utf8').replace('sum + cents * qty', 'sum + (qty > 0 ? cents * qty : 0)'));
  },
  docs: (cwd) => {
    mkdirSync(join(cwd, 'docs'), { recursive: true });
    writeFileSync(join(cwd, 'docs', 'pricing.md'), '# Pricing\n\nTotals are integer cents.\n');
  },
  comment: (cwd) => {
    const p = join(cwd, 'src', 'price.js');
    writeFileSync(p, readFileSync(p, 'utf8').replace('// Prices are integer cents; never floats.', '// Prices are integer cents; never floats or strings.'));
  },
};

/** A worker that makes `edit`; each verdict run answers from `verdicts` in turn (the last repeats). */
function agents(edit: Edit, verdicts: ((req: RunRequest, files: string[]) => FakeResult)[]) {
  let i = 0;
  return new FakeRunner((req) => {
    if (req.role === 'worker') {
      EDITS[edit](req.cwd);
      git(req.cwd, 'add', '-A');
      git(req.cwd, '-c', `user.email=${DEFAULT_COMMIT_IDENTITY.email}`, '-c', `user.name=${DEFAULT_COMMIT_IDENTITY.name}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'change');
      return { structured: { summary: 'changed' } };
    }
    if (req.role === 'evaluator-repro') return { structured: { test_path: '', explanation: '', not_reproducible: 'covered by the existing test' } };
    const base = /Base commit: ([0-9a-f]{40})/.exec(req.prompt)![1]!;
    const files = git(req.cwd, 'diff', '--name-only', `${base}..HEAD`).split('\n').filter(Boolean);
    return verdicts[Math.min(i++, verdicts.length - 1)]!(req, files);
  });
}

const pass = (confidence = 'high') => (_: RunRequest, files: string[]): FakeResult => ({ structured: { patch_correct: true, test_correct: true, confidence, confidence_reason: confidence === 'high' ? '' : 'the totals test was not run on a zero quantity', advice: '', claims: [{ claim: 'read the diff in full', label: 'measured', basis: 'git diff' }], files_reviewed: files, design_change: false } });

async function run(runner: FakeRunner, settings: InstanceSettings = {}) {
  const base = mkdtempSync(join(tmpdir(), 'eval-wire-'));
  const remote = join(base, 'remote.git');
  const seed = join(base, 'seed');
  cpSync(join(repoRoot, 'examples', 'basic'), seed, { recursive: true });
  writeFileSync(join(seed, '.gitignore'), '.claude/worktrees/\n');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', 'add', '-A');
  git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const repo = join(base, 'clone');
  git(base, 'clone', '-q', remote, repo);
  for (const [k, v] of [['user.email', 'coordinator@example.com'], ['user.name', 'coordinator'], ['commit.gpgsign', 'false']]) git(repo, 'config', k!, v!);
  const cfg = loadConfig(repo);
  cfg.project.land_mode = 'pr';
  cfg.tests.runner.changed = 'node --test --test-reporter=spec';
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  const log = new EventLog(join(base, 'events.db'));
  const backlog = new FileBacklog(join(base, 'backlog.json'), 'coordinator');
  backlog.open({ title: 'Totals skip non-positive quantities', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  const c = new Coordinator({ cfg, log, backlog, runner, repo, instance: 'alice', stateDir: join(base, 'state'), slotsDir, maxAttempts: 1, settings: () => ({ settings, error: null }), machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
  await c.tick();
  await c.idle();
  const verdictRuns = runner.calls.filter((r) => r.role === 'evaluator-verdict');
  const verdict = log.read(0, ['eval.verdict']).at(-1)?.payload as { model?: string; escalated_from?: string; unread?: string[]; patch_correct: boolean } | undefined;
  const level = log.read(0, ['review.level_set']).at(-1)?.payload as { level: string; reasons: string[] } | undefined;
  const costs = log.read(0, ['run.cost']).map((e) => e.payload as { role: string; model: string }).filter((p) => p.role.startsWith('evaluator-') && p.role !== 'evaluator-repro');
  return { verdictRuns, verdict, level, costs };
}

test('#106: an evaluator that says it reviewed a file its run never read leaves that file unread; the change waits for a human', { skip }, async () => {
  const t = await run(agents('code', [(_, files) => ({ ...pass()(_, files), reads: [] })]));
  assert.deepEqual(t.verdict?.unread, ['src/price.js'], 'computed from the run record, not files_reviewed');
  assert.equal(t.level?.level, 'L3');
  assert.ok(t.level!.reasons.some((r) => /evaluator did not read: src\/price\.js/.test(r)), t.level!.reasons.join(' | '));
});

test('#693: the evaluator is told to read the diff as text, with no textconv or external diff and every submodule link, whatever the change\'s .gitattributes or .gitmodules says', { skip }, async () => {
  const t = await run(agents('code', [pass()]));
  const prompt = t.verdictRuns[0]!.prompt;
  const line = prompt.split('\n').find((l) => l.startsWith('Base commit: '));
  assert.match(line ?? '', /^Base commit: ([0-9a-f]{40})\. Head: ([0-9a-f]{40})\. Inspect with: git diff --text --no-textconv --no-ext-diff --ignore-submodules=none \1\.\.\2$/, prompt);
});

test('#106: a file the run did read is not unread, whatever the evaluator lists', { skip }, async () => {
  const t = await run(agents('code', [() => ({ structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '', claims: [{ claim: 'read the diff in full', label: 'measured', basis: 'git diff' }], files_reviewed: [], design_change: false }, reads: ['src/price.js'] })]));
  assert.equal(t.verdict?.unread, undefined);
  assert.notEqual(t.level?.level, 'L3');
});

test('tiered: an app change is judged by the evaluator role\'s model; a docs-only or comment-only change by the cheap model', { skip }, async () => {
  const code = await run(agents('code', [pass()]));
  assert.deepEqual(code.verdictRuns.map((r) => r.model), ['opus']);
  assert.equal(code.verdict?.model, 'opus');
  const docs = await run(agents('docs', [pass()]));
  assert.deepEqual(docs.verdictRuns.map((r) => r.model), ['sonnet']);
  assert.deepEqual([docs.verdict?.model, docs.verdict?.escalated_from], ['sonnet', undefined]);
  const comment = await run(agents('comment', [pass()]));
  assert.deepEqual(comment.verdictRuns.map((r) => r.model), ['sonnet'], 'a comment-only change in app code routes as L0');
});

test('tiered: a cheap verdict that is not a confident pass goes once to the stronger model, whose verdict is final', { skip }, async () => {
  const unsure = await run(agents('docs', [pass('medium'), pass()]));
  assert.deepEqual(unsure.verdictRuns.map((r) => r.model), ['sonnet', 'opus']);
  assert.deepEqual([unsure.verdict?.model, unsure.verdict?.escalated_from], ['opus', 'sonnet']);
  assert.deepEqual(unsure.costs.map((c) => [c.role, c.model]), [['evaluator-verdict', 'sonnet'], ['evaluator-escalated', 'opus']]);
  const rejected = await run(agents('docs', [() => ({ structured: { patch_correct: false, test_correct: true, confidence: 'high', advice: 'typo', claims: [{ claim: 'read the diff in full', label: 'measured', basis: 'git diff' }], files_reviewed: ['docs/pricing.md'], design_change: false } }), pass('low')]));
  assert.deepEqual(rejected.verdictRuns.map((r) => r.model), ['sonnet', 'opus'], 'a rejection escalates');
  assert.equal(rejected.verdict?.model, 'opus');
  const unread = await run(agents('docs', [(_, files) => ({ ...pass()(_, files), reads: [] }), pass()]));
  assert.deepEqual(unread.verdictRuns.map((r) => r.model), ['sonnet', 'opus'], 'a pass that read nothing escalates');
  const strongUnsure = await run(agents('code', [pass('medium')]));
  assert.deepEqual(strongUnsure.verdictRuns.map((r) => r.model), ['opus'], "the strong model's verdict is never escalated");
});

test('tiered: settable per instance: escalation off, or the cheap model on no level', { skip }, async () => {
  const off = await run(agents('docs', [pass('medium')]), { eval_routing: { escalate: false } });
  assert.deepEqual(off.verdictRuns.map((r) => r.model), ['sonnet']);
  const none = await run(agents('docs', [pass()]), { eval_routing: { cheap_levels: [] } });
  assert.deepEqual(none.verdictRuns.map((r) => r.model), ['opus']);
  const haiku = await run(agents('docs', [pass()]), { eval_routing: { cheap_model: 'haiku' } });
  assert.deepEqual(haiku.verdictRuns.map((r) => r.model), ['haiku']);
});

test('the escalated evaluator\'s cost is booked to the evaluator stage', () => {
  assert.equal(stageOf('evaluator-escalated'), 'evaluator');
});
