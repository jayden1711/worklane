// docs/security.md lists a guard gap as fixed only once its fix PR has merged, with that merge commit (#859). This
// checks every row of its fixed-gaps table: the merge commit is an ancestor of HEAD, and the PR is merged with that
// commit (a read-only GitHub API call). CI runs it in a job with the whole history (ci.yml `security-fixed`); the test
// shards check out two commits only, so test/security-fixed.test.ts checks the logic with readers of its own.
//
//   node scripts/ci/security-fixed.mjs      (GITHUB_REPOSITORY names the repo; gh reads GH_TOKEN)
//
// Exit 1 lists each row that doesn't hold; exit 2: the table couldn't be read.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Every row of the "Fixed" section's table: its gap, fix PR number and merge commit (as written, abbreviated). */
export function fixedRows(page) {
  const at = page.search(/^## Fixed\b/m);
  if (at < 0) return [];
  const rest = page.slice(at);
  const next = rest.slice(1).search(/^## /m);
  const section = next < 0 ? rest : rest.slice(0, next + 1);
  const rows = [];
  for (const line of section.split('\n')) {
    const m = /^\|\s*(.+?)\s*\|\s*#(\d+)\s*\|\s*#(\d+)\s*\|\s*`([0-9a-f]{7,40})`\s*\|\s*$/.exec(line);
    if (m) rows.push({ gap: m[1], issue: Number(m[2]), pr: Number(m[3]), commit: m[4] });
  }
  return rows;
}

/**
 * Why each row doesn't hold, or nothing. `isAncestor(commit)`: whether it is an ancestor of HEAD; `prMerge(pr)`: the
 * PR's merge commit (full sha) when it is merged, else null. Either may throw: that row fails, saying why.
 */
export function problems(rows, o) {
  const out = [];
  for (const r of rows) {
    const name = `#${r.pr} (${r.commit})`;
    try {
      if (!o.isAncestor(r.commit)) out.push(`${name}: the merge commit isn't an ancestor of HEAD`);
    } catch (e) {
      out.push(`${name}: the merge commit can't be found (${String(e?.message ?? e).split('\n')[0]})`);
    }
    try {
      const sha = o.prMerge(r.pr);
      if (sha === null) out.push(`${name}: the PR isn't merged`);
      else if (!sha.startsWith(r.commit)) out.push(`${name}: the PR merged as ${sha.slice(0, 12)}, not ${r.commit}`);
    } catch (e) {
      out.push(`${name}: the PR can't be read (${String(e?.message ?? e).split('\n')[0]})`);
    }
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rows = fixedRows(readFileSync(new URL('../../docs/security.md', import.meta.url), 'utf8'));
  if (!rows.length) {
    console.error('docs/security.md: no row in its "Fixed" table');
    process.exit(2);
  }
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    console.error('GITHUB_REPOSITORY must name the repo (owner/name)');
    process.exit(2);
  }
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const out = problems(rows, {
    isAncestor: (c) => {
      try {
        git('merge-base', '--is-ancestor', `${c}^{commit}`, 'HEAD');
        return true;
      } catch (e) {
        if (e.status === 1) return false;
        throw e;
      }
    },
    prMerge: (n) => {
      const j = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/pulls/${n}`, '--jq', '{merged: .merged, sha: .merge_commit_sha}'], { encoding: 'utf8' }));
      return j.merged ? j.sha : null;
    },
  });
  for (const p of out) console.error(p);
  console.log(`docs/security.md: ${rows.length} fixed row(s), ${out.length} problem(s)`);
  process.exit(out.length ? 1 : 0);
}
