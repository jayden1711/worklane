// tests.yaml `deploy_gate:` (docs/deploy-gate.md): a branch the project's host deploys production from, which the
// coordinator fast-forwards only to default-branch commits whose configured test-run tiers all passed on that exact
// commit. Absent (the default), or present without `enabled: true`: no gate, nothing runs, nothing moves; a present
// block is still fully validated, so a mistake shows before the owner switches it on.
import { z } from 'zod';
/** The incident a deploy branch moved outside the gate raises (src/watchdog/incidents.ts KINDS). */
export const DEPLOY_GATE_INCIDENT = 'deploy_gate_diverged';
/** The check the gate posts on each default-branch commit it ran. */
export const DEPLOY_GATE_CHECK = 'deploy-gate';
const tierName = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/, 'a test_run tier name');
/** A plain branch name: no `..`, no `.lock` end, no leading `-` or `/`, nothing git refuses in a ref. */
const branchName = z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/, 'a branch name (letters, digits, . _ / -)')
    .refine((b) => !b.includes('..') && !b.endsWith('.lock') && !b.endsWith('/') && !b.includes('//'), 'a branch name git accepts');
/** The incident a post-deploy check that failed in production raises (src/watchdog/incidents.ts KINDS). */
export const POST_DEPLOY_INCIDENT = 'deploy_post_check_failed';
/** The incident a deploy the host didn't finish in time raises. */
export const POST_DEPLOY_WAIT_INCIDENT = 'deploy_post_check_no_deploy';
/** The credential the host's API token is stored under (the instance's secrets, console/secrets.ts). */
export const HOST_TOKEN_CREDENTIAL = 'railway-token';
const railwayId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'a Railway id (a UUID)');
const shortName = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/, 'a short name (lowercase letters, digits, _ or -)');
/** http only on this machine (a local stand-in for production); anywhere else, https. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Why `raw` isn't a production origin (scheme://host[:port], nothing else), or null. */
export function originProblem(raw) {
    let u;
    try {
        u = new URL(raw);
    }
    catch {
        return 'not a URL';
    }
    if (u.username || u.password)
        return 'no credentials in the URL';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname)))
        return 'https only (http only on localhost)';
    if (u.pathname !== '/' || u.search || u.hash || raw.replace(/\/$/, '') !== u.origin)
        return 'an origin only: scheme://host[:port], no path, query or fragment';
    return null;
}
/** One smoke check: a plain GET, no credentials, whose status (and, if set, body text) must match. */
export const PostDeployCheck = z.strictObject({
    name: shortName,
    /** What it covers: the checks must cover each kind at least once. */
    kind: z.enum(['health', 'sign_in', 'api']),
    /** An absolute URL on `origin`. */
    url: z.string().max(2000),
    /** GET only: a smoke check never changes anything. */
    method: z.literal('GET').default('GET'),
    expect_status: z.number().int().min(100).max(599),
    /** Text the body must contain. */
    expect_text: z.string().min(1).max(200).optional(),
});
/**
 * deploy_gate.post_deploy: once the host deployed the deploy branch's new commit, smoke-test production, and roll the
 * host back to the previous good deployment when a check fails. Absent: off.
 */
export const PostDeployConfig = z
    .strictObject({
    host: z.literal('railway'),
    /** The host's ids: the project, its production environment, and each production service deployed from the branch. */
    project: railwayId,
    environment: railwayId,
    services: z
        .array(z.strictObject({ name: shortName, id: railwayId }))
        .min(1)
        .max(20)
        .refine((s) => new Set(s.map((x) => x.id)).size === s.length && new Set(s.map((x) => x.name)).size === s.length, 'each service once'),
    /** Production's origin (https://app.example.com): every check's URL must be on it, and nothing else is ever requested. */
    origin: z.string().max(300),
    checks: z.array(PostDeployCheck).min(3).max(20),
    /** How long the host may take to deploy the commit (every service SUCCESS on it) before it is reported as not deployed. */
    wait_for_deploy_s: z.number().int().min(60).max(7200).default(1200),
    /** Each check's request timeout (one retry each). */
    timeout_s: z.number().int().min(1).max(30).default(10),
    /** GitHub deployments of the commit (the cross-check) count when their environment contains this. */
    github_environment: z.string().min(1).max(100).default('production'),
})
    .superRefine((p, ctx) => {
    const bad = originProblem(p.origin);
    if (bad)
        ctx.addIssue({ code: 'custom', path: ['origin'], message: bad });
    const origin = bad ? null : new URL(p.origin).origin;
    p.checks.forEach((c, i) => {
        let u = null;
        try {
            u = new URL(c.url);
        }
        catch {
            u = null;
        }
        if (!u)
            ctx.addIssue({ code: 'custom', path: ['checks', i, 'url'], message: 'not an absolute URL' });
        else if (u.username || u.password)
            ctx.addIssue({ code: 'custom', path: ['checks', i, 'url'], message: 'no credentials in a check URL' });
        else if (origin && u.origin !== origin)
            ctx.addIssue({ code: 'custom', path: ['checks', i, 'url'], message: `not on the production origin ${origin}` });
    });
    if (new Set(p.checks.map((c) => c.name)).size !== p.checks.length)
        ctx.addIssue({ code: 'custom', path: ['checks'], message: 'each check name once' });
    for (const k of ['health', 'sign_in', 'api']) {
        if (!p.checks.some((c) => c.kind === k))
            ctx.addIssue({ code: 'custom', path: ['checks'], message: `needs a ${k} check (health, the sign-in page and one read-only API call)` });
    }
});
export const DeployGateConfig = z.strictObject({
    /**
     * The off switch, off by default: until the owner sets `enabled: true` in a reviewed PR, nothing runs on the default
     * branch for the gate, the deploy branch never moves, no post-deploy check runs, and a chat `deploy <sha>` is refused.
     */
    enabled: z.boolean().default(false),
    /** The branch the host's production services deploy from. Never the default branch (checked at start). */
    branch: branchName.default('deploy'),
    /** test_run tiers (fast or full) that must all pass on a default-branch commit before the branch moves to it. */
    tiers: z
        .array(tierName)
        .min(1)
        .refine((t) => new Set(t).size === t.length, 'each tier once'),
    /** ops: post to the Discord ops channel when the branch moves and when it is held; off: the dashboard only. */
    notify: z.enum(['ops', 'off']).default('ops'),
    /** The post-deploy check (docs/deploy-gate.md); absent: off. */
    post_deploy: PostDeployConfig.optional(),
});
/** Why the gate does nothing while `enabled` isn't true (the override's refusal, the gate's own refusals). */
export const DEPLOY_GATE_OFF = 'the deploy gate is off (tests.yaml deploy_gate.enabled is not true); the owner turns it on in a reviewed PR';
/** What the deploy gate needs of tests.yaml: test_run, and every tier it names in it. Each problem, with its path. */
export function deployGateProblems(gate, testRunTiers) {
    if (!gate)
        return [];
    if (testRunTiers === null)
        return [{ path: ['deploy_gate'], message: 'needs test_run: the gate runs its tiers' }];
    return gate.tiers.flatMap((t, i) => (testRunTiers.includes(t) ? [] : [{ path: ['deploy_gate', 'tiers', i], message: `no test_run tier named ${t}` }]));
}
//# sourceMappingURL=config.js.map