# Worklane design

Status: **accepted at step 0 (2026-10-07)**, with the answers in §19. Name: Worklane (see [names.md](names.md)).

> **Changed since (stage 3, 2026-10-09).** Worklane keeps only what has shown it catches real problems, plus the controls that limit damage whatever the evidence: separate OS users and credential checks, the sandbox, protected categories that need a human, checks the harness runs itself rather than agents' claims, and no push to main. Removed for lack of evidence: the adaptive agent cap (a fixed, configurable cap remains, default 2), the optional roles of step 7, trust stages, the scorecard, the lessons loop and the Stop gate hook (the coordinator re-runs every `done_when` check itself before anything lands). A removed feature comes back only if the same failure happens twice. Sections below that describe these are kept as history.

> **Waiver (2026-10-13), trust metrics: read-only measurement only.** The owner waived the stage-3 rule above for one thing: measuring trust. `trustMetrics` (src/merge-metrics.ts) and src/trust.ts compute, per instance, the change failure rate, escaped bugs, time to restore, the review revise/reject rate, the flaky-check rate, cost per merged PR (tokens and estimated dollars) and verification time per tier, by risk area (money path, auth, other) over 7 and 30 days; the dashboard's Trust panel and a weekly digest in the Discord ops channel (`discord.ops_channel`) show them, with a recommendation in words ("keep 2 agents", "ready to raise to 3"; heavier or lighter verification per area). That is all it covers: no adaptive cap, no trust stages, and no automatic change to slots, caps or merges. Changing the agent count stays a machine owner's action. The code has no write path (test/trust.test.ts holds the module to imports that cannot write, and `/api/trust` to GET only).

> **Learnings (item 33, 2026-10-13): not the removed lessons loop.** When a task ends, each failed run leaves a `learning.noted` event: the earliest failed stage when code can tell it (`codeStage`; the weekly judge's label joins later) and the cause normalized as the weekly report does (`normalizeCause`). No agent writes a note and no model is asked. Notes with the same cause share the corrections fingerprint and point at the first with `same_as`; the Learnings panel on Reports groups them. A cause seen `MIN_SIGHTINGS` (3) times can be promoted by an owner only: the coordinator opens a PR adding that one line to `AGENTS.md`, labelled `review:L3`, which the merge policy never auto-merges. Agents never write `AGENTS.md` (a built-in guardrail, rule `agents-md`, and the push check's protected paths), so a worker's correction fix of kind `rule` goes in a skill.

> **Back on evidence (2026-10-13), checks from repeated feedback.** The feedback clustering held "until the same review comment shows up twice" comes back under the stage-3 rule: it acts only on that evidence and is off until configured (`checks_from_feedback: { enabled: false, min_sightings: 2, max_proposals_per_week: 3 }` in config.yaml). src/checks-from-feedback.ts groups what writers said when they turned work down (reviews requesting changes, closed PRs, revised or rejected plans, objections, chat corrections) by their words, deterministically, with the reverts of the same work as evidence. At two sightings of one constraint it proposes a check: a draft ast-grep rule with test cases where the repo has sgconfig.yml, else a test, as a draft PR quoting the evidence; an issue instead when the constraint concerns a protected area. Never auto-merged (its branch is in `neverAutoMerge`, and it is not recorded as the harness's PR); the Reports page shows the constraints with their counts and links.

> **Thesis (owner, 2026-10-18).** Code decides what may merge unattended; tests, fail-without tests, CI and the evaluator decide whether it's right. The rules limit scope (blast radius), not correctness: a backtest of the default rules over the public AIDev agent-PR dataset, with every verdict assumed PASS, would auto-merge 72.6% of PRs, including 66.0% of those people closed unmerged or reverted (README, "What it's for", with its limits). The merge decision follows rules read from the default branch (§4) that no agent can loosen: agents can't write the config folder's rules (the only paths in it they may edit are their own role prompts and skills, `AGENT_EDITABLE` in `src/guardrails/engine.ts`, and a change to those is `agent-instructions`, always high-risk and never auto-merged), and a change to the review rules, the merge policy or the harness's other controls is self-modification, always L3 and never auto-merged (`src/review.ts`). A model can only hold a merge, never approve one alone: the evaluator's PASS is required but never sufficient, since `readiness` needs every required check green on the head it approved (`src/pr-watch.ts`) and `mergeDecision` keeps every reason code computes, which a verdict can only add to (`src/merge-policy.ts`). A red main stops merging: only fix-forward's fix merges until it is green, and the culprit is reverted through a revert PR for a human when the fix doesn't come (§10, fix-forward). What sets the harness apart is the combination: deterministic merge rules, locks that know what an agent could change to loosen its own gate, a model that can only hold, and the control plane on infrastructure the customer owns. Direct land (`land_mode: direct`) is outside these guarantees: it skips `mergeDecision`; it is off by default, and the policy is that it stays an explicit owner opt-in on a single machine. The single machine is and stays a first-class deployment mode ([design/product-architecture.md](design/product-architecture.md) §0). The README's "What it's for" gives the review-bottleneck numbers this answers, with their source.

This document describes the architecture. Each section notes the precedent it follows (details and licenses in [prior-art.md](prior-art.md)); the order it was built in is in §18. Examples describe a hypothetical project. Everything specific to a real project lives in that project's `.worklane/` folder (config plus a `NOTES.md`), never in this repo; a CI denylist check enforces this.

---

## 1. Principles

1. **Proven patterns over invention.** Each mechanism names its precedent.
2. **Deterministic core, LLM leaves.** Code schedules, claims, budgets, validates and lands. Models plan, write, evaluate and summarize.
3. **Trust comes from verification, then scale.** Independent evaluation comes before parallelism, and parallelism before autonomy (Lauren Tan's pstack: "a loop you don't trust just produces unchecked work faster").
4. **Make the wrong thing impossible.** In order of preference: architecture, then a test or lint, then a written rule. Example: agents never get a GitHub write token or a production write credential, rather than a rule telling them not to use one.
5. **Block very little, verify a lot.** Only two things are blocked outright: signing from a live wallet and writing to the production database. Risky changes get more verification, not fewer permissions.
6. **One event log is the spine.** No component keeps private state. GitHub is the source of truth for issues and ownership.
7. **Nothing fails silently.** A gate that can't run is a failure that gets reported, never a pass. Cancelled or skipped is never green.
8. **"Done" means deployed and verified**, not "PR opened".

## 2. Packaging, naming, platforms

- **Engine:** this repo, installed as a pinned dev dependency: `npm install -D github:jayden1711/worklane#vX.Y.Z`. A `prepare` script builds `dist/` on install. Signed release tags, and a changelog that says what changed in guardrails, are planned in the releases track.
- **CLI:** `worklane`.

  | Command | What it does |
  |---|---|
  | `install` | Scaffold the config folder, generate hooks and settings |
  | `doctor` | Verify the install |
  | `up` / `down` | Install or remove the coordinator service |
  | `dashboard` | Open the UI |
  | `guardrails check` | Check rules for conflicts |
  | `report` | Generate a report |
  | `demo <dir>` | Seed a demo project worked by the real coordinator and open its dashboard |

  These are the main ones; `worklane --help` lists every command. Renaming the product is a repo script, not a CLI command: `npm run rename -- <name>`.

- **Config folder:** `.worklane/`, named after the tool following the `.github/`, `.claude/`, `.husky/` and `.pitboss/` precedent. `.harness/` was rejected because Harness.io already uses it, and projects often already call their test framework a "harness".
- **Language:** TypeScript on Node ≥ 22.13 (`engines` in package.json), so it works in projects whose CI still pins Node 22. The event log uses the built-in `node:sqlite`, which needs no flag from 22.13. CI runs everything on Node 22 and 24. `doctor` fails below 22.13.
- **Dependencies:** few and permissive.
  - Runtime: the three in package.json's `dependencies`, nothing else: `yaml` (ISC) and `zod` (MIT) for config and validation, and `@anthropic-ai/sandbox-runtime` (Apache-2.0) to run each approved MCP server in its own sandbox (`src/mcp/sandboxed.ts`). Built-ins cover SQLite, HTTP, SSE, file locks and `statfs`. (`ws`, the owner terminal's WebSocket, went with the terminal, #742.)
  - Agents run through the locally installed Claude Code CLI (`claude -p`), which is not a dependency of the package and is never vendored.
- **OS adapter layer** (`src/os/`). This is the only place OS-specific code may live, and a lint enforces that. The adapter is chosen by `os: auto | macos | linux | windows-wsl` (default `auto`).

  | Concern | macOS | Linux | Windows |
  |---|---|---|---|
  | Service | launchd LaunchAgent (generated plist, `launchctl bootstrap`) | systemd `--user` unit | inside WSL2: systemd; else Task Scheduler `ONLOGON` for dashboard only |
  | Load | `os.loadavg()` | `os.loadavg()` | CPU% from `os.cpus()` deltas (loadavg is always 0) |
  | Disk | `fs.statfs` | `fs.statfs` | `fs.statfs` |
  | Locks | `open(wx)` + pid liveness | same | same |
  | Bash sandbox | Seatbelt | bubblewrap | WSL2 bubblewrap; native Windows has none, so agents are **not run** |

  - On Windows without WSL2, `doctor` reports "dashboard + Issues only; agents run on another machine".
  - CI runs the core on macOS, Linux and Windows.
  - No service-manager libraries: the maintained ones are dead. We generate unit files from templates, about 150 lines total.

## 3. Architecture

```
            GitHub (issues, labels, assignees, claim refs, main)  ◄── source of truth
                 ▲  poll / webhook (normalized into events)
                 │  validated writes only
 ┌───────────────┴──────────────────────────────────────────────────────────┐
 │ Coordinator (deterministic, one per human per repo, runs as a service)   │
 │  scheduler · claims · state machine · budgets · watchdog · governor      │
 │  safe-output validator · review-level engine · land queue · deploy check │
 │                         │ append / read                                  │
 │                ┌────────▼─────────┐        SSE                           │
 │                │ event log (SQLite)│──────────────► Dashboard (localhost) │
 │                └────────▲─────────┘                 reports, scorecard   │
 └─────────────────────────┼────────────────────────────────────────────────┘
          spawn (claude -p, project settings only, no GitHub token)
     ┌───────────┬─────────┴──────┬───────────────┬──────────────┐
  worker×N     evaluator         pm        chief_of_staff     researcher …
  (worktree)  (read-only,        │                │
     │         fresh context)    └── emit proposed actions (NDJSON via local MCP tool)
     └── hooks: PreToolUse guardrails · PostToolUse format · Stop gate
```

## 4. Configuration

All config sits in `<project>/.worklane/` and is validated by zod schemas at startup. Invalid config exits non-zero with every error, the file and the path: it fails loudly and never falls back to defaults. JSON Schema is exported from zod so editors can autocomplete.

```
.worklane/
  config.yaml         # mode, backlog, runner, land_mode, os, owners, budgets, stage
  agents.yaml         # roster
  guardrails.yaml     # block rules, soft-deny (ask) rules, must-allow examples, network allowlist, protected paths
  tests.yaml          # test-runner adapter, tiers, money-path suites, baseline policy, worktree setup
  review.yaml         # review levels
  deploy.yaml         # environments, deploy adapter, verification
  benchmarks.yaml     # optional: declared benchmarks for the weekly optimization pass (a name, a command, repeats, a metric)
  roles/<role>.md     # role prompts (override the engine defaults)
  skills/<skill>/SKILL.md + evals/
  lessons/            # proposed and accepted lessons (land via review)
  checks/             # project-specific lints (e.g. a lint for unsafe reads of lagging external state)
```

**The config follows the default branch** (`src/config/live.ts`). The coordinator's clone is never checked out again after it is made, so its working tree's `.worklane/` goes stale the moment a config change merges; it is never what runs. At start the coordinator fetches the default branch and loads `.worklane/` at `origin/<default_branch>` straight from git (`git show`), with the same schema and cross-checks (and, for an instance, the same "a repo may only tighten the policy" check); the checkout's copy is used only when that ref has no config or an invalid one, and the start-up says so. Then, first thing every tick, it fetches the default branch again and, when the `.worklane/` tree there changed, loads and validates it and swaps it in whole (one assignment, with the instance's settings applied over it): everything that reads the config reads the new one from then on, with no restart. That covers `required_checks` (PR readiness, the check of main after an auto-merge, the main watch's own list for anything other than judging a merge), `land_mode`, tests.yaml (runner commands, gates, `land.pr_batch` fast and full checks, worktree setup, pool size, env), review.yaml, guardrails.yaml, agents.yaml (roster, budgets, routing), owners, reports, and the role prompts in `roles/`, read at the same commit. A config that fails validation is never applied: the last good one keeps running, `config.invalid` records the commit and every error (once per bad tree), and the watchdog's incident (`config_invalid`) is raised when there is one; a valid config on the branch again records `config.recovered` (or `config.applied`) and resolves it. A config change is `config.applied`, with the sections that changed. Merges are still judged by the config at their own first parent (the main watch's `requiredAt`), not by the live one.

Settings read once at start to build something that lives as long as the process need a restart: a change to one is applied for everything else, but that setting keeps its running value, and `config.applied` lists it under `restart_needed` (running and wanted values; the log says "restart needed" too). Never half-applied.

| Live (next tick) | Restart only |
|---|---|
| `required_checks`, `protection`, `owners`, `reports`, `hotspots`, `combined_check`, `conflicts`, `corrections`, `gardener`, `optimize`, `research`, `metrics`, `agent_runtime.run_windows` | `project.name` (service label, slots, state), `project.repo` (the token's scope), `project.default_branch` (the push guard and hooks) |
| `land_mode: direct` to `pr` (a tightening) | `land_mode: pr` to `direct` (the start-up protection gate and the hooks that allow the land) |
| agents.yaml, guardrails.yaml, review.yaml, deploy.yaml, app.yaml, benchmarks.yaml, `roles/*.md` | `backlog` (the backlog client), `agent_runtime.kind` (the agent runner) |
| tests.yaml except the two on the right | `tests.worktree.root` (where worktrees and the pool live), `tests.test_run` (the sandbox set up and checked at start) |

Instance-level files (`instance.yaml`, `credentials.yaml`, `intake.yaml`, ports and OS users) are not in the repo and are unaffected; `policy.yaml` is read on its own as before. Still read from the checkout: a review.yaml `money_path_source` file (a project file, not `.worklane/`), and the dashboard process's own copy of the config, loaded at its start.

Precedence: engine defaults < project `.worklane/` < machine-local `~/.config/worklane/<repo>.yaml`. The local file holds things that differ per human: their GitHub token reference, their machine's slot cap, and their dashboard port. Secrets are never in YAML; config holds only env var names or keychain references.

### agents.yaml (example)
```yaml
stage: 1
daily_budget_usd: 40            # usage guard on estimated cost, whichever runner is used
roles:
  chief_of_staff: { enabled: true,  model: sonnet }
  pm:             { enabled: true,  model: haiku }
  workers:        { enabled: true,  count: 2, max: 6, model: sonnet, hard_issues_model: opus }
  evaluator:      { enabled: true,  model: opus }
  security:       { enabled: false, model: opus, applies_to: [money-path] }
  researcher:     { enabled: true,  model: sonnet, max_per_day: 10 }
  red_attributor: { enabled: false, model: haiku }
  ci_repair:      { enabled: false, model: sonnet, max_fixes_per_pr: 2 }
```
- Model aliases (`opus`, `sonnet`, `haiku`) are resolved to full model IDs when a run starts, and the full ID is recorded in the event log so runs are reproducible.
- A role with `enabled: false` is never spawned. Turning one on or off from the dashboard is a config edit that lands through review level L3, because it is harness config.

## 5. Event log

- **Storage.** `node:sqlite` in WAL mode, behind a small data-access layer, so better-sqlite3 can replace it. One database per coordinator, at `~/.local/state/worklane/<owner>/<repo>/events.db` (the platform equivalent on each OS).
- **Schema.** `events(id INTEGER PK, ts, type, actor, subject, run_id, payload JSON, source)` is **append-only**. The dashboard, reports, scorecard and inbox are **projections**: tables or views rebuilt from events, and deleting one and replaying gives the same result.
  - `subject` is `issue:123`, `change:<id>`, `run:<id>` or `deploy:<sha>`.
  - `source` is `coordinator`, `github` or `agent`.
- **Event types** (closed, typed union):
  - Claims: `issue.claimed` and `issue.claim_lost`.
  - Contract: `contract.proposed` and `contract.agreed`.
  - Runs: `run.started`, `run.heartbeat`, `run.finished`, `run.killed` and `run.cost`.
  - Changes: `change.proposed`, `check.result`, `eval.verdict`, `review.level_set` and `change.queued`.
  - Landing and deploys: `land.batch_started`, `land.result`, `deploy.requested`, `deploy.verified` and `deploy.failed`.
  - Decisions: `decision.asked` and `decision.answered`.
  - Guardrails: `guardrail.blocked`, `guardrail.asked` and `network.domain_requested`.
  - Other: `lesson.proposed`, `stage.changed`, `baseline.recorded` and `github.*` (normalized from GitHub).
- **Secret safety.** Every payload goes through the redaction scanner before insert (see §12.3). The log never holds raw transcripts, only references to transcript files, which are scanned separately.
- **Reconciliation.** On start, and every N minutes, the coordinator reads issues, labels, assignees and claim refs from GitHub. It emits `github.*` events for any differences and fixes its own projections. Where they disagree, GitHub wins.
- **Backups.** Hourly `VACUUM INTO` a snapshot, then copied to a configured destination.
  - **Success is only reported after reading the copy back and comparing its checksum and its latest event id.** This is a day-one regression test (§17).
  - Optional off-machine push (e.g. to a private git branch or a bucket) is verified the same way: a remote read-back, not the exit code.

## 6. Backlog and ownership

- **Tracker:** GitHub Issues on the project repo, through a `backlog` adapter: `github`, or `file` for tests and the example project.
- **Labels** are created in step 2 by `worklane install --labels`:
  - Status: `triage`, `ready`, `agent:working`, `in-review`.
  - Flags: `needs:decision`, `money-path`, `blocked`.
  - Size: `size:S`, `size:M`, `size:L`.
  - `review:L0` through `review:L3`, set by code and displayed.
- **Actionable rule.** An issue is actionable only if:
  - a writer opened it, or a writer added `ready`; and
  - the writer is checked against the repo's collaborator permissions at that moment, *and* against `owners.writers` in config.
  - Issues from outsiders stay in `triage`. The coordinator never reads an untrusted issue body into a prompt without sanitizing it, following the gh-aw integrity filter.
- **Brief.** An issue may link to a spec document in the repo. That doc is the detailed spec and the issue is the tracking record. Existing spec docs don't need migrating; only new and active work goes into Issues.
- **Owner + delegate (Linear model):**
  - The GitHub **assignee** is the human owner.
  - The agent delegate is recorded in the claim and shown as a label `agent:working` plus the claim comment.
  - Defaults come from `owners.yaml`, mapping paths or labels to people; anything unassigned defaults to a configured default owner.
  - Decisions route to the owner's Inbox.
- **Claim protocol.** It must work with two coordinators, one per human, on the same repo.
  1. Select candidates: `ready` and not `agent:working`, ordered by priority, then age.
  2. **Atomic step:** create the git ref `refs/worklane/claims/issue-<n>` pointing at a lease commit whose message is JSON `{instance, run_id, worker, expires_at}`.
     - Ref creation is the only compare-and-swap GitHub offers: the API returns 422 if the ref exists.
     - On 422, back off with jitter and choose another issue.
  3. The winner adds `agent:working`, sets the assignee to the owner if it's empty, and posts the claim comment.
  4. **Re-read** the ref and labels. If the ref's lease isn't ours, release our labels and back off.
  5. **Heartbeat:** renew the lease by pushing with `--force-with-lease` against the previous SHA. An expired lease can be taken by compare-and-swap; only one taker wins.
  6. **Release** after landing or abandoning: delete the ref by compare-and-swap and clear the labels.
  7. The reconciler fixes drift between labels and refs. **The ref always wins.**
- **done_when contract.**
  - It is a fenced block in the issue body:
    ```done_when
    - test: test/test-foo.js        # must pass
    - repro: true                    # evaluator writes a failing repro first
    - command: npm test -- --changed # must exit 0 (no new failures vs baseline)
    - manual: "screenshot of the changed page read and described"
    ```
  - The PM drafts it, and the owner (or the chief_of_staff, for L0/L1-eligible sizes) agrees it, which emits `contract.agreed`.
  - **No agreed contract, no build:** the scheduler doesn't claim the issue.
  - `manual:` checks make the change at least L2.

## 7. Coordinator

- It is a long-running service installed by `worklane up`: a launchd, systemd or WSL unit with restart-always. **It does not depend on any Claude session.** The dashboard, scheduled reports, backups and deploy checks are all timers inside it. That gives it no session-bound watchers (regression test §17).
- **Task state machine**, checkpointed to SQLite on every transition, so a crash resumes from the last state.
  ```
  ready → claimed → contract → planning* → building → proposed → evaluating
        → leveled → (awaiting_approval) → queued → landing → landed
        → deploying → done
  failure edges: → requeued (attempt+1, ≤ max_attempts) | → blocked (needs:decision) | → abandoned
  * planning (plan mode) is required for size:M/L
  ```
- **Tick loop.** This follows Symphony and Sortie.
  - Each tick runs **reconcile → validate → fetch → sort → dispatch**, up to the free slots.
  - Ordering is priority, then age, then issue number.
  - Before *every* dispatch, it re-reads the issue's state on GitHub. Closed or landed work is never re-dispatched after a restart.
  - Retry backoff is `min(10s·2^(n-1), 5m)`.
  - Every run ends with a typed terminal reason: `succeeded`, `failed`, `timed_out`, `stalled`, `rate_limited`, `canceled_by_reconciliation` or `budget_exhausted`.
- **Facts that survive a crash** (from the failure modes reported in prior-art.md):
  - The pid, process group, worktree and lease are written to the log **before** an agent process is spawned.
  - Reaping is by process group; processes are never matched by name.
  - On startup, the coordinator reaps orphans from its own recorded pgids and cleans the worktrees of terminal tasks.
  - A rate-limit or usage pause is classified first and is not treated as a stall.
  - A run that hits the Claude usage limit ends at once (never retried) and pauses the instance until the reset time claude names (else a 5-hour default): no run starts, the task is requeued rather than failed, one notice goes to the asks channel and the dashboard, and the pause ends on its own at the reset. An open-model provider's limit only skips that provider until its reset; the run is redone on its fallback (src/usage-limit.ts).
  - The done_when contract and base SHA are stored on the **task**, not the attempt, so a retry can't lose them.
  - The coordinator enforces **evaluator ≠ author**, including in any recovery path.
  - Wakeups from bulk issue edits are debounced and coalesced.
- **Pinned base and verified SHA.** These follow Orbi and pstack.
  - A task records `base_sha` when it is claimed.
  - The evaluator's verdict is bound to the exact patch hash. If the patch changes, it is re-evaluated.
  - The land queue lands only verified patches.
- **Tamper guard and scope.** These follow no_human and StuCM/pit-crew.
  - Before evaluation, code counts deleted, skipped and weakened tests in the diff (`.skip`, `.only`, removed assertion calls). Any such test raises the review level and is shown to the evaluator.
  - A task may declare `files:` scope. Diffs outside that scope are flagged.
  - `collisions` lists unlanded changes that touch the same files.
- **Agent runs** go through an `AgentRunner` interface with two implementations:
  - **`cli`** (default): spawns the locally installed `claude -p --output-format stream-json` with the user's existing auth and `--setting-sources project`.
  - **`sdk`**: the same CLI, authenticated with `ANTHROPIC_API_KEY` (passed through to the run). There is no in-process SDK runner.

  Both runners use the same settings:
  - `settingSources: ['project']`, so user-level plugins and hooks never load inside agent sessions.
  - **An instance's guardrail hooks and rules are for its agent runs only.** `install --instance <name>` (run by `checkout.sh` on every run) writes them to `agent-settings.json` in the coordinator's instance home (0700; the agent user can't read or change it). The runner reads it for every run and passes it with `--settings`, merged with the lane's sandbox. The repo commits no `.claude/settings.json`, and people's own sessions in it don't get the hooks. Claude Code ranks `--settings` above local and shared project settings (only managed settings rank higher); lists such as deny rules merge, and a deny from any source wins; hooks merge, so a project can add hooks but not remove ours. Two things a project file could still do are closed off: `disableAllHooks` is read after precedence, so ours pins it to `false`; and a project's `env` is applied over the process environment (hooks included), so the run's harness variables are pinned in `--settings` and a project file that sets `env`, adds allow rules beyond ours, or sets anything but hooks and permission rules refuses the run. No agent settings: the run doesn't start, and neither does the coordinator; the error names the `install --instance` command. Claude Code drops a whole `--settings` over one invalid value, deny rules and hooks included, without a word (#626), so every `--settings` carries a check value made for that run (in `outputStyle`), and the run stops, naming the settings, unless claude's init event reports that value back before any line but a system one; a session that ends without confirming it fails, and nothing it sent before is passed on. Hooks in a checkout's own `.claude/settings.json` never stand in for them. While a run goes on, agents can't write anything under `.claude/`, or anything in the config folder but `roles/` and `skills/` (their own instructions, which they may change; such a PR is always high-risk and never auto-merges, a built-in review category no review.yaml removes): those paths are protected for every project, whatever its guardrails list, for edit tools and for shell writes (redirects, `tee`, `cp`, `mv`, `sed -i`, `rm`, ...).
  - A per-harness `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and `strictMcpConfig`.
  - An explicit `permissionMode`, never left to default to auto.
  - `maxBudgetUsd` per run and `maxTurns`.
  - Pre-approved safe commands come from config, so agents don't stall on prompts. They are passed as `--allowedTools` on every run. Verified 2026-10-07: a headless session in an untrusted directory (every new worktree) ignores `permissions.allow` from project settings, while hooks still run.
  - The full model ID, `total_cost_usd` and `modelUsage` are recorded as `run.cost`.
- **Environment scrubbing.** Agent processes get an allowlisted environment.
  - Removed: `GH_TOKEN`, `GITHUB_TOKEN` and any `*_TOKEN` or `*_KEY` not on the allowlist.
  - The project's `.env` is not in a worktree.
  - Deploy-platform CLI auth can be passed to roles that need staging access. A production DB credential is never passed (§12.1).
- **Safe outputs** follow the gh-aw spec. Agents call a localhost MCP tool, `propose`, that schema-validates and appends NDJSON. They hold no GitHub token.
  - **Proposal types:** `propose_change` (a git bundle against `base_sha`), `add_comment`, `add_labels`, `create_issue`, `ask_decision`, `report_blocked`, `propose_lesson`, `noop`.
  - **Validation pipeline:**
    1. Check the schema; the enum is closed and extra fields are rejected.
    2. Apply per-type maximums per run.
    3. Sanitize: NFC, zero-width and control characters, mention neutralizing, protocol and domain allowlist, truncation.
    4. Check the target is the claimed issue.
    5. Apply patch policy: size limits and protected paths.
    6. Run gitleaks on the diff.
    7. Apply the change.
  - Every validation decision is an event.
- **Worktrees:**
  - One per worker, at a configurable root (e.g. `.claude/worktrees/worklane-<n>`).
  - **The coordinator only ever touches worktrees it created**, tracked in the log. Other sessions' worktrees are never listed or removed.
  - Project setup steps come from `tests.yaml` `worktree.setup`. Typical steps: symlink `node_modules`, run code generators, install sub-package dependencies.
  - Every worktree is a `git worktree add` of the instance's one checkout, so all of an instance's agents share one object store: starting a task copies no history.
  - `tests.yaml` `checkout.sparse_exclude` lists directories no agent or test reads (design files, art): they are left out of every agent worktree and test-run workspace (sparse checkout), never out of the repo. A test-run tier that needs them sets `full_checkout: true`. Test runs share an object store of their own per instance (docs/test-runs.md): each run is sent only the objects the store lacks.
  - With `worktree.pool`, worktrees wait on main with setup done. `worktree.setup_key` names the files that pin what setup installs (the lockfiles, an ORM schema): when main moves and none of them changed, a pooled worktree follows main by a checkout in place and keeps its install, instead of being set up again. Each is set up on main only and handed to one task, never back, so no task's change reaches another's dependencies.
  - A worktree is deleted right after landing or abandonment, and deletion is verified by `git worktree list` plus a path check.
- **Watchdog:**
  - A run with no event or tool call for `stall_minutes` is killed and requeued.
  - Per-run, per-role and daily budgets. When the daily budget is hit, nothing new starts; running work finishes or is checkpointed. Spend is visible on the Agents page.
  - `max_attempts` per issue, after which it becomes `blocked` with a decision for its owner.
- **Auth.** There is no sign-in flow for agents; the harness never handles their credentials. (People sign in to the dashboard hub with GitHub; their role per instance is their permission on its repo: docs/dashboard.md. Every action, machine changes included, needs a live session (it ends after 12 hours idle or 7 days), never a recent sign-in; machine changes also need one of the machine devices, `dashboards.sh --machine-devices`.)
  - The `cli` runner uses whatever auth the user configured for Claude Code.
  - The `sdk` runner uses `ANTHROPIC_API_KEY`.
  - Budgets track estimated cost either way, from `total_cost_usd`.
  - Terms for unattended subscription use are reviewed in `docs/auth.md` before step 2.

## 8. Roles

| Role | Step | Context / tools | Output |
|---|---|---|---|
| worker | 2 (1), 4 (N) | its worktree, read/write | `propose_change`, lesson |
| evaluator | 2 | **fresh context, read-only**, clean worktree at `base_sha` | frozen repro test, verdict `{patch_correct, test_correct, confidence, confidence_reason, advice}` (plus `compromised_component` for a change to a protected surface) |
| pm | 2 | read-only + issue tools | issues with done_when, size, dedupe |
| chief_of_staff | 5 | read-only, the event log | routing, reports, decisions (only real ones) |
| researcher | 5 | open web (WebSearch/WebFetch only) minus a domain blocklist, daily caps; no repo access unless the instance's owner turns it on (then read-only) | a report with every source linked, as an issue comment or a docs/research/ PR |
| red_attributor | 7 (first job: green main) | read + test runner | culprit commit via bisect over the baseline |
| security | 7 | read-only, `money-path` changes | verdict, blocks landing until clean |
| ci_repair, qa_playtester, monitor, release_prep | 7 | per role | per role |

**Researcher** (changed from the allowlisted web above, by the owner's decision). The web is open through Claude Code's WebSearch and WebFetch only: no Bash (so no shell network), no write tools, no MCP, no credentials. A per-repo domain blocklist (`config.yaml` `research.domain_blocklist`) refuses fetches; daily caps on searches, fetches and estimated spend are instance settings. Every search and fetch is recorded and shown on the run page. Web content is untrusted data: a run's tools are fixed before it starts, and its output is taken only as a report and its sources (anything else it returns is dropped). Repo access is an instance setting, **off by default**: off, the run's working directory is a per-run context bundle the coordinator writes (the issue text and questions, redacted; beside the checkout, readable by the agents' group only), and its lane denies every read of the checkout, its worktrees and the instance's task and chat files (sandbox and Read/Glob/Grep rules, plus the engine hook in research mode); on (meant for public repos), it reads the repo read-only. Triggered by a `type:research` or `type:investigation` label, or a ```research block in an issue.

**Evaluator flow** (Agentless + AutoCodeRover/SpecRover + ECC tdd-workflow):
1. Without seeing the patch, write K candidate reproduction tests (3 to start).
2. Keep only those that **fail on base for the right reason**: an assertion failure, not an import or setup error. Majority-vote one and freeze its hash.
3. The worker can read the frozen test but can't change it; it is a protected path.
4. Run on the patched code: the repro test, the regression tests that passed on base, the done_when checks, and, at nightly or for money-path changes, Stryker on the changed lines.
5. The verdict can say the *test* is wrong. Allow at most 2 feedback rounds, then the issue is blocked.
6. If no repro is possible (docs, UI copy), the evaluator records `repro: not_applicable` with a reason. That sets the review level to at least L1.
7. Optional cross-family verdict (`routing.eval_cross_family`, off by default): on a protected change the evaluator approved, a hosted provider's model (another model family) gives a second verdict through the usual provider checks, read-only, never on Anthropic in its place, and never for a change touching held-out eval cases or secrets. If the two disagree (one approves, one rejects, or high against low confidence) the change waits for a human with both reasons. It can only add a hold.

## 9. Review levels

- The level is computed by code from:
  - paths touched (globs)
  - lines and files changed
  - labels
  - change type: migration, dependency, config, test-only, docs-only
  - the evaluator verdict and its confidence
- **The highest matching rule wins.**
- A failed or uncertain verdict bumps the level up by one.
- An agent can raise its own level, never lower it.
- The result and every reason are stored in `review.level_set` and shown on the dashboard.

Example (`review.yaml`):
```yaml
money_path_source: { file: <path to the project's own list> }   # single source of truth; never duplicated in config
levels:
  L0_auto:      { when: [docs-only, tests-only, comments, copy], max_lines: 200 }
  L1_evaluator: { when: [ui, app-non-money], max_lines: 400, max_files: 10 }
  L2_notify:    { when: [app-non-money-large, dependency, test-machinery] }
  L3_human:     { when: [money-path, migration, auth, secrets, deploy-config, release-config,
                         harness-config, guardrail-config, deletes-data], over_lines: 800 }
```

- **Categories** are path globs: built-ins (docs, tests, dependency, harness-config, ...) plus any a project names under `categories:` in review.yaml (a same-named one replaces the built-in). Levels list categories in `when`. A category listed for L1 raises a change that would otherwise be L0, e.g. `L1_evaluator: { when: [docs] }` for a site whose docs are its product.

How each level is cleared:

| Level | What it needs |
|---|---|
| L0 | checks pass |
| L1 | plus an evaluator pass |
| L2 | plus the owner is notified (Inbox and report) and can revert |
| L3 | a Decisions card; the owner's approval releases it into the land queue (direct mode) or counts as the PR review (PR mode) |

- **Trust stages move the thresholds.** A promotion (e.g. bigger UI changes allowed at L1) is a decision the owner approves. A metric regression demotes automatically, and that is an event.
- A project can start from its current practice. A team where agents already land their own changes can start at L0–L2 instead of "humans merge everything".

## 10. Land queue

- **Modes:**
  - `land_mode: direct`: the coordinator fast-forward pushes to `main`. A plain non-force push is itself a compare-and-swap: it is rejected if `main` moved. **Only on a protected branch** (the owner's decision; `src/direct-land.ts`): the harness pushes the branch itself and the main watch is off in this mode, so on a branch GitHub doesn't protect nothing would stop a bad push. At start-up the coordinator asks GitHub with the main watch's own protection check. No protection (403 or 404, as on a private repo on GitHub Free): it refuses to start, with `instance <name> not started: land_mode: direct pushes <branch> itself, and <repo> has no branch protection, so nothing would stop a bad push; use land_mode: pr, or turn on branch protection`. A check that fails (an error, the network down) fails closed: it refuses too, saying the protection couldn't be checked. Protected: it starts. The refusal is printed and recorded (`coordinator.error`, where `start-up`, kind `direct_land_refused`), so the dashboard lists it and health says it first, until a coordinator starts. Every direct land asks again, before its gates and right before its push: protection removed while running means nothing is pushed, the queue waits (`land.result` deferred), and the refusal is recorded once (where `direct land`) until a land goes through once protection is back. A remote that is a local path (a bare repo on disk) has no protection to ask about and lands as before; any other remote without GitHub access refuses.
  - `land_mode: pr`: PRs are opened by the coordinator's identity. When the org has Enterprise Cloud, it can hand off to GitHub's native merge queue; the native queue isn't available on private Free/Pro/Team repos.
- **Only the coordinator pushes.** Agents can't.
- **Never a push to the default branch (PR mode).** The harness merges through GitHub's merge API, never by a push. A push to `refs/heads/<default>` is refused, and recorded as `push.blocked`, in two places: `checkedPush` (the coordinator's only push path) refuses it before anything else; and git's pre-push hook refuses it, both in the checkout's hooks dir (`install --git-hooks-only`, which `checkout.sh` runs; root-owned there, not agent-writable) and in the coordinator's own hooks dir in its instance home (0700), which its git environment points `core.hooksPath` at (it runs none of the checkout's hooks). The hook also refuses whatever `origin/HEAD` names. The one exception is `land_mode: direct`, whose landing is a fast-forward push of the default branch by design: that push alone is let through `checkedPush`, and the coordinator's hooks dir then has no pre-push hook, and only while GitHub protects the branch (above).
- **Main watch (PR mode, per instance).** It is off in direct mode, where an unprotected branch isn't allowed at all (land modes, above). For a default branch GitHub doesn't protect (a private repo on GitHub Free, where protection and rulesets return 403): on by default when the protection API answers 403 or 404 (`policy.yaml` `main_watch: auto`; `off` turns it off), and re-asked every 6 hours. On the coordinator's timer, with at most one API call a minute (its time kept in the state file, so it holds across restarts), it checks every new first-parent commit on the default branch. A commit is accounted for if it is (a) the harness's own merge (`merge.done`) of a head whose `required_checks` were green when it merged, or (b) a merge of a PR by a mapped admin or writer (their role from their repo permission, as the dashboard reads it), with `required_checks` green on the PR's head at merge time (a check that finished, or was re-run, after the merge doesn't count). Anything else is unaccounted: a direct push, a merge with failing, missing or pending checks, an unknown actor or a bot, a rewritten history. Which PR a commit is the merge of is GitHub's answer, never inferred from git history: the commit-to-PR link (`GET /repos/{o}/{r}/commits/{sha}/pulls`), asked again for up to 2 minutes (`LINK_LAG_MS`) while it has no merged PR, since GitHub links a merge a few seconds after it lands; the PR's `merge_commit_sha` (also for a merge commit whose subject names the PR, before the link exists); and for a commit inside a rebase merge, `GET /repos/{o}/{r}/compare/{sha}...{merge_commit_sha}` ahead by fewer commits than the PR has. Git reads only the branch itself: its tip, whether it was rewritten, its first-parent line, and the config committed at a commit. Then, once per commit: auto-merge stops at once (the stop file, `merge.stopped`), the dashboard shows an alert on every page and the asks channel gets one notice (`main_watch.unaccounted`: the commit's link, why, the revert PR; no secrets), and a revert PR opens for a human (within the caps below), which the merge policy never auto-merges (a revert branch, and a PR the harness didn't open, always wait: `neverAutoMerge`). Only an admin's clear on the dashboard resumes auto-merge (`auto_merge.cleared` in the audit, `merge.resumed`). The last checked commit is kept in `main-watch.json`, so a restart neither checks a commit again nor skips one. The Machine page shows the mode ("GitHub enforced" or the main watch) and the last commit checked; a viewer sees the mode only. Without `required_checks` it is off, with the reason. **Bootstrap merges:** while a project's required check can't run yet, an admin's hand merge would be unaccounted. An admin accepts it first on the Machine page (`POST /api/main-watch/accept`, admins only like the clear, every attempt audited, refusals too): by sha, a commit on the branch's first-parent line after the last one checked (or the one being checked); or in advance by PR number, pinned to the PR's head then (`refs/pull/<n>/head`), so the merge of that PR at that head counts however it was merged (merge commit, squash, rebase: GitHub's own commit-to-PR link, as the watch already reads it), and a push to the PR after needs accepting again. Refused: a branch rewritten since the last check, a commit not on the branch or off its first-parent line, one already judged. Acceptances are kept in `main-watch-accepted.json` beside the state file (the dashboard writes it, the watch only reads it), each with the last commit checked when it was made, so a rewrite voids it. The watch counts an accepted commit accounted (`how: accepted`): no stop, alert or revert PR. Accepting never clears a stop. **Direct pushes:** a commit that landed without a PR at all (GitHub's commit-to-PR link, `GET /repos/{o}/{r}/commits/{sha}/pulls`, has no merged PR for it; or a force-push rewrote the branch) is also posted to the Discord ops channel at once (`src/direct-push-alert.ts`), before the revert PR is made: the sha, who pushed it (the push's GitHub login from the repo's activity, else the commit's GitHub author; never an email), its subject, and a link to the Machine page's main watch (`/machine#main-watch`). It mentions intake.yaml's `discord.owners` mapped in `discord.people` (the adapter pings only them, only in the bot's threads or the ops channel); with none, it posts without a mention and the Machine page says why. One post per commit, within the machine-wide limit of ops posts (the watchdog's); over it, it waits for the next pass. `config.yaml` `main_watch.direct_push_alert: false` turns it off, read as committed before the push so a push can't turn off its own alert. **Revert PR caps:** a trip is the unaccounted commits of one pass (those between the last commit checked and the tip at one fetch, kept in the state file across a restart) with the same reason; a direct push's reason names its own commit, so it is a trip of its own. A trip opens at most `config.yaml` `main_watch.revert_prs_per_trip` revert PRs (default 1), and an instance's main watch at most `main_watch.revert_prs_per_day` in any 24 hours (default 3), counted from the event log, so both hold across a restart. Both are at least 1 and are read as committed before the pass, so no commit in it changes its own cap. Past a cap the commit is still judged, still stops auto-merge and still alerts; the alert says which cap (`no_revert`: for a trip, its revert PR and its commits so far), and so does the asks channel's notice. A commit of a rebase-merged PR (its PR's `merge_commit_sha` a later commit) gets one revert of the PR's commits from it through that one, in one commit (`revert_through`), when they are a straight line of single-parent commits on the tip, no more than GitHub says the PR has (and at most 250); otherwise it is reverted alone. Reverting each commit alone on the tip conflicts when a later commit of the PR edits the same files. The trip's later commits that revert covers say so and open none. Whenever there is no revert PR, `no_revert` says why: a cap, a covering revert, a rewrite (nothing to revert), or why opening it failed (`git revert` conflicts with later commits, naming the files; the push checks refused it; the error). A failed revert never suppresses the stop or the alert, and doesn't count toward a cap, so the trip's next commit tries again. **Dead checks:** a required check with no run or status on the head of any commit judged for `main_watch.dead_check_days` (default 7) is raised once (`main_watch.dead_check`): on the Machine page and once in the ops channel, saying merges keep tripping the watch until it posts or leaves `required_checks`. It clears, with one more ops post, when a run of it appears or it is no longer required. Before it is raised, the watch reads the repo's Actions workflows once (`GET /repos/{o}/{r}/actions/workflows`, one of its calls, under the limit): when a workflow that would post the check is disabled (`state` `disabled_manually`, `disabled_inactivity` or another `disabled_*`; one named as the check, whose file is named so, or whose file as committed, up to 256 KiB, has a job that posts it; a job name of only `${{ … }}` posts nothing) and no active workflow would post it too, the warning carries it (`workflow` on the event) and the Machine page says which workflow and why it is off. It is read again only once per dead window while the check stays dead (the Machine page's note). A 403, a 404 or any error says nothing more, and judging and the stop never wait on it. Events: `main_watch.mode`, `main_watch.checked`, `main_watch.accepted`, `main_watch.unaccounted`, `main_watch.direct_push`, `main_watch.direct_push_alert`, `main_watch.dead_check`.
- **Branch protection: not strict by default.** Where GitHub can protect the default branch, the harness recommends requiring the `config.yaml` `required_checks` and **not** requiring PRs to be up to date first (a ruleset's `strict_required_status_checks_policy: false`, or classic protection's `strict: false`). `protection.strict: true` opts one repo in. It is advice only: `worklane init`'s Protection step reports it (`src/branch-protection.ts`), and nothing in the engine calls a protection API to set it. The trade-off: strict makes every PR merge main in and rerun CI each time main moves, so PRs queue behind each other. Without it, a PR can merge green on a slightly older main, and post-merge CI on the default branch, the check of main after each auto-merge, the combined check before it (`combined_check`) and the main watch catch the rare semantic conflict, faster than strict would have prevented it. On a plan where GitHub gives no protection (a private repo on GitHub Free, where rulesets return 403), the main watch is the guard either way.
- **PR watch and merge-ready (PR mode).** PRs open as drafts (an ordinary PR where the repo has no drafts). Each tick the coordinator polls a few of its open PRs, each at most once a minute: the PR's head, and the check runs and commit statuses on it. A PR is **ready** only when every check in `config.yaml` `required_checks` passed on the exact commit the evaluator approved, and the evaluator approved it. Missing, pending, cancelled, skipped and neutral checks are not passes, and with no required checks configured nothing is ever ready. **A pinned check counts only from its source** (#727, `src/check-source.ts`): `config.yaml` `required_check_sources` pins a name to the GitHub App that posts it (`app_id`) or the Actions workflow file that runs it (`workflow`: its run in this repo, for this very commit, the check run one of that run's own jobs); a name not listed takes the App GitHub's branch protection or ruleset requires for it. Any other same-name check, and every commit status, is missing for a pinned name, and a same-name check from any source that isn't a pass still blocks it: pinning only ever turns a match into missing. A name nothing pins is judged by name, exactly as before (the owner's choice, so an existing install keeps working); `doctor` names those. Gating PRs nobody here wrote is governance mode's job (#704): it refuses to turn on while any required check has no pin (`governanceRefusal`). The check of main after a merge, fix-forward, the fast checks and the main watch judge the same way: every judging function takes `JudgedChecks`, which only `PinnedChecks.of` makes. Ready means out of draft and labelled `merge-ready`; a head that moves afterwards (someone pushed) takes the label off. Every change is an event (`pr.opened`, `pr.status`, `pr.ready`, `pr.unready`, `pr.closed`; `pr.stats`, the PR's lines added and removed, files and comments as GitHub reports them, whenever they change). It needs the GitHub App's Checks: read permission (statuses are read when the credential allows).
- **Instance settings: which config wins.** For everything else the repo's `.worklane/` decides, and the instance policy can only tighten it. For exactly these knobs, the instance's `policy.yaml` `settings` win over the repo, whose values are the defaults:
  - worker count (`workers`)
  - daily budget (`daily_budget_usd`)
  - CI fix runs (`ci_repair.enabled`, `ci_repair.max_fixes_per_pr`)
  - run windows (`run_windows`), which dispatch now enforces: outside them no new work starts

  **Bounds.** They come from a machine-wide, root-owned `/etc/<cli>/limits.json` (engine defaults without one: 1-8 workers, a $100 budget ceiling, at most 5 fix runs per PR), plus the policy's own `max_workers` and `budget.daily_usd` ceilings. A value outside them is refused, not clamped. A broken limits file refuses every change rather than falling back.

  **Pick-up.** The coordinator re-reads the policy on every tick when its mtime or size changes, so a change applies without a restart (`settings.applied`). Refused settings fall back to the repo's values, with the reason in the event.

  **Changes.** Only through `changeSetting` (src/settings.ts), which the instance's own dashboard calls. Only the owner (`owners.default`) may change a setting. The value is checked against the schema and the bounds; policy.yaml is written atomically (temp file beside it, same owner, mode 0600, rename) with its comments kept; and `settings.changed { key, from, to, by, at }` goes to the instance's event log. Reports list each change.
- **Auto-merge (PR mode).** The harness may now merge its own PRs, under a policy. The instance's `policy.yaml` `auto_merge` is the kill switch (default off; read at every decision), and `review.yaml` `merge` can only narrow it. A ready PR (see PR watch) **waits for a human** if any of these holds:
  - high-risk: an L3 category, `ci-config`, or the repo's `merge.wait_categories`
  - design-level: the evaluator's `design_change` flag, which is binding; dependency manifests; a new top-level module
  - big: over `merge.max_lines` (800) or `merge.max_files` (20)
  - doubt: confidence below high, a failed or uncertain verdict, no design answer, a CI fix run on the PR, a push by anyone but the harness, or a push-limit hit
  - GitHub can't merge it cleanly

  A waiting PR gets `needs-owner`, one comment (the review packet) and a review request, so GitHub notifies the owner, who reviews from a phone if they like. The packet is sized for a phone: on top, at most 1,200 characters, every reason it waits (as many as fit, each cut to one line, the rest counted), the risk class, the evaluator's verdict, the instruction eval scores and a receipts summary; below, a collapsed "Full details" section with the whole of each. It is posted once per head and decision, decides nothing and adds no way to approve. Code: `src/coordinator/review-packet.ts`. Otherwise it is merged with a merge commit (never squash), pinned to the evaluated head. After each auto-merge the harness watches the default branch's required checks on the merge commit. If they go red while the commit before was green, it stops auto-merging on the instance (a stop file that survives restarts, cleared only by an admin on the dashboard, audited, or by the operator), opens a revert PR (never watched, so never merged by the harness, never reverted) and asks the owner. If main was already red before it, it stops and tells, without a revert. The first report of each day lists the last 24 hours of auto-merges with links. Events: `merge.decided`, `merge.done`, `merge.failed`, `merge.main_result`, `merge.stopped`, `merge.resumed`.
- **Review rules for agent PRs (`src/pr-rules.ts`, part of the merge policy).**
  - **Intent and risk class.** Every agent PR body starts with a one-paragraph intent (`**Intent:** ...`: the worker's `intent`, or the first paragraph of its summary when it gave none) and then a risk class (`**Risk class:** docs-only | logic | protected`, with why). The class is computed from the changed paths. **protected**: the change touches a category the merge policy always leaves to the owner (`whyHighRisk`: review.yaml's L3 list, `ci-config`, `merge.wait_categories`, the money-path config, and the locked `self-modification` and `agent-instructions` categories, which cover auth, secrets, CI workflows, setup scripts and the merge rules; the locks that name the engine's own source paths stand aside only for an instance root names as a managed app, with its repo, in `/etc/<cli>/managed-apps.json`, and apply wherever that file is missing or unreadable). **docs-only**: every file is `*.md` or under `docs/` (protected wins: `AGENTS.md` is protected). **logic**: anything else. The worker's `risk_class` can raise it, never lower it, and a worker's `protected` makes the merge wait for the owner. Before the PR opens, a validator (`prBodyProblems`) refuses a body without the intent, without the class, or with a class lower than the computed one: no PR opens, the land result is `rejected`, and the issue is blocked with the reason.
  - **Size limit.** `review.yaml` `max_pr_lines` (default 600). Counted: added plus removed lines of `git diff -M -U0 base..head`, without lockfiles (`LOCKFILE_GLOBS`) and the `generated` globs (default: minified files, source maps, `dist/`, `__generated__/`, `*.generated.*`, snapshots). A pure rename counts 0 (rename detection). Over the limit, the change is **mechanical** when, with all whitespace taken out of each line and blank lines dropped, its added lines are exactly its removed lines across the whole change: renames, moves (code moved to another file, even reformatted on the way), reindents and other formatting. One line whose content changed makes it not mechanical. (A per-file `git diff -w --numstat` was not enough: a file renamed and reformatted in one change loses git's rename pairing and reads as all new.) A mechanical change goes on. Any other is sent back to the worker at inspect, before verify, with "split it" and the numbers, like any rejected attempt: the next attempt gets it as feedback, and after the last one the issue is blocked.
  - **Docs-only fast path.** `review.yaml` `docs_only_checks` (default empty: off) names the light checks, e.g. `[denylist, dco, push-gate, scan]`. For a docs-only PR (the computed class, after the worker's claim), the harness's own merge call waits on just those of `required_checks`: the PR is marked ready on them, skips the PR batch, and the merge policy decides as usual. **GitHub's ruleset is unchanged and still requires every required check**, so the merge itself goes through only when GitHub allows it. While GitHub reports the PR `blocked` and a required check outside the light set is still pending or unreported, the harness waits and looks again on the next poll; if one failed or was cancelled, the PR waits for the owner with that reason. A repo gets the full speed-up by making its heavy CI jobs skip on docs-only changes with a job-level `if:` (GitHub counts a skipped job as satisfying a required check; a workflow-level `paths` filter leaves the check pending, so the merge waits). Without that, the fast path still saves the batch run, and a heavy check failing on a docs change doesn't start a CI fix run.
- **Flaky tests (PR mode, per instance).** Before the default branch counts as red after an auto-merge, its failing required checks are re-run once on the same commit (`src/flaky.ts`, `src/coordinator/flaky.ts`): an Actions job by re-running its workflow run's failed jobs (`POST /repos/{repo}/actions/runs/{run}/rerun-failed-jobs`, once per workflow run, after every required check on the commit has finished, since GitHub won't re-run a run still going), a test-run check (tests.yaml `test_run`) by running its tiers again on that commit and posting the checks again. A check is the finest grain: neither GitHub's check runs nor the test-run tiers report single test cases. Passing on the re-run: the check is flaky. It is quarantined, one issue is filed for it (unlabelled, so no agent picks it up; once per check, ever: a later sighting or a second quarantine reuses it), and nothing follows: no stop, no revert, no fix PR (`merge.main_result` green, with `flaky`). Failing again, unable to re-run (a commit status, a tracker without Actions, GitHub refusing it) or not done within `config.yaml` `flaky.rerun_timeout_min` (default 90): a real failure, handed to fix-forward (below). A quarantined check still runs and still reports, red on GitHub when it fails; its failure only no longer turns the branch red for the harness (`merge.main_result` lists it under `quarantined`) and counts as a sighting. It blocks again after `flaky.release_after_passes` (default 10) passes in a row on the default branch (a failure resets the count), or when an owner clears it on the dashboard (Reports, Flaky tests; `POST /api/flaky/clear`, owners only, audited). Never silent: every change is an event (`flaky.rerun_requested`, `flaky.rerun_result`, `flaky.quarantined`, `flaky.sighted`, `flaky.observed`, `flaky.released`), the issue (told when the check is quarantined again or released) and a dashboard row (`GET /api/flaky`, owners and writers: the check, first seen, sightings, its issue, passes toward release). The flake rate there is flaky re-runs over red runs (re-runs that found at least one flaky check, over the red runs that were re-run), over 7 and 30 days. `flaky.rerun: false` turns the re-run off (every failure is real at once). **The updater is untouched:** it still installs only a commit whose every check is green on that exact commit; quarantine never makes a red check green, it only changes the harness's own red/fix decisions. A flaky Actions job that passed on its re-run is green on GitHub because it actually passed there; a quarantined check that fails stays red, and the updater won't install that commit. The main watch and the pre-deploy gate (docs/deploy-gate.md) are untouched too: the watch judges a person's merge by the required checks at merge time, and the gate moves the deploy branch only to a commit whose every tier passed, quarantined or not.
- **Fix-forward (PR mode, per instance).** A real red after an auto-merge (`merge.main_result` red, after the flaky re-run) is fixed forward before anything is reverted (`src/fix-forward.ts`, `src/coordinator/fix-forward.ts`). First the culprit: the candidates are the first-parent commits since the last commit known green (its first parent when that is green; else the newest green post-merge check or recovery the log knows, at most 50 back). One candidate is the culprit. Several (CI cancelled or batched the runs between): each is tested on its own commit, binary search (`src/bisect.ts`, the same step as CI's red-batch bisect in `scripts/ci/batch.mjs`), by the checks already on it, else by the instance's own test runs (the tiers behind the failing checks) or a re-run of its Actions jobs; a candidate that can't be tested in `flaky.rerun_timeout_min` is passed over, and only those left leaves a range, not a culprit. A culprit that touches `config.yaml` `fix_forward.revert_first_paths` (globs), the money path, auth or secrets (the money-path list and review.yaml's categories) is reverted at once. Otherwise a fix task: an issue (labels `ready`, `fix-forward`) with the failing logs, the culprit's diff and the merged PRs, worked like any task (actionable because this instance's log filed it, and first in line); its PR goes through the normal gates, and the culprit is named on it. Until the default branch is green again only that PR auto-merges (the merge train's door, `trainMerge`). A fix task that ends without a PR, whose PR's CI fix runs give up or that is closed, or that merges and leaves the branch red, is a failed attempt; after `fix_forward.max_attempts` (default 2; 0 reverts at once) the culprit's revert PR is opened with the evidence (the bisect, each attempt and why it failed), auto-merge is stopped and the owner asked, as before. No culprit to revert (a range, or no green commit known): auto-merge stopped, the owner told. The ops channel hears "main is red: <checks>, culprit #n" once the culprit is named and "main is green again (fixed by #m / reverted #n)", once each (keys `fix-forward-red:<sha>`, `fix-forward-green:<sha>`), within the machine-wide limit of ops posts (`watchdog/post.ts` `takeOpsPost`, the one limit the incident posts, merge posts and direct-push alerts share). Events: `fix_forward.started`, `.tested`, `.culprit`, `.attempt`, `.attempt_failed`, `.finished` (fixed / reverted / gave_up: the Metrics panel's fix-forward figure), `.green`. The updater is untouched: it still installs only a commit whose every check is green. The main watch's unaccounted commits keep their own stop and revert PR.
- **Instruction evals (`agents.yaml` `instruction_evals`).** A change that touches the agents' own instructions (a skill under `.claude/skills/`, `AGENTS.md`, or a project role prompt in the config folder's `roles/`) is evaluated before it can land, after the evaluator approves it.
  - **The cases:** the instructions' eval cases (a skill's `evals/cases.md`; `evals/AGENTS.md` or `evals/roles/<role>.md` in the config folder; for a role without project cases, the engine's own in `templates/evals/roles/`). They run against the instructions at the base and at the head.
  - **The agent under test:** it gets the instructions as its system prompt and only the situation as its prompt. It never sees the rubric, runs with no tools, and works in a neutrally named temporary directory.
  - **The judge:** a different model (enforced) grades its plan against the case's correct and wrong actions.
  - **Runs and spend:** runs go through the runner like any other: the agent user, the subscription CLI, and the cost counted as `run.cost`. One cap (`cap_usd`, default $5) bounds base and head together. Once it is reached, the rest is "not run".
  - **What it does to the PR:** each target records `instructions.eval`, and the PR body shows base → head scores and the cost. The merge policy waits for the owner, with the cases whose outcome changed, when a score drops, the cap cut an eval short, the instructions have no cases, the evals are off, or the eval couldn't run.
  - **The engine's own prompts:** `node scripts/eval-roles.mjs` runs the same before/after eval on `src/roles.ts` against a base commit, prints the score diff and cost, and exits 1 on a drop. A judge on the model under test is refused before anything runs. With `--fix [n]` (default 3 attempts), a role whose head fails a case gets a fix loop: a fixer proposes a revised prompt from the failing visible cases only (never a held-out case, score or outcome), the proposal is rerun on the visible and held-out cases, and this repeats until every case passes, the attempt cap or `--fix-cap` (dollars per role). An attempt whose held-out score drops is rejected, whatever its visible score did. The report gives the base, the start, each attempt (its diff, scores, cost and verdict) and the best attempt. The loop only proposes: it never edits `src/roles.ts`; the owner applies the diff and reruns the eval.
  - **Nothing spends by default (#612):** every command that can call a paid model (`scripts/eval-roles.mjs`, `scripts/eval-stage-labels.mjs`, `skill eval`, `harness-eval run`) runs only with `--spend <usd>`, the most that invocation may spend in all; it bounds `--cap`, `--fix-cap` and `--budget` and never comes from config. Without it the command prints its plan (what it would run, the most it could spend) and exits 2, before any model call, held-out read or state write. Held-out cases (and harness-eval held-out tasks) are read only from a store named on purpose: `WORKLANE_HELD_OUT_DIR`, or `--held-out-from-state` for the one in this machine's state; without either, `eval-roles.mjs` scores the visible cases only and says so (the verdict still needs held-out scores), and `--write-held-out` is refused. The coordinator's scheduled harness evals don't go through these commands: the owner's config is their opt-in. Example: `node scripts/eval-roles.mjs --roles worker --score --spend 10 --held-out-from-state`.
- **CI fix runs (PR mode, `agents.yaml` `roles.ci_repair`).** When a required check fails on the head the harness last pushed, the coordinator reads the failing job's log (Actions: read), reclaims the issue and runs a worker in a worktree at the PR's head with the log in its brief. The fix goes through the same inspect (push limits included), verify and evaluator steps, on the whole change, and is pushed to the same branch only if the branch is still at the head the run started from. At most `max_fixes_per_pr` runs per PR (default 2). The harness gives up and asks the owner (a comment saying why, the `ci-failing` label, a review request) when: the cap is reached; fix runs are off; the log can't be read (no permission, or not an Actions job: a fix without the log would be a guess); someone else pushed to the branch; the worker shows the failure isn't caused by the change; or the fix fails its checks, the evaluator or the push. A fix run never merges and never reruns jobs, and a PR that needed one always waits for a human. Events: `ci_fix.started`, `ci_fix.finished`, `ci_fix.gave_up`; a run cut off by a restart is recorded as interrupted and counts toward the cap.
- **Feedback goes back to the session that wrote the change (PR mode).** Every worker and fix run records its claude session on `run.finished` (`session`; the run record keeps it too). A CI fix, a conflict fix and a review fix resume the issue's latest successful session (`claude --resume <id>`) with only the new instructions (the failing logs, the conflicted hunks, the review), since that session already has the issue's brief. A session that is gone (claude ends the resume at turn 0, "No conversation found") falls back to a fresh run with the whole brief; `run.finished` `resume` says which happened (`resumed`, or `fresh` with why). The resume goes through the same lane, so it runs as the same agent OS user, whose home holds the session. A third trigger: a writer's review on the harness's own open PR, requesting changes or commenting (its summary and its inline comments), starts a fix run with that text (`ci_fix.started` with `reviews`, the run's role `review-fix`), through the same pipeline and under the same `max_fixes_per_pr` cap as CI fixes. Past the cap, or on a branch someone else pushed to, the owner is told once per review (`review_fix.declined`, the `needs-owner` label, a review request). Reviews are read every 5 minutes, and only on PRs the harness opened: a person's PR is never touched. Code: `src/coordinator/fix-runs.ts`, `src/review-feedback.ts`.
- **Push limits.** Every push of agent-written code goes through one function that checks `guardrails.yaml` `push` first: no file over `max_file_mb` (default 10) in any commit of the range, including one added and later deleted; no path matching `refuse_paths`; at most `max_changed_lines` (default 1500); and never a `.github/workflows/` change, which the harness's credential can't push anyway. The same check runs on each change before it is verified, so the worker is told and no test run is spent; a refusal at the push blocks the issue with every reason. Either one records `push.refused`. A test fails if engine code pushes any other way (lease refs aside).
- **Steps for each batch:**
  1. Admission: evaluator pass, level cleared, and the secret and policy gates are green.
  2. In a throwaway worktree, rebase the batch onto `main@tip`. On conflict, abort and send the change back to its worker; never guess.
  3. Run the project's **pre-land steps** from `tests.yaml` `land.pre`. Example: a script that allocates sequence numbers (such as decision-record IDs) at merge time.
  4. Run the impact-selected tiers for the batch's union of paths. Money-path changes also run their money-path suites and the security role.
  5. **Gate:** no new failures against main's **recorded baseline failing set**. Cancelled, skipped, timed-out or missing results count as failures (§17).
  6. Push the tested SHA. Emit `land.result`. Delete the worktree.
- **Batching (step 4).** Follows bors + Mergify + SubmitQueue.
  - The batch seed is always the head of the queue.
  - Fill remaining slots with changes whose affected paths or tiers don't overlap.
  - Never batch two L3 changes or two changes to protected files.
  - On failure:
    1. Retry once, to separate flaky tests.
    2. Split the batch into cumulative prefixes and test them, re-running only the tests that failed in the parent.
    3. Land the longest prefix that passes, and recurse on the rest.
    4. A failing singleton is ejected to its issue with the logs.
- **PR-mode batching (`tests.yaml` `land.pr_batch`, off by default; src/coordinator/pr-batch.ts).** The same idea for PR mode, with the full suite run once per batch instead of once per PR.
  - **Queue.** A watched PR that is ready on its fast checks (`fast_checks`; the `full_checks` are left out of readiness until its batch posts them) waits in a queue, in the order PRs became ready.
  - **People's PRs.** An open PR into the default branch that the harness didn't open joins the same queue once its fast checks pass on its head, if a mapped admin or writer opened it (their role from their repo permission); a bot's or an unmapped author's only once an admin approves it. Taken from the fast test runs' own listing of open PRs. It gets the same sharded full run, alone in its batch (it merges when its author merges it, so nothing of the harness's waits behind it), and the full check is posted on its head through the App. The harness never merges it; a culprit gets the failing tier and `ci-failing`, and is never closed. Merged by its author once green, it is case (b) for the main watch.
  - **Batch.** The head of the queue, up to the batch size, merged in order onto the default branch's tip as merge commits on a local `<cli>/batch-<n>` branch (never pushed). A PR that doesn't merge onto the tip goes back to its author; one that only conflicts with a PR ahead of it waits for the next batch.
  - **Run.** One full run of the batch commit through the test-run service (`startTestRun({ kind: 'full', prs, sha }, { signal })`), split into `shards` parallel runs. The next batch starts once the last green batch's PRs have merged (or gone to the owner): built on the main they are about to change, it would be stale.
  - **Cancelled.** A batch is dropped mid-run, and its run cancelled through the signal, when a PR's head moves or it closes (the PR watch sees it), when main moves off the batch's base, or when the coordinator stops.
  - **No verdict is never red.** A run that was cancelled, interrupted or errored (the service's `outcome`, or a failed tier that never ran: no log) says nothing about the code: the batch is abandoned and batched again, never bisected, nobody blamed. One the batcher didn't cancel itself waits five minutes and records an error. Only tiers that ran and failed make a batch red.
  - **Alone.** A PR the merge policy leaves to the owner (high-risk, money-path, or any other reason it won't auto-merge) never shares a batch: it gets a batch of one, a full run, then waits for the owner. Merging the others around it would leave main in a state nobody tested.
  - **Green.** The passing full check is posted on each PR's head; the PR watch then hands each to the merge policy, unchanged: auto-merge where it allows, the owner otherwise.
  - **In order, onto the tested main.** A green batch's PRs merge strictly in batch order. Right before each merge, main's tip must be exactly what the batch tested that PR on: the batch's base for the first, the merge of the PR before it for each next one, and that merge's tree must be the batch's tree after that PR. Anything else (a commit that landed meanwhile, a PR ahead that didn't merge or waits for the owner) stops the batch: this PR and the rest are `stale` and tested again on the new main. The merge is GitHub's merge commit (`merge_method: merge`, pinned to the head), whose tree on the expected tip is the tree the batch tested; no combined-state check is needed.
  - **Owner approval.** A batched PR that waits for the owner merges on the owner's approving review, through the same check: if main is still its batch's base it merges; otherwise it is tested again first and merges once that passes. Merging it by hand on GitHub skips this, and the comment that asks for the review says so.
  - **Red.** A binary search over the batch's prefixes, each tested on the same base, finds the first PR that turns it red. It goes back to its author with the failing tier (a comment, `ci-failing`, out of readiness until its head changes). The longest green prefix merges; the PRs after the culprit go back in the queue and are tested again. A red batch of one is first checked against the base alone: a red base blames nobody, and the queue waits for the default branch to move.
  - **Never untested.** Right before any merge: every fast check passing on the PR's head, and a passing full run from a batch that held exactly that head (`mayMerge`). A PR whose head changes, or that closes, leaves its batch; if that happens after the run, the rest is tested again without it.
  - **Size.** Adaptive: the size with the fewest full runs per PR, `1/k + (1 - p)(log2 k + 1)`, at the recent pass rate `p` (smoothed toward 0.9), about `ln 2 / (1 - p)`, capped by `max` (default 8).
  - **Restarts.** Every step is a `pr_batch.step` event. A green batch cut off before all its checks were posted finishes posting them (`resumed`); any other open batch is `abandoned` and its PRs are back in the queue. A head is posted once and merged once.
  - **Events.** `pr_batch.queued`, and `pr_batch.step` (built, green, red, checks_posted, culprit, dropped, conflict, requeued, abandoned, resumed, error, finished).
- **Baseline:**
  - `baseline.recorded` stores main's failing-test set at a SHA, taken from nightly full runs or the last full run.
  - It is shown on the dashboard.
  - "Get main green" is the first backlog item and red_attributor's first job.
- **Machine-wide full-run lock.** Only one full suite runs per machine, across all harnesses on the box (§11).

## 11. Speed and the resource governor

- **Test-runner adapter interface:**
  ```ts
  interface TestRunner {
    plan(changed: string[]): Promise<TierPlan>        // which tiers/suites
    run(sel: Selection, opts): Promise<TestReport>    // per-test status: pass|fail|skip|cancel|timeout|missing
    vacuity(sel: Selection): Promise<VacuityReport>   // tests that assert nothing / touch no app code
  }
  ```
  - The generic `command` adapter takes a command, a result parser (JUnit XML, TAP, JSON or regex) and an exit-code policy.
  - Projects with a custom runner configure its commands for changed-only runs, tiers and shards, plus a per-suite output parser.
  - Projects with jest map `plan` to `--changedSince`.
- **Tiers** (tests.yaml):
  - PR or land gate: impact-selected plus vacuity plus project lints.
  - Land queue: affected modules, plus money-path suites when relevant.
  - Nightly: the full suite, Stryker (incremental) on modules changed that day, and recording the baseline.
- **Vacuous-test check.** Runs per test file.
  - (a) A static count of assertion calls; configured per project (e.g. `expect(` or a custom `check(` helper). Zero is a failure.
  - (b) A dynamic check: run with `NODE_V8_COVERAGE` and require at least one executed line in an app path (`server/`, `shared/`, `web/`). A test that only exercises its own fixtures fails.
  - This approach needs no ESLint, works for any Node runner, and is configured per project.
- **Resource governor:**
  - **Slots are machine-wide**, not per harness. They're lease files in a shared directory (`/var/tmp/agent-slots/` or `$AGENT_SLOTS_DIR`) under a small open protocol: one JSON file per slot `{pid, harness, project, started, kind}`. A slot whose holder pid is dead is reclaimed.
    - The protocol is documented in `docs/slots.md` so other harnesses on the box can join with about 20 lines of code.
    - The cap is per machine (e.g. 4 on a dedicated box, 2 on a laptop). A `full-run` slot kind is exclusive.
  - **Admission checks before starting an agent or test run:**
    - free disk after a new worktree (size estimated per project) stays at or above the larger of 10 GB and 5% of the disk (`governor.min_free_disk_gb`, `governor.min_free_disk_pct`)
    - load per core is below a threshold, using a CPU% adapter on Windows
    - other heavy workloads on the box (e.g. GPU jobs) are not observed directly; the cap is the guard
  - **Project preconditions on tiers.** For example, a tier can refuse to start above a disk-usage threshold. These are expressed in `tests.yaml`, not in engine code.
- **Plan mode** is required for size:M and size:L.
  - **The plan gate** (`plan_gate` in config.yaml). `always`, the default: every size:M/L plan, with its acceptance criteria (the planner's, or the issue's done_when), is posted on the issue and as a decision thread in Discord, and no worker runs until it is approved, by the same people as any held plan: an admin with "approve plan <n>" in the thread or on the dashboard, or `/<cli> approve` on the issue from a writer config.yaml lists. `risky` and `off`: only a high-risk or design-level plan waits; an ordinary one builds at once. `off` never skips the risk and design holds. size:S and unsized tasks have no plan.
  - **Plans cite decisions** (the owner's rule). Every plan has a Decisions section: "Rests on:" the recorded entries it relies on, "Argues against:" the recorded entries that cut against it, each with why the plan goes ahead anyway, or exactly "nothing recorded on this", alone. Entries come from the decisions index: the decisions already made (cited `decision <id>`) and the sections of the decision records in the checkout (`decisions.md`, `DECISIONS.md`, `docs/decisions.md`, `.worklane/decisions.md`, a `decisions/`, `docs/decisions/` or `docs/adr/` folder, and `docs/design.md`; cited `<file> § <heading>`, or by an id such as `D-12`). The plan contract check (`src/plan-decisions.ts`) refuses a plan without the section or citing what the files don't hold. Plan review, a fresh read-only `plan-reviewer` run, gets the plan, the full text of every entry it cites and the index, and names each recorded decision the plan contradicts without arguing against it. A refused plan goes back to the planner once with why, then the task is blocked. A plan that argues against a recorded decision waits for the owner, like a design-level one.
  - Skills and slash commands cover repeated workflows.
  - A PostToolUse formatter runs only if the project has one.
- **Weekly optimization pass** (`src/optimize.ts`, wired in `src/coordinator/optimize.ts`; config.yaml `optimize`, off by default: `{ enabled, weekday, at, budget_usd, max_prs, targets, slow_test_command, repeats }`).
  - **Targets:** the benchmarks declared in `.worklane/benchmarks.yaml` (`name`, `command`, `repeats`, `metric`: `wall_ms` or a `pattern` whose capture group is the number, `lower_is_better`, an optional `profile` command), and `slowest_tests`: the slowest test the metrics recorded over the week (`testrun.durations`, `ci.test_durations` events), run alone by `slow_test_command` with `{name}` (made shell-safe: anything but letters, digits, `_` and `-` becomes `.`). `targets` lists them in priority order; empty means every benchmark, then the slowest test. The pass picks the first never tried, else the one tried longest ago. No benchmark framework: a command and a number.
  - **The pass**, on `weekday` after `at` (local): the target's command `repeats` times on the default branch's tip, in a scratch worktree (median and MAD), then a normal task (label `optimize`, a `suite: full` contract) with the numbers, the profile (the `profile` command's output, else the last run's) and the rule: change only what improves this number, same behavior, every test passes. Only an `optimize` task this instance's own `optimize.pass` filed is dispatched without a writer's `ready`; the label alone makes nothing actionable. It builds on the high-risk build model (agents.yaml `routing.build_high_risk`, the strongest).
  - **The gate:** after the normal checks and the evaluator, before landing, the coordinator runs the benchmark `repeats` times on the change (and on main again if the task's base moved). Only a median better than main's by more than the noise (2 x the larger MAD, at least 1% of main's median) goes on (`optimize.result` `improved`): the PR, a normal draft through every gate and the usual merge policy, carries the before and after table with every raw run. Anything else (no gain, within the noise, a failing benchmark) is `discarded`: closed with why and the numbers, no PR.
  - **Budget:** a hard stop at `budget_usd` a week: the run.cost of the week's optimization tasks. No pass starts once it is spent, every worker run is capped at what is left, and no further attempt starts once it is gone (discarded with why). At most `max_prs` PRs a week, one task at a time, PR land mode only.

## 12. Guardrails

**Two modes**, chosen by `WORKLANE_AGENT=1`, which the coordinator sets on every headless run:

| | Agent mode (headless runs) | Human mode (anyone's interactive session) |
|---|---|---|
| Production DB, live-wallet signing | blocked | blocked |
| Production variable sets and deploys | ask | ask |
| Harness-file edits, secret files, domain allowlist | blocked | not applied |
| The push gate's first-time-setup hatch (`PUSH_GATE_BOOTSTRAP`) and git's pre-push hook: setting, exporting, passing or storing the hatch (a shell rc, `.env`, git config); `git push --no-verify`; `core.hooksPath` by `-c`, `git config` or `GIT_CONFIG_*`; writes to a git hooks dir or git config file (`src/guardrails/push-hook.ts`) | blocked (`push-gate-hatch`, `push-hook-bypass`); the runner also drops the hatch from every agent's and project command's environment, and the hook refuses it in an agent run | not applied |
| Commit secret scan | every `git commit` (PreToolUse) | opt-in git pre-commit hook (`install --git-hooks`) |
| Stop gate | runs `done_when` | none (recorded) |
| Engine not installed | every hook blocks | one-line warning at session start; nothing blocks |

Hooks are POSIX shell commands. Claude Code runs them with `sh` on macOS and Linux and with Git Bash on Windows, so human mode works on Windows without WSL. CI runs the hook tests on all three.

Enforcement is layered, so no single layer is trusted:
1. Credentials that make the action impossible
2. PreToolUse hook
3. Settings deny rules
4. OS sandbox on Bash (macOS and Linux)
5. Post-run diff and policy check in the coordinator: the only layer that works on every OS, and the one that can't be bypassed by subprocesses

### 12.1 Blocked (only these)

**Production database writes.**
- **Detection can't rely on the host name.** Some platforms give every environment's database the same private host name, so staging and production look identical by host.
  - Detection uses a **fingerprint of the full connection string**: SHA-256 over protocol, user, password, host, port and database. Platforms often use the same user and database name in every environment, so the password is frequently the only difference. Only the hash is stored.
  - The coordinator fetches the production connection string read-only at startup, through a project-configured command, and stores only the hash.
- **Architecture first.** Agents never receive a prod DB credential: the environment is scrubbed and there's no `.env` in worktrees.
  - Production reads that must stay allowed go through a dedicated **read-only database role**: SELECT only, a connection limit and a statement timeout. The project owner creates it.
  - **One sanctioned read path:** `prod-read "<SQL>"`. It runs a fixed client **inside** a production service, where the database's private host resolves, over the platform CLI's ssh. The client:
    - connects only with the read-only role's URL, stored on that service by the owner
    - wraps the query in a `READ ONLY` transaction
    - refuses multi-statement SQL

    SQL and client travel base64-encoded, so nothing can be injected into the remote shell. Production credentials never reach the agent's machine, and the database stays off the public internet. Every other production shell stays blocked.
  - Until the role exists, agents get no production DB access at all.
- **Hook rules**, in `guardrails.yaml`, with detection by fingerprint and environment rather than file name:
  - Deploy-platform commands that open a shell or run a process in production. The environment is resolved from an explicit flag, otherwise from the CLI's linked environment. **An environment that can't be resolved counts as production.**
  - DB clients, migration tools, or scripts given a connection string, or an environment, whose fingerprint matches production.
  - Commands that read or source production variables (which contain credentials) are **ask**.
  - **Allowed:** migrations the release process runs at boot.

**Signing from a live wallet.**
- Architecture: signing keys live only with the service that uses them (e.g. a cloud KMS). Agents never get credentials for them; this is enforced by environment scrubbing.
- Hook rules:
  - signing or sending CLIs (e.g. Foundry `cast send`) against a non-local RPC or with a non-test key
  - running the project's signing entry points with production config
  - The patterns are project config. Local devnets and testnets are always allowed.

### 12.2 Must stay frictionless (tested as allow examples)

These are **must-allow fixtures** in `guardrails.yaml`. `worklane guardrails check` fails if any rule would block or prompt them:
- reading production through the read-only path
- setting deploy-platform variables on **staging**
- running the project's release command
- editing any money-path file
- running the test suite
- `git push` by the coordinator

Setting variables or deploying directly in **production** is **ask** (soft-deny), not blocked.

**Rule-conflict check.** Every rule change runs the full must-block and must-allow corpus before going live. A new rule that blocks a must-allow example, or a block shadowed by an allow, fails the check and can't be activated. It runs in `doctor`, in CI, and in the land queue whenever guardrail config changes.

### 12.3 Secret scanning

| Where | How | When |
|---|---|---|
| Commits | gitleaks `--staged` pre-commit hook in every worktree; **re-scanned in the land queue** (the hook can be skipped with `SKIP=`) | every commit, every land |
| Agent transcripts and logs | `gitleaks stdin --max-decode-depth 2 --redact` on each transcript chunk and every event payload; matches are redacted before storage and raise `secret.detected` | streaming, during runs |
| Hooks, MCP config, permissions | AgentShield (`ecc-agentshield`, MIT) | `install`, `doctor`, CI |

The scanner sits behind an adapter so it can move to betterleaks; gitleaks is in security-patch-only mode.

### 12.4 Network

- Bash network goes through the sandbox's `allowedDomains`. WebFetch follows permission rules from the same allowlist.
- An unknown domain raises `network.domain_requested`, which becomes a Decision. It is approved once, then logged and added through a config change.
- No User-Agent spoofing and no workarounds for blocked sites; this is stated in role prompts and a hook rule.

### 12.5 Harness files are not writable by agents

- Protected: `.worklane/**` (except `lessons/` proposals, which go through `propose_lesson`), `.claude/settings*.json`, hook scripts, `CLAUDE.md`, and the frozen repro tests.
- Layers:
  - `Edit(...)` deny rules
  - the PreToolUse path check, including Bash redirects
  - sandbox `denyWrite`
  - the coordinator rejecting any proposed diff that touches them; that rejection is the only layer that works everywhere
- Changes to harness config come only from humans, or are proposals at L3.

### 12.6 Stop gate

- A Stop or SubagentStop hook runs the run's done_when checks.
- Outcomes:
  - pass: the agent may stop
  - fail: `decision: block` with the failing output
  - **can't run** (lock busy, timeout, missing tool): `decision: block` with a reason, plus a `stopgate.unavailable` event
- It **never** passes by default. "Busy" means wait or retry and then report; it never means skip.
- The coordinator re-verifies independently before accepting a proposal, so the hook isn't the only gate.

## 13. Deploy verification

- `deploy.yaml` declares environments and an adapter (generic adapters, e.g. Railway; project values are config).
- Platform auto-deploys can't be trusted to fire. Some platforms silently skip path-filtered deploys, so the verifier never assumes one happened:
  - **staging:** after a landing, the coordinator triggers the deploy explicitly (a configured command), polls until it settles, then **confirms the deployed SHA equals the landed SHA**.
  - **production:** the project's release command stays the path. The verifier confirms every production service serves the release SHA.
- A skipped deploy, a failed deploy, or a SHA mismatch is `deploy.failed`: a red row on the Deploys page and an Inbox item for the owner of deploys.
- An issue is `done` only after `deploy.verified`.

## 14. Dashboard

- **Stack:** Vite + React + TypeScript + Tailwind + shadcn/ui (Radix) + cmdk + TanStack Router, Table and Query, plus react-resizable-panels and sonner. All MIT.
  - Plane (AGPL) is a design reference only.
  - Served as static files, with its API and the SSE stream, by its own process, not the coordinator: `worklane dashboard` (`src/dashboard.ts`), on `127.0.0.1` only, with a per-install token. It reads the instance's event log and records answers in it. On a machine set up with separate users, each instance's dashboard is its own service (`worklane-dashboard-<name>.service`, as that instance's coordinator user `wl-<name>`), and a hub (`worklane-dashboard-hub.service`, as `wl-dash`) forwards to them, with GitHub sign-in (`scripts/setup/dashboards.sh`, docs/dashboard.md).
  - Live updates use **one SSE stream** that replays from `Last-Event-ID`. Actions are POSTs that become events.
  - Tauri v2 wraps it in step 6. v3 is in alpha, so we wait.
- **Pages:**

  | Page | Contents |
  |---|---|
  | Overview | live summary |
  | Inbox | the current user's items |
  | Decisions | cards with question, options, recommendation, receipts and owner; keystrokes `a` and `r` |
  | Issues | current/planning/backlog tabs; list and board views; swimlanes by module; filter chips; saved views (Mine, Collaborator, Money-path, Blocked); detail page with a properties panel showing owner, delegate, status, level and reasons, linked change, done_when, verdict and cost |
  | Landed commits / PRs + Land queue | label follows land_mode; shows the baseline |
  | Agents | roster, live status, logs, spend vs budget, enable/disable |
  | Activity | event feed |
  | Deploys | staging and prod SHAs; flags skipped or failed deploys |
  | Reports & Scorecard | |
  | Settings | |

- **Messaging a running agent** (spike, 2026-10-09, confirmed on the always-on machine):
  - The console sends messages through the session's stream-json input, which the coordinator holds. A message sent mid-turn is queued and answered only after the current turn ends, so the console shows it as pending until then.
  - Urgent control (pause, stop) uses interrupt and stop, never a message.
  - **Built (2026-10-10):**
    - Every run's input is stream-json: the prompt is the first user message, and the input stays open for the run.
    - A console message is held by the runner until the turn's `result`, then written as the next user message. A local probe showed a message written mid-turn is folded into that turn and replaces its answer. With nothing held at a result, the input closes and the session ends. The per-login run lock still covers an agent's whole run; an interactive run (a chat or thread reply) takes only the login's start lock (src/runner.ts, docs/intake.md 2.1.3).
    - The dashboard and the coordinator are separate processes. The console library (src/console.ts, owner only) writes a request into `<state>/console/requests/`, which the coordinator takes every 5 s. It lists live runs in `<state>/console/live.json`, and records every outcome as an event (`console.message_queued`, `console.message_delivered`, `console.message_dropped`, `console.run_stopped`, `console.request_refused`).
    - **Stop** kills the run's tree (reason `stopped`), and the task is blocked with who stopped it.
    - **Interrupt** is not offered yet: the spike's interrupt step (part 3) has to confirm it for a run as another OS user first.
    - **Live feed:** each run also writes a live feed (src/run-feed.ts) under its run record's id: assistant text, thinking, every tool call with its input, capped tool output, and Edit/Write diffs. It is redacted with the event log's patterns before it is written, capped per run with one truncation marker, and ended with the run.
  - Not the cross-session socket: the agent's socket lives in a 0700 directory its own user owns, so the coordinator user can't connect to it, by design of the user split.
  - Claude Code keeps that directory at a fixed path in `/tmp` (`/tmp/cc-socks`), so each coordinator service has a private `/tmp` shared only with its own agents. Otherwise one instance's agent user would lock out every other's.
- Cmd+K, keyboard-first, sidebar badge counts, and owner + delegate avatars on every row.
- Dark and light themes.
- **Shared mode (step 6):** each coordinator pushes events to a small relay (a Cloudflare Worker + Durable Object, behind Cloudflare Access) that merges both humans' streams with GitHub webhooks. Local mode never needs it.

## 15. Reports, scorecard, trust stages, learning

- **Reports** at the configured times, generated from the log by the chief_of_staff with a strict template:
  - what landed and deployed
  - what's in review, with level and owner
  - decisions needed, with owner
  - blocked items and why
  - spend vs budget
  - scorecard deltas
  - Delivered as a GitHub issue comment on a pinned "Reports" issue (visible to both owners) and on the dashboard. Short, no padding.
- **Scorecard**, computed from events:
  - evaluator pass rate
  - unverified-claim rate (claims in a run with no matching check event)
  - reverts
  - new red tests vs baseline
  - cost per *deployed* change
  - ready → deployed time
  - human interventions per task
- **Learning loop:**
  - After each task the agent emits `propose_lesson`: what worked, what failed, the fix.
  - Lessons land in `.worklane/lessons/` through the review queue at L2.
  - Repeated wins are proposed as skills (the ECC instinct → skill pattern, with a human promoting them).
  - Skills ship with evals: blind A/B, as in pstack's eval playbook. A skill change that regresses its eval doesn't land.
- **Docs freshness:** module docs carry `verified_at: <sha>`.
  - Agents treat a doc whose described paths changed after `verified_at` as unverified and must read the code. A check computes this, so it doesn't depend on the agent's judgment.
  - Deleting data based on a doc's claim needs L3.
  - CLAUDE.md is kept at ≤2.5k tokens, with a lint in `doctor`.

## 16. Project integration

A project's `.worklane/` holds its config plus a `NOTES.md` recording what was learned about the project during install:
- owners and writers
- machine constraints
- test-runner commands
- deploy specifics
- guardrail patterns
- the separate small commits made to the project during install

Install adds config only. A project's application code is never changed. Any small changes to its test machinery or docs (e.g. telling its impact planner that `.worklane/` isn't app code) are separate commits the owner approves.

## 17. Day-one regression tests

| Bug seen in another harness | Mechanism | Test |
|---|---|---|
| Cancelled or skipped CI checks counted as green | Check results are a closed enum; only `pass` is green; missing counts as fail | Table test: every non-`pass` conclusion from the GitHub checks API and the test adapters fails the gate |
| A 403 reported as a missing permission | A GitHub error classifier separates 403 by cause (rate-limit headers, SSO, secondary limit, scope, blocked) from 404 | Fixtures of real 403 bodies and headers mapped to the right `error.kind` |
| A "hold" counted as a failure | Outcomes are `pass`, `fail` or `hold`; hold (awaiting a decision or lock) is neither | Scorecard and gate tests with held items |
| Stop gate skipping when busy | Gate result is `pass`, `block` or `unavailable`, and `unavailable` blocks | Simulate a held lock and a timeout; assert block plus the event |
| Backups or state reported as pushed when they weren't | Success needs a read-back checksum and the latest event id | Fake remote that accepts a write and stores nothing must report failure |
| A watcher that dies when the session ends | All timers live in the coordinator service; nothing is session-scoped | Spawn the coordinator detached, kill the parent session's process group, assert heartbeats continue |

These ship in step 1 or step 2, whichever step introduces the code they guard. Step 1 ships the Stop gate, check-status and 403 tests.

## 17a. As first built (2026-10-07)

What exists, and where it deviates from the plan above:

- **Event log:** `node:sqlite`, zod-typed events, append-only enforced by triggers, redaction on write. Backups are verified by read-back. Projections are computed from the log on read; there are no cached projection tables yet.
- **Claims:** compare-and-swap lease refs (`refs/worklane/claims/issue-<n>`). Verified against GitHub. Lease commits are parentless.
- **Safe outputs, as built:** agents emit structured JSON (`--json-schema`) and commit on their own branch. The coordinator validates both and performs every outward action. Agents have no GitHub credentials (verified: `git credential fill` returns nothing in the agent environment). The MCP `propose` tool from §7 isn't needed for step 2's actions.
- **Reproduction tests:** one candidate per issue (K=1). A test that passes on the unfixed code, or an issue the evaluator says can't be reproduced, is recorded as `repro.unavailable`, and the change goes to at least L2 instead of blocking.
- **Decisions:** answered by `worklane decide <id> <option>`, or by a writer commenting `/worklane <option>` on the issue. The Decisions page arrives in step 3.
- **Landing:** direct mode is complete. In PR mode the coordinator records `rejected` with a pointer to step 3; opening and merging PRs ships with the dashboard.
- **Gate at landing:** the project's `changed` test command must exit 0. The "no new failures against the recorded baseline" comparison needs a per-runner failure parser, and arrives with tiered tests in step 4. Until then, a red main blocks landing, so getting main green is the first backlog item.
- **Runner:** `claude -p` with `--setting-sources project`, `--strict-mcp-config`, `--permission-mode dontAsk`, explicit allowed tools, and per-run turn and USD caps. `claude auth status` is checked before each run. The Agent SDK path (`agent_runtime.kind: sdk`) uses the same CLI with an API key. An in-process SDK runner is deferred.
- **Live verification:** the example project ran end to end with the real CLI (haiku for every role). Repro, then fix, then the coordinator's checks, then the verdict, then L1, then landed and closed, in under a minute for about $0.01.

## 18. Build order (history)

| Step | Contents | Ends with |
|---|---|---|
| 0 | scaffold, open-source hygiene, prior art, this design | **review (now)** |
| 1 | config schemas; `install`/`doctor`; guardrail hooks (prod-DB, wallet, production ask rules, protected files); gitleaks on commits and transcripts; vacuity check; Stop gate; rule-conflict checker; AgentShield in CI; generic example project; first project's `.worklane/` on a branch | tests pass, report |
| 2 | event log; coordinator service; one worker + evaluator; done_when; claims; review levels; serial land queue (direct + PR); staging deploy verify; labels created | tests pass, report |
| 3 | dashboard v0: Overview, Inbox, Decisions, Issues | |
| 4 | N workers in worktrees; machine-wide slots and governor; tiered tests; batching + bisect | |
| 5 | reports, scorecard, trust stages, learning loop, prod deploy verify | |
| 6 | remaining pages, Tauri, shared relay | |
| 7 | security, red_attributor, ci_repair, qa_playtester, monitor, release_prep | |

## 19. Decisions from the first design review (2026-10-07)

1. **Name:** Worklane.
2. **Owners** are per project, in `owners.yaml`: areas map to people, unassigned work goes to a default owner, and the owner can be changed per issue.
3. **Budget:** `daily_budget_usd` is a **usage guard on estimated cost**, not an API bill. It applies whichever runner is used.
4. **Auth and runner.** No sign-in flow.
   - **Default runner:** the locally installed Claude Code CLI (`claude -p`, stream-json) with whatever auth the user already configured.
   - **Option:** the same CLI with `ANTHROPIC_API_KEY` (`agent_runtime.kind: sdk`).
   - Both runners sit behind one `AgentRunner` interface.
  - [auth.md](auth.md) cites Anthropic's docs and terms. The CLI runner checks `claude auth status` before each run and strips API keys from the agent environment, so a subscription is never silently swapped for per-token billing. It uses conservative concurrency and optional run windows.
5. **Production DB:** agents get no production DB access until the project owner creates a read-only role (§12.1).
6. **Deploy CLIs:** the hook resolves the linked environment. Project release scripts should target production explicitly, so a checkout can stay linked to staging.
7. **Code of Conduct contact** is set. Security reports use GitHub private vulnerability reporting.
