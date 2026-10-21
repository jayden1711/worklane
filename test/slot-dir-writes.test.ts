// lint-test
// Every write into the shared slot directory goes through one helper, writeSlotFile (src/slot-file.ts, #661).
// Removing an instance (#555, PR #601) takes group write off its files there, so any of them can be 0444 to everyone
// else. Replacing a file needs only the directory's group write; an in-place write (writeFileSync to the final name,
// an append, an open for write) gets EACCES (#616), and so does a temp file named by pid alone that a crashed writer
// left, once a new process gets the same pid. writeSlotFile writes a new temp file of its own (a random name, created
// exclusively) and renames or hard-links it into place.
//
// Three checks:
// - A lint over src/. Every module that names a slot-dir path, or hands one to another module, is reviewed in
//   REVIEWED below, so a new one fails here until someone has read it. Only writeSlotFile writes, and in the helper
//   the lint reports a chmod by name, a whole-file write or open without `wx` (but `writeFileSync` to the const its
//   exclusive open returned), a descriptor write, truncate or mode change on any descriptor but that const, and a
//   call of a repo writer, anywhere in the file (direct or aliased calls; not through `.call`/`Reflect.apply`). A writer, and a module that only reads there or hands
//   the path on, writes no file but through it, whatever the path: no fs write under the names this lint resolves
//   (an fs import, renamed or destructured; `fs['...']`; `const w = fs.writeFileSync`), and no direct call of a
//   function or method that writes a file named from one of its parameters. A module that also writes files
//   elsewhere (its state dir, a worktree) lists each of its own fs writes in its review, by function and target,
//   with how many there are, once someone has read it; any other fs write in it fails here. A write call the lint
//   resolves, given a path built from a slot-dir name (or from a local initialised from one: `const d = o.slotsDir`),
//   is reported in any module.
//   Not caught (#772, the slot-path type, is the fix): a `mixed` module handing another module's writing function a
//   slot-dir path that came in as a parameter, or that a local function returns (`const d = pick(o)`), or that a
//   local got by a later assignment (`let d; d = o.slotsDir`); a method called on a value not traced to its module
//   (a parameter, `this.store`, a call's result) with a path not built from a slot-dir name, and any such call by
//   element access (`o.st['save'](…)`); a slot-dir path kept in a property under another name (`this.dir = …`); a
//   writer called through `.call`/`.apply`/`Reflect.apply`; fs bound to a local from `createRequire`,
//   `getBuiltinModule` or `import()` and then destructured or read into a local; a descriptor write (`writeSync`,
//   `ftruncateSync`, `fchmodSync`) on a descriptor the module didn't open (only the open is a write call here).
// - Each writer, run against a temp slot dir in which every file is 0444 (what a removal leaves): it still succeeds,
//   and the file's content is replaced. A 0444 temp file at the pid-only name a writer used before doesn't stop it.
// - The helper, by what it does: the fs calls writeSlotFile makes synchronously, at top level, through node:fs and
//   node:fs/promises, in each mode and on each failure, recorded through wrappers on those modules, with the exact
//   sequence asserted (one exclusive create, every descriptor op on the descriptor it returned, nothing by name
//   before the rename or link, nothing after the close but the rename, link or cleanup), and the check itself
//   failed against wrong helpers. The helper is loaded with the wrappers in place, so fs functions it takes at its
//   own load time are wrappers too. And a taken temp name is skipped for a second random one (randomBytes).
//   Not caught by the call check (Known gap in #766, and #772): a call deferred past the write's return (a microtask,
//   process.nextTick, setImmediate, `import().then`, a FileHandle method); a call made inside another fs call (an
//   options getter), which is skipped as fs's own; child_process; an fs function another module kept before the
//   wrappers went on; fs past those modules (process.binding); a helper that tells the wrappers from the real
//   functions; anything on a path the cases don't drive (another export, a branch none of them takes). The helper is
//   in the hook import tree, so a change to it waits for the owner.
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import type { SlotWrite, writeSlotFile } from '../src/slot-file.js';
import { readSlotFile, type SlotPathLike } from '../src/slot-file.js';
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
// check-table: never-shrink
const SLOT_NAMES = new Set(['slotsDir', 'SYSTEM_SLOTS', 'AGENT_SLOTS_DIR', 'incidentsDir', 'claimsDir', 'machineDir', 'superfanSlots', 'updateDrainPath', 'slotsConfigPath']);
/** Calls that open a file for write. */
// check-table: never-shrink
const WRITE_CALLS = new Set(['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'createWriteStream', 'openSync', 'open', 'copyFileSync', 'copyFile', 'cpSync', 'cp', 'truncateSync', 'truncate']);
/** The one module that writes slot-dir files: a new temp file of its own (flag wx), renamed or linked into place. */
const HELPER = 'src/slot-file.ts';

/**
 * helper: HELPER. writer: writes slot-dir files, through the helper. passes: reads there, or hands the path on. Each
 * of these writes nothing else: any other write in it is reported, a call of a function that writes included.
 * mixed: hands the path on, and writes files elsewhere (its state dir, a worktree). Each of its own fs writes is
 * listed in `elsewhere` (`<function>: <call>(<target>)` → how many such calls there are, and what they write), once
 * read: one more than listed is reported, so a second write with the same text isn't let through by the first's
 * entry. A call there of a function that writes is reported when its path is built from a slot-dir name.
 */
type Review = { kind: 'helper' | 'writer' | 'passes'; why: string } | { kind: 'mixed'; why: string; elsewhere: Record<string, readonly [count: number, what: string]> };

/** Every src/ module that names a slot-dir path, hands one on, or is handed one. Add a module only after reading every write in it. */
// check-table: never-grow
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
      'runTestRun: writeFileSync(join(d.logDir, id, `fetch-${i + 1}.log`))': [1, "a fetch step's log, in the log dir"],
      'runTestRun: writeFileSync(join(d.logDir, id, `setup-${i + 1}.log`))': [1, "a setup step's log, in the log dir"],
      'runTestRun: writeFileSync(join(d.logDir, logRef))': [1, "a tier's log, in the log dir"],
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
      'writeAgentReadable: writeFileSync(file)': [1, "its caller's file (a task file, in the state dir)"],
      'writeGroupOnly: writeFileSync(file)': [1, "its caller's file (in the state dir)"],
      'writeOwnerOnly: writeFileSync(tmp)': [1, "its caller's file, through a temp file"],
      'writeExecutable: writeFileSync(tmp)': [1, 'a git hook or a launcher, through a temp file'],
      'installOwnerOnlySecret: writeFileSync(tmp)': [1, "a secret in the user's own 0700 dir"],
      'installSecretFor: writeFileSync(tmp)': [1, "a secret in a user's 0700 dir"],
      'installService: writeFileSync(path)': [2, 'a launchd plist, or a systemd user unit'],
      'replaceFileAtomically: writeFileSync(tmp)': [1, "its caller's file, through a temp file"],
    },
  },
  'src/os/system-paths.ts': { kind: 'passes', why: 'testSlotsRefusal compares the slot dir with the test machine; writes nothing' },
  'src/cores.ts': { kind: 'passes', why: 'reads slotStatus' },
  'src/coordinator.ts': { kind: 'mixed', why: 'hands its slot dir to slots.ts, incidents and post.ts', elsewhere: { 'reproduce: cpSync(join(workerPath, s.test_path))': [1, 'the reproduction test, into the worker worktree'] } },
  'src/coordinator/shared.ts': { kind: 'passes', why: 'the slotsDir option' },
  'src/coordinator/base.ts': { kind: 'mixed', why: 'reads STOP, the drain and slotStatus; writes the task file and live state (state dir) through os/index.ts', elsewhere: {} },
  'src/coordinator/landing.ts': { kind: 'mixed', why: 'fullRunLock; worktrees through the worktree manager', elsewhere: {} },
  'src/coordinator/fix-runs.ts': { kind: 'mixed', why: 'tryAgentSlot; worktrees through the worktree manager', elsewhere: {} },
  'src/coordinator/merge-flow.ts': { kind: 'mixed', why: 'takeOpsPost; auto-merge-stopped.json (state dir) through writeGroupOnly', elsewhere: {} },
  'src/dashboard.ts': {
    kind: 'mixed',
    why: 'reads slots, STOP and incidents; hands its slot dir to healthView (health.ts) for the GitHub budget',
    elsewhere: {
      'dashboardToken: writeFileSync(f)': [1, 'the dashboard token, in the state dir'],
      'fileDraft: writeFileSync(filedPath(opts.stateDir, id))': [2, "a chat draft's filed marker (while filing, then filed), in the state dir"],
      'startDashboard: writeFileSync(join(opts.stateDir, SKIPS_FILE))': [1, 'the skipped setup steps, in the state dir'],
      'startDashboard: writeFileSync(viewsFile)': [1, 'dashboard-views.json, in the state dir'],
    },
  },
  'src/disk-guard.ts': { kind: 'passes', why: 'hands an incidents dir to the incident store' },
  'src/watchdog/wire.ts': { kind: 'passes', why: 'reads the slot dir disk usage' },
  'src/demo.ts': {
    kind: 'mixed',
    why: 'a temp slot dir for a demo coordinator (its config.json through writeSlotFile)',
    elsewhere: {
      "agents: writeFileSync(join(req.cwd, 'test', 'repro-qty.test.js'))": [1, "a scripted agent's edit, in its worktree"],
      'agents: writeFileSync(p)': [1, "a scripted agent's edit, in its worktree"],
      "agents: writeFileSync(join(req.cwd, 'README.md'))": [1, "a scripted agent's edit, in its worktree"],
      "agents: writeFileSync(join(req.cwd, 'migrations', '001_orders.sql'))": [1, "a scripted agent's edit, in its worktree"],
      'seedDemo: cpSync(seed)': [1, 'the demo project, copied from the example'],
      "seedDemo: writeFileSync(join(seed, '.gitignore'))": [1, 'the demo project'],
      "seedDemo: writeFileSync(join(seed, 'test', 'legacy.test.js'))": [1, 'the demo project'],
      'seedDemo: writeFileSync(cfgFile)': [1, "the demo project's config"],
      'seedDemo: writeFileSync(dep)': [1, "the demo project's deploy config"],
    },
  },
  'src/harness-evals/replay.ts': {
    kind: 'mixed',
    why: 'a temp slot dir for a replay coordinator (its config.json through writeSlotFile)',
    elsewhere: { 'edit: writeFileSync(f)': [1, "the scratch clone's config"], 'overlayHarnessConfig: writeFileSync(f.to)': [1, "the scratch clone's harness config"] },
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

/** A local holding a slot-dir path under a name of its own (`const d = o.slotsDir`), and where that name applies. */
interface SlotLocal {
  name: string;
  scope: ts.Node;
}

/** `x` used as a name, not as a property (`o.x`) or a key (`{ x: 1 }`). */
const usedAsName = (x: ts.Identifier) => !(ts.isPropertyAccessExpression(x.parent) && x.parent.name === x) && !(ts.isPropertyAssignment(x.parent) && x.parent.name === x);

/**
 * Whether an argument carries a slot-dir name: directly, through a path built from one (`m.pathCalls`: the path
 * builders' names in its module, renamed imports included), or through a local that holds one (`m.slotLocals`). A
 * nested call of anything else, and a function's body, are their own: each such call is checked where it is.
 */
function mentionsSlot(n: ts.Node, m?: Pick<Mod, 'pathCalls' | 'slotLocals'>): boolean {
  const pathCalls = m?.pathCalls ?? PATH_CALLS;
  let hit = false;
  const visit = (x: ts.Node) => {
    if (hit || ts.isFunctionLike(x)) return;
    if ((ts.isIdentifier(x) || ts.isPrivateIdentifier(x)) && SLOT_NAMES.has(x.text.replace(/^#/, ''))) hit = true;
    else if (ts.isIdentifier(x) && usedAsName(x) && m?.slotLocals.some((l) => l.name === x.text && x.pos >= l.scope.pos && x.end <= l.scope.end)) hit = true;
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

const exclusive = (f: string | null | undefined) => typeof f === 'string' && f.includes('x');

/**
 * Why a write in the helper is not a new temp file of its own, created exclusively, or null. A whole-file write to
 * a descriptor (`writeFileSync(fd, …)`) is one when `fd` is the helper's own exclusive descriptor (`own`).
 */
function helperWrite(call: ts.CallExpression, name: string, own: (a: ts.Expression | undefined) => boolean): string | null {
  const a = call.arguments;
  if (name === 'writeFileSync' && own(a[0])) return null;
  const flag = /^writeFile(Sync)?$/.test(name) ? flagOf(a[2]) : /^(open(Sync)?|createWriteStream)$/.test(name) ? flagOf(a[1]) : undefined;
  return exclusive(flag) ? null : `${name}(${a[baseTarget(name)]?.getText()}) in the helper: it writes only a new temp file of its own, created exclusively (flag 'wx')`;
}

/** Calls that set a file's mode by its name: they follow a symlink. */
// check-table: never-shrink
const CHMOD_BY_NAME = new Set(['chmodSync', 'chmod', 'lchmodSync', 'lchmod']);

/** Calls that write, truncate or change the mode of the file behind a descriptor (their first argument). */
// check-table: never-shrink
const FD_WRITES = new Set(['writeSync', 'write', 'writev', 'writevSync', 'ftruncate', 'ftruncateSync', 'fchmod', 'fchmodSync']);

/** Every declaration of `name` in a function (or the module), its parameters included, outside nested functions. */
function declarationsIn(scope: ts.Node, name: string): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (x: ts.Node) => {
    if ((ts.isVariableDeclaration(x) || ts.isParameter(x) || ts.isBindingElement(x)) && ts.isIdentifier(x.name) && x.name.text === name) out.push(x);
    if (x === scope || !ts.isFunctionLike(x)) ts.forEachChild(x, visit);
  };
  visit(scope);
  return out;
}

/**
 * Whether an argument is the helper's own exclusive descriptor: a name whose one binding in the function it is used
 * in is a `const` initialised straight from an exclusive open (`const fd = openSync(tmp, 'wx', mode)`) and never
 * assigned. A parameter, a for-of variable, a destructured binding, a `let`, or a const of an outer function never is.
 * `helperWrite` and the FD_WRITES report use it; the round-3 review's binding evasions of it (B6d, B6e, B7c to B7e)
 * are listed in #766's Known gap, and the fs-call check below covers them on the paths it drives.
 */
function exclusiveFd(m: Mod, writers: Writers, a: ts.Expression | undefined): boolean {
  if (!a || !ts.isIdentifier(a)) return false;
  const scope = scopeOf(a);
  const decls = declarationsIn(scope, a.text);
  const d = decls[0];
  if (decls.length !== 1 || !d || !ts.isVariableDeclaration(d) || !ts.isVariableDeclarationList(d.parent) || !(d.parent.flags & ts.NodeFlags.Const)) return false;
  if (ts.isForOfStatement(d.parent.parent) || ts.isForInStatement(d.parent.parent) || !d.initializer || !ts.isCallExpression(d.initializer)) return false;
  const w = writeOf(m, d.initializer, writers);
  if (!w || w.via || w.name !== 'openSync' || !exclusive(flagOf(d.initializer.arguments[1]))) return false;
  let assigned = false;
  const visit = (x: ts.Node) => {
    const target = ts.isBinaryExpression(x) && x.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && x.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? x.left : (ts.isPrefixUnaryExpression(x) || ts.isPostfixUnaryExpression(x)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(x.operator) ? x.operand : null;
    if (target && ts.isIdentifier(target) && target.text === a.text) assigned = true;
    if (x === scope || !ts.isFunctionLike(x)) ts.forEachChild(x, visit);
  };
  visit(scope);
  return !assigned;
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
  /**
   * An fs function under its local name (`import { writeFileSync as put }`, `const { writeFileSync: put } = fs`,
   * `const put = fs.writeFileSync`): its fs name.
   */
  fsAlias: Map<string, string>;
  /** The path builders' local names (`import { join as j }` included). */
  pathCalls: Set<string>;
  /** Locals that hold a slot-dir path, or a path built from one (`const d = o.slotsDir`, `const { slotsDir: d } = o`). */
  slotLocals: SlotLocal[];
  /** Classes and object literals declared here, by name: their methods are this module's. */
  objects: Set<string>;
  /** A local holding an instance or an alias of a class or object (`const st = new Store()`): the module of its methods. */
  instances: Map<string, string>;
}

/**
 * The module whose methods a value has, when this lint can tell: `this`, a class or object declared or imported
 * here (`Store`, `store`), a new one (`new Store()`), or a local holding one. A parameter, a property
 * (`this.store`) or a call's result is not traced.
 */
function moduleOf(m: Mod, e: ts.Expression): string | null {
  if (e.kind === ts.SyntaxKind.ThisKeyword) return m.file;
  if (ts.isParenthesizedExpression(e)) return moduleOf(m, e.expression);
  if (ts.isNewExpression(e)) return moduleOf(m, e.expression);
  if (!ts.isIdentifier(e)) return null;
  return m.imported.get(e.text)?.mod ?? m.instances.get(e.text) ?? (m.objects.has(e.text) ? m.file : null);
}

/** Parsed once per text: each test lints all of src/ with a file or two changed. */
const parsed = new Map<string, Mod>();

function parseMod(file: string, text: string): Mod {
  const hit = parsed.get(file);
  if (hit?.text === text) return hit;
  const m: Mod = { file, text, src: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), imported: new Map(), namespaces: new Map(), fsAlias: new Map(), pathCalls: new Set(PATH_CALLS), slotLocals: [], objects: new Set(), instances: new Map() };
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
  /** The fs function an expression is (`fs.writeFileSync`, `fs['writeFileSync']`, a local alias, `….bind(fs)`), or null. */
  const fsFunction = (e: ts.Expression): string | null => {
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'bind') return fsFunction(e.expression.expression);
    if (ts.isIdentifier(e)) return m.fsAlias.get(e.text) ?? null;
    const root = calleeRoot(e);
    return root && fsWhole.has(root) ? calleeName(e) : null;
  };
  const objects = (n: ts.Node) => {
    if ((ts.isClassDeclaration(n) && n.name) || (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isObjectLiteralExpression(n.initializer) || ts.isClassExpression(n.initializer)))) m.objects.add((n.name as ts.Identifier).text);
    ts.forEachChild(n, objects);
  };
  objects(m.src);
  const aliases = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      if (ts.isObjectBindingPattern(n.name) && ts.isIdentifier(n.initializer) && fsWhole.has(n.initializer.text)) {
        for (const e of n.name.elements) if (ts.isIdentifier(e.name)) m.fsAlias.set(e.name.text, e.propertyName ? e.propertyName.getText() : e.name.text);
      }
      const fn = ts.isIdentifier(n.name) ? fsFunction(n.initializer) : null;
      if (fn) m.fsAlias.set((n.name as ts.Identifier).text, fn);
      const owner = ts.isIdentifier(n.name) && (ts.isNewExpression(n.initializer) || ts.isIdentifier(n.initializer)) ? moduleOf(m, n.initializer) : null;
      if (owner) m.instances.set((n.name as ts.Identifier).text, owner);
    }
    ts.forEachChild(n, aliases);
  };
  aliases(m.src);
  m.slotLocals = slotLocals(m);
  parsed.set(file, m);
  return m;
}

/** The nearest function (or the module) a node is in: where a local declared there is seen. */
function scopeOf(n: ts.Node): ts.Node {
  for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p) || ts.isSourceFile(p)) return p;
  return n.getSourceFile();
}

/**
 * The locals in a module that hold a slot-dir path: initialized from a slot-dir name (or from such a local), or
 * destructured from one (`const { slotsDir: d } = o`). Repeated until nothing new is found.
 */
function slotLocals(m: Pick<Mod, 'src' | 'pathCalls'>): SlotLocal[] {
  const decls: ts.VariableDeclaration[] = [];
  const out: SlotLocal[] = [];
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n)) {
      decls.push(n);
      if (ts.isObjectBindingPattern(n.name)) {
        for (const e of n.name.elements) if (ts.isIdentifier(e.name) && SLOT_NAMES.has((e.propertyName ?? e.name).getText())) out.push({ name: e.name.text, scope: scopeOf(n) });
      }
    }
    ts.forEachChild(n, collect);
  };
  collect(m.src);
  const known = new Set<ts.VariableDeclaration>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of decls) {
      if (known.has(d) || !ts.isIdentifier(d.name) || !d.initializer || !mentionsSlot(d.initializer, { pathCalls: m.pathCalls, slotLocals: out })) continue;
      known.add(d);
      out.push({ name: d.name.text, scope: scopeOf(d) });
      changed = true;
    }
  }
  return out;
}

/** A parameter a file name is built from: its index, and the option it is read from (`o.dir`), if one. */
interface Param {
  i: number;
  prop?: string;
}

/**
 * Functions that write a file named from one of their parameters: module → function name → that parameter. `fns`:
 * plain functions. `methods`: a class's or an object literal's methods, called on a value `moduleOf` traces to the
 * module (`new Store().save(…)`, `store.save(…)`, `this.save(…)`).
 */
interface Writers {
  fns: Map<string, Map<string, Param>>;
  methods: Map<string, Map<string, Param>>;
}

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
  const wrapped = (mod: string, n: string, kind: 'fns' | 'methods' = 'fns'): Write | null => {
    const p = writers[kind].get(mod)?.get(n);
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
  if (ns) return wrapped(ns, name);
  const owner = ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) ? moduleOf(m, e.expression) : null;
  return (owner ? wrapped(owner, name, 'methods') : null) ?? base(name);
}

const isFunctionValue = (e: ts.Node | undefined): e is ts.ArrowFunction | ts.FunctionExpression => !!e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e));

/**
 * A named function: `function f() {}`, or `const f = () => {}` / `function () {}`; or a method (`method: true`): a
 * class's or an object literal's (`save() {}`, `save = () => {}`, `save: () => {}`).
 */
function namedFunction(n: ts.Node): { name: string; fn: ts.SignatureDeclaration; method: boolean } | null {
  if (ts.isFunctionDeclaration(n) && n.name && n.body) return { name: n.name.text, fn: n, method: false };
  if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && isFunctionValue(n.initializer)) return { name: n.name.text, fn: n.initializer, method: false };
  const key = (ts.isMethodDeclaration(n) || ts.isPropertyDeclaration(n) || ts.isPropertyAssignment(n)) && (ts.isIdentifier(n.name) || ts.isStringLiteralLike(n.name) || ts.isPrivateIdentifier(n.name)) ? n.name.text : null;
  if (key === null) return null;
  if (ts.isMethodDeclaration(n) && n.body) return { name: key, fn: n, method: true };
  if ((ts.isPropertyDeclaration(n) || ts.isPropertyAssignment(n)) && isFunctionValue(n.initializer)) return { name: key, fn: n.initializer, method: true };
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
  const writers: Writers = { fns: new Map(), methods: new Map() };
  for (let changed = true; changed; ) {
    changed = false;
    for (const m of mods) {
      if (m.file === HELPER) continue;
      const visit = (n: ts.Node) => {
        const f = namedFunction(n);
        if (f && !writers[f.method ? 'methods' : 'fns'].get(m.file)?.has(f.name)) {
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
            const kind = writers[f.method ? 'methods' : 'fns'];
            if (!kind.has(m.file)) kind.set(m.file, new Map());
            kind.get(m.file)!.set(f.name, written);
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
    /** In a mixed module: how many times each listed write was found so far. */
    const seen = new Map<string, number>();
    const own = (a: ts.Expression | undefined) => exclusiveFd(m, writers, a);
    let slot = false;
    const visit = (n: ts.Node) => {
      if ((ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) && SLOT_NAMES.has(n.text.replace(/^#/, ''))) slot = true;
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const args = n.arguments ?? [];
        const hands = args.some((a) => mentionsSlot(a, m));
        const w = ts.isCallExpression(n) ? writeOf(m, n, writers) : null;
        if (!w && ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
          // A method called on a value not traced to its module: a writing method by that name anywhere, given a
          // slot-dir path, is reported (its other calls can't be told apart from any other method's).
          const name = n.expression.name.text;
          for (const [mod, ms] of writers.methods) {
            const p = ms.get(name);
            const t = p ? targetOf(n, { name, target: p, via: mod }) : undefined;
            if (t && mentionsSlot(t, m)) {
              at(n, `${name}(${t.getText()}) on a path built from a slot-dir name, and a method by that name in ${mod} writes the file it is given: write it with writeSlotFile (${HELPER})`);
              break;
            }
          }
        }
        if (file === HELPER && ts.isCallExpression(n)) {
          const name = calleeName(n.expression) ?? '';
          const fsName = ts.isIdentifier(n.expression) ? m.fsAlias.get(name) : name;
          if (fsName && CHMOD_BY_NAME.has(fsName)) at(n, `${fsName}(${n.arguments[0]?.getText() ?? ''}) in the helper: it sets a mode only through the descriptor of its own exclusive open (fchmodSync), never by name`);
          const fdName = ts.isIdentifier(n.expression) ? (m.fsAlias.get(name) ?? name) : name;
          if (FD_WRITES.has(fdName) && !own(n.arguments[0])) at(n, `${fdName}(${n.arguments[0]?.getText() ?? ''}) in the helper: it writes only to its own exclusive descriptor, a const bound in the same function to openSync(tmp, 'wx', …)`);
        }
        if (w && ts.isCallExpression(n)) {
          const t = targetOf(n, w);
          const what = `${w.name}(${t?.getText() ?? ''})`;
          const key = `${ownerName(n)}: ${what}`;
          if (file === HELPER) {
            // A second layer next to the fs-call check at the end of this file: these match code anywhere in the
            // helper, off the paths that check drives included.
            const why = w.via ? `${what} in the helper: it writes only through fs, a new temp file of its own` : helperWrite(n, w.name, own);
            if (why) at(n, why);
          } else if (t && mentionsSlot(t, m)) at(n, `${what} on a path built from a slot-dir name: write it with writeSlotFile (${HELPER})`);
          else if (review?.kind === 'mixed') {
            const listed = review.elsewhere[key]?.[0] ?? 0;
            const found = (seen.get(key) ?? 0) + 1;
            if (w.via) {
              // another function's write: checked above, by its path
            } else if (found <= listed) seen.set(key, found);
            else if (listed > 0) at(n, `${key} is listed as a write elsewhere ${listed} time(s), and this is one more: read it, then raise its count in REVIEWED`);
            else at(n, `${key} writes directly, and is not listed: list it as a write elsewhere in REVIEWED once read (the slot dir is written only through writeSlotFile, ${HELPER})`);
          } else if (review) at(n, `${key} writes directly: this module writes no file but through writeSlotFile (${HELPER})`);
        }
        if (hands) {
          const e = n.expression;
          const root = calleeRoot(e);
          const mod = ts.isIdentifier(e) ? m.imported.get(e.text)?.mod : ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) ? ((root ? m.namespaces.get(root) : undefined) ?? moduleOf(m, e.expression)) : undefined;
          if (mod && !REVIEWED[mod]) at(n, `hands a slot-dir path to ${mod}, which is not reviewed: add it to REVIEWED after reading its writes`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
    for (const [key, [listed]] of Object.entries(review?.kind === 'mixed' ? review.elsewhere : {})) {
      const found = seen.get(key) ?? 0;
      if (found === 0) out.push({ file, line: 0, what: `${key}: listed as a write elsewhere but not found: drop it from REVIEWED` });
      else if (found < listed) out.push({ file, line: 0, what: `${key}: listed as a write elsewhere ${listed} times but found ${found}: lower its count in REVIEWED` });
    }
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
  // writeIncidents now writes a file named from its dir: each call of it (and of withIncidents) is a write too. In
  // withIncidents, its dir is `const d = incidentsDir(dir)`: a local that holds a slot-dir path.
  assert.deepEqual(
    found.slice(1).map((l) => l.replace(/^\d+: /, '')),
    [
      `writeIncidents(d) on a path built from a slot-dir name: write it with writeSlotFile (${HELPER})`,
      ...['raiseIncident: withIncidents(o.dir)', 'resolveIncident: withIncidents(o.dir)'].map((w) => `${w} writes directly: this module writes no file but through writeSlotFile (${HELPER})`),
    ],
  );
});

test('lint: a write in a pass-through module from a parameter (budget-health read(), #676) is reported', () => {
  const files = srcFiles();
  const before = files.get('src/github/budget-health.ts')!;
  // Since #772 budget-health reads through src/slot-file.ts and imports no fs: the mutant brings its own import.
  const anchors = ['    const file = slotFile(dir, name);\n', "import { readRegularFile, slotsDir } from '../os/index.js';\n"];
  for (const a of anchors) assert.equal(before.split(a).length, 2, `the mutation's anchor is in budget-health.ts once: ${a}`);
  const mutant = before.replace(anchors[0]!, `${anchors[0]!}    writeFileSync(join(dir, name), '{}');\n`).replace(anchors[1]!, `import { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\n${anchors[1]!}`);
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

test("lint: a class's methods that write their parameter (a method, a property arrow) are writes where they are called (#766 review, probe A)", () => {
  const files = srcFiles();
  files.set('src/fixture-store.ts', ["import { appendFileSync, writeFileSync } from 'node:fs';", 'export class Store {', '  save(file: string) {', "    writeFileSync(file, 'x');", '  }', "  put = (f: string) => appendFileSync(f, 'x');", '  again(file: string) {', '    this.save(file);', '  }', '}', ''].join('\n'));
  files.set(
    'src/slots.ts',
    `${files.get('src/slots.ts')!}\nimport { Store } from './fixture-store.js';\nexport const pa = () => new Store().save(join(slotsDir(), 'a.json'));\nconst st = new Store();\nexport const pa2 = (dir: string) => st.save(join(dir, 'a2.json'));\nexport const pa3 = (dir: string) => (st.put(join(dir, 'a3.json')), st.again(join(dir, 'a4.json')));\nexport const pa4 = (o: { st: Store }) => o.st.save(join(slotsDir(), 'a5.json'));\n`,
  );
  const found = lines(lintSlotWrites(files), 'src/slots.ts').map((l) => l.replace(/^\d+: /, ''));
  assert.deepEqual(found, [
    `save(join(slotsDir(), 'a.json')) on a path built from a slot-dir name: write it with writeSlotFile (${HELPER})`,
    'hands a slot-dir path to src/fixture-store.ts, which is not reviewed: add it to REVIEWED after reading its writes',
    `pa2: save(join(dir, 'a2.json')) writes directly: this module writes no file but through writeSlotFile (${HELPER})`,
    `pa3: put(join(dir, 'a3.json')) writes directly: this module writes no file but through writeSlotFile (${HELPER})`,
    `pa3: again(join(dir, 'a4.json')) writes directly: this module writes no file but through writeSlotFile (${HELPER})`,
    // o.st is not traced to its module: a slot-dir path given to a writing method by that name is still reported.
    `save(join(slotsDir(), 'a5.json')) on a path built from a slot-dir name, and a method by that name in src/fixture-store.ts writes the file it is given: write it with writeSlotFile (${HELPER})`,
  ]);
});

test("lint: an object literal's methods that write their parameter are writes where they are called (#766 review, probe B)", () => {
  const files = srcFiles();
  files.set('src/fixture-obj.ts', ["import { writeFileSync } from 'node:fs';", "export const store = { save(f: string) { writeFileSync(f, 'x'); }, put: (f: string) => writeFileSync(f, 'y') };", ''].join('\n'));
  files.set('src/slots.ts', `${files.get('src/slots.ts')!}\nimport { store } from './fixture-obj.js';\nexport const pb = () => store.save(join(slotsDir(), 'b.json'));\nexport const pb2 = (dir: string) => store.put(join(dir, 'b2.json'));\n`);
  const found = lines(lintSlotWrites(files), 'src/slots.ts').map((l) => l.replace(/^\d+: /, ''));
  assert.deepEqual(found, [
    `save(join(slotsDir(), 'b.json')) on a path built from a slot-dir name: write it with writeSlotFile (${HELPER})`,
    'hands a slot-dir path to src/fixture-obj.ts, which is not reviewed: add it to REVIEWED after reading its writes',
    `pb2: put(join(dir, 'b2.json')) writes directly: this module writes no file but through writeSlotFile (${HELPER})`,
  ]);
});

test('lint: a slot dir copied to a local first (const d = o.slotsDir, or destructured) is still a slot-dir path (#766 review, probe D)', () => {
  const files = srcFiles();
  files.set(
    'src/dashboard.ts',
    `${files.get('src/dashboard.ts')!}\nimport { writeGroupOnly as wgo } from './os/index.js';\nimport { join as pj } from 'node:path';\nexport function gapD(o: { slotsDir: string }) {\n  const d = o.slotsDir;\n  const f = pj(d, 'd2.json');\n  wgo(pj(d, 'd.json'), '{}');\n  wgo(f, '{}');\n}\nexport function gapD2(o: { slotsDir: string }) {\n  const { slotsDir: e } = o;\n  wgo(pj(e, 'e.json'), '{}');\n}\nexport function notD(d: string) {\n  wgo(pj(d, 'state.json'), '{}');\n}\n`,
  );
  const found = lines(lintSlotWrites(files), 'src/dashboard.ts').map((l) => l.replace(/^\d+: /, ''));
  assert.deepEqual(
    found,
    [`writeGroupOnly(pj(d, 'd.json'))`, 'writeGroupOnly(f)', `writeGroupOnly(pj(e, 'e.json'))`].map((w) => `${w} on a path built from a slot-dir name: write it with writeSlotFile (${HELPER})`),
    "a local's name in another function is not the slot dir",
  );
});

test('lint: an fs function bound to a local (const w = fs.writeFileSync) is still a write (#766 review, probe E)', () => {
  const files = srcFiles();
  files.set(
    'src/slots.ts',
    `${files.get('src/slots.ts')!}\nimport * as fsx from 'node:fs';\nexport const pe = (dir: string) => {\n  const w = fsx.writeFileSync;\n  w(dir + '/e.json', '');\n};\nconst a2 = fsx['appendFileSync'].bind(fsx);\nconst a3 = a2;\nexport const pe2 = (dir: string) => a3(dir + '/e2.json', '');\n`,
  );
  const found = lines(lintSlotWrites(files), 'src/slots.ts').map((l) => l.replace(/^\d+: /, ''));
  assert.deepEqual(found, [`pe: writeFileSync(dir + '/e.json') writes directly: this module writes no file but through writeSlotFile (${HELPER})`, `pe2: appendFileSync(dir + '/e2.json') writes directly: this module writes no file but through writeSlotFile (${HELPER})`]);
});

test('lint: a write in a module that writes elsewhere is counted: one more than listed is reported, even with the same text', () => {
  const files = srcFiles();
  const before = files.get('src/harness-evals/replay.ts')!;
  const mutant = before.replace('    writeFileSync(f, d.toString());\n', '    writeFileSync(f, d.toString());\n    writeFileSync(f, d.toString());\n');
  assert.notEqual(mutant, before, 'the mutation applies');
  files.set('src/harness-evals/replay.ts', mutant);
  assert.deepEqual(lines(lintSlotWrites(files), 'src/harness-evals/replay.ts'), [
    `${before.slice(0, before.indexOf('    writeFileSync(f, d.toString());\n')).split('\n').length + 1}: edit: writeFileSync(f) is listed as a write elsewhere 1 time(s), and this is one more: read it, then raise its count in REVIEWED`,
  ]);
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

test('lint: in the helper, a write to the descriptor of its own exclusive open is allowed; a chmod by name, and a whole-file write to any other descriptor, are reported', () => {
  const files = srcFiles();
  const body = [
    "import { chmodSync as cm, fchmodSync, openSync as op, writeFileSync as wf } from 'node:fs';",
    'export function v(file: string, other: number) {',
    "  const fd = op(file, 'wx', 0o600);",
    '  fchmodSync(fd, 0o600);',
    "  wf(fd, 'x');",
    "  let g = op(file, 'wx');",
    '  g = other;',
    "  wf(g, 'x');",
    "  wf(other, 'x');",
    '  cm(file, 0o660);',
    '}',
    '',
  ].join('\n');
  files.set(HELPER, `${files.get(HELPER)!}\n${body}`);
  const found = lines(lintSlotWrites(files), HELPER).map((l) => l.replace(/^\d+: /, ''));
  assert.deepEqual(found, [
    "writeFileSync(g) in the helper: it writes only a new temp file of its own, created exclusively (flag 'wx')",
    "writeFileSync(other) in the helper: it writes only a new temp file of its own, created exclusively (flag 'wx')",
    'chmodSync(file) in the helper: it sets a mode only through the descriptor of its own exclusive open (fchmodSync), never by name',
  ]);
});

/** What the lint reports in the helper with `body` appended to it (fixture text: no file is written), lines dropped. */
function inHelper(...body: string[]): string[] {
  const files = srcFiles();
  const imports = [
    "import { appendFileSync as afs, chmodSync as cms, copyFileSync as cfs, fchmodSync as fcm, ftruncateSync, openSync as op, truncateSync as tfs, writeFileSync as wf, writeSync, writevSync } from 'node:fs';",
    "import { writeGroupOnly as wgo } from './os/index.js';",
  ].join('\n');
  files.set(HELPER, `${files.get(HELPER)!}\n${imports}\n${body.join('\n')}\n`);
  return lines(lintSlotWrites(files), HELPER).map((l) => l.replace(/^\d+: /, ''));
}
const wholeWrite = (w: string) => `${w} in the helper: it writes only a new temp file of its own, created exclusively (flag 'wx')`;
const fdWrite = (w: string) => `${w} in the helper: it writes only to its own exclusive descriptor, a const bound in the same function to openSync(tmp, 'wx', …)`;

test("lint: in the helper, a parameter named like tempWith's exclusive fd is not its own descriptor (#766 review, H1)", () => {
  assert.deepEqual(inHelper('export function h1(fd: number) {', "  wf(fd, 'x');", '}'), [wholeWrite('writeFileSync(fd)')]);
});

test('lint: in the helper, writeSync to any other descriptor is reported (#766 review, H2)', () => {
  assert.deepEqual(inHelper('export function h2(other: number) {', "  writeSync(other, 'x');", '}'), [fdWrite('writeSync(other)')]);
});

test('lint: in the helper, a non-exclusive open and a write to its descriptor are reported (#766 review, H3, a control)', () => {
  assert.deepEqual(inHelper('export function h3(file: string) {', "  const g = op(file, 'r+');", "  wf(g, 'x');", '}'), [wholeWrite('openSync(file)'), wholeWrite('writeFileSync(g)')]);
});

test('lint: in the helper, a for-of variable named fd is not its own descriptor (#766 review, H4)', () => {
  assert.deepEqual(inHelper('export function h4(fds: number[]) {', "  for (const fd of fds) wf(fd, 'x');", '}'), [wholeWrite('writeFileSync(fd)')]);
});

test('lint: in the helper, ftruncateSync and fchmodSync on any other descriptor are reported (#766 review, H5)', () => {
  assert.deepEqual(inHelper('export function h5(other: number) {', '  ftruncateSync(other, 0);', '  fcm(other, 0o666);', '}'), [fdWrite('ftruncateSync(other)'), fdWrite('fchmodSync(other)')]);
});

test('lint: in the helper, writevSync on any other descriptor is reported (#766 round-5 review)', () => {
  assert.deepEqual(inHelper('export function wv(other: number) {', '  writevSync(other, []);', '}'), [fdWrite('writevSync(other)')]);
});

test("lint: in the helper, a descriptor is its own only as a const bound to its exclusive open in the same function: not destructured, not a let, not from a closure", () => {
  const found = inHelper(
    'export function own(file: string) {',
    "  const [d] = [op(file, 'wx')];",
    "  writeSync(d, 'x');",
    "  let l = op(file, 'wx');",
    "  writeSync(l, 'x');",
    "  const fd = op(file, 'wx', 0o600);",
    '  fcm(fd, 0o600);',
    '  ftruncateSync(fd, 0);',
    "  writeSync(fd, 'x');",
    '  writevSync(fd, []);',
    "  wf(fd, 'x');",
    "  return () => writeSync(fd, 'y');",
    '}',
  );
  assert.deepEqual(found, [fdWrite('writeSync(d)'), fdWrite('writeSync(l)'), fdWrite('writeSync(fd)')], 'the const itself is allowed every descriptor write; the closure is not');
});

// The round-4 review's L1 to L7: code anywhere in the helper, off the paths the fs-call check drives included.
test('lint: in the helper, a chmod by name in another export is reported (#766 review, L1)', () => {
  assert.deepEqual(inHelper('export function chmodSlot(f: string) { cms(f, 0o666); }'), ['chmodSync(f) in the helper: it sets a mode only through the descriptor of its own exclusive open (fchmodSync), never by name']);
});

test('lint: in the helper, an in-place write on a branch no fs-call case takes is reported (#766 review, L2)', () => {
  assert.deepEqual(inHelper('export function big(file: string, data: string) { if (data.length > 1e6) wf(file, data); }'), [wholeWrite('writeFileSync(file)')]);
});

test('lint: in the helper, an append, an open for write, a truncate and a copy onto a name are reported (#766 review, L3, L4, L6, L7)', () => {
  assert.deepEqual(inHelper("export function l3(file: string) { afs(file, 'x'); }"), [wholeWrite('appendFileSync(file)')]);
  assert.deepEqual(inHelper("export function l4(file: string) { return op(file, 'r+'); }"), [wholeWrite('openSync(file)')]);
  assert.deepEqual(inHelper('export function l6(file: string) { tfs(file, 0); }'), [wholeWrite('truncateSync(file)')]);
  assert.deepEqual(inHelper('export function l7(a: string, file: string) { cfs(a, file); }'), [wholeWrite('copyFileSync(file)')]);
});

test("lint: in the helper, a call of the repo's own writers is reported (#766 review, L5)", () => {
  assert.deepEqual(inHelper("export function l5(file: string) { wgo(file, 'x'); }"), ['writeGroupOnly(file) in the helper: it writes only through fs, a new temp file of its own']);
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

const json = (p: SlotPathLike) => JSON.parse(readSlotFile(p)) as Record<string, unknown>;

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

// ---------------------------------------------------------------------------------------------------------------
// The helper, by what it does: the synchronous, top-level fs calls writeSlotFile makes (#766 review, round 4; the
// lint's helper checks above stay as a second layer, round 5). It lives here, in an engine-guards file, so weakening
// it waits for the owner too. What it doesn't see is in the header's "Not caught by the call check".

type SlotWriter = typeof writeSlotFile;
type Fns = Record<string, (...a: never[]) => unknown>;

interface Call {
  name: string;
  args: unknown[];
  /** What an openSync returned. */
  fd?: number;
  /** The code of what it threw. */
  error?: string;
}

/** Make the first `times` calls of fs's `name` throw `code` instead of running. */
type Fail = { name: string; code: string; times?: number };

const DATA = 'slot-file-call-test-data';

/** The recording under way, if any. */
let recording: { calls: Call[]; depth: number; fail: Fail | undefined; failed: number } | null = null;

/**
 * Every function of node:fs and node:fs/promises, with a wrapper that records its calls while `recording` is set and
 * otherwise just calls it. Classes (Stats, ReadStream, ...) are left as they are. A call made inside another fs call
 * is not recorded: that is how writeFileSync calling writeSync stays out, but it also hides anything the helper runs
 * from inside one (an options getter; Known gap). The wrappers are made once: a module loaded while they are in place
 * keeps them in anything it took from fs then (`const w = writeFileSync`); a module loaded before does not.
 */
const WRAPPERS = (() => {
  const req = createRequire(import.meta.url);
  const out: { mod: Fns; name: string; real: Fns[string]; wrapper: Fns[string] }[] = [];
  for (const mod of [req('node:fs'), req('node:fs/promises')] as Fns[]) {
    for (const name of Object.keys(mod)) {
      const real = mod[name];
      if (typeof real !== 'function' || /^[A-Z]/.test(name)) continue;
      const wrapper = function (this: unknown, ...args: never[]): unknown {
        const r = recording;
        if (!r || r.depth > 0) return Reflect.apply(real, this, args);
        const c: Call = { name, args: [...args] };
        r.calls.push(c);
        r.depth++;
        try {
          if (r.fail?.name === name && r.failed < (r.fail.times ?? 1)) {
            r.failed++;
            throw Object.assign(new Error(`simulated ${r.fail.code}`), { code: r.fail.code });
          }
          const result = Reflect.apply(real, this, args);
          if (name === 'openSync') c.fd = result as number;
          return result;
        } catch (e) {
          c.error = (e as NodeJS.ErrnoException).code ?? String(e);
          throw e;
        } finally {
          r.depth--;
        }
      };
      out.push({ mod, name, real, wrapper: Object.assign(wrapper, real) });
    }
  }
  return out;
})();

/** Put the wrappers in place of fs's functions (their ESM bindings too, which is how the helper imports them), or back. */
function wrappers(on: boolean): void {
  for (const w of WRAPPERS) w.mod[w.name] = on ? w.wrapper : w.real;
  syncBuiltinESMExports();
}

/** Load a module (a fresh instance) while the wrappers are in place. */
async function loadWrapped(url: string): Promise<SlotWriter> {
  wrappers(true);
  try {
    return ((await import(url)) as { writeSlotFile: SlotWriter }).writeSlotFile;
  } finally {
    wrappers(false);
  }
}

/** The helper under test: a fresh instance of src/slot-file.ts, loaded with the wrappers in place. */
const underTest = await loadWrapped(new URL('../src/slot-file.js?fs-calls', import.meta.url).href);

/** Run `write` and return the fs calls it made, in order, and the code of what it threw. */
function recordCalls(write: SlotWriter, file: string, o: SlotWrite, fail?: Fail): { calls: Call[]; error?: string } {
  const r = (recording = { calls: [], depth: 0, fail, failed: 0 });
  wrappers(true);
  try {
    write(file, DATA, o);
    return { calls: r.calls };
  } catch (e) {
    return { calls: r.calls, error: (e as NodeJS.ErrnoException).code ?? String(e) };
  } finally {
    wrappers(false);
    recording = null;
  }
}

/**
 * The calls as text: the temp names TMP, TMP2, ... in the order they appear; the target FILE; the content DATA; the
 * descriptor the first open returned FD, any other `fd <n>`; any other number (a mode) in octal.
 */
function render(calls: Call[], file: string): string[] {
  const tmpName = new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.${process.pid}\\.[0-9a-f]{16}\\.tmp$`);
  const tmps: string[] = [];
  const fd = calls.find((c) => c.name === 'openSync' && c.fd !== undefined)?.fd;
  const showFd = (n: number) => (n === fd ? 'FD' : `fd ${n}`);
  const show = (v: unknown, i: number): string => {
    if (typeof v === 'number') return i === 0 ? showFd(v) : `0o${v.toString(8)}`;
    if (typeof v !== 'string') return v === undefined ? 'undefined' : JSON.stringify(v);
    if (v === file) return 'FILE';
    if (v === DATA) return 'DATA';
    if (!tmpName.test(v)) return JSON.stringify(v);
    if (!tmps.includes(v)) tmps.push(v);
    return tmps.indexOf(v) === 0 ? 'TMP' : `TMP${tmps.indexOf(v) + 1}`;
  };
  return calls.map((c) => `${c.name}(${c.args.map(show).join(', ')})${c.error ? ` throws ${c.error}` : c.fd !== undefined ? ` -> ${showFd(c.fd)}` : ''}`);
}

/**
 * Which of the helper's rules a call sequence breaks, one line per offending call ([] when it keeps them all):
 * - every call on a descriptor uses the one the exclusive open returned;
 * - every open is an exclusive create (flag 'wx') of a new temp name beside the file;
 * - nothing touches a file by name (the temp file, the target or any other) before the rename or link, but the
 *   open and, once something has failed, the removal of its own temp file;
 * - after the close, only the rename or link of the temp file to the target, and the removal of the temp file.
 */
function broken(calls: Call[], shown: string[], file: string): string[] {
  const out: string[] = [];
  const opened = calls.findIndex((c) => c.name === 'openSync' && c.fd !== undefined);
  const fd = calls[opened]?.fd;
  const tmp = calls[opened]?.args[0];
  const place = calls.findIndex((c) => c.name === 'renameSync' || c.name === 'linkSync');
  const closed = calls.findIndex((c) => c.name === 'closeSync' && c.args[0] === fd);
  const cleanup = (c: Call, i: number) => c.name === 'rmSync' && c.args[0] === tmp && calls.slice(opened + 1, i).some((x) => x.error);
  calls.forEach((c, i) => {
    const byName = typeof c.args[0] !== 'number';
    if (!byName && c.args[0] !== fd) out.push(`${shown[i]}: a descriptor other than the one its exclusive open returned`);
    if (c.name === 'openSync' && (c.args[1] !== 'wx' || typeof c.args[0] !== 'string' || !shown[i]!.startsWith('openSync(TMP'))) out.push(`${shown[i]}: not an exclusive create (flag "wx") of a new temp name`);
    if (byName && c.name !== 'openSync' && (place === -1 || i < place) && !cleanup(c, i)) out.push(`${shown[i]}: touches a file by name before the rename or link`);
    if (closed !== -1 && i > closed && !(((c.name === 'renameSync' || c.name === 'linkSync') && c.args[0] === tmp && c.args[1] === file) || (c.name === 'rmSync' && c.args[0] === tmp))) out.push(`${shown[i]}: after its descriptor is closed`);
  });
  if (fd !== undefined && closed === -1) out.push('its descriptor is never closed');
  return out;
}

interface Case {
  name: string;
  o: SlotWrite;
  expected: string[];
  fail?: Fail;
  throws?: string;
  /** The target exists before the write. */
  exists?: boolean;
}

const OPEN = 'openSync(TMP, "wx", 0o666) -> FD';
const RM = 'rmSync(TMP, {"force":true})';
const CASES: Case[] = [
  { name: 'by default: create, write, close, rename', o: {}, expected: [OPEN, 'writeFileSync(FD, DATA)', 'closeSync(FD)', 'renameSync(TMP, FILE)'] },
  { name: 'with a mode: it goes to the open (the umask applies)', o: { mode: 0o640 }, expected: ['openSync(TMP, "wx", 0o640) -> FD', 'writeFileSync(FD, DATA)', 'closeSync(FD)', 'renameSync(TMP, FILE)'] },
  { name: 'exactMode: fchmod on the descriptor, before the write', o: { mode: 0o660, exactMode: true }, expected: ['openSync(TMP, "wx", 0o660) -> FD', 'fchmodSync(FD, 0o660)', 'writeFileSync(FD, DATA)', 'closeSync(FD)', 'renameSync(TMP, FILE)'] },
  { name: 'replace false: link, then remove the temp name', o: { replace: false }, expected: [OPEN, 'writeFileSync(FD, DATA)', 'closeSync(FD)', 'linkSync(TMP, FILE)', RM] },
  { name: 'the open fails: nothing else', o: {}, fail: { name: 'openSync', code: 'EACCES' }, throws: 'EACCES', expected: ['openSync(TMP, "wx", 0o666) throws EACCES'] },
  { name: 'the temp name is taken: a new one, the taken one never touched', o: {}, fail: { name: 'openSync', code: 'EEXIST' }, expected: ['openSync(TMP, "wx", 0o666) throws EEXIST', 'openSync(TMP2, "wx", 0o666) -> FD', 'writeFileSync(FD, DATA)', 'closeSync(FD)', 'renameSync(TMP2, FILE)'] },
  { name: 'three taken names: it gives up', o: {}, fail: { name: 'openSync', code: 'EEXIST', times: 3 }, throws: 'EEXIST', expected: ['TMP', 'TMP2', 'TMP3'].map((t) => `openSync(${t}, "wx", 0o666) throws EEXIST`) },
  { name: 'the fchmod fails: close, remove the temp file', o: { mode: 0o660, exactMode: true }, fail: { name: 'fchmodSync', code: 'EPERM' }, throws: 'EPERM', expected: ['openSync(TMP, "wx", 0o660) -> FD', 'fchmodSync(FD, 0o660) throws EPERM', 'closeSync(FD)', RM] },
  { name: 'the write fails: close, remove the temp file', o: {}, fail: { name: 'writeFileSync', code: 'ENOSPC' }, throws: 'ENOSPC', expected: [OPEN, 'writeFileSync(FD, DATA) throws ENOSPC', 'closeSync(FD)', RM] },
  { name: 'the rename fails: remove the temp file', o: {}, fail: { name: 'renameSync', code: 'EXDEV' }, throws: 'EXDEV', expected: [OPEN, 'writeFileSync(FD, DATA)', 'closeSync(FD)', 'renameSync(TMP, FILE) throws EXDEV', RM] },
  { name: 'replace false and the file exists (a lock held): remove the temp file', o: { replace: false }, exists: true, throws: 'EEXIST', expected: [OPEN, 'writeFileSync(FD, DATA)', 'closeSync(FD)', 'linkSync(TMP, FILE) throws EEXIST', RM] },
];

/** Run one case against `write` in a fresh dir; throws an AssertionError naming what is wrong. */
function checkCase(write: SlotWriter, c: Case): void {
  const dir = mkdtempSync(join(process.env.AGENT_SLOTS_DIR!, 'calls-'));
  const file = join(dir, 'f.json');
  if (c.exists) writeFileSync(file, 'held');
  const { calls, error } = recordCalls(write, file, c.o, c.fail);
  const shown = render(calls, file);
  const bad = broken(calls, shown, file);
  assert.deepEqual(bad, [], `${c.name}:\n${bad.join('\n')}\n-- the calls:\n${shown.join('\n')}`);
  assert.deepEqual(shown, c.expected, c.name);
  assert.equal(error, c.throws, c.name);
  assert.deepEqual(temps(dir), [], `${c.name}: no temp file left`);
}

for (const c of CASES) test(`writeSlotFile's fs calls, ${c.name}`, () => checkCase(underTest, c));

/**
 * A wrong helper, for the check to fail: the compiled helper with each `from` swapped for `to`, written as a module
 * of its own in a temp dir (src/ is untouched) and loaded the way the helper under test is.
 */
async function variant(name: string, swaps: [from: string, to: string][]): Promise<SlotWriter> {
  let text = readFileSync(new URL('../src/slot-file.js', import.meta.url), 'utf8').replace(/^\/\/# sourceMappingURL=.*$/m, '');
  for (const [from, to] of swaps) {
    assert.equal(text.split(from).length, 2, `${name}: ${from} is in the compiled helper exactly once (if the helper changed, update this variant)`);
    text = text.replace(from, () => to);
  }
  const f = join(mkdtempSync(join(process.env.AGENT_SLOTS_DIR!, 'variant-')), `${name}.mjs`);
  writeFileSync(f, text);
  return loadWrapped(pathToFileURL(f).href);
}

const checkAll = (write: SlotWriter) => {
  for (const c of CASES) checkCase(write, c);
};

test('the fs-call check passes an unchanged copy of the helper, loaded the way the wrong variants below are (a control)', async () => {
  checkAll(await variant('copy', []));
});

test('the fs-call check fails a helper that sets the mode by name (chmodSync(tmp))', async () => {
  const w = await variant('chmod-by-name', [
    ['import { closeSync, fchmodSync,', 'import { chmodSync, closeSync, fchmodSync,'],
    ['fchmodSync(fd, exact);', 'chmodSync(tmp, exact);'],
  ]);
  assert.throws(() => checkAll(w), /chmodSync\(TMP, 0o660\): touches a file by name before the rename or link/);
});

test('the fs-call check fails a helper that writes to another descriptor', async () => {
  const w = await variant('other-fd', [['writeFileSync(fd, data);', "{ const other = openSync(tmp, 'r+'); writeFileSync(other, data); closeSync(other); }"]]);
  assert.throws(() => checkAll(w), /writeFileSync\(fd \d+, DATA\): a descriptor other than the one its exclusive open returned/);
});

test('the fs-call check fails a helper that uses its descriptor after closing it', async () => {
  const w = await variant('op-after-close', [['closeSync(fd);', 'closeSync(fd); fchmodSync(fd, mode);']]);
  assert.throws(() => checkAll(w), /fchmodSync\(FD, 0o666\) throws EBADF: after its descriptor is closed/);
});

test("the fs-call check fails a helper whose open is not exclusive (flag 'w', not 'wx')", async () => {
  const w = await variant('no-wx', [["openSync(tmp, 'wx', mode)", "openSync(tmp, 'w', mode)"]]);
  assert.throws(() => checkAll(w), /openSync\(TMP, "w", 0o666\) -> FD: not an exclusive create \(flag "wx"\) of a new temp name/);
});

test('the fs-call check fails a helper that keeps an fs function from load time and calls it through Reflect.apply', async () => {
  const w = await variant('kept-chmod', [
    ['import { closeSync, fchmodSync,', 'import { chmodSync, closeSync, fchmodSync,'],
    ["from 'node:fs';", "from 'node:fs';\nconst keptChmod = chmodSync;"],
    ['fchmodSync(fd, exact);', '{ fchmodSync(fd, exact); Reflect.apply(keptChmod, undefined, [tmp, exact]); }'],
  ]);
  assert.throws(() => checkAll(w), /chmodSync\(TMP, 0o660\): touches a file by name before the rename or link/);
});

// The temp name is random (moved here from test/slot-file.test.ts in round 5, so it is under engine-guards): with
// predictable names another coordinator could take all three ahead of time, and every write (STOP included) would
// fail with EEXIST, #616's failure under another name.

/**
 * Plant a symlink at the first temp name `write` will draw (randomBytes patched to return fixed bytes once), then
 * write: the planted name must be skipped (never opened, written or removed) and a second random name drawn.
 */
function takenNameSkipped(write: SlotWriter): void {
  const dir = mkdtempSync(join(process.env.AGENT_SLOTS_DIR!, 'taken-'));
  const own = join(mkdtempSync(join(process.env.AGENT_SLOTS_DIR!, 'own-')), 'secret');
  writeFileSync(own, 'secret', { mode: 0o600 });
  chmodSync(own, 0o600);
  const fixed = Buffer.alloc(8, 0xab);
  const planted = join(dir, `f.json.${process.pid}.${fixed.toString('hex')}.tmp`);
  symlinkSync(own, planted);
  const crypto = createRequire(import.meta.url)('node:crypto') as Fns;
  const real = crypto['randomBytes']!;
  let calls = 0;
  crypto['randomBytes'] = (...a: never[]) => (calls++ === 0 ? Buffer.from(fixed) : Reflect.apply(real, crypto, a));
  syncBuiltinESMExports();
  try {
    write(join(dir, 'f.json'), 'new');
  } finally {
    crypto['randomBytes'] = real;
    syncBuiltinESMExports();
  }
  assert.equal(calls, 2, 'a second name was drawn, from randomBytes');
  assert.equal(readFileSync(join(dir, 'f.json'), 'utf8'), 'new');
  assert.equal(lstatSync(join(dir, 'f.json')).isSymbolicLink(), false);
  assert.equal(lstatSync(planted).isSymbolicLink(), true, 'the planted link is left where it is');
  assert.equal(readFileSync(own, 'utf8'), 'secret', 'and what it points at is not written');
  assert.deepEqual(temps(dir), [planted.slice(dir.length + 1)], 'no temp file of its own left');
}

test('a temp name that is taken (here a planted symlink) is skipped: never opened, written or removed; the next name is random', { skip }, () => {
  takenNameSkipped(underTest);
});

test('the taken-name check fails a helper with predictable temp names (a counter, no randomBytes; #766 review, F10)', { skip }, async () => {
  const w = await variant('counter-names', [["randomBytes(8).toString('hex')", "String(attempt).padStart(16, '0')"]]);
  assert.throws(() => takenNameSkipped(w), /a second name was drawn, from randomBytes/);
});
