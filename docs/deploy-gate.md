# Pre-deploy gate

Some hosts deploy every commit on the default branch to production as soon as it lands. Railway's GitHub integration works that way. If the repo's main commits carry no CI of their own, a merge that broke the build goes straight to production.

With the gate on, production deploys from a separate branch (`deploy`), and only the coordinator moves it. It moves `deploy` forward only to default-branch commits whose gate tiers all passed on that exact commit. Staging can stay on `main` and keep deploying every merge.

The code is in `src/deploy-gate/`. Its Discord side (the ops posts and the owner's override) is in `src/coordinator/deploy-commands.ts`.

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

It is off by default: without `deploy_gate`, nothing runs and nothing moves.

```yaml
test_run:
  tiers:
    - { name: chain, command: "npm run chain", kind: fast }
    - { name: suite, command: "npm test", kind: full, database: true }
  # ...
deploy_gate:
  branch: deploy           # default: deploy. Never the default branch.
  tiers: [chain, suite]    # the full post-merge set: test_run tiers of either kind, all run unsharded on the commit
  notify: ops              # ops (default): post to discord.ops_channel when deploy moves and when it is held; off: dashboard only
```

The schema refuses:
- `deploy_gate` without `test_run`;
- a tier that isn't one of `test_run`'s;
- a tier named twice;
- a branch name git wouldn't take.

The coordinator also refuses a gate on the default branch. The gate needs the test runs to be set up: a sandbox whose check passes (docs/test-runs.md). Without them, it records why (`coordinator.error`, where `deploy gate`) and moves nothing.

## Where to see it

- **Dashboard, Machine page:** the commit `deploy` is at, when and by whom it moved there, the last held commit and why, and a refusal in force.
- **Events:**
  - `deploy_gate.verdict`
  - `deploy_gate.moved` (with `by` and `override`)
  - `deploy_gate.held`
  - `deploy_gate.refused`
  - `deploy_gate.override`
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

2. **Create `deploy` first.** Turn the gate on and wait for its first green commit (the gate creates `deploy` there), or create it yourself at the commit production runs now. Then switch each production trigger to it:

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

## Limits (GitHub Free)

On a private repo on GitHub Free, there are no rulesets or branch protection. Nothing stops a person with write access from pushing to `deploy`, and the host then deploys whatever they pushed.

The gate detects the push on its next pass (within about 90 s) and raises an incident in the ops channel. If the push left `deploy` off the default branch's line, the gate also refuses to move `deploy`. It can't prevent the push or undo a deploy that already happened.

With a plan that has rulesets, restrict who may push to `deploy` to the App.
