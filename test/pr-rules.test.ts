// Review rules for agent PRs (src/pr-rules.ts): the body's intent and risk class, the size limit, the docs-only
// fast path. The coordinator's wiring of each is in coordinator.test.ts ("review rules").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewConfig } from '../src/config/schema.js';
import { DEFAULT_REVIEW } from '../src/coordinator/shared.js';
import { waitCategoriesOf } from '../src/merge-policy.js';
import { checksFor, effectiveClass, prBodyHead, prBodyProblems, riskClassOf, rulesetHold, sizeFiles, sizeVerdict, type SizeFile } from '../src/pr-rules.js';
import { computeLevel } from '../src/review.js';

const review = ReviewConfig.parse(DEFAULT_REVIEW);
const classOf = (paths: string[], moneyPaths: RegExp[] = []) =>
  riskClassOf({ paths, level: computeLevel({ files: paths.map((path) => ({ path, added: 1, removed: 0 })), labels: [], moneyPaths }, review), waitCategories: waitCategoriesOf(review) });

const GOOD = `${prBodyHead({ intent: 'Totals ignore orders with a zero or negative quantity.', cls: 'logic', why: [] })}\n\nCloses #7\n`;

test('body: a body without the intent paragraph or without the risk class is refused; one with both passes', () => {
  assert.deepEqual(prBodyProblems(GOOD, 'logic'), []);
  assert.match(GOOD, /^\*\*Intent:\*\* Totals ignore orders with a zero or negative quantity\.\n\n\*\*Risk class:\*\* logic\n\nCloses #7/);
  // No intent at all: the old body, starting at "Closes".
  assert.match(prBodyProblems('Closes #7\n\n**Risk class:** logic\n', 'logic').join(), /does not start with a one-paragraph intent/);
  // An empty intent.
  assert.match(prBodyProblems(prBodyHead({ intent: '  \n ', cls: 'logic', why: [] }), 'logic').join(), /does not start with a one-paragraph intent/);
  // No class.
  assert.match(prBodyProblems('**Intent:** Fix totals.\n\nCloses #7\n', 'logic').join(), /not followed by a risk class/);
  // A class that isn't one of the three.
  assert.match(prBodyProblems('**Intent:** Fix totals.\n\n**Risk class:** low\n', 'logic').join(), /not followed by a risk class/);
  // An intent of several paragraphs is folded into one, so the class still follows it.
  const folded = prBodyHead({ intent: 'First part.\n\nSecond part.', cls: 'logic', why: [] });
  assert.match(folded, /^\*\*Intent:\*\* First part\. Second part\.\n\n\*\*Risk class:\*\* logic$/);
  assert.deepEqual(prBodyProblems(folded, 'logic'), []);
});

test('class: computed from the paths with the existing high-risk lists, self-modification and the money-path config', () => {
  assert.equal(classOf(['docs/guide.md', 'README.md']).cls, 'docs-only');
  assert.equal(classOf(['src/price.js']).cls, 'logic');
  assert.equal(classOf(['docs/guide.md', 'src/price.js']).cls, 'logic', 'docs plus code is logic');
  assert.equal(classOf(['docs/diagram.png']).cls, 'docs-only', 'anything under docs/');
  assert.equal(classOf(['notes.txt']).cls, 'logic', "the owner's docs are *.md and docs/**, nothing wider");
  // Protected: the money path (from money_path_source), auth, secrets, CI, setup scripts, the harness's own controls, agent instructions.
  const p = (paths: string[], money: RegExp[] = []) => classOf(paths, money);
  assert.equal(p(['src/ledger.js'], [/^src\/ledger/]).cls, 'protected');
  assert.match(p(['src/ledger.js'], [/^src\/ledger/]).why.join(), /money path: src\/ledger\.js/);
  assert.equal(p(['src/auth/session.ts']).cls, 'protected');
  assert.equal(p(['.env.production']).cls, 'protected');
  assert.equal(p(['.github/workflows/ci.yml']).cls, 'protected');
  assert.equal(p(['scripts/setup/machine.sh']).cls, 'protected');
  assert.equal(p(['src/merge-policy.ts']).cls, 'protected');
  assert.match(p(['src/pr-rules.ts']).why.join(), /changes the merge policy: src\/pr-rules\.ts/, 'these rules are the merge policy');
  assert.equal(p(['AGENTS.md']).cls, 'protected', 'protected wins over docs-only');
  assert.equal(p(['docs/guide.md', 'CLAUDE.md']).cls, 'protected');
});

test("class: the agent's claim can raise it, never lower it", () => {
  assert.equal(effectiveClass('logic', 'protected'), 'protected');
  assert.equal(effectiveClass('docs-only', 'logic'), 'logic');
  assert.equal(effectiveClass('protected', 'docs-only'), 'protected');
  assert.equal(effectiveClass('logic', 'docs-only'), 'logic');
  assert.equal(effectiveClass('logic', undefined), 'logic');
  // A body that states a lower class than its paths give is refused.
  const lowered = prBodyHead({ intent: 'Tidy the merge rules.', cls: 'logic', why: [] });
  assert.match(prBodyProblems(lowered, 'protected').join(), /risk class logic is lower than the one its changed paths give \(protected\)/);
  assert.match(prBodyProblems(prBodyHead({ intent: 'Fix totals.', cls: 'docs-only', why: [] }), 'logic').join(), /lower/);
  assert.deepEqual(prBodyProblems(prBodyHead({ intent: 'Fix totals.', cls: 'protected', why: [] }), 'logic'), [], 'a raised class is fine');
});

/** `n` distinct lines of code, `tag` keeping one set apart from another. */
const code = (n: number, tag = 'v') => Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};`);
/** A file that adds `n` new lines. */
const f = (path: string, n: number): SizeFile => ({ path, added: code(n, path.replace(/\W/g, '_')), removed: [] });
const limits = { maxLines: 600, generated: DEFAULT_REVIEW.generated };

test('size: over max_pr_lines and not mechanical, it is sent back with "split it"; under it, or mechanical, it goes on', () => {
  assert.equal(sizeVerdict([f('src/a.ts', 400), f('src/b.ts', 200)], limits).ok, true, 'at the limit');
  const over = sizeVerdict([f('src/a.ts', 400), f('src/b.ts', 201)], limits);
  assert.equal(over.ok, false);
  assert.match(over.why, /^split it: 601 changed lines \(over review\.yaml max_pr_lines 600/);
  // Lockfiles and generated files are not counted.
  assert.equal(sizeVerdict([f('src/a.ts', 100), f('package-lock.json', 5000), f('web/yarn.lock', 900), f('web/dist/app.js', 3000), f('src/__generated__/schema.ts', 2000)], limits).ok, true);
  // Mechanical: a reindent (the same lines, whitespace changed) and a move to another file, over the limit.
  const reindent: SizeFile = { path: 'src/a.ts', removed: code(400), added: code(400).map((l) => `  ${l.replace(' = ', '  =  ')}`) };
  const move: SizeFile[] = [{ path: 'src/old.ts', removed: code(300, 'm'), added: [] }, { path: 'src/new.ts', removed: [], added: ['', ...code(300, 'm')] }];
  assert.deepEqual(sizeVerdict([reindent, ...move], limits), { ok: true, lines: 1401, why: '1401 changed lines, all mechanical (renames, moves or formatting)' });
  // Formatting plus real logic over the limit: split (the formatting goes in a PR of its own).
  const mixed = sizeVerdict([reindent, f('src/b.ts', 30)], limits);
  assert.equal(mixed.ok, false);
  assert.match(mixed.why, /\(30 of them are more than renames, moves or formatting\)/);
  // A line whose content changed is not formatting, even when everything else is.
  assert.equal(sizeVerdict([{ ...reindent, added: [...reindent.added.slice(1), 'export const v0 = 1;'] }], { ...limits, maxLines: 100 }).ok, false);
  // The repo's own generated globs replace the default.
  assert.equal(sizeVerdict([f('proto/gen/api.pb.go', 5000)], { maxLines: 600, generated: ['proto/gen/**'] }).ok, true);
  assert.equal(sizeVerdict([f('proto/gen/api.pb.go', 5000)], limits).ok, false);
});

test('size: read from git, a pure rename and a reindent are mechanical; the same lines of new code are not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-size-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 'a@example.com'], ['user.name', 'a'], ['commit.gpgsign', 'false']]) g('config', k!, v!);
  const body = Array.from({ length: 800 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'big.ts'), body);
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  const base = g('rev-parse', 'HEAD');
  g('mv', 'src/big.ts', 'src/renamed.ts');
  g('commit', '-q', '-m', 'rename');
  const renamed = g('rev-parse', 'HEAD');
  const rename = sizeVerdict(sizeFiles(dir, base, renamed), limits);
  assert.deepEqual([rename.ok, rename.lines], [true, 0], rename.why);
  writeFileSync(join(dir, 'src', 'renamed.ts'), body.split('\n').map((l) => (l ? `  ${l}` : l)).join('\n'));
  g('commit', '-q', '-am', 'reindent');
  const reindented = sizeVerdict(sizeFiles(dir, base, g('rev-parse', 'HEAD')), limits);
  assert.equal(reindented.ok, true, reindented.why);
  assert.ok(reindented.lines > 600, 'over the limit, but only formatting');
  writeFileSync(join(dir, 'src', 'new.ts'), body.replace(/export const v/g, 'export const w'));
  g('add', '-A');
  g('commit', '-q', '-m', 'new code');
  const real = sizeVerdict(sizeFiles(dir, base, g('rev-parse', 'HEAD')), limits);
  assert.equal(real.ok, false);
  assert.match(real.why, /^split it: /);
});

test('docs-only fast path: a docs-only PR waits on the light checks only; everything else on every required check', () => {
  const required = ['test', 'desktop', 'denylist', 'dco', 'push-gate', 'scan'];
  const light = ['denylist', 'dco', 'push-gate', 'scan'];
  assert.deepEqual(checksFor({ cls: 'docs-only', required, docsOnlyChecks: light }), { checks: light, fast: true });
  assert.deepEqual(checksFor({ cls: 'logic', required, docsOnlyChecks: light }), { checks: required, fast: false });
  assert.deepEqual(checksFor({ cls: 'protected', required, docsOnlyChecks: light }), { checks: required, fast: false });
  assert.deepEqual(checksFor({ cls: 'docs-only', required, docsOnlyChecks: [] }), { checks: required, fast: false }, 'off by default');
  // A light check that isn't required isn't waited on; none of them required: no fast path.
  assert.deepEqual(checksFor({ cls: 'docs-only', required, docsOnlyChecks: ['scan', 'lychee'] }), { checks: ['scan'], fast: true });
  assert.deepEqual(checksFor({ cls: 'docs-only', required, docsOnlyChecks: ['lychee'] }), { checks: required, fast: false });
});

test("docs-only fast path: GitHub's ruleset still requires every check: pending waits, a failure goes to the owner", () => {
  assert.deepEqual(rulesetHold([{ name: 'scan', outcome: 'pass' }, { name: 'test', outcome: 'pending' }]), { act: 'wait' });
  assert.deepEqual(rulesetHold([{ name: 'scan', outcome: 'pass' }, { name: 'test', outcome: 'missing' }]), { act: 'wait' });
  const hold = rulesetHold([{ name: 'test', outcome: 'fail' }, { name: 'desktop', outcome: 'pending' }]);
  assert.equal(hold.act, 'hold');
  assert.match((hold as { why: string }).why, /test \(fail\) did not pass on GitHub/);
  assert.deepEqual(rulesetHold([{ name: 'scan', outcome: 'pass' }, { name: 'test', outcome: 'skipped' }]), { act: 'none' }, 'GitHub counts a skipped job as satisfied');
});

test('config: max_pr_lines defaults to 600, generated to the built-in list, docs_only_checks to none (no fast path)', () => {
  const parsed = ReviewConfig.parse({ version: 1, levels: DEFAULT_REVIEW.levels });
  assert.deepEqual([parsed.max_pr_lines, parsed.docs_only_checks], [600, []]);
  assert.deepEqual(parsed.generated, DEFAULT_REVIEW.generated);
  assert.deepEqual([DEFAULT_REVIEW.max_pr_lines, DEFAULT_REVIEW.docs_only_checks], [600, []]);
});
