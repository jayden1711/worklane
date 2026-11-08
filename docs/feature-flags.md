# Feature flags

A risky change to the engine ships behind a flag. It stays off in every project until that project turns it on, so a
new behaviour can be tried on one repo before it reaches the rest. Code: `src/config/schema.ts` (`FLAGS`, `RETIRED_FLAGS` and the schema) and `src/flags.ts` (`flagOn`, `adoptFlags` and the audit). Tests:
`test/feature-flags.test.ts`.

## The rules

- **Off by default, always.** A flag is on only where the repo's `config.yaml` says `true` for it. Absent, `false`, or
  any other value is off.
- **Per repo, from the default branch only.** Flags live in the repo's own `.worklane/config.yaml`. A flag changes
  only through a commit that was reviewed and merged on the default branch, like any other config change.
- **One reader, one writer.** No config object carries flags: every parsed `flags:` is a frozen `{}`, whichever
  loader read it (the coordinator, the tool guard, the CLI, the dashboard, a branch). The one reader is
  `flagOn('<name>')`. It reads only a snapshot of the flags the default branch's committed config turns on, at one
  commit: the commit whose config the coordinator is running.
  - The coordinator's config step is the only writer (a test holds that nothing else calls `adoptFlags`).
  - It reads `config.yaml` at that commit from git and checks `flags:` in plain code, not through the zod schema.
  - A started-on-the-checkout coordinator (main's config invalid or missing) has no such commit, so **every flag is
    off**. A branch, a hand edit, a written-to config object or a polluted prototype never turns one on.
  - Started on main's config, its commit counts at once. A config main later applies, confirms or recovers to moves
    the commit; an invalid one keeps the last good commit, as it keeps the last good config.
- **Only flags the engine knows.** The engine lists its flags in `FLAGS` (`src/config/schema.ts`).
  - **A name it doesn't know makes the config invalid.** The coordinator keeps running on the last good config and
    raises `config_invalid`, naming the flag and the ones it knows. A typo never turns something on, and never quietly
    does nothing.
  - **A retired name is the exception** (`RETIRED_FLAGS`): it's accepted with any value and always read as off. So a
    repo that still names a flag the engine retired keeps working, at start too.
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

1. Add an entry to `FLAGS` in `src/config/schema.ts`, with what turning it on changes and the PR that adds it. That file
   is in the agents' tool guard's import tree, so the change is L3 and waits for the owner.
2. Guard the new behaviour with `flagOn('<name>')`, keeping the old behaviour when it's off. Only the coordinator's
   process has flags on: elsewhere (the tool guard, the CLI, the dashboard) `flagOn` is always off, so a flag guards
   only the coordinator's own behaviour.
3. Test both states. Off must behave exactly as before.
4. Once the change is the default everywhere, **retire** the flag:
   - move its name from `FLAGS` to `RETIRED_FLAGS` (never just delete it);
   - remove the old path;
   - say so in the changelog.

   A repo that still names it keeps working, with the flag off, and the log records it off at the first tick. A name
   never leaves `RETIRED_FLAGS`. Deleting it would make every config that still names it invalid, and at start
   (`loadConfig`, with no last good config to fall back on) the engine wouldn't run.

The engine knows no flags yet. The first one comes with the first risky change that needs one. The canary rollout
([testing-in-production.md](testing-in-production.md), item f) stages any registered flag ring by ring.

## What flags can never do

- **They can't turn on a change for a repo that didn't ask for it.** Only that repo's own default-branch config does.
- **They can't loosen a guard or a check by themselves.** A flag only chooses between two paths the engine already
  has, and both are reviewed like any other code.
- **They can't be read from anything but the default branch's committed config.** Not from a checkout, a branch, a
  config object or the schema; the freeze on `FILES` and `ProjectConfig.shape` is shallow (zod's own objects can be
  changed), so the flags don't rely on it.
- **They can't change without a record.** A flip is a reviewed commit plus a `flag.flipped` event. The only flip without
  a commit is a flag the engine stopped knowing, and that's always recorded as off.
- **They can't be set from the dashboard, the CLI, an issue or an agent's run.** Only the repo's config sets them, and
  agents can't change harness config by themselves (guardrails, docs/design.md §12.5).
