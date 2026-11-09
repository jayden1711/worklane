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
- it has been on for at least `soak_hours` (counted from the latest instance to turn it on), less any time its
  coordinator wasn't seen running: a clean stop to the next start, and any gap of more than `live_minutes` between
  two of its ticks after the flip (a suspended host, a paused VM, a frozen or hung coordinator, a clock stepped
  forward);
- **each** of the ring's instances merged at least `min_merges` PRs since then (`merge.done`, one per PR number; a
  merge with no number never counts), so an instance that does no work isn't promoted on the others'. `min_merges: 0`
  is allowed: an explicit opt-out by whoever writes root's `rollout.json`;
- **every instance is alive:** its last `coordinator.tick` is at most `live_minutes` old. A coordinator that stopped
  ticking isn't soaking: silence between ticks after the flip isn't counted, and silence now holds the ring;
- **nothing went wrong** in any of them since it went on:
  - no `merge.stopped`;
  - no `merge.main_result` red or timed out;
  - no `config.invalid`;
  - no `testrun.fault`;
  - no unclean stop, and no restart without a clean stop before it (a crash, or a crash loop);
  - no more than `max_errors` `coordinator.error`, and no events lost to a full disk (what they said is unknown);
- every ring before it is promoted;
- every instance's event log could be read.

"Since it went on" is by the **log's own order**: what was written after the flip that turned the flag on. The clock
only measures the soak's hours, so a clock stepped back never hides a bad sign. A flip stamped before events logged
ahead of it (a clock behind), an event logged after the flip but stamped before it, or a stamp that doesn't parse, can't
time a soak: the ring is held until the flag goes off and on again. Order against the ring before is judged from the
earliest stamp of any event in the stretch. A tick stamped in the future, or one whose stamp doesn't parse, is no sign
of life, and neither is a tick followed by a recorded stop. A merge counts once per PR, and only
when it was merged after the flip (by its own `merged_at` when it has one).
- **An off with no commit** (`sha: null`) is the engine's own, written when it read no config from the default branch.
  It is a real off: the engine ran with the flag off, so the next on starts a new soak. While an instance is off this
  way, its ring is held (`unknown`), and status never advises setting the flag true in a repo that already says so.
- **An on while already on** is a replay, never a new on-period.

Only then is the next ring turned on. **Out of order** is judged from the flip history, not today's state: a ring
turned on before the ring before it was promoted (its hours done and its `min_merges`-th merge) stays out of order
once that ring is promoted, until the flag goes off there and on again. A ring rolled back for a bad sign in the log
(auto-merge stopped, the default branch red or timed out, the config invalid, a machine fault, an unclean stop), then
turned off and on again, says so in its `why` ("rolled back before"). A rollback for a crash loop (restarts without a
clean stop) or too many coordinator errors leaves no such note once an off with a commit has ended that on-period:
those are judged within the period, and the next soak starts fresh (the owner's decision, #1231 X5).

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
instances folder. Run as root, it reads every home; a home that is there but can't be read (another user's, 0700) is
unread, and status exits 1 asking to run as root: the running user's own folder is never read in its place. A name in
both, and not the same folder, is ambiguous: neither is read, and status says to remove the stale one. A folder that is
a link to one is listed too. The machine's instances are those in the running user's folder and the server instances under
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

`--file <path>` reads another rollout file as it is (not checked as root's), and says so. A limit: it still exits 0
when everything else would, so a script can't tell a try-out from root's file by the exit code alone (the frozen
acceptance file's healthy CLI cases run with `--file` and expect 0); read the note.

## What it can never do

- **It can't turn a flag on or off.** There is no such command, and the status only says which PR to make.
- **It can't name a project in this repository.** The rings live in root's file on the machine.
- **It can't promote a ring it couldn't read**, one whose earlier ring isn't promoted, or one whose coordinator isn't
  ticking.
- **It can't see an instance the machine's list doesn't name** beyond the running user's folder and `/srv/worklane`:
  a desktop instance in another user's home is read only when it's in a ring.
- **It can't keep an admin's edit of `rollout.json` safe from a rename at the same moment:** the rename rewrites the
  file whole (atomically for readers), and the machine lock doesn't cover a hand edit.
- **It can't see silence from the flip, or from a coordinator start, to the first tick after it:** the gaps it takes
  off are between two ticks, or from a tick to a stop, so a coordinator that hung right after logging the flip, or
  after starting, has that time counted until its next tick. A test pins this; closing it needs the frozen acceptance
  file's sparse healthy logs changed, which is the owner's decision.
- **It can't tell a clock that was behind at boot:** the soak counts wall-clock time, so a host booted with its clock
  at the time it shut down (no RTC), then stepped forward by NTP after the flip, has its downtime counted as soak.
  Keep the host clock synced at boot. A test pins this limit, so a fix shows up as a change.
- **It can't see harm the event log doesn't record:** a slower agent, or a worse plan that still merged green. The
  soak time and the merge count are there so a person looks before the next ring.
- **It can't stage an engine version.** That's the canary's and the updater's job.
