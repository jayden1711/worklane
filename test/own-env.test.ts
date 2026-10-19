// #786: the engine's security reads see only variables that are set. The protection is by design: src/os/own-env.ts's
// OwnEnv, a frozen null-prototype snapshot of a source's own variables, read through get(). An EnvSource (an OwnEnv or
// a raw environment) has no index signature, so a function that takes one can't read it but through ownEnv(env).get():
// the @ts-expect-error lines below fail `npm run typecheck` the day that stops being true.
//
// The lint at the end is a backstop beside it, not the protection: in the modules listed in OWN_ENV_MODULES, process.env
// is never read directly (a member, an alias, a destructuring), so a new read there can't skip the accessor unseen.
// It takes its input as data (#771): its fail-without is the fixtures below, never a planted read in src/.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { ownEnv, OwnEnv, type EnvSource } from '../src/os/own-env.js';
import { repoRoot } from './helpers.js';

/** Runs `f` with `vars` on Object.prototype, as a polluting dependency would set them, and takes them off after. */
function polluted<T>(vars: Record<string, string>, f: () => T): T {
  const proto = Object.prototype as Record<string, unknown>;
  for (const k of Object.keys(vars)) assert.ok(!Object.hasOwn(proto, k), `${k} isn't on Object.prototype already`);
  try {
    for (const [k, v] of Object.entries(vars)) proto[k] = v;
    return f();
  } finally {
    for (const k of Object.keys(vars)) delete proto[k];
  }
}

const CANARY = 'WL786_CANARY_NEVER_SET';

test('ownEnv: a variable that is set reads as itself; one that is not, or one only a prototype has, reads as undefined', () => {
  assert.equal(Object.hasOwn(process.env, CANARY), false, 'the canary is not in the environment');
  const env = ownEnv({ A: '1', EMPTY: '' });
  assert.equal(env.get('A'), '1');
  assert.equal(env.get('EMPTY'), '', 'an empty variable is set');
  assert.equal(env.get('B'), undefined);
  for (const inherited of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) assert.equal(env.get(inherited), undefined, `${inherited} (on every object's prototype)`);
  polluted({ [CANARY]: 'from-the-prototype', A: 'from-the-prototype' }, () => {
    assert.equal(process.env[CANARY], 'from-the-prototype', 'process.env inherits it (measured on Node 22, #786)');
    assert.equal(ownEnv().get(CANARY), undefined, 'process.env, own variables only');
    assert.equal(ownEnv({ B: '2' }).get(CANARY), undefined, 'a plain object, own variables only');
    assert.equal(ownEnv({ A: '1' }).get('A'), '1', 'a set variable keeps its own value');
    assert.equal(env.get(CANARY), undefined, 'a snapshot taken before the pollution');
    assert.equal(ownEnv().asProcessEnv()[CANARY], undefined, 'the snapshot as a ProcessEnv: no prototype to inherit from');
  });
});

test('ownEnv: a snapshot, frozen, with no prototype; later changes to its source are not in it', () => {
  const source: NodeJS.ProcessEnv = { A: '1' };
  const env = ownEnv(source);
  source.A = '2';
  source.B = '3';
  assert.equal(env.get('A'), '1');
  assert.equal(env.get('B'), undefined);
  const raw = env.asProcessEnv();
  assert.equal(Object.getPrototypeOf(raw), null);
  assert.ok(Object.isFrozen(raw));
  assert.throws(() => {
    raw.A = 'x';
  }, TypeError);
  assert.equal(ownEnv(env), env, 'an OwnEnv is taken as it is');
});

test('ownEnv: only string values are variables', () => {
  const env = ownEnv({ N: 1, U: undefined, O: {}, S: 's' } as unknown as NodeJS.ProcessEnv);
  assert.deepEqual(['N', 'U', 'O', 'S'].map((k) => env.get(k)), [undefined, undefined, undefined, 's']);
});

test('OwnEnv.is: only a snapshot this module took, never a look-alike or process.env', () => {
  assert.ok(OwnEnv.is(ownEnv({})));
  const lookalike = { get: () => 'forged', asProcessEnv: () => ({}) };
  assert.equal(OwnEnv.is(lookalike), false);
  assert.equal(OwnEnv.is(process.env), false);
  assert.equal(OwnEnv.is(Object.create(OwnEnv.prototype)), false, 'its prototype without its private field');
  // A look-alike handed in as a source is copied like any raw environment: its own string properties (none here).
  assert.equal(ownEnv(lookalike as unknown as EnvSource).get('get'), undefined);
});

test('ownEnv (adversarial, #786): a name injected by a replaced Object.keys or Array iterator is not copied from the prototype', () => {
  const realKeys = Object.keys;
  const realIter = Array.prototype[Symbol.iterator];
  const snapshots: OwnEnv[] = [];
  polluted({ [CANARY]: 'from-the-prototype' }, () => {
    try {
      // Object.keys replaced after own-env.ts loaded: it took its own copy then.
      Object.keys = ((o: object) => [...realKeys(o), CANARY]) as typeof Object.keys;
      snapshots.push(ownEnv({ A: '1' }));
      Object.keys = realKeys;
      // An Array iterator that adds the name: the copy is an indexed loop with an own check per name.
      Array.prototype[Symbol.iterator] = function* (this: unknown[]) {
        yield* realIter.call(this);
        yield CANARY;
      } as typeof realIter;
      snapshots.push(ownEnv({ A: '1' }));
    } finally {
      Object.keys = realKeys;
      Array.prototype[Symbol.iterator] = realIter;
    }
  });
  assert.deepEqual(snapshots.map((s) => [s.get(CANARY), s.get('A')]), [[undefined, '1'], [undefined, '1']]);
});

test('ownEnv: on Windows names are case-insensitive (Path is PATH); elsewhere they are not', () => {
  assert.equal(ownEnv({ Path: 'C:\\bin' }, 'win32').get('PATH'), 'C:\\bin');
  assert.equal(ownEnv({ PATH: 'C:\\bin' }, 'win32').get('Path'), 'C:\\bin');
  assert.equal(ownEnv({ Path: '/bin' }, 'linux').get('PATH'), undefined);
  polluted({ [CANARY]: 'from-the-prototype', [CANARY.toLowerCase()]: 'from-the-prototype' }, () => {
    assert.equal(ownEnv({}, 'win32').get(CANARY), undefined);
    assert.equal(ownEnv({}, 'win32').get(CANARY.toLowerCase()), undefined);
  });
});

test('the types: an EnvSource and an OwnEnv are read only through get(), and a raw environment is no OwnEnv (npm run typecheck)', () => {
  const read = (src: EnvSource, own: OwnEnv) => {
    // @ts-expect-error an EnvSource has no index signature: read it through ownEnv(src).get(name)
    void src.PATH;
    // @ts-expect-error nor element access
    void src['PATH'];
    // @ts-expect-error an OwnEnv has no index signature either
    void own['PATH'];
    // @ts-expect-error process.env is no OwnEnv
    const forged: OwnEnv = process.env;
    // @ts-expect-error nor is a plain object
    const plain: OwnEnv = { get: () => 'x' };
    return [forged, plain];
  };
  assert.equal(typeof read, 'function');
});

// ---------------------------------------------------------------------------------------------------------------
// The backstop lint

/**
 * The modules that never read process.env directly (#786); the lint sees process.env only, not a parameter read raw.
 * Not yet here, each until the PR named edits it no more: src/os/index.ts (#818, stateDir), src/service.ts (#819),
 * src/hook.ts, src/guardrails/context.ts and src/mcp/connector.ts (#785), src/cli.ts (#743, #769, #803, #836).
 */
export const OWN_ENV_MODULES: readonly string[] = [
  'src/avatars.ts',
  'src/browser/run.ts',
  'src/cli-agents.ts',
  'src/coordinator/browser.ts',
  'src/desktop.ts',
  'src/held-out.ts',
  'src/init.ts',
  'src/instance.ts',
  'src/managed-apps.ts',
  'src/mcp/npm.ts',
  'src/os/own-env.ts',
  'src/os/system-paths.ts',
  'src/plugins/cli.ts',
  'src/plugins/fetch.ts',
  'src/runner.ts',
  'src/setup/app-manifest.ts',
  'src/skilleval.ts',
  'src/spend-gate.ts',
  'src/testrun/host.ts',
  'src/tool-path.ts',
];

interface Finding {
  file: string;
  line: number;
  what: string;
}

/** `process.env`, `globalThis.process.env`, or either with element access (`process['env']`). */
function isProcessEnv(e: ts.Expression): boolean {
  const name = (x: ts.Expression): string | null => (ts.isPropertyAccessExpression(x) ? x.name.text : ts.isElementAccessExpression(x) && ts.isStringLiteralLike(x.argumentExpression) ? x.argumentExpression.text : null);
  if (name(e) !== 'env') return false;
  const p = (e as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression;
  if (ts.isIdentifier(p)) return p.text === 'process';
  return name(p) === 'process' && ts.isIdentifier((p as ts.PropertyAccessExpression).expression) && ((p as ts.PropertyAccessExpression).expression as ts.Identifier).text === 'globalThis';
}

/**
 * Every use of process.env in `files` (path → source text) that may read a variable. Allowed: handing it on whole (a
 * call's argument, a parameter's default, a spread, which copies own variables only) and writing it (an assignment's
 * target, a delete). Anything else is reported: a member read, an alias (`const e = process.env`), a destructuring.
 */
export function lintEnvReads(files: ReadonlyMap<string, string>): Finding[] {
  const out: Finding[] = [];
  for (const [file, text] of files) {
    const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const at = (n: ts.Node, what: string) => out.push({ file, line: src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1, what });
    const visit = (n: ts.Node) => {
      if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && isProcessEnv(n)) {
        const parent = n.parent;
        const handedOn = (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && !!parent.arguments?.some((a) => a === n);
        const byDefault = ts.isParameter(parent) && parent.initializer === n;
        const spread = (ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent)) && parent.expression === n;
        const member = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === n ? parent : null;
        const written = member && ((ts.isBinaryExpression(member.parent) && member.parent.left === member && member.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) || ts.isDeleteExpression(member.parent));
        if (!handedOn && !byDefault && !spread && !written) at(n, `${n.getText(src)}${member ? `${member.getText(src).slice(n.getText(src).length)}` : ''} reads the environment directly: read it through ownEnv().get(name) (src/os/own-env.ts, #786)`);
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  return out;
}

const show = (f: Finding[]) => f.map((x) => `${x.file}:${x.line}: ${x.what}`).join('\n');
const fixture = (lines: string[]) => new Map([['src/fixture.ts', [...lines, ''].join('\n')]]);

test('lint (#786): the listed modules read the environment only through ownEnv', () => {
  const files = new Map(OWN_ENV_MODULES.map((f) => [f, readFileSync(join(repoRoot, f), 'utf8')]));
  const found = lintEnvReads(files);
  assert.deepEqual(found, [], show(found));
});

test('lint (#786): a direct read is reported, by member, element, alias, destructuring or globalThis', () => {
  const found = lintEnvReads(
    fixture([
      'export const a = process.env.HOME;',
      "export const b = process.env['AGENT_SLOTS_DIR'];",
      'export const c = process.env[`${x}_STATE_DIR`];',
      'const e = process.env;',
      'const { PATH } = process.env;',
      'export const f = globalThis.process.env.HOME;',
      "export const g = process['env'].HOME;",
      'export const h = process.env.HOME ?? "";',
      // A cast past the type (its get() would be whatever Object.prototype.get is): reported too.
      'export const i = (process.env as unknown as OwnEnv).get("HOME");',
    ]),
  );
  assert.deepEqual(
    found.map((f) => f.line),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
    show(found),
  );
  assert.match(found[0]!.what, /process\.env\.HOME reads the environment directly: read it through ownEnv\(\)\.get\(name\)/);
});

test('lint (#786): handing process.env on whole, or writing it, is not a read here', () => {
  const found = lintEnvReads(
    fixture([
      'export const a = ownEnv(process.env).get("HOME");',
      'export function f(env: NodeJS.ProcessEnv = process.env) { return env; }',
      'export const c = { ...process.env, X: "1" };',
      'process.env.PATH = "/bin";',
      'delete process.env.X;',
      'markTestRun(process.env);',
    ]),
  );
  assert.deepEqual(found, [], show(found));
});

test("lint (#786): one direct read added to a listed module's real text is reported there", () => {
  const before = readFileSync(join(repoRoot, 'src/tool-path.ts'), 'utf8');
  const files = new Map([['src/tool-path.ts', `${before}\nexport const sneaky = () => process.env.PATH;\n`]]);
  const found = lintEnvReads(files);
  assert.equal(found.length, 1, show(found));
  assert.equal(found[0]!.line, before.split('\n').length + 1);
});
