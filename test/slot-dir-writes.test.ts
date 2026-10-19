// Nothing writes a file in the shared slot directory in place (#616). Removing an instance (#555, PR #601) takes group
// write off its files there. That is safe only because every writer replaces a file whole: a temp file of its own,
// renamed or hard-linked into place, which needs only the directory's group write. An in-place write (writeFileSync
// to the final name, an append, an open for write) to a file a removal left gets EACCES.
//
// Two checks:
// - A lint over src/. Every module that names a slot-dir path, or hands one to another module, is reviewed in
//   REVIEWED below, so a new one fails here until someone has read it. A reviewed writer writes only to a temp file
//   that the same function renames or links into place (or opens with an exclusive flag). No other module writes to a
//   path built from a slot-dir name.
// - Each writer, run against a temp slot dir in which every file is 0444 (what a removal leaves): it still succeeds,
//   and the file's content is replaced.
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { GitHubBudget } from '../src/github/budget.js';
import { IntakeConfig } from '../src/intake/report.js';
import { claimDiscord } from '../src/intake/discord-claims.js';
import { identifyGate, GATE_STATE, tokenKey } from '../src/intake/discord-gate.js';
import { claimSource } from '../src/intake/source-claims.js';
import { emergencyStop, resumeAll, stopAll, tryAgentSlot } from '../src/slots.js';
import { superfanPass } from '../src/superfan/superfan.js';
import { tryTestSlot } from '../src/testrun/slots.js';
import { INCIDENTS_FILE, readIncidents } from '../src/watchdog/incidents.js';
import { takeOpsPost } from '../src/watchdog/post.js';
import { PID_LIMIT, repoRoot } from './helpers.js';

// ---------------------------------------------------------------------------------------------------------------
// The lint

/** Names that carry a slot-dir path (or a path in it): a module that uses one is a slot module. */
const SLOT_NAMES = new Set(['slotsDir', 'SYSTEM_SLOTS', 'AGENT_SLOTS_DIR', 'incidentsDir', 'claimsDir', 'machineDir', 'superfanSlots', 'updateDrainPath', 'slotsConfigPath']);
/** Calls that open a file for write. */
const WRITE_CALLS = new Set(['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'createWriteStream', 'openSync', 'open', 'copyFileSync', 'copyFile', 'cpSync', 'cp', 'truncateSync', 'truncate']);
/** Calls that put a written temp file into place without opening the target. */
const PLACE_CALLS = new Set(['renameSync', 'rename', 'linkSync', 'link']);

/**
 * Every src/ module that names a slot-dir path, hands one on, or is handed one. A `writer` writes files there: every
 * write in it is checked. `passes` only reads there or hands the path on: a write of a path built from a slot-dir
 * name is reported. Add a module only after reading every write in it.
 */
const REVIEWED: Record<string, { kind: 'writer' | 'passes'; why: string }> = {
  'src/locks.ts': { kind: 'writer', why: 'tryLock: a temp file linked into place; a takeover claim the same way' },
  'src/slots.ts': { kind: 'writer', why: 'agent and full-run slots through tryLock; STOP renamed over' },
  'src/testrun/slots.ts': { kind: 'writer', why: 'test-run slots through tryLock' },
  'src/watchdog/incidents.ts': { kind: 'writer', why: 'incidents.json renamed over, under incidents.lock' },
  'src/watchdog/post.ts': { kind: 'writer', why: 'the incident store through withIncidents (takeOpsPost, posting)' },
  'src/watchdog/watchdog.ts': { kind: 'passes', why: 'the incident dir for incidents.ts' },
  'src/watchdog/view.ts': { kind: 'passes', why: 'reads the incident store' },
  'src/testrun/run.ts': { kind: 'passes', why: 'hands its slot dir to waitTestSlot (testrun/slots.ts)' },
  'src/testrun/measure.ts': { kind: 'passes', why: 'reads the held test slots; hands its slot dir to run.ts' },
  'src/superfan/superfan.ts': { kind: 'writer', why: 'superfan-machine.json (and the instance state) renamed over' },
  'src/coordinator/superfan.ts': { kind: 'passes', why: 'the machine superfan lock (tryLock) and its state file for superfan.ts' },
  'src/intake/discord-claims.ts': { kind: 'writer', why: 'discord-claim-<instance>.json renamed over, under a tryLock' },
  'src/intake/source-claims.ts': { kind: 'writer', why: '<kind>-claim-<instance>.json renamed over, under a tryLock' },
  'src/intake/discord-gate.ts': { kind: 'writer', why: 'discord-identify.json renamed over, under a tryLock (its dir is the slot dir)' },
  'src/intake/wire.ts': { kind: 'passes', why: 'the machine dir for the claims and the identify gate' },
  'src/github/budget.ts': { kind: 'writer', why: 'github-budget-<key>.json renamed over; its lock through tryLock, moved aside by rename' },
  'src/github/budget-health.ts': { kind: 'passes', why: 'reads github-budget-<key>.json (readdirSync, lstatSync, readRegularFile: O_RDONLY | O_NOFOLLOW); never the lock' },
  'src/health.ts': { kind: 'passes', why: 'hands its slotsDir option to githubBudgetHealth (budget-health.ts)' },
  'src/update-drain.ts': { kind: 'passes', why: 'reads the drain file (root writes it)' },
  'src/os/index.ts': { kind: 'passes', why: 'defines the slot-dir paths' },
  'src/os/system-paths.ts': { kind: 'passes', why: 'testSlotsRefusal compares the slot dir with the test machine; writes nothing' },
  'src/cores.ts': { kind: 'passes', why: 'reads slotStatus' },
  'src/coordinator.ts': { kind: 'passes', why: 'hands its slot dir to slots.ts, incidents and post.ts' },
  'src/coordinator/shared.ts': { kind: 'passes', why: 'the slotsDir option' },
  'src/coordinator/base.ts': { kind: 'passes', why: 'reads STOP, the drain and slotStatus' },
  'src/coordinator/landing.ts': { kind: 'passes', why: 'fullRunLock' },
  'src/coordinator/fix-runs.ts': { kind: 'passes', why: 'tryAgentSlot' },
  'src/coordinator/merge-flow.ts': { kind: 'passes', why: 'takeOpsPost' },
  'src/dashboard.ts': { kind: 'passes', why: 'reads slots, STOP and incidents; hands its slot dir to healthView (health.ts) for the GitHub budget' },
  'src/disk-guard.ts': { kind: 'passes', why: 'hands an incidents dir to the incident store' },
  'src/watchdog/wire.ts': { kind: 'passes', why: 'reads the slot dir disk usage' },
  'src/demo.ts': { kind: 'passes', why: 'a temp slot dir for a demo coordinator' },
  'src/harness-evals/replay.ts': { kind: 'passes', why: 'a temp slot dir for a replay coordinator' },
};

interface Finding {
  file: string;
  line: number;
  what: string;
}

/** A callee's name: `f`, `x.f`, or `x['f']`. */
function calleeName(e: ts.Expression): string | null {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) return e.argumentExpression.text;
  return null;
}

/** The object a member callee is read from (`x` in `x.f` or `x['f']`), when it is a plain name. */
const calleeRoot = (e: ts.Expression): string | null => ((ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) && ts.isIdentifier(e.expression) ? e.expression.text : null);

/** Calls that build a path from their arguments: a slot-dir name inside one is still this argument's. */
const PATH_CALLS = new Set(['join', 'resolve', 'dirname', 'String']);

/**
 * Whether an argument carries a slot-dir name: directly, or through a path built from one (`pathCalls`: the path
 * builders' names in this module, renamed imports included). A nested call of anything else, and a function's body,
 * are their own: each such call is checked where it is.
 */
function mentionsSlot(n: ts.Node, pathCalls: ReadonlySet<string> = PATH_CALLS): boolean {
  let hit = false;
  const visit = (x: ts.Node) => {
    if (hit || ts.isFunctionLike(x)) return;
    if ((ts.isIdentifier(x) || ts.isPrivateIdentifier(x)) && SLOT_NAMES.has(x.text.replace(/^#/, ''))) hit = true;
    else if ((ts.isCallExpression(x) || ts.isNewExpression(x)) && !pathCalls.has(calleeName(x.expression) ?? '')) visit(x.expression);
    else ts.forEachChild(x, visit);
  };
  visit(n);
  return hit;
}

/** A call's open flag, when it is a string literal: the argument itself, or its options' `flag`/`flags`. */
function flagOf(a: ts.Expression | undefined): string | null | undefined {
  if (!a) return undefined;
  if (ts.isStringLiteralLike(a)) return a.text;
  if (ts.isObjectLiteralExpression(a)) {
    const p = a.properties.find((x) => ts.isPropertyAssignment(x) && ['flag', 'flags'].includes(x.name.getText()));
    if (!p) return undefined;
    const v = (p as ts.PropertyAssignment).initializer;
    return ts.isStringLiteralLike(v) ? v.text : null;
  }
  return null; // computed: unknown
}

const exclusive = (f: string | null | undefined) => typeof f === 'string' && f.includes('x');

/** The function (or file) a node is in. */
function enclosing(n: ts.Node): ts.Node {
  let p = n.parent;
  while (p && !ts.isFunctionLike(p) && !ts.isSourceFile(p)) p = p.parent;
  return p ?? n.getSourceFile();
}

/** Whether `scope` renames or links `target` into another name. */
function placedFrom(scope: ts.Node, target: string): boolean {
  let hit = false;
  const visit = (x: ts.Node) => {
    if (hit) return;
    if (ts.isCallExpression(x) && PLACE_CALLS.has(calleeName(x.expression) ?? '') && x.arguments[0]?.getText() === target && x.arguments[1] && x.arguments[1].getText() !== target) hit = true;
    else ts.forEachChild(x, visit);
  };
  visit(scope);
  return hit;
}

/** Why this call writes in place, or null when it can't open an existing file for write. */
function inPlace(call: ts.CallExpression, name: string): string | null {
  const a = call.arguments;
  switch (name) {
    case 'open':
    case 'openSync': {
      const f = flagOf(a[1]);
      if (f === undefined || exclusive(f) || (typeof f === 'string' && !/[wa+]/.test(f))) return null;
      return `${name} with a write flag (${a[1]?.getText()})`;
    }
    case 'writeFile':
    case 'writeFileSync': {
      if (exclusive(flagOf(a[2]))) return null;
      const target = a[0]?.getText() ?? '';
      return placedFrom(enclosing(call), target) ? null : `${name}(${target}) writes its final name: write a temp file, then rename or link it into place`;
    }
    case 'createWriteStream':
      return exclusive(flagOf(a[1])) ? null : `createWriteStream(${a[0]?.getText()}) without an exclusive flag`;
    default:
      return `${name}(${a[baseTarget(name)]?.getText()}) writes in place`;
  }
}

/** Which argument an fs write call writes: the destination for a copy, else the first. */
const baseTarget = (name: string) => (/^(copyFile|cp)(Sync)?$/.test(name) ? 1 : 0);

/** The src/ module a relative import names, as a REVIEWED key. */
function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  return relative(repoRoot, resolve(repoRoot, from, '..', spec)).split(sep).join('/').replace(/\.js$/, '.ts');
}

/** A parsed module and what its imports name. */
interface Mod {
  file: string;
  src: ts.SourceFile;
  /** A name imported from a src/ module: the module, and the name it exports. */
  imported: Map<string, { mod: string; name: string }>;
  /** A namespace import of a src/ module: the module. */
  namespaces: Map<string, string>;
  /** An fs function under its local name (`import { writeFileSync as put }`): its fs name. */
  fsAlias: Map<string, string>;
  /** The path builders' local names (`import { join as j }` included). */
  pathCalls: Set<string>;
}

function parseMod(file: string, text: string): Mod {
  const m: Mod = { file, src: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), imported: new Map(), namespaces: new Map(), fsAlias: new Map(), pathCalls: new Set(PATH_CALLS) };
  for (const s of m.src.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || !s.importClause) continue;
    const spec = s.moduleSpecifier.text;
    const b = s.importClause.namedBindings;
    const named = b && ts.isNamedImports(b) ? b.elements.map((e) => ({ local: e.name.text, name: (e.propertyName ?? e.name).text })) : [];
    if (/^(node:)?fs(\/promises)?$/.test(spec)) for (const e of named) m.fsAlias.set(e.local, e.name);
    if (/^(node:)?path$/.test(spec)) for (const e of named) if (PATH_CALLS.has(e.name)) m.pathCalls.add(e.local);
    const mod = resolveImport(file, spec);
    if (!mod) continue;
    if (b && ts.isNamespaceImport(b)) m.namespaces.set(b.name.text, mod);
    for (const e of named) m.imported.set(e.local, { mod, name: e.name });
    if (s.importClause.name) m.imported.set(s.importClause.name.text, { mod, name: 'default' });
  }
  return m;
}

/** In-place wrappers: module → function name → the parameter it writes in place. */
type Wrappers = Map<string, Map<string, number>>;

/** A write call: an fs write, or a wrapper's (`via`: the wrapper's module). `target`: the argument it writes. */
interface Write {
  name: string;
  target: number;
  via: string | null;
}

function writeOf(m: Mod, call: ts.CallExpression, wrappers: Wrappers): Write | null {
  const e = call.expression;
  const name = calleeName(e);
  if (!name) return null;
  const base = (n: string): Write | null => (WRITE_CALLS.has(n) ? { name: n, target: baseTarget(n), via: null } : null);
  const wrapped = (mod: string, n: string): Write | null => {
    const i = wrappers.get(mod)?.get(n);
    return i === undefined ? null : { name: n, target: i, via: mod };
  };
  if (ts.isIdentifier(e)) {
    const fsName = m.fsAlias.get(name);
    if (fsName) return base(fsName);
    const imp = m.imported.get(name);
    if (imp) return wrapped(imp.mod, imp.name);
    return wrapped(m.file, name) ?? base(name);
  }
  const root = calleeRoot(e);
  const ns = root ? m.namespaces.get(root) : undefined;
  return ns ? wrapped(ns, name) : base(name);
}

/** Why this write call writes in place, or null when it can't open an existing file for write. */
function whyInPlace(call: ts.CallExpression, w: Write): string | null {
  if (!w.via) return inPlace(call, w.name);
  const target = call.arguments[w.target]?.getText() ?? '';
  return placedFrom(enclosing(call), target) ? null : `${w.name}(${target}) writes its final name in place (through ${w.via}): write a temp file, then rename or link it into place`;
}

/** A named function: `function f() {}`, or `const f = () => {}` / `function () {}`. */
function namedFunction(n: ts.Node): { name: string; fn: ts.SignatureDeclaration } | null {
  if (ts.isFunctionDeclaration(n) && n.name && n.body) return { name: n.name.text, fn: n };
  if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) return { name: n.name.text, fn: n.initializer };
  return null;
}

/**
 * Every function in src/ that writes one of its own parameters in place (as writeGroupOnly and writeAgentReadable in
 * src/os/index.ts do), found from the code rather than listed: a call of one is a write, like writeFileSync. A
 * wrapper of a wrapper counts too (repeated until nothing new is found).
 */
function deriveWrappers(mods: Mod[]): Wrappers {
  const wrappers: Wrappers = new Map();
  for (let changed = true; changed; ) {
    changed = false;
    for (const m of mods) {
      const visit = (n: ts.Node) => {
        const f = namedFunction(n);
        if (f && !wrappers.get(m.file)?.has(f.name)) {
          const params = f.fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : null));
          let written: number | null = null;
          const scan = (x: ts.Node) => {
            if (written !== null) return;
            if (ts.isCallExpression(x)) {
              const w = writeOf(m, x, wrappers);
              const t = w ? x.arguments[w.target] : undefined;
              if (w && t && ts.isIdentifier(t) && params.includes(t.text) && whyInPlace(x, w)) written = params.indexOf(t.text);
            }
            ts.forEachChild(x, scan);
          };
          ts.forEachChild(f.fn, scan);
          if (written !== null) {
            if (!wrappers.has(m.file)) wrappers.set(m.file, new Map());
            wrappers.get(m.file)!.set(f.name, written);
            changed = true;
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(m.src);
    }
  }
  return wrappers;
}

/** The lint over a set of modules (path relative to the repo root, with / separators, to its text). */
function lintSlotWrites(files: Map<string, string>): Finding[] {
  const out: Finding[] = [];
  for (const key of Object.keys(REVIEWED)) if (!files.has(key)) out.push({ file: key, line: 0, what: 'reviewed here but not in src/ any more: drop it from REVIEWED' });
  const mods = [...files].map(([file, text]) => parseMod(file, text));
  const wrappers = deriveWrappers(mods);
  for (const m of mods) {
    const { file, src } = m;
    const review = REVIEWED[file];
    const at = (n: ts.Node, what: string) => out.push({ file, line: src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1, what });
    let slot = false;
    const visit = (n: ts.Node) => {
      if ((ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) && SLOT_NAMES.has(n.text.replace(/^#/, ''))) slot = true;
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const args = n.arguments ?? [];
        const hands = args.some((a) => mentionsSlot(a, m.pathCalls));
        const w = ts.isCallExpression(n) ? writeOf(m, n, wrappers) : null;
        if (w && ts.isCallExpression(n)) {
          if (review?.kind === 'writer') {
            const why = whyInPlace(n, w);
            if (why) at(n, why);
          } else if (hands) at(n, `${w.name} on a path built from a slot-dir name: slot-dir files are written by a reviewed writer, through a temp file`);
        }
        if (hands) {
          const called = calleeName(n.expression);
          const root = calleeRoot(n.expression);
          const mod = ts.isIdentifier(n.expression) && called ? m.imported.get(called)?.mod : root ? m.namespaces.get(root) : undefined;
          if (mod && !REVIEWED[mod]) at(n, `hands a slot-dir path to ${mod}, which is not reviewed: add it to REVIEWED after reading its writes`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
    if (slot && !review) out.push({ file, line: 0, what: 'names a slot-dir path but is not reviewed: add it to REVIEWED after reading its writes' });
  }
  return out;
}

function srcFiles(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.set(relative(repoRoot, p).split(sep).join('/'), readFileSync(p, 'utf8'));
    }
  };
  walk(join(repoRoot, 'src'));
  return out;
}

const show = (f: Finding[]) => f.map((x) => `${x.file}:${x.line}: ${x.what}`).join('\n');

test('lint: src/ writes no slot-dir file in place, and every module that touches the slot dir is reviewed', () => {
  const found = lintSlotWrites(srcFiles());
  assert.deepEqual(found, [], show(found));
});

test('lint: an append to a slot-dir path in a new module is reported, and so is the module itself', () => {
  const files = srcFiles();
  files.set('src/fixture-append.ts', ["import { appendFileSync } from 'node:fs';", "import { join } from 'node:path';", "import { slotsDir } from './os/index.js';", "appendFileSync(join(slotsDir(), 'x.json'), '{}');", ''].join('\n'));
  const found = lintSlotWrites(files);
  assert.match(show(found), /src\/fixture-append\.ts:4: appendFileSync on a path built from a slot-dir name/);
  assert.match(show(found), /src\/fixture-append\.ts:0: names a slot-dir path but is not reviewed/);
});

test("lint: a reviewed writer that writes its final name directly (the incident store's mutant) is reported", () => {
  const files = srcFiles();
  const before = files.get('src/watchdog/incidents.ts')!;
  const mutant = before.replace(/writeFileSync\(tmp, JSON\.stringify\(f\), \{ mode: 0o660 \}\);\s*renameSync\(tmp, file\);/, 'writeFileSync(file, JSON.stringify(f), { mode: 0o660 });');
  assert.notEqual(mutant, before, 'the mutation applies');
  files.set('src/watchdog/incidents.ts', mutant);
  assert.match(show(lintSlotWrites(files)), /src\/watchdog\/incidents\.ts:\d+: writeFileSync\(file\) writes its final name/);
});

test('lint: an append, an open for write and a stream in a reviewed writer are reported; an exclusive create is not', () => {
  const files = srcFiles();
  const body = [
    "import { appendFileSync, createWriteStream, openSync, writeFileSync } from 'node:fs';",
    'export function w(file: string) {',
    "  appendFileSync(file, 'x');",
    "  openSync(file, 'r+');",
    '  createWriteStream(file);',
    "  writeFileSync(file, 'x', { flag: 'wx' });",
    "  openSync(file, 'wx');",
    '  openSync(file);',
    '}',
    '',
  ].join('\n');
  files.set('src/locks.ts', `${files.get('src/locks.ts')!}\n${body}`);
  const found = show(lintSlotWrites(files).filter((f) => f.file === 'src/locks.ts')).split('\n');
  assert.equal(found.length, 3, found.join('\n'));
  assert.match(found[0]!, /appendFileSync\(file\) writes in place/);
  assert.match(found[1]!, /openSync with a write flag \('r\+'\)/);
  assert.match(found[2]!, /createWriteStream\(file\) without an exclusive flag/);
});

test('lint: a pass-through module that writes a slot-dir path itself, or hands one to an unreviewed module, is reported', () => {
  const files = srcFiles();
  files.set('src/fixture-gate.ts', 'export function gate(o: { dir: string }) { return o.dir; }\n');
  files.set('src/cores.ts', `${files.get('src/cores.ts')!}\nimport { gate } from './fixture-gate.js';\nimport { writeFileSync as w2 } from 'node:fs';\nexport const x = (slotsDir: string) => (gate({ dir: slotsDir }), w2(slotsDir + '/f', ''));\n`);
  const found = show(lintSlotWrites(files));
  assert.match(found, /src\/cores\.ts:\d+: hands a slot-dir path to src\/fixture-gate\.ts, which is not reviewed/);
  assert.match(found, /src\/cores\.ts:\d+: writeFileSync on a path built from a slot-dir name/, 'a write imported under another name is still a write');
});

test("lint: a write through the repo's own in-place wrappers (writeGroupOnly, writeAgentReadable) is a write", () => {
  const files = srcFiles();
  files.set(
    'src/fixture-group.ts',
    ["import { join } from 'node:path';", "import { slotsDir, writeAgentReadable, writeGroupOnly } from './os/index.js';", "writeGroupOnly(join(slotsDir(), 'x.json'), '{}');", "writeAgentReadable(join(slotsDir(), 'y.json'), '{}', 0);", ''].join('\n'),
  );
  // In a reviewed writer: the wrapper on the final name is reported; on a temp file renamed into place it is not.
  files.set('src/slots.ts', `${files.get('src/slots.ts')!}\nimport { writeGroupOnly as wg } from './os/index.js';\nexport function w(file: string, tmp: string) {\n  wg(file, 'x');\n  wg(tmp, 'x');\n  renameSync(tmp, file);\n}\n`);
  const found = show(lintSlotWrites(files));
  assert.match(found, /src\/fixture-group\.ts:3: writeGroupOnly on a path built from a slot-dir name/);
  assert.match(found, /src\/fixture-group\.ts:4: writeAgentReadable on a path built from a slot-dir name/);
  const inWriter = found.split('\n').filter((l) => l.startsWith('src/slots.ts:'));
  assert.equal(inWriter.length, 1, inWriter.join('\n'));
  assert.match(inWriter[0]!, /writeGroupOnly\(file\) writes its final name/);
});

test('lint: a wrapper of a wrapper, a local helper, a computed fs key and a renamed join are still writes', () => {
  const files = srcFiles();
  files.set('src/fixture-wrap.ts', ["import { writeGroupOnly } from './os/index.js';", 'export function save(path: string, data: string) {', '  writeGroupOnly(path, data);', '}', ''].join('\n'));
  files.set(
    'src/cores.ts',
    `${files.get('src/cores.ts')!}\nimport * as fs from 'node:fs';\nimport { join as qjoin } from 'node:path';\nimport { save } from './fixture-wrap.js';\nconst put = (p: string) => fs.appendFileSync(p, 'x');\nexport const y = (slotsDir: string) => (save(qjoin(slotsDir, 'a'), ''), put(qjoin(slotsDir, 'b')), fs['writeFileSync'](qjoin(slotsDir, 'c'), ''));\n`,
  );
  const all = lintSlotWrites(files).filter((f) => f.file === 'src/cores.ts');
  assert.match(show(all), /hands a slot-dir path to src\/fixture-wrap\.ts, which is not reviewed/);
  const found = show(all.filter((f) => f.what.includes('on a path built'))).split('\n');
  assert.equal(found.length, 3, found.join('\n'));
  assert.match(found[0]!, /save on a path built from a slot-dir name/);
  assert.match(found[1]!, /put on a path built from a slot-dir name/);
  assert.match(found[2]!, /writeFileSync on a path built from a slot-dir name/);
});

// ---------------------------------------------------------------------------------------------------------------
// The writers, against what a removal leaves: every existing file 0444, the directory writable.

const skip = process.platform === 'win32' ? 'file modes' : process.getuid?.() === 0 ? 'root ignores file modes' : false;

/** A fresh slot dir inside the test's own (temporary) AGENT_SLOTS_DIR. */
const slotDir = () => mkdtempSync(join(process.env.AGENT_SLOTS_DIR!, 'removed-'));

/** What a removal leaves: every file read-only to its owner too, the directory still writable. */
function removalLeft(dir: string): void {
  for (const f of readdirSync(dir)) chmodSync(join(dir, f), 0o444);
}

/** A lock whose holder is dead (above any pid), as a crashed holder leaves it. */
const staleLock = (dir: string, name: string) => writeFileSync(join(dir, name), JSON.stringify({ pid: PID_LIMIT + 1, owner: 'gone', acquiredAt: new Date(0).toISOString() }));

const json = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;

test('the state a removal leaves: an in-place write or append gets EACCES (what a mutant writer would hit)', { skip }, () => {
  const dir = slotDir();
  writeFileSync(join(dir, INCIDENTS_FILE), '{}');
  removalLeft(dir);
  assert.throws(() => writeFileSync(join(dir, INCIDENTS_FILE), '{"incidents":[]}'), { code: 'EACCES' });
  assert.throws(() => appendFileSync(join(dir, INCIDENTS_FILE), ' '), { code: 'EACCES' });
});

test('takeOpsPost: the incident store is replaced when every slot-dir file is 0444', { skip }, () => {
  const dir = slotDir();
  const t = Date.now();
  assert.equal(takeOpsPost({ dir, now: t }), true);
  staleLock(dir, 'incidents.lock');
  removalLeft(dir);
  assert.equal(takeOpsPost({ dir, now: t + 1000 }), true);
  assert.equal(readIncidents(dir).posts.length, 2);
});

test('stopAll and resumeAll: STOP is replaced and removed when it is 0444', { skip }, () => {
  const dir = slotDir();
  stopAll('one', 'first', dir);
  removalLeft(dir);
  stopAll('two', 'second', dir);
  assert.equal(emergencyStop(dir)?.reason, 'second');
  removalLeft(dir);
  assert.equal(resumeAll(dir), true);
  assert.equal(emergencyStop(dir), null);
});

test('tryAgentSlot and tryTestSlot: taken over stale 0444 locks', { skip }, () => {
  const dir = slotDir();
  for (const f of ['slots.lock', 'agent-0.lock', 'test-0.lock']) staleLock(dir, f);
  removalLeft(dir);
  const agent = tryAgentSlot('me', dir);
  assert.ok(agent, 'an agent slot');
  assert.equal(json(agent.path).pid, process.pid);
  agent.release();
  staleLock(dir, 'slots.lock');
  removalLeft(dir);
  const run = tryTestSlot('me', dir);
  assert.ok(run, 'a test slot');
  assert.equal(json(run.path).pid, process.pid);
  run.release();
});

test("the machine superfan's state is replaced when it is 0444", { skip }, async () => {
  const dir = slotDir();
  const stateFile = join(dir, 'superfan-machine.json');
  let now = new Date('2026-01-01T00:00:00Z');
  const pass = () =>
    superfanPass({ scope: 'machine', watching: 'the machine', stateFile, stateMode: 0o660, settings: { enabled: true, every_minutes: 10, daily_budget_usd: 1 }, read: () => ({ incidents: [], updates: [] }), judge: async () => ({ ok: false, costUsd: 0 }), post: async () => false, redact: (s) => s, now: () => now });
  assert.equal(await pass(), 'quiet');
  removalLeft(dir);
  now = new Date('2026-01-01T01:00:00Z');
  assert.equal(await pass(), 'quiet');
  assert.equal(json(stateFile).lastPassAt, now.toISOString());
});

test('the Slack/Linear and Discord claims are replaced when they are 0444', { skip }, async () => {
  const dir = slotDir();
  const a = await claimSource({ kind: 'slack', instance: 'one', key: 'k1', claimsDir: dir });
  assert.ok('release' in a);
  staleLock(dir, 'slack-claims.lock');
  removalLeft(dir);
  const b = await claimSource({ kind: 'slack', instance: 'one', key: 'k2', claimsDir: dir });
  assert.ok('release' in b, JSON.stringify(b));
  const claim = readdirSync(dir).find((f) => f.startsWith('slack-') && f.endsWith('-one.json'));
  assert.ok(claim, readdirSync(dir).join(', '));
  assert.equal(json(join(dir, claim)).key, 'k2');

  const discord = (channel: string) => IntakeConfig.parse({ version: 1, discord: { enabled: true, guild: '300000000001', channels: [channel], asks_channel: '111111', dashboard_url: 'https://dashboard.example.test' } });
  const none = mkdtempSync(join(process.env.AGENT_SLOTS_DIR!, 'no-instances-'));
  const c = await claimDiscord({ instance: 'one', config: discord('333333'), instancesDir: none, claimsDir: dir });
  assert.ok('release' in c, JSON.stringify(c));
  const first = readFileSync(join(dir, 'discord-claim-one.json'), 'utf8');
  removalLeft(dir);
  const d = await claimDiscord({ instance: 'one', config: discord('444444'), instancesDir: none, claimsDir: dir });
  assert.ok('release' in d, JSON.stringify(d));
  assert.notEqual(readFileSync(join(dir, 'discord-claim-one.json'), 'utf8'), first);
});

test("the Discord identify gate's state is replaced when it is 0444", { skip }, async () => {
  const dir = slotDir();
  let now = 1_000_000;
  const gate = identifyGate({ dir, token: 'example-token', owner: 'me', now: () => now, sleep: async () => {}, limit: async () => null });
  assert.deepEqual(await gate(), { ok: true });
  removalLeft(dir);
  now += 60_000;
  assert.deepEqual(await gate(), { ok: true });
  assert.deepEqual(json(join(dir, GATE_STATE))[tokenKey('example-token')], { last: now });
});

test("a token's GitHub budget is replaced when it is 0444", { skip }, async () => {
  const dir = slotDir();
  const budget = new GitHubBudget('0123456789abcdef', dir, { maxWaitMs: 0 });
  await budget.take('backlog');
  staleLock(dir, 'github-budget-0123456789abcdef.lock');
  removalLeft(dir);
  await budget.take('backlog');
  assert.equal(budget.read().resources.core?.used.backlog, 2);
});
