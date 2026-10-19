// Every write into the shared slot directory goes through one helper, writeSlotFile (src/slot-file.ts, #661).
// Removing an instance (#555, PR #601) takes group write off its files there, so any of them can be 0444 to everyone
// else. Replacing a file needs only the directory's group write; an in-place write (writeFileSync to the final name,
// an append, an open for write) gets EACCES (#616), and so does a temp file named by pid alone that a crashed writer
// left, once a new process gets the same pid. writeSlotFile writes a new temp file of its own (a random name, created
// exclusively) and renames or hard-links it into place.
//
// Two checks:
// - A lint over src/. Every module that names a slot-dir path, or hands one to another module, is reviewed in
//   REVIEWED below, so a new one fails here until someone has read it. Only writeSlotFile writes, and it only a new
//   temp file of its own. A writer, and a module that only reads there or hands the path on, writes no file but
//   through it, whatever the path: no fs write (under any name: renamed, destructured, fs['...']), and no call of a
//   function that writes a file named from one of its parameters. A module that also writes files elsewhere (its
//   state dir, a worktree) lists each of its own fs writes in its review, by function and target, once someone has
//   read it; any other fs write in it fails here. Anywhere, a write of a path built from a slot-dir name is reported.
//   Not caught: such a module calling another module's writing function with a slot-dir path that came in as a
//   parameter (each such module is listed `mixed` below).
// - Each writer, run against a temp slot dir in which every file is 0444 (what a removal leaves): it still succeeds,
//   and the file's content is replaced. A 0444 temp file at the pid-only name a writer used before doesn't stop it.
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
/** The one module that writes slot-dir files: a new temp file of its own (flag wx), renamed or linked into place. */
const HELPER = 'src/slot-file.ts';

/**
 * helper: HELPER. writer: writes slot-dir files, through the helper. passes: reads there, or hands the path on. Each
 * of these writes nothing else: any other write in it is reported, a call of a function that writes included.
 * mixed: hands the path on, and writes files elsewhere (its state dir, a worktree). Each of its own fs writes is
 * listed in `elsewhere` (`<function>: <call>(<target>)` → what it writes), once read; a call there of a function
 * that writes is reported when its path is built from a slot-dir name.
 */
type Review = { kind: 'helper' | 'writer' | 'passes'; why: string } | { kind: 'mixed'; why: string; elsewhere: Record<string, string> };

/** Every src/ module that names a slot-dir path, hands one on, or is handed one. Add a module only after reading every write in it. */
const REVIEWED: Record<string, Review> = {
  [HELPER]: { kind: 'helper', why: 'writeSlotFile: a new temp file (flag wx), renamed or linked into place' },
  'src/locks.ts': { kind: 'writer', why: 'tryLock: the lock, and a takeover claim, through writeSlotFile (linked into place: replace false)' },
  'src/slots.ts': { kind: 'writer', why: 'agent and full-run slots through tryLock; STOP through writeSlotFile' },
  'src/testrun/slots.ts': { kind: 'writer', why: 'test-run slots through tryLock' },
  'src/watchdog/incidents.ts': { kind: 'writer', why: 'incidents.json through writeSlotFile, under incidents.lock' },
  'src/watchdog/post.ts': { kind: 'writer', why: 'the incident store through withIncidents (takeOpsPost, posting)' },
  'src/watchdog/watchdog.ts': { kind: 'passes', why: 'the incident dir for incidents.ts' },
  'src/watchdog/view.ts': { kind: 'passes', why: 'reads the incident store' },
  'src/testrun/run.ts': {
    kind: 'mixed',
    why: 'hands its slot dir to waitTestSlot (testrun/slots.ts)',
    elsewhere: {
      'runTestRun: writeFileSync(join(d.logDir, id, `fetch-${i + 1}.log`))': "a fetch step's log, in the log dir",
      'runTestRun: writeFileSync(join(d.logDir, id, `setup-${i + 1}.log`))': "a setup step's log, in the log dir",
      'runTestRun: writeFileSync(join(d.logDir, logRef))': "a tier's log, in the log dir",
    },
  },
  'src/testrun/measure.ts': { kind: 'mixed', why: 'reads the held test slots; hands its slot dir to run.ts (runTestRun writes its logs in the log dir)', elsewhere: {} },
  'src/superfan/superfan.ts': { kind: 'writer', why: 'superfan-machine.json (and the instance state) through writeSlotFile' },
  'src/coordinator/superfan.ts': { kind: 'mixed', why: 'the machine superfan lock (tryLock) and its state file for superfan.ts; a judge run dir (threadRunDir) beside the repo', elsewhere: {} },
  'src/intake/discord-claims.ts': { kind: 'writer', why: 'discord-claim-<instance>.json through writeSlotFile, under a tryLock' },
  'src/intake/source-claims.ts': { kind: 'writer', why: '<kind>-claim-<instance>.json through writeSlotFile, under a tryLock' },
  'src/intake/discord-gate.ts': { kind: 'writer', why: 'discord-identify.json through writeSlotFile, under a tryLock (its dir is the slot dir)' },
  'src/intake/wire.ts': { kind: 'passes', why: 'the machine dir for the claims and the identify gate' },
  'src/github/budget.ts': { kind: 'writer', why: 'github-budget-<key>.json through writeSlotFile; its lock through tryLock, moved aside by rename' },
  'src/github/budget-health.ts': { kind: 'passes', why: 'reads github-budget-<key>.json (readdirSync, lstatSync, readRegularFile: O_RDONLY | O_NOFOLLOW); never the lock' },
  'src/health.ts': { kind: 'passes', why: 'hands its slotsDir option to githubBudgetHealth (budget-health.ts)' },
  'src/update-drain.ts': { kind: 'passes', why: 'reads the drain file (root writes it)' },
  'src/os/index.ts': {
    kind: 'mixed',
    why: 'defines the slot-dir paths',
    elsewhere: {
      'writeAgentReadable: writeFileSync(file)': 'its caller\'s file (a task file, in the state dir)',
      'writeGroupOnly: writeFileSync(file)': "its caller's file (in the state dir)",
      'writeOwnerOnly: writeFileSync(tmp)': "its caller's file, through a temp file",
      'writeExecutable: writeFileSync(tmp)': 'a git hook or a launcher, through a temp file',
      'installOwnerOnlySecret: writeFileSync(tmp)': "a secret in the user's own 0700 dir",
      'installSecretFor: writeFileSync(tmp)': "a secret in a user's 0700 dir",
      'installService: writeFileSync(path)': 'a launchd plist or a systemd user unit',
      'replaceFileAtomically: writeFileSync(tmp)': "its caller's file, through a temp file",
    },
  },
  'src/os/system-paths.ts': { kind: 'passes', why: 'testSlotsRefusal compares the slot dir with the test machine; writes nothing' },
  'src/cores.ts': { kind: 'passes', why: 'reads slotStatus' },
  'src/coordinator.ts': { kind: 'mixed', why: 'hands its slot dir to slots.ts, incidents and post.ts', elsewhere: { 'reproduce: cpSync(join(workerPath, s.test_path))': 'the reproduction test, into the worker worktree' } },
  'src/coordinator/shared.ts': { kind: 'passes', why: 'the slotsDir option' },
  'src/coordinator/base.ts': { kind: 'mixed', why: 'reads STOP, the drain and slotStatus; writes the task file and live state (state dir) through os/index.ts', elsewhere: {} },
  'src/coordinator/landing.ts': { kind: 'mixed', why: 'fullRunLock; worktrees through the worktree manager', elsewhere: {} },
  'src/coordinator/fix-runs.ts': { kind: 'mixed', why: 'tryAgentSlot; worktrees through the worktree manager', elsewhere: {} },
  'src/coordinator/merge-flow.ts': { kind: 'mixed', why: 'takeOpsPost; auto-merge-stopped.json (state dir) through writeGroupOnly', elsewhere: {} },
  'src/dashboard.ts': {
    kind: 'mixed',
    why: 'reads slots, STOP and incidents; hands its slot dir to healthView (health.ts) for the GitHub budget',
    elsewhere: {
      'dashboardToken: writeFileSync(f)': 'the dashboard token, in the state dir',
      'fileDraft: writeFileSync(filedPath(opts.stateDir, id))': "a chat draft's filed marker, in the state dir",
      'startDashboard: writeFileSync(join(opts.stateDir, SKIPS_FILE))': 'the skipped setup steps, in the state dir',
      'startDashboard: writeFileSync(viewsFile)': 'dashboard-views.json, in the state dir',
    },
  },
  'src/disk-guard.ts': { kind: 'passes', why: 'hands an incidents dir to the incident store' },
  'src/watchdog/wire.ts': { kind: 'passes', why: 'reads the slot dir disk usage' },
  'src/demo.ts': {
    kind: 'mixed',
    why: 'a temp slot dir for a demo coordinator (its config.json through writeSlotFile)',
    elsewhere: {
      "agents: writeFileSync(join(req.cwd, 'test', 'repro-qty.test.js'))": "a scripted agent's edit, in its worktree",
      'agents: writeFileSync(p)': "a scripted agent's edit, in its worktree",
      "agents: writeFileSync(join(req.cwd, 'README.md'))": "a scripted agent's edit, in its worktree",
      "agents: writeFileSync(join(req.cwd, 'migrations', '001_orders.sql'))": "a scripted agent's edit, in its worktree",
      'seedDemo: cpSync(seed)': 'the demo project, copied from the example',
      "seedDemo: writeFileSync(join(seed, '.gitignore'))": 'the demo project',
      "seedDemo: writeFileSync(join(seed, 'test', 'legacy.test.js'))": 'the demo project',
      'seedDemo: writeFileSync(cfgFile)': "the demo project's config",
      'seedDemo: writeFileSync(dep)': "the demo project's deploy config",
    },
  },
  'src/harness-evals/replay.ts': {
    kind: 'mixed',
    why: 'a temp slot dir for a replay coordinator (its config.json through writeSlotFile)',
    elsewhere: { 'edit: writeFileSync(f)': "the scratch clone's config", 'overlayHarnessConfig: writeFileSync(f.to)': "the scratch clone's harness config" },
  },
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

/**
 * Whether an fs call can write: an open only with a write flag, or one not known here (numeric flags count as a
 * read only when every one named is a read flag: `O_RDONLY | O_NOFOLLOW`); every other write call always.
 */
function fsWrites(call: ts.CallExpression, name: string): boolean {
  if (name !== 'open' && name !== 'openSync') return true;
  const a = call.arguments[1];
  const f = flagOf(a);
  if (f === null) {
    const named: string[] = a!.getText().match(/\bO_[A-Z]+\b/g) ?? [];
    return !named.includes('O_RDONLY') || named.some((x) => /^O_(WRONLY|RDWR|CREAT|TRUNC|APPEND)$/.test(x));
  }
  return typeof f === 'string' && /[wax+]/.test(f);
}

/** Which argument an fs write call writes: the destination for a copy, else the first. */
const baseTarget = (name: string) => (/^(copyFile|cp)(Sync)?$/.test(name) ? 1 : 0);

/** Why a write in the helper is not a new temp file of its own, created exclusively, or null. */
function helperWrite(call: ts.CallExpression, name: string): string | null {
  const a = call.arguments;
  const flag = /^writeFile(Sync)?$/.test(name) ? flagOf(a[2]) : /^(open(Sync)?|createWriteStream)$/.test(name) ? flagOf(a[1]) : undefined;
  return exclusive(flag) ? null : `${name}(${a[baseTarget(name)]?.getText()}) in the helper: it writes only a new temp file of its own, created exclusively (flag 'wx')`;
}

/** The src/ module a relative import names, as a REVIEWED key. */
function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  return relative(repoRoot, resolve(repoRoot, from, '..', spec)).split(sep).join('/').replace(/\.js$/, '.ts');
}

/** A parsed module and what its imports name. */
interface Mod {
  file: string;
  text: string;
  src: ts.SourceFile;
  /** A name imported from a src/ module: the module, and the name it exports. */
  imported: Map<string, { mod: string; name: string }>;
  /** A namespace import of a src/ module: the module. */
  namespaces: Map<string, string>;
  /** An fs function under its local name (`import { writeFileSync as put }`, `const { writeFileSync: put } = fs`): its fs name. */
  fsAlias: Map<string, string>;
  /** The path builders' local names (`import { join as j }` included). */
  pathCalls: Set<string>;
}

/** Parsed once per text: each test lints all of src/ with a file or two changed. */
const parsed = new Map<string, Mod>();

function parseMod(file: string, text: string): Mod {
  const hit = parsed.get(file);
  if (hit?.text === text) return hit;
  const m: Mod = { file, text, src: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), imported: new Map(), namespaces: new Map(), fsAlias: new Map(), pathCalls: new Set(PATH_CALLS) };
  /** fs imported whole (`import * as fs`, `import fs`): destructuring it names fs functions. */
  const fsWhole = new Set<string>();
  for (const s of m.src.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || !s.importClause) continue;
    const spec = s.moduleSpecifier.text;
    const b = s.importClause.namedBindings;
    const named = b && ts.isNamedImports(b) ? b.elements.map((e) => ({ local: e.name.text, name: (e.propertyName ?? e.name).text })) : [];
    if (/^(node:)?fs(\/promises)?$/.test(spec)) {
      for (const e of named) m.fsAlias.set(e.local, e.name);
      if (b && ts.isNamespaceImport(b)) fsWhole.add(b.name.text);
      if (s.importClause.name) fsWhole.add(s.importClause.name.text);
    }
    if (/^(node:)?path$/.test(spec)) for (const e of named) if (PATH_CALLS.has(e.name)) m.pathCalls.add(e.local);
    const mod = resolveImport(file, spec);
    if (!mod) continue;
    if (b && ts.isNamespaceImport(b)) m.namespaces.set(b.name.text, mod);
    for (const e of named) m.imported.set(e.local, { mod, name: e.name });
    if (s.importClause.name) m.imported.set(s.importClause.name.text, { mod, name: 'default' });
  }
  const destructured = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer && ts.isIdentifier(n.initializer) && fsWhole.has(n.initializer.text)) {
      for (const e of n.name.elements) if (ts.isIdentifier(e.name)) m.fsAlias.set(e.name.text, e.propertyName ? e.propertyName.getText() : e.name.text);
    }
    ts.forEachChild(n, destructured);
  };
  destructured(m.src);
  parsed.set(file, m);
  return m;
}

/** A parameter a file name is built from: its index, and the option it is read from (`o.dir`), if one. */
interface Param {
  i: number;
  prop?: string;
}

/** Functions that write a file named from one of their parameters: module → function name → that parameter. */
type Writers = Map<string, Map<string, Param>>;

/** A write call: an fs write, or a writer function's (`via`: its module). `target`: the argument it writes. */
interface Write {
  name: string;
  target: Param;
  via: string | null;
}

/** The argument (or, for an options object, the option) a write call writes; undefined when the call has none. */
function targetOf(call: ts.CallExpression, w: Write): ts.Node | undefined {
  const a = call.arguments[w.target.i];
  if (!a || !w.target.prop || !ts.isObjectLiteralExpression(a)) return a;
  const p = a.properties.find((x) => (ts.isPropertyAssignment(x) || ts.isShorthandPropertyAssignment(x)) && x.name.getText() === w.target.prop);
  if (p) return ts.isPropertyAssignment(p) ? p.initializer : p.name;
  return a.properties.some((x) => ts.isSpreadAssignment(x)) ? a : undefined; // it may come in a spread
}

function writeOf(m: Mod, call: ts.CallExpression, writers: Writers): Write | null {
  const e = call.expression;
  const name = calleeName(e);
  if (!name) return null;
  const base = (n: string): Write | null => (WRITE_CALLS.has(n) && fsWrites(call, n) ? { name: n, target: { i: baseTarget(n) }, via: null } : null);
  const wrapped = (mod: string, n: string): Write | null => {
    const p = writers.get(mod)?.get(n);
    return p === undefined ? null : { name: n, target: p, via: mod };
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

/** A named function: `function f() {}`, or `const f = () => {}` / `function () {}`. */
function namedFunction(n: ts.Node): { name: string; fn: ts.SignatureDeclaration } | null {
  if (ts.isFunctionDeclaration(n) && n.name && n.body) return { name: n.name.text, fn: n };
  if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) return { name: n.name.text, fn: n.initializer };
  return null;
}

/**
 * The first of `names` an expression uses (not as a property: `x.file` is not `file`), outside nested functions;
 * with the option it reads, when it reads one straight off a parameter (`o.dir`).
 */
function firstOf(n: ts.Node, names: ReadonlyMap<string, Param>): Param | undefined {
  let hit: Param | undefined;
  const visit = (x: ts.Node) => {
    if (hit !== undefined || ts.isFunctionLike(x)) return;
    if (ts.isIdentifier(x) && names.has(x.text) && !(ts.isPropertyAccessExpression(x.parent) && x.parent.name === x)) {
      const p = names.get(x.text)!;
      hit = p.prop === undefined && ts.isPropertyAccessExpression(x.parent) && x.parent.expression === x ? { i: p.i, prop: x.parent.name.text } : p;
    } else ts.forEachChild(x, visit);
  };
  visit(n);
  return hit;
}

/** The names in a function that stand for a parameter: the parameter, and a local named from one (`const tmp = `${file}.tmp``). */
function fromParams(fn: ts.SignatureDeclaration): Map<string, Param> {
  const out = new Map<string, Param>();
  fn.parameters.forEach((p, i) => {
    if (ts.isIdentifier(p.name)) out.set(p.name.text, { i });
  });
  const locals: ts.VariableDeclaration[] = [];
  const collect = (x: ts.Node) => {
    if (ts.isVariableDeclaration(x) && ts.isIdentifier(x.name) && x.initializer) locals.push(x);
    if (!ts.isFunctionLike(x)) ts.forEachChild(x, collect);
  };
  ts.forEachChild(fn, collect);
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of locals) {
      const name = (d.name as ts.Identifier).text;
      const i = out.has(name) ? undefined : firstOf(d.initializer!, out);
      if (i !== undefined) {
        out.set(name, i);
        changed = true;
      }
    }
  }
  return out;
}

/**
 * Every function in src/ that writes a file named from one of its parameters (writeGroupOnly, writeOwnerOnly,
 * replaceFileAtomically, ...), found from the code rather than listed: a call of one is a write, like writeFileSync.
 * A writer of a writer counts too (repeated until nothing new is found). The helper's own are not: a call of
 * writeSlotFile is the one allowed write.
 */
function deriveWriters(mods: Mod[]): Writers {
  const writers: Writers = new Map();
  for (let changed = true; changed; ) {
    changed = false;
    for (const m of mods) {
      if (m.file === HELPER) continue;
      const visit = (n: ts.Node) => {
        const f = namedFunction(n);
        if (f && !writers.get(m.file)?.has(f.name)) {
          const from = fromParams(f.fn);
          let written: Param | undefined;
          const scan = (x: ts.Node) => {
            if (written !== undefined) return;
            if (ts.isCallExpression(x)) {
              const w = writeOf(m, x, writers);
              const t = w ? targetOf(x, w) : undefined;
              if (t) written = firstOf(t, from);
            }
            ts.forEachChild(x, scan);
          };
          ts.forEachChild(f.fn, scan);
          if (written !== undefined) {
            if (!writers.has(m.file)) writers.set(m.file, new Map());
            writers.get(m.file)!.set(f.name, written);
            changed = true;
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(m.src);
    }
  }
  return writers;
}

/** The function a node is in, by name (`(module)` outside any): the nearest one that has a name. */
function ownerName(n: ts.Node): string {
  for (let p = n.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) && p.name) return p.name.getText();
    if (ts.isConstructorDeclaration(p)) return 'constructor';
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && (ts.isVariableDeclaration(p.parent) || ts.isPropertyAssignment(p.parent) || ts.isPropertyDeclaration(p.parent))) return p.parent.name.getText();
  }
  return '(module)';
}

/** The lint over a set of modules (path relative to the repo root, with / separators, to its text). */
function lintSlotWrites(files: Map<string, string>): Finding[] {
  const out: Finding[] = [];
  for (const key of Object.keys(REVIEWED)) if (!files.has(key)) out.push({ file: key, line: 0, what: 'reviewed here but not in src/ any more: drop it from REVIEWED' });
  const mods = [...files].map(([file, text]) => parseMod(file, text));
  const writers = deriveWriters(mods);
  for (const m of mods) {
    const { file, src } = m;
    const review = REVIEWED[file];
    const at = (n: ts.Node, what: string) => out.push({ file, line: src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1, what });
    const seen = new Set<string>();
    let slot = false;
    const visit = (n: ts.Node) => {
      if ((ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) && SLOT_NAMES.has(n.text.replace(/^#/, ''))) slot = true;
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const args = n.arguments ?? [];
        const hands = args.some((a) => mentionsSlot(a, m.pathCalls));
        const w = ts.isCallExpression(n) ? writeOf(m, n, writers) : null;
        if (w && ts.isCallExpression(n)) {
          const t = targetOf(n, w);
          const what = `${w.name}(${t?.getText() ?? ''})`;
          const key = `${ownerName(n)}: ${what}`;
          if (file === HELPER) {
            const why = w.via ? `${what} in the helper: it writes only through fs, a new temp file of its own` : helperWrite(n, w.name);
            if (why) at(n, why);
          } else if (t && mentionsSlot(t, m.pathCalls)) at(n, `${what} on a path built from a slot-dir name: write it with writeSlotFile (${HELPER})`);
          else if (review?.kind === 'mixed') {
            if (w.via) {
              // another function's write: checked above, by its path
            } else if (key in review.elsewhere) seen.add(key);
            else at(n, `${key} writes directly, and is not listed: list it as a write elsewhere in REVIEWED once read (the slot dir is written only through writeSlotFile, ${HELPER})`);
          } else if (review) at(n, `${key} writes directly: this module writes no file but through writeSlotFile (${HELPER})`);
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
    for (const key of Object.keys(review?.kind === 'mixed' ? review.elsewhere : {})) if (!seen.has(key)) out.push({ file, line: 0, what: `${key}: listed as a write elsewhere but not found: drop it from REVIEWED` });
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
const lines = (f: Finding[], file: string) => f.filter((x) => x.file === file).map((x) => `${x.line}: ${x.what}`);

test('lint: src/ writes the slot dir only through writeSlotFile, and every module that touches the slot dir is reviewed', () => {
  const found = lintSlotWrites(srcFiles());
  assert.deepEqual(found, [], show(found));
});

test('lint: an append to a slot-dir path in a new module is reported, and so is the module itself', () => {
  const files = srcFiles();
  files.set('src/fixture-append.ts', ["import { appendFileSync } from 'node:fs';", "import { join } from 'node:path';", "import { slotsDir } from './os/index.js';", "appendFileSync(join(slotsDir(), 'x.json'), '{}');", ''].join('\n'));
  const found = lintSlotWrites(files);
  assert.match(show(found), /src\/fixture-append\.ts:4: appendFileSync\(join\(slotsDir\(\), 'x\.json'\)\) on a path built from a slot-dir name/);
  assert.match(show(found), /src\/fixture-append\.ts:0: names a slot-dir path but is not reviewed/);
});

test("lint: a reviewed writer that writes directly is reported, even a temp file renamed into place (the incident store's mutant)", () => {
  const files = srcFiles();
  const before = files.get('src/watchdog/incidents.ts')!;
  const mutant = before.replace('writeSlotFile(file, JSON.stringify(f), { mode: 0o660 });', 'const tmp = `${file}.${process.pid}.tmp`;\n  writeFileSync(tmp, JSON.stringify(f), { mode: 0o660 });\n  renameSync(tmp, file);');
  assert.notEqual(mutant, before, 'the mutation applies');
  files.set('src/watchdog/incidents.ts', mutant);
  const found = lines(lintSlotWrites(files), 'src/watchdog/incidents.ts');
  assert.match(found[0] ?? '', /writeIncidents: writeFileSync\(tmp\) writes directly: this module writes no file but through writeSlotFile/);
  // writeIncidents now writes a file named from its dir: each call of it (and of withIncidents) is a write too.
  assert.deepEqual(
    found.slice(1).map((l) => l.replace(/^\d+: /, '')),
    ['withIncidents: writeIncidents(d)', 'raiseIncident: withIncidents(o.dir)', 'resolveIncident: withIncidents(o.dir)'].map((w) => `${w} writes directly: this module writes no file but through writeSlotFile (${HELPER})`),
  );
});

test('lint: a write in a pass-through module from a parameter (budget-health read(), #676) is reported', () => {
  const files = srcFiles();
  const before = files.get('src/github/budget-health.ts')!;
  const mutant = before.replace('    const file = join(dir, name);\n', "    const file = join(dir, name);\n    writeFileSync(join(dir, name), '{}');\n").replace("import { lstatSync, readdirSync } from 'node:fs';", "import { lstatSync, readdirSync, writeFileSync } from 'node:fs';");
  assert.notEqual(mutant, before, 'the mutation applies');
  files.set('src/github/budget-health.ts', mutant);
  const found = lines(lintSlotWrites(files), 'src/github/budget-health.ts');
  assert.equal(found.length, 2, found.join('\n'));
  assert.match(found[0]!, /read: writeFileSync\(join\(dir, name\)\) writes directly: this module writes no file but through writeSlotFile/);
  assert.match(found[1]!, /read\(dir \?\? slotsDir\(\)\) on a path built from a slot-dir name/, 'and its call with the slot dir');
});

test('lint: a function that writes into the directory it is given (putInDir, #654 review) is a write where it is and where it is called', () => {
  const files = srcFiles();
  files.set('src/os/index.ts', `${files.get('src/os/index.ts')!}\nexport function putInDir(dir: string) {\n  writeFileSync(join(dir, 'x'), '');\n}\n`);
  files.set('src/cores.ts', `${files.get('src/cores.ts')!}\nimport { putInDir } from './os/index.js';\nexport const z = (d: string) => putInDir(d);\nexport const z2 = () => putInDir(slotsDir());\n`);
  const found = lintSlotWrites(files);
  assert.match(show(found), /src\/os\/index\.ts:\d+: putInDir: writeFileSync\(join\(dir, 'x'\)\) writes directly, and is not listed/);
  assert.match(show(found), /src\/cores\.ts:\d+: z: putInDir\(d\) writes directly: this module writes no file but through writeSlotFile/);
  assert.match(show(found), /src\/cores\.ts:\d+: putInDir\(slotsDir\(\)\) on a path built from a slot-dir name/);
});

test('lint: in a module that writes elsewhere, a listed write is not reported; a new one is, and so is one listed but gone', () => {
  const files = srcFiles();
  const before = files.get('src/dashboard.ts')!;
  files.set('src/dashboard.ts', `${before}\nexport function more(stateDir: string) {\n  writeFileSync(join(stateDir, 'x.json'), '{}');\n}\n`);
  assert.deepEqual(lines(lintSlotWrites(files), 'src/dashboard.ts'), [`${before.split('\n').length + 2}: more: writeFileSync(join(stateDir, 'x.json')) writes directly, and is not listed: list it as a write elsewhere in REVIEWED once read (the slot dir is written only through writeSlotFile, ${HELPER})`]);
  files.set('src/dashboard.ts', before.replace('writeFileSync(viewsFile,', 'void (viewsFile,'));
  assert.deepEqual(lines(lintSlotWrites(files), 'src/dashboard.ts'), ['0: startDashboard: writeFileSync(viewsFile): listed as a write elsewhere but not found: drop it from REVIEWED']);
});

test('lint: in the helper, an append, an open for write and a stream are reported; an exclusive create and a read are not', () => {
  const files = srcFiles();
  const body = [
    "import { appendFileSync, createWriteStream, openSync, writeFileSync } from 'node:fs';",
    'export function w(file: string) {',
    "  appendFileSync(file, 'x');",
    "  openSync(file, 'r+');",
    '  createWriteStream(file);',
    "  writeFileSync(file, 'x');",
    "  writeFileSync(file, 'x', { flag: 'wx' });",
    "  openSync(file, 'wx');",
    '  openSync(file);',
    '}',
    '',
  ].join('\n');
  files.set(HELPER, `${files.get(HELPER)!}\n${body}`);
  const found = lines(lintSlotWrites(files), HELPER);
  assert.equal(found.length, 4, found.join('\n'));
  assert.match(found[0]!, /appendFileSync\(file\) in the helper/);
  assert.match(found[1]!, /openSync\(file\) in the helper/);
  assert.match(found[2]!, /createWriteStream\(file\) in the helper/);
  assert.match(found[3]!, /writeFileSync\(file\) in the helper/);
});

test('lint: a pass-through module that writes a slot-dir path itself, or hands one to an unreviewed module, is reported', () => {
  const files = srcFiles();
  files.set('src/fixture-gate.ts', 'export function gate(o: { dir: string }) { return o.dir; }\n');
  files.set('src/cores.ts', `${files.get('src/cores.ts')!}\nimport { gate } from './fixture-gate.js';\nimport { writeFileSync as w2 } from 'node:fs';\nexport const x = (slotsDir: string) => (gate({ dir: slotsDir }), w2(slotsDir + '/f', ''));\n`);
  const found = show(lintSlotWrites(files));
  assert.match(found, /src\/cores\.ts:\d+: hands a slot-dir path to src\/fixture-gate\.ts, which is not reviewed/);
  assert.match(found, /src\/cores\.ts:\d+: writeFileSync\(slotsDir \+ '\/f'\) on a path built from a slot-dir name/, 'a write imported under another name is still a write');
});

test("lint: a write through the repo's own writers (writeGroupOnly, writeAgentReadable, writeOwnerOnly) is a write, on a temp file too", () => {
  const files = srcFiles();
  files.set(
    'src/fixture-group.ts',
    ["import { join } from 'node:path';", "import { slotsDir, writeAgentReadable, writeGroupOnly } from './os/index.js';", "writeGroupOnly(join(slotsDir(), 'x.json'), '{}');", "writeAgentReadable(join(slotsDir(), 'y.json'), '{}', 0);", ''].join('\n'),
  );
  files.set('src/slots.ts', `${files.get('src/slots.ts')!}\nimport { writeGroupOnly as wg, writeOwnerOnly } from './os/index.js';\nexport function w(file: string, tmp: string) {\n  wg(tmp, 'x');\n  renameSync(tmp, file);\n  writeOwnerOnly(file, 'x');\n}\n`);
  const found = show(lintSlotWrites(files));
  assert.match(found, /src\/fixture-group\.ts:3: writeGroupOnly\(join\(slotsDir\(\), 'x\.json'\)\) on a path built from a slot-dir name/);
  assert.match(found, /src\/fixture-group\.ts:4: writeAgentReadable\(join\(slotsDir\(\), 'y\.json'\)\) on a path built from a slot-dir name/);
  const inWriter = lines(lintSlotWrites(files), 'src/slots.ts');
  assert.equal(inWriter.length, 2, inWriter.join('\n'));
  assert.match(inWriter[0]!, /w: writeGroupOnly\(tmp\) writes directly/);
  assert.match(inWriter[1]!, /w: writeOwnerOnly\(file\) writes directly/);
});

test('lint: a writer of a writer, a local helper, a computed fs key, destructured fs and a renamed join are still writes', () => {
  const files = srcFiles();
  files.set('src/fixture-wrap.ts', ["import { writeGroupOnly } from './os/index.js';", 'export function save(path: string, data: string) {', '  writeGroupOnly(path, data);', '}', ''].join('\n'));
  files.set(
    'src/cores.ts',
    `${files.get('src/cores.ts')!}\nimport * as fs from 'node:fs';\nimport { join as qjoin } from 'node:path';\nimport { save } from './fixture-wrap.js';\nconst { writeFileSync: put2 } = fs;\nconst put = (p: string) => fs.appendFileSync(p, 'x');\nexport const y = (slotsDir: string) => (save(qjoin(slotsDir, 'a'), ''), put(qjoin(slotsDir, 'b')), fs['writeFileSync'](qjoin(slotsDir, 'c'), ''), put2(qjoin(slotsDir, 'd'), ''));\n`,
  );
  const all = lintSlotWrites(files).filter((f) => f.file === 'src/cores.ts');
  assert.match(show(all), /hands a slot-dir path to src\/fixture-wrap\.ts, which is not reviewed/);
  assert.match(show(all), /put: appendFileSync\(p\) writes directly/, 'the local helper itself writes');
  const found = show(all.filter((f) => f.what.includes('on a path built'))).split('\n');
  assert.equal(found.length, 4, found.join('\n'));
  assert.match(found[0]!, /save\(qjoin\(slotsDir, 'a'\)\) on a path built from a slot-dir name/);
  assert.match(found[1]!, /put\(qjoin\(slotsDir, 'b'\)\) on a path built from a slot-dir name/);
  assert.match(found[2]!, /writeFileSync\(qjoin\(slotsDir, 'c'\)\) on a path built from a slot-dir name/);
  assert.match(found[3]!, /writeFileSync\(qjoin\(slotsDir, 'd'\)\) on a path built from a slot-dir name/, 'a destructured fs function is still a write');
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

/** A temp file a crashed writer left under this process's pid, 0444 (another user's, or a removal's): #661. */
const leftoverTemp = (path: string) => {
  writeFileSync(path, 'left by a crashed writer');
  chmodSync(path, 0o444);
};

const json = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;

/** The temp files in a dir: none is left once a write is done (a leftover planted by the test aside). */
const temps = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.tmp')).sort();

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

test("stopAll: a 0444 temp file at the old pid-only name (.STOP.<pid>.tmp) doesn't stop it", { skip }, () => {
  const dir = slotDir();
  const left = `.STOP.${process.pid}.tmp`;
  leftoverTemp(join(dir, left));
  stopAll('one', 'first', dir);
  assert.equal(emergencyStop(dir)?.reason, 'first');
  assert.deepEqual(temps(dir), [left], 'only the leftover: its own temp file is gone');
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
  assert.deepEqual(temps(dir), [], 'no temp file or claim left');
});

test("the machine superfan's state is replaced when it is 0444, and a 0444 temp file at the old pid-only name doesn't stop it", { skip }, async () => {
  const dir = slotDir();
  const stateFile = join(dir, 'superfan-machine.json');
  let now = new Date('2026-01-01T00:00:00Z');
  const pass = () =>
    superfanPass({ scope: 'machine', watching: 'the machine', stateFile, stateMode: 0o660, settings: { enabled: true, every_minutes: 10, daily_budget_usd: 1 }, read: () => ({ incidents: [], updates: [] }), judge: async () => ({ ok: false, costUsd: 0 }), post: async () => false, redact: (s) => s, now: () => now });
  const left = `superfan-machine.json.${process.pid}.tmp`;
  leftoverTemp(join(dir, left));
  assert.equal(await pass(), 'quiet');
  removalLeft(dir);
  now = new Date('2026-01-01T01:00:00Z');
  assert.equal(await pass(), 'quiet');
  assert.equal(json(stateFile).lastPassAt, now.toISOString());
  assert.deepEqual(temps(dir), [left], 'only the leftover');
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
  assert.deepEqual(temps(dir), []);
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
  assert.deepEqual(temps(dir), []);
});

test("a token's GitHub budget is replaced when it is 0444", { skip }, async () => {
  const dir = slotDir();
  const budget = new GitHubBudget('0123456789abcdef', dir, { maxWaitMs: 0 });
  await budget.take('backlog');
  staleLock(dir, 'github-budget-0123456789abcdef.lock');
  removalLeft(dir);
  await budget.take('backlog');
  assert.equal(budget.read().resources.core?.used.backlog, 2);
  assert.deepEqual(temps(dir), []);
});
