// lint-test
// #846: every child the engine starts gets only its own environment. The protection is by design: src/os/child-process.ts
// is the engine's only way to start a process, and whatever a caller passes as `env` (a plain object, a spread, nothing
// at all), the child gets childEnvOf() of it: a null-prototype copy of the own variables. These tests pollute
// Object.prototype the way a malicious dependency would and look at what the child sees, through every call form.
//
// The lint at the end is a backstop beside it, not the protection: no other module in src/ imports node:child_process
// for a value, so a new spawn can't skip the module unseen. It takes its input as data (#771): its fail-without is the
// fixtures below, never a planted import in src/.
import assert from 'node:assert/strict';
import * as nodeCp from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import ts from 'typescript';
import { pathToFileURL } from 'node:url';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import { childEnvOf, execFile, execFileSync, spawn, spawnSync, startSetupWorker } from '../src/os/child-process.js';
import { ownEnv } from '../src/os/own-env.js';
import { repoRoot } from './helpers.js';

const CANARY = 'WL846_CANARY_NEVER_SET';
const NODE = process.execPath;

/** Runs `f` with `vars` on Object.prototype, as a polluting dependency would set them, and takes them off after. */
async function polluted<T>(vars: Record<string, unknown>, f: () => T | Promise<T>): Promise<T> {
  const proto = Object.prototype as Record<string, unknown>;
  for (const k of Object.keys(vars)) assert.ok(!Object.hasOwn(proto, k), `${k} isn't on Object.prototype already`);
  try {
    for (const [k, v] of Object.entries(vars)) proto[k] = v;
    return await f();
  } finally {
    for (const k of Object.keys(vars)) delete proto[k];
  }
}

/** What the child saw, as booleans and test-made values only: never a real variable's value (they can hold tokens). */
const REPORT = `process.stdout.write(JSON.stringify({ canary: Object.hasOwn(process.env, ${JSON.stringify(CANARY)}), keep: process.env.WL846_KEEP ?? null, drop: Object.hasOwn(process.env, 'WL846_DROP'), cwd: process.cwd() }))`;
type Report = { canary: boolean; keep: string | null; drop: boolean; cwd: string };
const read = (out: string | Buffer): Report => JSON.parse(String(out)) as Report;

/** Each call form, run with the canary on Object.prototype: what its child reported. */
const FORMS: Record<string, () => Promise<Report>> = {
  'spawnSync, no env': async () => read(spawnSync(NODE, ['-e', REPORT], { encoding: 'utf8' }).stdout),
  'spawnSync, a plain env': async () => read(spawnSync(NODE, ['-e', REPORT], { encoding: 'utf8', env: { WL846_KEEP: 'k' } }).stdout),
  'spawnSync, a spread env': async () => read(spawnSync(NODE, ['-e', REPORT], { encoding: 'utf8', env: { ...process.env, WL846_KEEP: 'k', WL846_DROP: undefined } }).stdout),
  'spawnSync, options where the arguments go': async () => read(spawnSync(NODE, { input: REPORT, encoding: 'utf8' }).stdout),
  'spawnSync, no options at all': async () => read(spawnSync(NODE, ['-e', REPORT]).stdout),
  'execFileSync, no env': async () => read(execFileSync(NODE, ['-e', REPORT], { encoding: 'utf8' })),
  'execFileSync, a spread env': async () => read(execFileSync(NODE, ['-e', REPORT], { encoding: 'utf8', env: { ...process.env, WL846_KEEP: 'k' } })),
  'execFileSync, options where the arguments go': async () => read(execFileSync(NODE, { input: REPORT, encoding: 'utf8' })),
  'execFileSync, null options (Node reads them as none)': async () => read(execFileSync(NODE, ['-e', REPORT], null as unknown as undefined)),
  'execFile, null options and a callback': () => new Promise((done, fail) => void execFile(NODE, ['-e', REPORT], null, (e, out) => (e ? fail(e) : done(read(out))))),
  'spawn, no env': () => spawned(spawn(NODE, ['-e', REPORT])),
  'spawn, a spread env': () => spawned(spawn(NODE, ['-e', REPORT], { env: { ...process.env, WL846_KEEP: 'k' } })),
  'execFile, args and a callback': () => new Promise((done, fail) => void execFile(NODE, ['-e', REPORT], (e, out) => (e ? fail(e) : done(read(out))))),
  'execFile, a plain env and a callback': () => new Promise((done, fail) => void execFile(NODE, ['-e', REPORT], { env: { WL846_KEEP: 'k' } }, (e, out) => (e ? fail(e) : done(read(out))))),
  'execFile, promisified, a spread env': async () => read((await promisify(execFile)(NODE, ['-e', REPORT], { env: { ...process.env, WL846_KEEP: 'k' } })).stdout),
};

function spawned(child: nodeCp.ChildProcess): Promise<Report> {
  return new Promise((done, fail) => {
    let out = '';
    child.stdout!.on('data', (d: Buffer) => void (out += d.toString()));
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? done(read(out)) : fail(new Error(`exit ${code}`))));
  });
}

test('#846: a child never sees a variable from Object.prototype, through every call form; set variables still reach it', async () => {
  assert.equal(Object.hasOwn(process.env, CANARY), false, 'the canary is not in the environment');
  for (const [form, run] of Object.entries(FORMS)) {
    const r = await polluted({ [CANARY]: 'from-the-prototype', WL846_DROP: 'from-the-prototype' }, run);
    assert.equal(r.canary, false, `${form}: the child got the prototype's canary`);
    assert.equal(r.drop, false, `${form}: an env key set to undefined, or only on the prototype, isn't the child's`);
    if (/env/.test(form) && !/no env/.test(form)) assert.equal(r.keep, 'k', `${form}: a variable the caller set reaches the child`);
  }
});

test("#846: Node's own child_process hands the prototype's keys on (why the module exists; Node 22, measured)", async () => {
  // If this ever fails, Node stopped copying inherited keys: the module still holds, it's just no longer needed.
  const r = await polluted({ [CANARY]: 'from-the-prototype' }, () => read(nodeCp.spawnSync(NODE, ['-e', REPORT], { encoding: 'utf8', env: { ...process.env } }).stdout));
  assert.equal(r.canary, true);
});

test('#846: NODE_OPTIONS on Object.prototype loads no code in a child node', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wl846-node-'));
  const mark = join(dir, 'loaded');
  const preload = join(dir, 'preload.cjs');
  writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(mark)}, '');\n`);
  const r = await polluted({ NODE_OPTIONS: `--require ${preload}` }, () => spawnSync(NODE, ['-e', ''], { encoding: 'utf8' }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(mark), false, 'the child loaded the file NODE_OPTIONS named');
});

test('#846: an `env` only on Object.prototype is not read as the options\' env', async () => {
  const r = await polluted({ env: { [CANARY]: 'from-the-prototype', PATH: process.env.PATH } }, () => read(spawnSync(NODE, ['-e', REPORT], { encoding: 'utf8' }).stdout));
  assert.equal(r.canary, false);
});

/** A digest of an environment's own variables, so two can be compared without printing one (they can hold tokens). */
const digest = (env: Record<string, string | undefined>) => createHash('sha256').update(JSON.stringify(Object.keys(env).filter((k) => env[k] !== undefined).sort().map((k) => [k, env[k]]))).digest('hex');
const CHILD_DIGEST = `const e = process.env; process.stdout.write(require('node:crypto').createHash('sha256').update(JSON.stringify(Object.keys(e).sort().map((k) => [k, e[k]]))).digest('hex'))`;

test('#846: with a clean prototype a child gets exactly what it got before: every own variable, no more, no less', () => {
  const omitted = spawnSync(NODE, ['-e', CHILD_DIGEST], { encoding: 'utf8' }).stdout;
  assert.equal(omitted, nodeCp.spawnSync(NODE, ['-e', CHILD_DIGEST], { encoding: 'utf8' }).stdout, 'no env: the same as Node gives');
  assert.equal(omitted, digest(process.env), 'no env: the engine\'s own environment');
  const given = { ...process.env, WL846_KEEP: 'k', WL846_DROP: undefined };
  assert.equal(spawnSync(NODE, ['-e', CHILD_DIGEST], { encoding: 'utf8', env: given }).stdout, digest(given), 'a given env: its own set variables');
});

test('#846: the other options reach Node as given (cwd, encoding, input), and a bad options value is still refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wl846-cwd-'));
  const cwd = read(spawnSync(NODE, ['-e', REPORT], { cwd: dir, encoding: 'utf8' }).stdout).cwd;
  assert.equal(cwd, read(nodeCp.spawnSync(NODE, ['-e', REPORT], { cwd: dir, encoding: 'utf8' }).stdout).cwd);
  assert.ok(cwd.endsWith(dir.split(/[\\/]/).pop()!), 'cwd');
  assert.equal(typeof execFileSync(NODE, ['-e', 'process.stdout.write("x")'], { encoding: 'utf8' }), 'string', 'encoding');
  const codeOf = (f: () => unknown) => {
    try {
      f();
      return null;
    } catch (e) {
      return (e as { code?: string }).code ?? null;
    }
  };
  const bad = 'not options' as unknown as nodeCp.SpawnSyncOptions;
  assert.equal(codeOf(() => spawnSync(NODE, [], bad)), codeOf(() => nodeCp.spawnSync(NODE, [], bad)));
  assert.equal(codeOf(() => spawnSync(NODE, [], bad)), 'ERR_INVALID_ARG_TYPE');
  assert.equal(codeOf(() => execFileSync(NODE, 'not args' as unknown as string[])), codeOf(() => nodeCp.execFileSync(NODE, 'not args' as unknown as string[])));
  // #883 round 2: null options are refused by spawn and spawnSync, as Node refuses them (execFile* read null as none).
  const none = null as unknown as nodeCp.SpawnSyncOptions;
  assert.equal(codeOf(() => nodeCp.spawnSync(NODE, ['-e', ''], none)), 'ERR_INVALID_ARG_TYPE', "Node's own answer");
  assert.equal(codeOf(() => spawnSync(NODE, ['-e', ''], none)), 'ERR_INVALID_ARG_TYPE', 'spawnSync, null options');
  assert.equal(codeOf(() => spawn(NODE, ['-e', ''], none as nodeCp.SpawnOptions)), codeOf(() => nodeCp.spawn(NODE, ['-e', ''], none as nodeCp.SpawnOptions)), 'spawn, null options');
});

test('#883 round 2: an own env key set to undefined still opts out of NODE_V8_COVERAGE, as with Node', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wl846-cov-'));
  const had = Object.hasOwn(process.env, 'NODE_V8_COVERAGE');
  const was = process.env.NODE_V8_COVERAGE;
  const SEES = "process.stdout.write(String(Object.hasOwn(process.env, 'NODE_V8_COVERAGE')))";
  process.env.NODE_V8_COVERAGE = dir;
  try {
    const optOut = { env: { WL846_KEEP: 'k', NODE_V8_COVERAGE: undefined }, encoding: 'utf8' as const };
    assert.equal(nodeCp.spawnSync(NODE, ['-e', SEES], optOut).stdout, 'false', "Node's own answer");
    assert.equal(spawnSync(NODE, ['-e', SEES], optOut).stdout, 'false', 'the opt-out holds');
    const kept = { env: { WL846_KEEP: 'k' }, encoding: 'utf8' as const };
    assert.equal(spawnSync(NODE, ['-e', SEES], kept).stdout, nodeCp.spawnSync(NODE, ['-e', SEES], kept).stdout, 'without it, as Node');
  } finally {
    if (had) process.env.NODE_V8_COVERAGE = was;
    else delete process.env.NODE_V8_COVERAGE;
  }
});

test("#846: a spy on node:child_process's exports still sees each spawn (the module reads the live export per call)", () => {
  const cp = createRequire(import.meta.url)('node:child_process') as Record<string, (...a: unknown[]) => unknown>;
  const real = cp.spawnSync!;
  const seen: unknown[][] = [];
  cp.spawnSync = (...a: unknown[]) => (seen.push(a), real(...a));
  syncBuiltinESMExports();
  try {
    spawnSync(NODE, ['-e', ''], { env: { WL846_KEEP: 'k' } });
  } finally {
    cp.spawnSync = real;
    syncBuiltinESMExports();
  }
  assert.equal(seen.length, 1);
  const [file, args, options] = seen[0] as [string, string[], { env: Record<string, string> }];
  assert.deepEqual([file, args], [NODE, ['-e', '']]);
  assert.equal(Object.getPrototypeOf(options), null, 'the options Node gets: own keys only');
  assert.equal(Object.getPrototypeOf(options.env), null, 'the env Node gets: own keys only');
  assert.deepEqual({ ...options.env }, { WL846_KEEP: 'k' });
});

/** A worker (eval'd code) that posts what it sees: booleans and a digest only, never a variable's value. */
const WORKER_REPORT = `const e = process.env; require('node:worker_threads').parentPort.postMessage({ canary: Object.hasOwn(e, ${JSON.stringify(CANARY)}), path: typeof e.PATH === 'string', digest: require('node:crypto').createHash('sha256').update(JSON.stringify(Object.keys(e).sort().map((k) => [k, e[k]]))).digest('hex') })`;
type WorkerReport = { canary: boolean; path: boolean; digest: string };
function reported(w: Worker): Promise<WorkerReport> {
  return new Promise((done, fail) => {
    w.once('message', (m: WorkerReport) => done(m));
    w.once('error', fail);
  });
}

/**
 * The options startSetupWorker hands Node's Worker, through a stand-in Worker (the real setup worker runs the real
 * probe: gh, claude, the service manager), with `vars` on Object.prototype while it is called.
 */
async function setupWorkerOptions(vars: Record<string, unknown>): Promise<{ file: unknown; options: Record<string, unknown> }> {
  const wtm = createRequire(import.meta.url)('node:worker_threads') as Record<string, unknown>;
  const real = wtm.Worker;
  const seen: { file: unknown; options: Record<string, unknown> }[] = [];
  wtm.Worker = class {
    constructor(file: unknown, options: Record<string, unknown>) {
      seen.push({ file, options });
    }
  };
  syncBuiltinESMExports();
  try {
    await polluted(vars, () => void startSetupWorker({ some: 'data' }));
  } finally {
    wtm.Worker = real;
    syncBuiltinESMExports();
  }
  assert.equal(seen.length, 1);
  return seen[0]!;
}

/** A tiny worker script (a file, so no eval): it posts 1. */
function workerScript(): URL {
  const f = join(mkdtempSync(join(tmpdir(), 'wl846-worker-')), 'w.mjs');
  writeFileSync(f, "import { parentPort } from 'node:worker_threads'; parentPort.postMessage(1);\n");
  return pathToFileURL(f);
}

/** The option names Node's Worker reads from its options (a Proxy records each), for a script URL. */
async function workerOptionNames(): Promise<string[]> {
  const seen = new Set<string>();
  const options = new Proxy({ env: childEnvOf(process.env) } as Record<string | symbol, unknown>, {
    get: (t, k) => (typeof k === 'string' && seen.add(k), Reflect.get(t, k)),
    has: (t, k) => (typeof k === 'string' && seen.add(k), Reflect.has(t, k)),
  });
  const w = new Worker(workerScript(), options as WorkerOptions);
  await new Promise((done, fail) => (w.once('message', done), w.once('error', fail)));
  await w.terminate();
  return [...seen].sort();
}

test('#883 round 3: the setup worker never takes an option from Object.prototype: env given, every other option Node reads an own key', async () => {
  const names = await workerOptionNames();
  for (const n of ['env', 'eval', 'execArgv', 'argv', 'resourceLimits']) assert.ok(names.includes(n), `Node reads ${n} (the probe works)`);
  const pollute = { env: { [CANARY]: 'from-the-prototype' }, execArgv: ['--require', '/nonexistent/preload.cjs'], argv: ['x'], resourceLimits: { maxOldGenerationSizeMb: 1 }, name: 'polluted', stdin: true, transferList: [] };
  const { file, options } = await setupWorkerOptions(pollute);
  assert.equal(String(file), new URL('../src/setup-worker.js', import.meta.url).href, 'the setup worker, from a fixed src/ path');
  // eval can't be named in a src/ Worker's options (#806's lint); an inherited one fails closed (the next test).
  assert.deepEqual(names.filter((n) => n !== 'eval' && !Object.hasOwn(options, n)), [], 'each option Node reads is an own key: none comes from a prototype');
  for (const n of names.filter((x) => x !== 'eval' && x !== 'env' && x !== 'workerData')) assert.equal(options[n], undefined, `${n}: Node's default`);
  assert.deepEqual(options.workerData, { some: 'data' });
  const env = options.env as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(env), null);
  assert.equal(Object.hasOwn(env, CANARY), false, "the worker's env is not the prototype's");
  assert.equal(env.PATH, process.env.PATH, "the engine's own");
  // Why: Node's own Worker, options with no env, takes Object.prototype.env whole (Node 22, measured).
  const raw = await polluted({ env: { [CANARY]: 'from-the-prototype' } }, () => reported(new Worker(WORKER_REPORT, { eval: true })));
  assert.deepEqual([raw.canary, raw.path], [true, false]);
});

test('#883 round 3: an inherited eval makes Node refuse a Worker started from a URL (the setup worker fails closed)', async () => {
  const code = await polluted({ eval: true }, () => {
    try {
      new Worker(workerScript(), { workerData: 1, env: childEnvOf(process.env) }).terminate();
      return null;
    } catch (e) {
      return (e as { code?: string }).code ?? null;
    }
  });
  assert.equal(code, 'ERR_INVALID_ARG_VALUE');
});

test('#883 round 3: with a clean prototype the setup worker gets what it got before (the env it is given, run in a real Worker)', async () => {
  const { options } = await setupWorkerOptions({});
  assert.equal(digest(options.env as Record<string, string | undefined>), digest(process.env));
  // The same env object, in a real Worker (eval'd here, in the test, never in src/), reads as Node's default does.
  const given = await reported(new Worker(WORKER_REPORT, { eval: true, env: childEnvOf(process.env) }));
  const node = await reported(new Worker(WORKER_REPORT, { eval: true }));
  assert.equal(given.digest, node.digest);
  assert.equal(given.digest, digest(process.env));
});

test('childEnvOf: a fresh null-prototype copy of the own variables, in order; an own undefined kept; an OwnEnv works', async () => {
  const source: NodeJS.ProcessEnv = { B: '2', A: '1', GONE: undefined };
  const env = await polluted({ [CANARY]: 'x' }, () => childEnvOf(source));
  assert.equal(Object.getPrototypeOf(env), null);
  assert.notEqual(env, source);
  // An own undefined stays (#883 round 2): Node leaves it out of the child, and reads it as an opt-out (NODE_V8_COVERAGE).
  assert.deepEqual(Object.keys(env), ['B', 'A', 'GONE']);
  assert.equal(env.GONE, undefined);
  assert.equal(env[CANARY], undefined);
  assert.deepEqual(Object.keys(childEnvOf(Object.create({ INHERITED: '1' }) as NodeJS.ProcessEnv)), [], 'any prototype, not only Object.prototype');
  assert.deepEqual({ ...childEnvOf(ownEnv({ X: 'x' })) }, { X: 'x' }, 'an OwnEnv snapshot');
  assert.equal(Object.getPrototypeOf(childEnvOf(ownEnv({ X: 'x' }))), null);
  assert.deepEqual(Object.keys(childEnvOf()).sort(), Object.keys(process.env).sort(), 'process.env by default');
});

// ---- The lint (a backstop beside the module): only src/os/child-process.ts reaches node:child_process for a value. ----

const MODULE = 'src/os/child-process.ts';
// check-table: never-shrink
const SPECIFIERS = new Set(['child_process', 'node:child_process', 'cluster', 'node:cluster']);
/** worker_threads: a worker's own side (parentPort, workerData) is fine; starting one (Worker) goes through MODULE. */
// check-table: never-shrink
const WORKER_SPECIFIERS = new Set(['worker_threads', 'node:worker_threads']);
/** Node's internal bindings that start a process without child_process. */
// check-table: never-shrink
const BINDINGS = new Set(['spawn_sync', 'process_wrap']);
type Finding = { file: string; line: number; what: string };

/** The name an import or export specifier takes from its module (`Worker` in `Worker as W`). */
const takes = (s: ts.ImportSpecifier | ts.ExportSpecifier) => (s.propertyName ?? s.name).text;

/** Every place in `files` (path -> text) but the module itself that reaches child_process, cluster or a Worker for a value. */
function childProcessReach(files: Map<string, string>): Finding[] {
  const out: Finding[] = [];
  for (const [file, text] of files) {
    if (file === MODULE) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const at = (n: ts.Node, what: string) => out.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, what });
    const visit = (n: ts.Node) => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && SPECIFIERS.has(n.moduleSpecifier.text)) {
        if (!n.importClause?.isTypeOnly) at(n, `imports ${n.moduleSpecifier.text}: start a process through ${MODULE} (import type is fine)`);
        return;
      }
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && WORKER_SPECIFIERS.has(n.moduleSpecifier.text)) {
        const c = n.importClause;
        const spec = n.moduleSpecifier.text;
        if (!c || c.isTypeOnly) return;
        if (c.name || (c.namedBindings && ts.isNamespaceImport(c.namedBindings))) at(n, `imports ${spec} whole: start a Worker through ${MODULE}'s fixed starter`);
        else {
          // `default` is the whole module under another name (#883 round 3: `import { default as wt }` reached Worker).
          const taken = c.namedBindings?.elements.find((e) => !e.isTypeOnly && (takes(e) === 'Worker' || takes(e) === 'default'));
          if (taken) at(n, `imports ${takes(taken)} from ${spec}: start a Worker through ${MODULE}'s fixed starter`);
        }
        return;
      }
      if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && (SPECIFIERS.has(n.moduleSpecifier.text) || WORKER_SPECIFIERS.has(n.moduleSpecifier.text))) {
        if (!n.isTypeOnly) at(n, `re-exports ${n.moduleSpecifier.text}: only ${MODULE} reaches it`);
        return;
      }
      if (ts.isImportEqualsDeclaration(n)) at(n, 'import = require(…): import a module statically');
      if (ts.isStringLiteralLike(n) && (SPECIFIERS.has(n.text) || WORKER_SPECIFIERS.has(n.text))) at(n, `${JSON.stringify(n.text)}: only ${MODULE} names it for a value`);
      if (ts.isStringLiteralLike(n) && BINDINGS.has(n.text)) at(n, `${JSON.stringify(n.text)}: an internal binding that starts a process past ${MODULE}`);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

function srcFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(c|m)?tsx?$/.test(name)) files.set(relative(repoRoot, p).split('\\').join('/'), readFileSync(p, 'utf8'));
    }
  };
  walk(join(repoRoot, 'src'));
  return files;
}

test('#846 backstop: in src/, only src/os/child-process.ts reaches node:child_process for a value', () => {
  const files = srcFiles();
  assert.ok(files.has(MODULE) && files.size > 100, 'read the whole of src/');
  assert.deepEqual(childProcessReach(files), []);
});

test('#846 backstop: the lint finds each way around the module (fixtures, never a planted import in src/)', () => {
  const found = (text: string) => childProcessReach(new Map([['src/x.ts', text]])).map((f) => f.what.split(': ')[0]);
  assert.deepEqual(found("import { spawn } from 'node:child_process';"), ['imports node:child_process']);
  assert.deepEqual(found("import { spawn, type ChildProcess } from 'child_process';"), ['imports child_process']);
  assert.deepEqual(found("import * as cp from 'node:child_process';"), ['imports node:child_process']);
  assert.deepEqual(found("import cp from 'node:child_process';"), ['imports node:child_process']);
  assert.deepEqual(found("export { spawn } from 'node:child_process';"), ['re-exports node:child_process']);
  assert.deepEqual(found("const cp = await import('node:child_process');"), ['"node:child_process"']);
  assert.deepEqual(found("const cp = require('child_process');"), ['"child_process"']);
  assert.deepEqual(found("const cp = createRequire(import.meta.url)(`node:child_process`);"), ['"node:child_process"']);
  assert.deepEqual(found("const cp = process.getBuiltinModule('node:child_process');"), ['"node:child_process"']);
  assert.deepEqual(found("import cp = require('node:child_process');"), ['import = require(…)', '"node:child_process"']);
  assert.deepEqual(found("const b = (process as any).binding('spawn_sync');"), ['"spawn_sync"']);
  assert.deepEqual(found("import type { ChildProcess } from 'node:child_process';"), [], 'a type-only import is fine');
  assert.deepEqual(found("export type { ChildProcess } from 'node:child_process';"), [], 'a type-only re-export is fine');
  assert.deepEqual(found("import { spawn } from './os/child-process.js';"), []);
  // #883 round 2: a Worker reads Object.prototype.env when its options set none, so it starts through the module too.
  assert.deepEqual(found("import { Worker } from 'node:worker_threads';"), ['imports Worker from node:worker_threads']);
  assert.deepEqual(found("import { Worker as W, isMainThread } from 'worker_threads';"), ['imports Worker from worker_threads']);
  assert.deepEqual(found("import * as wt from 'node:worker_threads';"), ['imports node:worker_threads whole']);
  assert.deepEqual(found("import { default as wt } from 'node:worker_threads';"), ['imports default from node:worker_threads'], '#883 round 3: the module under another name');
  assert.deepEqual(found("import { default as cp } from 'node:child_process';"), ['imports node:child_process']);
  assert.deepEqual(found("import { default as c } from 'node:cluster';"), ['imports node:cluster']);
  assert.deepEqual(found("import wt from 'node:worker_threads';"), ['imports node:worker_threads whole']);
  assert.deepEqual(found("export { Worker } from 'node:worker_threads';"), ['re-exports node:worker_threads']);
  assert.deepEqual(found("const wt = await import('node:worker_threads');"), ['"node:worker_threads"']);
  assert.deepEqual(found("import { parentPort, workerData } from 'node:worker_threads';"), [], "a worker's own side is fine");
  assert.deepEqual(found("import type { Worker } from 'node:worker_threads';"), [], 'a type-only import is fine');
  assert.deepEqual(found("import cluster from 'node:cluster';"), ['imports node:cluster']);
  assert.deepEqual(childProcessReach(new Map([[MODULE, "import * as cp from 'node:child_process';"]])), [], 'the module itself');
});
