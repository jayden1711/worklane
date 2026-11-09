import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { ReviewConfig } from '../src/config/schema.js';
import { Coordinator } from '../src/coordinator.js';
import { questionLines } from '../src/coordinator/landing.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { DEFAULT_COMMIT_IDENTITY, FakeRunner, type RunRequest } from '../src/runner.js';
import { which } from '../src/os/index.js';
import { repoRoot } from './helpers.js';

// R1182r (adversarial) on #1182. R1: `app-non-money-large` (recorded as `*`) binds the app files it counts, never a docs
// build stamp, so the re-ask loop stays gone. R2: the files real-path categories name are listed first, also under `*`.
// R3: the print holds each bound file's entry at main's tip too, so an approval never covers a land that undoes main's
// later change to it. Ported from the review's JavaScript (attacks-1182r), assertions unchanged except R3's control.

const skip = !which('gitleaks') && 'gitleaks not installed';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const PRINT = 'landing floor, exactly this batch and these files: sha256 ';
const REVIEW = (wait: string[], l1: Record<string, number> = {}) =>
  ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: ['app-non-money'], max_lines: 100000 }, L1_evaluator: { when: [], ...l1 }, L2_notify: { when: [] }, L3_human: { when: [] } }, merge: { wait_categories: wait } });

function fixture(wait: string[] = [], l1: Record<string, number> = {}) {
  const base = mkdtempSync(join(tmpdir(), 'r1182r-'));
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
  for (const [k, v] of [['user.email', 'coordinator@example.com'], ['user.name', 'coordinator'], ['commit.gpgsign', 'false'], ['core.precomposeunicode', 'false']]) git(repo, 'config', k!, v!);
  const cfg = loadConfig(repo);
  cfg.project.land_mode = 'direct';
  cfg.tests.runner.changed = 'node --test --test-reporter=spec';
  cfg.review = REVIEW(wait, l1);
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  return { base, remote, repo, cfg, backlog: new FileBacklog(join(base, 'backlog.json'), 'coordinator'), log: new EventLog(join(base, 'events.db')), slotsDir, stateDir: join(base, 'state') };
}
type Fixture = ReturnType<typeof fixture>;
type Queued = EventPayload<'land.queued'>;
type Floor = { held: string[]; ask: unknown[]; seen: boolean; listed: string[]; print: string };
const ISSUE = 'Totals count non-positive quantities.\n\n```done_when\n- test: test/price.test.js\n```\n';
const runner = (extra: Record<string, string>) =>
  new FakeRunner((req: RunRequest) => {
    if (req.role === 'worker') {
      const p = join(req.cwd, 'src', 'price.js');
      writeFileSync(p, readFileSync(p, 'utf8').replace('sum + cents * qty', 'sum + (qty > 0 ? cents * qty : 0)'));
      for (const [f, body] of Object.entries(extra)) {
        mkdirSync(dirname(join(req.cwd, f)), { recursive: true });
        writeFileSync(join(req.cwd, f), body);
      }
      git(req.cwd, 'add', '-A');
      git(req.cwd, '-c', `user.email=${DEFAULT_COMMIT_IDENTITY.email}`, '-c', `user.name=${DEFAULT_COMMIT_IDENTITY.name}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fix');
      return { structured: { summary: 'fixed' } };
    }
    return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: 'looks right', claims: [{ claim: 'read the diff in full', label: 'measured', basis: 'git diff' }], files_reviewed: ['src/price.js', ...Object.keys(extra)], design_change: false } };
  });
const coord = (f: Fixture, extra: Record<string, string> = {}) => new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: runner(extra), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, maxAttempts: 1, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
async function cycle(f: Fixture, extra: Record<string, string> = {}) {
  const c = coord(f, extra);
  await c.tick();
  await c.idle();
}
const landFloor = (f: Fixture, tip: string, head: string, applied: Queued[]) => (coord(f) as unknown as { landFloor(p: string, t: string, h: string, a: Queued[]): Floor }).landFloor(f.repo, tip, head, applied);
const onMain = (f: Fixture) => git(f.base, '--git-dir', f.remote, 'ls-tree', '-r', '--name-only', 'main').split('\n');
const asked = (f: Fixture) => f.log.read(0, ['decision.asked']).map((e) => e.payload as EventPayload<'decision.asked'>).filter((q) => q.kind === 'land');

let n = 0;
function levelAndApprove(f: Fixture, o: { issue: number; head: string; level: 'L1' | 'L3'; reasons?: string[]; approved?: boolean }) {
  f.log.append('review.level_set', { issue: o.issue, head: o.head, level: o.level, reasons: o.reasons ?? [] }, 'coordinator');
  if (o.approved) {
    const id = `r${o.issue}-${n++}`;
    f.log.append('decision.asked', { id, kind: 'land', issue: o.issue, owner: 'example-owner', question: 'Approve?', options: ['approve', 'reject'], recommendation: 'reject', receipts: [] }, 'coordinator');
    f.log.append('decision.answered', { id, by: 'example-owner', answer: 'approve' }, 'example-owner', 'human');
  }
}
function event(f: Fixture, o: { issue: number; head: string; base: string; files: string[]; level: 'L1' | 'L3'; approved?: boolean }): Queued {
  f.log.append('change.proposed', { issue: o.issue, branch: `b${o.issue}`, base: o.base, head: o.head, files: o.files, lines: 1, patch_hash: 'x' }, 'coordinator');
  levelAndApprove(f, o);
  const q = { issue: o.issue, head: o.head, level: o.level } as Queued;
  f.log.append('land.queued', q, 'coordinator');
  return q;
}
const approveAtLanding = (f: Fixture, q: Queued, fl: Floor) => levelAndApprove(f, { issue: q.issue, head: q.head, level: 'L3', reasons: [...fl.held.map((r) => `${r}: held`), ...fl.listed, `${PRINT}${fl.print}`], approved: true });
const put = (r: string, p: string, body: string) => {
  mkdirSync(dirname(join(r, p)), { recursive: true });
  writeFileSync(join(r, p), body);
};
const commitIn = (r: string) => (m: string) => {
  git(r, 'add', '-A');
  git(r, 'commit', '-q', '--allow-empty', '-m', m);
  return git(r, 'rev-parse', 'HEAD');
};
/** Entry 1 (approved at review) adds src/ok.js; `output(write)` makes a land commit on top of it with what `write` puts. */
function withApproved(f: Fixture) {
  const r = f.repo;
  const tip = git(r, 'rev-parse', 'HEAD');
  const commit = commitIn(r);
  writeFileSync(join(r, 'src', 'ok.js'), 'export const ok = 1;\n');
  const a = commit('A');
  const qa = event(f, { issue: 1, head: a, base: tip, files: ['src/ok.js'], level: 'L3', approved: true });
  const output = (write: () => void, m = 'pre-land') => {
    git(r, 'checkout', '-q', '-f', a);
    write();
    return commit(m);
  };
  return { tip, qa, output };
}
const lines = (k: number, tag: string) => Array.from({ length: k }, (_, i) => `export const v${i} = ${JSON.stringify(tag)};`).join('\n') + '\n';
const CI = 'test: { script: [echo ok] }\n';
const HARDENED = 'test: { script: [echo ok], rules: [{ if: "$CI_PIPELINE_SOURCE != \\"merge_request_event\\"" }] }\n';

test('R1a (unit): app-non-money-large held; only a docs build stamp changed between passes: the approval should still cover', () => {
  const f = fixture(['app-non-money-large'], { max_lines: 50 });
  const { tip, qa, output } = withApproved(f);
  const h1 = output(() => (put(f.repo, 'src/gen.js', lines(200, 'same')), put(f.repo, 'docs/build-info.md', 'built 1\n')), 'pass 1');
  const fl1 = landFloor(f, tip, h1, [qa]);
  assert.ok(fl1.held.length === 1 && /app-non-money-large/.test(fl1.held[0]!), `control: only app-non-money-large held: ${JSON.stringify(fl1.held)}`);
  // Control: the stamp alone raises nothing.
  const hs = output(() => put(f.repo, 'docs/build-info.md', 'built 1\n'), 'stamp only');
  assert.equal(landFloor(f, tip, hs, [qa]).held.length, 0, 'control: the stamp alone raises nothing');
  approveAtLanding(f, qa, fl1);
  assert.equal(landFloor(f, tip, h1, [qa]).ask.length, 0, 'control: the identical land commit is covered');
  const h2 = output(() => (put(f.repo, 'src/gen.js', lines(200, 'same')), put(f.repo, 'docs/build-info.md', 'built 2\n')), 'pass 2');
  const fl2 = landFloor(f, tip, h2, [qa]);
  assert.equal(fl2.ask.length, 0, `RE-ASK LOOP: only a docs stamp (raises nothing) changed, yet the approval is stale; print ${fl1.print.slice(0, 12)} -> ${fl2.print.slice(0, 12)}`);
  // Not the review's: the app files `*` counts stay bound. The generated file with other content is asked again.
  const h3 = output(() => (put(f.repo, 'src/gen.js', lines(200, 'other')), put(f.repo, 'docs/build-info.md', 'built 1\n')), 'pass 3');
  assert.equal(landFloor(f, tip, h3, [qa]).ask.length, 1, 'the large app file changed: asked again');
});

test('R1b (end to end): pre-land writes the same large generated file and a per-pass docs stamp: one approve should land it', { skip }, async () => {
  const f = fixture(['app-non-money-large'], { max_lines: 50 });
  f.cfg.guardrails.push.max_changed_lines = 5000;
  const counter = join(f.base, 'counter');
  f.cfg.tests.land.pre = ['node tools/gen.mjs'];
  const gen = `import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const c = ${JSON.stringify(counter)};
const n = existsSync(c) ? Number(readFileSync(c, 'utf8')) : 0;
writeFileSync(c, String(n + 1));
mkdirSync('docs', { recursive: true });
writeFileSync('docs/build-info.md', 'built ' + n + '\\n');
writeFileSync('src/gen.js', Array.from({ length: 200 }, (_, i) => 'export const v' + i + ' = 0;').join('\\n') + '\\n');
`;
  f.backlog.open({ title: 'Totals skip non-positive quantities', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  await cycle(f, { 'tools/gen.mjs': gen });
  for (let i = 0; i < 3 && !asked(f).length; i++) await cycle(f);
  assert.equal(asked(f).length, 1, 'control: asked once at landing');
  for (let round = 0; round < 3; round++) {
    const q = asked(f).at(-1)!;
    f.log.append('decision.answered', { id: q.id, by: 'example-owner', answer: 'approve' }, 'example-owner', 'human');
    for (let i = 0; i < 2; i++) await cycle(f);
    if (onMain(f).includes('src/gen.js')) break;
  }
  assert.ok(onMain(f).includes('src/gen.js'), `RE-ASK LOOP: approved 3 times, never landed; questions: ${asked(f).length}`);
  assert.equal(asked(f).length, 1, 'asked once');
});

test('R2: app-non-money-large + agent-instructions: a 4th CLAUDE.md hidden by the reason\'s "and 1 more" is shown in the question', () => {
  const f = fixture(['app-non-money-large'], { max_lines: 50 });
  const { tip, qa, output } = withApproved(f);
  const h1 = output(() => {
    for (let i = 0; i < 60; i++) put(f.repo, `a/f${String(i).padStart(2, '0')}.js`, `export const x = ${i};\n`);
    for (let i = 0; i < 4; i++) put(f.repo, `z${i}/CLAUDE.md`, 'Be careful.\n');
  }, 'pass 1');
  const fl1 = landFloor(f, tip, h1, [qa]);
  assert.ok(fl1.held.some((h) => /app-non-money-large/.test(h)) && fl1.held.some((h) => /agent-instructions/.test(h)), `control: ${JSON.stringify(fl1.held)}`);
  assert.ok(!fl1.held.some((h) => h.includes('z3/CLAUDE.md')), 'control: the reason names only 3 of the 4');
  const q = questionLines(fl1.held.map((r) => `${r}: held`), fl1.listed, 'review.level_set event 1');
  assert.ok(q.some((l) => l.includes('z3/CLAUDE.md')), `HIDDEN: z3/CLAUDE.md is bound but not in the question (first file lines: ${JSON.stringify(q.filter((l) => l.startsWith('judged')).slice(0, 3))}, last: ${JSON.stringify(q.at(-1))})`);
});

test("R3: main hardens .gitlab-ci.yml after the owner approved output adding it; the land now reverts main's change: must be asked again", () => {
  const f = fixture();
  const r = f.repo;
  const tip1 = git(r, 'rev-parse', 'HEAD');
  const commit = commitIn(r);
  writeFileSync(join(r, 'src', 'ok.js'), 'export const ok = 1;\n');
  const a = commit('A');
  const qa = event(f, { issue: 1, head: a, base: tip1, files: ['src/ok.js'], level: 'L3', approved: true });
  put(r, '.gitlab-ci.yml', CI);
  const h1 = commit('pre-land pass 1');
  const fl1 = landFloor(f, tip1, h1, [qa]);
  assert.ok(fl1.held.some((h) => /ci-config/.test(h)), `control: ${JSON.stringify(fl1.held)}`);
  approveAtLanding(f, qa, fl1);
  // Meanwhile main gets a hardened CI file (another land, or a human).
  git(r, 'checkout', '-q', '-f', tip1);
  put(r, '.gitlab-ci.yml', HARDENED);
  const tip2 = commit('main: harden CI');
  // The land commit on the new tip: A cherry-picked (same head, so the same batch), the pre-land step writes X again.
  writeFileSync(join(r, 'src', 'ok.js'), 'export const ok = 1;\n');
  put(r, '.gitlab-ci.yml', CI);
  const h2 = commit('pre-land pass 2');
  const diff = git(r, 'diff', '--name-only', tip2, h2);
  assert.ok(diff.includes('.gitlab-ci.yml'), 'control: the land changes .gitlab-ci.yml (reverts the hardening)');
  const unapproved = landFloor(f, tip2, h2, [{ ...qa, level: 'L1' }]);
  assert.ok(unapproved.held.some((h) => /ci-config/.test(h)), `control: without the landing approval the land is held on ci-config: ${JSON.stringify(unapproved.held)}`);
  // Inverted from the review's control (`equal`, which showed the print had no tip side): the print now differs.
  assert.notEqual(unapproved.print, fl1.print, "the print holds main's side of the bound file");
  const fl2 = landFloor(f, tip2, h2, [qa]);
  assert.equal(fl2.ask.length, 1, `LANDS UNASKED: the land replaces main's hardened .gitlab-ci.yml with the older approved form; print unchanged (${fl1.print.slice(0, 12)} == ${fl2.print.slice(0, 12)})`);
});

test('R3b (not the review\'s): main moves through an unrelated file after the approval: the approval still covers (no loop)', () => {
  const f = fixture();
  const r = f.repo;
  const tip1 = git(r, 'rev-parse', 'HEAD');
  const commit = commitIn(r);
  writeFileSync(join(r, 'src', 'ok.js'), 'export const ok = 1;\n');
  const a = commit('A');
  const qa = event(f, { issue: 1, head: a, base: tip1, files: ['src/ok.js'], level: 'L3', approved: true });
  put(r, '.gitlab-ci.yml', CI);
  const h1 = commit('pre-land pass 1');
  const fl1 = landFloor(f, tip1, h1, [qa]);
  approveAtLanding(f, qa, fl1);
  git(r, 'checkout', '-q', '-f', tip1);
  put(r, 'README.md', 'moved on\n');
  const tip2 = commit('main: unrelated');
  writeFileSync(join(r, 'src', 'ok.js'), 'export const ok = 1;\n');
  put(r, '.gitlab-ci.yml', CI);
  const h2 = commit('pre-land pass 2');
  assert.equal(landFloor(f, tip2, h2, [qa]).ask.length, 0, 'main moved, the bound file is the same on both sides: covered');
});
