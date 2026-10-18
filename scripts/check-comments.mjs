#!/usr/bin/env node
// The comment policy over a diff (#330): each comment the change adds or changes must start with WHY: or
// INVARIANT:, or cite an issue or decision id; no narration; at most max_lines lines. A thin wrapper: the check
// is runCommentCheck in src/comment-policy.ts, the same the CLI's `check-comments` runs, so build first.
//
//   node scripts/check-comments.mjs --base <rev> [--head <rev>]     (run from the repo root)
//
// INVARIANT: the policy is read from the config committed at --base, so a PR can't switch it off through its own
// config. (This script, the rule and the CI step are the PR's own: changing them is an owner-merged engine change.)
// Off at --base (the default): prints so and exits 0. Exit 1: findings; exit 2: it couldn't check.
import { runCommentCheck } from '../dist/src/comment-policy.js';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const base = opt('--base');
if (!base) {
  console.error('usage: node scripts/check-comments.mjs --base <rev> [--head <rev>]');
  process.exit(2);
}
const r = runCommentCheck(process.cwd(), base, opt('--head') ?? 'HEAD');
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
process.exitCode = r.code;
