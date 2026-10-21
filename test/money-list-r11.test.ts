// #763 round 11, from the round-10 reviews:
// - in a list of regexes, a line with a blank was skipped as code, even when it held a regex (`=> /^src\/ledger\//
//   .test(p)`) or was a glob with a space (`Shared Ledger/**`): neither read nor refused, doctor ok, and the path L1;
// - suggestions narrower than the line: under the i flag (`billing/**` for `/^billing\//i`), a refused line holding a
//   regex read as a literal glob, and a `{` that isn't a quantifier;
// - main's money RegExps tested twice for each app path (once for membership, once for what main counted);
// - a glob that holds ` #` (`docs/Issue #12/**`) cut at the comment syntax, silently;
// - a # after a no-break space, a CR-only list, an apostrophe in a name, a TS line with a /* */ comment.
//
// WHY the look-alike letter and the no-break space are written as themselves or found by their properties: no committed
// file holds a code point number (#763).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewConfig } from '../src/config/schema.js';
import { globToRegExp } from '../src/guardrails/glob.js';
import * as review from '../src/review.js';

const { computeLevel, loadMoneyPaths, moneyListCheck, moneyListEntries, moneyListProblems, MoneyGlob } = review;
/** The Cyrillic small ie, written as itself. */
const CYRILLIC_IE = 'е';
/** The no-break space: the first space separator past ASCII. */
const NBSP = Array.from({ length: 128 }, (_, i) => String.fromCodePoint(128 + i)).find((c) => /^\p{Zs}$/u.test(c))!;
const LEVELS = { L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 }, L1_evaluator: { when: ['app-non-money'], max_lines: 400, max_files: 10 }, L2_notify: { when: ['dependency'] } };
const MONEY_L3 = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: ['money-path'], over_lines: 800 } } });
const level = (money: RegExp[], path: string) => computeLevel({ files: [{ path, added: 1, removed: 0 }], labels: [], moneyPaths: money, scope: undefined }, MONEY_L3);

function fromRepo(text: string): { doctor: { level: string; detail: string }; money: RegExp[] } {
  const dir = mkdtempSync(join(tmpdir(), 'money-r11-'));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'money.ts'), text);
  git('add', '-A');
  git('commit', '-q', '-m', 'money');
  const src = { file: 'money.ts' } as Parameters<typeof moneyListCheck>[1];
  return { doctor: moneyListCheck(dir, src, 'HEAD'), money: loadMoneyPaths(dir, src, 'HEAD') };
}

const TS_LIST = 'export const MONEY = [\n  /^src\\/billing\\//,\n];\nexport const isLedger = (p: string) => /^src\\/ledger\\//.test(p);\n';

test('#763 round 11: the characters here are the ones their names say', () => {
  assert.ok(/^\p{Script=Cyrillic}$/u.test(CYRILLIC_IE) && !/[a-z]/.test(CYRILLIC_IE));
  assert.equal(NBSP.normalize('NFKC'), ' ');
});

test('#763 round 11: a TS money file, on a list main threw on (option b): the line with a regex in code is refused, and its path is held', () => {
  // The block comment names src/**/billing, whose `/**/` main read as a regex and threw on.
  const { doctor, money } = fromRepo(`/* Money paths; the old ones were src/**/billing. */\n${TS_LIST}`);
  assert.equal(level(money, 'src/ledger/post.ts').level, 'L3');
  assert.equal(doctor.level, 'fail', doctor.detail);
  assert.ok(doctor.detail.includes('export const isLedger'), doctor.detail);
  // A list with a glob with a space beside regexes: refused, never skipped.
  const shared = moneyListEntries('src/**/billing/**\n/^src\\/payments\\//\nShared Ledger/**\n');
  assert.deepEqual(moneyListProblems(shared).map((p) => p.line), ['Shared Ledger/**']);
  assert.equal(level(shared, 'Shared Ledger/post.ts').level, 'L3');
});

test('#763 round 11: the same TS file on a list main loaded: a look-alike of the regex in code is held', () => {
  const { money } = fromRepo(TS_LIST);
  const lookalike = `src/l${CYRILLIC_IE}dger/post.ts`;
  const r = level(money, lookalike);
  assert.equal(r.level, 'L3', r.reasons.join('\n'));
  assert.ok((r.categories['confusable-path'] ?? []).includes(lookalike), r.reasons.join('\n'));
});

test('#763 round 11: suggestions are never narrower: the i flag, a regex refused as a line, a { that isn\'t a quantifier', () => {
  const covers = (line: string, paths: string[]) => {
    const problems = moneyListProblems(moneyListEntries(line));
    assert.equal(problems.length, 1, line);
    const g = globToRegExp(problems[0]!.suggestion);
    for (const p of paths) assert.ok(g.test(p), `${line} -> ${problems[0]!.suggestion} misses ${p}`);
    assert.deepEqual(moneyListProblems(moneyListEntries(problems[0]!.suggestion)), [], problems[0]!.suggestion);
  };
  covers('/^billing\\//i', ['billing/x.ts', 'Billing/charge.ts', 'BILLING/x.ts']);
  covers('/billing/i', ['src/billing/x.ts', 'src/Billing/x.ts']);
  covers('/^billing\\//.', ['billing/charge.ts']);
  covers('/^src\\/billing\\//.test(path)', ['src/billing/charge.ts']);
  covers('/^a{|z}q$/', ['a{x', 'xz}q']);
});

test('#763 round 11: a whole-line fuzz with the i flag: every refused line\'s suggestion covers what its regex matches, and every read line\'s globs do', () => {
  const ALPHABET = ['a', 'b', 'A', '/', '.', '{'];
  const paths: string[] = [''];
  for (let n = 1; n <= 4; n++) for (const p of paths.filter((q) => q.length === n - 1)) for (const c of ALPHABET) paths.push(p + c);
  const PIECES = ['a', 'b', 'A', '\\/', '\\.', '[^/]', '.*', '.', '?', '*', '+', '{0}', '{0,2}', '{', '}', '|', '(a|b)', '[ab]', '$'];
  const FLAGS = ['', 'i', 'u', 'iu', 'g'];
  const TEMPLATES = [(r: string) => r, (r: string) => `${r},`, (r: string) => `x ${r}`, (r: string) => `"g/**", ${r}`, (r: string) => `${r}.test(p)`, (r: string) => `const R = ${r};`, (r: string) => `${r} # c`];
  let seed = 1111;
  const rand = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % n;
  };
  let tried = 0;
  const misses: string[] = [];
  for (let k = 0; k < 3_000; k++) {
    let body = rand(2) ? '^' : '';
    for (let j = 0, len = 1 + rand(5); j < len; j++) body += PIECES[rand(PIECES.length)]!;
    const flags = FLAGS[rand(FLAGS.length)]!;
    let re: RegExp;
    try {
      re = new RegExp(body, flags.replace('g', ''));
    } catch {
      continue;
    }
    if (body.includes('/') && !body.includes('\\/')) continue;
    const line = TEMPLATES[rand(TEMPLATES.length)]!(`/${body}/${flags}`);
    tried++;
    // What the line was read as (its globs) or the glob its refusal suggests; main's kept readings aside.
    const entries = moneyListEntries(line);
    const globs = [
      ...entries.flatMap((e) => (e instanceof MoneyGlob ? [globToRegExp(e.glob)] : [])),
      ...moneyListProblems(entries).map((p) => globToRegExp(p.suggestion)),
    ];
    if (!globs.length) {
      misses.push(`neither read nor refused: ${line}`);
      continue;
    }
    const missed = paths.find((p) => re.test(p) && !globs.some((g) => g.test(p)));
    if (missed !== undefined) misses.push(`${line} misses ${JSON.stringify(missed)}`);
  }
  assert.ok(tried > 1_000, `${tried} lines`);
  assert.deepEqual(misses.slice(0, 5), []);
});

test('#763 round 11: each money RegExp is tested once for each path, for membership and for what main counted together', () => {
  class Counting extends RegExp {
    n = 0;
    override test(s: string): boolean {
      this.n++;
      return super.test(s);
    }
  }
  class CountingGlob extends MoneyGlob {
    n = 0;
    override test(s: string): boolean {
      this.n++;
      return super.test(s);
    }
  }
  // A glob line's entry, whose `before` is itself, and a regex line's, whose `before` is main's own RegExp.
  const globs = Array.from({ length: 5 }, (_, i) => {
    const g = new CountingGlob(globToRegExp(`g${i}/**`), `g${i}/**`);
    g.before = g;
    return g;
  });
  const befores = Array.from({ length: 5 }, (_, i) => new Counting(`^r${i}\\/`));
  const regexLines = befores.map((b, i) => {
    const g = new CountingGlob(globToRegExp(`r${i}/**`), `r${i}/**`);
    g.before = b;
    return g;
  });
  const files = Array.from({ length: 40 }, (_, i) => ({ path: `app/f${i}.ts`, added: 1, removed: 0 }));
  computeLevel({ files, labels: [], moneyPaths: [...globs, ...regexLines], scope: undefined }, MONEY_L3);
  for (const re of [...globs, ...regexLines, ...befores]) assert.equal(re.n, 40, re.source);
});

test('#763 round 11: a glob that holds ` #` is read whole as well, never cut silently, on lists main loads and on lists it threw on', () => {
  for (const text of ['docs/Issue #12/**\nbilling/**\n', 'docs/Issue #12/**\nsrc/**/billing/**\n', 'billing #2/**\n']) {
    const money = moneyListEntries(text);
    assert.deepEqual(moneyListProblems(money), [], text);
    const path = text.startsWith('billing') ? 'billing #2/charge.ts' : 'docs/Issue #12/charge.ts';
    const r = level(money, path);
    assert.equal(r.level, 'L3', `${JSON.stringify(text)}: ${r.reasons.join('; ')}`);
    assert.ok(money.some((e) => e instanceof MoneyGlob && e.test(path)), `${JSON.stringify(text)}: read as a glob, compared for look-alikes`);
  }
});

test('#763 round 11: a # after a no-break space and a CR-only list are refused; an apostrophe in a name and a TS line with a /* */ comment are read', () => {
  for (const text of [`billing/**${NBSP}# card`, 'billing/**\rpayments/**']) {
    const money = moneyListEntries(text);
    assert.equal(moneyListProblems(money).length, 1, JSON.stringify(text));
    for (const path of ['billing/x.ts', 'payments/x.ts']) assert.equal(level(money, path).level, 'L3', `${JSON.stringify(text)}: ${path}`);
  }
  for (const text of ["docs/owner's guide/billing/**", '  /^src\\/billing\\//, /* card data */']) {
    const money = moneyListEntries(text);
    assert.deepEqual(moneyListProblems(money), [], text);
    assert.equal(level(money, text.startsWith('docs') ? "docs/owner's guide/billing/x.ts" : 'src/billing/x.ts').level, 'L3', text);
    assert.equal(level(money, 'lib/other.ts').level, 'L1', `${text}: not every path`);
  }
});
