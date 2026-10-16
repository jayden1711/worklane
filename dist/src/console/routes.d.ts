import type { IncomingMessage, ServerResponse } from 'node:http';
import { type SecretRule } from './secrets.js';
import type { SessionOf } from './session.js';
export interface AskRouteContext {
    eventsDb: string;
    /** This dashboard's instance (or project) name, for the session's role. */
    instance: string;
    session: SessionOf;
    /** The coordinator user's home, where secrets go (secretsDir); the process's own when unset. */
    secretsHome?: string;
    /** The machine owners file (src/machine-owners.ts); the system's when unset. */
    machineOwnersFile?: string;
    /** Per credential name: its value's shape, and what follows its install (src/console/secrets.ts SecretRule). */
    secretRules?: Record<string, SecretRule>;
}
/** Handle a setup-console route; false when the path isn't one. */
export declare function handleAskRoute(req: IncomingMessage, res: ServerResponse, url: URL, ctx: AskRouteContext): Promise<boolean>;
