export declare const RAILWAY_API = "https://backboard.railway.com/graphql/v2";
/** A host deployment, as the post-deploy check uses it. */
export interface HostDeployment {
    id: string;
    /** The host's status: SUCCESS, BUILDING, DEPLOYING, FAILED, CRASHED, REMOVED, ... */
    status: string;
    createdAt: string;
    /** The commit it was built from (meta.commitHash), or null. */
    commit: string | null;
    canRollback: boolean;
}
/** What the post-deploy check needs of the host. */
export interface DeployHost {
    /** A service's production deployments, newest first. */
    deployments(service: string, first: number): Promise<HostDeployment[]>;
    /** Roll the service back to this deployment; whether the host said it did. */
    rollback(id: string): Promise<boolean>;
    /** Redeploy this deployment; the new deployment's id. */
    redeploy(id: string): Promise<string>;
}
/** No token is stored: the host's API can't be called. */
export declare class NoHostToken extends Error {
    constructor();
}
/** The GraphQL bodies the client sends (tests and docs check them against each other). */
export declare const RAILWAY_QUERIES: {
    readonly LIST: "query($i:DeploymentListInput!,$n:Int){deployments(input:$i,first:$n){edges{node{id status createdAt canRollback meta}}}}";
    readonly ROLLBACK: "mutation($id:String!){deploymentRollback(id:$id)}";
    readonly REDEPLOY: "mutation($id:String!){deploymentRedeploy(id:$id){id status}}";
};
export type RailwayCall = <T>(query: string, variables: Record<string, unknown>) => Promise<T>;
/** INVARIANT: the one Railway client (post-deploy and previews): the token is read per call, never in an error. */
export declare function railwayClient(token: () => string | null, f?: typeof fetch, api?: string, timeoutMs?: number): RailwayCall;
/** Railway's API over `f`, for one project's environment. `token` is read on every call. */
export declare function railwayHost(ids: {
    project: string;
    environment: string;
}, token: () => string | null, f?: typeof fetch, api?: string, timeoutMs?: number): DeployHost;
/**
 * GitHub's deployments of `sha` by the host's GitHub App (the cross-check): how many there are in a production
 * environment, and how many of those last said success. Null when GitHub couldn't be asked.
 */
export declare function githubDeployments(repo: string, token: () => Promise<string>, environment: string, f?: typeof fetch, api?: string, bot?: string): (sha: string) => Promise<{
    total: number;
    success: number;
} | null>;
