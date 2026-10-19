// A lint over test/ (#815): a test that creates, writes or removes a path the engine resolves (a machine location
// like MACHINE_PATHS.hubUnitFile or SYSTEM_SLOTS.dir, the state dir, the slot dir) makes sure first that it is the
// test machine's, never the real one:
// - A machine location (src/os/system-paths.ts systemPath, and everything in src/ built from it): the test calls
//   onRealMachine (test/isolate.ts) on it first, which throws unless it is inside this test's system root.
// - The state dir (stateDir) and the slot dir (slotsDir): the resolver itself throws in a test run for anything
//   outside the test machine (testStateRefusal, testSlotsRefusal), before a caller can open it. onRealMachine can't
//   guard them (neither is inside the system root), so the lint checks that each resolver still refuses, and reports
//   every write built from one that doesn't.
// And a test never writes what onRealMachine returns: that is the real machine's path.
//
// WHY: the suite runs on machines that run the engine. A test whose isolation slipped (a variable it changed, a file
// run without the preload, a constant computed before the root moved) wrote the real machine's files through these
// paths; owner-terminal-removed.test.ts removed and wrote MACHINE_PATHS.hubUnitFile and CONSOLE_SHELL with nothing
// checking they were the test's (#815).
//
// How it finds them, through the compiler's symbols rather than text: a write is a call that the type checker
// resolves to an fs function that creates, writes, moves or removes (node:fs, node:fs/promises; under any import
// name, destructured or aliased), or to a function in src/ or test/ that hands one of its parameters to such a call
// (found from the code, a writer of a writer included). What it writes is traced back through locals (`const f =
// …`, later `f = …`), for-of variables and array callbacks (`[A, B].forEach((f) => …)`: the loop forms), destructuring,
// path builders and any other call's arguments, a test helper's return value, and into src/: a declaration there
// is a machine location when what it holds or returns is built from systemPath (MACHINE_PATHS, CONSOLE_SHELL,
// unitPath, …), named by its declaration (aliases and namespace imports are the same name) and its property
// (`MACHINE_PATHS.hubUnitFile`). A guard is an `onRealMachine(x)` call that runs whenever its statement does (the
// statement itself, a const's initialiser, or inside one's arguments, as `assert.equal(onRealMachine(x), …)`; never
// behind a condition, a short-circuit, an optional call or in another function), in a statement before the write in
// the same block or one around it (a for-of body or a try block on the way), where `x` traces to the same name.
//
// Not caught: a write by a child process or a shell script; an engine function that writes a machine location of
// its own (the test names no path); a path passed through a property of an object the lint doesn't trace (`this.f`,
// a parameter's field), a Map, or a closure's captured `let` assigned in another function; a guard on a different
// value that happens to mention the same name (`onRealMachine(join(tmp, MACHINE_PATHS.x))`).
import assert from 'node:assert/strict';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { repoRoot } from './helpers.js';

type Family = 'machine' | 'state' | 'slots';

/** The resolvers every engine-resolved path is built from, by name and module, and what each resolves. */
const SEEDS: Record<string, { file: string; family: Family; refusal?: { fn: string; error: string } }> = {
  systemPath: { file: 'src/os/system-paths.ts', family: 'machine' },
  stateDir: { file: 'src/os/index.ts', family: 'state', refusal: { fn: 'testStateRefusal', error: 'TestStateRefused' } },
  slotsDir: { file: 'src/os/index.ts', family: 'slots', refusal: { fn: 'testSlotsRefusal', error: 'TestSlotsRefused' } },
};
const REFUSALS_FILE = 'src/os/system-paths.ts';
/** The guard: test/isolate.ts onRealMachine. */
const GUARD = { file: 'test/isolate.ts', fn: 'onRealMachine' };

/** fs functions that create, write, move or remove a path: which arguments they write. */
const FS_WRITES: Record<string, readonly number[]> = {
  writeFile: [0], writeFileSync: [0], appendFile: [0], appendFileSync: [0], mkdir: [0], mkdirSync: [0], mkdtemp: [0], mkdtempSync: [0],
  rm: [0], rmSync: [0], rmdir: [0], rmdirSync: [0], unlink: [0], unlinkSync: [0], rename: [0, 1], renameSync: [0, 1],
  copyFile: [1], copyFileSync: [1], cp: [1], cpSync: [1], link: [1], linkSync: [1], symlink: [1], symlinkSync: [1],
  chmod: [0], chmodSync: [0], lchmod: [0], lchmodSync: [0], chown: [0], chownSync: [0], lchown: [0], lchownSync: [0],
  utimes: [0], utimesSync: [0], lutimes: [0], lutimesSync: [0], truncate: [0], truncateSync: [0], open: [0], openSync: [0], createWriteStream: [0],
};
const FS_TYPES = /[\\/]@types[\\/]node[\\/]fs(?:[\\/]promises)?\.d\.ts$/;
/** Array methods whose callback's first parameter is each element: `[A, B].forEach((f) => …)` is a loop over A and B. */
const ELEMENT_CALLBACKS = new Set(['forEach', 'map', 'flatMap', 'filter', 'some', 'every', 'find', 'findLast']);

/**
 * Where a value comes from: an engine-resolved path in src/ (`key`: its module and name, and the property read off it,
 * `decl` its declaration), a parameter of the function it is in (and the option read off it, `prop`), or the real
 * machine (onRealMachine's result).
 */
type Origin = { key: string; families: ReadonlySet<Family>; decl: ts.Node } | { param: ts.ParameterDeclaration; prop?: string } | { real: true };

interface Finding {
  file: string;
  line: number;
  what: string;
}

const NONE: ReadonlySet<Family> = new Set();

/** The lint over one program: `files` are the test files it checks (paths relative to the repo root). */
function lintMachineWrites(program: ts.Program, files: (rel: string) => boolean): Finding[] {
  const checker = program.getTypeChecker();
  const rel = (n: ts.Node) => relative(repoRoot, n.getSourceFile().fileName).split(sep).join('/');
  const inSrc = (n: ts.Node) => rel(n).startsWith('src/');
  const ours = (n: ts.Node) => /^(src|test)\//.test(rel(n)) && !n.getSourceFile().isDeclarationFile;
  const nameOf = (d: ts.Node): string => {
    const n = (d as { name?: ts.Node }).name;
    if (n && (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isPrivateIdentifier(n))) return n.text;
    if ((ts.isArrowFunction(d) || ts.isFunctionExpression(d)) && ts.isVariableDeclaration(d.parent)) return nameOf(d.parent);
    return '(anonymous)';
  };
  const keyOf = (d: ts.Node) => `${rel(d)}:${nameOf(ts.isArrowFunction(d) || ts.isFunctionExpression(d) ? (ts.isVariableDeclaration(d.parent) ? d.parent : d) : d)}`;

  const declOf = (id: ts.Node): ts.Declaration | undefined => {
    let s = ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id ? checker.getShorthandAssignmentValueSymbol(id.parent) : checker.getSymbolAtLocation(id);
    if (s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
    return s?.valueDeclaration ?? s?.declarations?.[0];
  };
  const isFn = (e: ts.Node | undefined): e is ts.ArrowFunction | ts.FunctionExpression => !!e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e));
  /** The function a call calls: by the callee's symbol (cheap), else by the checker's resolved signature. */
  const calleeMemo = new Map<ts.Node, ts.SignatureDeclaration | undefined>();
  const calleeDecl = (c: ts.CallExpression | ts.NewExpression): ts.SignatureDeclaration | undefined => {
    if (calleeMemo.has(c)) return calleeMemo.get(c);
    const callee = c.expression;
    const id = ts.isIdentifier(callee) ? callee : ts.isPropertyAccessExpression(callee) ? callee.name : undefined;
    let d: ts.Node | undefined = id ? declOf(id) : undefined;
    if (d && ts.isVariableDeclaration(d) && isFn(d.initializer)) d = d.initializer;
    // An overloaded function: its implementation, the one with a body.
    if (d && ts.isFunctionDeclaration(d) && !d.body && d.name) d = checker.getSymbolAtLocation(d.name)?.declarations?.find((x) => ts.isFunctionDeclaration(x) && !!x.body) ?? d;
    if (!(d && ts.isFunctionLike(d) && !ts.isJSDocSignature(d))) {
      const s = checker.getResolvedSignature(c)?.declaration;
      d = s && !ts.isJSDocSignature(s) ? s : undefined;
    }
    const out = d as ts.SignatureDeclaration | undefined;
    calleeMemo.set(c, out);
    return out;
  };
  /** A function's returned expressions (its concise body, or each `return x` outside nested functions). */
  const returnsOf = (fn: ts.SignatureDeclaration): ts.Expression[] => {
    const body = (fn as { body?: ts.Node }).body;
    if (!body) return [];
    if (!ts.isBlock(body)) return [body as ts.Expression];
    const out: ts.Expression[] = [];
    const visit = (x: ts.Node) => {
      if (ts.isReturnStatement(x) && x.expression) out.push(x.expression);
      if (!ts.isFunctionLike(x)) ts.forEachChild(x, visit);
    };
    ts.forEachChild(body, visit);
    return out;
  };
  const seedOf = (d: ts.Node) => {
    const s = SEEDS[nameOf(d)];
    return s && s.file === rel(d) && (ts.isFunctionDeclaration(d) || (ts.isVariableDeclaration(d) && isFn(d.initializer))) ? s : undefined;
  };

  const bare = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e) ? bare(e.expression) : e);
  /** The object literal a const holds: `{ … }`, or `Object.freeze({ … })`. */
  const objectOf = (init: ts.Expression | undefined): ts.ObjectLiteralExpression | undefined => {
    if (!init) return undefined;
    const e = bare(init);
    if (ts.isObjectLiteralExpression(e)) return e;
    if (ts.isCallExpression(e) && e.expression.getText() === 'Object.freeze' && e.arguments[0]) return objectOf(e.arguments[0]);
    return undefined;
  };
  const meet = (a: ReadonlySet<Family>, b: ReadonlySet<Family>): ReadonlySet<Family> => new Set([...a].filter((f) => b.has(f)));

  // What a src/ declaration resolves, always: the families of the seeds what it holds or returns is built from, on
  // every branch (`env ?? varLibPath('init')` and `dir === system.dir ? FILE : join(dir, …)` are none: in a test they
  // are the test's own paths, which onRealMachine would refuse). A const object (MACHINE_PATHS) is what its
  // properties are, each on its own.
  const fams = new Map<ts.Node, ReadonlySet<Family>>();
  function families(d: ts.Node): ReadonlySet<Family> {
    if (isFn(d) && ts.isVariableDeclaration(d.parent)) d = d.parent;
    if (!inSrc(d)) return NONE;
    const seed = seedOf(d);
    if (seed) return new Set([seed.family]);
    const hit = fams.get(d);
    if (hit) return hit;
    fams.set(d, NONE); // in progress: a cycle adds nothing
    let out: ReadonlySet<Family> = NONE;
    const all = (es: ts.Expression[]) => (es.length ? es.map(must).reduce(meet) : NONE);
    if (ts.isVariableDeclaration(d)) {
      const obj = objectOf(d.initializer);
      if (obj) out = new Set(obj.properties.flatMap((p) => [...families(p)]));
      else out = isFn(d.initializer) ? all(returnsOf(d.initializer)) : d.initializer ? must(d.initializer) : NONE;
    } else if (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d) || ts.isGetAccessorDeclaration(d) || isFn(d)) out = all(returnsOf(d));
    else if (ts.isPropertyAssignment(d) || ts.isPropertyDeclaration(d)) out = d.initializer ? must(d.initializer) : NONE;
    fams.set(d, out);
    return out;
  }
  /** The families an expression is on every branch; an object literal is none (a function's result object is no path). */
  function must(e: ts.Expression): ReadonlySet<Family> {
    e = bare(e);
    if (ts.isConditionalExpression(e)) return meet(must(e.whenTrue), must(e.whenFalse));
    if (ts.isBinaryExpression(e) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(e.operatorToken.kind)) return meet(must(e.left), must(e.right));
    if (ts.isObjectLiteralExpression(e)) return NONE;
    return new Set(origins(e).flatMap((o) => ('key' in o ? [...o.families] : [])));
  }

  /** What `x.name` comes from, given where `x` comes from. */
  const refine = (os: Origin[], name: string): Origin[] =>
    os.flatMap((o): Origin[] => {
      if ('real' in o) return [o];
      if ('param' in o) return [o.prop === undefined ? { param: o.param, prop: name } : o];
      const obj = ts.isVariableDeclaration(o.decl) ? objectOf(o.decl.initializer) : undefined;
      const p = obj?.properties.find((x) => (ts.isPropertyAssignment(x) || ts.isShorthandPropertyAssignment(x)) && nameOf(x) === name);
      if (p) return families(p).size || ts.isShorthandPropertyAssignment(p) ? [{ key: `${o.key}.${name}`, families: ts.isShorthandPropertyAssignment(p) ? o.families : families(p), decl: p }] : [];
      return [{ key: `${o.key}.${name}`, families: o.families, decl: o.decl }];
    });

  // Assignments to a local after its declaration (`f = …`), by declaration, per file.
  const assigned = new Map<ts.SourceFile, Map<ts.Node, ts.Expression[]>>();
  const assignmentsTo = (d: ts.Node): ts.Expression[] => {
    const sf = d.getSourceFile();
    let m = assigned.get(sf);
    if (!m) {
      const mm = new Map<ts.Node, ts.Expression[]>();
      const visit = (x: ts.Node) => {
        if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(x.left)) {
          const t = declOf(x.left);
          if (t) mm.set(t, [...(mm.get(t) ?? []), x.right]);
        }
        ts.forEachChild(x, visit);
      };
      visit(sf);
      assigned.set(sf, (m = mm));
    }
    return m.get(d) ?? [];
  };

  /** A parameter's origins: itself, and each element when its function is an array callback (`[A, B].forEach((f) => …)`). */
  const paramOrigins = (p: ts.ParameterDeclaration): Origin[] => {
    const fn = p.parent;
    const call = fn.parent;
    // A default (`p = CONSOLE_SHELL`) is where it comes from when a call leaves it out.
    const own: Origin[] = [{ param: p }, ...(p.initializer ? origins(p.initializer) : [])];
    if (isFn(fn) && fn.parameters[0] === p && call && ts.isCallExpression(call) && call.arguments[0] === fn && ts.isPropertyAccessExpression(call.expression) && ELEMENT_CALLBACKS.has(call.expression.name.text)) {
      return [...own, ...origins(call.expression.expression)];
    }
    return own;
  };

  const byDecl = new Map<ts.Node, Origin[]>();
  /** Where a name's value comes from. */
  function declOrigins(d: ts.Declaration): Origin[] {
    if (inSrc(d)) {
      const f = families(d);
      if (f.size) return [{ key: keyOf(d), families: f, decl: d }];
    }
    const hit = byDecl.get(d);
    if (hit) return hit;
    byDecl.set(d, []);
    let out: Origin[] = [];
    // `const { a } = x` is x.a; a deeper pattern is all of x.
    const prop = ts.isBindingElement(d) && ts.isObjectBindingPattern(d.parent) && !d.dotDotDotToken ? nameOf(d.propertyName ?? d) : undefined;
    const pick = (os: Origin[]) => (prop !== undefined && (ts.isVariableDeclaration(d.parent.parent) || ts.isParameter(d.parent.parent)) ? refine(os, prop) : os);
    let v: ts.Node = d;
    while (ts.isBindingElement(v) || ts.isObjectBindingPattern(v) || ts.isArrayBindingPattern(v)) v = v.parent;
    if (ts.isParameter(v)) out = pick(paramOrigins(v));
    else if (ts.isVariableDeclaration(v)) {
      const list = v.parent;
      const loop = ts.isVariableDeclarationList(list) ? list.parent : undefined;
      if (loop && ts.isForOfStatement(loop)) out = pick(origins(loop.expression));
      else if (loop && ts.isForInStatement(loop)) out = [];
      else out = pick([...(v.initializer ? origins(v.initializer) : []), ...assignmentsTo(d).flatMap((e) => origins(e))]);
    } else if (ts.isShorthandPropertyAssignment(v)) out = origins(v.name);
    else if (ts.isPropertyAssignment(v) && !inSrc(v)) out = origins(v.initializer);
    byDecl.set(d, out);
    return out;
  }

  const byNode = new Map<ts.Node, Origin[]>();
  /** Where an expression's value comes from: machine locations by name, a function's parameters, the real machine. */
  function origins(e: ts.Node): Origin[] {
    if (ts.isFunctionLike(e)) return [];
    const hit = byNode.get(e);
    if (hit) return hit;
    byNode.set(e, []);
    let out: Origin[] = [];
    if (ts.isIdentifier(e)) {
      const d = declOf(e);
      out = d ? declOrigins(d) : [];
    } else if (ts.isCallExpression(e) || ts.isNewExpression(e)) {
      const d = calleeDecl(e);
      const args = e.arguments ?? [];
      if (d && rel(d) === GUARD.file && nameOf(d) === GUARD.fn) out.push({ real: true }); // and nothing of its argument: the result is the real path
      else {
        if (d && inSrc(d) && families(d).size) out.push({ key: keyOf(d), families: families(d), decl: d });
        else if (d && ours(d) && !inSrc(d)) {
          // A test helper: what it returns, its parameters replaced by this call's arguments.
          for (const o of returnsOf(d).flatMap((r) => origins(r))) {
            if (!('param' in o) || o.param.parent !== d) {
              out.push(o);
              continue;
            }
            const a = args[d.parameters.indexOf(o.param)];
            if (a) out.push(...(o.prop === undefined ? origins(a) : propOf(a, o.prop)));
          }
        }
        if (ts.isPropertyAccessExpression(e.expression)) out.push(...origins(e.expression.expression));
        // path.join(root, real) is under root: only its first part can make it the real machine's.
        const join = d && /[\\/]@types[\\/]node[\\/]path\.d\.ts$/.test(d.getSourceFile().fileName) && nameOf(d) === 'join';
        args.forEach((a, i) => out.push(...origins(a).filter((o) => !(join && i > 0 && 'real' in o))));
      }
    } else if (ts.isPropertyAccessExpression(e)) {
      const own = declOf(e.name);
      const base = origins(e.expression);
      if (own && !inSrc(own) && ours(own) && (ts.isPropertyAssignment(own) || ts.isShorthandPropertyAssignment(own))) out = declOrigins(own); // a test's own object
      else if (own && inSrc(own) && families(own).size && !base.some((o) => 'key' in o)) out = [{ key: keyOf(own), families: families(own), decl: own }];
      else out = refine(base, e.name.text);
    } else if (ts.isElementAccessExpression(e)) out = origins(e.expression);
    else ts.forEachChild(e, (x) => void out.push(...origins(x)));
    byNode.set(e, out);
    return out;
  }
  /** Where `arg.prop` comes from: its property when `arg` is an object literal (any spread too), else as read. */
  const propOf = (arg: ts.Expression, prop: string): Origin[] => {
    const a = bare(arg);
    if (!ts.isObjectLiteralExpression(a)) return refine(origins(a), prop);
    const p = a.properties.find((x) => (ts.isPropertyAssignment(x) || ts.isShorthandPropertyAssignment(x)) && nameOf(x) === prop);
    const spread = a.properties.filter(ts.isSpreadAssignment).flatMap((s) => refine(origins(s.expression), prop));
    return [...(p && ts.isPropertyAssignment(p) ? origins(p.initializer) : p && ts.isShorthandPropertyAssignment(p) ? origins(p.name) : []), ...spread];
  };

  // Writers: which parameters (and which option of one, `o.dir`) a function creates, writes, moves or removes.
  const writerMemo = new Map<ts.Node, Map<number, Set<string | undefined>>>();
  function writerParams(fn: ts.SignatureDeclaration): Map<number, Set<string | undefined>> {
    const hit = writerMemo.get(fn);
    if (hit) return hit;
    const out = new Map<number, Set<string | undefined>>();
    writerMemo.set(fn, out); // in progress: a recursive call adds nothing
    const body = (fn as { body?: ts.Node }).body;
    const visit = (x: ts.Node) => {
      if (ts.isCallExpression(x)) {
        for (const t of writes(x)) {
          for (const o of t.os) {
            if (!('param' in o) || o.param.parent !== fn) continue;
            const i = fn.parameters.indexOf(o.param);
            if (!out.has(i)) out.set(i, new Set());
            out.get(i)!.add(o.prop);
          }
        }
      }
      ts.forEachChild(x, visit);
    };
    if (body) visit(body);
    return out;
  }
  /** What a call creates, writes, moves or removes: each argument (or an option of one) and where it comes from. */
  function writes(c: ts.CallExpression): { node: ts.Expression; os: Origin[] }[] {
    const d = calleeDecl(c);
    if (!d) return [];
    if (FS_TYPES.test(d.getSourceFile().fileName)) {
      const name = nameOf(d);
      const at = FS_WRITES[name];
      if (!at) return [];
      if (name === 'open' || name === 'openSync') {
        // A read: no flags, a string flag without w, a, x or +, or numeric flags naming O_RDONLY and no write flag.
        const f = c.arguments[1];
        const named: string[] = f && !ts.isStringLiteralLike(f) ? (f.getText().match(/\bO_[A-Z]+\b/g) ?? []) : [];
        if (!f || (ts.isStringLiteralLike(f) && !/[wax+]/.test(f.text)) || (named.includes('O_RDONLY') && !named.some((x) => /^O_(WRONLY|RDWR|CREAT|TRUNC|APPEND)$/.test(x)))) return [];
      }
      return at.flatMap((i) => (c.arguments[i] ? [{ node: c.arguments[i]!, os: origins(c.arguments[i]!) }] : []));
    }
    if (!ours(d) || !(d as { body?: ts.Node }).body) return [];
    return [...writerParams(d)].flatMap(([i, props]) => {
      const a = c.arguments[i];
      return a ? [{ node: a, os: [...props].flatMap((p) => (p === undefined ? origins(a) : propOf(a, p))) }] : [];
    });
  }

  // The seeds that guard themselves: each resolver with a refusal still calls it and throws, itself or through a
  // function in src/ it calls (slotsDir through the function that resolves it, say).
  const refusesMemo = new Map<ts.Node, boolean>();
  const refuses = (fn: ts.Node, r: { fn: string; error: string }): boolean => {
    const hit = refusesMemo.get(fn);
    if (hit !== undefined) return hit;
    refusesMemo.set(fn, false); // in progress
    let calls = false;
    let throws = false;
    let via = false;
    const scan = (y: ts.Node) => {
      if (ts.isCallExpression(y)) {
        const d = calleeDecl(y);
        if (d && rel(d) === REFUSALS_FILE && nameOf(d) === r.fn) calls = true;
        else if (d && inSrc(d) && (d as { body?: ts.Node }).body && refuses(d, r)) via = true;
      }
      if (ts.isThrowStatement(y) && y.expression && ts.isNewExpression(y.expression) && y.expression.expression.getText() === r.error) throws = true;
      if (!ts.isFunctionLike(y)) ts.forEachChild(y, scan);
    };
    const body = (fn as { body?: ts.Node }).body;
    if (body) ts.forEachChild(body, scan);
    refusesMemo.set(fn, (calls && throws) || via);
    return (calls && throws) || via;
  };
  const selfGuarded = new Map<Family, string | null>();
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !inSrc(sf)) continue;
    const visit = (x: ts.Node) => {
      const seed = ts.isFunctionDeclaration(x) ? seedOf(x) : undefined;
      if (seed?.refusal) selfGuarded.set(seed.family, refuses(x, seed.refusal) ? null : `${nameOf(x)}() no longer refuses a path outside the test machine in a test run (it must call ${seed.refusal.fn} and throw ${seed.refusal.error}): put the refusal back`);
      ts.forEachChild(x, visit);
    };
    visit(sf);
  }
  for (const [name, s] of Object.entries(SEEDS)) if (s.refusal && !selfGuarded.has(s.family)) selfGuarded.set(s.family, `${name}() is not in ${s.file} any more: the lint can't see its refusal`);

  // The guards, per file: each onRealMachine(x) call, what x traces to, and the statement it runs in whenever that
  // statement runs: the call is the statement, a `const` initialiser, or an argument, operand or part of one (as in
  // `assert.equal(onRealMachine(x), …)`), never behind a condition, a short-circuit, an optional call or a function.
  const guardOf = (c: ts.CallExpression): { s: ts.Statement; keys: Set<string> } | null => {
    const d = calleeDecl(c);
    if (!d || rel(d) !== GUARD.file || nameOf(d) !== GUARD.fn || !c.arguments[0]) return null;
    let x: ts.Node = c;
    for (let p = x.parent; ; x = p, p = p.parent) {
      if (ts.isExpressionStatement(p)) break;
      if (ts.isVariableDeclaration(p) && p.initializer === x && ts.isVariableDeclarationList(p.parent) && ts.isVariableStatement(p.parent.parent)) {
        x = p.parent;
        p = p.parent.parent;
        break;
      }
      const shortCircuit = ts.isBinaryExpression(p) && p.right === x && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(p.operatorToken.kind);
      const optional = (ts.isCallExpression(p) || ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && (p.questionDotToken !== undefined || (p.flags & ts.NodeFlags.OptionalChain) !== 0);
      const part = ts.isCallExpression(p) || ts.isNewExpression(p) || ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p) || ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p) || ts.isTemplateSpan(p) || ts.isTemplateExpression(p) || ts.isArrayLiteralExpression(p) || ts.isAwaitExpression(p) || ts.isVoidExpression(p) || (ts.isBinaryExpression(p) && !shortCircuit);
      if (!part || optional) return null;
    }
    return { s: x.parent as ts.Statement, keys: new Set(origins(c.arguments[0]).flatMap((o) => ('key' in o ? [o.key] : []))) };
  };
  /** Whether a guard statement runs, unconditionally, before `n` and around it: its parents up to one that holds `n` are blocks, for-of bodies and try blocks. */
  const guards = (g: ts.Statement, n: ts.Node): boolean => {
    if (g.getEnd() > n.getStart()) return false;
    const holds = (p: ts.Node) => p.pos <= n.pos && n.end <= p.end && p.getSourceFile() === n.getSourceFile();
    for (let p: ts.Node = g.parent; ; p = p.parent) {
      if (holds(p)) return true;
      const ok = ts.isBlock(p) && (ts.isBlock(p.parent) || ts.isSourceFile(p.parent) || (ts.isTryStatement(p.parent) && p.parent.tryBlock === p) || ts.isForOfStatement(p.parent));
      if (!(ok || ts.isForOfStatement(p))) return false;
    }
  };

  const out: Finding[] = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !files(rel(sf))) continue;
    const stmts: { s: ts.Statement; keys: Set<string> }[] = [];
    const collect = (x: ts.Node) => {
      const g = ts.isCallExpression(x) ? guardOf(x) : null;
      if (g) stmts.push(g);
      ts.forEachChild(x, collect);
    };
    collect(sf);
    const visit = (x: ts.Node) => {
      if (ts.isCallExpression(x)) {
        for (const { node, os } of writes(x)) {
          const at = (what: string) => out.push({ file: rel(sf), line: sf.getLineAndCharacterOfPosition(x.getStart()).line + 1, what: `${x.expression.getText()}(${node.getText()}): ${what}` });
          if (os.some((o) => 'real' in o)) at(`${GUARD.fn} gives the real machine's path: a test never creates, writes or removes it`);
          const seen = new Set<string>();
          for (const o of os) {
            if (!('key' in o) || seen.has(o.key)) continue;
            seen.add(o.key);
            if (o.families.has('machine') && !stmts.some((g) => g.keys.has(o.key) && guards(g.s, x))) at(`${o.key.replace(/^.*:/, '')} is a machine location (${o.key.replace(/:.*$/, '')}): call ${GUARD.fn} on it first, in this block or one around it`);
            for (const f of ['state', 'slots'] as const) {
              const why = o.families.has(f) ? selfGuarded.get(f) : null;
              if (why) at(`${o.key.replace(/^.*:/, '')} is built from it: ${why}`);
            }
          }
        }
      }
      ts.forEachChild(x, visit);
    };
    visit(sf);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------

const config = (() => {
  const c = ts.getParsedCommandLineOfConfigFile(join(repoRoot, 'tsconfig.json'), { noEmit: true }, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => assert.fail(ts.flattenDiagnosticMessageText(d.messageText, '\n')) });
  assert.ok(c, 'tsconfig.json');
  return c;
})();
const isTestFile = (r: string) => r.startsWith('test/') && r.endsWith('.ts') && !r.endsWith('.d.ts');
const relOf = (f: string) => relative(repoRoot, f).split(sep).join('/');

let whole: ts.Program | undefined;
/** The program over test/ (and what it imports), or one over fixture files (relative path → text) on top of it. */
function program(fixtures?: Map<string, string>): ts.Program {
  const host = ts.createCompilerHost(config.options, true);
  const extra = new Map([...(fixtures ?? [])].map(([k, v]) => [join(repoRoot, k), v]));
  const get = host.getSourceFile.bind(host);
  host.getSourceFile = (f, lang, onError, create) => (extra.has(f) ? ts.createSourceFile(f, extra.get(f)!, lang, true, ts.ScriptKind.TS) : get(f, lang, onError, create));
  host.fileExists = (f) => extra.has(f) || ts.sys.fileExists(f);
  host.readFile = (f) => extra.get(f) ?? ts.sys.readFile(f);
  const roots = fixtures ? [...extra.keys()] : config.fileNames.filter((f) => isTestFile(relOf(f)));
  const p = ts.createProgram({ rootNames: roots, options: config.options, host, ...(whole ? { oldProgram: whole } : {}) });
  if (!fixtures) whole = p;
  return p;
}

const show = (f: Finding[]) => f.map((x) => `${x.file}:${x.line}: ${x.what}`).join('\n');

test('lint: every test that creates, writes or removes a machine location calls onRealMachine on it first; the state and slot dirs refuse themselves (#815)', () => {
  const found = lintMachineWrites(program(), isTestFile);
  assert.deepEqual(found, [], show(found));
});

/** The lint over fixture test files only. */
function lintFixtures(files: Record<string, string>): string {
  const m = new Map(Object.entries(files));
  return show(lintMachineWrites(program(m), (r) => m.has(r) && isTestFile(r)));
}
const head = [
  "import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';",
  "import * as fs from 'node:fs';",
  "import { writeFile } from 'node:fs/promises';",
  "import { dirname, join } from 'node:path';",
  "import { MACHINE_PATHS } from '../src/setup-steps.js';",
  "import { CONSOLE_SHELL } from '../src/console/owner-terminal-removed.js';",
  "import * as removed from '../src/console/owner-terminal-removed.js';",
  "import { SYSTEM_SLOTS, stateDir, slotsDir, writeOwnerOnly } from '../src/os/index.js';",
  "import { unitPath } from '../src/os/system-paths.js';",
  "import { onRealMachine } from './isolate.js';",
];

test('lint: an unguarded write, move or removal of a machine location is reported, however it is named or looped over', () => {
  const found = lintFixtures({
    'test/fixture-a.test.ts': [
      ...head,
      'export function oldInstall() {',
      '  for (const f of [MACHINE_PATHS.hubUnitFile, CONSOLE_SHELL]) rmSync(f, { force: true });', // 12: the loop form, both
      '  mkdirSync(dirname(MACHINE_PATHS.hubUnitFile), { recursive: true });', // 13
      "  fs.writeFileSync(removed.CONSOLE_SHELL, '');", // 14: a namespace import, fs whole
      '  const { appendFileSync: add } = fs;',
      "  add(SYSTEM_SLOTS.dir, '');", // 16: destructured fs, SYSTEM_SLOTS
      "  [CONSOLE_SHELL].forEach((p) => writeOwnerOnly(p, ''));", // 17: a callback loop, a src writer
      '  let later = "";',
      '  later = unitPath("x.service");',
      "  void writeFile(later, '');", // 20: a later assignment, fs/promises, a function from systemPath
      '  const wipe = (p: string) => rmSync(p);',
      '  wipe(MACHINE_PATHS.hubUnitFile);', // 22: a test helper that removes its parameter
      "  writeFileSync(onRealMachine(CONSOLE_SHELL), '');", // 23: the real path itself
      '}',
      '',
    ].join('\n'),
  });
  const lines = found.split('\n');
  const at = (n: number) => lines.filter((l) => l.startsWith(`test/fixture-a.test.ts:${n}: `));
  assert.equal(at(12).length, 2, found);
  assert.match(at(12).join('\n'), /hubUnitFile is a machine location/);
  assert.match(at(12).join('\n'), /CONSOLE_SHELL is a machine location \(src\/console\/owner-terminal-removed\.ts\)/);
  assert.match(at(13)[0] ?? '', /mkdirSync\(dirname\(MACHINE_PATHS\.hubUnitFile\)\): MACHINE_PATHS\.hubUnitFile is a machine location/, found);
  assert.match(at(14)[0] ?? '', /CONSOLE_SHELL is a machine location/, found);
  assert.match(at(16)[0] ?? '', /SYSTEM_SLOTS\.dir is a machine location/, found);
  assert.match(at(17)[0] ?? '', /writeOwnerOnly\(p\): CONSOLE_SHELL is a machine location/, found);
  assert.match(at(20)[0] ?? '', /writeFile\(later\): unitPath is a machine location/, found);
  assert.match(at(21).join('\n') + at(22).join('\n'), /wipe\(MACHINE_PATHS\.hubUnitFile\): MACHINE_PATHS\.hubUnitFile is a machine location/, found);
  assert.deepEqual(at(23).map((l) => l.replace(/^.*?: /, '')), ["writeFileSync(onRealMachine(CONSOLE_SHELL)): onRealMachine gives the real machine's path: a test never creates, writes or removes it"], found);
  assert.equal(lines.length, 9, found);
});

test("lint: a machine location reaches a write through a test's object, an array's element, a parameter's default or a destructured name", () => {
  const found = lintFixtures({
    'test/fixture-e.test.ts': [
      ...head,
      'export function more(n: number) {',
      '  const o = { p: CONSOLE_SHELL, q: `/tmp/x${n}` };',
      '  rmSync(o.p);', // 13
      '  rmSync(o.q);', // 14: not a machine location
      '  const arr = [MACHINE_PATHS.hubUnitFile];',
      '  rmSync(arr[n]!);', // 16
      '  const drop = (p = SYSTEM_SLOTS.config) => rmSync(p);', // 17: its default
      '  drop();',
      '  const { dir } = SYSTEM_SLOTS;',
      '  mkdirSync(dir);', // 20
      '}',
      '',
    ].join('\n'),
  });
  assert.deepEqual(found.split('\n').map((l) => l.split(':')[1]), ['13', '16', '17', '20'], found);
  assert.match(found, /:20: mkdirSync\(dir\): SYSTEM_SLOTS\.dir is a machine location/);
});

test("lint: what onRealMachine gives is the real path only as a path's start: under a test's own root it is the test's", () => {
  const found = lintFixtures({
    'test/fixture-d.test.ts': [
      ...head,
      'export function layout(root: string) {',
      '  const etc = join(root, onRealMachine(dirname(CONSOLE_SHELL)));',
      '  mkdirSync(etc, { recursive: true });', // 13: under root: fine
      "  writeFileSync(join(onRealMachine(CONSOLE_SHELL), 'x'), '');", // 14: the real path's start
      "  writeFileSync(`${onRealMachine(CONSOLE_SHELL)}.bak`, '');", // 15
      '}',
      '',
    ].join('\n'),
  });
  assert.deepEqual(found.split('\n').map((l) => l.split(':')[1]), ['14', '15'], found);
});

test('lint: a guard counts only on the same name, before the write, in its block or one around it (a for-of body, a try block), never under a condition or in another function', () => {
  const found = lintFixtures({
    'test/fixture-b.test.ts': [
      ...head,
      'for (const f of [MACHINE_PATHS.hubUnitFile, CONSOLE_SHELL]) onRealMachine(f);', // 11: module level, both
      'export function guarded() {',
      '  for (const f of [MACHINE_PATHS.hubUnitFile, CONSOLE_SHELL]) rmSync(f, { force: true });', // 13: ok
      '  try {',
      "    onRealMachine(SYSTEM_SLOTS.dir);",
      "    writeFileSync(join(SYSTEM_SLOTS.dir, 'x'), '');", // 16: ok
      '  } finally {',
      "    writeFileSync(SYSTEM_SLOTS.config, '');", // 18: another name
      '  }',
      '  if (Math.random() > 2) onRealMachine(SYSTEM_SLOTS.config);',
      "  writeFileSync(SYSTEM_SLOTS.config, '');", // 21: the guard is conditional
      '  const later = () => { onRealMachine(unitPath("a")); };',
      "  writeFileSync(unitPath('a'), '');", // 23: the guard is in another function
      "  writeFileSync(unitPath('b'), '');", // 24
      '  onRealMachine(unitPath("c"));', // after both
      '  for (const f of [SYSTEM_SLOTS.config]) {',
      '    onRealMachine(f);',
      "    writeFileSync(f, '');", // 28: ok, the loop form
      '  }',
      '  const shown = [String(onRealMachine(MACHINE_PATHS.helper))];',
      '  mkdirSync(MACHINE_PATHS.helper);', // 31: ok, a guard inside a const's initialiser
      '  void (shown.length > 9 && onRealMachine(MACHINE_PATHS.allowedSigners));',
      '  rmSync(MACHINE_PATHS.allowedSigners);', // 33: the guard is behind a short-circuit
      "  JSON.parse('{}')?.x?.(onRealMachine(MACHINE_PATHS.fullRunLock));",
      '  rmSync(MACHINE_PATHS.fullRunLock);', // 35: the guard is in an optional call
      "  writeFileSync(MACHINE_PATHS.enginePackage, '');", // 36: not a machine location (the engine's package.json)
      '  void later;',
      '}',
      '',
    ].join('\n'),
  });
  const lines = found.split('\n').map((l) => l.replace(/^test\/fixture-b\.test\.ts:/, ''));
  assert.deepEqual(lines.map((l) => Number(l.split(':')[0])), [18, 21, 23, 24, 33, 35], found);
  assert.match(lines[0]!, /SYSTEM_SLOTS\.config is a machine location/);
});

test("lint: the state and slot dirs need no onRealMachine while their resolvers refuse in a test run; without the refusal each write built from one is reported", () => {
  const writes = [...head, "export function w() {", "  writeFileSync(join(stateDir(), 'x'), '');", '  mkdirSync(`${String(slotsDir())}/y`);', '}', ''].join('\n');
  assert.equal(lintFixtures({ 'test/fixture-c.test.ts': writes }), '');
  // The resolvers without their refusals (fixture copies of src/os/index.ts, nothing in src/ is changed).
  const real = ts.sys.readFile(join(repoRoot, 'src', 'os', 'index.ts'))!;
  const noState = real.replace(/const refusal = testStateRefusal\(dir\);\n\s*if \(refusal\) throw new TestStateRefused\(refusal\);\n/, '');
  const noSlots = real.replace(/const refusal = testSlotsRefusal\(dir\);\n\s*if \(refusal\) throw new TestSlotsRefused\(refusal\);\n/, '');
  assert.notEqual(noState, real, 'the state refusal is cut');
  assert.notEqual(noSlots, real, 'the slot refusal is cut');
  for (const [mutant, line, name] of [[noState, 12, 'stateDir'], [noSlots, 13, 'slotsDir']] as const) {
    const found = lintFixtures({ 'test/fixture-c.test.ts': writes, 'src/os/index.ts': mutant });
    assert.match(found, new RegExp(`fixture-c\\.test\\.ts:${line}: .*: ${name} is built from it: ${name}\\(\\) no longer refuses`), found);
    assert.equal(found.split('\n').length, 1, found);
  }
});
