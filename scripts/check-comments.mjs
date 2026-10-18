#!/usr/bin/env node
// The comment policy over a diff (#330): each comment the change adds or changes must start with WHY: or
// INVARIANT:, or cite an issue or decision id; no narration; at most max_lines lines. The rule is
// src/comment-policy.ts's, shared with the agents' post-edit hook, so build first (npm run build).
//
//   node scripts/check-comments.mjs --base <rev> [--head <rev>]     (run from the repo root)
//
// INVARIANT: the policy is read from the config committed at --base, never the change's own, so a PR can't switch it
// off for itself. Off there (the default): prints so and exits 0. Exit 1: findings; exit 2: it couldn't check.
import { checkRange, formatFindings, policyAt } from '../dist/src/comment-policy.js';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const base = opt('--base');
const head = opt('--head') ?? 'HEAD';
if (!base) {
  console.error('usage: node scripts/check-comments.mjs --base <rev> [--head <rev>]');
  process.exit(2);
}
const root = process.cwd();
try {
  const policy = policyAt(root, base);
  if (!policy?.enabled) {
    console.log(`comment policy: off in the config at ${base} (config.yaml comment_policy.enabled); nothing checked`);
    process.exit(0);
  }
  const findings = checkRange(root, base, head, policy);
  if (!findings.length) {
    console.log(`comment policy: every comment added in ${base}..${head} passes`);
    process.exit(0);
  }
  console.error(`comment policy: ${findings.length} comment(s) added in ${base}..${head} break it (start with WHY: or INVARIANT:, or cite an issue or decision id; no narration; at most ${policy.max_lines} lines):`);
  console.error(formatFindings(findings));
  process.exit(1);
} catch (e) {
  console.error(`comment policy: could not check ${base}..${head}: ${e.message}`);
  process.exit(2);
}
