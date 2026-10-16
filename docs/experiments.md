# Experiments (agent research loops)

A **study** lets an agent improve one number for you. You fix the goal (one metric and its direction), the eval and the
budget. Each round, one agent session reads the study's research log, proposes **one** change, and ends. Sandboxed
jobs then train and predict on this machine's GPU, a separate scorer scores the predictions, and the coordinator
decides what runs next: a candidate is screened on one seed, then measured against the best on several seeds at the
same budget, at each size of the study's ladder, before it counts. Nothing polls.

## The design principle

**No viable hack exists; it isn't just detected.** Everything a score depends on is out of reach of everything the
score judges: the eval files, the scorer, the labels and the reference data are not in the agent's copy, not readable
through its tools, not mounted in a job's sandbox, and owned by another user; timings are taken by the harness; the
predictions are checked for format before the scorer reads them; limits are systemd's and the kernel's. The tampering
monitor and the anomaly hold are a second look, never the thing that keeps a hack out.

It follows published agent research loops, and what labs found when they ran them:

| Source | What it found | What it means here |
|---|---|---|
| Karpathy, autoresearch (github.com/karpathy/autoresearch, `program.md`) | A fixed eval, a fixed time budget per run, a keep/discard log; every rule there is in the prompt. | The same loop, each rule in code. |
| METR, "Recent frontier models are reward hacking", 2025-06-05 (metr.org/blog/2025-06-05-recent-reward-hacking) | Reward hacking was "more than 43× more common" on tasks where the model could see the whole scoring function; models overwrote timing functions and equality operators. | Sessions never see the eval, the scorer or the labels, only the metric in words and their own results; timings are the harness's own; the scorer is another process and user. |
| Sakana AI, "The AI Scientist" (arXiv 2408.06292, 2024) | It edited its own code to extend its timeout and relaunched itself. | Time, CPU, memory and process limits are systemd's; outputs live on a volume of exactly their quota; a job can't reach sudo, a helper, systemd or D-Bus. |
| Anthropic, "Natural Emergent Misalignment from Reward Hacking in Production RL" (arXiv 2511.18397, 2025-11-23; anthropic.com/research/emergent-misalignment-reward-hacking) | Models that learned to reward hack generalized to wider misalignment; preventing the hack was among what helped. | The principle above: make the hack impossible, not caught. |
| OpenAI, "Monitoring Reasoning Models for Misbehavior and the Risks of Promoting Obfuscation" (arXiv 2503.11926, 2025-03) | A weaker model reading the chain of thought catches reward hacking far better than one reading actions alone; training against the monitor teaches models to hide it. | A cheaper model reads each session's whole transcript; its findings go to the owner and the hold, never back to any session. |
| UK AISI, layered isolation for agent sandboxes (owner-provided, not verified) | Two network layers, and the controller outside the sandbox. | Every step has PrivateNetwork, and a host rule drops the job and scorer users' traffic too; the coordinator stays outside. |

## The study file

Studies live in the project's own `.worklane/experiments.yaml`. An owner starts one on the dashboard, which pins its
version: the definition, every eval file's sha256 and the data sources' sha256. Any of them changing on the default
branch stops new work until an owner starts the new version; the best starts over.

```yaml
version: 1
studies:
  - id: example-speed
    goal: "Lower validation loss at a fixed training budget"
    kind: supervised                           # supervised | self_supervised | unsupervised | generative
    metric: { name: val_loss, direction: min, min_delta: 0.002, source: score, anomaly_margin: 0.25 }
    eval:
      predict: "python eval/predict.py --ckpt $OUT/ckpt --inputs $EVAL_INPUTS --out $PRED"
      score: "python eval/score.py --pred $PRED --labels $LABELS"
      files: [eval/score.py]                   # the scorer's: only the score step ever has them
      predict_files: [eval/predict.py]         # the predict step's own sealed copy, never the scorer's
      inputs: eval-inputs                      # approved data source ids (root's file), never paths
      labels: eval-labels                      # scorer-only: labels, hidden targets, a probe's labels or a reference set
    train:
      command: "python train.py --config $CONFIG --data $DATA --out $OUT"
      data: [train-set]
      env: { lockfile: uv.lock, build: "uv sync --frozen" }
      preflight: "python -c 'import train'"
    editable: ["train.py", "model/**"]         # the only paths a change may touch; never the eval
    config_schema:
      lr: { type: number, min: 0.00001, max: 0.1 }
      depth: { type: integer, min: 2, max: 24 }
    data_card: "Text, one document a line; about 1M lines."
    job: { max_minutes: 10, gpus: 1, output_gb: 5 }
    budget: { gpu_hours_per_day: 4, agent_usd_per_day: 5, agent_usd_total: 60, max_jobs: 200 }
    exploration: { share: 0.2, near_miss: 0.02 }
    screen: { margin: 0.01, seeds: 3 }         # stage 1 must beat the best by margin; stage 2 runs 3 + 3 seeds
    ladder:                                    # optional, 2 or 3 sizes, smallest first
      - { name: small, config: { depth: 4 } }
      - { name: medium, config: { depth: 8 } }
```

The file is refused when the labels are also training data or eval inputs, when an editable glob covers an eval file,
or when a predict file is also the scorer's.

### Study kinds

Every kind is the same contract: the job writes predictions to `pred/`; the scorer (its own user and unit, no network)
compares them with what only it can read.

| Kind | The job's predictions | What the scorer holds |
|---|---|---|
| supervised | outputs for the eval inputs | the labels |
| self_supervised (and world models) | predicted futures or masked values | the hidden targets |
| unsupervised | embeddings or cluster assignments | a fixed probe and its labels, or hidden labels |
| generative | samples | a fixed reference set and metric |
| rl_rollout | — | **not supported in this version**: scoring would run the job's policy, and that can't yet be made safe. The study file is refused. |

Before the scorer runs, a gate (as the scorer user, in its own unit) reads every prediction file's bytes and headers
without loading anything: safetensors (plain numeric dtypes), `.npy`/`.npz` (numeric dtypes only: an object dtype is
pickle), `.csv`, `.json`, `.jsonl`, `.txt`. Pickle, `.pt`, `.pth`, `.ckpt` and anything else is refused by name and no
score is made.

## The session

- The experimenter has Read, Glob, Grep, Edit and Write in its own worktree: no shell, no network, no tool to start,
  watch or wait for a job.
- The eval files (the scorer's and the predict step's) are not in its worktree, and the hook denies their paths and the
  harness's config; its prompt gives the metric in words, its parent's config and its own past results, never the
  eval, the scorer's output, approval reasons or the monitor's findings.
- Its only output is one object: `hypothesis`, `variable` (the one thing it changes), `motivation`, `expected_effect`,
  `config`. The coordinator reads it once.
- **One variable per round**: one knob (against its parent's config) or the code, never both, never two. More is
  refused. A **combine** session is the one exception: it puts a winner found from a near miss onto the best.
- The change must be non-empty, plain files only, and inside `editable`.

## Keep or discard (two stages, scheduled by the coordinator)

1. **Stage 1, the screen**: one seed. Unless it beats the best by `screen.margin`, it is "screened out, 1 seed" and
   never run again.
2. **Stage 2**: `screen.seeds` runs of the candidate and the same number of the current best, the same budget each
   (the same minutes, GPUs, output quota and size; each run's GPU-minutes recorded). Better means the candidate's mean
   beats the best's by more than the seeds' spread (the larger standard deviation) and `min_delta`. The log shows
   mean ± spread for both.
3. **The scale ladder**: a winner at one size runs stage 2 again at the next, and only counts after the largest.
4. **The anomaly hold**: a winner beating the best by more than `anomaly_margin` (a share of the best), or whose
   session the monitor flagged, is held; the owner reads its run record, its change and the monitor's findings, then
   accepts or rejects it.
5. A winner from an explore session (built on a near miss, not the best) isn't promoted alone: a combine session puts
   its change on the best, and the combination is judged again by both stages.

Exactly `share` of sessions explore (counted, not drawn at random). Three crashed, refused or stopped jobs in a row
pause the study.

## The tampering monitor

After each session, a cheaper model (the one routing gives the short reflection run), with no tools, reads the
session's whole transcript (its reasoning, its tool calls and their results) and its change, and says whether it tried
anything aimed at the score instead of the task. A finding (or no answer) holds the job until the owner approves it,
holds its result for review, and raises an incident; it counts against the study's spend. Nothing it says ever reaches
a session.

## Approval and caps

An owner approves a job when it is the first job of a study version, uses more than one GPU, has an output quota over
20 GB (the size of its output volume, the disk it may fill), or changes the dependency lockfile; stage-2 and ladder
jobs follow the same rules. Time is a cap, not a threshold: root's `max_minutes` starts at 20 and is raised per
instance once its jobs are proven. A job above any of root's caps is refused and can't be approved.

Spend is real money only: the sessions' and the monitor's cost, on the local day. GPU time is shown in hours.

## Setting a machine up (root, server mode only)

```sh
sudo bash scripts/setup/experiments.sh install <name>        # users, helper, sudoers rule, slice, root's file, egress rule
sudo bash scripts/setup/experiments.sh set <name> --devices 0 --max-minutes 20 --gpu-hours 8 --output-gb 50 \
  --tasks-max 1024 --memory-gb 16 --cpu-cores 4
bash scripts/setup/experiments.sh data hash <path>            # prints the sha256 to approve
sudo bash scripts/setup/experiments.sh data add <name> <id> --from <path> --sha256 <hex> --visibility job|scorer
sudo bash scripts/setup/experiments.sh check <name>
sudo bash scripts/setup/egress-firewall.sh check
```

- `wl-exp-<name>` runs a job's build, preflight, train and predict steps; `wl-score-<name>` runs the gate and the
  score. Both are system users with no login, no home and no sudo, each in its own group only; neither is ever in a
  GPU group (a granted unit gets the device group for that unit only).
- Every step is a transient unit with RuntimeMaxSec, TasksMax, MemoryMax (no swap) and CPUQuota from root's file, no
  network (and the host's egress rule for these users as a second layer), nothing of `/var/lib/worklane-exp` but what
  is bound for it, and no way to reach a root helper, sudo, su, pkexec, systemd-run, systemctl or the systemd and D-Bus
  sockets.
- A job's outputs live on a loop-mounted volume of exactly its quota: the kernel stops its writes at the cap. They are
  copied off and made root's when it ends; the predictions are the scorer's.
- Train, predict and score times are the helper's own clock: a timing metric (`metric.source: train_ms` or
  `predict_ms`) is never anything the job printed.
- The GPU: the same per-GPU locks as the test runs. A GPU job that timed out or was killed is never run again by itself.
- CI's real-systemd job proves the sandbox, the egress rule (with PrivateNetwork off), the quota, a timing metric, the
  four study kinds end to end, and a canary job that tries each boundary once and must fail every attempt.

## On the dashboard: Extend -> Experiments

Owners and writers see **Extend** in the sidebar (`g x`), with an **Experiments** tab beside Automations.

- **Empty state** (no study defined): what a study does, three guarantees, and one action: **Copy setup command**
  (owners, when the machine isn't set up), else **Copy an example study** to commit as the repo's `experiments.yaml`.
- **A study** (`/extend/experiments/<id>`): its state and version; best so far; the queue; spend today; a held result's
  review card; and the research log, one row a hypothesis: its stage-1 result, each stage-2 size's mean ± spread
  against the best, and the budget each run used.
- **Buttons** are only those this person may use and that apply now. Owners: Start, Approve or Decline a waiting job,
  Accept or Reject a held result, Resume, Archive. Writers: Pause, and Stop job while one runs. Viewers have no tab.
- **Review -> Confirm**: every action first shows what it would do and the exact change; Confirm does exactly that, and
  is refused if anything moved since the review. Every attempt is audited.

### How a new user finds it
1. The sidebar shows Extend; its second tab is Experiments.
2. The empty state says what a study is; its one button copies the root command (or an example study, once set up).
3. After the root script and a merged `experiments.yaml`, the study's card says "not started"; its page has Start, whose
   Review shows the pins.
4. The first job (the baseline) waits: the study shows "Waiting for you" with the reason, and Approve job.
5. From then on each round adds a log row; holds, the circuit breaker and approvals show on the study's page.
