// #970: the decisions index reads each record as committed at the plan's base (#920), but the planner and the plan
// reviewer were told to read the record files in their checkout, where setup steps have run, so that copy could
// differ. Their briefs now carry the committed text, and nothing points them at the checkout copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decisionIndex, recordTexts, type DecisionEntry } from '../src/plan-decisions.js';
import { decisionsMade, planReviewExtra, type Plan } from '../src/plan-mode.js';
import { defaultRolePrompt } from '../src/roles.js';

const COMMITTED = 'Every export is CSV; no JSON exports.';
const CHANGED = 'Exports may be JSON when a setup step says so.';

/** A checkout whose decisions.md, as committed at HEAD (the base), differs from its working-tree copy. */
function drifted() {
  const repo = mkdtempSync(join(tmpdir(), 'committed-records-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'decisions.md'), `# Decisions\n\n## D-1: Exports are CSV\n${COMMITTED}\n`);
  git('add', '-A');
  git('-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'records');
  // What a setup step leaves in the checkout: the same heading, other text.
  writeFileSync(join(repo, 'decisions.md'), `# Decisions\n\n## D-1: Exports are CSV\n${CHANGED}\n`);
  return decisionIndex(repo, []);
}

const plan: Plan = { approach: 'a', steps: ['s'], acceptance: ['x'], files: [], risks: [], design_change: false, questions: [], decisions: { nothing: false, restsOn: [{ ref: 'decisions.md § D-1: Exports are CSV', how: 'h' }], arguesAgainst: [] } } as unknown as Plan;
const CHECKOUT_POINTER = /records? (files )?(in|this) (this |the )?checkout(?!:)|in this checkout, which you may read|the files are in this checkout|this checkout keeps/i;

test('#970: the planner\'s brief carries each record\'s committed text, never the checkout copy, and points at no checkout file', () => {
  const brief = decisionsMade(drifted()).join('\n');
  assert.ok(brief.includes(COMMITTED), brief);
  assert.ok(!brief.includes(CHANGED), 'the working-tree text is never in the brief');
  assert.doesNotMatch(brief, CHECKOUT_POINTER);
});

test('#970: the plan reviewer\'s brief carries the committed text of every record, and points at no checkout file', () => {
  const brief = planReviewExtra({ ...plan, decisions: { nothing: true } } as unknown as Plan, drifted()).join('\n');
  assert.ok(brief.includes(COMMITTED));
  assert.ok(!brief.includes(CHANGED));
  assert.doesNotMatch(brief, CHECKOUT_POINTER);
});

test('#970: the planner and plan-reviewer instructions read records in the brief, never their files in the checkout', () => {
  for (const role of ['planner', 'plan-reviewer']) {
    const p = defaultRolePrompt(role);
    assert.match(p, /never its file in this checkout/, role);
    assert.doesNotMatch(p, /decision records this checkout keeps|docs\/design\.md in this checkout, which you may read/, role);
  }
});

test('#970: past the brief\'s budget, a record is listed as not included, never sent to the checkout for', () => {
  const entries: DecisionEntry[] = ['a', 'b', 'c'].map((x) => ({ ref: `decisions.md § ${x}`, aliases: [], title: x, text: x.repeat(40) }));
  const out = recordTexts(entries, 90).join('\n');
  assert.ok(out.includes('a'.repeat(40)) && out.includes('b'.repeat(40)) && !out.includes('c'.repeat(40)));
  assert.match(out, /Not included, past this brief's size \(1\): \[decisions\.md § c\]/);
  assert.doesNotMatch(out, CHECKOUT_POINTER);
});
