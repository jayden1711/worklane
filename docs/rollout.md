# Canary rollout, ring by ring

A risky change reaches projects one ring at a time: first the engine's own repository, then each project in the order
root lists them. A ring goes on only after the ring before it has run the change long enough, with enough merges and
nothing going wrong. Code: `src/rollout.ts`, `src/rollout-cli.ts`. Tests: `test/rollout.test.ts`.

## What is rolled out, and what isn't

One engine install serves every instance on a machine, so the rings can't stage engine versions. They stage a
**risky change behind a feature flag** ([feature-flags.md](feature-flags.md)): the flag goes on for each ring's repos
in turn. Engine versions keep their own gate: the scratch-repo canary after every update, and the updater's rollback
when it fails ([canary.md](canary.md)).

## The rings: root's `/etc/worklane/rollout.json`

The rings name instances, so they live on the machine, never in a repository:

```json
{
  "rings": [
    { "name": "engine", "instances": ["<the engine repo's instance>"] },
    { "name": "first", "instances": ["<a project's instance>"] },
    { "name": "second", "instances": ["<another project's instance>"] }
  ],
  "promote": { "soak_hours": 48, "min_merges": 3 }
}
```

- **Ring 0 is the engine's own repository.** The rings go in order, and an instance is in one ring only.
- **Ring and instance names** are lowercase letters, digits and dashes, never a path.
- **`promote`** defaults to 48 hours and 3 merges.

## Promotion criteria

A ring is **promoted** when all of these hold:

- the flag is on in **every** instance of the ring (on in some is `partial`);
- it has been on for at least `soak_hours` (counted from the latest instance to turn it on);
- the ring's instances merged at least `min_merges` PRs since then (`merge.done`);
- **nothing went wrong** in any of them since it went on:
  - no `merge.stopped`;
  - no `merge.main_result` red or timed out;
  - no `config.invalid`;
  - no `testrun.fault`;
- every ring before it is promoted;
- every instance's event log could be read. An unread log promotes nothing.

Only then is the next ring turned on. A ring turned on before the one before it was promoted is **out of order**.

## Rollback

A ring where anything went wrong after the flag went on, or one that is out of order, is **roll back**. The flag is
turned off there and in every later ring that has it on, each through a PR in its repo that sets
`flags.<name>: false`. Each flip is recorded (`flag.flipped`). The engine never flips a flag by itself: on and off are
both reviewed config changes.

## Check where a change stands

As root, or as a user who can read each ring's event log:

```
worklane rollout status --flag <name>
```

It prints each ring's state (`off`, `partial`, `soaking`, `promoted`, `roll back`, `out of order`) and why, then the
**one** next step: which ring to turn on, what to wait for, or which rings to roll back, naming their instances.
It opens every event log read-only and changes nothing.

- **Exit 0:** the status.
- **Exit 1:** the rollout file or an instance's log couldn't be read (it still prints what it could).
- **Exit 2:** a usage error.

`--file <path>` reads another rollout file.

## What it can never do

- **It can't turn a flag on or off.** There is no such command, and the status only says which PR to make.
- **It can't name a project in this repository.** The rings live in root's file on the machine.
- **It can't promote a ring it couldn't read**, or one whose earlier ring isn't promoted.
- **It can't see harm the event log doesn't record:** a slower agent, or a worse plan that still merged green. The
  soak time and the merge count are there so a person looks before the next ring.
- **It can't stage an engine version.** That's the canary's and the updater's job.
