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
  /** Windows only: each name folded to upper case, to the name as written (null elsewhere). */
  readonly #index: Readonly<Record<string, string>> | null;

  private constructor(vars: Record<string, string>, index: Record<string, string> | null) {
    this.#vars = freeze(vars);
    this.#index = index && freeze(index);
  }

  /**
   * A snapshot of `source`'s own string variables (an OwnEnv is returned as it is), each name kept as written.
   * Windows names are case-insensitive (`Path` is `PATH`), so there get() looks a name up case-insensitively; when
   * two names differ only in case, the later one copied answers.
   */
  static of(source: EnvSource = process.env, platform: NodeJS.Platform = process.platform): OwnEnv {
    if (OwnEnv.is(source)) return source;
    const vars = create(null) as Record<string, string>;
    const index = platform === 'win32' ? (create(null) as Record<string, string>) : null;
    // WHY: an indexed loop and an own check per name, not for-of: a polluted Array iterator can't add a name.
    const names = keysOf(source);
    for (let i = 0; i < names.length; i++) {
      const k = names[i]!;
      const v = hasOwn(source, k) ? source[k] : undefined;
      if (typeof v !== 'string') continue;
      vars[k] = v;
      if (index) index[upper(k)] = k;
    }
    return new OwnEnv(vars, index);
  }

  /** Whether `x` is a snapshot this module took (the private field's brand: a look-alike object isn't one). */
  static is(x: unknown): x is OwnEnv {
    return typeof x === 'object' && x !== null && #vars in x;
  }

  /** The variable `name`, or undefined when it wasn't set: never a value inherited from a prototype. */
  get(name: string): string | undefined {
    const index = this.#index;
    const k = index ? (hasOwn(index, upper(name)) ? index[upper(name)]! : undefined) : name;
    return k !== undefined && hasOwn(this.#vars, k) ? this.#vars[k] : undefined;
  }

  /**
   * The snapshot itself (frozen, null-prototype, each name as written) for a function still typed NodeJS.ProcessEnv:
   * its reads are own variables only too. Plain property reads are case-sensitive even on Windows, so a read of it
   * must use the name's own case there (as Windows writes it: `Path`, `SystemRoot`); get() needn't.
   * WHY (#786): testSlotsRefusal (#818) still takes a NodeJS.ProcessEnv, and the runner hands its snapshot on whole as
   * one; agentEnv and agentAuthEnv (#819) take an EnvSource and read it through get().
   */
  asProcessEnv(): NodeJS.ProcessEnv {
    return this.#vars;
  }
}

/** A snapshot of `source` (process.env by default): the one way a security read sees the environment (#786). */
export const ownEnv = (source: EnvSource = process.env, platform: NodeJS.Platform = process.platform): OwnEnv => OwnEnv.of(source, platform);
