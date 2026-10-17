/** Where local init installs tools and the engine (bin/ under it). */
export declare const toolPrefix: (env?: NodeJS.ProcessEnv) => string;
export declare const toolBin: (env?: NodeJS.ProcessEnv) => string;
/** PATH with the prefix's bin at the end, unless it's there already. */
export declare function toolPath(path?: string, env?: NodeJS.ProcessEnv): string;
/** A tool's full path: on PATH, else in the prefix's bin; null when in neither. */
export declare const findTool: (cmd: string, env?: NodeJS.ProcessEnv) => string | null;
/** An environment for running tools by name: `env` with PATH reaching the prefix's bin too. */
export declare const withToolPath: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
