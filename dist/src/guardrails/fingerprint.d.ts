export declare function fingerprint(connection: string): string | null;
/** Connection strings appearing literally in text. */
export declare function findConnections(text: string): string[];
/** Connection strings a command reaches: literal ones plus $VAR / ${VAR} references resolved from env. */
export declare function connectionsIn(command: string, env: Record<string, string | undefined>): string[];
