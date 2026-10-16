/** The run's ticket: set by the runner for this one run, never a credential to any server. */
export declare const TICKET_VAR: string;
export declare const BROKER_SOCKET = "broker.sock";
export declare const CONTROL_SOCKET = "control.sock";
/** The command line claude starts for one approved server: the engine's own cli.js, by absolute path. */
export declare const connectorArgv: (node: string, engineCli: string, instance: string, server: string) => string[];
export declare function runConnector(instance: string, server: string, env?: NodeJS.ProcessEnv): Promise<number>;
