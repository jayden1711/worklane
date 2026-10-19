// An environment's own variables, and nothing else (#786).
//
// WHY: a variable that isn't set reads through to Object.prototype: once any code in the process sets
// `Object.prototype.X`, `process.env.X` is that value while X is unset (measured on Node 22, #786). The engine's
// safety reads (the system root, the test-run marks, the slot and state dirs, the held-out store) must not depend on
// the prototype being clean.
//
// INVARIANT: an OwnEnv holds a frozen, null-prototype copy of the own string variables of the environment it was
// taken from, so get() returns only a variable that was set there. Its private field makes the type nominal: neither
// process.env nor a plain object is an OwnEnv, and an EnvSource (an OwnEnv or a raw environment) has no index
// signature, so code that takes one can read it only through ownEnv(env).get(name).
//
// LIMIT: code that replaces these builtins before this module loads, replaces a String method (Windows' case fold
// calls one), or edits process.env itself, is out of scope: what is set in the environment is the environment.

/** WHY: builtins taken at load, so a later `Object.keys = …` or `Object.hasOwn = …` changes nothing. */
const keysOf = Object.keys;
const hasOwn = Object.hasOwn;
const freeze = Object.freeze;
const create = Object.create;
const upper = (s: string): string => s.toUpperCase();

/** What a security read may be handed: a snapshot already taken, or a raw environment to take one from. */
export type EnvSource = OwnEnv | Readonly<NodeJS.ProcessEnv>;

export class OwnEnv {
  readonly #vars: Readonly<Record<string, string>>;
  readonly #fold: boolean;

  private constructor(vars: Record<string, string>, fold: boolean) {
    this.#vars = freeze(vars);
    this.#fold = fold;
  }

  /**
   * A snapshot of `source`'s own string variables (an OwnEnv is returned as it is). Windows names are
   * case-insensitive (`Path` is `PATH`), so there both the copy and get() fold to upper case.
   */
  static of(source: EnvSource = process.env, platform: NodeJS.Platform = process.platform): OwnEnv {
    if (OwnEnv.is(source)) return source;
    const fold = platform === 'win32';
    const vars = create(null) as Record<string, string>;
    // WHY: an indexed loop and an own check per name, not for-of: a polluted Array iterator can't add a name.
    const names = keysOf(source);
    for (let i = 0; i < names.length; i++) {
      const k = names[i]!;
      const v = hasOwn(source, k) ? source[k] : undefined;
      if (typeof v === 'string') vars[fold ? upper(k) : k] = v;
    }
    return new OwnEnv(vars, fold);
  }

  /** Whether `x` is a snapshot this module took (the private field's brand: a look-alike object isn't one). */
  static is(x: unknown): x is OwnEnv {
    return typeof x === 'object' && x !== null && #vars in x;
  }

  /** The variable `name`, or undefined when it wasn't set: never a value inherited from a prototype. */
  get(name: string): string | undefined {
    const k = this.#fold ? upper(name) : name;
    return hasOwn(this.#vars, k) ? this.#vars[k] : undefined;
  }

  /**
   * The snapshot itself (frozen, null-prototype) for a function still typed NodeJS.ProcessEnv: its reads are own
   * variables only too. WHY (#786): testSlotsRefusal is rewritten by #818, so its call site hands it this instead.
   */
  asProcessEnv(): NodeJS.ProcessEnv {
    return this.#vars;
  }
}

/** A snapshot of `source` (process.env by default): the one way a security read sees the environment (#786). */
export const ownEnv = (source: EnvSource = process.env, platform: NodeJS.Platform = process.platform): OwnEnv => OwnEnv.of(source, platform);
