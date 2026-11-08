// lint-test
// Every download of a pinned release asset in CI retries with backoff, and is still checked against its pinned
// sha256 (#1201). WHY: on 2026-11-08 GitHub release downloads answered 504 for a while, and a single-shot `curl` turned
// whole PRs red with no test failing; a retry rides that out, and the pin keeps a retried download as strict as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { repoRoot } from './helpers.js';

/** A download of a pinned binary: a GitHub release asset, or the vendor hosts CI fetches pinned binaries from. */
const DOWNLOAD = /releases\/download\/|storage\.googleapis\.com\/chrome-for-testing-public\/|nodejs\.org\/dist\//;

/** A run script's lines, with backslash-continued lines joined. */
const logicalLines = (run: string) => run.replace(/\\\n\s*/g, ' ').split('\n');

/**
 * What is wrong with one step's script: each download that doesn't retry with backoff (--retry 3 or more,
 * --retry-all-errors, --retry-delay), or isn't followed in the same step by a sha256 check.
 */
export function downloadProblems(run: string): string[] {
  const lines = logicalLines(run);
  const out: string[] = [];
  for (const [i, l] of lines.entries()) {
    if (!/\bcurl\b/.test(l) || !DOWNLOAD.test(l)) continue;
    const retries = Number(/--retry\s+(\d+)/.exec(l)?.[1] ?? 0);
    if (retries < 3 || !/--retry-all-errors\b/.test(l) || !/--retry-delay\s+\d+/.test(l)) out.push(`no retry with backoff (--retry 5 --retry-all-errors --retry-delay 5): ${l.trim()}`);
    if (!lines.slice(i + 1).some((x) => /\bsha256sum -c\b/.test(x))) out.push(`no sha256 check after it in the same step: ${l.trim()}`);
  }
  return out;
}

test('the download lint: a bare curl to a release asset, one without backoff, and one with no sha256 check after it are each refused', () => {
  const url = 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz';
  const pin = 'echo "abc  f" | sha256sum -c -';
  assert.equal(downloadProblems(`curl -sSfL -o f "${url}"\n${pin}`).length, 1, 'a bare curl');
  assert.match(downloadProblems(`curl -sSfL --retry 1 --retry-all-errors --retry-delay 5 -o f "${url}"\n${pin}`)[0]!, /no retry with backoff/, 'one retry is not enough');
  assert.match(downloadProblems(`curl -sSfL --retry 5 -o f "${url}"\n${pin}`)[0]!, /no retry with backoff/, 'no --retry-all-errors');
  assert.match(downloadProblems(`curl -sSfL --retry 5 --retry-all-errors --retry-delay 5 -o f "${url}"\ntar -xzf f`)[0]!, /no sha256 check after it/, 'the pin is never optional');
  assert.match(downloadProblems(`${pin}\ncurl -sSfL --retry 5 --retry-all-errors --retry-delay 5 -o f "${url}"`)[0]!, /no sha256 check after it/, 'a check before the download checks nothing');
  assert.deepEqual(downloadProblems(`curl -sSfL --retry 5 --retry-all-errors --retry-delay 5 -o f \\\n  "${url}"\n${pin}`), [], 'continued lines are read whole');
  assert.deepEqual(downloadProblems('curl -sf "$GH_FAKE/repos/example/alpha"'), [], 'a local probe is no download');
});

test('every pinned download in .github/workflows retries with backoff and is checked against its sha256 (#1201)', () => {
  const dir = join(repoRoot, '.github', 'workflows');
  const problems: string[] = [];
  let downloads = 0;
  for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).sort()) {
    const text = readFileSync(join(dir, f), 'utf8');
    const w = parse(text) as { jobs?: Record<string, { steps?: { name?: string; run?: string }[] }> };
    for (const [id, job] of Object.entries(w.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (typeof step.run !== 'string') continue;
        downloads += logicalLines(step.run).filter((l) => /\bcurl\b/.test(l) && DOWNLOAD.test(l)).length;
        for (const p of downloadProblems(step.run)) problems.push(`${f} ${id} (${step.name ?? 'a step'}): ${p}`);
      }
    }
    // A download outside a step's script (a workflow-level env, a matrix value) would be missed above: none may exist.
    for (const l of text.split('\n')) if (/\bcurl\b/.test(l) && DOWNLOAD.test(l) && !/^\s+(curl|.*\bcurl )/.test(l)) problems.push(`${f}: a download outside a step's script: ${l.trim()}`);
  }
  assert.deepEqual(problems, []);
  assert.ok(downloads >= 9, `found ${downloads} downloads: the lint must see the workflows' downloads`);
});

test("the setup and CI scripts' release downloads retry too", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : /\.(sh|mjs)$/.test(n) ? [join(d, n)] : []));
  const bare = walk(join(repoRoot, 'scripts'))
    .flatMap((f) => readFileSync(f, 'utf8').split('\n').map((l, i) => ({ f, i, l })))
    .filter(({ l }) => /\bcurl\b/.test(l) && /releases\/download\//.test(l) && !/--retry\s+\d+/.test(l) && !/^\s*#/.test(l))
    .map(({ f, i, l }) => `${relative(repoRoot, f)}:${i + 1}: ${l.trim()}`);
  assert.deepEqual(bare, []);
});
