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
import { changeFiles, filesAt, filesAtOnce } from '../src/coordinator/change-files.js';
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

// #941: a decoy under a new name with every use moved to it, the registered table and its mark left in place unused.
const USE_REMOVED = "removes or changes a line that uses a check's or guard's table, so what the engine uses may no longer be that table";

/**
 * The hold as a real PR gives it its input (R1184a #1): only the files whose text changed are in the diff, and every
 * other file is context, its text before the change, as weakeningOf's contextAt reads it.
 */
function weakensChanged(before: Record<string, string>, after: Record<string, string>): string[] {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const changed = paths.filter((p) => before[p] !== after[p]);
  const lines = (t: string | undefined) => (t === undefined ? [] : t.split('\n'));
  const files: ChangeFile[] = changed.map((path) => {
    const [b, a] = [lines(before[path]), lines(after[path])];
    const left = [...a];
    const removed = b.filter((x) => {
      const k = left.indexOf(x);
      if (k === -1) return true;
      left.splice(k, 1);
      return false;
    }).filter(Boolean);
    const right = [...b];
    const added = a.filter((x) => {
      const k = right.indexOf(x);
      if (k === -1) return true;
      right.splice(k, 1);
      return false;
    }).filter(Boolean);
    return { path, added: added.length, removed: removed.length, addedLines: added, removedLines: removed };
  });
  const registering = new Set(Object.keys(before).filter((p) => /\/\/ check-table: /.test(before[p]!)));
  const context = { paths: new Set(Object.keys(before)), registering, text: (p: string) => before[p] ?? null };
  return kinds(weakening.weakeningReasons({ files, deleted: new Set(changed.filter((p) => after[p] === undefined)), before: (p) => before[p] ?? null, after: (p) => after[p] ?? null, scope: undefined, context }));
}

test('decoy (#941): every use moved to a new table under another name waits, in the same file or imported from another', () => {
  // In the same file: a new declaration, the use switched to it; CHECKS and its mark are unchanged and unused.
  const same = BASE.replace("test('t', () => { for (const c of CHECKS) void c; });", "export const LIVE = ['a'];\ntest('t', () => { for (const c of LIVE) void c; });");
  assert.ok(weakensChanged({ [F]: BASE }, { [F]: same }).includes(USE_REMOVED), 'a decoy in the same file');
  // Imported from a new file: the use switched to the import.
  const imported = BASE.replace("import { test } from 'node:test';", "import { test } from 'node:test';\nimport { LIVE } from './x-live.js';").replace('of CHECKS)', 'of LIVE)');
  assert.ok(weakensChanged({ [F]: BASE }, { [F]: imported, 'test/x-live.ts': "export const LIVE = ['a'];\n" }).includes(USE_REMOVED), 'a decoy imported from another file');
});

test("decoy (#941, R1184a #1): a use in another file moved to a decoy waits when the table's own file is unchanged (only changed files in the diff)", () => {
  const user = "import { CHECKS } from './x-rules.test.js';\nexport const run = () => CHECKS.length;\n";
  const moved = "import { LIVE } from './x-live.js';\nexport const run = () => LIVE.length;\n";
  assert.deepEqual(weakensChanged({ [F]: BASE, 'src/x-user.ts': user }, { [F]: BASE, 'src/x-user.ts': moved, 'src/x-live.ts': "export const LIVE = ['a'];\n" }), [USE_REMOVED]);
});

test('decoy (#941, R1184a #2): a use through an alias, or with the name on a continuation line, moved to a decoy waits', () => {
  // An alias kept, its user switched: `const rules = CHECKS;` stays, `rules.length` becomes `LIVE.length`.
  const alias = `${BASE}const rules = CHECKS;\nexport const run = () => rules.length;\n`;
  const aliasMoved = `${BASE}const rules = CHECKS;\nexport const LIVE = ['a'];\nexport const run = () => LIVE.length;\n`;
  assert.ok(weakensChanged({ [F]: alias }, { [F]: aliasMoved }).includes(USE_REMOVED), 'an alias in the same file');
  // The alias in another file, unchanged, and its importer switched.
  const aliasFile = "import { CHECKS } from './x-rules.test.js';\nexport const rules = CHECKS;\n";
  const importer = "import { rules } from './x-alias.js';\nexport const run = () => rules.length;\n";
  const importerMoved = "import { LIVE } from './x-live.js';\nexport const run = () => LIVE.length;\n";
  assert.deepEqual(weakensChanged({ [F]: BASE, 'src/x-alias.ts': aliasFile, 'src/x-user.ts': importer }, { [F]: BASE, 'src/x-alias.ts': aliasFile, 'src/x-user.ts': importerMoved, 'src/x-live.ts': "export const LIVE = ['a'];\n" }), [USE_REMOVED], 'an alias imported from an unchanged file');
  // The table's name on a continuation line: `const rules =` rewritten, `  CHECKS;` unchanged below it.
  const cont = `${BASE}const rules =\n  CHECKS;\nexport const run = () => rules.length;\n`;
  const contMoved = cont.replace('const rules =\n', 'const rules = LIVE; const unused =\n').replace(BASE, `${BASE}const LIVE = ['a'];\n`);
  assert.ok(weakensChanged({ [F]: cont }, { [F]: contMoved }).includes(USE_REMOVED), 'a continuation line');
  // No binding at all: a call's argument on the next line (`() =>`, then `  CHECKS.length);`), the first line rewritten.
  const arg = `${BASE}test('u', () =>\n  CHECKS.length);\n`;
  const argMoved = arg.replace("test('u', () =>\n", "const LIVE = ['a'];\ntest('u', () => LIVE.length); void (() =>\n");
  assert.ok(weakensChanged({ [F]: arg }, { [F]: argMoved }).includes(USE_REMOVED), "a call's argument on a continuation line");
  // The same through a real repo's diff, with weakeningOf reading the context from git (contextAt).
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
  const base = commit({ [F]: BASE, 'src/x-alias.ts': aliasFile, 'src/x-user.ts': importer });
  const head = commit({ 'src/x-user.ts': importerMoved, 'src/x-live.ts': "export const LIVE = ['a'];\n" });
  const files = changeFiles(dir, base, head);
  assert.deepEqual(files.map((f) => f.path).sort(), ['src/x-live.ts', 'src/x-user.ts'], 'the table file and the alias file are not in the diff');
  assert.deepEqual(kinds(weakening.weakeningOf(dir, base, head, files, undefined, base)), [USE_REMOVED], 'through git');
  // The context's one-batch reader gives filesAt's answer: each blob's text, the size of one over the cap, none for a path not there.
  const asked = [F, 'src/x-alias.ts', 'src/x-user.ts', 'src/none.ts'];
  for (const cap of [Infinity, 60]) assert.deepEqual(filesAtOnce(dir, head, asked, cap), filesAt(dir, head, asked, cap), `cap ${cap}`);
});

test('decoy (#941, R1184c): an alias an import or a destructuring makes, then its use moved to a decoy, waits', () => {
  const live = { 'src/x-live.ts': "export const LIVE = ['a'];\n" };
  const shapes: [string, Record<string, string>, string][] = [
    ['import { CHECKS as C }', {}, "import { CHECKS as C } from '../test/x-rules.test.js';\nexport const run = () => C.length;\n"],
    ['a default import of export default CHECKS', { 'src/x-default.ts': "import { CHECKS } from '../test/x-rules.test.js';\nexport default CHECKS;\n" }, "import C from './x-default.js';\nexport const run = () => C.length;\n"],
    ['const { CHECKS: C } = require(...)', {}, "const { CHECKS: C } = require('../test/x-rules.test.js');\nexport const run = () => C.length;\n"],
    ['import { rules as r }', { 'src/x-alias.ts': "import { CHECKS } from '../test/x-rules.test.js';\nexport const rules = CHECKS;\n" }, "import { rules as r } from './x-alias.js';\nexport const run = () => r.length;\n"],
    ['export { rules as default }, then a default import', { 'src/x-alias.ts': "import { CHECKS } from '../test/x-rules.test.js';\nconst rules = CHECKS;\nexport { rules as default };\n" }, "import r from './x-alias.js';\nexport const run = () => r.length;\n"],
    ['module.exports = CHECKS, then a CommonJS default', { 'src/x-cjs.cjs': "const { CHECKS } = require('../test/x-rules.test.js');\nmodule.exports = CHECKS;\n" }, "const C = require('./x-cjs.cjs');\nexport const run = () => C.length;\n"],
  ];
  for (const [what, extra, user] of shapes) {
    const before = { [F]: BASE, ...extra, 'src/x-user.ts': user };
    // The import or destructuring line kept as it was; only the use switched to the decoy.
    const switched = `import { LIVE } from './x-live.js';\n${user.replace(/\b(?:C|r)\.length/, 'LIVE.length')}`;
    assert.notEqual(switched, user);
    assert.deepEqual(weakensChanged(before, { ...before, 'src/x-user.ts': switched, ...live }), [USE_REMOVED], what);
  }
  // Control: an unrelated default import named like nothing bound; `default` is never a name.
  const other = { [F]: BASE, 'src/x-other.ts': "export default ['x'];\n", 'src/x-user.ts': "import d from './x-other.js';\nexport default d;\nexport const n = d.length;\n" };
  assert.deepEqual(weakensChanged(other, { ...other, 'src/x-user.ts': "import d from './x-other.js';\nexport default d;\nexport const n = d.length + 1;\n" }), []);
});

test('decoy (#941), control: adding a use of the table, changing a line that never named it, or another file\'s own name like an alias, adds no such reason', () => {
  const more = BASE.replace("test('t', () => { for (const c of CHECKS) void c; });", "test('t', () => { for (const c of CHECKS) void c; });\ntest('u', () => { void CHECKS.length; });");
  assert.ok(!weakensChanged({ [F]: BASE }, { [F]: more }).includes(USE_REMOVED), 'an added use (the table-used rule reads added lines)');
  const other = `${BASE}const n = 1;\n`;
  assert.deepEqual(weakensChanged({ [F]: other }, { [F]: other.replace('const n = 1;', 'const n = 2;') }), []);
  // `rules` is bound to CHECKS in one file; another file's own `rules`, bound to something else, is not the table.
  const alias = `${BASE}const rules = CHECKS;\nexport const run = () => rules.length;\n`;
  const own = "const rules = ['x'];\nexport const n = rules.length;\n";
  assert.deepEqual(weakensChanged({ [F]: alias, 'src/x-own.ts': own }, { [F]: alias, 'src/x-own.ts': own.replace('rules.length', 'rules.length + 1') }), []);
});
