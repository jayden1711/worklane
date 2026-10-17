/** The example project the demo seeds from: shipped in the package (`files` in package.json), beside dist/. */
export declare const EXAMPLE_DIR: string;
export declare function seedDemo(dir: string): Promise<{
    root: string;
    eventsDb: string;
    issues: number;
}>;
