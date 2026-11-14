// The two globals test/isolate.ts sets before any test module runs, neither writable nor configurable (#941): the test
// tables' freeze, and its deep frozen-check. A module calls them by their bare names, so no lookup on the way can be
// redefined (R1184ao AO3). In a process without the preload they don't exist, and a call throws a ReferenceError.
declare function __worklaneTestFreezeTable(v: unknown, where?: string): void;
declare function __worklaneTestDeepFrozen(v: unknown): boolean;
