// The registered check tables of the engine's own code (#941): a module's tables live in a data-only file beside it,
// `<module>.tables.json` (`src/review.ts` reads `src/review.tables.json`). The weakening hold reads that file as
// parsed data, before and after a change, and never runs code (src/merge-policy-weakening.ts, jsonTableFindings). A
// module loads its own file here, by its own URL (checked against its call sites: callerScript), and gets each table deep-frozen: no write to a table succeeds after
// load. What the load returns can still be changed by code that runs before it and replaces a built-in it calls
// (JSON.parse, Array.prototype.map, Object.freeze, readFileSync): open, named by the owner (R1184p P1; #1251). No path is
// written at the load site. The load line and each `TABLES.get('NAME')` line can't be removed or
// changed without the owner (the hold's TABLE_LOAD; each load statement is on one line), and an added line that
// imports the loader any other way, or uses `import.meta` other than to read it (this reads the path from its `.url`),
// waits too (LOADER_IMPORT); a specifier computed at run time is a named limit (R1184o 3). The hold reads lines as text; test/merge-policy.test.ts's
// backstop reads every module parsed. A use moved off a table while its load stays is the open class the owner named
// (#941).
//
// A tables file is one JSON object: each key a table's name (A-Z, 0-9, `_`), each value
// `{ "kind": "never-shrink" | "never-grow" | "exact", "value": <data> }` (exact: an entry added, lost or changed
// waits, for a table that any change can loosen). A `"//"` key, in any object, is a comment: it is
// dropped at load and by the hold. The data is JSON, plus two tagged shapes:
//   - `{ "$set": [...] }`: a FrozenSet (frozenSet), a read-only set (no add, delete or clear; not a Set, so
//     Set.prototype's methods can't be called on it either);
//   - `{ "$regexp": "<source>", "flags": "<flags>" }`: a Pattern, `{ source, flags }`, never a RegExp. A frozen RegExp
//     is not frozen: RegExp.prototype.compile rewrites its pattern in place before it throws (measured, Node 26). The
//     module that uses one builds its own RegExp from it (regExpOf) and keeps it to itself.
// A string may hold `{configDir}` or `{cli}`: BRAND's config folder and CLI name, put in at load (the product name
// lives only in src/brand.ts); a `$regexp`'s source never has them filled in. The hold compares the text as written.
//
// Anything else fails to load: a key or a tag not listed here, a kind not listed, a `$regexp` that doesn't compile, a
// number that isn't finite (1e400) or is -0 (either would compare as another value). (A
// `__proto__` key is an own key like any other: objects are made with Object.fromEntries, never by assignment.)
// The hold reads the file with the same parser (parseTables), so a file that can't load waits.
// scripts/lib/check-tables.mjs is the same loader for the scripts that run without a build; test/check-tables.test.ts
// holds the two to the same answers on every tables file in the repo.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as util from 'node:util';
import { BRAND } from './brand.js';

export type TableKind = 'never-shrink' | 'never-grow' | 'exact';

/** One table as its file declares it: its kind, and its data with every comment taken out. */
export interface ParsedTable {
  kind: TableKind;
  value: unknown;
}

/** A tables file's name: `<module>.tables.json`. */
export const TABLES_FILE = /(?:^|\/)[^/]+\.tables\.json$/;
/** A table's name. */
export const TABLE_NAME = /^[A-Z][A-Z0-9_]*$/;
/** A comment key, in any object. */
export const COMMENT = '//';

const KINDS: readonly string[] = ['never-shrink', 'never-grow', 'exact'];
const FLAGS = /^[dgimsuvy]*$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * `v` with every comment key taken out, checked: a tagged shape is exactly one of the two.
 * Throws, naming where, on anything else.
 */
function dataOf(v: unknown, at: string): unknown {
  // A number JSON can't hold (1e400 parses to Infinity) or -0 would compare as another value (null, 0): refused.
  if (typeof v === 'number' && (!Number.isFinite(v) || Object.is(v, -0))) throw new Error(`${at}: a number that isn't finite, or -0`);
  if (Array.isArray(v)) return v.map((x, k) => dataOf(x, `${at}[${k}]`));
  if (!isObject(v)) return v;
  const keys = Object.keys(v).filter((k) => k !== COMMENT);
  if (keys.some((k) => k.startsWith('$'))) {
    if (keys.length === 1 && keys[0] === '$set') {
      if (!Array.isArray(v.$set)) throw new Error(`${at}: "$set" is not a list`);
      return { $set: dataOf(v.$set, `${at}.$set`) };
    }
    if (keys.length === 2 && keys.includes('$regexp') && keys.includes('flags')) {
      const [source, flags] = [v.$regexp, v.flags];
      if (typeof source !== 'string' || typeof flags !== 'string' || !FLAGS.test(flags)) throw new Error(`${at}: "$regexp" and "flags" must be strings, the flags among dgimsuvy`);
      try {
        new RegExp(source, flags);
      } catch (e) {
        throw new Error(`${at}: the regexp doesn't compile (${(e as Error).message})`);
      }
      return { $regexp: source, flags };
    }
    throw new Error(`${at}: a tagged value must be {"$set": [...]} or {"$regexp": "...", "flags": "..."}, not ${JSON.stringify(keys)}`);
  }
  return Object.fromEntries(keys.map((k) => [k, dataOf(v[k], `${at}.${k}`)]));
}

/**
 * A tables file's tables, by name: each one's kind and its data, comments taken out. Throws when the text isn't JSON or
 * isn't a tables file as above (the hold then waits). The one parser: the loader and the hold both read through it.
 */
export function parseTables(text: string, file: string): Map<string, ParsedTable> {
  let top: unknown;
  try {
    top = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file}: not JSON (${(e as Error).message})`);
  }
  if (!isObject(top)) throw new Error(`${file}: not a JSON object of tables`);
  const out = new Map<string, ParsedTable>();
  for (const name of Object.keys(top)) {
    if (name === COMMENT) continue;
    if (!TABLE_NAME.test(name)) throw new Error(`${file}: "${name.slice(0, 60)}" is not a table name (A-Z, 0-9, _)`);
    const t = top[name];
    if (!isObject(t)) throw new Error(`${file}: ${name} is not {"kind": ..., "value": ...}`);
    const keys = Object.keys(t).filter((k) => k !== COMMENT);
    if (keys.length !== 2 || !keys.includes('kind') || !keys.includes('value')) throw new Error(`${file}: ${name} must have exactly "kind" and "value" (and comments)`);
    if (typeof t.kind !== 'string' || !KINDS.includes(t.kind)) throw new Error(`${file}: ${name}'s kind must be never-shrink, never-grow or exact`);
    out.set(name, { kind: t.kind as TableKind, value: dataOf(t.value, name) });
  }
  return out;
}

/** A regexp as a table holds it: data. regExpOf makes a RegExp of it. */
export interface Pattern {
  readonly source: string;
  readonly flags: string;
}

/** A new RegExp for `p`, for the module that uses it to keep to itself. */
export const regExpOf = (p: Pattern): RegExp => new RegExp(p.source, p.flags);
/** A new RegExp for each of `ps`, in a frozen list: for the module that uses them to keep to itself (never export it). */
export const regExpsOf = (ps: readonly Pattern[]): readonly RegExp[] => Object.freeze(ps.map(regExpOf));

/** A set that can't change (frozenSet): a read-only set, its methods only. */
export type FrozenSet<T> = ReadonlySet<T>;

/**
 * A set that can't change: a frozen object whose methods read a Set held where no code can reach it. No add, delete or
 * clear, and not a Set (Set.prototype's methods throw on it); no class, so no prototype of its own to patch.
 */
export function frozenSet<T>(values: Iterable<T>): FrozenSet<T> {
  const store = new Set(values);
  return Object.freeze({
    get size() {
      return store.size;
    },
    has: (v: T) => store.has(v),
    forEach(f: (value: T, again: T, set: ReadonlySet<T>) => void, self?: unknown) {
      for (const v of store) f.call(self, v, v, this as unknown as ReadonlySet<T>);
    },
    *entries(): Generator<[T, T]> {
      for (const v of store) yield [v, v];
    },
    *keys(): Generator<T> {
      yield* store;
    },
    *values(): Generator<T> {
      yield* store;
    },
    *[Symbol.iterator](): Generator<T> {
      yield* store;
    },
  }) as unknown as FrozenSet<T>;
}

/** The strings BRAND fills in at load. */
const PLACEHOLDERS: readonly [string, string][] = [
  ['{configDir}', BRAND.configDir],
  ['{cli}', BRAND.cli],
];
const filled = (s: string) => PLACEHOLDERS.reduce((t, [k, v]) => t.split(k).join(v), s);

/** Parsed data as the code gets it: deep-frozen, a `$set` a FrozenSet, a `$regexp` a Pattern, placeholders filled. */
function frozen(v: unknown): unknown {
  if (typeof v === 'string') return filled(v);
  if (Array.isArray(v)) return Object.freeze(v.map(frozen));
  if (!isObject(v)) return v;
  if ('$set' in v) return frozenSet((v.$set as unknown[]).map(frozen));
  // A pattern's source is taken as written: a placeholder's value isn't regexp text (its `.` would match anything).
  if ('$regexp' in v) return Object.freeze({ source: v.$regexp as string, flags: v.flags as string });
  return Object.freeze(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, frozen(x)])));
}

/** A module's tables, each deep-frozen. `get` throws on a name the file doesn't have. */
export interface Tables {
  get<T>(name: string): T;
  readonly names: readonly string[];
}

/** The tables of the text of a tables file, deep-frozen. Throws as parseTables does. */
export function tablesFrom(text: string, file: string): Tables {
  const values = new Map([...parseTables(text, file)].map(([n, t]) => [n, frozen(t.value)]));
  const names = Object.freeze([...values.keys()]);
  return Object.freeze({
    names,
    get<T>(name: string): T {
      if (!values.has(name)) throw new Error(`${file} has no table ${name}`);
      return values.get(name) as T;
    },
  });
}

/** Where the module at `moduleUrl` keeps its tables: its path with the extension replaced by `.tables.json`. */
export const tablesFileOf = (moduleUrl: string): string => fileURLToPath(moduleUrl).replace(/\.[cm]?[jt]s$/, '') + '.tables.json';

/**
 * The script that called the function calling this one, from V8's structured call sites (node:util getCallSites,
 * with source maps off, so `--enable-source-maps` changes nothing): the module V8 is running, which no write to
 * `import.meta.url` changes. It sets no stack hook (src/ may not: test/slot-path.test.ts, #806), and it reads no stack
 * text, so a path with parentheses or spaces is read as it is. Undefined when Node has no getCallSites (the engines
 * floor, 22.13, has it with the sourceMap option), so the load is refused: fail closed.
 */
function callerScript(): string | undefined {
  if (typeof util.getCallSites !== 'function') return undefined;
  // [0] is this function, [1] tablesOf, [2] its caller.
  return util.getCallSites(3, { sourceMap: false })[2]?.scriptName;
}

/**
 * The tables of the module at `moduleUrl` (its `import.meta.url`), read from its own tables file. Throws when it can't,
 * or when `moduleUrl` isn't the calling module's own file (R1184s D1): a module that writes its `import.meta.url` first
 * (in any spelling: `import.meta.url! = …`, `(import.meta.url as string) = …`, a pattern, a target split over lines)
 * can't load another file's tables as its own.
 */
export function tablesOf(moduleUrl: string): Tables {
  const caller = callerScript();
  if (caller === undefined || caller !== moduleUrl) throw new Error(`tablesOf: ${moduleUrl} is not the calling module (${caller ?? 'no stack frame'}); a module loads only its own tables, as tablesOf(import.meta.url)`);
  const file = tablesFileOf(moduleUrl);
  return tablesFrom(readFileSync(file, 'utf8'), file);
}
