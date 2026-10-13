# The canary

The canary proves the engine still works end to end, on a scratch repo of its own. Each day, and after every engine
update, the updater files a tiny issue there: "add one line to `CANARY.md`". The issue has to go through everything a
real one does (issue, plan, PR, green checks, merged) within a time limit.

- **After an update**, the install isn't final until the canary passes. If the canary fails, or runs out of time, the
  updater rolls back the same way it does when services don't come up. It stops the services, restores every
  instance's migration backups, switches back to the previous engine and restarts the services. Then it holds the
  commit (no retry until a newer commit, or until updates are turned off and on again) and raises a watchdog incident.
- **The daily canary** checks the engine as it is now. If it fails, it raises the incident and rolls nothing back.
- No other update starts while a canary runs.

Every canary is recorded in `/var/lib/worklane/updates.jsonl` as `canary_filed`, then `canary_passed` or
`canary_failed` (the stage it reached, why, its PR, how long it took). The Machine page's **Updates** panel shows the
last result, with a link to its PR.

## What the canary never touches

The canary's merges only ever land in its scratch repo. Each of these makes that sure on its own:

- The canary is its own instance with its own GitHub App. The manifest flow (`app-manifest`, and the dashboard's Add
  project) refuses an installation that reaches any repo other than the one it was made for, and the instance's
  tokens are minted for that one repo.
- The machine config names the canary's repo as well as its instance. The `canary` command refuses to file or read
  anything when the instance's repo isn't exactly that repo, or when another instance on this machine runs on it.
- A canary PR counts only when its URL is in the canary repo.
- The only issues the canary instance takes without a writer are open `ready` + `canary` issues that its own App
  opened, and only on the instance the machine config names as the canary. Every other instance keeps the usual rule:
  a writer opened it, or a writer added `ready`.

## Set it up

1. **Make the scratch repo** on GitHub, for example `<your-org>/<name>-canary`. Make it private if you like. Give it:
   - the engine's config, like any project (`worklane install` scaffolds `.worklane/`; commit it). In
     `.worklane/config.yaml`, list yourself as the owner and as a writer.
   - a CI workflow with at least one check that runs on pull requests (a one-line `true` job is enough). The canary
     passes only when every check on its merged PR is green, and fails when there are none.
   - branch protection on `main` that requires that check, not strict (or let the main watch guard it: see
     [dashboard.md](dashboard.md)).
2. **Add it as a project.** In the dashboard, open **Setup console → Add project** and enter a name (say `canary`)
   and the repo ([dashboard.md](dashboard.md#add-project)). The run creates the instance, and makes its GitHub App
   through the manifest flow: approve the App, then install it on **only** the scratch repo. Leave
   `commit_identity` unset in its `instance.yaml`: the canary recognises its own App by that bot identity.
3. **Let it merge on its own.** In the canary instance's `policy.yaml`, set `auto_merge: true`. The canary's change is
   a one-line docs change (L0), which the default merge rules merge once its checks are green. Nothing on the
   canary should wait for you.
4. **Name it in the machine config.** As root, add a `canary` block to `/etc/worklane/updates.json` (keep the rest):

   ```json
   "canary": { "instance": "canary", "repo": "<your-org>/<name>-canary", "time_limit_minutes": 120 }
   ```

   `time_limit_minutes` is optional (120 by default). Give it enough time for a plan, a build, CI and the merge on
   a quiet machine.
5. **Check it.** On its next run (every 10 minutes, while updates are on), the updater files the first daily canary.
   The Updates panel shows it running, then its result. You can also follow it in the canary instance's own
   dashboard.

## When it fails

The Updates panel and the log say how far the canary got and why. The stages are: filed, taken, planned, PR, checks,
merged. Common causes:

- **"not taken: …"**: the instance didn't pick it up. Check that the instance is running, that `canary.instance` names
  it, and that its App opened the issue.
- **"the plan was held for the owner"**: the canary repo's `review.yaml` treats the change as high-risk. A
  `CANARY.md` line should never be.
- **"merged with no checks on its head"**: the scratch repo has no CI. Add a check (step 1).
- **"timed out after N minutes at …"**: raise `time_limit_minutes`, or find out what held it at that stage.

After an update's canary fails, the commit stays held until a newer commit arrives, or until you turn updates off
and on again from the Machine page. When a later canary passes, the watchdog incident is resolved.
