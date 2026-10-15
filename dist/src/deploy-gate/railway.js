// The host's API for the post-deploy check (post-deploy.ts): Railway's public GraphQL API, with the instance's
// stored token as a Bearer token. Three calls, each checked against the public schema by introspection
// (docs/deploy-gate.md says what is verified and what isn't):
//
//   deployments(input: {projectId, environmentId, serviceId}, first: N) { edges { node { id status createdAt canRollback meta } } }
//   deploymentRollback(id: String!): Boolean!
//   deploymentRedeploy(id: String!): Deployment!
//
// The token is read when a call is made, and is never logged, never in an error, never in an event.
import { redactString } from '../events/redact.js';
export const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';
/** No token is stored: the host's API can't be called. */
export class NoHostToken extends Error {
    constructor() {
        super('no host token is stored');
    }
}
const LIST = 'query($i:DeploymentListInput!,$n:Int){deployments(input:$i,first:$n){edges{node{id status createdAt canRollback meta}}}}';
const ROLLBACK = 'mutation($id:String!){deploymentRollback(id:$id)}';
const REDEPLOY = 'mutation($id:String!){deploymentRedeploy(id:$id){id status}}';
/** The GraphQL bodies the client sends (tests and docs check them against each other). */
export const RAILWAY_QUERIES = { LIST, ROLLBACK, REDEPLOY };
/** INVARIANT: the one Railway client (post-deploy and previews): the token is read per call, never in an error. */
export function railwayClient(token, f = fetch, api = RAILWAY_API, timeoutMs = 20_000) {
    return async (query, variables) => {
        const t = token();
        if (!t)
            throw new NoHostToken();
        let res;
        try {
            res = await f(api, {
                method: 'POST',
                headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify({ query, variables }),
                signal: AbortSignal.timeout(timeoutMs),
            });
        }
        catch (e) {
            // A network error's message never carries the request's headers.
            throw new Error(`the host's API didn't answer: ${redactString(String(e.message)).slice(0, 200)}`);
        }
        const text = await res.text();
        let j = {};
        try {
            j = JSON.parse(text);
        }
        catch {
            j = {};
        }
        if (!res.ok || j.errors?.length || !j.data) {
            const why = j.errors?.map((e) => e.message ?? '').join('; ') || text.slice(0, 200);
            throw new Error(`the host's API answered ${res.status}: ${redactString(why.replaceAll(t, '[redacted]')).slice(0, 300)}`);
        }
        return j.data;
    };
}
/** Railway's API over `f`, for one project's environment. `token` is read on every call. */
export function railwayHost(ids, token, f = fetch, api = RAILWAY_API, timeoutMs = 20_000) {
    const call = railwayClient(token, f, api, timeoutMs);
    return {
        deployments: async (service, first) => {
            const d = await call(LIST, {
                i: { projectId: ids.project, environmentId: ids.environment, serviceId: service },
                n: first,
            });
            return d.deployments.edges
                .map(({ node: n }) => {
                const meta = n.meta && typeof n.meta === 'object' ? n.meta : {};
                const commit = typeof meta.commitHash === 'string' && /^[0-9a-f]{7,40}$/.test(meta.commitHash) ? meta.commitHash : null;
                return { id: String(n.id), status: String(n.status), createdAt: String(n.createdAt), commit, canRollback: n.canRollback === true };
            })
                .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
        },
        rollback: async (id) => (await call(ROLLBACK, { id })).deploymentRollback === true,
        redeploy: async (id) => String((await call(REDEPLOY, { id })).deploymentRedeploy.id),
    };
}
/**
 * GitHub's deployments of `sha` by the host's GitHub App (the cross-check): how many there are in a production
 * environment, and how many of those last said success. Null when GitHub couldn't be asked.
 */
export function githubDeployments(repo, token, environment, f = fetch, api = 'https://api.github.com', bot = 'railway-app[bot]') {
    return async (sha) => {
        try {
            const headers = { authorization: `Bearer ${await token()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
            const res = await f(`${api}/repos/${repo}/deployments?sha=${sha}&per_page=50`, { headers, signal: AbortSignal.timeout(20_000) });
            if (!res.ok)
                return null;
            const list = (await res.json());
            const mine = list.filter((d) => d.creator?.login === bot && (d.environment ?? '').toLowerCase().includes(environment.toLowerCase()));
            let success = 0;
            for (const d of mine) {
                const s = await f(`${api}/repos/${repo}/deployments/${d.id}/statuses?per_page=1`, { headers, signal: AbortSignal.timeout(20_000) });
                if (s.ok && (await s.json())[0]?.state === 'success')
                    success++;
            }
            return { total: mine.length, success };
        }
        catch {
            return null;
        }
    };
}
//# sourceMappingURL=railway.js.map