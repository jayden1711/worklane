# Pre-deploy gate

Some hosts deploy every commit on the default branch to production as soon as it lands. Railway's GitHub integration works that way. If the repo's main commits carry no CI of their own, a merge that broke the build goes straight to production.

With the gate on, production deploys from a separate branch (`deploy`), and only the coordinator moves it. It moves `deploy` forward only to default-branch commits whose gate tiers all passed on that exact commit. Staging can stay on `main` and keep deploying every merge.

The code is in `src/deploy-gate/`. After each move, an optional [post-deploy check](#post-deploy-check) smoke-tests production and rolls the host back when it fails. Its Discord side (the ops posts and the owner's override) is in `src/coordinator/deploy-commands.ts`.

## How it works

1. **A new tip of the default branch.** At most every 90 s, the coordinator fetches `main` and `deploy` (git, no API call). When `main` has a new tip, it runs the gate's tiers on that exact commit. This is a post-merge run through the same test-run service and sandbox as PRs (docs/test-runs.md), with the files changed since `deploy`.
   - The run's tier checks are posted on the commit, plus one `deploy-gate` check that passes only when every gate tier passed.
   - Commits merged while a run is going are skipped: the next run is on the newest tip.
2. **Every gate tier green on that commit.** The coordinator fast-forwards `deploy` to it through the instance's App with a plain ref update: `PATCH /repos/<repo>/git/refs/heads/deploy {"sha": "<sha>", "force": false}`.
   - It does so only if the commit descends from where `deploy` is now.
   - There is no code path that forces it. GitHub also refuses a non-fast-forward with `force: false`.
   - If `deploy` doesn't exist yet, it is created at the first green commit (`POST /git/refs`, which can't overwrite).
3. **A tier red, or the run couldn't go ahead.** `deploy` stays where it is. The commit is recorded as held, with the reason. Fixing `main` is left to the normal flow (a fix PR). The next green tip moves `deploy` on.
4. **`deploy` not where the gate put it.** Someone pushed to it.
   - The gate raises a watchdog incident ("The deploy branch moved outside the gate"), which is posted to the ops channel.
   - If the commit is off the default branch's line, the gate refuses to move `deploy` at all until a person puts it back.
   - If the commit is on the line, the gate moves on from there at the next green tip, and the incident resolves.

The App needs **Contents: read & write** (for the ref update) and **Checks: read & write** (for the checks).

## Configuration: tests.yaml `deploy_gate:`

It is off by default, and has an explicit switch, `enabled`, which defaults to `false`. Without `deploy_gate`, or with it but without `enabled: true`, the whole gate is off:
- no test run on the default branch for the gate;
- `deploy` never moves;
- no post-deploy check, and no ask for the host token;
- a Discord `deploy <sha>` is refused, saying the gate is off.

A present block is still fully validated while it is off (every rule below, the post-deploy check's included), so a mistake shows before it is switched on. The dashboard's Pre-deploy gate panel says "Configured, off", with what turning it on would do.

**Turning it on is the owner's step:** `enabled: true`, in its own reviewed PR, after a green suite has posted. An agent adds the block switched off and leaves the switch to the owner.

```yaml
test_run:
  tiers:
    - { name: chain, command: "npm run chain", kind: fast }
    - { name: suite, command: "npm test", kind: full, database: true }
  # ...
deploy_gate:
  enabled: false           # default: false (off). The owner sets true in a reviewed PR.
  branch: deploy           # default: deploy. Never the default branch.
  tiers: [chain, suite]    # the full post-merge set: test_run tiers of either kind, all run unsharded on the commit
  notify: ops              # ops (default): post to discord.ops_channel when deploy moves and when it is held; off: dashboard only
```

The schema refuses:
- `deploy_gate` without `test_run`;
- a tier that isn't one of `test_run`'s;
- a tier named twice;
- a branch name git wouldn't take.

The coordinator also refuses a gate on the default branch. The gate needs the test runs to be set up (docs/test-runs.md). Without them, it records why (`coordinator.error`, where `deploy gate`) and moves nothing. While the sandbox's check is failing the gate does nothing, and goes on when the check passes.

## Where to see it

- **Dashboard, Machine page:** while it is off, "Configured, off" and what turning it on would do. While it is on: the commit `deploy` is at, when and by whom it moved there, the last held commit and why, and a refusal in force.
- **Events:**
  - `deploy_gate.verdict`
  - `deploy_gate.moved` (with `by` and `override`)
  - `deploy_gate.held`
  - `deploy_gate.refused`
  - `deploy_gate.override`
  - `deploy_gate.post_deploy` (the post-deploy check, below)
- **Discord ops channel** (`notify: ops`, with intake.yaml `discord.ops_channel`): one post per move and per hold. The incident gets its own post through the watchdog.

## An owner's override: `deploy <sha>`

Sometimes production needs a commit the gate held, such as a hotfix while one tier is flaky. In that case, an owner types `deploy <sha>` in a channel the bot reads (an ideas or chat channel).

- **Who.** Only an owner listed in intake.yaml `discord.owners` whose GitHub login is an admin of the repo now. This is the same rule as high-risk approvals. Anyone else is refused, and the refusal is recorded.
- **What.** The sha must be on the default branch's first-parent line. Anything else is refused.
- **Confirm first.** The bot opens a thread that names the commit and the gate's state for it (green, red, running, not checked). Nothing moves until the same owner replies exactly `confirm` there. `cancel` drops it, and any other reply is asked back.
- **Then:**
  - the same fast-forward-only move as the gate's: never forced, and only if the commit descends from where `deploy` is;
  - a post to ops ("Deploy override by @owner ... (override while red)");
  - an audit entry (`dashboard.audit`, action `deploy_gate.override`, via `discord`) with who, the sha and the gate's state at the time.

## One-time setup

### On the host (Railway)

Point each **production** service's GitHub source at `deploy`. Staging services stay on `main`. Railway sets a service's branch per environment. Its public GraphQL API (`https://backboard.railway.com/graphql/v2`) holds it on the service's deployment trigger for that environment.

Use an account or workspace token as `Authorization: Bearer $RAILWAY_TOKEN`. A project token uses the `Project-Access-Token` header instead, and whether it may run these mutations is not verified. Keep the token in your shell only, and never put it in a file.

1. **Read each production service's trigger, and its branch now:**

   ```sh
   curl -s https://backboard.railway.com/graphql/v2 \
     -H "Authorization: Bearer $RAILWAY_TOKEN" -H 'Content-Type: application/json' \
     -d '{"query":"query($p:String!,$e:String!,$s:String!){deploymentTriggers(projectId:$p,environmentId:$e,serviceId:$s){edges{node{id branch repository checkSuites}}}}","variables":{"p":"<PROJECT_ID>","e":"<PRODUCTION_ENV_ID>","s":"<SERVICE_ID>"}}'
   ```

2. **Create `deploy` first.** Turn the gate on (the owner's reviewed PR setting `deploy_gate.enabled: true`) and wait for its first green commit (the gate creates `deploy` there), or create it yourself at the commit production runs now. Then switch each production trigger to it:

   ```sh
   curl -s https://backboard.railway.com/graphql/v2 \
     -H "Authorization: Bearer $RAILWAY_TOKEN" -H 'Content-Type: application/json' \
     -d '{"query":"mutation($id:String!,$b:String!){deploymentTriggerUpdate(id:$id,input:{branch:$b}){id branch repository}}","variables":{"id":"<TRIGGER_ID>","b":"deploy"}}'
   ```

   The CLI can do the same through an environment config patch: `railway environment edit -p <PROJECT_ID> -e <PRODUCTION_ENV> --service-config <SERVICE> source.branch deploy -m "production deploys from deploy"`.

3. **Check that staging still says `main`:** run query 1 with the staging environment's id.

Where this was checked: the mutation, the query and their fields are in Railway's public GraphQL schema, read by introspection. The CLI command is from the Railway CLI's source (`railway environment edit --service-config`). Neither has been run against a real project here, so read back the branch with query 1 after the change.

`serviceInstanceUpdate` can't set a branch: its `source` input has only `image` and `repo`.

### On GitHub

- Once the `deploy-gate` check shows on main commits, you can require it wherever the plan allows.
- Give the App **Contents: read & write** (the ref update) and **Checks: read & write** (the checks), and accept them on the installation.

## How to verify

0. While `enabled` isn't `true`: the Machine page says "Configured, off", no `full` run of the gate tiers starts after a merge, `deploy` doesn't move, and `deploy <sha>` in Discord is answered "Not deployed: the deploy gate is off". Then the owner merges the PR setting `enabled: true`.
1. Merge a PR to `main`.
2. Within about 90 s, the gate's run starts. The test runs on the Machine page show a `full` run of the gate tiers on the merge commit.
3. When it ends, the merge commit has its tier checks and a `deploy-gate` check: `gh api repos/<repo>/commits/<sha>/check-runs --jq '.check_runs[] | [.name, .conclusion] | @tsv'`.
4. Green: `deploy` is at the merge commit (`git ls-remote origin refs/heads/deploy`). The Machine page shows it, and the ops channel has the post.
5. The host deployed that commit. Ask for the latest deployment of each production service:

   ```sh
   curl -s https://backboard.railway.com/graphql/v2 \
     -H "Authorization: Bearer $RAILWAY_TOKEN" -H 'Content-Type: application/json' \
     -d '{"query":"query($i:DeploymentListInput!){deployments(input:$i,first:1){edges{node{id status createdAt meta}}}}","variables":{"i":{"projectId":"<PROJECT_ID>","environmentId":"<PRODUCTION_ENV_ID>","serviceId":"<SERVICE_ID>"}}}'
   ```

   `meta.commitHash` should be the merge commit. `meta` is untyped JSON in the schema; the Railway CLI reads `commitHash` from it. GitHub's deployments show the same: `gh api repos/<repo>/deployments --jq '.[] | [.sha, .environment, .created_at] | @tsv' | head`.
6. A red merge: `deploy` stays put, the Machine page shows the held commit and why, and ops has a "Deploy held" post.

## Post-deploy check

The gate decides what `deploy` may move to. The post-deploy check looks at what production does once the host has deployed it. After each move of `deploy` (by the gate or an override), the coordinator:

1. **Waits for the host's deploy of exactly that commit.** It asks the host about every 30 s until each configured production service's latest deployment has `meta.commitHash` equal to the commit and status `SUCCESS`.
   - GitHub's deployments of the commit by `railway-app[bot]` in an environment containing `github_environment` are the cross-check, recorded with the result. Without a host token, they are the only signal.
   - A service's deployment of the commit that ends `FAILED`, `CRASHED`, `SKIPPED` or `REMOVED`: "the deploy failed". Nothing is smoke-tested or rolled back.
   - Not deployed within `wait_for_deploy_s`: "not deployed", an amber incident, an ops post. Nothing is smoke-tested or rolled back.
2. **Smoke-tests production.** Each check is one `GET` to its URL with a `timeout_s` timeout and one retry. It never sends a cookie, a token or any credential, never follows a redirect, and never requests anything off `origin`. A check passes when the status is `expect_status` and, if set, the body contains `expect_text`.
3. **Every check passed:** nothing else happens. The result is recorded, and an earlier post-deploy incident resolves.
4. **A check failed:**
   - **Rollback.** Each configured service is rolled back to its newest deployment of the previous `deploy` commit that served production (status `SUCCESS`, `REMOVED` or `SLEEPING`). If the commit `deploy` moved from had itself failed this check, the target is the last commit that passed. The coordinator uses the host's `deploymentRollback` when the deployment offers it (`canRollback`), and otherwise `deploymentRedeploy` of that deployment.
   - **Nothing moves on git.** `deploy` stays where it is, and the commit is marked as failed in production: the gate never moves `deploy` to it again, and an owner's `deploy <sha>` is refused for it. Fix forward on the default branch; the next green commit moves `deploy` on, and the host deploys that.
   - **A red incident** ("Production failed its post-deploy check").
   - **An ops post** with each failing check, its status, a short snippet of its body, and what was rolled back per service. The snippet is redacted: secret-shaped strings, cookie, session and token values are removed. No response header is ever kept.
   - **No host token stored:** the same, except nothing is rolled back. The post says the rollback needs the token.
   - **A follow-up issue** in the project's tracker, labelled `post-deploy`. It links the commit, lists each failed check (its name, kind, error and status) and the rollback's result per service. It is **never** labelled `ready`, so nothing builds it on its own: to have it built, give it a `done_when` contract and label it `ready`.
     - The issue never carries the response's body: the repo may be public, and the redactor can't know every secret's shape. The snippet stays in the ops post. The host's and the request's error text sits in Markdown code spans, so no link, image, URL, `#n` reference or mention in it renders.
     - One issue per commit and failing check, ever. The same check failing again on the same commit files nothing more; a different check failing on it files one issue for that check. The coordinator records each issue in its state before filing it, and marks the issue's body once per check (`<!-- post-deploy:<sha>:<check> -->`), so a restart between the two finds the open issue instead of filing a second one; a check no open issue carries is filed.
     - The issue is filed beside the check, not inside it: a slow or refusing tracker never delays the next commit's check or rollback. If the tracker refuses it (GitHub down, say), the rollback, the incident and the ops post still happen; the error is logged and it is tried again after 1 minute, doubling up to 30 minutes.
     - "Not deployed" and "the deploy failed" file no issue: no check ran. Their incident and ops post say what happened.

Post-deploy failures are posted to `discord.ops_channel` even with `notify: off`. A pass is never posted.

### Configuration

It is off by default. Add `post_deploy` to `deploy_gate`:

```yaml
deploy_gate:
  branch: deploy
  tiers: [chain, suite]
  post_deploy:
    host: railway
    project: <PROJECT_ID>
    environment: <PRODUCTION_ENV_ID>
    services:                      # every production service deployed from `deploy`
      - { name: web, id: <SERVICE_ID> }
      - { name: worker, id: <SERVICE_ID> }
    origin: https://app.example.com
    checks:                        # must cover health, the sign-in page and one read-only API call
      - { name: health, kind: health, url: "https://app.example.com/api/health", expect_status: 200 }
      - { name: sign-in, kind: sign_in, url: "https://app.example.com/sign-in", expect_status: 200, expect_text: "Sign in" }
      - { name: status, kind: api, url: "https://app.example.com/api/status", expect_status: 200 }
    wait_for_deploy_s: 1200        # default 1200 (60 to 7200)
    timeout_s: 10                  # each request; default 10 (1 to 30)
    github_environment: production # default
```

The schema refuses:
- a check URL that isn't on `origin` (same scheme, host and port), or that carries credentials;
- an `origin` with a path, a query or credentials, or one on `http` other than `localhost`;
- a `method` other than `GET`;
- a set of checks without a `health`, a `sign_in` and an `api` check, or a check name used twice;
- ids that aren't Railway ids.

The results are `deploy_gate.post_deploy` events: `passed`, `failed`, `timed_out` or `deploy_failed`, with each check, the rollback and the GitHub cross-check. A `failed` one also files its follow-up issue (above).

Without `post_deploy`, nothing runs after a move: nothing is watched, smoke-tested, rolled back or filed.

### The host token

Rolling back needs a Railway account or workspace token. It is stored like the instance's other secrets: a file only the coordinator user can read (0400), in the instance's secrets directory, under the name `railway-token`. It is read when a call is made, and is never logged, never in an event, never on Discord.

To store it:
1. With `post_deploy` on and no token stored, the coordinator raises a setup step: "The host's API token, for the post-deploy rollback". Discord says only that a setup step needs you, with no detail.
2. Open it from the dashboard's **Setup console**, or reply `link` in its Discord thread for a one-time link by DM (docs/intake.md, 2.1.5).
3. Paste the token in its password box. Only the owner can, and it is not shown again.

The next check uses it; no restart is needed. To replace it, delete the file and restart the coordinator: it asks again.

### Commands for the owner

Use these with the same token, kept in your shell only (`Authorization: Bearer $RAILWAY_TOKEN`).

List a production service's latest deployments, with their commit and whether they can be rolled back to:

```sh
curl -s https://backboard.railway.com/graphql/v2 \
  -H "Authorization: Bearer $RAILWAY_TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"query($i:DeploymentListInput!){deployments(input:$i,first:5){edges{node{id status createdAt canRollback meta}}}}","variables":{"i":{"projectId":"<PROJECT_ID>","environmentId":"<PRODUCTION_ENV_ID>","serviceId":"<SERVICE_ID>"}}}'
```

Roll a service back to one of them by hand (the id from the list):

```sh
curl -s https://backboard.railway.com/graphql/v2 \
  -H "Authorization: Bearer $RAILWAY_TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"mutation($id:String!){deploymentRollback(id:$id)}","variables":{"id":"<DEPLOYMENT_ID>"}}'
```

If that deployment has `canRollback: false`, redeploy it instead:

```sh
curl -s https://backboard.railway.com/graphql/v2 \
  -H "Authorization: Bearer $RAILWAY_TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"mutation($id:String!){deploymentRedeploy(id:$id){id status}}","variables":{"id":"<DEPLOYMENT_ID>"}}'
```

### What is verified

These were read from Railway's public GraphQL schema by unauthenticated introspection:
- `deployments(input: DeploymentListInput!, first: Int)` with `projectId`, `environmentId` and `serviceId`;
- `Deployment.id`, `status`, `createdAt`, `canRollback` and `meta` (the scalar `DeploymentMeta`, untyped JSON);
- the `DeploymentStatus` values;
- `deploymentRollback(id: String!): Boolean!` ("Rolls back to a deployment");
- `deploymentRedeploy(id: String!, usePreviousImageTag: Boolean): Deployment!`.

These have not been run against a real project, so they are unverified:
- that `meta.commitHash` holds the commit (the Railway CLI reads it there);
- that the list comes newest first (the coordinator sorts by `createdAt` anyway);
- that a replaced deployment shows as `REMOVED` and can still be rolled back to;
- that an account or workspace token may run the two mutations;
- the environment name Railway gives its GitHub deployments (hence `github_environment`).

Before relying on it, run the list command for each production service, and check that `meta.commitHash` is there and the previous deployment says `canRollback: true`.

## Limits (GitHub Free)

On a private repo on GitHub Free, there are no rulesets or branch protection. Nothing stops a person with write access from pushing to `deploy`, and the host then deploys whatever they pushed.

The gate detects the push on its next pass (within about 90 s) and raises an incident in the ops channel. If the push left `deploy` off the default branch's line, the gate also refuses to move `deploy`. It can't prevent the push or undo a deploy that already happened.

With a plan that has rulesets, restrict who may push to `deploy` to the App.
