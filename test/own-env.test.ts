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
import { agentAuthEnv, agentEnv } from '../src/runner.js';
import { localServiceEnv } from '../src/service.js';
import { detectClaudeLogin, probeEnv, type SetupProbe } from '../src/setup-steps.js';
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

test("regression (#786 round 3): on Windows an agent's environment keeps SystemRoot, ComSpec, ProgramData and ProgramFiles from a snapshot", () => {
  const win: NodeJS.ProcessEnv = { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe', ProgramData: 'C:\\ProgramData', ProgramFiles: 'C:\\Program Files', USERPROFILE: 'C:\\Users\\example' };
  const keep = ['SystemRoot', 'ComSpec', 'ProgramData', 'ProgramFiles', 'USERPROFILE'];
  const pick = (e: NodeJS.ProcessEnv) => Object.fromEntries(keep.map((k) => [k, e[k]]));
  // What runner.ts, cli-agents.ts and skill eval hand agentEnv: a snapshot, taken as on Windows. Its names keep their
  // case, as Windows' own environment does, so an exact-case read of it finds them.
  assert.deepEqual(pick(agentEnv(ownEnv(win, 'win32').asProcessEnv(), 'cli')), pick(win));
  assert.equal(ownEnv(win, 'win32').asProcessEnv().Path, 'C:\\bin', 'asProcessEnv keeps each name as written');
  // agentEnv reads its base through get(): a Windows snapshot's `Path` is the agent's PATH, as Windows' own env gives it.
  const fromSnapshot = agentEnv(ownEnv(win, 'win32'), 'cli');
  assert.deepEqual([fromSnapshot.PATH, fromSnapshot.SystemRoot], ['C:\\bin', 'C:\\Windows']);
  // Its result is an ordinary object (a child's env, #846), so the check is for an own TZ, not a read of one.
  polluted({ TZ: 'from-the-prototype' }, () => assert.equal(Object.hasOwn(agentEnv({ PATH: '/bin' }, 'cli'), 'TZ'), false, 'a raw base: own variables only'));
});

// After #819: agentAuthEnv is the pass-through list both the runner and the wizard's Claude step read, so it is the
// security read, and it reads its base through the same snapshot.
const PROTO_LOGIN = { ANTHROPIC_API_KEY: 'sk-from-the-prototype', TZ: 'from-the-prototype', CLAUDE_CONFIG_DIR: '/from-the-prototype' };

test("after #819 (#786): agentAuthEnv sees only variables that are set: an ANTHROPIC_API_KEY, TZ or CLAUDE_CONFIG_DIR on Object.prototype is not the agent's", () => {
  polluted(PROTO_LOGIN, () => {
    for (const runtime of ['api_key', 'cli'] as const) {
      assert.deepEqual(Object.keys(agentAuthEnv({ PATH: '/bin' }, runtime)), ['PATH'], `${runtime}: a raw base`);
      assert.deepEqual(Object.keys(agentAuthEnv(ownEnv({ PATH: '/bin' }), runtime)), ['PATH'], `${runtime}: a snapshot`);
    }
    assert.equal(agentAuthEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk-own' }, 'api_key').ANTHROPIC_API_KEY, 'sk-own', 'a key that is set still reaches an api_key run');
    assert.equal(Object.hasOwn(agentEnv({ PATH: '/bin' }, 'api_key'), 'ANTHROPIC_API_KEY'), false, 'agentEnv, which builds on it');
  });
});

test('after #819 (#786): agentAuthEnv on Windows (modelled): a name in any case is the variable, and a prototype key still is not', () => {
  const win: NodeJS.ProcessEnv = { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', Anthropic_Api_Key: 'sk-own' };
  const env = agentAuthEnv(ownEnv(win, 'win32'), 'api_key');
  assert.deepEqual([env.PATH, env.SystemRoot, env.ANTHROPIC_API_KEY], ['C:\\bin', 'C:\\Windows', 'sk-own']);
  // agentEnv hands its base on whole, so a Windows snapshot's case-folded index reaches agentAuthEnv.
  assert.equal(agentEnv(ownEnv(win, 'win32'), 'api_key').ANTHROPIC_API_KEY, 'sk-own');
  polluted({ ...PROTO_LOGIN, anthropic_api_key: 'sk-from-the-prototype' }, () => {
    const bare = agentAuthEnv(ownEnv({ Path: 'C:\\bin' }, 'win32'), 'api_key');
    assert.deepEqual(Object.keys(bare), ['PATH']);
    assert.equal(bare.PATH, 'C:\\bin');
  });
});

test("after #819 (#786): the Claude step's environment and its login's cache key see only variables that are set", () => {
  const ids: string[] = [];
  const probe: Pick<SetupProbe, 'which' | 'run' | 'serviceManagerEnv'> = {
    which: () => '/stand-in/claude',
    serviceManagerEnv: () => ({ env: {} }),
    // Stand-ins: `claude auth status` signed in on claude.ai, and the proof call answered. Nothing is run.
    run: (_cmd, args) => ({ status: 0, stdout: JSON.stringify(args[0] === 'auth' ? { loggedIn: true, authMethod: 'claude.ai' } : { subtype: 'success', is_error: false }), stderr: '' }),
  };
  const seen = polluted({ ...PROTO_LOGIN, HOME: '/from-the-prototype' }, () => {
    const env = probeEnv({ agentRuntime: 'api_key', managerEnv: {} });
    detectClaudeLogin(probe, { kind: 'cli', source: 'config' }, (id, call) => (ids.push(id), call()));
    return {
      unitHome: localServiceEnv({ PATH: '/bin' }).HOME,
      authStatusEnv: ['ANTHROPIC_API_KEY', 'TZ', 'CLAUDE_CONFIG_DIR'].filter((k) => Object.hasOwn(env, k)),
      cacheKeyConfigDir: ids.length === 1 ? (JSON.parse(ids[0]!) as unknown[]).at(-1) : `${ids.length} calls`,
    };
  });
  // The local unit's HOME; what `claude auth status` runs with; the manager's CLAUDE_CONFIG_DIR in the login's cache key.
  assert.deepEqual(seen, { unitHome: '', authStatusEnv: [], cacheKeyConfigDir: null });
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
 * Not yet here, each until the PR named edits it no more: src/os/index.ts (stateDir and the project command's LANG;
 * #818 has merged, so a follow-up), src/hook.ts, src/guardrails/context.ts and src/mcp/connector.ts (#785),
 * src/cli.ts (#743, #769, #803, #836).
 */
export const OWN_ENV_MODULES: readonly string[] = [
  'src/avatars.ts',
  'src/browser/run.ts',
  'src/cli-agents.ts',
  'src/coordinator/browser.ts',
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
  'src/service.ts',
  'src/setup-steps.ts',
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
