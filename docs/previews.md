# PR previews

With previews on, each open PR gets its own Railway environment. The environment is forked from a template environment and deployed at the PR's head. The app's browser flows run against its URL, and the URL and screenshots are posted on the PR. The environment is deleted when the PR is merged or closed.

The code is in `src/preview/`. It reuses the deploy gate's Railway client and its token (docs/deploy-gate.md, "The host token").

## How it works

At most once a minute, the coordinator compares GitHub's open PRs with the project's environments.

1. **Delete.** It deletes every preview environment, and that PR's screenshots, when one of these is true:
   - its PR is no longer open (merged or closed);
   - it is older than `ttl_hours`, even while the PR is open (an upper bound on a leak). It is not made again until the PR's head moves.
   - it was left over from a preview that failed.

   A preview environment is one named `pr-preview-<number>`. Nothing else is ever deleted, and the template never is, whatever its name.
2. **Create.** An open PR whose head has no preview yet gets one, while fewer than `max_concurrent` exist:
   1. An environment `pr-preview-<number>` is forked from `template_environment` (`ephemeral`, no initial deploys).
   2. Each of `services` is deployed in it at the PR's head commit.
   3. The coordinator waits until every deployment is `SUCCESS`. If one fails, or they aren't all done within `timeout_s`, the environment is deleted and the PR comment says why. It is tried again when the head moves.
   4. The URL is `https://<domain>` of `url_service`'s deployment. If it has none, a Railway domain is generated.
   5. Each flow in app.yaml (or the ones in `flows`) runs against that URL. The browser may reach that origin only; every other request is refused and recorded.
   6. One comment on the PR (edited in place on later heads) gives the URL, the head, each flow's result and its screenshot.

   A PR past the cap waits, said once in the log (`preview.waiting`), and gets its preview when one is deleted. A new head redeploys the PR's existing environment. A PR from a fork never gets a preview, because the fork's code would run with the template's variables.

**Screenshots.** GitHub has no API for a comment's own attachments. So each screenshot is uploaded as an asset of one draft release, tagged `pr-previews`. A draft release creates no tag and no commit, so nothing is committed to git. The comment links the images, which collaborators can open. A PR's assets are deleted with its preview, and on each new head.

Events: `preview.created`, `preview.ready`, `preview.failed`, `preview.removed`, `preview.waiting` and `preview.error`.

## Configuration: tests.yaml `preview:`

It is off by default. Without `preview`, or with it but without `enabled: true`, nothing is created, deployed, checked, posted or deleted. A present block is still validated.

```yaml
preview:
  enabled: false                 # the owner switches it on in a reviewed PR
  project: <PROJECT_ID>
  template_environment: <TEMPLATE_ENV_ID>
  services:
    - { name: web, id: <WEB_SERVICE_ID> }
    - { name: worker, id: <WORKER_SERVICE_ID> }
  url_service: web
  # flows: [home, checkout]      # default: every app.yaml flow
  max_concurrent: 2              # default 2
  timeout_s: 1200                # default 1200: the deploy wait
  ttl_hours: 72                  # default 72
```

With `enabled: true`, `project`, `template_environment`, `services` and `url_service` are required, and `url_service` must be one of `services`. Every name in `flows` must be an app.yaml flow (checked at coordinator start).

## What the owner does

1. **The token.** Previews use the deploy gate's host token, `railway-token` in the instance's secrets. With previews on and no token stored, the setup console asks for it ("The host's API token, for PR previews"); see docs/deploy-gate.md, "The host token". Use an account or workspace token that can create and delete environments, deploy services and create domains in the project. A project token is scoped to one environment, so it can't fork new environments.
2. **The template environment.** Create an environment in the project for previews to fork, with each service connected to the repo, and the variables a preview should have. Use no production secrets or production databases. Its id is `template_environment`.
3. **The App.** It needs **Contents: read & write** for the draft release and its assets, and **Issues** or **Pull requests: read & write** for the comment.
4. **Switch it on** with the block above and `enabled: true`, in its own reviewed PR.

## What is verified

The Railway calls (`src/preview/railway.ts`) have only been run against a fake server. They have not been checked against Railway's live schema or a real project. Before switching previews on, confirm these with your token:
- `environments(projectId)`;
- `environmentCreate(input: {projectId, name, sourceEnvironmentId, ephemeral, skipInitialDeploys})`;
- `environmentDelete(id)`;
- `serviceInstanceDeployV2(serviceId, environmentId, commitSha)`;
- `deployment(id) { status staticUrl }`;
- `serviceDomainCreate(input: {environmentId, serviceId})`.
