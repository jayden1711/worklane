import { type RunHost } from './host.js';
export declare const MEASURE_USAGE: string;
export interface MeasureArgs {
    sha: string | null;
    tiers: string[];
    sets: string[];
    json: boolean;
}
/** The command's arguments, strictly: anything unknown, or a flag without its value, is a usage error (null). */
export declare function parseMeasureArgs(args: readonly string[]): MeasureArgs | null;
export interface MeasureIo {
    out?: (l: string) => void;
    err?: (l: string) => void;
    /** Tests only (the CLI passes none): a host that records its calls, to prove a refusal makes none. */
    host?: (instance: string) => RunHost;
}
export declare function measureCommand(instance: string | undefined, sub: string | undefined, rest: readonly string[], io?: MeasureIo): Promise<number>;
