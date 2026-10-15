import { z } from 'zod';
/** The incident a deploy branch moved outside the gate raises (src/watchdog/incidents.ts KINDS). */
export declare const DEPLOY_GATE_INCIDENT = "deploy_gate_diverged";
/** The check the gate posts on each default-branch commit it ran. */
export declare const DEPLOY_GATE_CHECK = "deploy-gate";
/** The incident a post-deploy check that failed in production raises (src/watchdog/incidents.ts KINDS). */
export declare const POST_DEPLOY_INCIDENT = "deploy_post_check_failed";
/** The incident a deploy the host didn't finish in time raises. */
export declare const POST_DEPLOY_WAIT_INCIDENT = "deploy_post_check_no_deploy";
/** The credential the host's API token is stored under (the instance's secrets, console/secrets.ts). */
export declare const HOST_TOKEN_CREDENTIAL = "railway-token";
/** Why `raw` isn't a production origin (scheme://host[:port], nothing else), or null. */
export declare function originProblem(raw: string): string | null;
/** One smoke check: a plain GET, no credentials, whose status (and, if set, body text) must match. */
export declare const PostDeployCheck: z.ZodObject<{
    name: z.ZodString;
    kind: z.ZodEnum<{
        health: "health";
        sign_in: "sign_in";
        api: "api";
    }>;
    url: z.ZodString;
    method: z.ZodDefault<z.ZodLiteral<"GET">>;
    expect_status: z.ZodNumber;
    expect_text: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type PostDeployCheck = z.infer<typeof PostDeployCheck>;
/**
 * deploy_gate.post_deploy: once the host deployed the deploy branch's new commit, smoke-test production, and roll the
 * host back to the previous good deployment when a check fails. Absent: off.
 */
export declare const PostDeployConfig: z.ZodObject<{
    host: z.ZodLiteral<"railway">;
    project: z.ZodString;
    environment: z.ZodString;
    services: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>>;
    origin: z.ZodString;
    checks: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        kind: z.ZodEnum<{
            health: "health";
            sign_in: "sign_in";
            api: "api";
        }>;
        url: z.ZodString;
        method: z.ZodDefault<z.ZodLiteral<"GET">>;
        expect_status: z.ZodNumber;
        expect_text: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    wait_for_deploy_s: z.ZodDefault<z.ZodNumber>;
    timeout_s: z.ZodDefault<z.ZodNumber>;
    github_environment: z.ZodDefault<z.ZodString>;
}, z.core.$strict>;
export type PostDeployConfig = z.infer<typeof PostDeployConfig>;
export declare const DeployGateConfig: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    branch: z.ZodDefault<z.ZodString>;
    tiers: z.ZodArray<z.ZodString>;
    notify: z.ZodDefault<z.ZodEnum<{
        off: "off";
        ops: "ops";
    }>>;
    post_deploy: z.ZodOptional<z.ZodObject<{
        host: z.ZodLiteral<"railway">;
        project: z.ZodString;
        environment: z.ZodString;
        services: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>>;
        origin: z.ZodString;
        checks: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            kind: z.ZodEnum<{
                health: "health";
                sign_in: "sign_in";
                api: "api";
            }>;
            url: z.ZodString;
            method: z.ZodDefault<z.ZodLiteral<"GET">>;
            expect_status: z.ZodNumber;
            expect_text: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        wait_for_deploy_s: z.ZodDefault<z.ZodNumber>;
        timeout_s: z.ZodDefault<z.ZodNumber>;
        github_environment: z.ZodDefault<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type DeployGateConfig = z.infer<typeof DeployGateConfig>;
/** Why the gate does nothing while `enabled` isn't true (the override's refusal, the gate's own refusals). */
export declare const DEPLOY_GATE_OFF = "the deploy gate is off (tests.yaml deploy_gate.enabled is not true); the owner turns it on in a reviewed PR";
/** What the deploy gate needs of tests.yaml: test_run, and every tier it names in it. Each problem, with its path. */
export declare function deployGateProblems(gate: DeployGateConfig | undefined, testRunTiers: string[] | null): {
    path: (string | number)[];
    message: string;
}[];
