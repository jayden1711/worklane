export declare const PLUGIN_STEPS: readonly ["plugin-fetch", "plugin-stage", "plugin-withdraw", "plugin-remove", "mcp-fetch", "mcp-preview", "mcp-snapshot", "mcp-stage"];
/** Whether these are exactly one plugin step's arguments (the command first), in the helper's shapes. */
export declare function pluginStepOk(a: readonly string[]): boolean;
