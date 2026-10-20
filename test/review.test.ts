import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
// check-table: never-shrink
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
// check-table: never-shrink
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

test("the globs that hold in every repo are exactly the config folder's, CI's, the git hooks' and the secret scan's (the push gate's scripts are engine source); every other lock names the engine's own source", () => {
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

/** A string naming root's reader's module as code would load it (relative or not; `.js`, `.mjs`, `.cjs` or none). */
const LOCK_SCOPE_MODULE = /(?:^|[/\\])managed-apps(?:\.[cm]?js)?$/;
/** Whether `s` names that module, read as a module path is: any `?…` or `#…` cut off, and %-escapes decoded. */
const namesLockScopeModule = (s: string): boolean => {
  let path = s.replace(/[?#][\s\S]*$/, '');
  try {
    path = decodeURIComponent(path);
  } catch {
    // A malformed escape: as written.
  }
  return LOCK_SCOPE_MODULE.test(s) || LOCK_SCOPE_MODULE.test(path);
};

/**
 * The lock-scope module's edge, for one source file (`file` its repo path, `text` its source). Empty means clean. It
 * takes source as data, so a fixture test feeds it exactly what the repo walk does (#771), and it parses every file it
 * is given: no pre-filter by text, which an escaped name would get past. Outside the module itself (src/managed-apps.ts):
 * - the module is reached only by a static named import or a named re-export. Never `import * as`, a default or
 *   side-effect import, `export *`, `export * as`, `import()`, `require()` or any other string naming it (escapes
 *   decoded, a query or fragment cut off, %-escapes decoded), so no file holds a namespace object to walk;
 * - no module path has `?`, `#` or `%` in it (src/ uses none), which can name the same module in a form this can't match;
 * - `import()`, `require()`, `<x>.require()` and `createRequire(…)(…)` take a plain string (a template with no `${}`
 *   is one), so the module they load is one this can read;
 * - `require` and `createRequire` (a name, or a property's name) stand only as the direct callee of a call whose first
 *   argument is a plain string. Never parenthesized, after a comma, as `.call`/`.apply`/`.bind`'s object, passed as
 *   an argument, held in a variable, destructured, renamed on import or imported at all, so neither reaches a call
 *   this can't see under its own name (src/ uses neither but as a plain-string call).
 * The call's shape isn't checked: readLockScope takes the instance and its repo and nothing else (#747).
 * Out of its reach: `require`/`createRequire` reached by a computed key (`globalThis['req' + 'uire']`); the function
 * a plain-string `createRequire('…')` returns, held under another name and called with a path built at run time;
 * another loader (`Module._load` and the like); eval and new Function; and code run by path (a child process, or a
 * file loaded by a path this can't read).
 */
export function lockScopeFindings(file: string, text: string): string[] {
  if (file === 'src/managed-apps.ts') return [];
  const kind = /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const out: string[] = [];
  const at = (n: ts.Node, why: string) => out.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${why}: ${n.getText(sf).slice(0, 120)}`);
  // The one place the module's name may stand: the specifier of a static named import or a named re-export.
  const namedOnly = new Set<ts.Node>();
  for (const s of sf.statements) {
    const c = ts.isImportDeclaration(s) ? s.importClause : undefined;
    if (c && !c.name && c.namedBindings && ts.isNamedImports(c.namedBindings)) namedOnly.add((s as ts.ImportDeclaration).moduleSpecifier);
    if (ts.isExportDeclaration(s) && s.moduleSpecifier && s.exportClause && ts.isNamedExports(s.exportClause)) namedOnly.add(s.moduleSpecifier);
  }
  const named = (e: ts.Expression, name: string) => (ts.isIdentifier(e) && e.text === name) || (ts.isPropertyAccessExpression(e) && e.name.text === name);
  /** A call that loads a module: import(…), require(…), <x>.require(…), createRequire(…)(…). */
  const loads = (c: ts.CallExpression) => c.expression.kind === ts.SyntaxKind.ImportKeyword || named(c.expression, 'require') || (ts.isCallExpression(c.expression) && named(c.expression.expression, 'createRequire'));
  const plain = (a: ts.Expression | undefined) => !!a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a));
  /** `require`/`createRequire` as anything but the direct callee of a plain-string call: `n` the name, `ref` what it names. */
  const looseLoader = (n: ts.Identifier): ts.Node | null => {
    const ref = ts.isPropertyAccessExpression(n.parent) && n.parent.name === n ? n.parent : n;
    const call = ref.parent;
    return ts.isCallExpression(call) && call.expression === ref && plain(call.arguments[0]) ? null : ref;
  };
  // Every module path: a static import's or export's, import = require()'s, and a loading call's plain string.
  const paths = new Set<ts.Node>();
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) paths.add(n.moduleSpecifier);
    if (ts.isExternalModuleReference(n)) paths.add(n.expression);
    if (ts.isCallExpression(n) && loads(n)) {
      const a = n.arguments[0];
      if (plain(a)) paths.add(a!);
      else at(n, 'a module loaded by a path that is not a plain string');
    }
    if (ts.isIdentifier(n) && (n.text === 'require' || n.text === 'createRequire')) {
      const loose = looseLoader(n);
      if (loose) at(loose.parent ?? loose, 'require or createRequire other than called directly with a plain string');
    }
    if (ts.isStringLiteralLike(n)) {
      if (paths.has(n) && /[?#%]/.test(n.text)) at(n, 'a module path with ?, # or %');
      if (namesLockScopeModule(n.text) && !namedOnly.has(n)) at(n.parent, 'its module reached other than by a static named import');
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// WHY (#747): the coordinator's lock scope must be root's word alone. readLockScope takes only the instance and its
// repo, but a file holding the module's namespace (or loading it by a path this can't read) is one this lint can't
// follow, so every src/ file but the module's own reaches it only by a static named import.
test("src/ reaches root's reader's module (src/managed-apps.ts) only by a static named import", () => {
  const src = join(repoDir, 'src');
  const files = (readdirSync(src, { recursive: true }) as string[]).filter((p) => /\.([cm]?ts|tsx|[cm]?js)$/.test(p)).map((p) => `src/${p.split(sep).join('/')}`);
  assert.ok(files.length > 100, `${files.length} files`);
  // Every file, through the same function the fixtures below go through.
  assert.deepEqual(files.flatMap((p) => lockScopeFindings(p, readFileSync(join(repoDir, p), 'utf8'))), []);
  // The walk sees the reader's real caller: the coordinator's start-up, which a namespace import there would fail.
  assert.ok(files.includes('src/service.ts'));
  const service = readFileSync(join(repoDir, 'src/service.ts'), 'utf8');
  const widened = service.replace("import { readLockScope } from './managed-apps.js';", "import * as lockScope from './managed-apps.js';");
  assert.notEqual(widened, service, "the coordinator's start-up imports { readLockScope } from './managed-apps.js'");
  assert.match(lockScopeFindings('src/service.ts', widened).join('\n'), /src\/service\.ts:\d+: its module reached other than by a static named import/);
});

const IMPORTED = "import { readLockScope } from './managed-apps.js';\n";
const NAMESPACE = "import * as m from './managed-apps.js';\n";
const MODULE = /its module reached other than by a static named import/;
const MARKS = /a module path with \?, # or %/;
const NOT_PLAIN = /a module loaded by a path that is not a plain string/;
const LOOSE = /require or createRequire other than called directly with a plain string/;
const BUILT = "'./managed-' + 'apps.js'";
/** What the lint must refuse, and why: each a fixture, so none is ever planted in src/ (#771). The file is src/x.ts unless named. */
// check-table: never-shrink
export const LOCK_SCOPE_BAD: [string, string, RegExp, string?][] = [
  // PR #765's round-1 review: the module edge.
  ['the escaped name alone in the file, through a namespace', `${NAMESPACE}m.readLock\\u0053cope(a, b);`, MODULE],
  ['a \\x escape in a string key', `${NAMESPACE}m['readLock\\x53cope'](a, b);`, MODULE],
  ['a concatenated key', `${NAMESPACE}m['readLock' + 'Scope'](a, b);`, MODULE],
  ['a template key', `${NAMESPACE}m[\`readLock\${'Scope'}\`](a, b);`, MODULE],
  ['a key built at run time', `${NAMESPACE}const k = ['readLock', 'Scope'].join('');\nm[k](a, b);`, MODULE],
  ['Object.values on the namespace', `${NAMESPACE}Object.values(m).find((f) => f.length === 2)(a, b);`, MODULE],
  ['import(), a named property', "const m = await import('./managed-apps.js');\nm.readLockScope(a, b);", MODULE],
  ['import(), destructured', "const { readLockScope: r } = await import('./managed-apps.js');\nr(a, b);", MODULE],
  ['import(), a template with no ${}', 'const m = await import(`./managed-apps.js`);', MODULE],
  ['export *', "export * from './managed-apps.js';", MODULE],
  ['export * as', "export * as lockScope from './managed-apps.js';", MODULE],
  ['require(), a named property', "const m = require('./managed-apps.js');\nm.readLockScope(a, b);", MODULE],
  ['require(), destructured', "const { readLockScope } = require('./managed-apps.js');", MODULE],
  ['require() in a .cjs file', "const m = require('./managed-apps.cjs');", MODULE, 'src/x.cjs'],
  ['globalThis.require()', "const m = globalThis.require('./managed-apps.js');", MODULE],
  ['module.require()', "const m = module.require('./managed-apps.js');", MODULE],
  ['createRequire', "const m = createRequire(import.meta.url)('./managed-apps.js');", MODULE],
  ['import = require()', "import m = require('./managed-apps.js');", MODULE],
  ['a default import', "import m from './managed-apps.js';", MODULE],
  ['a side-effect import', "import './managed-apps.js';", MODULE],
  ['import attributes', "import * as m from './managed-apps.js' with { type: 'js' };", MODULE],
  ['a namespace import from a subfolder, its specifier escaped', "import * as m from '../managed\\x2dapps.js';", MODULE],
  ['a variable holding the path', "const p = './managed-apps.js';\nconst m = await import(p);", MODULE],
  ['new URL()', "const u = new URL('./managed-apps.js', import.meta.url);", MODULE],
  // PR #765's round-2 review: plain strings Node loads as the module itself.
  ['a query', "import * as m from './managed-apps.js?x';\nm['readLock' + 'Scope'](a, b);", MARKS],
  ['a fragment', "import * as m from './managed-apps.js#x';\nm['readLock' + 'Scope'](a, b);", MARKS],
  ['a %-escape', "import * as m from './managed%2Dapps.js';\nm['readLock' + 'Scope'](a, b);", MARKS],
  ['import() with a query', "const m = await import('./managed-apps.js?x');", MARKS],
  ['export * as, with a query', "export * as ns from './managed-apps.js?x';", MARKS],
  ['a named import with a query', "import { readLockScope } from './managed-apps.js?x';", MARKS],
  ['a namespace import with a query: also the module, read as a path', "import * as m from './managed-apps.js?x';", MODULE],
  ['a namespace import with a %-escape: also the module, read as a path', "import * as m from './managed%2Dapps.js';", MODULE],
  // PR #765's round-2 review: a path built at run time.
  ['import(), concatenated', "const m = await import('./managed-' + 'apps.js');", NOT_PLAIN],
  ['import(), a template with ${}', "const m = await import(`./managed-${'apps'}.js`);", NOT_PLAIN],
  ['globalThis.require(), concatenated', "const m = globalThis.require('./managed-' + 'apps.js');", NOT_PLAIN],
  ['module.require(), concatenated', "const m = module.require('./managed-' + 'apps.js');", NOT_PLAIN],
  ['require() in a .cjs file, concatenated', "const m = require('./managed-' + 'apps.js');", NOT_PLAIN, 'src/x.cjs'],
  ['createRequire, concatenated', "const m = createRequire(import.meta.url)('./managed-' + 'apps.js');", NOT_PLAIN],
  ['import(), a variable', 'const m = await import(spec);', NOT_PLAIN],
  ['import(), a tagged template', 'const m = await import(String.raw`./managed-apps.js`);', NOT_PLAIN],
  ['require() with no path', 'const m = require();', NOT_PLAIN],
  // PR #765's round-3 review: require reached other than as a plain-string call's callee, with a path built at run time.
  ['(require)()', `const m = (require)(${BUILT});`, LOOSE],
  ['(require)() in a .cjs file', `const m = (require)(${BUILT});`, LOOSE, 'src/x.cjs'],
  ['(0, require)()', `const m = (0, require)(${BUILT});`, LOOSE],
  ['require.call()', `const m = require.call(null, ${BUILT});`, LOOSE],
  ['require.apply()', `const m = require.apply(null, [${BUILT}]);`, LOOSE],
  ['require.bind()', `const m = require.bind(null)(${BUILT});`, LOOSE],
  ['Reflect.apply(require)', `const m = Reflect.apply(require, null, [${BUILT}]);`, LOOSE],
  ['require in a variable', `const r = require;\nconst m = r(${BUILT});`, LOOSE],
  ['require passed as an argument', `const m = load(require, ${BUILT});`, LOOSE],
  ['require in an object', `const o = { r: require };\nconst m = o.r(${BUILT});`, LOOSE],
  ['require destructured off module', `const { require: r } = module;\nconst m = r(${BUILT});`, LOOSE],
  ['module.require.call()', `const m = module.require.call(module, ${BUILT});`, LOOSE],
  ['(module.require)()', `const m = (module.require)(${BUILT});`, LOOSE],
  ["createRequire's function in a variable", `const r = createRequire(import.meta.url);\nconst m = r(${BUILT});`, LOOSE],
  ['createRequire renamed on import', `import { createRequire as cr } from 'node:module';\nconst m = cr(import.meta.url)(${BUILT});`, LOOSE],
  ['createRequire passed as an argument', `const m = load(createRequire, ${BUILT});`, LOOSE],
];
/** What it must let through. */
// check-table: never-grow
export const LOCK_SCOPE_GOOD: [string, string, string?][] = [
  ['the plain import and two-argument calls', `${IMPORTED}readLockScope(i.name, i.repo.repo);\nconst f = () => readLockScope(a, b).scope;`],
  // Once imported, the function takes the instance and its repo and nothing else, so what a file does with it is no matter.
  ['the imported function passed around', `${IMPORTED}const r = readLockScope;\nr.call(null, a, b);\ncall(readLockScope);`],
  ['other names, imported, typed and passed on by name', "import { githubRepoOf } from './managed-apps.js';\nimport type { LockScope } from '../managed-apps.js';\nexport { githubRepoOf } from './managed-apps.js';"],
  ["strings naming the module's neighbours", "const a = 'scripts/setup/managed-apps.sh', b = etcPath('managed-apps.json'), c = 'src/managed-apps.ts';"],
  ['a dynamic import of another module', "const { runBroker } = await import('./mcp/service.js');"],
  ['a dynamic import of another module, a template with no ${}', 'const m = await import(`./plugins/cli.js`);'],
  ['require() of a package', "const { Client } = require('pg');"],
  ['require() in a .cjs file', "const fs = require('node:fs');", 'src/x.cjs'],
  ['an import type', "let e: import('./experiments.js').ExperimentHost;"],
  ["a '?', '#' or '%' in a string that is no module path", "const q = 'which repo? #747, 100%';"],
];

test('the lock-scope module lint, fed fixtures: every reach past a static named import, or by a path it can\'t read, is refused, and those pass', () => {
  for (const [what, code, file] of LOCK_SCOPE_GOOD) assert.deepEqual(lockScopeFindings(file ?? 'src/x.ts', code), [], what);
  // The module itself defines and uses it as it likes.
  assert.deepEqual(lockScopeFindings('src/managed-apps.ts', `${NAMESPACE}export function readLockScope(a, b) {}\nreadLockScope(a, b);`), []);
  for (const [what, code, why, file] of LOCK_SCOPE_BAD) {
    const found = lockScopeFindings(file ?? 'src/x.ts', code);
    assert.match(found.join('\n'), why, `${what}: ${found.join('; ') || 'nothing found'}`);
  }
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
  // Read as committed (#715: at the default branch's ref, never the working tree).
  for (const a of [['init', '-q'], ['add', 'plan.js'], ['-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'list']]) execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  const [self, ...res] = loadMoneyPaths(dir, { file: 'plan.js', pattern: 'const MONEY = \\[([\\s\\S]*?)\\];' }, 'HEAD');
  assert.ok(self!.test('plan.js') && !self!.test('src/plan.js'), 'the list file itself first');
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
