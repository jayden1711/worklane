export declare const PLUGIN_HOSTS_FILE: () => string;
export declare const DEFAULT_PLUGIN_HOSTS: readonly ["github.com"];
/** A DNS name as the allowlist holds it: lowercase labels, at least one dot, no IP literal. */
export declare const HOST_NAME: RegExp;
/**
 * The hosts plugins may come from. No file: github.com alone. A file anyone but root owns, that others may write, or
 * that doesn't hold {"hosts": [<name>, ...]}: no host at all (fails closed), with why.
 */
export declare function readPluginHosts(file?: string, ownerUid?: number): {
    hosts: string[];
    problem: string | null;
};
/** Why `url` may not be fetched from, given the allowed hosts; null when it may. */
export declare function pluginUrlProblem(url: string, hosts: readonly string[]): string | null;
/** Whether an address is public: not loopback, private, link-local, CGNAT, ULA, multicast, reserved or unspecified. */
export declare function isPublicAddress(ip: string): boolean;
/**
 * Resolve `host` once, refuse it unless every address it gives is public, and return the address git is pinned to.
 * `resolve` is a test seam (the system resolver otherwise).
 */
export declare function pinnedAddress(host: string, resolve?: (h: string) => Promise<{
    address: string;
    family: number;
}[]>): Promise<string>;
/** git's pin for one host on https: http.curloptResolve's "host:443:address" (an IPv6 address in brackets). */
export declare const curlResolve: (host: string, ip: string) => string;
export declare const MCP_REGISTRIES_FILE: () => string;
export declare const DEFAULT_MCP_REGISTRIES: readonly ["registry.npmjs.org"];
/**
 * The npm registries pinned MCP servers may come from (owner's condition on mcp-fetch): root's file
 * (/etc/<cli>/mcp-registries.json, root:root 0644, set by plugins.sh registries); absent, registry.npmjs.org alone.
 * A file that isn't root's alone or doesn't hold {"registries": [<host name>, ...]}: none at all.
 */
export declare function readMcpRegistries(file?: string, ownerUid?: number): {
    registries: string[];
    problem: string | null;
};
/** Why a lockfile's packages may not be installed: any `resolved` URL not on https://<registry>/. Null when all are. */
export declare function lockResolvedProblem(lockText: string, registry: string): string | null;
