// #966 round 2: each caller reads a glob's `?` as what a match does there. Where a match refuses, protects or marks
// (deny), an astral character counts for `?`; where it exempts, permits or lowers (allow), only what main matched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ReviewConfig } from '../src/config/schema.js';
import { Secrets } from '../src/guardrails/access.js';
import { computeLevel, moneyBefore, moneyListEntries } from '../src/review.js';

const KEY = '\u{1F511}';
const isMoney = (list: string, path: string) => moneyListEntries(list).some((re) => re.test(path));

test('R123a: a money line whose comment holds an astral character still covers what main read (the cover test is allow)', () => {
  // Main: the cut glob `billing/**/?` doesn't cover the line, so it reads `billing/**/?**`: billing/charge.ts is money.
  for (const line of [`billing/**/? # see /${KEY}`, `billing/**/? // see /${KEY}`, `pay/**/? # /${KEY}`]) {
    const dir = line.split('/')[0]!;
    assert.ok(isMoney(line, `${dir}/charge.ts`), `${JSON.stringify(line)}: ${dir}/charge.ts`);
    assert.ok(isMoney(line, `${dir}/x/${KEY}`), `${JSON.stringify(line)}: an astral name under it`);
  }
});

test('a money glob counts an astral ? as money, but what main counted (moneyBefore) stays main\'s own reading', () => {
  const list = 'billing/?.ts';
  assert.ok(isMoney(list, `billing/${KEY}.ts`), 'money: deny reads one character');
  assert.ok(!moneyBefore(moneyListEntries(list)).some((re) => re.test(`billing/${KEY}.ts`)), 'main did not count it, so it stays app code for the large-change L2');
  assert.ok(moneyBefore(moneyListEntries(list)).some((re) => re.test('billing/a.ts')));
  assert.ok(moneyBefore(moneyListEntries('billing/**')).some((re) => re.test('billing/a.ts')));
});

test('R123b: a secret ! exception with ? never excepts an astral name main didn\'t except; a secret glob with ? holds one', () => {
  const root = '/nonexistent-966';
  const ctx = { projectRoot: root, home: join(root, 'no-home') };
  const ex = new Secrets(['keys/**', '!keys/?.pem'], ctx);
  assert.equal(ex.at(join(root, 'keys', `${KEY}.pem`)), true, 'still a secret');
  assert.equal(ex.at(join(root, 'keys', 'k.pem')), false, 'the exception as before');
  const deny = new Secrets(['keys/?.pem'], ctx);
  assert.equal(deny.at(join(root, 'keys', `${KEY}.pem`)), true);
  assert.equal(deny.at(join(root, 'keys', 'k.pem')), true);
});

test('a docs or tests category glob with ? never lowers a level for an astral name main counted as app code', () => {
  const cfg = ReviewConfig.parse({
    version: 1,
    categories: { docs: ['notes/?.txt'] },
    levels: { L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 }, L1_evaluator: { when: ['app-non-money'], max_lines: 400, max_files: 10 }, L2_notify: { when: ['dependency'] }, L3_human: { when: ['money-path'] } },
  });
  const level = (path: string) => computeLevel({ files: [{ path, added: 1, removed: 0 }], labels: [], moneyPaths: [], scope: undefined }, cfg).level;
  assert.equal(level('notes/a.txt'), 'L0');
  assert.equal(level(`notes/${KEY}.txt`), 'L1');
});
