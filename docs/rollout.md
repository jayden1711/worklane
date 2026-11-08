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
  "promote": { "soak_hours": 48, "min_merges": 3, "live_minutes": 30, "max_errors": 2 }
}
```

- **Ring 0 is the engine's own repository, and nothing else.** Status checks it: each ring 0 instance's
  `instance.yaml` names one of the engine's own repos (`engineRepos()`), and no instance of the engine's repo is
  outside ring 0. Wrong, or can't tell: no ring is turned on, and status exits 1. The rings go in order, and an
  instance is in one ring only.
- **The file is root's alone.** Status reads it as root's other policy files are read: a link, a non-regular file, or
  one another user can write is refused. `--file <path>` reads a copy as it is, to try one out, and says so.
- **Ring and instance names** are lowercase letters, digits and dashes, never a path.
- **`promote`** defaults to 48 hours, 3 merges, a tick in the last 30 minutes, and at most 2 coordinator errors.
- **An instance in a ring is never removed, and a rename keeps the file right**
  (`scripts/setup/instance-records.cjs`):
  - **Removal is refused** (`instance-remove.sh`, before it changes anything) while the instance is in a ring. Taking it
    out would throw away the ring's evidence: its bad signs since the flag went on, so the ring would read promoted. Or
    it would throw away a ring whole: ring 0, so the next ring would get the flag with no engine soak. Take it out of
    `rollout.json` by hand first, judging that ring again, then remove the instance.
  - **Renaming** an instance renames it in its ring.

## Promotion criteria

A ring is **promoted** when all of these hold:

- the flag is on in **every** instance of the ring (on in some is `partial`);
- it has been on for at least `soak_hours` (counted from the latest instance to turn it on);
- **each** of the ring's instances merged at least `min_merges` PRs since then (`merge.done`, one per PR number), so an
  instance that does no work isn't promoted on the others';
- **every instance is alive:** its last `coordinator.tick` is at most `live_minutes` old. A coordinator that stopped
  ticking isn't soaking, so silence never reads as health;
- **nothing went wrong** in any of them since it went on:
  - no `merge.stopped`;
  - no `merge.main_result` red or timed out;
  - no `config.invalid`;
  - no `testrun.fault`;
  - no unclean stop, and no restart without a clean stop before it (a crash, or a crash loop);
  - no more than `max_errors` `coordinator.error`;
- every ring before it is promoted;
- every instance's event log could be read.

"Since it went on" is by the **log's own order**: what was written after the flip that turned the flag on. The clock
only measures the soak's hours, so a clock stepped back never hides a bad sign. A tick stamped in the future is no sign
of life. Two kinds of flip don't count:
- an off with no commit (`sha: null`) is the engine's own, written when it read no config from the default branch, not
  a config change, so the ring keeps its history;
- an on while it is already on is a replay, never a new on-period.

Only then is the next ring turned on. **Out of order** is judged from the flip history, not today's state: a ring
turned on before the ring before it was promoted (its hours done and its `min_merges`-th merge) stays out of order
once that ring is promoted, until the flag goes off there and on again. A ring that was rolled back, then turned on
again, says so in its `why` ("rolled back before").

A ring with an instance whose log can't be read is **unknown**, never off. It holds every step that turns a ring on,
and a rollback names it too.

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

It prints each ring's state (`off`, `partial`, `soaking`, `promoted`, `roll back`, `out of order`, `unknown`) and why, then the
**one** next step: which ring to turn on, what to wait for, or which rings to roll back, naming their instances.

**Where it finds an instance:** in the instance's coordinator home (`wl-<name>`,
`~/.local/state/worklane/instances/<name>`), where a separate-users machine keeps it, or in the running user's own
instances folder. Run as root, it reads every home. A name in both, and not the same folder, is ambiguous: neither is
read, and status says to remove the stale one. A folder that is a link to one is listed too. The machine's instances are those in the running user's folder and the server instances under
`/srv/worklane`; a list that doesn't name every ring instance isn't the machine's whole list, and holds (exit 1).

**Instances in no ring are read too.** Status also reads every other instance on the machine.

- **One with the flag on** is listed as `outside the rollout`, and it's always in the roll-back step. Its repo turned
  the flag on, but the rollout never put it there.
- **One whose log can't be read** holds every step that would turn a ring on or call the flag done, because status
  can't tell whether the flag is on there. It also exits 1.

It opens every event log read-only and changes nothing.

- **Exit 0:** the status.
- **Exit 1:** the rollout file, an instance's log or the machine's instance list couldn't be used, or ring 0 isn't the
  engine's own repo (it still prints what it could).
- **Exit 2:** a usage error.

`--file <path>` reads another rollout file as it is (not checked as root's), and says so.

## What it can never do

- **It can't turn a flag on or off.** There is no such command, and the status only says which PR to make.
- **It can't name a project in this repository.** The rings live in root's file on the machine.
- **It can't promote a ring it couldn't read**, one whose earlier ring isn't promoted, or one whose coordinator isn't
  ticking.
- **It can't see an instance the machine's list doesn't name** beyond the running user's folder and `/srv/worklane`:
  a desktop instance in another user's home is read only when it's in a ring.
- **It can't keep an admin's edit of `rollout.json` safe from a rename at the same moment:** the rename rewrites the
  file whole (atomically for readers), and the machine lock doesn't cover a hand edit.
- **It can't see harm the event log doesn't record:** a slower agent, or a worse plan that still merged green. The
  soak time and the merge count are there so a person looks before the next ring.
- **It can't stage an engine version.** That's the canary's and the updater's job.
