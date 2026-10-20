// Every child process the engine starts, started here (#846).
//
// WHY: Node's child_process copies an env object's enumerable INHERITED keys into the child's environment (its
// normalizeSpawnArguments walks `for (const key in env)`), and with no `env` it walks process.env the same way
// (measured on Node 22, #846). So once any code in the process sets `Object.prototype.NODE_OPTIONS` (or GIT_*,
// HTTPS_PROXY, PERL5OPT, ...), every child gets it, past outboundEnv's and withoutPushGateHatch's deletions, which
// remove own keys only. src/os/own-env.ts (#786) closed the engine's own reads; this closes what its children get.
//
// INVARIANT: spawn, spawnSync, execFile and execFileSync here are node:child_process's, except that the child's
// environment is always childEnvOf(options.env || process.env): a null-prototype copy of the own variables only, so no
// value reaches a child from a prototype, whatever the caller passed (a plain object, a spread, nothing at all). The
// options themselves are passed as a null-prototype copy of their own keys too. No other module in src/ imports
// node:child_process for a value (test/child-process.test.ts, the backstop); a type-only import is fine.
//
// With a clean prototype a child gets exactly what it got before: the same own variables (undefined ones left out, as
// Node leaves them out), in the same order.
//
// LIMIT: code that replaces these builtins, edits process.env itself, or patches node:child_process's exports, is out
// of scope: what is set in the environment is the environment. Each call reads node:child_process's live export (none
// is captured at load), so a test's spy on node:child_process still sees every spawn.
import * as cp from 'node:child_process';
import { promisify } from 'node:util';
import { OwnEnv, type EnvSource } from './own-env.js';

export type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';

/** WHY: builtins taken at load, so a later `Object.keys = …` or `Object.hasOwn = …` changes nothing. */
const keysOf = Object.keys;
const hasOwn = Object.hasOwn;
const create = Object.create;
const isArray = Array.isArray;
const defineProperty = Object.defineProperty;

/**
 * The environment a child gets from `source` (process.env by default): a fresh null-prototype object with `source`'s
 * own variables, in their order, each one that isn't undefined kept as it is. Nothing inherited, ever.
 */
export function childEnvOf(source: EnvSource = process.env): NodeJS.ProcessEnv {
  const from = (OwnEnv.is(source) ? source.asProcessEnv() : source) as Readonly<Record<string, unknown>>;
  const env = create(null) as Record<string, unknown>;
  // WHY: an indexed loop and an own check per name, not for-in or for-of: neither a prototype nor a polluted Array
  // iterator can add a name.
  const names = keysOf(from);
  for (let i = 0; i < names.length; i++) {
    const k = names[i]!;
    if (!hasOwn(from, k)) continue;
    const v = from[k];
    if (v !== undefined) env[k] = v;
  }
  return env as NodeJS.ProcessEnv;
}

/**
 * `options` as Node will read it, with the child's environment built by childEnvOf: a null-prototype copy of its own
 * keys, so an inherited `env` (or anything else) is never read. Not an object (a caller's mistake): handed on as it
 * is, for Node to refuse as it always has.
 */
function withChildEnv(options: unknown): unknown {
  if (options != null && (typeof options !== 'object' || isArray(options))) return options;
  const out = create(null) as Record<string, unknown>;
  if (options != null) {
    const o = options as Record<string, unknown>;
    const names = keysOf(o);
    for (let i = 0; i < names.length; i++) {
      const k = names[i]!;
      if (hasOwn(o, k)) out[k] = o[k];
    }
  }
  // As Node reads it: `options.env || process.env`.
  out.env = childEnvOf((out.env || process.env) as EnvSource);
  return out;
}

/** (args?, options?) as Node reads them: an object (not an array) where the arguments go is the options. */
function argsAndOptions(a: unknown, b: unknown): [unknown, unknown] {
  if (a != null && typeof a === 'object' && !isArray(a)) return [[], a];
  return [a ?? [], b];
}

/** (args?, options?, callback?) as execFile reads them: a function in any of the three places is the callback. */
function execFileArgs(a: unknown, b: unknown, c: unknown): [unknown, unknown, unknown] {
  if (typeof a === 'function') return [[], undefined, a];
  if (a != null && typeof a === 'object' && !isArray(a)) return [[], a, b];
  if (typeof b === 'function') return [a ?? [], undefined, b];
  return [a ?? [], b, c];
}

type Untyped = (...args: unknown[]) => unknown;

/** node:child_process's spawn; the child's environment is childEnvOf(options.env || process.env). */
export const spawn = ((command: string, a?: unknown, b?: unknown) => {
  const [args, options] = argsAndOptions(a, b);
  return (cp.spawn as Untyped)(command, args, withChildEnv(options));
}) as unknown as typeof cp.spawn;

/** node:child_process's spawnSync; the child's environment is childEnvOf(options.env || process.env). */
export const spawnSync = ((command: string, a?: unknown, b?: unknown) => {
  const [args, options] = argsAndOptions(a, b);
  return (cp.spawnSync as Untyped)(command, args, withChildEnv(options));
}) as unknown as typeof cp.spawnSync;

/** node:child_process's execFileSync; the child's environment is childEnvOf(options.env || process.env). */
export const execFileSync = ((file: string, a?: unknown, b?: unknown) => {
  const [args, options] = argsAndOptions(a, b);
  return (cp.execFileSync as Untyped)(file, args, withChildEnv(options));
}) as unknown as typeof cp.execFileSync;

/** node:child_process's execFile (promisify gives { stdout, stderr }, as Node's does); the same environment rule. */
export const execFile = ((file: string, a?: unknown, b?: unknown, c?: unknown) => {
  const [args, options, callback] = execFileArgs(a, b, c);
  return (cp.execFile as Untyped)(file, args, withChildEnv(options), callback);
}) as unknown as typeof cp.execFile;
defineProperty(execFile, promisify.custom, {
  enumerable: false,
  value: (file: string, a?: unknown, b?: unknown) => {
    const [args, options] = execFileArgs(a, b, undefined);
    return ((cp.execFile as unknown as Record<symbol, Untyped>)[promisify.custom]!)(file, args, withChildEnv(options));
  },
});
