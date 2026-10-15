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
