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
// options themselves are passed as a null-prototype copy of their own keys too. startSetupWorker does the same for the
// engine's one worker_threads Worker (whose options' `env` was read through the prototype, #883 rounds 2 and 3), from
// a fixed script and never eval, so it loads no other code (#806). No other module in src/
// imports node:child_process for a value, nor Worker from node:worker_threads (test/child-process.test.ts, the
// backstop); a type-only import is fine.
//
// With a clean prototype a child gets exactly what it got before: the same own variables in the same order (an own
// undefined one is still left out, and still opts out of NODE_V8_COVERAGE), and the same refusals of bad options.
//
// LIMIT: code that replaces these builtins, edits process.env itself, or patches node:child_process's exports, is out
// of scope: what is set in the environment is the environment. Each call reads node:child_process's live export (none
// is captured at load), so a test's spy on node:child_process still sees every spawn.
import * as cp from 'node:child_process';
import { promisify } from 'node:util';
import * as wt from 'node:worker_threads';
import { OwnEnv, type EnvSource } from './own-env.js';

export type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';

/** WHY: builtins taken at load, so a later `Object.keys = …` or `Object.hasOwn = …` changes nothing. */
const keysOf = Object.keys;
const hasOwn = Object.hasOwn;
const create = Object.create;
const isArray = Array.isArray;
const defineProperty = Object.defineProperty;

/** A fresh null-prototype object with `o`'s own enumerable keys and their values, in order: nothing inherited. */
function ownCopy(o: object): Record<string, unknown> {
  const from = o as Record<string, unknown>;
  const out = create(null) as Record<string, unknown>;
  // WHY: an indexed loop and an own check per name, not for-in or for-of: neither a prototype nor a polluted Array
  // iterator can add a name.
  const names = keysOf(from);
  for (let i = 0; i < names.length; i++) {
    const k = names[i]!;
    if (hasOwn(from, k)) out[k] = from[k];
  }
  return out;
}

/**
 * The environment a child gets from `source` (process.env by default): a fresh null-prototype object with `source`'s
 * own variables, in their order, each kept as it is. Nothing inherited, ever. An own variable set to undefined stays:
 * Node leaves it out of the child as before, and reads it as the caller's opt-out (NODE_V8_COVERAGE, #883 round 2).
 */
export function childEnvOf(source: EnvSource = process.env): NodeJS.ProcessEnv {
  return ownCopy(OwnEnv.is(source) ? source.asProcessEnv() : source) as NodeJS.ProcessEnv;
}

/**
 * `options` as Node will read it, with the child's environment built by childEnvOf: a null-prototype copy of its own
 * keys, so an inherited `env` (or anything else) is never read. Not an object (a caller's mistake), or null where Node
 * refuses null (`nullIsNone` false: spawn, spawnSync), is handed on as it is, for Node to refuse as it always has.
 */
function withChildEnv(options: unknown, nullIsNone: boolean): unknown {
  if (options === null && !nullIsNone) return options;
  if (options != null && (typeof options !== 'object' || isArray(options))) return options;
  const out = options != null ? ownCopy(options as object) : (create(null) as Record<string, unknown>);
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
  return (cp.spawn as Untyped)(command, args, withChildEnv(options, false));
}) as unknown as typeof cp.spawn;

/** node:child_process's spawnSync; the child's environment is childEnvOf(options.env || process.env). */
export const spawnSync = ((command: string, a?: unknown, b?: unknown) => {
  const [args, options] = argsAndOptions(a, b);
  return (cp.spawnSync as Untyped)(command, args, withChildEnv(options, false));
}) as unknown as typeof cp.spawnSync;

/** node:child_process's execFileSync; the child's environment is childEnvOf(options.env || process.env). */
export const execFileSync = ((file: string, a?: unknown, b?: unknown) => {
  const [args, options] = argsAndOptions(a, b);
  return (cp.execFileSync as Untyped)(file, args, withChildEnv(options, true));
}) as unknown as typeof cp.execFileSync;

/** node:child_process's execFile (promisify gives { stdout, stderr }, as Node's does); the same environment rule. */
export const execFile = ((file: string, a?: unknown, b?: unknown, c?: unknown) => {
  const [args, options, callback] = execFileArgs(a, b, c);
  return (cp.execFile as Untyped)(file, args, withChildEnv(options, true), callback);
}) as unknown as typeof cp.execFile;
defineProperty(execFile, promisify.custom, {
  enumerable: false,
  value: (file: string, a?: unknown, b?: unknown) => {
    const [args, options] = execFileArgs(a, b, undefined);
    return ((cp.execFile as unknown as Record<symbol, Untyped>)[promisify.custom]!)(file, args, withChildEnv(options, true));
  },
});

/**
 * The setup check's worker (src/setup-worker.ts, started by checkSetupOffThread), and no other: the engine's one Worker
 * (#883 rounds 2 and 3). WHY: a Worker whose options set no `env` reads `options.env` through the prototype, so
 * `Object.prototype.env` became the worker's whole environment, and so that of every child it starts (gh, claude, the
 * service manager; measured, Node 22). The other options are read the same way: an inherited `execArgv` of
 * `--require <file>` ran that file in the worker, and an inherited `resourceLimits` crashed it (measured, #883 round 3).
 * So `env` is always given, childEnvOf(process.env) (what the worker got before with a clean prototype), and every
 * other option Node reads is an own key here, undefined (Node's default), so none is read from a prototype.
 * The one it can't name is `eval` (#806's lint refuses the word in a Worker's options): an inherited `eval` makes
 * Node refuse to start the worker (a URL script can't be eval'd), so it fails closed (measured).
 * INVARIANT (#806): the script is a fixed literal src/ module and the options a literal without `eval` or a spread, so
 * this is no code loader; test/slot-path.test.ts holds every Worker in src/ to that. Another worker gets its own fixed
 * starter beside this one. test/child-process.test.ts fails if Node reads an option name this literal doesn't set.
 */
export function startSetupWorker(workerData: unknown): wt.Worker {
  return new wt.Worker(new URL('../setup-worker.js', import.meta.url), {
    workerData,
    env: childEnvOf(process.env),
    argv: undefined,
    execArgv: undefined,
    name: undefined,
    resourceLimits: undefined,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    trackUnmanagedFds: undefined,
    transferList: undefined,
  });
}
