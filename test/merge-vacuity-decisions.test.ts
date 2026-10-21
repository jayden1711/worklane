// #784, the owner's four decisions, built in round 2:
// (a) auto-config turns the coverage run on (vacuity.dynamic) where runner.one runs one test file in Node, and says how
//     to turn it on where it can't;
// (b) a repo with no vacuity section waits too;
// (c) a fix-forward PR the gate holds while main is red is flagged in the digest, and said at once on the ops channel;
// (d) a test run against a build (dist/) counts for the source file its source map names; one it can't map holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { detectProject, draftTests, planFrom } from '../src/auto-config.js';
import { BRAND } from '../src/brand.js';
import { FileBacklog } from '../src/backlog/file.js';
import type { PullRequest } from '../src/backlog/types.js';
import { loadConfig } from '../src/config/load.js';
import { ReviewConfig, TestsConfig } from '../src/config/schema.js';
import { Coordinator } from '../src/coordinator.js';
import { waitingOnYou } from '../src/digest.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { IntakeConfig, type IntakeSource, type ReplyOptions } from '../src/intake/report.js';
import { FakeRunner } from '../src/runner.js';
import { exampleProject } from './helpers.js';
import { approve, green, openPr, skip } from './repro-state-graph/harness.js';

// ---- (a) auto-config

/** The drafted tests.yaml for a repo holding `files`. */
function drafted(files: Record<string, string>): { text: string; doc: ReturnType<typeof TestsConfig.parse> } {
  const dir = mkdtempSync(join(tmpdir(), 'ac-vacuity-'));
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), t);
  }
  const text = draftTests(planFrom(detectProject(dir, Object.keys(files).sort(), {}), { answers: {}, overrides: {} }), []);
  return { text, doc: TestsConfig.parse(parse(text)) };
}
const pkg = (o: object) => JSON.stringify(o);

test('(a) auto-config: a runner that runs one test file in Node turns the coverage run on (node --test, vitest)', () => {
  const node = drafted({ 'package.json': pkg({ scripts: { test: 'node --test' } }), 'package-lock.json': '{}', 'src/a.js': '', 'test/a.test.js': "import assert from 'node:assert';" });
  assert.deepEqual([node.doc.runner.one, node.doc.vacuity?.dynamic], ['node --test {file}', true]);
  const vitest = drafted({ 'package.json': pkg({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '1' } }), 'package-lock.json': '{}', 'src/a.ts': '', 'src/a.test.ts': 'expect(1)' });
  assert.deepEqual([vitest.doc.runner.one, vitest.doc.vacuity?.dynamic], ['npx vitest run {file}', true]);
  assert.doesNotMatch(node.text, /vacuity\.dynamic is false/, 'no note when it is on');
});

test('(a) auto-config: where none is found, the run stays off and the draft says how to turn it on, with lines to paste', () => {
  const none = drafted({ 'package.json': pkg({ scripts: { test: 'custom-runner' } }), 'package-lock.json': '{}', 'src/a.js': '', 'test/a.test.js': "import assert from 'node:assert';" });
  assert.equal(none.doc.vacuity?.dynamic, false);
  assert.match(none.text, /# note: vacuity\.dynamic is false .*every PR that changes app code waits for you/);
  assert.match(none.text, /#\s+dynamic: true\n/);
  assert.match(none.text, /#\s+one: "node --test \{file\}"/);
  const py = drafted({ 'pyproject.toml': '[tool.pytest.ini_options]\n', 'app/a.py': '', 'tests/test_a.py': 'assert 1' });
  assert.equal(py.doc.vacuity?.dynamic ?? false, false, 'pytest: not a Node run, so off');
});

// ---- the coordinator, on a real repo with the example project's tests.yaml

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
type Run = { tests: string[]; appPaths: string[] };
type Gate = { mergeDecisionFor(n: number, number: number, pr: PullRequest): { auto: boolean; reasons: string[]; vacuityRun?: Run }; vacuityRun(w: EventPayload<'pr.opened'>, pr: PullRequest, run: Run): Promise<void> };

function prWith(files: Record<string, string>, tune: (c: ReturnType<typeof loadConfig>) => void = () => {}, links: Record<string, string> = {}) {
  const dir = exampleProject().dir;
  // The build's folder is there before the PR (a new top-level folder is a design hold of its own).
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', '.keep'), '');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'dist');
  const base = git(dir, 'rev-parse', 'HEAD');
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  for (const [p, to] of Object.entries(links)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    symlinkSync(to, join(dir, p));
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'change');
  const head = git(dir, 'rev-parse', 'HEAD');
  const cfg = loadConfig(dir);
  cfg.project.land_mode = 'pr';
  cfg.review = ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: [] }, L1_evaluator: { when: ['app-non-money'] }, L2_notify: { when: [] }, L3_human: { when: ['secrets'] } } });
  tune(cfg);
  const log = new EventLog(join(dir, '..', 'events.db'));
  log.append('issue.claimed', { issue: 7, instance: 'i', lease: 'a'.repeat(40), base, owner: 'example-owner' }, 'i');
  const w = { issue: 7, number: 9, url: 'u', head, draft: false };
  log.append('pr.opened', w, 'i');
  log.append('eval.verdict', { issue: 7, head, patch_hash: 'h', patch_correct: true, test_correct: true, confidence: 'high', advice: '', design_change: false }, 'i');
  const c = new Coordinator({ cfg, log, backlog: new FileBacklog(join(dir, '..', 'b.json')), runner: new FakeRunner(() => ({})), repo: dir, instance: 'i', stateDir: join(dir, '..', 'state'), autoMerge: () => true }) as unknown as Gate;
  const pr: PullRequest = { number: 9, url: 'u', head: 'b', base: 'main', headSha: head, draft: false, state: 'open', title: 't', mergeable: true, mergeableState: 'clean' };
  return { c, w, pr, log };
}

/** The decision after the coverage run it asks for, if it asks for one. */
async function decided(t: ReturnType<typeof prWith>) {
  const first = t.c.mergeDecisionFor(7, 9, t.pr);
  if (first.vacuityRun) await t.c.vacuityRun(t.w, t.pr, first.vacuityRun);
  return t.c.mergeDecisionFor(7, 9, t.pr);
}

// ---- (b) no vacuity section

const PRICE_JS = '// Prices are integer cents.\nexport function totalCents(items) {\n  return items.reduce((s, { cents, qty }) => s + cents * qty, 0) + 0;\n}\n\nexport function applyDiscount(cents, pct) {\n  return Math.round(cents * (100 - pct) / 100);\n}\n';

test('(b) no vacuity section: a PR that changes code waits, naming the missing section', () => {
  const t = prWith({ 'src/price.js': PRICE_JS }, (c) => void delete c.tests.vacuity);
  const d = t.c.mergeDecisionFor(7, 9, t.pr);
  assert.deepEqual([d.auto, d.reasons, d.vacuityRun], [false, [`design: vacuity: tests.yaml has no vacuity section, so nothing shows its tests run the code it changes (src/price.js); \`${BRAND.cli} doctor\` shows the section to add`], undefined]);
});

test('(b) no vacuity section: docs, config and tests alone still merge (control)', () => {
  const t = prWith({ 'README.md': '# more\n', 'src/settings.yaml': 'a: 1\n', 'test/x.test.js': 'assert.ok(1)\n' }, (c) => void delete c.tests.vacuity);
  const d = t.c.mergeDecisionFor(7, 9, t.pr);
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

// ---- (d) a test run against a build, mapped by its source map

const DIST = 'export function totalCents(items) {\n  return items.reduce((s, { cents, qty }) => s + cents * qty, 0);\n}\n//# sourceMappingURL=price.js.map\n';
const MAP = JSON.stringify({ version: 3, file: 'price.js', sourceRoot: '', sources: ['../src/price.ts'], names: [], mappings: 'AAAA' });
const DIST_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { totalCents } from '../dist/price.js';\ntest('t', () => { assert.equal(totalCents([{ cents: 2, qty: 3 }]), 6); });\n";
const TS = 'export function totalCents(items: { cents: number; qty: number }[]): number {\n  return items.reduce((s, { cents, qty }) => s + cents * qty, 0);\n}\n';

test('(d) a test that runs the build (dist/) of a changed source file counts for it, by the build\'s source map', async () => {
  const t = prWith({ 'src/price.ts': TS, 'dist/price.js': DIST, 'dist/price.js.map': MAP, 'test/dist.test.js': DIST_TEST });
  const d = await decided(t);
  assert.deepEqual([d.auto, d.reasons], [true, []]);
  const m = t.log.read(0, ['vacuity.measured']).map((e) => e.payload as { touched: string[] });
  assert.deepEqual(m.map((x) => x.touched), [['src/price.ts']], 'the coverage of dist/price.js counted for src/price.ts');
});

test('(d) coverage it can\'t map holds the PR: no map, a map that is a symlink, a map naming a file outside the repo', async () => {
  const ranNone = 'design: vacuity: its tests (test/dist.test.js) ran none of the app code it changes (src/price.ts)';
  const noMap = await decided(prWith({ 'src/price.ts': TS, 'dist/price.js': DIST, 'test/dist.test.js': DIST_TEST }));
  assert.deepEqual([noMap.auto, noMap.reasons], [false, [ranNone]], 'no map');
  const linked = await decided(prWith({ 'src/price.ts': TS, 'dist/price.js': DIST, 'test/dist.test.js': DIST_TEST, 'dist/real.map': MAP }, () => {}, { 'dist/price.js.map': 'real.map' }));
  assert.deepEqual([linked.auto, linked.reasons], [false, [ranNone]], 'a map that is a symlink is never followed');
  const outside = await decided(prWith({ 'src/price.ts': TS, 'dist/price.js': DIST, 'test/dist.test.js': DIST_TEST, 'dist/price.js.map': JSON.stringify({ version: 3, sources: ['../../../../../elsewhere/src/price.ts'], mappings: '' }) }));
  assert.deepEqual([outside.auto, outside.reasons], [false, [ranNone]], 'a source outside the repo counts for nothing');
});

test('(d) a source map that is a FIFO, or over its size limit, is never read: the reader returns at once, mapping nothing', { skip: process.platform === 'win32' && 'POSIX FIFO' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'map-root-'));
  mkdirSync(join(root, 'dist'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'dist', 'a.js'), 'export function a() { return 1; }\n');
  writeFileSync(join(root, 'dist', 'b.js'), 'export function b() { return 1; }\n');
  execFileSync('mkfifo', [join(root, 'dist', 'a.js.map')]);
  const big = execFileSync(process.execPath, ['-e', 'const fs=require("fs");const fd=fs.openSync(process.argv[1],"w");fs.ftruncateSync(fd,8*1024*1024+1);fs.closeSync(fd)', join(root, 'dist', 'b.js.map')]);
  void big;
  const cov = join(root, '.cov');
  mkdirSync(cov);
  const fn = (file: string) => ({ url: new URL(`file://${join(root, file)}`).href, functions: [{ functionName: 'a', ranges: [{ count: 1 }] }] });
  writeFileSync(join(cov, 'c.json'), JSON.stringify({ result: [fn('dist/a.js'), fn('dist/b.js')] }));
  const probe = "const [mod, cov, root] = process.argv.slice(1); const m = await import(mod); console.log(JSON.stringify(m.touchedAppFiles(cov, root, ['src/**'])));";
  const mod = new URL('../src/vacuity.js', import.meta.url).href;
  const t0 = Date.now();
  const r = execFileSync(process.execPath, ['--input-type=module', '-e', probe, mod, cov, root], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' });
  assert.deepEqual(JSON.parse(r.trim()), [], 'nothing mapped');
  assert.ok(Date.now() - t0 < 5_000, 'at once');
});

// ---- (c) fix-forward's PR held while main is red

test('(c) the digest flags a waiting PR that is fix-forward\'s fix while main is red, and stops once main is green', () => {
  const ev = (type: string, payload: object, ts: string) => ({ type, ts, payload });
  const events = [
    ev('issue.seen', { issue: 7, title: 'Fix main: ci red since #4' }, '2026-10-20T08:00:00Z'),
    ev('fix_forward.started', { sha: 'a'.repeat(40), number: 4, failed: ['ci'], last_green: null, candidates: [] }, '2026-10-20T08:00:01Z'),
    ev('fix_forward.attempt', { sha: 'a'.repeat(40), attempt: 1, issue: 7, culprit: 4 }, '2026-10-20T08:00:02Z'),
    ev('pr.opened', { issue: 7, number: 9, url: 'u', head: 'b'.repeat(40), draft: false }, '2026-10-20T08:10:00Z'),
    ev('merge.decided', { issue: 7, number: 9, head: 'b'.repeat(40), auto: false, reasons: ['design: vacuity: it changes app code (src/a.js) and no test'] }, '2026-10-20T08:20:00Z'),
  ];
  const item = waitingOnYou(events as never, new Date('2026-10-20T09:00:00Z'), { updates: [] }).items.find((i) => i.pr === 9)!;
  assert.match(item.detail, /^MAIN IS RED: this is fix-forward's fix, and main stays red until you merge it/);
  assert.match(item.detail, /design: vacuity: it changes app code/);
  const green = [...events, ev('fix_forward.green', { sha: 'a'.repeat(40), tip: 'c'.repeat(40), fixed_by: null, reverted: 4 }, '2026-10-20T08:30:00Z')];
  assert.doesNotMatch(waitingOnYou(green as never, new Date('2026-10-20T09:00:00Z'), { updates: [] }).items.find((i) => i.pr === 9)!.detail, /MAIN IS RED/, 'main green again: an ordinary hold');
});

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

test('(c) a fix-forward PR the gate holds while main is red is said at once on the ops channel, once per PR and head', { skip }, async () => {
  const chat = fakeChat();
  const intake = IntakeConfig.parse({ version: 1, discord: { enabled: true, guild: '555555', channels: ['111111'], allowed_senders: ['100000000001'], people: { '100000000001': 'example-owner' }, ops_channel: OPS, dashboard_url: 'https://dashboard.example.test', owners: ['100000000001'] } });
  // Passes as the task's own checks run it; fails under the gate's coverage run: the gate holds it.
  const t = await openPr({ 'evaluator-verdict': approve() }, {
    autoMerge: () => true,
    edit: (cfg) => {
      cfg.tests.runner.one = 'node --test --test-reporter=spec {file} && test -z "$NODE_V8_COVERAGE"';
      cfg.project.fix_forward.max_attempts = 0; // fix-forward's own steps stay out of the way: only its record is read
    },
    deps: { intake: { config: () => intake, sources: [chat] } },
  });
  // The default branch is red, and this PR's task is fix-forward's fix for it.
  t.f.log.append('fix_forward.started', { sha: 'a'.repeat(40), number: null, failed: ['ci'], last_green: null, candidates: [] }, 'alice');
  t.f.log.append('fix_forward.attempt', { sha: 'a'.repeat(40), attempt: 1, issue: t.n, culprit: null }, 'alice');
  await green(t);
  await t.c.idle();
  await green(t);
  await t.c.idle();
  await green(t);
  const held = chat.posts.filter((p) => p.where === OPS && /fix-forward's fix waits for you/.test(p.text));
  assert.equal(held.length, 1, `one notice (posts: ${JSON.stringify(chat.posts.map((p) => p.text.slice(0, 80)))})`);
  assert.match(held[0]!.text, new RegExp(`#${t.opened.number}`));
  assert.match(held[0]!.text, /design: vacuity: its coverage run failed/);
  assert.equal(t.f.log.read(0, ['merge.done']).length, 0, 'still not merged');
});
