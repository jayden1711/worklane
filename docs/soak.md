# The soak test

A coordinator that works for hours can leak what a test of minutes never shows: memory, file handles, an event log
or WAL that keeps growing, a run that never ends, a slot never given back, ticks that get slower. The soak test runs
the real coordinator for hours and fails on any of these. Code: `test/soak.test.ts` (the run), `src/soak.ts` (the
verdict). Workflow: `.github/workflows/soak.yml`.

## What runs

- **A real coordinator, nothing real at stake.** The real coordinator works on a scratch repository with a local
  bare remote and a file backlog (the test harness's), so nothing is pushed to GitHub. The agents are stand-ins: the
  worker adds the file its task asks for, and the evaluator approves what it read. No model is called and nothing
  is spent.
- **A steady stream of work.** A new task is filed every 30 s (`SOAK_ISSUE_EVERY_S`). Each one goes claim → build →
  checks → evaluation → land, as a real task does.
- **A tick on a fixed period**, 1 s (`SOAK_TICK_MS`), as production ticks on one (60 s there). Back to back, a tick
  that slowed with the log would also slow the log's growth and hide its own drift.
- **A sample every 60 s** (`SOAK_SAMPLE_S`; the verdict judges gaps, the sample count and the filing against the
  driver's own periods, never the run's own spacing, which a coordinator slow on every tick would set), after a forced GC (the driver refuses to run without `--expose-gc`),
  records:
  - heap and RSS;
  - open file handles (`/proc/self/fd`, or `/dev/fd`);
  - the event log's size (its file and its WAL), the WAL alone, and its event count;
  - the median and the slowest tick since the last sample;
  - distinct tasks landed, tasks filed, and the oldest unlanded task's age;
  - agent runs open, and the oldest one's age;
  - agent slots held;
  - on Linux, the open file handles the processes it started hold (each one's `/proc/<pid>/fd`);
  - on a real soak on Linux, the job's cgroup (named by `/proc/self/cgroup`): the processes in it and its sub-groups
    (`cgroup.procs`), and its kernel memory less what the kernel can reclaim, plus its socket buffers
    (`memory.stat` `kernel` − `slab_reclaimable` + `sock`).

  After the last tick the driver stops the coordinator, waits for its `idle()` and 2 s more, and takes **one more
  sample**, the stop sample, judged on its own (below): what the shutdown leaves is read too.

## What fails it (`src/soak.ts`)

| Finding | Limit (`SOAK_LIMITS`) |
|---|---|
| Heap grew (after a 10-minute warm-up): from the first quarter's median to the median of the last 10 samples, to the last quarter's median, or by the robust slope over the run (no more than the rise seen); from the run's lowest 10-sample median to the median of the last 10; and from the upper envelope's first quarter (each 10 samples' highest) to the highest of its last 3 blocks, about the last 30 samples | 128 MB |
| RSS grew, the same way | 256 MB |
| Open file handles grew, the same way | 32 |
| Any one sample above the first quarter (memory held mid-run, then let go) | 4× the limit above |
| `coordinator.error` events, agent runs that didn't succeed (or failed to start), and every other event type whose name ends in `.failed` or `_failed` (read from the event schema itself), in the whole run, the warm-up included (the stand-in agents never fail) | 0 |
| The machine's full-run test lock, held at any sample | never |
| The coordinator's git worktrees grew, and the entries in its worktree folder (a checkout git no longer lists is still there), as open file handles are judged | 2 |
| The processes the soak started grew; the same way. Counted: its descendants; any of this user's in a group or session one of them leads or led (that same leader, by its start time); and on Linux, any carrying the soak's mark in its environment. The smoke counts its own group only when it leads it (under `node --test` the group is the runner's and every test file's). A real soak, which has its machine to itself, also counts its own group whether it leads it or not (never the test runner, its parent), and on Linux any of this user's that started after the soak (by pid and start time) in its own session or in a session that didn't exist then: an orphan that dropped the mark and left the group, one in a new session, or a user-manager service. So a detached child or a setsid'd double fork counts in both; a plain double fork that dropped the mark counts in a real soak, and in the smoke only by the mark | 4 |
| Those processes' resident memory grew, as RSS is judged | 256 MB |
| Those processes' open file handles grew (Linux, where they are required in every sample), as this process's are judged | 32 |
| A real soak on Linux only (required in every sample there): the processes in the job's cgroup grew, as child processes are judged. They are counted whatever their uid, session or pid history (`sudo` doesn't move a process out of the cgroup). Processes, not tasks: `pids.current` counts threads, which the runner's own .NET processes add and drop | 4 |
| A real soak on Linux only: the job cgroup's kernel memory less what the kernel can reclaim, plus its socket buffers (`kernel` − `slab_reclaimable` + `sock`), grew, as memory is judged. It bounds what no fd table names: a pipe's or a socket's buffers held only in flight (sent over a unix socket and never received, or sent over TCP or UDP and never read). The kernel charges a pipe's and a unix socket's as kernel pages (R1181u C1: `slab_unreclaimable` + `sock` read about a tenth of them) and a TCP or UDP socket's as `sock` (R1181x D1); a netlink socket's to no cgroup, so the level adds the namespace's netlink queues (R1181z D1). The dentry cache is reclaimable, so walking files doesn't move it | 64 MB, 4× held |
| The stop sample (read after `stop()`, `idle()` and 2 s): processes the soak started, processes in the job's cgroup, worktrees or the worktree folder's entries above the first quarter's median; an agent run open, a slot or the full-run lock held; a `coordinator.error`, a failed run or another failure event logged during the shutdown (R1181v L1); more than 64 files and folders outside the worktree folder, more than 64 files in the worktree folder that no checkout tracks (untracked or ignored in a checkout, or in an entry that is no checkout: R1181aa AA1; a checkout open at stop keeps its own), 16 MB of disk besides the event log, or 1 MB of event log written since the last run sample, or the WAL past its limit (R1181x D2); more than 64 files outside the soak's folders (used inodes, less the walked files on the filesystems counted: a tmpfs soak folder is in none, R1181aa AA2), the filesystems' level more than 16 MB above the last run sample's, or a SysV IPC object above the first quarter's (R1181z D2, D3, L3); open file handles (its own, the children's), watches, the children's RSS, the cgroup's kernel memory or the filesystems' level above the first quarter's median by more than its growth limit | any one, or the limit above |
| inotify watches and fanotify marks grew, this process's and those processes' (Linux, where they are required in every sample), as open file handles are judged | 32 |
| Disk under the soak's folder, the test isolate's home, the `/dev/shm` entries the soak or one of its processes holds open or mapped, and (Linux) files they hold open or mapped after unlinking them, besides the event log (judged on its own above), per landed task after the warm-up | 64 KB |
| The same disk, grown or held mid-run, as memory is judged (temp files are made inside the folder) | 256 MB, 4× held |
| A real soak on Linux only (required in every sample there): the used space of the filesystems of the soak's folder and `/var/tmp` (statfs), plus the kernel's `Shmem` (which holds `/dev/shm`, `$XDG_RUNTIME_DIR` and every other tmpfs, so they aren't read twice; a soak folder on a tmpfs is read through `Shmem` only, R1181x L1), less the event log, which is on the soak folder's filesystem and judged on its own above. Grown or held, with the same envelope as the disk. It catches what a walk misses: an unlinked open or mapped file, a memfd, a file outside the walked folders by its blocks (an empty file there costs an inode and no block: its inodes are read at the stop sample only, R1181z D3). But it also counts anything else on those filesystems, so it is read only where the soak has its machine to itself: not in the smoke, which shares its machine with other test files, nor off Linux | 256 MB, 4× held |
| Files and folders under the soak's folder, per landed task after the warm-up | 64 |
| Agent runs open, at any sample | 0 |
| Agent slots held, at any sample | 0 |
| A gap between samples | 3× the sample period, and at least 5 min |
| Samples, against the hours asked at one a sample period | at least 90% |
| One tick | 30 min |
| Event log growth per landed task, over the run and over every 30-minute window that landed at least half the usual (and 5) | 256 KB |
| Event log growth in a 30-minute window that landed fewer | 3× the usual window's |
| WAL size at any sample (checkpoints falling behind) | 64 MB |
| Median tick, and each interval's slowest tick: the last quarter's, and the last 30 minutes', vs the first quarter's | 3× |
| A tick's cost against the log's size, the median's or the slowest's (its slope, judged once the log gained 10k events) | 250 ms per 100k events |
| Tasks landed | at least 1 |
| Tasks filed, against the hours asked at one a filing period | at least 50% |
| Tasks filed and not landed, at any sample after the warm-up | 10 |
| The oldest task filed and not landed, at any sample after the warm-up | 30 min |
| Minutes since the last landing, at the end, with tasks filed since | 5, or 3× the run's median gap between landings |
| Samples after the warm-up | at least 4, and the run at least 90% of the hours asked for |
| Samples that counted open file handles | at least half |
| A sample missing a field the verdict reads | none (it judges nothing, and fails) |

Growth is read against the first quarter's median, and the largest reading counts. A late spike, a late step and a
slow linear leak are each read whole. A rise that levels off within the limit is read as its real size, not its
slope over the whole run. A sawtooth whose peaks rise is read by its peaks (the envelope).

The driver samples after the coordinator's `idle()`, with no run in flight. So a run open at a sample is one that
never finished, and a slot held then is leaked, however young either reads. The events carry no run id: a finish
closes the newest open run of its issue and role, so an orphan left before a retry keeps its own age.

- **Work must keep landing.** A backlog of more than 10 unlanded tasks fails, and so does no landing for the last
  5 minutes while tasks were filed.
- **Too short fails.** A run with fewer than 4 samples after the warm-up fails, and so does one shorter than 90% of
  the hours it was asked for. The workflow also checks that the verdict is for the hours asked.
- **Open file handles are judged over the samples that counted them.** A run where most samples couldn't count them
  fails.
- **The WAL is read once a sample** (a minute), so a spike between two samples isn't seen. The log is judged per
  landed task, with no absolute cap.

The verdict and every sample are written to `SOAK_REPORT_DIR` (`soak-verdict.json`, `soak-samples.json`), and each sample
as it is taken (`soak-samples.jsonl`), so a run that crashes or runs out of memory still leaves its samples. The
workflow empties that folder before the soak, and runs node without `NODE_TEST_CONTEXT` (with it, `node --test` runs
nothing and exits 0), so a verdict an earlier step left there is never the one read. A check a run is too short for
(the last 30 minutes' drift needs 2 h after the warm-up, the tick against the log 10k new events) is named in the
verdict's `not_judged`, not passed in silence. Runs are grouped per branch, so a dispatch from another branch never
replaces main's pending scheduled run.

## When it runs

- **Every PR**, as a smoke test: the same test for 12 ticks (`SOAK_TICKS`), back to back, with a sample and a new task
  each tick. A tick count rather than a time, so a slow runner gives the same number of samples. Its limits are
  wider and it judges no log rate or tick slope, since 12 ticks are no time to judge them (they never reach a WAL
  checkpoint). It shows that the driver, the sampling and the verdict work.
- **Weekly and by hand**, the soak itself: the `soak` workflow, never on a pull request. It runs on GitHub's runners,
  which stop a job at 6 hours, so a soak is **at most 5.5 hours**. The schedule runs 5.5 h; `workflow_dispatch` takes
  `hours` (from 1 to 5.5; anything else is refused). A run must leave a verdict with no failure, for the hours asked,
  to pass: a skipped or renamed test that writes none fails the job. `test/soak.test.ts` pins the soak step's
  script as written, and the job's and step's keys (no `if:`, no `continue-on-error`, no secrets in any form). The
  process has a 4 GiB heap cap, so a leak fails the soak rather than the runner, and `timeout` ends it 15 minutes
  past its hours. The verdict goes to the run's summary, and the report is kept as the `soak-report` artifact for 30
  days. The workflow is required by nothing: not the ruleset, not `.worklane/config.yaml`, and not the updater.
- **Not 8 hours, by the owner's decision (2026-11-07).** A continuous 8 h soak would need the trusted self-hosted
  runner, and `test/self-hosted-guard.test.ts` lets only push-guarded, required jobs run there. The soak stays on
  GitHub's runners.

## What it can never do

- **It can't push, merge, post or spend.** The repository and its remote are scratch directories, the agents are
  stand-ins, and the workflow has `contents: read` and no secrets.
- **It can't run on a pull request's code with more than read access**, or on a self-hosted runner.
- **It can't see leaks in what it doesn't run:** real agents' processes, the dashboard, the updater, the hub, or a
  real GitHub's answers. It soaks the coordinator's own loop.
- **It can't stop code that runs before the soak step from changing what the soak runs, beyond what the steps pin:**
  - Only the two pinned actions run before node's exact path is recorded (`record node`). The soak step and the build
    run that node, not whatever is first on PATH or under `$RUNNER_TOOL_CACHE` (R1181l 1, A3; owner OK 2026-11-09).
  - `install gitleaks` runs before `npm ci`, with BASH_ENV cleared. Then `npm ci --ignore-scripts`, so no package
    script runs, and the locked TypeScript runs, by the recorded node (R1181l 1, 2, R1181m D2).
  - The download helper calls its tools by absolute path, so a PATH stand-in, or a function named `sha256sum`, can't
    stand in for them. A BASH_ENV can still define a function by the absolute path's own name, so a caller must clear
    BASH_ENV, as `install gitleaks`, the one step that runs it here, does.
  - setup-node itself, the runner image and the pinned actions are trusted as pinned.
- **It can't show a leak slower than its hours.** Nor can it show a rise inside the first quarter of the run that then
  holds (about the first 80 minutes of a 5.5 h run, measured by R1181e) under 4× its limit: the first quarter is the
  baseline. The 4 GiB heap cap bounds that heap. A leak after a high first quarter is read from the run's low point.
- **A single held sample at the very end counts:** the envelope reads about the last 30 samples, so one forced-GC
  sample 140 MB up at the end fails where the same sample mid-run passes (R1181h H4).
- **A sawtooth slower than the 10-sample block** is bounded only by the 4× peak rule (R1181g note 3).
- **The workflow trusts what it pins:** every step through the soak is pinned as written; `npm ci`'s own package
  scripts don't run, setup-node and the runner image aren't pinned beyond their versions, so the soak step sets its
  knobs, clears NODE_OPTIONS and BASH_ENV, and runs the node recorded right after setup-node.
- **It can't see what it doesn't count off Linux, or below what it reads:** off Linux, an orphan that dropped the mark
  and left every group it was seen in, a file held open after unlinking, a child's open file handles, the job's
  cgroup and the filesystems' levels aren't read.
  - A process of another user (a `run_as` command through `sudo -n -u`), and a new process in a session of this
    user's that was alive before the soak and isn't the soak's own (a worker a daemon started earlier starts on the
    soak's request), aren't counted by process, nor are their file handles. A real soak on Linux counts them through
    the job's cgroup, but only those started in it (R1181t). A worker that a daemon outside the job's cgroup starts
    (a user service, another job's daemon) isn't counted at all, nor is a process of another user that leaves the
    cgroup (`sudo systemd-run`, a container started through a root daemon): its only link to the soak is a request
    over IPC (R1181v D2). A process of this user's that moves to another cgroup in a new session (a user-manager
    service) is counted as a new session; the smoke counts none of them.
  - A session is the soak's when it is new since the snapshot: its id unknown then, or now led by another process
    than the one that led it then (R1181t D4: a pid reused as a session id). A session whose leader has gone keeps its
    id, so the kernel won't reuse it.
  - What no process holds in its fd table (a pipe's, a unix socket's, a TCP or UDP socket's buffers held only in flight,
    sent and never received) is read only through the job cgroup's kernel memory, on a real soak on Linux: a hoard
    under its 64 MB limit isn't seen, and in the smoke none is (R1181t D1, R1181u C1, R1181x D1). A netlink socket's
    buffers are charged to no cgroup: the level adds the namespace's netlink queues (`/proc/net/netlink`), which on a
    runner are the machine's (R1181z D1); another kind of socket that no cgroup is charged for isn't read. An inotify instance held in flight costs
    about 88 bytes a watch, so it is bounded only by the system's `max_user_watches` (65,536 on a stock Ubuntu: about
    6 MB), never by this check. A file handle held in flight shows only as its file struct, about 15% of what it holds:
    the inode and dentry it pins count as reclaimable, which the level leaves out, so such a leak is bounded only by the
    user's open-file limit (R1181x D4). A pipe hoard stalls on the user's `fs.pipe-user-pages-soft` (64 MB) and then
    grows a page a pipe.
  - Kernel memory is charged to the cgroup a process is in when it allocates. A counted process in another cgroup (a
    user service the soak starts, a child that moves itself) holds what it puts in flight outside this check; it is
    counted as a process, not by what it holds (R1181x D3).
  - Scheduled work created during the run (a user timer, a crontab or `at` line), and a unit the user manager keeps
    loaded with no process (a path unit, a failed or `RemainAfterExit` unit), is seen only while its process runs at a
    sample, never as a schedule or a unit (R1181x D5, R1181z L4).
  - SysV IPC objects (semaphore sets, message queues, shared memory segments), POSIX message queues (`/dev/mqueue`,
    where it is mounted) and keys in this user's keyrings (`/proc/key-users`: their count and bytes against the
    quota) outlive every process: a real soak on Linux counts them, as processes are judged, and any above the first
    quarter's at the stop sample fail (R1181z D2, R1181ab D3, D4). The smoke doesn't: a desktop's own programs make
    them. Their noise on a runner hasn't been measured.
  - An empty file outside the walked folders costs an inode and no block. The filesystems' used inodes are read at the
    stop sample only, against the last run sample, less the walked folders' own files: mid-run they aren't judged, as
    their noise on a runner hasn't been measured (R1181z D3).
  - The stop sample is read 2 s after `stop()` and `idle()`: what the shutdown starts later, or ends later, isn't seen
    as left. A process the coordinator's git starts in the background (`git gc --auto` detaches) that is still running
    then would read as left behind.
- **The smoke counts less than a real soak:** it shares its machine with other test files and the user's programs, so
  it counts by descent, a seen leader and the mark only. In the smoke, an orphan that dropped the mark and left the
  groups it was seen in (a plain double fork from a clean environment, or a new session) isn't counted, nor are the
  filesystems' levels read. A real soak counts both: it runs on a CI runner with the machine to itself, where a new
  session of the same user during the soak (on a desktop, a new terminal) would be counted as the soak's.
- **It is a heuristic over a sampled series.** Each review round found shapes it misjudged; issue #1231 proposes a
  written attack spec as its acceptance bar. A tick that grows with the log (issue #1234) is expected to fail it today.
