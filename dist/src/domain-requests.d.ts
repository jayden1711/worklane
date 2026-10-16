export interface RefusedRequest {
    host: string;
    tool: string;
    /** The URL or command that was refused (clipped). */
    what: string;
}
/**
 * Follows a run's stream-json lines and collects the hosts it was refused, each once per run. `allow` is the
 * lane's allowlist: a host on it was not refused for the network (another failure), so it is never reported.
 */
export declare class RefusalTracker {
    private allow;
    private calls;
    private seen;
    readonly refused: RefusedRequest[];
    constructor(allow: string[]);
    line(j: unknown): void;
    private add;
}
/** The hosts one tool call was refused, from its input and what it returned. */
export declare function refusedIn(tool: string, input: Record<string, unknown>, result: string): RefusedRequest[];
/** One word each: a decision is answered by a `/<cli> <option>` comment. */
export declare const DOMAIN_OPTIONS: readonly ["allow-repo", "allow-once", "deny"];
export type DomainAnswer = (typeof DOMAIN_OPTIONS)[number];
/** The owner's decision for a refused host: what was refused, by which run, and what each answer does. */
export declare function domainDecision(r: RefusedRequest & {
    issue: number;
    role: string;
    run: string;
}, configFile: string): {
    question: string;
    options: ("deny" | "allow-repo" | "allow-once")[];
    recommendation: DomainAnswer;
    receipts: string[];
};
/**
 * guardrails.yaml with `host` added to network.allow, comments and order kept: the change an "allow-repo"
 * answer proposes as a pull request. Null if the host is already allowed.
 */
export declare function withAllowedHost(yamlText: string, host: string): string | null;
/**
 * Hosts allowed once for an issue's next run and not used yet: an "allow-once" answer, until a run of that
 * issue starts after it. Events in log order.
 */
export declare function allowedOnce(events: {
    type: string;
    payload: unknown;
}[], issue: number): string[];
