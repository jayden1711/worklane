# Experiments (agent research loops)

A **study** lets an agent improve one number for you. You fix the goal (one metric and its direction), the eval and the
budget. Each round, one agent session reads the study's research log, proposes **one** change and **one** config, and
ends. A sandboxed job then trains and predicts on this machine's GPU, a separate scorer scores the predictions, and the
result is kept only if it beats the best so far. When the job's record lands, the next session starts. Nothing polls.

It follows published agent research loops (Karpathy's autoresearch: a fixed eval, a fixed time budget per run, a
keep/discard log), with each of their prompt rules made into code. The AI Scientist (Sakana, 2024) edited its own
timeout; METR (2025) saw models read the grader's answer. Here the caps sit outside the job's reach, and the score is
computed by another user in another process against labels the job never sees.

## The study file

Studies live in the project's own `.worklane/experiments.yaml` (a self-modification path: always reviewed at L3 and
merged by an owner). An owner then starts a study on the dashboard, which pins its version: the definition, the eval
files' sha256 and the data sources' sha256. Any of them changing is a new version, and the best starts over.

```yaml
version: 1
studies:
  - id: example-speed
    goal: "Lower validation loss at a fixed training budget"
    metric: { name: val_loss, direction: min, min_delta: 0.002 }
    eval:
      mode: split                              # the only mode: the job predicts, the scorer scores
      predict: "python eval/predict.py --ckpt $OUT/ckpt --inputs $EVAL_INPUTS --out $PRED"
      score: "python eval/score.py --pred $PRED --labels $LABELS"
      files: [eval/score.py, eval/predict.py]  # pinned at start; the pinned copy is what runs
      inputs: eval-inputs                      # approved data source ids (root's file), never paths
      labels: eval-labels                      # scorer-only
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
    confirm_runs: 1
```

The file is refused when the labels are also training data or eval inputs, or when an editable glob covers an eval file.

## The session

- The experimenter role has Read, Glob, Grep, Edit and Write in its own worktree: no shell, no network, no tool to
  start, watch or wait for a job.
- Its only output is one object: `hypothesis`, `motivation`, `expected_effect`, `config`. The coordinator reads it once.
- The change is the worktree's diff. It must be non-empty, only plain files (no symlink, submodule or mode change) and
  only inside `editable`. A config key outside `config_schema` or a value outside its bounds is refused, not clamped.
- Refusals are log entries too, so the next session sees them.

## Keep or discard

- The first result of a version is the baseline. After it, a result is kept only when it beats the best by more than
  `min_delta`.
- With `confirm_runs: 1`, a beating result is run again (same commit, a new seed) and judged on the worse of its runs.
- Exploration: exactly `share` of sessions explore (counted, not drawn at random). An explore session starts from a
  near miss (a discarded result within `near_miss` of the best) instead of the best. It is judged by the same rule, so
  the best never gets worse.
- Three crashed, refused or stopped jobs in a row pause the study until someone resumes it.

## Approval and caps

An owner approves a job in the Inbox when it is the first job of a study version, runs over 20 minutes, uses more than
one GPU, writes more than 20 GB, or changes the dependency lockfile. Root's file on the machine sets hard caps (minutes
a job, GPU-hours a day, output size, the approved data sources): a job above them is refused and can't be approved.

Spend is real money only: the sessions' agent cost, counted on the local day. GPU time is shown in hours.

## Setting a machine up (root, server mode only)

```sh
sudo bash scripts/setup/experiments.sh install <name>        # users, helper, sudoers rule, slice, root's file
sudo bash scripts/setup/experiments.sh set <name> --devices 0 --max-minutes 60 --gpu-hours 8 --output-gb 50
bash scripts/setup/experiments.sh data hash <path>            # prints the sha256 to approve
sudo bash scripts/setup/experiments.sh data add <name> <id> --from <path> --sha256 <hex> --visibility job|scorer
sudo bash scripts/setup/experiments.sh check <name>
```

- `wl-exp-<name>` runs a job's build, preflight, train and predict steps; `wl-score-<name>` runs its score step. Both
  are system users with no login, no home and no sudo, each in its own group only. Neither is ever in a GPU group: a
  granted step's unit gets the device group for that unit only (`SupplementaryGroups=`).
- The helper (`/usr/local/libexec/worklane-exp`) runs each step as a transient unit in `worklane-exp.slice`. Every
  step has no network (the environment build too, unless root's file says `env_network: true`) and sees nothing of
  `/var/lib/worklane-exp` but what is bound for it. The score step runs the sealed eval copy as the scorer with the
  predictions and the labels; it never gets the job's workspace, environment or code.
- Root's file, `/etc/worklane/experiments/<name>.json`, is the only place the GPUs, the caps and the approved data
  sources come from. A source is copied by root, checked against the sha256 you give (a mismatch installs nothing),
  and readable only by the user its visibility names. Jobs never fetch anything.
- The GPU: the same per-GPU locks as the test runs, held from before training until prediction ends. The wait has its
  own limit and doesn't count against the job's minutes. A GPU job that timed out or was killed is never run again by
  itself.
- After a job, its outputs are root's (the coordinator reads them); the predictions are the scorer's. Nobody's job can
  write them again. The record (`record.json`) is root's.

## On the dashboard: Extend -> Experiments

Owners and writers see **Extend** in the sidebar (`g x`), with an **Experiments** tab beside Automations.

- **Empty state** (no study defined): what a study does, three guarantees, and one action. If the machine isn't set up
  for this instance, that action is **Copy setup command** (owners; run it in a root shell). Otherwise it's **Copy an
  example study**, to commit as the repo's `experiments.yaml` (an owner merges it).
- **A study** (`/extend/experiments/<id>`): its state and version; **Best so far** (value, change against the
  baseline, a chart of the best over scored jobs); **Queue** (the entry in flight, why it waits for approval, or the
  next round); **Spend today** (agent dollars, GPU-hours, dollars in all, jobs, each against its cap); and the
  **research log**, newest first.
- **Buttons** are only those this person may use and that apply now. Owners: Start (or start a new version), Approve
  or Decline a waiting job, Resume, Archive. Writers: Pause, and Stop job while one runs. Viewers have no tab, and the
  server sends them nothing.
- **Review -> Confirm**: every action first shows what it would do and the exact change (for Start: the version, the
  commit, each eval file's and data source's sha256). Confirm does exactly that, and is refused if anything moved since
  the review. Every attempt is audited.

### How a new user finds it
1. The sidebar shows Extend; its second tab is Experiments.
2. The empty state says what a study is; its one button copies the root command (or an example study, once set up).
3. After the root script and a merged `experiments.yaml`, the study's card says "not started"; its page has Start, whose
   Review shows the pins.
4. The first job (the baseline) waits: the study shows "Waiting for you" with the reason, and Approve job.
5. From then on each round adds a log row; holds, the circuit breaker and approvals show on the study's page.
