import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ApprovalRecord } from './approval.js';
type Role = 'owner' | 'writer' | 'viewer';
export interface PluginsWho {
    login: string;
    role: Role | null;
    breakGlass?: boolean;
}
/** One approved entry as a writer may see it: an allowlist of fields, so a field added later stays an owner's. */
export declare const WRITER_FIELDS: readonly ["id", "kind", "label", "roles", "on", "reach"];
export interface WriterEntry {
    id: string;
    kind: 'plugin' | 'mcp';
    label: string;
    roles: string[];
    on: boolean;
    /** What it can reach, in words: skills, agents, commands, bin; hosts, secrets' names, tools. */
    reach: string[];
}
/** What an approved entry can reach, for both roles' views. */
export declare function reachOf(r: ApprovalRecord): string[];
export interface PluginsContext {
    instance: string | null;
    instanceHome: string | null;
    eventsDb: string;
    /** The broker's blocked servers (src/mcp/client.ts brokerStatus); null without a broker. */
    blocked: () => Promise<Record<string, unknown> | null>;
    /** The dashboard's own state (the cached update check). Unset: no update check. */
    stateDir?: string;
    /** Test seams. */
    allowlistOwnerUid?: number;
    fetchJson?: (url: string) => Promise<unknown>;
}
/** The page's data for this role: null for a viewer (who gets a 403). */
export declare function pluginsView(ctx: PluginsContext, role: Role | null): Promise<Record<string, unknown> | null>;
/** The one command a root admin runs to confirm a staged approval (always the installed engine's script). */
export declare const confirmCommand: (instance: string, id: string, digest: string) => string;
type Json = (res: ServerResponse, status: number, body: unknown) => void;
/**
 * The Plugins routes. Returns false for any other path. GET /api/plugins for owners and writers; every POST is the
 * owner's (the dashboard checked CSRF before routing), refused and audited otherwise.
 */
export declare function handlePluginsRoute(req: IncomingMessage, res: ServerResponse, url: URL, ctx: PluginsContext & {
    who: PluginsWho;
    readBody: (req: IncomingMessage) => Promise<unknown>;
    json: Json;
    audit: (action: string, detail: Record<string, unknown>) => void;
}): Promise<boolean>;
export {};
