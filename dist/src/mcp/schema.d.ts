/** The keywords anywhere in `schema` that the broker does not enforce. */
export declare function unenforced(schema: unknown, at?: string): string[];
/** Why `value` doesn't fit `schema` (the subset above), or null. */
export declare function schemaProblem(schema: unknown, value: unknown, at?: string): string | null;
/**
 * Why a tool call's arguments don't fit its approved input schema, or null. Beyond the schema itself, arguments must be
 * an object, and a property the approved schema doesn't name is refused even when the schema leaves additional
 * properties open: a field nobody approved is how a poisoned description smuggles data out.
 */
export declare function argumentsProblem(inputSchema: unknown, args: unknown): string | null;
