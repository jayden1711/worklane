// #859: docs/security.md lists a gap as fixed only with its fix PR merged, as the merge commit it names. CI's
// security-fixed workflow checks that on the whole history (scripts/ci/security-fixed.mjs); this checks the script's
// reading of the table and its judgement, with readers of its own, and that the job is wired as it must be.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { repoRoot } from './helpers.js';

interface Row {
  gap: string;
  issue: number;
  pr: number;
  commit: string;
}
const s = (await import(pathToFileURL(join(repoRoot, 'scripts', 'ci', 'security-fixed.mjs')).href)) as {
  fixedRows: (page: string) => Row[];
  problems: (rows: Row[], o: { isAncestor: (c: string) => boolean; prMerge: (n: number) => string | null }) => string[];
};
const page = readFileSync(join(repoRoot, 'docs', 'security.md'), 'utf8');

/** Readers that know the real table: each listed PR merged as its commit (padded to a full sha), each an ancestor. */
const knowing = (rows: Row[]) => {
  const merged = new Map(rows.map((r) => [r.pr, r.commit.padEnd(40, '0')]));
  return { isAncestor: (c: string) => rows.some((r) => r.commit === c), prMerge: (n: number) => merged.get(n) ?? null };
};

test('#859: every row of the fixed-gaps table is read, and the real table holds', () => {
  const rows = s.fixedRows(page);
  assert.ok(rows.length >= 5, `the table: ${rows.length} rows`);
  assert.deepEqual(rows[0], { gap: 'A rename plus an edit slipped past every exact-path lock', issue: 683, pr: 688, commit: '521ce276' });
  assert.equal(page.split('\n').filter((l) => /^\| .* \| #\d+ \| #\d+ \| `[0-9a-f]+` \|$/.test(l)).length, rows.length, 'no row missed');
  assert.deepEqual(s.problems(rows, knowing(rows)), []);
});

test("#859: a row naming a PR that isn't merged, or a commit that isn't on HEAD's history, fails (the #852 review's mutation)", () => {
  const real = s.fixedRows(page);
  const mutated = s.fixedRows(page.replace('| #683 | #688 | `521ce276` |', '| #683 | #9999 | `deadbeef` |'));
  assert.deepEqual(s.problems(mutated, knowing(real)), ["#9999 (deadbeef): the merge commit isn't an ancestor of HEAD", "#9999 (deadbeef): the PR isn't merged"]);
  // The right PR with the wrong commit, and a reader that can't answer.
  const wrong = s.fixedRows(page.replace('`521ce276`', '`deadbeef`'));
  assert.deepEqual(s.problems(wrong.slice(0, 1), knowing(real)), ["#688 (deadbeef): the merge commit isn't an ancestor of HEAD", '#688 (deadbeef): the PR merged as 521ce2760000, not deadbeef']);
  const broken = { isAncestor: () => { throw new Error('fatal: Not a valid commit name\nmore'); }, prMerge: () => { throw new Error('HTTP 404'); } };
  assert.deepEqual(s.problems(real.slice(0, 1), broken), ["#688 (521ce276): the merge commit can't be found (fatal: Not a valid commit name)", "#688 (521ce276): the PR can't be read (HTTP 404)"]);
});

test('#859: on a checkout with the whole history, each merge commit the table names is an ancestor of HEAD', (t) => {
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (git('rev-parse', '--is-shallow-repository') === 'true') return t.skip('a shallow checkout (the CI shards): the security-fixed job checks this');
  for (const r of s.fixedRows(page)) assert.doesNotThrow(() => git('merge-base', '--is-ancestor', `${r.commit}^{commit}`, 'HEAD'), `#${r.pr} ${r.commit}`);
});

test("#859: the security-fixed workflow runs the script on the whole history, reading GitHub only, on every PR that changes the page or the check", () => {
  const wf = parseYaml(readFileSync(join(repoRoot, '.github', 'workflows', 'security-fixed.yml'), 'utf8')) as { on: { pull_request?: { paths?: string[] }; push?: unknown }; permissions?: Record<string, string>; jobs: Record<string, { steps: { uses?: string; with?: Record<string, unknown>; run?: string; env?: Record<string, string> }[] }> };
  assert.deepEqual(Object.keys(wf.on), ['pull_request'], 'pull requests only: on main the table changes only through one');
  assert.deepEqual(wf.on.pull_request?.paths, ['docs/security.md', 'scripts/ci/security-fixed.mjs', '.github/workflows/security-fixed.yml']);
  assert.deepEqual(wf.permissions, { contents: 'read', 'pull-requests': 'read' });
  const job = wf.jobs['security-fixed'];
  assert.ok(job, 'the job');
  const checkout = job.steps.find((x) => x.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout?.with?.['fetch-depth'], 0, 'the whole history');
  const run = job.steps.find((x) => x.run?.includes('scripts/ci/security-fixed.mjs'));
  assert.equal(run?.run?.trim(), 'node scripts/ci/security-fixed.mjs');
  assert.equal(run?.env?.GH_TOKEN, '${{ github.token }}');
});
