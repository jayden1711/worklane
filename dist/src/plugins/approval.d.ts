import { z } from 'zod';
export declare const PLUGIN_ID: RegExp;
export declare const ROLE: RegExp;
export declare const DIGEST: RegExp;
/** At most this many staged approvals per instance, each dropped this long after it was staged. */
export declare const PENDING_MAX_PER_INSTANCE = 4;
export declare const PENDING_TTL_MS: number;
/** At most this many fetches per instance per hour (Q13: an owner may stage, rate-capped). */
export declare const FETCHES_PER_HOUR = 10;
/** At most this many MCP server snapshots or previews per instance per hour (owner's condition on mcp-preview/mcp-snapshot). */
export declare const SNAPSHOTS_PER_HOUR = 10;
export declare const allowlistPath: (instance: string) => string;
export declare const pendingPath: () => string;
export declare const fetchLogPath: () => string;
export declare const previewDir: (instance: string, id: string) => string;
export declare const storeDir: (instance: string, id: string, tree: string) => string;
export declare const emptyPluginRoot: (instance: string) => string;
/** Where the broker keeps an instance's MCP secrets: one 0700 directory per server in the broker user's home. */
export declare const mcpSecretsDir: (brokerHome: string, id: string) => string;
/** A plugin's approval. Every field is part of the digest. */
export declare const PluginRecord: z.ZodObject<{
    v: z.ZodLiteral<1>;
    kind: z.ZodLiteral<"plugin">;
    instance: z.ZodString;
    id: z.ZodString;
    source: z.ZodObject<{
        type: z.ZodLiteral<"git">;
        url: z.ZodString;
        sha: z.ZodString;
        path: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    name: z.ZodNullable<z.ZodString>;
    version: z.ZodNullable<z.ZodString>;
    fetchedTree: z.ZodString;
    tree: z.ZodString;
    transform: z.ZodArray<z.ZodString>;
    components: z.ZodObject<{
        skills: z.ZodArray<z.ZodString>;
        agents: z.ZodArray<z.ZodString>;
        commands: z.ZodArray<z.ZodString>;
        outputStyles: z.ZodArray<z.ZodString>;
        bin: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    mcpServers: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        argv: z.ZodArray<z.ZodString>;
        envNames: z.ZodArray<z.ZodString>;
        from: z.ZodString;
    }, z.core.$strict>>;
    options: z.ZodArray<z.ZodString>;
    flags: z.ZodArray<z.ZodString>;
    roles: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export type PluginRecord = z.infer<typeof PluginRecord>;
/** A host an MCP server may reach (its sandbox's egress allowlist): a DNS name, optionally one *. label first. */
export declare const HOST: RegExp;
/** A secret's name: the environment variable the broker sets for that one server. */
export declare const SECRET_NAME: RegExp;
export declare const SnapshotSchema: z.ZodObject<{
    serverName: z.ZodNullable<z.ZodString>;
    instructions: z.ZodNullable<z.ZodString>;
    tools: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        title: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        inputSchema: z.ZodUnknown;
        outputSchema: z.ZodOptional<z.ZodUnknown>;
        annotations: z.ZodOptional<z.ZodUnknown>;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** How an approved MCP server starts: a server inside an approved plugin, or a pinned npm package. */
export declare const McpRuntime: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"plugin">;
    plugin: z.ZodString;
    tree: z.ZodString;
    server: z.ZodString;
    argv: z.ZodArray<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"npm">;
    package: z.ZodString;
    version: z.ZodString;
    integrity: z.ZodString;
    lockfile: z.ZodString;
    tree: z.ZodString;
    argv: z.ZodArray<z.ZodString>;
}, z.core.$strict>], "type">;
export type McpRuntime = z.infer<typeof McpRuntime>;
/**
 * An MCP server's approval: how it starts, what it may reach, and what it shows the model. The broker runs it (never
 * Claude Code), with its secrets in its own environment only, and serves the approved snapshot, never the live list.
 * snapshot null: approved code whose tools couldn't be listed without its secrets (Q3); it serves nothing until a
 * second approval adds the snapshot taken with them.
 */
export declare const McpRecord: z.ZodObject<{
    v: z.ZodLiteral<1>;
    kind: z.ZodLiteral<"mcp">;
    instance: z.ZodString;
    id: z.ZodString;
    runtime: z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"plugin">;
        plugin: z.ZodString;
        tree: z.ZodString;
        server: z.ZodString;
        argv: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"npm">;
        package: z.ZodString;
        version: z.ZodString;
        integrity: z.ZodString;
        lockfile: z.ZodString;
        tree: z.ZodString;
        argv: z.ZodArray<z.ZodString>;
    }, z.core.$strict>], "type">;
    secrets: z.ZodArray<z.ZodString>;
    network: z.ZodArray<z.ZodString>;
    snapshot: z.ZodNullable<z.ZodObject<{
        serverName: z.ZodNullable<z.ZodString>;
        instructions: z.ZodNullable<z.ZodString>;
        tools: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            title: z.ZodOptional<z.ZodString>;
            description: z.ZodOptional<z.ZodString>;
            inputSchema: z.ZodUnknown;
            outputSchema: z.ZodOptional<z.ZodUnknown>;
            annotations: z.ZodOptional<z.ZodUnknown>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    snapshotHash: z.ZodNullable<z.ZodString>;
    snapshotWithSecrets: z.ZodBoolean;
    flags: z.ZodArray<z.ZodString>;
    roles: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export type McpRecord = z.infer<typeof McpRecord>;
/** What one approval covers. Every field is part of the digest. */
export declare const ApprovalRecord: z.ZodDiscriminatedUnion<[z.ZodObject<{
    v: z.ZodLiteral<1>;
    kind: z.ZodLiteral<"plugin">;
    instance: z.ZodString;
    id: z.ZodString;
    source: z.ZodObject<{
        type: z.ZodLiteral<"git">;
        url: z.ZodString;
        sha: z.ZodString;
        path: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    name: z.ZodNullable<z.ZodString>;
    version: z.ZodNullable<z.ZodString>;
    fetchedTree: z.ZodString;
    tree: z.ZodString;
    transform: z.ZodArray<z.ZodString>;
    components: z.ZodObject<{
        skills: z.ZodArray<z.ZodString>;
        agents: z.ZodArray<z.ZodString>;
        commands: z.ZodArray<z.ZodString>;
        outputStyles: z.ZodArray<z.ZodString>;
        bin: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    mcpServers: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        argv: z.ZodArray<z.ZodString>;
        envNames: z.ZodArray<z.ZodString>;
        from: z.ZodString;
    }, z.core.$strict>>;
    options: z.ZodArray<z.ZodString>;
    flags: z.ZodArray<z.ZodString>;
    roles: z.ZodArray<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    v: z.ZodLiteral<1>;
    kind: z.ZodLiteral<"mcp">;
    instance: z.ZodString;
    id: z.ZodString;
    runtime: z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"plugin">;
        plugin: z.ZodString;
        tree: z.ZodString;
        server: z.ZodString;
        argv: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"npm">;
        package: z.ZodString;
        version: z.ZodString;
        integrity: z.ZodString;
        lockfile: z.ZodString;
        tree: z.ZodString;
        argv: z.ZodArray<z.ZodString>;
    }, z.core.$strict>], "type">;
    secrets: z.ZodArray<z.ZodString>;
    network: z.ZodArray<z.ZodString>;
    snapshot: z.ZodNullable<z.ZodObject<{
        serverName: z.ZodNullable<z.ZodString>;
        instructions: z.ZodNullable<z.ZodString>;
        tools: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            title: z.ZodOptional<z.ZodString>;
            description: z.ZodOptional<z.ZodString>;
            inputSchema: z.ZodUnknown;
            outputSchema: z.ZodOptional<z.ZodUnknown>;
            annotations: z.ZodOptional<z.ZodUnknown>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    snapshotHash: z.ZodNullable<z.ZodString>;
    snapshotWithSecrets: z.ZodBoolean;
    flags: z.ZodArray<z.ZodString>;
    roles: z.ZodArray<z.ZodString>;
}, z.core.$strict>], "kind">;
export type ApprovalRecord = z.infer<typeof ApprovalRecord>;
export declare const AllowlistEntry: z.ZodObject<{
    record: z.ZodDiscriminatedUnion<[z.ZodObject<{
        v: z.ZodLiteral<1>;
        kind: z.ZodLiteral<"plugin">;
        instance: z.ZodString;
        id: z.ZodString;
        source: z.ZodObject<{
            type: z.ZodLiteral<"git">;
            url: z.ZodString;
            sha: z.ZodString;
            path: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>;
        name: z.ZodNullable<z.ZodString>;
        version: z.ZodNullable<z.ZodString>;
        fetchedTree: z.ZodString;
        tree: z.ZodString;
        transform: z.ZodArray<z.ZodString>;
        components: z.ZodObject<{
            skills: z.ZodArray<z.ZodString>;
            agents: z.ZodArray<z.ZodString>;
            commands: z.ZodArray<z.ZodString>;
            outputStyles: z.ZodArray<z.ZodString>;
            bin: z.ZodArray<z.ZodString>;
        }, z.core.$strict>;
        mcpServers: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            argv: z.ZodArray<z.ZodString>;
            envNames: z.ZodArray<z.ZodString>;
            from: z.ZodString;
        }, z.core.$strict>>;
        options: z.ZodArray<z.ZodString>;
        flags: z.ZodArray<z.ZodString>;
        roles: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        v: z.ZodLiteral<1>;
        kind: z.ZodLiteral<"mcp">;
        instance: z.ZodString;
        id: z.ZodString;
        runtime: z.ZodDiscriminatedUnion<[z.ZodObject<{
            type: z.ZodLiteral<"plugin">;
            plugin: z.ZodString;
            tree: z.ZodString;
            server: z.ZodString;
            argv: z.ZodArray<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            type: z.ZodLiteral<"npm">;
            package: z.ZodString;
            version: z.ZodString;
            integrity: z.ZodString;
            lockfile: z.ZodString;
            tree: z.ZodString;
            argv: z.ZodArray<z.ZodString>;
        }, z.core.$strict>], "type">;
        secrets: z.ZodArray<z.ZodString>;
        network: z.ZodArray<z.ZodString>;
        snapshot: z.ZodNullable<z.ZodObject<{
            serverName: z.ZodNullable<z.ZodString>;
            instructions: z.ZodNullable<z.ZodString>;
            tools: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                title: z.ZodOptional<z.ZodString>;
                description: z.ZodOptional<z.ZodString>;
                inputSchema: z.ZodUnknown;
                outputSchema: z.ZodOptional<z.ZodUnknown>;
                annotations: z.ZodOptional<z.ZodUnknown>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        snapshotHash: z.ZodNullable<z.ZodString>;
        snapshotWithSecrets: z.ZodBoolean;
        flags: z.ZodArray<z.ZodString>;
        roles: z.ZodArray<z.ZodString>;
    }, z.core.$strict>], "kind">;
    digest: z.ZodString;
    staged_at: z.ZodString;
    staged_by: z.ZodString;
    confirmed_at: z.ZodString;
}, z.core.$strict>;
export type AllowlistEntry = z.infer<typeof AllowlistEntry>;
export declare const Allowlist: z.ZodObject<{
    version: z.ZodLiteral<1>;
    instance: z.ZodString;
    entries: z.ZodArray<z.ZodObject<{
        record: z.ZodDiscriminatedUnion<[z.ZodObject<{
            v: z.ZodLiteral<1>;
            kind: z.ZodLiteral<"plugin">;
            instance: z.ZodString;
            id: z.ZodString;
            source: z.ZodObject<{
                type: z.ZodLiteral<"git">;
                url: z.ZodString;
                sha: z.ZodString;
                path: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>;
            name: z.ZodNullable<z.ZodString>;
            version: z.ZodNullable<z.ZodString>;
            fetchedTree: z.ZodString;
            tree: z.ZodString;
            transform: z.ZodArray<z.ZodString>;
            components: z.ZodObject<{
                skills: z.ZodArray<z.ZodString>;
                agents: z.ZodArray<z.ZodString>;
                commands: z.ZodArray<z.ZodString>;
                outputStyles: z.ZodArray<z.ZodString>;
                bin: z.ZodArray<z.ZodString>;
            }, z.core.$strict>;
            mcpServers: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                argv: z.ZodArray<z.ZodString>;
                envNames: z.ZodArray<z.ZodString>;
                from: z.ZodString;
            }, z.core.$strict>>;
            options: z.ZodArray<z.ZodString>;
            flags: z.ZodArray<z.ZodString>;
            roles: z.ZodArray<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            v: z.ZodLiteral<1>;
            kind: z.ZodLiteral<"mcp">;
            instance: z.ZodString;
            id: z.ZodString;
            runtime: z.ZodDiscriminatedUnion<[z.ZodObject<{
                type: z.ZodLiteral<"plugin">;
                plugin: z.ZodString;
                tree: z.ZodString;
                server: z.ZodString;
                argv: z.ZodArray<z.ZodString>;
            }, z.core.$strict>, z.ZodObject<{
                type: z.ZodLiteral<"npm">;
                package: z.ZodString;
                version: z.ZodString;
                integrity: z.ZodString;
                lockfile: z.ZodString;
                tree: z.ZodString;
                argv: z.ZodArray<z.ZodString>;
            }, z.core.$strict>], "type">;
            secrets: z.ZodArray<z.ZodString>;
            network: z.ZodArray<z.ZodString>;
            snapshot: z.ZodNullable<z.ZodObject<{
                serverName: z.ZodNullable<z.ZodString>;
                instructions: z.ZodNullable<z.ZodString>;
                tools: z.ZodArray<z.ZodObject<{
                    name: z.ZodString;
                    title: z.ZodOptional<z.ZodString>;
                    description: z.ZodOptional<z.ZodString>;
                    inputSchema: z.ZodUnknown;
                    outputSchema: z.ZodOptional<z.ZodUnknown>;
                    annotations: z.ZodOptional<z.ZodUnknown>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            snapshotHash: z.ZodNullable<z.ZodString>;
            snapshotWithSecrets: z.ZodBoolean;
            flags: z.ZodArray<z.ZodString>;
            roles: z.ZodArray<z.ZodString>;
        }, z.core.$strict>], "kind">;
        digest: z.ZodString;
        staged_at: z.ZodString;
        staged_by: z.ZodString;
        confirmed_at: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type Allowlist = z.infer<typeof Allowlist>;
export declare const PendingEntry: z.ZodObject<{
    instance: z.ZodString;
    id: z.ZodString;
    roles: z.ZodArray<z.ZodString>;
    network: z.ZodOptional<z.ZodArray<z.ZodString>>;
    secrets: z.ZodOptional<z.ZodArray<z.ZodString>>;
    digest: z.ZodString;
    staged_at: z.ZodString;
    staged_by: z.ZodString;
}, z.core.$strict>;
export type PendingEntry = z.infer<typeof PendingEntry>;
export declare const Pending: z.ZodObject<{
    version: z.ZodLiteral<1>;
    entries: z.ZodArray<z.ZodObject<{
        instance: z.ZodString;
        id: z.ZodString;
        roles: z.ZodArray<z.ZodString>;
        network: z.ZodOptional<z.ZodArray<z.ZodString>>;
        secrets: z.ZodOptional<z.ZodArray<z.ZodString>>;
        digest: z.ZodString;
        staged_at: z.ZodString;
        staged_by: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** JSON with every object's keys sorted and no whitespace: one text per value. */
export declare function canonicalJson(v: unknown): string;
/** The digest of an approval record: what is reviewed, staged and confirmed. */
export declare function approvalDigest(r: ApprovalRecord): string;
/** Roles from the helper's `role+role` form, sorted and unique; null when any isn't a role name. */
export declare function parseRoles(s: string): string[] | null;
export declare class AllowlistError extends Error {
}
/**
 * An instance's allowlist. No file: no plugins (an empty list). Anything else wrong with it (not root's, writable by
 * its group or others, a symlink, not JSON, not the schema, another instance's) is an error, never "no plugins" and
 * never "whatever it says": a run that would load plugins refuses to start.
 */
export declare function readAllowlist(instance: string, o?: {
    file?: string;
    ownerUid?: number;
}): Allowlist;
/** The pending list with expired entries dropped. A missing or unreadable file is an empty list (it grants nothing). */
export declare function livePending(raw: unknown, now?: number): PendingEntry[];
