/** The broker's user and its two socket groups, for instance `name` (scripts/setup/mcp-broker.sh makes them). */
export declare const brokerUser: (name: string) => string;
export declare const clientGroup: (name: string) => string;
export declare const controlGroup: (name: string) => string;
/** A secret file: 0400, the broker user's own, in its own 0700 directory per server. */
export declare function readSecretFile(home: string, id: string, name: string): string | null;
export declare function runBroker(instance: string): Promise<number>;
