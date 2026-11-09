// The loader of src/check-tables.ts, for the scripts that run without a build (#941): a script's tables live in a
// data-only file beside it, `<script>.tables.json`, which the weakening hold compares parsed and never runs. Read by
// the script's own URL, each table deep-frozen. The format, the tags and what fails to load are src/check-tables.ts's,
// line for line; test/check-tables.test.ts holds the two loaders to the same answers on every tables file in the repo
// and on the same bad files. Scripts fill in no placeholder: the product-rename tool rewrites their files.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TABLES_FILE = /(?:^|\/)[^/]+\.tables\.json$/;
export const TABLE_NAME = /^[A-Z][A-Z0-9_]*$/;
export const COMMENT = '//';

const KINDS = ['never-shrink', 'never-grow', 'exact'];
const FLAGS = /^[dgimsuvy]*$/;

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `v` with every comment key taken out, checked as src/check-tables.ts dataOf. */
function dataOf(v, at) {
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
        throw new Error(`${at}: the regexp doesn't compile (${e.message})`);
      }
      return { $regexp: source, flags };
    }
    throw new Error(`${at}: a tagged value must be {"$set": [...]} or {"$regexp": "...", "flags": "..."}, not ${JSON.stringify(keys)}`);
  }
  return Object.fromEntries(keys.map((k) => [k, dataOf(v[k], `${at}.${k}`)]));
}

/** A tables file's tables, by name: { kind, value }, comments taken out. Throws as src/check-tables.ts parseTables. */
export function parseTables(text, file) {
  let top;
  try {
    top = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file}: not JSON (${e.message})`);
  }
  if (!isObject(top)) throw new Error(`${file}: not a JSON object of tables`);
  const out = new Map();
  for (const name of Object.keys(top)) {
    if (name === COMMENT) continue;
    if (!TABLE_NAME.test(name)) throw new Error(`${file}: "${name.slice(0, 60)}" is not a table name (A-Z, 0-9, _)`);
    const t = top[name];
    if (!isObject(t)) throw new Error(`${file}: ${name} is not {"kind": ..., "value": ...}`);
    const keys = Object.keys(t).filter((k) => k !== COMMENT);
    if (keys.length !== 2 || !keys.includes('kind') || !keys.includes('value')) throw new Error(`${file}: ${name} must have exactly "kind" and "value" (and comments)`);
    if (typeof t.kind !== 'string' || !KINDS.includes(t.kind)) throw new Error(`${file}: ${name}'s kind must be never-shrink, never-grow or exact`);
    out.set(name, { kind: t.kind, value: dataOf(t.value, name) });
  }
  return out;
}

/** A new RegExp for a Pattern ({ source, flags }), for the script that uses it to keep to itself. */
export const regExpOf = (p) => new RegExp(p.source, p.flags);
/** A new RegExp for each Pattern, in a frozen list: for the script that uses them to keep to itself (never export it). */
export const regExpsOf = (ps) => Object.freeze(ps.map(regExpOf));

// FrozenSet: begin (scripts/lib/table-copies.mjs copies these lines, as they are, into a script that runs on its own)
/** A set that can't change, as src/check-tables.ts frozenSet: a frozen object over a set held in a closure. */
const frozenSet = (values) => {
  const store = new Set(values);
  return Object.freeze({
    get size() {
      return store.size;
    },
    has: (v) => store.has(v),
    forEach(f, self) {
      for (const v of store) f.call(self, v, v, this);
    },
    *entries() {
      for (const v of store) yield [v, v];
    },
    *keys() {
      yield* store;
    },
    *values() {
      yield* store;
    },
    *[Symbol.iterator]() {
      yield* store;
    },
  });
};
// FrozenSet: end
export { frozenSet };

/** Parsed data as a script gets it: deep-frozen, a `$set` a FrozenSet, a `$regexp` a Pattern. `fill` puts placeholders in (tests only). */
function frozen(v, fill) {
  if (typeof v === 'string') return fill(v);
  if (Array.isArray(v)) return Object.freeze(v.map((x) => frozen(x, fill)));
  if (!isObject(v)) return v;
  if ('$set' in v) return frozenSet(v.$set.map((x) => frozen(x, fill)));
  if ('$regexp' in v) return Object.freeze({ source: v.$regexp, flags: v.flags });
  return Object.freeze(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, frozen(x, fill)])));
}

/** The tables of a tables file's text, deep-frozen: { names, get(name) }, get throwing on a name it hasn't. */
export function tablesFrom(text, file, fill = (s) => s) {
  const values = new Map([...parseTables(text, file)].map(([n, t]) => [n, frozen(t.value, fill)]));
  const names = Object.freeze([...values.keys()]);
  return Object.freeze({
    names,
    get(name) {
      if (!values.has(name)) throw new Error(`${file} has no table ${name}`);
      return values.get(name);
    },
  });
}

/** Where the script at `moduleUrl` keeps its tables: its path with the extension replaced by `.tables.json`. */
export const tablesFileOf = (moduleUrl) => fileURLToPath(moduleUrl).replace(/\.[cm]?[jt]s$/, '') + '.tables.json';

/** The file of the code that called `fn`, from the call stack's text (no write to `import.meta.url` changes it). */
export function callerFile(fn) {
  const limit = Error.stackTraceLimit;
  const o = {};
  try {
    Error.stackTraceLimit = 1;
    Error.captureStackTrace(o, fn);
  } finally {
    Error.stackTraceLimit = limit;
  }
  return typeof o.stack === 'string' ? frameFile(o.stack) : undefined;
}

/** The file of a stack text's first frame (`    at f (file:///x.js:1:2)` or `    at file:///x.js:1:2`). */
export function frameFile(stack) {
  const at = stack.split('\n').find((l) => /^ {4}at /.test(l));
  const m = at === undefined ? null : (/\((\S[^()]*):\d+:\d+\)$/.exec(at) ?? /^ {4}at (?:async )?([^\s()]+):\d+:\d+$/.exec(at));
  return m?.[1];
}

/** Whether the stack's `caller` is the script at `url`: the same URL (scripts run unbuilt, with no source map). */
export const isCaller = (caller, url) => caller !== undefined && caller === url;

/**
 * The tables of the script at `moduleUrl` (its `import.meta.url`), from its own tables file. Throws when it can't, or
 * when `moduleUrl` isn't the calling script's own file (R1184s D1).
 */
export function tablesOf(moduleUrl) {
  const caller = callerFile(tablesOf);
  if (!isCaller(caller, moduleUrl)) throw new Error(`tablesOf: ${moduleUrl} is not the calling module (${caller ?? 'no stack frame'}); a module loads only its own tables, as tablesOf(import.meta.url)`);
  const file = tablesFileOf(moduleUrl);
  return tablesFrom(readFileSync(file, 'utf8'), file);
}
