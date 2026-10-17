/** The shell binary: an explicit path from the environment, else the engine's own release build. */
export declare function desktopBinary(env?: NodeJS.ProcessEnv, engineDir?: string): string | null;
/** Open the dashboard in the desktop window; resolves when the window closes. */
export declare function runDesktop(bin: string, url: string, title: string): Promise<number>;
