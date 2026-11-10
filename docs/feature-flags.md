# Feature flags

A risky change to the engine ships behind a flag. It stays off in every project until that project turns it on, so a
new behaviour can be tried on one repo before it reaches the rest. Code: `src/config/schema.ts` (`FLAGS`, `RETIRED_FLAGS` and the schema) and `src/flags.ts` (`FlagState`, `adoptFlags` and the audit). Tests:
`test/feature-flags.test.ts` and `test/feature-flags-af.test.ts`.

## The rules

- **Off by default, always.** A flag is on only where the repo's `config.yaml` says `true` for it. Absent, `false`, or
  any other value is off.
- **Per repo, from the default branch only.** Flags live in the repo's own `.worklane/config.yaml`. A flag changes
  only through a commit that was reviewed and merged on the default branch, like any other config change.
- **One reader, one writer.** No config object carries flags: every parsed `flags:` is a frozen `{}`, whichever
  loader read it (the coordinator, the tool guard, the CLI, the dashboard, a branch). The one reader is a
  coordinator's `flags.on('<name>')`. It reads only that coordinator's snapshot of the flags the default branch's
  committed config turns on, at one commit: the default branch's head, as the remote last said it was, when its config was valid.
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
    behind (a stop, a flush outside a tick, a rewrite that failed) is dropped, never written again. The position is
    the log's last row, by its id and its stamp, so an entry from another log is told apart: a log restored from a
    backup (the updater's rollback restores migration backups), replaced, or a position past every row. Such an
    entry, at a process's start, is written once to this log if it still reads the flag on, else dropped. An entry
    whose position couldn't be read at the turn-off takes it just before its off is written, and the off is written
    only once that position is read and saved: if either fails, that flag alone stays off and its off waits for the
    next tick; the tick's other records take effect. An import that carries a log moves the target's file aside
    while it writes that log, removes it once the log is written, and puts it back if the write fails (a full
    disk), so an import that fails keeps it; one that carries none keeps the target's file, and a bundle's file is
    never taken without its log (a bundle path with a `.` or `..` segment is refused, and so is a case variant of the
    log's or this file's name, or a log's `-wal`, `-shm` or `-journal`). Before it writes a log, the import folds the
    old log's WAL into it (a coordinator that died leaves one) so SQLite never replays it over the new log; a WAL still
    held open by another process (the coordinator, or a dashboard reading the log), or one left without its log (the
    log moved aside), is refused, and nothing is imported. If the log can't be read when the file is judged, or the file can't be saved after it is, the entries
    stay as they were before and their flags stay off, with no record, until a later tick can. A save that fails (a
    full disk) is tried again at every tick. **Never silent:** while a flag is held off either way, each tick ends
    with an error naming it, so the config step records a `coordinator.error` at every tick until it clears; a failure
    of the config refresh in the same tick is recorded too, as its own error.
    Limits:
    - An import killed between moving the target's file aside and removing it leaves the file at
      `flags-unrecorded.json.import-old`, which nothing reads: its unrecorded offs are lost. If the kill came before
      the log write ended, the target's log is still its own: move it back by hand before the next start; if after,
      the log is the bundle's and the file belongs to none, so delete it. Nothing else takes it up: a later import
      puts back only a file it moved itself, and an export leaves `.import-old` out.
    - A bundle's own file of unrecorded offs is written right after its log, whatever order the bundle lists them in
      (R1173aj AJ4). An import killed after the log write and before that file loses the bundle's pending offs
      (AJ5): the imported log starts with them unrecorded, so a flag the source had turned off and not yet recorded
      reads as on until main changes.
    - Two imports into one folder at once aren't supported: there is no lock between them (AJ6). Stop the
      coordinator and run one import at a time, as export says.
    - A restored or replaced log whose row at an entry's position was written again with the very same millisecond
      stamp reads as the entry's own log: if main turns the flag on, the next start writes that off and the on once
      more.
    - An import of this instance's own earlier bundle (a restore by import) loses the offs not yet recorded: the file
      goes with the log it replaces, and the two logs can't be told apart. The updater's rollback keeps them.
    - An import doesn't check that the coordinator is stopped. One still running rewrites its own entries beside the
      imported log, and the next start writes their pairs into it. Stop it first, as export says.
    The coordinator adopts flags even when refreshing its config failed.
  - It reads `flags:` in plain code, not through the zod schema.
  - A coordinator started on the checkout's config (main's invalid or missing) adopts nothing until main's config is
    valid: **every flag is off**. A branch, a hand edit, a written-to config object or a polluted prototype never
    turns one on.
  - The snapshot is each coordinator's own (`coordinator.flags`), never the process's, bound to its own log and repo.
    A harness-eval replay builds a second coordinator in the instance's process and ticks it with a task repo's
    config: it has its own flags, and can't turn the instance's on or off. What this holds: no code path in the
    engine shares or changes another coordinator's flag state. Code running in the same process that sets out to
    tamper with it (a swapped prototype, a Proxy, a replaced built-in) is out of scope, though the shapes the reviews
    found are refused.
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
2. Guard the new behaviour with `this.flags.on('<name>')` in the coordinator, keeping the old behaviour when it's off.
   Only a coordinator has flags on, each its own: elsewhere (the tool guard, the CLI, the dashboard) no flag is ever
   on, so a flag guards only the coordinator's own behaviour.
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
