// A shifted clock for one optional CI job (#687): with TEST_CLOCK_SHIFT=+45d, a process that loads this runs as if
// it were 45 days later. The weekly clock-shift workflow (.github/workflows/clock-shift.yml) loads it through
// NODE_OPTIONS, so every Node process of the run has it, the test files' and the ones they start alike, at the same
// shift. Nothing else loads it: test/isolate.ts and the required test shards never do.
//
// What moves: every read of "now" (Date.now(), `new Date()`, `Date()`), and the file times fs reports and takes
// (stat, lstat, fstat and utimes, lutimes, futimes: sync, callback and promise forms). WHY the file times too: the
// engine compares the clock with a file's mtime (the intake's raw-report retention, src/intake/store.ts). With only
// Date moved, a file written a second ago looked 45 days old; on a real machine 45 days later, its mtime would be
// that late too. What doesn't move: timers and performance.now() (intervals, not dates), and any process that
// isn't Node (git, a shell, a browser).
import { createRequire, syncBuiltinESMExports } from 'node:module';

const UNIT_MS: Readonly<Record<string, number>> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** TEST_CLOCK_SHIFT (`+45d`, `-2h`, `+1500ms`) in milliseconds; empty is 0; anything else throws. */
export function parseClockShift(value: string | undefined): number {
  const v = (value ?? '').trim();
  if (v === '') return 0;
  const m = /^([+-])(\d+)(ms|s|m|h|d)$/.exec(v);
  if (!m) throw new Error(`TEST_CLOCK_SHIFT=${value}: expected a shift like +45d, -2h or +1500ms`);
  return (m[1] === '-' ? -1 : 1) * Number(m[2]) * UNIT_MS[m[3]!]!;
}

type AnyFn = (...a: unknown[]) => unknown;
const RealDate = Date;

/** A Stats (or BigIntStats) moved by `ms`: its Date getters (mtime, …) derive from the *Ms and *Ns fields. */
function shiftStats<T>(s: T, ms: number): T {
  if (s === null || typeof s !== 'object') return s;
  const o = s as Record<string, unknown>;
  for (const k of ['atime', 'mtime', 'ctime', 'birthtime']) {
    const v = o[`${k}Ms`];
    if (typeof v === 'number') o[`${k}Ms`] = v + ms;
    if (typeof v === 'bigint') o[`${k}Ms`] = v + BigInt(ms);
    const ns = o[`${k}Ns`];
    if (typeof ns === 'bigint') o[`${k}Ns`] = ns + BigInt(ms) * 1_000_000n;
  }
  return s;
}

/** A time given to utimes on the shifted clock, as the real time to store (seconds, as fs takes a number). */
function unshift(t: unknown, ms: number): unknown {
  if (t instanceof RealDate) return (t.getTime() - ms) / 1000;
  const sec = typeof t === 'number' ? t : Number(t);
  return Number.isFinite(sec) ? sec - ms / 1000 : t;
}

function shiftFileTimes(ms: number): void {
  const fs = createRequire(import.meta.url)('node:fs') as Record<string, AnyFn> & { promises: Record<string, AnyFn> };
  const wrap = (obj: Record<string, AnyFn>, name: string, make: (orig: AnyFn) => AnyFn) => {
    if (typeof obj[name] === 'function') obj[name] = make(obj[name]);
  };
  for (const n of ['statSync', 'lstatSync', 'fstatSync']) wrap(fs, n, (f) => (...a) => shiftStats(f(...a), ms));
  for (const n of ['stat', 'lstat', 'fstat']) {
    wrap(fs, n, (f) => (...a) => {
      const cb = a.at(-1);
      if (typeof cb === 'function') a[a.length - 1] = (err: unknown, s: unknown) => (cb as AnyFn)(err, err ? s : shiftStats(s, ms));
      return f(...a);
    });
  }
  for (const n of ['stat', 'lstat']) wrap(fs.promises, n, (f) => async (...a) => shiftStats(await (f(...a) as Promise<unknown>), ms));
  const times = (a: unknown[]) => [a[0], unshift(a[1], ms), unshift(a[2], ms), ...a.slice(3)];
  for (const n of ['utimesSync', 'lutimesSync', 'futimesSync', 'utimes', 'lutimes', 'futimes']) wrap(fs, n, (f) => (...a) => f(...times(a)));
  for (const n of ['utimes', 'lutimes']) wrap(fs.promises, n, (f) => (...a) => f(...times(a)));
  // `import { statSync } from 'node:fs'` reads node's ESM view of the module: bring it in step.
  syncBuiltinESMExports();
}

/** Move this process's clock by `ms`. Date stays Date (instanceof, Date.parse, Date.UTC): only "now" changes. */
function installClockShift(ms: number): void {
  const now = () => RealDate.now() + ms;
  globalThis.Date = new Proxy(RealDate, {
    construct: (target, args, newTarget) => Reflect.construct(target, args.length === 0 ? [now()] : args, newTarget),
    apply: () => new RealDate(now()).toString(),
    get: (target, key, receiver) => (key === 'now' ? now : Reflect.get(target, key, receiver)),
  });
  shiftFileTimes(ms);
}

const shift = parseClockShift(process.env.TEST_CLOCK_SHIFT);
if (shift !== 0) installClockShift(shift);
