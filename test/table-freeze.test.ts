// #941: the test tables stay code (read by the weakening hold's line reader), and the test loader freezes each one
// right after its declaration (test/table-freeze.ts, registered by test/isolate.ts in every test process the suite
// starts). This file registers tables of its own, so the hook's work is checked where it happens: under the preload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frozenSet } from '../src/check-tables.js';
import { DEEP_FROZEN_GLOBAL, FREEZE_GLOBAL, freezeTestTable } from './isolate.js';
import * as me from './table-freeze.test.js';
import { withFreezes } from './table-freeze.js';

/** A probe: rules, as a test table holds them. */
// check-table: never-shrink
export const PROBE_RULES = ['a', 'b', ['nested']];

/** A probe: a set, as a test table holds one (a frozenSet: a Set can't be frozen). */
// check-table: never-shrink
const PROBE_WORDS = frozenSet(['w']);

// R1184l's shape: this module's own later top-level code tries to empty its table, through its own namespace. The
// table was frozen when its statement ended, so the write throws here, at load.
let selfWrite: unknown = null;
try {
  (me.PROBE_RULES as unknown[]).length = 1;
} catch (e) {
  selfWrite = e;
}

test('a test table is frozen right after its declaration: a write throws, from another place or from its own module (#941)', () => {
  assert.ok(Object.isFrozen(PROBE_RULES), 'run under the preload (--import ./dist/test/isolate.js): the hook froze it');
  assert.ok(selfWrite instanceof TypeError, 'its own module emptying it at top level, after it, through its namespace');
  assert.deepEqual(PROBE_RULES, ['a', 'b', ['nested']]);
  assert.throws(() => PROBE_RULES.push('c'), TypeError);
  assert.throws(() => ((PROBE_RULES[2] as string[]).length = 0), TypeError);
  assert.equal((PROBE_WORDS as unknown as { add?: unknown }).add, undefined);
  assert.throws(() => Set.prototype.clear.call(PROBE_WORDS as unknown as Set<string>), TypeError);
  assert.throws(() => Set.prototype.delete.call(PROBE_WORDS as unknown as Set<string>, 'w'), TypeError);
  assert.deepEqual([...PROBE_WORDS], ['w']);
});

test("the loader freezes after each top-level statement that declares a registered table, and never inside a fixture's text (#941)", () => {
  const src = "// check-table: never-shrink\nconst RULES = ['a'];\nconst DOC = `\n// check-table: never-grow\nconst ALLOWED = [];\n`;\nRULES.length = 0;\n";
  const out = withFreezes(src, 'file:///x/dist/test/a.test.js')!;
  assert.equal(out.split('\n').length, src.split('\n').length, 'no line moves');
  assert.ok(out.split('\n')[1]!.includes('(RULES, '), `frozen on its own line: ${out}`);
  assert.ok(!out.includes('(ALLOWED, ') && out.includes('const ALLOWED = [];\n`'), 'the fixture text is unchanged');
  assert.equal(withFreezes("const RULES = ['a'];\n", 'file:///x.js'), null, 'no mark, no change');
  // Run: the table is frozen before the line after it, so that line's write throws.
  const frozen: unknown[] = [];
  // Strict, as a module is (a sloppy write to a frozen object is ignored, not refused).
  const run = new Function('freeze', '"use strict";\n' + out.replace(/__worklaneTestFreezeTable/g, 'freeze'));
  assert.throws(() => run((v: unknown) => (frozen.push(v), Object.freeze(v))), TypeError);
  assert.deepEqual(frozen, [['a']]);
});

test('freezeTestTable refuses a Set or a Map anywhere in a table, leaves a RegExp and a Buffer, and freezes the rest (#941)', () => {
  assert.throws(() => freezeTestTable(new Set(['a'])), /can't be one/);
  assert.throws(() => freezeTestTable({ inner: new Map() }), /a Map/);
  const t = { re: /x/g, buf: Buffer.from('ab'), list: [1], deep: { k: [2] } };
  freezeTestTable(t);
  assert.ok(!Object.isFrozen(t.re) && t.re.test('x'), 'the RegExp still works');
  assert.throws(() => t.list.push(3), TypeError);
  assert.throws(() => t.deep.k.push(3), TypeError);
});

/** The preload's deep frozen-check, read from its non-writable global (R1184al D1: never through a helper's global). */
const deepFrozen = (globalThis as unknown as Record<string, (v: unknown) => boolean>)[DEEP_FROZEN_GLOBAL]!;

test("every table a test helper registers is deep-frozen, read with the preload's own built-ins (#941, R1184al D1)", async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { registrationsOf } = await import('../src/merge-policy-weakening.js');
  const { repoRoot } = await import('./helpers.js');
  assert.equal(typeof deepFrozen, 'function', 'the preload set its check');
  const desc = Object.getOwnPropertyDescriptor(globalThis, FREEZE_GLOBAL)!;
  assert.deepEqual([desc.writable, desc.configurable], [false, false], 'the freeze global is neither writable nor configurable');
  for (const m of ['raw-check-reads', 'token-standins', 'host-tools']) {
    const names = registrationsOf(readFileSync(join(repoRoot, 'test', `${m}.ts`), 'utf8')).tables.map((t) => t.table);
    assert.ok(names.length > 0, `${m} registers tables`);
    // As imported, and as a second copy by a query or a hash (R1184aq D1): each is frozen, read here with the preload's
    // own check.
    for (const spec of [`./${m}.js`, `./${m}.js?lock`, `./${m}.js#lock`]) {
      const mod = (await import(spec)) as Record<string, unknown>;
      for (const n of names.filter((x) => x in mod)) assert.ok(deepFrozen(mod[n]), `${spec} ${n} deep-frozen`);
    }
  }
});

test("the hook freezes a copy loaded by a query or a hash, right after its declaration, in a table module with no self-freeze (#941, R1184aq D1, R1184ar D3)", async () => {
  const { rmSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { randomBytes } = await import('node:crypto');
  const { repoRoot } = await import('./helpers.js');
  // Under dist/test, so the hook treats it as a test module; no self-freeze line, so only the hook can freeze it. Its own
  // later top-level code writes the table (R1184l's shape), so the freeze must come right after the declaration.
  const name = `zz-ar-${randomBytes(4).toString('hex')}.js`;
  const file = join(repoRoot, 'dist', 'test', name);
  try {
    writeFileSync(file, "// check-table: never-grow\nexport const FIXTURE_ALLOWED = ['a'];\nexport let later = 'no';\ntry { FIXTURE_ALLOWED.push('b'); later = 'grew'; } catch { later = 'refused'; }\n");
    for (const spec of [`./${name}?fresh`, `./${name}#fresh`]) {
      const m = (await import(spec)) as { FIXTURE_ALLOWED: string[]; later: string };
      assert.deepEqual([m.later, deepFrozen(m.FIXTURE_ALLOWED), m.FIXTURE_ALLOWED], ['refused', true, ['a']], spec);
    }
  } finally {
    rmSync(file, { force: true });
  }
});

test('a helper imported before a table module can neither replace the freeze, undo it, nor blind the check, through any built-in the walk or the call uses (#941, R1184al D1, R1184ao D1)', async () => {
  const { spawnSync } = await import('node:child_process');
  const { rmSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { randomBytes } = await import('node:crypto');
  const { pathToFileURL } = await import('node:url');
  const { repoRoot } = await import('./helpers.js');
  // Each helper runs before test/raw-check-reads.js loads, as one imported first would.
  const helpers: [string, string, string?, ('import' | 'require')?][] = [
    ['control', ''],
    ['control, by a first-load require()', '', './raw-check-reads.js', 'require'],
    ['AL2a the freeze global replaced', "try { globalThis.__worklaneTestFreezeTable = () => {}; } catch {}\ntry { Object.defineProperty(globalThis, '__worklaneTestFreezeTable', { value: () => {} }); } catch {}\n"],
    ['AL2f Object.freeze replaced', 'Object.freeze = (x) => x;\n'],
    ['AO1 RegExp[Symbol.hasInstance] answers true for a table', "Object.defineProperty(RegExp, Symbol.hasInstance, { value: (x) => typeof x === 'object' && x !== null && !Array.isArray(x) });\n"],
    ['AO2 the Array iterator yields nothing for a table\'s key list', "const real = Array.prototype[Symbol.iterator];\nArray.prototype[Symbol.iterator] = function () { return this.length === 1 && this[0] === 'PinnedChecks' ? [][Symbol.iterator]() : real.call(this); };\n"],
    ['AO3 Symbol.for answers another symbol', "const realFor = Symbol.for;\nconst other = Symbol('x');\nglobalThis[other] = () => {};\nSymbol.for = (k) => (k.startsWith('worklane.test') ? other : realFor(k));\n"],
    ['globalThis redefined', "try { Object.defineProperty(globalThis, 'globalThis', { value: { __worklaneTestFreezeTable: () => {}, __worklaneTestDeepFrozen: () => true } }); } catch {}\n"],
    // R1184aq D1: another module hook that loads the table module itself, or takes the freeze calls out; and a second
    // copy of the module, loaded by a query or a hash.
    ['AQ1a register(), short-circuit', "import { register } from 'node:module';\nregister('data:text/javascript,' + encodeURIComponent(\"import { readFileSync } from 'node:fs'; export async function load(url, context, next) { if (url.includes('/raw-check-reads.js')) return { format: 'module', source: readFileSync(new URL(url), 'utf8'), shortCircuit: true }; return next(url, context); }\"));\n"],
    ['AQ1b registerHooks, short-circuit', "import { registerHooks } from 'node:module';\nimport { readFileSync } from 'node:fs';\nregisterHooks({ load(url, context, next) { if (url.includes('/raw-check-reads.js')) return { format: 'module', source: readFileSync(new URL(url), 'utf8'), shortCircuit: true }; return next(url, context); } });\n"],
    ['AQ1c registerHooks, the freeze calls taken out', "import { registerHooks } from 'node:module';\nregisterHooks({ load(url, context, next) { const r = next(url, context); return url.includes('/raw-check-reads.js') ? { ...r, source: String(r.source).replace(/__worklaneTestFreezeTable\\(/g, 'void (') } : r; } });\n"],
    ['AQ2a a query string', '', './raw-check-reads.js?fresh'],
    ['AQ2b a hash', '', './raw-check-reads.js#fresh'],
    // R1184as D1: the CommonJS compile step handed the module's text with the freeze calls taken out, by a patched
    // _compile or _extensions['.js'], or by a direct call of the real _compile.
    ['AS1a _compile patched, then require()', "import M from 'node:module';\nconst orig = M.prototype._compile;\nM.prototype._compile = function (c, f, ...r) { return orig.call(this, String(c).replace(/__worklaneTestFreezeTable\\(/g, 'void ('), f, ...r); };\n", './raw-check-reads.js', 'require'],
    ['AS1b _extensions[.js] patched, then require()', "import M from 'node:module';\nconst orig = M._extensions['.js'];\nM._extensions['.js'] = function (m, f) { const c0 = m._compile; m._compile = function (c, ff, ...r) { return c0.call(this, String(c).replace(/__worklaneTestFreezeTable\\(/g, 'void ('), ff, ...r); }; return orig.call(this, m, f); };\n", './raw-check-reads.js', 'require'],
    ['AR1a _extensions[.js] replaced, handing _compile stripped text, then require()', "import M from 'node:module';\nimport { readFileSync } from 'node:fs';\nM._extensions['.js'] = function (mod, f) { const c = readFileSync(f, 'utf8'); return mod._compile(String(c).replace(/__worklaneTestFreezeTable\\(/g, 'void ('), f, 'module'); };\n", './raw-check-reads.js', 'require'],
    ['AS1c _compile patched, then import()', "import M from 'node:module';\nimport { createRequire } from 'node:module';\nconst orig = M.prototype._compile;\nM.prototype._compile = function (c, f, ...r) { return orig.call(this, String(c).replace(/__worklaneTestFreezeTable\\(/g, 'void ('), f, ...r); };\ncreateRequire(import.meta.url)('./raw-check-reads.js');\n"],
    ['AS1d the real _compile called with stripped text, then import()', "import M from 'node:module';\nimport { readFileSync } from 'node:fs';\nimport { fileURLToPath } from 'node:url';\nconst f = fileURLToPath(new URL('./raw-check-reads.js', import.meta.url));\nconst m = new M(f);\nm.filename = f;\nm.paths = [];\nconst c = readFileSync(f, 'utf8');\nm._compile(String(c).replace(/__worklaneTestFreezeTable\\(/g, 'void ('), f, 'module');\n"],
    ['AS1e the same, then require()', "import M from 'node:module';\nimport { readFileSync } from 'node:fs';\nimport { fileURLToPath } from 'node:url';\nconst f = fileURLToPath(new URL('./raw-check-reads.js', import.meta.url));\nconst m = new M(f);\nm.filename = f;\nm.paths = [];\nconst c = readFileSync(f, 'utf8');\nm._compile(String(c).replace(/__worklaneTestFreezeTable\\(/g, 'void ('), f, 'module');\n", './raw-check-reads.js', 'require'],
  ];
  // Under dist/test, so the loader's hook treats them as test modules; removed after.
  const dir = join(repoRoot, 'dist', 'test');
  for (const [label, body, spec = './raw-check-reads.js', how = 'import'] of helpers) {
    const tag = randomBytes(4).toString('hex');
    const [helper, main] = [join(dir, `zz-ao-helper-${tag}.js`), join(dir, `zz-ao-main-${tag}.js`)];
    try {
      writeFileSync(helper, `${body}export {};\n`);
      writeFileSync(main, `import './zz-ao-helper-${tag}.js';\nimport { createRequire } from 'node:module';\nconst { MAKERS_ALLOWED, RAW_READS_ALLOWED } = ${how === 'require' ? `createRequire(import.meta.url)(${JSON.stringify(spec)})` : `await import(${JSON.stringify(spec)})`};\nconst check = __worklaneTestDeepFrozen;\nconst refused = (f) => { try { f(); return 'grew'; } catch { return 'refused'; } };\nconst inner = Object.values(MAKERS_ALLOWED)[0];\nconsole.log(JSON.stringify({ frozen: [check(RAW_READS_ALLOWED), check(MAKERS_ALLOWED)], writes: [refused(() => { RAW_READS_ALLOWED['src/x.ts'] = 'x'; }), refused(() => { inner.push('x'); })] }));\n`);
      const r = spawnSync(process.execPath, ['--import', pathToFileURL(join(dir, 'isolate.js')).href, main], { encoding: 'utf8', env: process.env, timeout: 60_000 });
      // Either the helper's hook registration is refused (the process stops there), or the tables are frozen.
      if (/^AQ1/.test(label)) {
        assert.notEqual(r.status, 0, `${label}: the hook was registered: ${r.stdout}`);
        assert.match(r.stderr, /module\.register(Hooks)? after the test preload/, label);
        continue;
      }
      // The compile step: a patch of it throws (it is read-only), and a compile from other text is refused.
      if (/^A[SR]1/.test(label)) {
        assert.notEqual(r.status, 0, `${label}: the module compiled: ${r.stdout}`);
        assert.match(r.stderr, /compiled from a source other than its file's|read[- ]only|Cannot assign/, label);
        continue;
      }
      assert.equal(r.status, 0, `${label}: ${r.stderr}`);
      const out = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as unknown;
      assert.deepEqual(out, { frozen: [true, true], writes: ['refused', 'refused'] }, label);
    } finally {
      rmSync(helper, { force: true });
      rmSync(main, { force: true });
    }
  }
});

test("a test helper that registers tables freezes each one itself at its end, so require(), a worker or a process without the preload can't load it unfrozen (#941, R1184ap)", async () => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const { readFileSync, rmSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { randomBytes } = await import('node:crypto');
  const { pathToFileURL } = await import('node:url');
  const { registrationsOf } = await import('../src/merge-policy-weakening.js');
  const { repoRoot } = await import('./helpers.js');
  // Each module under test/ that registers a table and isn't a test file (other tests import it) calls the freeze by its
  // bare name for each table, at top level. A test file's own tables guard its own run, under the preload.
  const files = execFileSync('git', ['grep', '-l', '// check-table: ', '--', 'test'], { cwd: repoRoot, encoding: 'utf8' }).trim().split('\n');
  // Modules only (a fixture's data may hold the mark's text), and each with a table its marks register.
  const helpers = files.filter((f) => /\.ts$/.test(f) && !/\.(test|d)\.ts$/.test(f) && f !== 'test/isolate.ts' && registrationsOf(readFileSync(join(repoRoot, f), 'utf8')).tables.length > 0);
  assert.ok(helpers.length >= 3, `the helpers found: ${helpers.join(', ')}`);
  for (const f of helpers) {
    const text = readFileSync(join(repoRoot, f), 'utf8');
    for (const { table } of registrationsOf(text).tables) assert.ok(text.split('\n').some((l) => l.startsWith(`__worklaneTestFreezeTable(${table}, `)), `${f}: ${table} freezes itself`);
  }
  // Every helper the lock finds, each in a fresh child so it is a first load: by require() under the preload, every
  // table it registers deep-frozen; and without the preload, not loadable (R1184as D2: a self-freeze left in a comment
  // or under an `if` passed the text check above).
  const dist = join(repoRoot, 'dist', 'test');
  for (const f of helpers) {
    const js = join(dist, f.replace(/^test\//, '').replace(/\.ts$/, '.js'));
    const names = registrationsOf(readFileSync(join(repoRoot, f), 'utf8')).tables.map((x) => x.table);
    const probe = join(dist, `zz-as-${randomBytes(4).toString('hex')}.js`);
    try {
      writeFileSync(probe, `import { createRequire } from 'node:module';\nconst m = createRequire(import.meta.url)(${JSON.stringify(js)});\nconsole.log(JSON.stringify(${JSON.stringify(names)}.map((n) => [n, n in m && __worklaneTestDeepFrozen(m[n])])));\n`);
      const r = spawnSync(process.execPath, ['--import', pathToFileURL(join(dist, 'isolate.js')).href, probe], { encoding: 'utf8', env: process.env, timeout: 60_000 });
      assert.equal(r.status, 0, `${f}: ${r.stderr}`);
      assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').at(-1)!), names.map((n) => [n, true]), `${f}: every table frozen on a first-load require()`);
    } finally {
      rmSync(probe, { force: true });
    }
    const bareLoad = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(js).href)});`], { encoding: 'utf8', timeout: 60_000 });
    assert.notEqual(bareLoad.status, 0, `${f}: loaded without the preload`);
    assert.match(bareLoad.stderr, /__worklaneTestFreezeTable is not defined/, f);
  }
  // A test file that registers a table is imported by no other file: its tables guard its own run, which CI starts
  // under the preload, and they don't freeze themselves (R1184ar: an imported one would be R1184ap's case).
  const testTables = files.filter((f) => /\.test\.ts$/.test(f) && registrationsOf(readFileSync(join(repoRoot, f), 'utf8')).tables.length > 0);
  for (const f of testTables) {
    const base = f.replace(/^.*\//, '').replace(/\.ts$/, '');
    // git grep exits 1 when nothing matches: no file names it.
    let named = '';
    try {
      named = execFileSync('git', ['grep', '-lE', `['"/]${base.replace(/\./g, '\\.')}(\\.js)?['"?#]`, '--', 'test', 'src', 'scripts'], { cwd: repoRoot, encoding: 'utf8' });
    } catch (e) {
      if ((e as { status?: number }).status !== 1) throw e;
    }
    const importers = named.split('\n').filter((x) => x && x !== f);
    // A test file may name another in its text (a fixture, a comment); an import or require of one is what counts.
    const imports = importers.filter((x) => new RegExp(`(?:import\\s*\\(|from|require\\s*\\()\\s*['"][^'"]*/${base.replace(/\./g, '\\.')}\\.js`).test(readFileSync(join(repoRoot, x), 'utf8')));
    assert.deepEqual(imports, [], `${f}: a test file with tables, imported by another file`);
  }
  // Loaded each way the loader's hook may not see.
  const dir = join(repoRoot, 'dist', 'test');
  const main = join(dir, `zz-ap-main-${randomBytes(4).toString('hex')}.js`);
  try {
    writeFileSync(main, `import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
const write = (m) => { try { m.RAW_READS_ALLOWED['src/x.ts'] = 'x'; return 'grew'; } catch { return 'refused'; } };
const r = createRequire(import.meta.url)('./raw-check-reads.js');
const viaRequire = { frozen: __worklaneTestDeepFrozen(r.RAW_READS_ALLOWED), write: write(r) };
const viaWorker = await new Promise((res, rej) => { const w = new Worker("import { parentPort } from 'node:worker_threads'; const m = await import(" + JSON.stringify(new URL('./raw-check-reads.js?worker', import.meta.url).href) + "); let wr = 'grew'; try { m.RAW_READS_ALLOWED['src/x.ts'] = 'x'; } catch { wr = 'refused'; } parentPort.postMessage({ frozen: Object.isFrozen(m.RAW_READS_ALLOWED), write: wr });", { eval: true, type: 'module' }); w.on('message', res); w.on('error', rej); });
console.log(JSON.stringify({ viaRequire, viaWorker }));
`);
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(join(dir, 'isolate.js')).href, main], { encoding: 'utf8', env: process.env, timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').at(-1)!), { viaRequire: { frozen: true, write: 'refused' }, viaWorker: { frozen: true, write: 'refused' } });
  } finally {
    rmSync(main, { force: true });
  }
  // A process without the preload can't load it at all: the freeze's name is undefined there.
  const bare = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(dir, 'raw-check-reads.js')).href)});`], { encoding: 'utf8', timeout: 60_000 });
  assert.notEqual(bare.status, 0, 'loaded without the preload');
  assert.match(bare.stderr, /__worklaneTestFreezeTable is not defined/);
});
