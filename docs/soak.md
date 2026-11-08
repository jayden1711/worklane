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
  - agent slots held.

## What fails it (`src/soak.ts`)

| Finding | Limit (`SOAK_LIMITS`) |
|---|---|
| Heap grew (after a 10-minute warm-up): from the first quarter's median to the median of the last 10 samples, to the last quarter's median, or by the robust slope over the run (no more than the rise seen); from the run's lowest 10-sample median to the median of the last 10; and from the upper envelope's first quarter (each 10 samples' highest) to the highest of its last 3 blocks, about the last 30 samples | 128 MB |
| RSS grew, the same way | 256 MB |
| Open file handles grew, the same way | 32 |
| Any one sample above the first quarter (memory held mid-run, then let go) | 4× the limit above |
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

The verdict and every sample are written to `SOAK_REPORT_DIR` (`soak-verdict.json`, `soak-samples.json`).

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
- **It can't show a leak slower than its hours.** Nor can it show a rise inside the first quarter of the run that then
  holds (about the first 80 minutes of a 5.5 h run, measured by R1181e) under 4× its limit: the first quarter is the
  baseline. The 4 GiB heap cap bounds that heap. A leak after a high first quarter is read from the run's low point.
- **A single held sample at the very end counts:** the envelope reads about the last 30 samples, so one forced-GC
  sample 140 MB up at the end fails where the same sample mid-run passes (R1181h H4).
- **A sawtooth slower than the 10-sample block** is bounded only by the 4× peak rule (R1181g note 3).
- **The workflow trusts what it pins:** every step through the soak is pinned as written; `npm ci`'s own package
  scripts, setup-node and the runner image aren't, so the soak step sets its knobs, clears NODE_OPTIONS and BASH_ENV
  and runs only setup-node's node.
- **It is a heuristic over a sampled series.** Each review round found shapes it misjudged; issue #1231 proposes a
  written attack spec as its acceptance bar. A tick that grows with the log (issue #1234) is expected to fail it today.
