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
- **A sample every 60 s** (`SOAK_SAMPLE_S`) records:
  - heap and RSS;
  - open file handles (`/proc/self/fd`, or `/dev/fd`);
  - the event log's size (its file and its WAL) and the WAL alone;
  - the median tick time since the last sample;
  - tasks landed;
  - agent runs open, and the oldest one's age;
  - agent slots held.

## What fails it (`src/soak.ts`)

| Finding | Limit (`SOAK_LIMITS`) |
|---|---|
| Heap grew from the first quarter (after a 10-minute warm-up): the highest of the last 3 samples, the last quarter's median, or the robust slope over the run | 128 MB |
| RSS grew | 256 MB |
| Open file handles grew | 32 |
| An agent run open, at any sample, for longer than | 30 min |
| Agent runs started and never finished, at the end | 0 |
| Agent slots held beyond the runs open, at any sample after the warm-up (any at the end) | 0 |
| Event log growth per landed task, over the run, its last quarter and its last 30 min | 256 KB |
| WAL size at any sample (checkpoints falling behind) | 64 MB |
| Median tick, last quarter vs first | 3× |
| Tasks landed | at least 1, and at least half of those filed |
| Tasks landed in the last quarter, while tasks were filed in it | at least 1 |
| Minutes since the last landing, at the end, with tasks filed since | 5 |
| Samples after the warm-up | at least 4, and the run at least 90% of the hours asked for |
| Samples that counted open file handles | at least half |

Growth is read three ways against the first quarter's median, and the largest counts: the highest of the last 3
samples, the last quarter's median, and a robust (Theil-Sen) slope over the run times its length. The driver forces a
GC before each sample (`--expose-gc`), so a peak is memory held, not garbage. A late spike, a late step and a slow
linear leak are each read whole. The driver samples after the coordinator's `idle()`, with no run in flight, so a run
open at a sample is one that never finished, and a slot held then is leaked.

- **Work must keep landing.** A soak fails when no task landed in its last quarter while tasks were filed, or when
  fewer than half the tasks filed landed.
- **Too short fails.** A run with fewer than 4 samples after the warm-up fails, and so does one shorter than the hours
  it was asked for.
- **Open file handles are judged over the samples that counted them.** A run where most samples couldn't count them
  fails.
- **The WAL is read once a sample** (a minute), so a spike between two samples isn't seen. The log is judged per
  landed task, with no absolute cap.

The verdict and every sample
are written to `SOAK_REPORT_DIR` (`soak-verdict.json`, `soak-samples.json`).

## When it runs

- **Every PR**, as a smoke test: the same test for 12 ticks (`SOAK_TICKS`), with a sample and a new task each tick.
  A tick count rather than a time, so a slow runner gives the same number of samples. Its limits are wider, since a
  minute is no time to judge a slope. It shows that the driver, the sampling and the verdict work.
- **Weekly and by hand**, the soak itself: the `soak` workflow, never on a pull request. It runs on GitHub's runners,
  which stop a job at 6 hours, so a soak is **at most 5.5 hours**. The schedule runs 5.5 h; `workflow_dispatch` takes
  `hours` (from 1 to 5.5; anything else is refused). A run must leave a verdict with no failure to pass: a skipped or renamed test that writes none fails the job. The process has a 4 GiB heap cap, so a leak fails the
  soak rather than the runner, and `timeout` ends it 15 minutes past its hours. The verdict goes to the run's summary,
  and the report is kept as the `soak-report` artifact for 30 days. The workflow is required by nothing: not the
  ruleset, not `.worklane/config.yaml`, and not the updater.
- **Not 8 hours, by the owner's decision (2026-11-07).** A continuous 8 h soak would need the trusted self-hosted
  runner, and `test/self-hosted-guard.test.ts` lets only push-guarded, required jobs run there. The soak stays on
  GitHub's runners.

## What it can never do

- **It can't push, merge, post or spend.** The repository and its remote are scratch directories, the agents are
  stand-ins, and the workflow has `contents: read` and no secrets.
- **It can't run on a pull request's code with more than read access**, or on a self-hosted runner.
- **It can't see leaks in what it doesn't run:** real agents' processes, the dashboard, the updater, the hub, or a
  real GitHub's answers. It soaks the coordinator's own loop.
- **It can't show a leak slower than its hours**, or one hidden in the 10-minute warm-up.
