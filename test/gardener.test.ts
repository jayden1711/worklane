import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StoredEvent } from '../src/events/types.js';
import { gardenerDue, gardenerSignals, gardenerView, logEntry, patternHistory, readFindings, toFile, type Finding } from '../src/gardener.js';
import { contractProblems } from '../src/role-contract.js';
import { defaultRolePrompt } from '../src/roles.js';
import { engineRoleCases, parseCases } from '../src/skilleval.js';

const DRAFT = ['**Outcome:** One rounding helper.', '**Sources:** src/money.js and its callers.', '**Constraints:** No behavior change.', '**Deliverable:**', '```done_when', '- command: |', '    node --test', '```', '**Review point:** L1; waits for the owner if it touches money paths.'].join('\n');
const ev = (type: string, payload: object, ts = '2026-10-12T10:00:00.000Z') => ({ id: 0, ts, type, payload, actor: 'test', source: 'x' }) as unknown as StoredEvent;
const f = (pattern: string, where: string[], fix = true): Finding => ({ pattern, kind: 'duplication', where, detail: 'd', fix: fix ? { title: `Fix ${pattern}`, body: DRAFT } : null });

test('due once a period, off-hours: from the day\'s time to 3 hours after, and never again within the period', () => {
  const at = (h: number, m = 0, day = 12) => new Date(2026, 9, day, h, m);
  const o = { everyDays: 7, at: '03:00' };
  assert.equal(gardenerDue(at(2, 59), null, o), false, 'before the time');
  assert.equal(gardenerDue(at(3, 0), null, o), true);
  assert.equal(gardenerDue(at(5, 59), null, o), true);
  assert.equal(gardenerDue(at(6, 0), null, o), false, 'not in the working day');
  assert.equal(gardenerDue(at(3, 10, 18), at(3, 0, 12).toISOString(), o), false, 'six days later');
  assert.equal(gardenerDue(at(3, 0, 19), at(3, 5, 12).toISOString(), o), true, 'a week later, a few minutes earlier than last time');
});

test("the log's own signals: files conflict fixes keep touching, slow checks, checks that flip on one commit", () => {
  const s = gardenerSignals([
    ev('conflict_fix.finished', { files: ['package-lock.json', 'src/a.js'] }),
    ev('conflict_fix.finished', { files: ['package-lock.json'] }),
    ev('check.result', { issue: 1, head: 'aaaaaaa', stage: 'verify', checks: [{ check: 'npm test', status: 'fail', exitCode: 1, duration_ms: 90_000 }] }),
    ev('check.result', { issue: 1, head: 'aaaaaaa', stage: 'verify', checks: [{ check: 'npm test', status: 'pass', exitCode: 0, duration_ms: 95_000 }] }),
  ]);
  assert.deepEqual(s.map((x) => [x.pattern, x.kind, x.where]), [['hotspot:package-lock.json', 'hotspot', ['package-lock.json']], ['slow-check:npm-test', 'slow_check', ['npm test']], ['flaky-check:npm-test', 'flaky_check', ['npm test']]]);
  assert.match(s[0]!.detail, /2 conflict fixes/);
});

test("the run's findings are checked: a kind, a pattern and a place; a fix only as a valid five-part draft", () => {
  const r = readFindings({
    findings: [
      { pattern: 'Hand Rolled Rounding', kind: 'duplication', where: ['./src/cart.js', 'src/invoice.js'], detail: 'same rounding', fix_title: 'Use roundCents', fix_body: DRAFT },
      { pattern: 'x', kind: 'nonsense', where: ['a'], detail: '', fix_title: '', fix_body: '' },
      { pattern: 'dead-export', kind: 'dead_code', where: ['src/old.js'], detail: 'unused', fix_title: 'Delete it', fix_body: 'just delete' },
    ],
  });
  assert.deepEqual(r.findings.map((x) => [x.pattern, x.where, x.fix?.title ?? null]), [['hand-rolled-rounding', ['src/cart.js', 'src/invoice.js'], 'Use roundCents'], ['dead-export', ['src/old.js'], null]]);
  assert.equal(r.refused.length, 2);
  assert.match(r.refused[1]!, /^dead-export: its fix isn't a valid draft/);
});

test('a fix is filed only for a pattern seen 3+ times (over every run), once, outside protected paths, at most max_prs', () => {
  const history = patternHistory([ev('gardener.finding', { pattern: 'p2', where: ['a', 'b'] }), ev('gardener.finding', { pattern: 'done', where: ['a', 'b', 'c'] }), ev('gardener.filed', { pattern: 'done', issue: 40 })]);
  const isProtected = (p: string) => p.startsWith('migrations/');
  const plan = toFile([f('p1', ['x']), f('p2', ['c']), f('done', ['d']), f('mig', ['migrations/1.sql', 'migrations/2.sql', 'migrations/3.sql']), f('p3', ['x', 'y', 'z', 'w']), f('nofix', ['1', '2', '3'], false)], history, { maxPrs: 1, isProtected });
  assert.deepEqual(plan.file.map((x) => x.pattern), ['p3'], 'most-seen first, within the limit');
  const why = Object.fromEntries(plan.held.map((h) => [h.pattern, h.why]));
  assert.match(why.p1!, /seen 1 time\(s\); a fix is filed from 3/);
  assert.match(why.done!, /already filed as #40/);
  assert.match(why.mig!, /high-risk or safety-floor path: logged only/);
  assert.match(why.nofix!, /no fix proposed/);
  assert.match(why.p2!, /over this run's limit of 1/, 'seen twice before plus once now: eligible, but over the limit');
});

test('the log entry and the read model', () => {
  const e = logEntry({ at: '2026-10-12T03:04:00.000Z', findings: [f('p3', ['x', 'y']), f('p1', ['z'])], filed: [{ pattern: 'p3', issue: 41 }], held: [{ pattern: 'p1', why: 'seen 1 time(s)' }], refused: ['bad one'], costUsd: 1.2 });
  assert.match(e, /^### Gardener run, 2026-10-12 03:04 UTC \(\$1\.20\)/);
  assert.match(e, /\*\*p3\*\* \(duplication\): `x`, `y`\. d → fix filed as #41/);
  assert.match(e, /\*\*p1\*\* .*\(seen 1 time\(s\)\)/);
  assert.match(e, /Refused from the run:\n- bad one/);
  const v = gardenerView([ev('gardener.finding', { pattern: 'p3', kind: 'duplication', where: ['x', 'y'], detail: 'd' }), ev('gardener.filed', { pattern: 'p3', issue: 41 }), ev('gardener.run', { started_at: '2026-10-12T03:00:00.000Z', findings: 1, filed: [41], cost_usd: 1.2, log_issue: 9, outcome: 'done' })]);
  assert.deepEqual(v, { logIssue: 9, runs: [{ at: '2026-10-12T03:00:00.000Z', findings: 1, filed: [41], costUsd: 1.2, outcome: 'done' }], patterns: [{ pattern: 'p3', kind: 'duplication', sightings: 2, places: ['x', 'y'], filed: 41, lastSeen: '2026-10-12T10:00:00.000Z' }] });
});

test('the gardener role follows the contract and ships eval cases, manipulation among them', () => {
  assert.deepEqual(contractProblems(defaultRolePrompt('gardener')), []);
  const cases = parseCases(engineRoleCases('gardener') ?? '');
  assert.ok(cases.length >= 6 && cases.every((c) => c.correct.length && c.wrong.length), `${cases.length} cases`);
  assert.ok(cases.filter((c) => /manipulation/i.test(c.title)).length >= 2);
});
