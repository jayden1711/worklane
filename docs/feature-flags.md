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
  commit: the default branch's head, as the remote last said it was, when its config was valid.
  - The coordinator's config step is the only writer. Nothing it is passed picks the source: it asks `origin` for
    its own default branch (its `HEAD`) and that branch's head, by its exact ref (`ls-remote`, never a local ref an
    agent could move), and adopts that commit's flags only when the commit is here (fetched) and its config is valid,
    by the schema and by the instance's own check (a required argument). Otherwise, **every flag is off**: a read
    that failed (the remote unreachable, the commit not fetched, the config invalid or removed, the read or the check
    throwing) never keeps one on, and isn't cached, so the next tick reads again. A push between the config step's
    fetch and its `ls-remote` gives a head not fetched yet: every flag is off for that tick, recorded, and back on
    at the next. A test holds that nothing else in `src/` names `adoptFlags`, and
    since nothing it takes picks the source, any caller could only adopt what the default branch says now.
  - origin's default branch must be the instance's configured `default_branch`: if origin's `HEAD` points anywhere
    else (an unprotected branch), nothing is adopted and every flag is off.
  - A flag goes on only once its `flag.flipped` is durably written: while any record is held in memory (a full disk),
    or one was dropped, nothing turns on. A flag the default branch turned off goes off at once, before its record
    is written, so a record that can't be written never keeps one on. Such an off is kept in
    `flags-unrecorded.json` beside the event log, written and synced to disk before the off takes effect, and is
    written to the log at the next tick that can, by this process or the next one (a log locked past its busy
    timeout ends the tick and the process): before any later change, once, so a flag the default branch turns on
    again has both records. Each entry keeps the log's position when the flag went off, and leaves the file once the
    log has an off row of that flag stored after it, checked at every tick and at a process's start: so an entry left
    behind (a stop, a flush outside a tick, a rewrite that failed) is dropped, never written again. A save that fails
    (a full disk) is tried again at every tick.
    The coordinator adopts flags even when refreshing its config failed.
  - It reads `flags:` in plain code, not through the zod schema.
  - A coordinator started on the checkout's config (main's invalid or missing) adopts nothing until main's config is
    valid: **every flag is off**. A branch, a hand edit, a written-to config object or a polluted prototype never
    turns one on.
  - The snapshot is the process's own: one coordinator process, one repo. A process serving several would need one
    per repo.
- **Only flags the engine knows.** The engine lists its flags in `FLAGS` (`src/config/schema.ts`).
  - **A name it doesn't know makes the config invalid.** The coordinator keeps running on the last good config and
    raises `config_invalid`, naming the flag and the ones it knows. A typo never turns something on, and never quietly
    does nothing.
  - **A retired name is the exception** (`RETIRED_FLAGS`): it's accepted with any value and always read as off. So a
    repo that still names a flag the engine retired keeps working, at start too.
- **Every flip is audited.** On each tick the coordinator compares each flag's state with the last one recorded in the
  event log. Each difference is one `flag.flipped` event: the flag, from, to, and the commit of the config it read.
  A flip made while the coordinator was down is recorded at its first tick. A limit: the coordinator being down is
  itself an off with no record, and so is an off on a disk too full for `flags-unrecorded.json` too, when the
  process stops before the disk has room (its record is then held in memory, or dropped, and lost); the log shows
  the flag on through that time. A flag the engine stopped knowing that
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
- **Limit: the test seam.** `withKnownFlags` (a flag registered for one test) runs only in node's test runner
  (`--test`, or `NODE_TEST_CONTEXT` set). A process whose environment an attacker can set could set
  `NODE_TEST_CONTEXT` and pass it; environment control is outside the threat model.
- **They can't change without a record.** A flip is a reviewed commit plus a `flag.flipped` event. The only flip without
  a commit is a flag the engine stopped knowing, and that's always recorded as off.
- **They can't be set from the dashboard, the CLI, an issue or an agent's run.** Only the repo's config sets them, and
  agents can't change harness config by themselves (guardrails, docs/design.md §12.5).
