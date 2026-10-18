import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { BRAND } from '../src/brand.js';
import { ReviewConfig } from '../src/config/schema.js';
import { globToRegExp } from '../src/guardrails/glob.js';
import { hookCommand, hookEntry } from '../src/install.js';
import { AGENT_INSTRUCTIONS, computeLevel, loadMoneyPaths, LOCKED_CATEGORIES, SELF_MODIFICATION, SELF_MODIFICATION_PARTS, selfModificationPart, type ChangeFile } from '../src/review.js';
// The scope's own functions (#665) through the namespace: on an engine without them, only the tests that use them fail.
import * as review from '../src/review.js';

const cfg = ReviewConfig.parse({
  version: 1,
  levels: {
    L0_auto: { when: ['docs-only', 'tests-only', 'comments', 'copy'], max_lines: 200 },
    L1_evaluator: { when: ['ui', 'app-non-money'], max_lines: 400, max_files: 10 },
    L2_notify: { when: ['app-non-money-large', 'dependency', 'test-machinery'] },
    L3_human: { when: ['money-path', 'migration', 'auth', 'secrets', 'deploy-config', 'release-config', 'harness-config', 'guardrail-config', 'deletes-data'], over_lines: 800 },
  },
});
const money = [/^server\/(ledger|escrow)\//, /^shared\//];
const f = (path: string, added = 10, removed = 0, addedLines?: string[]): ChangeFile => ({ path, added, removed, ...(addedLines ? { addedLines } : {}) });
const level = (files: ChangeFile[], extra: Partial<Parameters<typeof computeLevel>[0]> = {}) => computeLevel({ files, labels: [], moneyPaths: money, scope: undefined, ...extra }, cfg);

test('docs and tests only, small: L0; large: L1', () => {
  assert.equal(level([f('docs/a.md'), f('test/a.test.js')]).level, 'L0');
  assert.equal(level([f('docs/a.md', 300)]).level, 'L1');
});

test('non-money app code: L1; large: L2', () => {
  assert.equal(level([f('web/page.jsx'), f('test/page.test.js')]).level, 'L1');
  assert.equal(level([f('web/page.jsx', 500)]).level, 'L2');
  assert.equal(level(Array.from({ length: 11 }, (_, i) => f(`web/c${i}.jsx`, 1))).level, 'L2');
});

test('money path, migrations, deploy and harness config: L3, with reasons', () => {
  const r = level([f('server/escrow/settle.js', 3)]);
  assert.equal(r.level, 'L3');
  assert.ok(r.reasons.some((x) => x.startsWith('money-path: server/escrow/settle.js')));
  assert.equal(level([f('prisma/migrations/2026_x/migration.sql')]).level, 'L3');
  assert.equal(level([f('.github/workflows/ci.yml')]).level, 'L3');
  assert.equal(level([f('.worklane/guardrails.yaml')]).level, 'L3');
  assert.equal(level([f('web/a.jsx', 900)]).level, 'L3', 'over 800 lines');
});

test('data deletion in added lines is L3 wherever it appears', () => {
  assert.equal(level([f('scripts/cleanup.js', 2, 0, ["await db.$executeRaw`DELETE FROM sessions`"])]).level, 'L3');
});

test('dependency bumps and test machinery: L2', () => {
  assert.equal(level([f('package.json', 1, 1), f('package-lock.json', 40, 30)]).level, 'L2');
  assert.equal(level([f('scripts/build.mjs')]).level, 'L2');
});

// WHY (#629): src/hook.ts is the agents' PreToolUse guard (which tool calls an agent may make, the .worklane/** guard
// among them) and the post-edit hook. Held only by a repo's own `engine: src/**`, a review.yaml without that glob let a
// change to it merge below the owner.
test("regression: a change to the agents' tool guard (src/hook.ts) is self-modification, L3, with a review.yaml that lists no src/**", () => {
  assert.ok(!Object.values(cfg.categories ?? {}).flat().some((g) => g.startsWith('src')), 'this review.yaml names no src/ glob');
  const r = level([f('src/hook.ts', 1, 1)]);
  assert.equal(r.level, 'L3', r.reasons.join('; '));
  assert.deepEqual(r.categories[SELF_MODIFICATION], ['src/hook.ts']);
  assert.ok(r.reasons.includes(`${SELF_MODIFICATION}: src/hook.ts`), r.reasons.join('; '));
  assert.equal(selfModificationPart('src/hook.ts'), "the agents' tool guard");
});

// WHY (#655): the guard's deny lists, the read-only agents' tool lists and refusals, and the task file's frozen and
// hidden paths live beside src/hook.ts. Unlocked, a change to any of them widened what the guard allows at L1.
const GUARD_MODULES = [
  'src/held-out-paths.ts', 'src/dashboard-key-paths.ts', 'src/experiments/paths.ts',
  'src/intake/run.ts', 'src/intake/chat.ts', 'src/research.ts', 'src/contract.ts',
];

test("regression: a change to each module the agents' tool guard decides with is self-modification, L3, with a review.yaml that lists no src/**", () => {
  const notL3 = GUARD_MODULES.filter((path) => {
    const r = level([f(path, 1, 1)]);
    return r.level !== 'L3' || r.categories[SELF_MODIFICATION]?.[0] !== path || selfModificationPart(path) !== "the agents' tool guard";
  });
  assert.deepEqual(notL3, [], `not locked as the agents' tool guard: ${notL3.map((p) => `${p} (${level([f(p, 1, 1)]).level})`).join(', ')}`);
});

const repoDir = fileURLToPath(new URL('../../', import.meta.url));
const ownName = (JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf8')) as { name: string }).name;

/**
 * A source file's relative imports as repo paths (`./x.js` from src/hook.ts is `src/x.ts`, `../x.js` from src/a/b.ts is
 * `src/x.ts`), and any it can't name: a path that isn't a literal, a require made by createRequire, or a specifier that
 * resolves inside the package by another route (a `#` import, the package's own name).
 */
function relativeImports(text: string, from = 'src/hook.ts'): { modules: string[]; unnamed: string[] } {
  // TypeScript's own import scan: both quotes, side-effect imports, re-exports, import(), require, import x = require.
  const specs = ts.preProcessFile(text, true, true).importedFiles.map((f) => f.fileName);
  const unnamed: string[] = [];
  const file = ts.createSourceFile(from, text, ts.ScriptTarget.Latest, true);
  const literal = (n: ts.Node | undefined) => !!n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));
  const visit = (n: ts.Node): void => {
    // `export * as ns from` is the one static form the scan above leaves out.
    if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) specs.push(n.moduleSpecifier.text);
    if (ts.isIdentifier(n) && n.text === 'createRequire') unnamed.push('createRequire');
    if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require')) && !literal(n.arguments[0])) unnamed.push(n.getText(file));
    ts.forEachChild(n, visit);
  };
  visit(file);
  for (const s of specs) if (s.startsWith('#') || s === ownName || s.startsWith(`${ownName}/`)) unnamed.push(s);
  const modules = specs.filter((n) => n.startsWith('.')).map((n) => posix.join(posix.dirname(from), n).replace(/\.js$/, '.ts'));
  return { modules: [...new Set(modules)].sort(), unnamed: [...new Set(unnamed)] };
}

/** Every module the entries reach, directly or through other imports (themselves included), and what can't be followed. */
function importTree(...entries: string[]): { modules: string[]; problems: string[] } {
  const seen = new Set<string>();
  const problems: string[] = [];
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let text: string;
    try {
      text = readFileSync(join(repoDir, file), 'utf8');
    } catch {
      problems.push(`${file}: imported, but there is no such source file to read`);
      continue;
    }
    const r = relativeImports(text, file);
    problems.push(...r.unnamed.map((u) => `${file}: ${u}`));
    queue.push(...r.modules);
  }
  return { modules: [...seen].sort(), problems };
}

test('the import reader sees every import form, and reports one it cannot name', () => {
  const sample = [
    "import { a } from './a.js';", 'import { b } from "./b.js";', "import './c.js';", "export { d } from './d.js';",
    "export * from './e.js';", "import type { F } from './f.js';", "const g = await import('./g.js');",
    'const h = await import(`./h.js`);', "const i = require('./i.js');", "import k = require('./k.js');",
    "export * as l from './l.js';", "import { m } from './sub/m.js';", "import { x } from 'node:fs';",
  ].join('\n');
  assert.deepEqual(relativeImports(sample), { modules: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'k', 'l', 'sub/m'].map((m) => `src/${m}.ts`), unnamed: [] });
  assert.deepEqual(relativeImports("import { y } from '../y.js';", 'src/a/b.ts').modules, ['src/y.ts'], 'resolved from the importing file');
  assert.deepEqual(relativeImports("const m = await import('./' + name);").unnamed, ["import('./' + name)"]);
  assert.deepEqual(relativeImports('const m = await import(`./${name}.js`);').unnamed, ['import(`./${name}.js`)']);
  assert.deepEqual(relativeImports("const r = require(name);").unnamed, ['require(name)']);
  assert.deepEqual(relativeImports("const load = createRequire(import.meta.url); load('./z.js');").unnamed, ['createRequire']);
  assert.deepEqual(relativeImports(`import { s } from '#self';\nimport { t } from '${ownName}/dist/src/t.js';`).unnamed, ['#self', `${ownName}/dist/src/t.js`]);
});

// WHY (#665): locking only what src/hook.ts imports itself left 52 of the 77 modules it reaches unlocked, among them
// the guardrail rules' loader (src/config/load.ts, schema.ts), the chat reply's secret check (src/events/redact.ts) and
// the live environment the guardrails key on (src/adapters/railway.ts): each could change what the guard allows at L1.
/** The guard's code (src/hook.ts) and its process entry (src/hook-main.ts, what the installed hook commands run). */
const GUARD_ENTRIES = ['src/hook.ts', 'src/hook-main.ts'];

test("regression: every module in the agents' tool guard's import tree is self-modification, L3, with a review.yaml that lists no src/**", () => {
  const { modules, problems } = importTree(...GUARD_ENTRIES);
  assert.deepEqual(problems, [], 'the guard loads a module this test cannot follow: import it by a literal relative path');
  assert.ok(modules.length > 50, `read the tree: ${modules.length} modules`);
  const notL3 = modules.filter((path) => {
    const r = level([f(path, 1, 1)]);
    return r.level !== 'L3' || !r.categories[SELF_MODIFICATION]?.includes(path);
  });
  assert.deepEqual(notL3, [], `${notL3.length} of the ${modules.length} modules the guard reaches are not locked`);
});

// No module the guard reaches is left unlocked: in the engine's repo `engine: src/**` holds them all at L3 already, so
// the lock costs nothing there, and outside it (a managed app's repo) the engine's source globs don't apply at all.
test("the guard's own list (src/hook-imports.ts) is exactly the tree's modules no other glob locks: none missing, none stale", () => {
  const { modules } = importTree(...GUARD_ENTRIES);
  const guard = SELF_MODIFICATION_PARTS.find((p) => p.what === "the agents' tool guard")!;
  const listed = guard.globs.filter((g) => !g.includes('*'));
  const others = SELF_MODIFICATION_PARTS.flatMap((p) => p.globs).filter((g) => !listed.includes(g)).map((g) => globToRegExp(g));
  const want = modules.filter((m) => !others.some((re) => re.test(m)));
  assert.deepEqual([...listed].sort(), want, `src/hook-imports.ts must list exactly these, from the real imports:\n${want.map((m) => `  '${m}',`).join('\n')}`);
});

// WHY (#665 review): the hooks ran `node <engine>/dist/src/cli.js hook <event>`, so the guard's process was the whole
// CLI: src/cli.ts set its exit code, and some 400 modules, most outside the locked tree, loaded with it. The hook
// commands now run the guard's own entry, and what writes those commands is locked too.
test("regression: every hook command install writes runs the guard's own entry (src/hook-main.ts), never the CLI; its writers are locked", () => {
  for (const event of ['pre-tool-use', 'session-start', 'session-end', 'post-tool-use']) {
    const cmd = hookCommand('/opt/engine/current/dist/src/cli.js', event);
    assert.ok(cmd.startsWith('E="/opt/engine/current/dist/src/hook-main.js"; '), cmd);
    assert.ok(cmd.includes(` node "$E" ${event} ||`), cmd);
    assert.doesNotMatch(cmd, /cli\.js|"\$E" hook /, cmd);
  }
  assert.equal(hookEntry('$CLAUDE_PROJECT_DIR/node_modules/x/dist/src/cli.js'), '$CLAUDE_PROJECT_DIR/node_modules/x/dist/src/hook-main.js');
  assert.equal(hookEntry('C:\\e\\dist\\src\\cli.js'), 'C:\\e\\dist\\src\\hook-main.js');
  assert.throws(() => hookCommand('/usr/local/bin/engine', 'pre-tool-use'), /must be the engine's dist\/src\/cli\.js/);
  assert.ok(existsSync(join(repoDir, 'src', 'hook-main.ts')));
  assert.equal(selfModificationPart('src/hook-main.ts'), "the agents' tool guard");
  for (const path of ['src/install.ts', 'src/instance.ts']) {
    const r = level([f(path, 1, 1)]);
    assert.equal(r.level, 'L3', path);
    assert.equal(selfModificationPart(path), "the agents' tool guard's hook commands", path);
  }
  // No engine source writes a hook command that runs the CLI's `hook` (src/cli.ts keeps it for older installs).
  const viaCli = readdirSync(join(repoDir, 'src'), { recursive: true, encoding: 'utf8' })
    .filter((p) => p.endsWith('.ts') && p !== 'cli.ts')
    .filter((p) => /cli\.js[^\n]*\bhook (pre-tool-use|session-start|session-end|post-tool-use)\b|"\$E" hook /.test(readFileSync(join(repoDir, 'src', p), 'utf8')));
  assert.deepEqual(viaCli, []);
});

// WHY (#665): the locked globs matched by path in every managed repo, so an app's own src/contract.ts, src/hooks.ts or
// src/hook-form.ts waited for the owner as "the agents' tool guard". Only root's word makes a repo a managed app.
test("regression: where root says the repo is a managed app, the app's own src/contract.ts, src/hooks.ts and the like aren't the engine's controls; the engine's scope keeps every lock", () => {
  const app = (path: string) => level([f(path, 1, 1)], { scope: 'managed-app' });
  const appCode = ['src/contract.ts', 'src/hooks.ts', 'src/hook-form.ts', 'src/research.ts', 'src/intake/run.ts', 'src/config/load.ts', 'src/review.ts', 'src/coordinator/x.ts', 'scripts/setup/deploy.sh', 'test/review.test.ts', 'docs/design.md'];
  const locked = appCode.filter((p) => app(p).categories[SELF_MODIFICATION] || selfModificationPart(p, 'managed-app'));
  assert.deepEqual(locked, [], "a managed app's own files, labelled as the engine's controls");
  assert.equal(app('src/contract.ts').level, 'L1', app('src/contract.ts').reasons.join('; '));
  // What changes the harness's rules for the app's own repo still waits for the owner there.
  for (const path of [`${BRAND.configDir}/review.yaml`, `${BRAND.configDir}/guardrails.yaml`, `${BRAND.configDir}/experiments.yaml`, '.github/workflows/ci.yml', '.githooks/pre-push', '.gitleaks.toml']) {
    const r = app(path);
    assert.equal(r.level, 'L3', path);
    assert.deepEqual(r.categories[SELF_MODIFICATION], [path], path);
  }
  for (const path of ['AGENTS.md', `${BRAND.configDir}/roles/worker.md`]) assert.deepEqual(app(path).categories[AGENT_INSTRUCTIONS], [path], path);
  // The engine's scope, said or left out: every lock, as before.
  for (const scope of [undefined, 'engine'] as const) {
    for (const path of ['src/contract.ts', 'src/hooks.ts', 'src/hook-form.ts', 'src/config/load.ts']) {
      const r = level([f(path, 1, 1)], { scope });
      assert.equal(r.level, 'L3', `${path} (${scope ?? 'no scope'})`);
      assert.equal(selfModificationPart(path, scope), "the agents' tool guard", path);
    }
  }
});

test('the globs that hold in every repo are exactly the config folder, CI, push gate and secret-scan ones; every other lock names the engine\'s own source', () => {
  const everyRepo = LOCKED_CATEGORIES[SELF_MODIFICATION]!.filter((g) => !review.engineSourceGlob(g));
  assert.deepEqual(everyRepo, [
    `${BRAND.configDir}/review.yaml`, `${BRAND.configDir}/guardrails.yaml`, '.github/workflows/**', '.github/release-signers',
    '.denylist*', '.gitleaks*', '.githooks/**', `${BRAND.configDir}/experiments.yaml`,
  ]);
  assert.deepEqual(review.lockedCategories('managed-app')[SELF_MODIFICATION], everyRepo);
  assert.deepEqual(review.lockedCategories('managed-app')[AGENT_INSTRUCTIONS], LOCKED_CATEGORIES[AGENT_INSTRUCTIONS], "the agents' instructions are every repo's");
  for (const scope of [undefined, 'engine'] as const) assert.equal(review.lockedCategories(scope), LOCKED_CATEGORIES);
});

// The managed-app scope can come only from root's file (src/managed-apps.ts): no other module may name it, so no
// caller can hand computeLevel a scope that root didn't give (#665). Tests may.
test("only root's file reader and the review levels name the managed-app scope", () => {
  const src = join(repoDir, 'src');
  const files = (readdirSync(src, { recursive: true }) as string[]).filter((p) => /\.(ts|js|mjs|cjs)$/.test(p)).map((p) => `src/${p.split(sep).join('/')}`);
  assert.ok(files.length > 100, `${files.length} files`);
  const naming = files.filter((p) => /(['"`])managed-app\1/.test(readFileSync(join(repoDir, p), 'utf8')));
  assert.deepEqual(naming.sort(), ['src/managed-apps.ts', 'src/review.ts']);
});

test('a failed or low-confidence verdict bumps one level; an agent can raise but not lower', () => {
  const ok = { patch_correct: true, test_correct: true, confidence: 'high' as const };
  assert.equal(level([f('web/a.jsx')], { verdict: ok }).level, 'L1');
  assert.equal(level([f('web/a.jsx')], { verdict: { ...ok, confidence: 'low' } }).level, 'L2');
  assert.equal(level([f('web/a.jsx')], { verdict: { ...ok, patch_correct: false } }).level, 'L2');
  assert.equal(level([f('server/escrow/a.js')], { verdict: { ...ok, patch_correct: false } }).level, 'L3', 'capped at L3');
  assert.equal(level([f('web/a.jsx')], { requested: 'L3' }).level, 'L3');
  assert.equal(level([f('server/escrow/a.js')], { requested: 'L0' }).level, 'L3', 'cannot lower');
});

test('money paths load from the project source of truth (regex literals in a JS list)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-'));
  writeFileSync(join(dir, 'plan.js'), "const OTHER = [/^nope\\//];\nconst MONEY = [\n  /^server\\/(ledger|sweep)\\//,\n  /^shared\\//,\n];\n");
  const res = loadMoneyPaths(dir, { file: 'plan.js', pattern: 'const MONEY = \\[([\\s\\S]*?)\\];' });
  assert.equal(res.length, 2);
  assert.ok(res[0]!.test('server/sweep/x.js') && !res[0]!.test('server/games/x.js'));
  assert.ok(!res.some((r) => r.test('nope/x')), 'only the MONEY list');
});

test('review.yaml categories: a site can send all docs to the evaluator and name its own pages for a human', () => {
  const site = ReviewConfig.parse({
    version: 1,
    categories: { 'privacy-terms': ['privacy/**', 'terms/**'], 'pilot-form': ['pilot/**', 'assets/pilot.js'] },
    levels: {
      L0_auto: { when: [], max_lines: 200 },
      L1_evaluator: { when: ['docs', 'app-non-money'], max_lines: 400, max_files: 10 },
      L2_notify: { when: ['dependency'] },
      L3_human: { when: ['privacy-terms', 'pilot-form', 'harness-config'], over_lines: 800 },
    },
  });
  const lvl = (...paths: string[]) => computeLevel({ files: paths.map((p) => f(p)), labels: [], moneyPaths: [], scope: undefined }, site);
  const docs = lvl('docs-src/quickstart.md');
  assert.equal(docs.level, 'L1', 'a one-line docs change still gets the evaluator');
  assert.ok(docs.reasons.includes('docs: docs-src/quickstart.md'), docs.reasons.join('; '));
  assert.equal(lvl('test/a.test.js').level, 'L0', 'only the categories listed for L1 are raised');
  const privacy = lvl('privacy/index.html');
  assert.equal(privacy.level, 'L3');
  assert.ok(privacy.reasons.includes('privacy-terms: privacy/index.html'));
  // assets/** is a built-in docs path; a configured category still catches the form's script.
  assert.equal(lvl('assets/pilot.js').level, 'L3');
  // The template's defaults are unchanged without categories.
  assert.equal(level([f('docs/a.md')]).level, 'L0');
});
