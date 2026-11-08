# Feature flags

A risky change to the engine ships behind a flag. It stays off in every project until that project turns it on, so a
new behaviour can be tried on one repo before it reaches the rest. Code: `src/flags.ts` (the schema half in `src/config/schema.ts`). Tests:
`test/feature-flags.test.ts`.

## The rules

- **Off by default, always.** A flag is on only where the repo's `config.yaml` says `true` for it. Absent, `false`, or
  any other value is off.
- **Per repo.** Flags live in the repo's own `.worklane/config.yaml`, which the coordinator reads from the default
  branch (`src/config/live.ts`). So a flag changes only through a commit that was reviewed and merged there, like any
  other config change.
- **Only flags the engine knows.** The engine lists its flags in `FLAGS` (`src/flags.ts`). A name it doesn't know makes
  the config invalid: the coordinator keeps running on the last good config and raises `config_invalid`, naming the
  flag and the ones it knows. A typo never turns something on, and never quietly does nothing.
- **Every flip is audited.** On each tick the coordinator compares each flag's state with the last one recorded in the
  event log. Each difference is one `flag.flipped` event: the flag, from, to, and the commit of the config it read.
  A flip made while the coordinator was down is recorded at its first tick. A flag the engine stopped knowing that
  was on is recorded off. The events are covered by the audit chain ([audit-log.md](audit-log.md)), and the config's
  git history shows who made the change.

## Turn one on

In the repo's `.worklane/config.yaml`, through a PR:

```yaml
flags:
  some_flag: true
```

Once it's merged, the next tick applies it and records `flag.flipped` (`from: false, to: true`). To turn it off, set
`false` or remove the line.

## Add one (engine developers)

1. Add an entry to `FLAGS` in `src/flags.ts`, with what turning it on changes and the PR that adds it.
2. Guard the new behaviour with `flagOn(cfg.project.flags, '<name>')`, keeping the old behaviour when it's off.
3. Test both states. Off must behave exactly as before.
4. Once the change is the default everywhere, remove the flag and its old path, and say so in the changelog. A repo
   that still names the removed flag gets `config_invalid` until it deletes the line, and the log records the flag
   off.

The engine knows no flags yet. The first one comes with the first risky change that needs one. The canary rollout
([testing-in-production.md](testing-in-production.md), item f) stages any registered flag ring by ring.

## What flags can never do

- **They can't turn on a change for a repo that didn't ask for it.** Only that repo's own default-branch config does.
- **They can't loosen a guard or a check by themselves.** A flag only chooses between two paths the engine already
  has, and both are reviewed like any other code.
- **They can't change without a record.** A flip is a reviewed commit plus a `flag.flipped` event. The only flip without
  a commit is a flag the engine stopped knowing, and that's always recorded as off.
- **They can't be set from the dashboard, the CLI, an issue or an agent's run.** Only the repo's config sets them, and
  agents can't change harness config by themselves (guardrails, docs/design.md §12.5).
