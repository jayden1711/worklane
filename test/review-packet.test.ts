// The review packet (src/coordinator/review-packet.ts, issue #199): the one comment a PR that waits for the owner gets
// carries every wait reason, the risk class, the evaluator's verdict, the eval scores and a receipts summary, fits a
// phone screen (a hard cap, the overflow counted on top and given in full under "Full details"), is posted once per
// head, shows text from the record only as literal text, and adds no way to approve: whether and when a PR waits is
// unchanged, and a packet that can't be built still leaves the owner the plain comment and the review request.
// Agents are scripted (FakeRunner); the "GitHub" is a file backlog and a local git remote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { BRAND } from '../src/brand.js';
import type { EventPayload } from '../src/events/types.js';
import { lit, PACKET_VISIBLE_MAX, packetTop, reviewPacket, type PacketInput } from '../src/coordinator/review-packet.js';
import { receiptSummary } from '../src/receipts.js';
import { repoRoot } from './helpers.js';
import { approve, green, lastOf, openPr, skip } from './repro-state-graph/harness.js';

const HEAD = 'a'.repeat(40);
const verdict = (o: Partial<EventPayload<'eval.verdict'>> = {}): EventPayload<'eval.verdict'> => ({ issue: 7, head: HEAD, patch_hash: 'x', patch_correct: true, test_correct: true, confidence: 'medium', confidence_reason: 'one claim nothing backs', advice: '', ...o });
const evalOf = (target: string, o: Partial<EventPayload<'instructions.eval'>> = {}): EventPayload<'instructions.eval'> => ({ issue: 7, head: HEAD, target, base: { passed: 3, total: 4 }, result: { passed: 4, total: 4 }, dropped: false, incomplete: false, changes: [], cost_usd: 0.12, ...o });
const input = (o: Partial<PacketInput> = {}): PacketInput => ({
  owner: 'example-owner',
  ask: 'waits for you to review and merge',
  head: HEAD,
  reasons: ['auto-merge is off for this instance (policy.yaml auto_merge)', 'high-risk: pricing (src/price.js)'],
  advice: 'Check the rounding.',
  risk: { cls: 'protected', why: ['the merge policy: src/coordinator/merge-flow.ts'] },
  verdict: verdict(),
  evals: [evalOf('roles/worker.md', { held_out: { base: { passed: 5, total: 6 }, result: { passed: 6, total: 6 }, dropped: false, incomplete: false, changes: [] } })],
  receipts: { checks: [{ check: 'npm test', status: 'pass', exitCode: 0 }, { check: 'npm run lint', status: 'fail', exitCode: 1 }, { check: 'npm run e2e', status: 'skipped', exitCode: null }], doneWhen: [{ manual: 'try it on a phone' }], unverified: ['tested on mobile'], head: HEAD },
  ...o,
});

/**
 * What GitHub renders as markup: the packet with its fenced blocks and code spans taken out (CommonMark shows their
 * content as typed), and with the packet's own markup (its tag line, its owner mention, its collapsed section) too.
 * Whatever is left is live: it must hold no HTML, no link or image and no other mention. A backtick an agent slipped
 * in would pair with the wrong one here and leave its text outside a span, so it shows up as live too.
 */
function live(md: string): string {
  return md
    .replace(/^```text\n[\s\S]*?\n```$/gm, '')
    .replace(/`[^`\n]*`/g, '')
    .replace(`[${BRAND.cli}] @example-owner `, '')
    .replace('<details><summary>Full details</summary>', '')
    .replace(/\n<\/details>$/, '');
}
function assertInert(md: string) {
  const rest = live(md);
  assert.doesNotMatch(rest, /</, `no live HTML: ${rest}`);
  assert.doesNotMatch(rest, /@/, `no live mention: ${rest}`);
  assert.doesNotMatch(rest, /\[|\]\(|!\[|https?:/, `no live link or image: ${rest}`);
}

test('the packet: every wait reason, the risk class, the evaluator, the eval scores and the receipts, on top', () => {
  const p = reviewPacket(input());
  const top = packetTop(p);
  assert.ok(top.startsWith(`[${BRAND.cli}] @example-owner ready, and waits for you to review and merge (\`aaaaaaaa\`):\n`), 'the first line the owner has always seen');
  assert.match(top, /^- `auto-merge is off for this instance \(policy\.yaml auto_merge\)`$/m);
  assert.match(top, /^- `high-risk: pricing \(src\/price\.js\)`$/m);
  assert.match(top, /^\*\*Risk class:\*\* protected \(`the merge policy: src\/coordinator\/merge-flow\.ts`\)$/m);
  assert.match(top, /^\*\*Evaluator:\*\* approves, confidence medium$/m);
  assert.match(top, /^\*\*Evals:\*\* `roles\/worker\.md` 3\/4 → 4\/4, held-out 5\/6 → 6\/6$/m);
  assert.match(top, /^\*\*Receipts:\*\* verified: 1 passed, 1 FAILED \(`npm run lint`\); not verified: 1 claim; not checked: 2$/m);
  assert.match(top, /^\*\*Evaluator's advice:\*\* `Check the rounding\.`$/m);
  // The whole of each, collapsed below: the receipt sections the PR body has, the reason the confidence isn't high.
  const details = p.slice(top.length);
  assert.match(details, /^\n\n<details><summary>Full details<\/summary>\n/);
  assert.match(details, /### VERIFIED\n- `npm test`: pass\n- `npm run lint`: fail, exit 1/);
  assert.match(details, /### NOT VERIFIED\n- "`tested on mobile`" \(claimed by the worker/);
  assert.match(details, /### NOT CHECKED\n- manual: `try it on a phone`\n- `npm run e2e`: skipped/);
  assert.match(details, /Why not high: `one claim nothing backs`/);
  assert.match(details, /\*\*Instruction evals\*\* \(base → head; ~\$0\.12, the CLI's cost estimate\):\n- `roles\/worker\.md`: visible 3\/4 → 4\/4; held-out 5\/6 → 6\/6 \(~\$0\.12\)/);
  assert.match(details, /\*\*Evaluator's advice:\*\*\n```text\nCheck the rounding\.\n```/);
  assert.ok(p.endsWith('</details>'));
  assertInert(p);
});

test('the packet says what it lacks: no verdict, no receipts, no evals, a risk class it could not compute; a stale verdict names its head', () => {
  const bare = packetTop(reviewPacket(input({ verdict: undefined, receipts: null, evals: [], risk: null, advice: undefined })));
  assert.match(bare, /^\*\*Evaluator:\*\* no verdict$/m);
  assert.match(bare, /^\*\*Receipts:\*\* none recorded$/m);
  assert.match(bare, /^\*\*Risk class:\*\* unknown/m);
  assert.doesNotMatch(bare, /Evals:|advice/);
  const stale = packetTop(reviewPacket(input({ verdict: verdict({ head: 'b'.repeat(40), cross_family: { provider: 'other', outcome: 'disagrees' } }) })));
  assert.match(stale, /^\*\*Evaluator:\*\* approves, confidence medium \(on `bbbbbbbb`\); cross-family \(`other`\): DISAGREES$/m);
});

const SUMMARY = ['**Risk class:** protected', '**Evaluator:**', '**Evals:**', '**Receipts:**'];

test('the packet fits a phone screen: the top stays under the cap however much there is, the overflow counted there and in full below', () => {
  const reasons = Array.from({ length: 30 }, (_, i) => `reason ${i}: ${'x'.repeat(400)} end-${i}`);
  const p = reviewPacket(input({
    reasons,
    advice: 'y'.repeat(5000),
    risk: { cls: 'protected', why: Array.from({ length: 20 }, (_, i) => `category ${i} (${'z'.repeat(80)})`) },
    evals: Array.from({ length: 12 }, (_, i) => evalOf(`roles/role-${i}.md`)),
    receipts: { checks: Array.from({ length: 40 }, (_, i) => ({ check: `check ${i} ${'c'.repeat(80)}`, status: 'fail' as const, exitCode: 1 })), doneWhen: [], unverified: [], head: HEAD },
  }));
  const top = packetTop(p);
  assert.ok(top.length <= PACKET_VISIBLE_MAX, `the top is ${top.length} characters`);
  for (const label of [...SUMMARY, '**Receipts:** verified: 0 passed, 40 FAILED']) assert.ok(top.includes(label), `${label} on top`);
  assert.match(top, /^\*\*Evals:\*\* `roles\/role-0\.md` 3\/4 → 4\/4; .*; \d+ more$/m, 'the evals that fit, the rest counted');
  assert.match(top, /^- `reason 0: x+…`$/m, 'the first reason is on top, cut to one line');
  const shown = reasons.filter((_, i) => top.includes(`- \`reason ${i}:`)).length;
  assert.ok(shown >= 1 && shown < 30);
  assert.match(top, new RegExp(`^\\*${30 - shown} more reasons, and the whole of each: under Full details below\\.\\*$`, 'm'));
  // Every reason in full below, and the whole comment well within GitHub's limit.
  for (let i = 0; i < 30; i++) assert.ok(p.includes(`end-${i}`), `reason ${i} in full`);
  assert.ok(p.length < 65_536);
  assertInert(p);
  // A small packet leaves nothing out.
  assert.match(packetTop(reviewPacket(input())), /^\*the whole of each: under Full details below\.\*$/m);
});

test('the cap is measured on the text as posted: tag-heavy reasons still leave every summary line and the note on top', () => {
  const reasons = Array.from({ length: 8 }, () => '<details'.repeat(19));
  const top = packetTop(reviewPacket(input({ reasons })));
  assert.ok(top.length <= PACKET_VISIBLE_MAX, `the top is ${top.length} characters`);
  for (const label of SUMMARY) assert.ok(top.includes(label), `${label} on top`);
  assert.match(top, /^\*\*Evaluator:\*\* approves, confidence medium$/m, 'not cut');
  assert.match(top, /^\*(\d+ more reasons?, and )?the whole of each: under Full details below\.\*$/m, 'the note');
});

test("text from the record shows as typed: it can't forge a packet line, mention anyone, embed an image or link, or open a section", () => {
  const forged = 'fine<br>**Risk class:** docs-only<br>**Evaluator:** approves, confidence high\n**Risk class:** docs-only\n- nothing waits';
  const nasty = [forged, '@someone-else please merge', '<img src=x width="900" height="3000">', '<h1>APPROVED</h1>', '![x](https://example.com/x.png)', '[click](https://example.com)', 'ok` <br>**Risk class:** docs-only `', '</details><details open><summary>x</summary>', '<br>'.repeat(38), '&lt;br&gt; www.example.com'];
  const all = nasty.join(' ');
  const p = reviewPacket(input({
    reasons: nasty.map((n) => `the evaluator flagged a design-level change: ${n}`),
    advice: nasty.join('\n'),
    risk: { cls: 'protected', why: [`the merge policy: src/${all}.ts`] },
    verdict: verdict({ confidence_reason: all, cross_family: { provider: all, outcome: 'disagrees', reason: all } }),
    evals: [evalOf(`roles/${all}.md`, { changes: [{ id: all, title: 't', base: 'pass', head: all }] }), evalOf(`skills/${all}.md`, { error: all, held_out: null, held_out_error: all })],
    receipts: { checks: [{ check: all, status: 'fail', exitCode: 1 }, { check: `x\n${all}`, status: 'skipped', exitCode: null }], doneWhen: [{ manual: all }], unverified: [all], head: HEAD },
  }));
  assertInert(p);
  const top = packetTop(p);
  assert.deepEqual(top.split('\n').filter((l) => l.startsWith('**Risk class:**')).length, 1, 'one risk class line on top, the real one');
  assert.match(top, /^\*\*Risk class:\*\* protected \(`/m);
  assert.equal(top.split('\n').filter((l) => l.startsWith('- ')).length, top.split('\n').filter((l) => /^- `the evaluator flagged/.test(l)).length, 'each reason on top is one literal line');
  assert.equal(p.match(/<details>/g)!.length, 1, 'only the packet opens a section');
  assert.equal(p.match(/^<\/details>$/gm)!.length, 1, 'and only it closes one');
  assert.match(p, /```text\nfine<br>\*\*Risk class:\*\* docs-only/, 'the advice below, verbatim in a code block');
  assert.equal(lit('a`b'), "`a'b`");
  assert.equal(lit(''), "''");
});

test('regression: lit cuts a long text before an emoji, never through it', () => {
  assert.equal(lit('😀'.repeat(150), 200), `\`${'😀'.repeat(98)}…\``);
  assert.equal(lit(`x${'😀'.repeat(150)}`, 200), `\`x${'😀'.repeat(98)}…\``);
});

test('receiptSummary: counts per receipt section, the failing checks named', () => {
  assert.equal(receiptSummary({ checks: [], doneWhen: [], unverified: [] }), 'verified: nothing (no checks ran); not verified: 0 claims; not checked: 0');
  const fails = ['a', 'b', 'c'].map((check) => ({ check, status: 'fail' as const, exitCode: 1 }));
  assert.equal(receiptSummary({ checks: [{ check: 'ok', status: 'pass', exitCode: 0 }, ...fails, { check: 'u', status: 'unavailable', exitCode: null }], doneWhen: [{ manual: 'm' }], unverified: ['x', 'y'] }), 'verified: 1 passed, 3 FAILED (`a`, `b`, …); not verified: 2 claims; not checked: 2');
  assert.equal(receiptSummary({ checks: [{ check: 'a\n# b`c', status: 'fail', exitCode: 1 }], doneWhen: [], unverified: [] }), "verified: 0 passed, 1 FAILED (`a # b'c`); not verified: 0 claims; not checked: 0");
});

/**
 * Why a module can reach more than text: each import outside `allowed` (module and name, multi-line or not), any
 * re-export, dynamic import(), require, await, `this`, or a global that talks to the world (fetch, globalThis,
 * process, eval, Function, ...). Read from the TypeScript syntax tree, so formatting can't hide one.
 */
function reach(source: string, allowed: string[]): string[] {
  const src = ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const GLOBALS = new Set(['fetch', 'globalThis', 'process', 'require', 'eval', 'Function', 'XMLHttpRequest', 'WebSocket', 'Deno', 'Bun', 'window', 'global']);
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n)) {
      const from = (n.moduleSpecifier as ts.StringLiteral).text;
      const c = n.importClause;
      if (!c) out.push(`side-effect import ${from}`);
      else {
        if (c.name) out.push(`default import from ${from}`);
        const b = c.namedBindings;
        if (b && ts.isNamespaceImport(b)) out.push(`namespace import from ${from}`);
        if (b && ts.isNamedImports(b)) for (const e of b.elements) if (!allowed.includes(`${from}:${(e.propertyName ?? e.name).text}`)) out.push(`import ${(e.propertyName ?? e.name).text} from ${from}`);
      }
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier) out.push(`re-export from ${(n.moduleSpecifier as ts.StringLiteral).text}`);
    else if (ts.isImportEqualsDeclaration(n)) out.push('import = require');
    else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) out.push('dynamic import()');
    else if (ts.isAwaitExpression(n)) out.push('await');
    else if (n.kind === ts.SyntaxKind.ThisKeyword) out.push('this');
    else if (ts.isIdentifier(n) && GLOBALS.has(n.text)) out.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}
// check-table: never-grow
const PACKET_ALLOWED = ['../brand.js:BRAND', '../backlog/types.js:DoneWhenList', '../events/types.js:EventPayload', '../path-text.js:shownPath', '../pr-rules.js:RiskClass', '../receipts.js:receiptLines', '../receipts.js:receiptSummary', '../receipts.js:CheckRecord'];

test('no new approval path: the packet and the receipts it uses are text from the record, and reach nothing that approves, merges, runs or calls out', () => {
  const packet = readFileSync(join(repoRoot, 'src', 'coordinator', 'review-packet.ts'), 'utf8');
  assert.deepEqual(reach(packet, PACKET_ALLOWED), []);
  assert.deepEqual(reach(readFileSync(join(repoRoot, 'src', 'receipts.ts'), 'utf8'), ['./backlog/types.js:DoneWhenList']), []);
  // How a path reads (an eval target, #683): text only, it imports nothing.
  assert.deepEqual(reach(readFileSync(join(repoRoot, 'src', 'path-text.ts'), 'utf8'), []), []);
  // The check itself catches each way past it an evaluator found, and the obvious others.
  const bypasses: Record<string, string> = {
    'a shell helper from an allowed-looking module': packet.replace("import type { RiskClass } from '../pr-rules.js';", "import type { RiskClass } from '../pr-rules.js';\nimport { sh } from './shared.js';"),
    'a second name from an allowed module': packet.replace('import { receiptLines, receiptSummary, type CheckRecord }', 'import { receiptLines, receiptSummary, lowerConfidence, type CheckRecord }'),
    'a multi-line import': `${packet}\nimport {\n  approveMerge,\n} from '../decide.js';\n`,
    'a re-export': `${packet}\nexport { approveMerge } from '../decide.js';\n`,
    'export *': `${packet}\nexport * from '../decide.js';\n`,
    'a dynamic import': `${packet}\nexport function leak() { void import('node:child_process').then((m) => m.execSync('true')); }\n`,
    'fetch': `${packet}\nexport function leak() { void fetch('https://example.com'); }\n`,
    'globalThis': `${packet}\nexport function leak() { return (globalThis as Record<string, unknown>)['fet' + 'ch']; }\n`,
    'require': `${packet}\nexport function leak() { return require('node:fs'); }\n`,
    'a side-effect import': `import '../decide.js';\n${packet}`,
  };
  for (const [what, source] of Object.entries(bypasses)) assert.notDeepEqual(reach(source, PACKET_ALLOWED), [], `${what} is caught`);
});

test('a waiting PR gets the packet once per head, beside the label and the review request; the decision is the same as without it', { skip }, async () => {
  const t = await openPr({ 'evaluator-verdict': approve() });
  t.f.log.append('instructions.eval', evalOf('roles/worker.md', { issue: t.n, head: t.opened.head }), 'coordinator');
  await green(t);
  const decided = lastOf(t.f.log, 'merge.decided') as { auto: boolean; reasons: string[] };
  assert.deepEqual([decided.auto, decided.reasons], [false, ['auto-merge is off for this instance (policy.yaml auto_merge)']]);
  assert.ok(!t.pr().merged);
  assert.ok(t.pr().labels.includes('needs-owner'));
  assert.deepEqual(t.pr().reviewers, ['example-owner']);
  const packets = () => t.pr().comments.filter((x) => /waits for you to review and merge/.test(x.body));
  assert.equal(packets().length, 1);
  const top = packetTop(packets()[0]!.body);
  assert.ok(top.length <= PACKET_VISIBLE_MAX);
  assert.match(top, /^- `auto-merge is off for this instance \(policy\.yaml auto_merge\)`$/m);
  assert.match(top, /^\*\*Risk class:\*\* logic$/m, 'src/price.js: neither docs nor high-risk');
  assert.match(top, /^\*\*Evaluator:\*\* approves, confidence high$/m);
  assert.match(top, /^\*\*Evals:\*\* `roles\/worker\.md` 3\/4 → 4\/4$/m);
  assert.match(top, /^\*\*Receipts:\*\* verified: \d+ passed; not verified: 0 claims; not checked: \d+$/m);
  assert.match(packets()[0]!.body, /<details><summary>Full details<\/summary>[\s\S]*### VERIFIED/);
  await t.c.tick();
  await t.c.tick();
  assert.equal(packets().length, 1, 'one packet per head, not one per poll');
  assert.ok(!t.pr().merged, 'the packet approves nothing');
});

for (const [what, facts] of [
  ['reading the facts throws', () => { throw new Error('packet facts unreadable'); }],
  ['building the packet throws', () => ({ risk: { cls: 'protected', why: null }, verdict: undefined, evals: [], receipts: null })],
] as const) {
  test(`a packet that can't be built (${what}): the owner still gets the label, the plain comment and the review request, and the error is recorded`, { skip }, async () => {
    const t = await openPr({ 'evaluator-verdict': approve() });
    (t.c as unknown as { packetFacts: () => unknown }).packetFacts = facts;
    await green(t);
    const decided = lastOf(t.f.log, 'merge.decided') as { auto: boolean; reasons: string[] };
    assert.deepEqual([decided.auto, decided.reasons], [false, ['auto-merge is off for this instance (policy.yaml auto_merge)']]);
    assert.ok(t.pr().labels.includes('needs-owner'));
    assert.deepEqual(t.pr().reviewers, ['example-owner']);
    const asked = t.pr().comments.filter((x) => /waits for you to review and merge/.test(x.body));
    assert.equal(asked.length, 1);
    assert.match(asked[0]!.body, /^\[\S+\] @example-owner ready, and waits for you to review and merge \(`\w{8}`\):\n- `auto-merge is off for this instance \(policy\.yaml auto_merge\)`$/);
    const err = t.f.log.read(0, ['coordinator.error']).map((e) => e.payload as { where: string }).filter((p) => p.where === `review packet #${t.opened.number}`);
    assert.equal(err.length, 1);
    assert.ok(!t.pr().merged);
  });
}
