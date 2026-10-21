// #869, #886's round-5 review: a table's old lines kept as dead text can't hide the live table from the reader, however
// the lines around the escape read on their own, and through a global binding; and the merge decision reads the default
// branch's tip whatever the clone's fetch refspec. Fixtures for the pure reader, and one real repo for the decision. No
// repo file is read or edited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import type { PullRequest } from '../src/backlog/types.js';
import { loadConfig } from '../src/config/load.js';
import { ReviewConfig } from '../src/config/schema.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import * as weakening from '../src/merge-policy-weakening.js';
import type { ChangeFile } from '../src/review.js';
import { FakeRunner } from '../src/runner.js';
import { exampleProject } from './helpers.js';

/** The start of the reason (its examples may grow). */
const HIDDEN = "adds a line that could hide a check's table from the line reader";
const kinds = (reasons: string[]) => reasons.map((r) => r.slice(weakening.WEAKENING_REASON.length).replace(/ \(.*$/s, '')).map((k) => (k.startsWith(HIDDEN) ? HIDDEN : k));

/** The pure hold for a change given as each file's text before and after, its lines as a diff gives them. */
function weakens(before: Record<string, string>, after: Record<string, string>): string[] {
  const minus = (a: string[], b: string[]) => {
    const left = [...b];
    return a.filter((x) => {
      const k = left.indexOf(x);
      if (k === -1) return true;
      left.splice(k, 1);
      return false;
    });
  };
  const files: ChangeFile[] = Object.keys(after).map((path) => {
    const [b, a] = [(before[path] ?? '').split('\n'), after[path]!.split('\n')];
    const removed = minus(b, a).filter(Boolean);
    const added = minus(a, b).filter(Boolean);
    return { path, added: added.length, removed: removed.length, addedLines: added, removedLines: removed };
  });
  return kinds(weakening.weakeningReasons({ files, deleted: new Set(), before: (p) => before[p] ?? null, after: (p) => after[p] ?? null, scope: undefined }));
}

const F = 'test/x-rules.test.ts';
const L = 'test/x-lint.test.ts';
const BASE = "import { test } from 'node:test';\n// check-table: never-shrink\nexport const CHECKS = [\n  'a',\n  'b',\n  'c',\n];\ntest('t', () => { for (const c of CHECKS) void c; });\n";
const LINT = `// lint-test\n${BASE}`;
const ESC = "export const C\\u0048ECKS = ['a'];";
/** The table's old lines kept in a template literal, `after` on the line that closes it. */
const inTemplate = (text: string, after: string) => text.replace('// check-table', 'export const DOC = `\n// check-table').replace('];\n', `];\n\`;${after}\n`);
/** The table's old lines kept in a block comment, `after` on the next line. */
const inComment = (text: string, after: string) => text.replace('// check-table', '/*\n// check-table').replace('];\n', `];\n*/\n${after}\n`);

test('decoy (P1): the escaped declaration on the line that closes the template holding the old lines waits', () => {
  assert.ok(weakens({ [F]: BASE }, { [F]: inTemplate(BASE, ` ${ESC}`) }).includes(HIDDEN), 'test file');
  assert.ok(weakens({ [L]: LINT }, { [L]: inTemplate(LINT, ` ${ESC}`) }).includes(HIDDEN), 'lint test');
});

test('decoy (P2): a regex literal holding a quote, then the escaped declaration, waits', () => {
  assert.ok(weakens({ [F]: BASE }, { [F]: inComment(BASE, `/'/; ${ESC}`) }).includes(HIDDEN), "/'/");
  assert.ok(weakens({ [F]: BASE }, { [F]: inComment(BASE, `/"/; ${ESC}`) }).includes(HIDDEN), '/"/');
  assert.ok(weakens({ [F]: BASE }, { [F]: inComment(BASE, `/\`/; ${ESC}`) }).includes(HIDDEN), '/`/');
  assert.ok(weakens({ [F]: BASE }, { [F]: inComment(BASE, `const half = 4 / 2; const s = '/'; ${ESC}`) }).includes(HIDDEN), 'a division, then a string holding a slash');
  assert.ok(weakens({ [F]: BASE }, { [F]: inComment(BASE, `/[/']/.test('x'); ${ESC}`) }).includes(HIDDEN), 'a slash and a quote in a class');
});

test('decoy (P3): the live table bound on the global object, or under a key built from strings, waits', () => {
  for (const line of ["Object.assign(globalThis, { ['CHE' + 'CKS']: ['a'] });", "globalThis['CHE' + 'CKS'] = ['a'];", "global.CHECKS = ['a'];", "self.CHECKS = ['a'];", "window.CHECKS = ['a'];", "Object.assign(scope, { ['CHE' + 'CKS']: ['a'] });"]) {
    assert.ok(weakens({ [F]: BASE }, { [F]: inComment(BASE, line) }).includes(HIDDEN), line);
    assert.ok(weakens({ [L]: LINT }, { [L]: inComment(LINT, line) }).includes(HIDDEN), `lint test: ${line}`);
  }
});

test("decoy (the builder's own pass): what a line or a whole-file reader could misplace still waits", () => {
  const cases: Record<string, string> = {
    'a regex literal after `export default`': `export default /'/; ${ESC}`,
    'a division after a property named like a keyword': `const z = q.in / 1; ${ESC} const y = 2 / 1;`,
    'a carriage return ending a `//` comment mid-line': `// note${String.fromCharCode(13)}${ESC}`,
    'a line separator ending a `//` comment mid-line': `// note${String.fromCharCode(0x2028)}${ESC}`,
    'an HTML-like comment opener before a block comment': `<!-- /*\n${ESC}\n// */`,
    'a regex literal after `)` of a condition': `if (ok) /'/.test('x'); ${ESC}`,
  };
  for (const [what, after] of Object.entries(cases)) assert.ok(weakens({ [F]: BASE }, { [F]: inComment(BASE, after) }).includes(HIDDEN), what);
  // A hashbang line is a comment: a `/*` on it opens nothing.
  const S = 'scripts/x-rules.mjs';
  const script = `#!/usr/bin/env node\n${BASE}`;
  assert.ok(weakens({ [S]: script }, { [S]: `#!/usr/bin/env node /*\n${ESC}\n// */\n${BASE.replace('// check-table', '/*\n// check-table').replace('];\n', '];\n*/\n')}` }).includes(HIDDEN), 'hashbang');
});

test('decoy: ordinary added lines still pass: those words in a string or comment, a string key, an escape in a string or template', () => {
  const add = (l: string) => weakens({ [F]: BASE }, { [F]: `${BASE}${l}\n` });
  for (const l of ["const what = 'self-modification of the window';", '// the global list', "const o = { 'key': 1 };", "const accent = '\\u00e9';", 'const t = `caf\\u00e9`;', "const half = 4 / 2;", "const r = /a'b/.test('x');", 'const u = `a ${1 + 1} b`;']) {
    assert.deepEqual(add(l), [], l);
  }
});

test('the merge decision reads the tip whatever the fetch refspec: a clone that maps only another branch still sees a mark that landed after the claim', () => {
  const dir = exampleProject().dir;
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (files: Record<string, string>) => {
    for (const [p, t] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), t);
    }
    g('add', '-A');
    g('commit', '-q', '-m', 'step');
    return g('rev-parse', 'HEAD');
  };
  const P = 'test/rules.test.ts';
  const table = (mark: boolean, rows: string[]) => `import { test } from 'node:test';\n${mark ? '// check-table: never-shrink\n' : ''}export const CHECKS = [\n${rows.map((r) => `  '${r}',`).join('\n')}\n];\ntest('t', () => {});\n`;
  const base = commit({ [P]: table(false, ['a', 'b', 'c']) });
  execFileSync('git', ['init', '-q', '--bare', join(dir, '..', 'origin.git')], { stdio: 'ignore' });
  g('remote', 'add', 'origin', join(dir, '..', 'origin.git'));
  g('push', '-q', 'origin', `${base}:refs/heads/main`);
  g('fetch', '-q', 'origin');
  // The clone's refspec now maps only another branch: a plain `fetch origin main` leaves refs/remotes/origin/main at
  // the base.
  g('config', 'remote.origin.fetch', '+refs/heads/other:refs/remotes/origin/other');
  g('checkout', '-q', '-b', 'tip');
  const tip = commit({ [P]: table(true, ['a', 'b', 'c']) });
  g('push', '-q', 'origin', `${tip}:refs/heads/main`);
  g('checkout', '-q', '-b', 'pr', base);
  const head = commit({ [P]: table(false, ['a', 'b']) });
  const cfg = loadConfig(dir);
  cfg.project.land_mode = 'pr';
  cfg.review = ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: [] }, L1_evaluator: { when: ['app-non-money'] }, L2_notify: { when: [] }, L3_human: { when: ['secrets'] } } });
  const log = new EventLog(join(dir, '..', 'events.db'));
  const n = 7;
  log.append('issue.claimed', { issue: n, instance: 'i', lease: 'a'.repeat(40), base, owner: 'example-owner' }, 'i');
  log.append('pr.opened', { issue: n, number: 9, url: 'u', head, draft: false }, 'i');
  log.append('eval.verdict', { issue: n, head, patch_hash: 'h', patch_correct: true, test_correct: true, confidence: 'high', advice: '', design_change: false }, 'i');
  const c = new Coordinator({ cfg, log, backlog: new FileBacklog(join(dir, '..', 'b.json')), runner: new FakeRunner(() => ({})), repo: dir, instance: 'i', stateDir: join(dir, '..', 'state'), autoMerge: () => true });
  const pr: PullRequest = { number: 9, url: 'u', head: 'pr', base: 'main', headSha: head, draft: false, state: 'open', title: 't', mergeable: true, mergeableState: 'clean' };
  const d = c.mergeDecisionFor(n, 9, pr);
  assert.equal(d.auto, false, d.reasons.join(' | '));
  assert.ok(d.reasons.some((r) => r.startsWith(`${weakening.WEAKENING_REASON}removes or changes an entry in a check's rules`)), d.reasons.join(' | '));
});
