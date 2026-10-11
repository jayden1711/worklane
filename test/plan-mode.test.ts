import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { needsPlan, objection, PLAN_DISALLOWED, PLAN_SCHEMA, PLAN_TOOLS, planAnswer, planBrief, planComment, planDecision, planHoldReasons, readPlan } from '../src/plan-mode.js';
import { exampleProject } from './helpers.js';

const plan = { approach: 'Add an orders table and route totals through it.', steps: ['Add the migration', 'Use it in totals'], files: ['migrations/002_orders.sql', 'src/price.js'], risks: ['Old rows without an order id'], questions: ['Keep the old totals path for a release?'] };

test('size:M and size:L are planned first; smaller or unsized issues are not', () => {
  assert.equal(needsPlan(['ready', 'size:M']), true);
  assert.equal(needsPlan(['size:L']), true);
  assert.equal(needsPlan(['size:S']), false);
  assert.equal(needsPlan(['ready']), false);
});

test('the plan run is read-only: no editing tools, only reading and read-only git', () => {
  for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) assert.ok(PLAN_DISALLOWED.includes(t), t);
  assert.ok(!PLAN_TOOLS.includes('Bash') && !PLAN_TOOLS.includes('Edit') && !PLAN_TOOLS.includes('Write'));
  assert.ok(PLAN_TOOLS.every((t) => ['Read', 'Glob', 'Grep'].includes(t) || /^Bash\(git (log|show|diff|grep):\*\)$/.test(t)));
  assert.deepEqual([...PLAN_SCHEMA.required], ['approach', 'steps', 'files', 'risks', 'design_change']);
});

test('a plan needs an approach and steps; anything else is reported as no plan', () => {
  assert.deepEqual(readPlan(plan), plan);
  assert.deepEqual(readPlan({ ...plan, questions: [] }), { approach: plan.approach, steps: plan.steps, files: plan.files, risks: plan.risks });
  assert.deepEqual(readPlan({ approach: ' ', steps: ['x'] }), { invalid: 'the plan run gave no approach' });
  assert.deepEqual(readPlan({ approach: 'x', steps: [] }), { invalid: 'the plan run gave no steps' });
  assert.deepEqual(readPlan(undefined), { invalid: 'the plan run gave no approach' });
});

test('the posted plan says the build proceeds and how to object; the worker gets the plan in its brief', () => {
  const c = planComment(plan, 'example-owner');
  assert.match(c, /The build starts now with this plan; @example-owner/);
  assert.ok(c.includes(`/${BRAND.cli} object <why>`));
  for (const s of ['**Approach.** Add an orders table', '1. Add the migration', '2. Use it in totals', '`migrations/002_orders.sql`', 'Old rows without an order id', 'Keep the old totals path']) assert.ok(c.includes(s), s);
  const b = planBrief(plan).join('\n');
  assert.match(b, /Build to it; if you must depart from it, say where and why/);
  assert.match(b, /1\. Add the migration\n2\. Use it in totals/);
  assert.match(b, /Files expected to change: migrations\/002_orders\.sql, src\/price\.js/);
});

test("an objection is the owner's or a writer's /<cli> object comment after the plan; others don't count", () => {
  const cmd = `/${BRAND.cli} object`;
  const comments = [
    { author: 'example-owner', body: `${cmd} too early` }, // before the plan: not an objection to it
    { author: 'bot', body: 'Plan for this issue…' },
    { author: 'stranger', body: `${cmd} I don't like it` },
    { author: 'example-collaborator', body: 'Looks fine.' },
    { author: 'Example-Collaborator', body: `Thinking about it.\n${cmd} the migration must be reversible` },
  ];
  assert.deepEqual(objection(comments, 2, ['example-owner', 'example-collaborator']), { by: 'Example-Collaborator', why: 'the migration must be reversible' });
  assert.equal(objection(comments.slice(0, 4), 2, ['example-owner', 'example-collaborator']), null);
  assert.deepEqual(objection([{ author: 'example-owner', body: cmd }], 0, ['example-owner']), { by: 'example-owner', why: 'no reason given' });
});

const review = loadConfig(exampleProject().dir).review!;
const hold = (p: { files: string[]; design_change?: boolean; design_reason?: string }, exists = (_: string) => true) => planHoldReasons({ ...plan, design_change: false, ...p }, { review, moneyPaths: [], existsAtBase: exists });

test("a plan touching an L3 path is held, judged with the merge policy's own categories", () => {
  assert.deepEqual(hold({ files: ['migrations/002_orders.sql', 'src/price.js'] }), ['high-risk: migration (migrations/002_orders.sql)']);
  assert.deepEqual(hold({ files: ['.github/workflows/ci.yml'] }), ['high-risk: deploy-config (.github/workflows/ci.yml)', 'high-risk: ci-config (.github/workflows/ci.yml)']);
});

test('a design-level plan is held: its own flag, a dependency manifest, or a new top-level module; no design answer holds too', () => {
  assert.deepEqual(hold({ files: ['src/price.js'], design_change: true, design_reason: 'adds a public --currency option' }), ['design: the plan flagged a design change: adds a public --currency option']);
  assert.deepEqual(hold({ files: ['package.json', 'src/price.js'] }), ['design: dependency manifests change (package.json)']);
  assert.deepEqual(hold({ files: ['billing/invoice.js'] }, (d) => d !== 'billing'), ['design: new top-level module (billing/)']);
  assert.deepEqual(planHoldReasons({ ...plan, files: ['src/price.js'] }, { review, moneyPaths: [], existsAtBase: () => true }), ['design: the plan gave no design-change answer']);
});

test('an ordinary plan is not held: post and proceed', () => {
  assert.deepEqual(hold({ files: ['src/price.js', 'test/price.test.js'] }), []);
});

test("a held plan's decision: approve builds, revise plans again with the note, reject stops", () => {
  const d = planDecision(['high-risk: migration (migrations/002_orders.sql)']);
  assert.deepEqual(d.options, ['approve', 'revise', 'reject']);
  assert.match(d.receipts[0]!, /^holds because high-risk: migration/);
  assert.deepEqual(planAnswer('approve'), { act: 'build' });
  assert.deepEqual(planAnswer('revise', `Close, but:\n/${BRAND.cli} revise make the migration reversible\nand keep old rows`), { act: 'replan', note: 'make the migration reversible\nand keep old rows' });
  assert.deepEqual(planAnswer('revise', `/${BRAND.cli} revise`), { act: 'replan', note: 'no note given; plan it again with the risks in mind' });
  assert.deepEqual(planAnswer('reject'), { act: 'stop' });
});
