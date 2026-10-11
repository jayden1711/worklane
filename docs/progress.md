# Progress

One short note per step: what shipped, how it was verified, what's still unproven.

Features later removed keep their history here, marked **Removed in cfef4b4**: on 2026-10-09 that commit removed what had caught nothing on real work (see "Pruning" below). A removed feature comes back only if the same failure happens twice.

## Steps 0-2 (2026-10-07)

- **Step 0:** scaffold, open-source hygiene, prior art, design, names. Repo history cleaned of project specifics.
- **Step 1 (v0.1.0, v0.1.1):** config schemas, `install`/`doctor`, guardrail hooks (agent and human modes), secret scanning on commits and transcripts, vacuity check, Stop gate (**removed in cfef4b4**: the coordinator re-runs every done_when check itself, and an installed Stop hook is a no-op), rule-conflict check, production read path, machine-wide slots and run queue. CI on macOS, Linux and Windows.
- **Step 2 (v0.2.0):** event log, verified backups, compare-and-swap claims, GitHub backlog, review levels, coordinator (repro-first evaluator, independent verify, serial land queue, staging verification), baseline gate, investigations, skill evals.
  - Verified live with the real `claude` CLI on a local demo repo.
  - Unproven until the always-on machine: a coordinator running for days; real GitHub issues end to end.

## Step 3: dashboard v0 (2026-10-08)

- **What:** a local dashboard served by `worklane dashboard`. Pages: Overview, Inbox, Decisions, Issues (list and board, tabs, filter chips, saved views, swimlanes by area) and an issue detail page with a properties panel.
- **Interaction:** Cmd+K menu, keyboard-first (`g` chords, `j`/`k`, `1-9`/`a`/`r` to answer decisions, `/` to search, `b` to toggle board), dark and light themes.
- **Data:** reads only the event log, through a pure projection. Live updates arrive over one SSE stream. Binds to 127.0.0.1 with a per-install token. Its one write is a human answering a decision, recorded as an event.
- **UI stack:** React + Tailwind, components in the style of shadcn/ui (MIT), cmdk and Radix. Bundled licenses ship in `dist/web/licenses.txt`.
- **Demo:** `worklane demo <dir>` seeds a project worked by the real coordinator with scripted agents, covering every state.
- **Verified:** API tests (token, SSE on log growth from another process, decisions recorded once with a valid option, path traversal blocked, saved views). Projection tests. Headless-Chrome screenshots of every page read and checked.
- **Bugs the screenshots found:** the coordinator re-recorded unchanged issues every tick (now only on change, with a regression test); avatar fallback; CLI option parsing.
- **Unproven:** the Chrome extension couldn't reach this Mac's localhost, so screenshots came from a local headless Chrome. Not yet used by a human.

## Step 4: parallel workers, governor, tiered tests, batched landing (2026-10-08)

- **Parallel workers:** each tick fills every free worker (`workers.count`), each in its own worktree. Project commands run async, so one long test run can't stall other agents' streams.
- **Governor:** before each start it checks the daily budget, sustained load (higher of the 5- and 15-minute averages; `governor.max_load`, default 2 x cores), free disk after another worktree (`min_free_disk_pct`, default 15%) and the machine-wide slot cap shared with other harnesses. Holds are recorded when the reason changes.
- **Tiered gates** (`tests.yaml gates`): `land` (e.g. `changed`) for every batch; `money_path` (e.g. `full`) added when a batch touches money paths. Exclusive tiers take the machine-wide full-run slot; a busy slot defers the batch, it never fails it. Every gate is judged against main's baseline and retried once for flakes.
- **Batched landing:**
  - Seed with the oldest; add non-overlapping changes up to `land.batch_max` (default 4), at most one L3.
  - One tested commit per batch. A conflict ejects only that change.
  - A red batch splits in half recursively until the culprit is isolated and blocked; the rest land.
  - A rejected push (the tip moved) defers rather than fails.
- **Nightly** (`tests.yaml nightly_at`): queues a full run on the tip of main that re-records the baseline, plus extra nightly tiers such as mutation testing, all behind the full-run lock, the idle probe and the load gate.
- **Also fixed:** secret scans cover exactly the change's commits, not the worktree (which includes dependencies).
- **Verified:** tests for three concurrent workers landing, the cross-harness cap, governor holds on load and disk, one-commit batches, split-to-culprit, overlap separation, deferral on a held full-run slot, and the nightly schedule.
- **Unproven until the always-on machine:** real parallel Claude runs at the target cap; batch sizes against a project whose full suite takes hours (a split costs another gate run).

## Step 5: reports, scorecard, trust stages, learning loop (2026-10-08)

Of this step only the reports remain. The scorecard, trust stages and learning loop were **removed in cfef4b4**.

- **Scorecard** (**removed in cfef4b4**; reports keep landed, in review, decisions, blocked, spend and governor holds): computed from the event log over a window, never stored. Evaluator pass rate, unverified-claim rate (a worker said done, then inspection or checks disagreed), reverts, new reds caught and baseline growth, cost per finished task, ready-to-done time, interventions per task, **idle hours** (ready work waiting with nothing running; ticks now record active and ready counts) and **hours blocked on the owner** (decisions waiting, tasks blocked).
- **Reports:** at each `reports.times` slot the coordinator posts one comment to a single report issue, mentioning `reports.to` (or the default owner). The comment lists what landed (and whether it is verified on staging), what's in review, decisions waiting with owner and wait time, what's blocked and why, spend, governor holds, and the scorecard with changes since the last report (the scorecard part was removed in cfef4b4). `worklane report` prints the current one. The dashboard Reports page comes in step 6.
- **Trust stages** (**removed in cfef4b4**, with their stage decisions; agents.yaml's `stage` is still accepted and ignored, so existing configs load): once a day the window is scored. After `promote_after_days` healthy days the owner is asked to promote to the next stage defined in review.yaml; only an approval promotes. A quality regression (pass rate, unverified claims, reverts, baseline growth) demotes one stage on its own; too little work is not a regression. A stage relaxes only the categories it lists. Money-path, migration, auth, secrets, deploy, release, harness and guardrail config can never be relaxed: config validation rejects it, and the level computation ignores it even if asked.
- **Learning loop** (**removed in cfef4b4**, with the lesson in the worker's output): once a day, new lessons go to `<config dir>/lessons/<day>.md` on a branch, opened as a PR. They reach main only when the owner merges. Advice that recurs across three or more tasks is listed as a skill candidate; turning one into a skill (with evals) stays a human step.
- **Also fixed:**
  - Each tick step is guarded on its own, so a GitHub error in reconcile no longer stops landing.
  - Coordinator tests now use fixed machine readings; CI macOS runners' low disk had held dispatch.
  - A task blocked before any claim now reaches its owner's inbox.
  - release.mjs returns to the starting commit when run detached.
  - Each fix has a regression test.
- **Released:** v0.3.0 (steps 3 and 4), from a clean worktree after CI was green on all six OS x Node jobs.
- **Unproven until the always-on machine:** promotion and demotion thresholds against real work (defaults: 10 tasks in 7 days, pass rate 0.8, unverified claims 0.1, zero reverts); report posting with real GitHub permissions; lessons PRs opened by the coordinator's token. (Stages and lessons were removed in cfef4b4 before this was tested.)

## Step 6: the remaining dashboard pages and a desktop window (2026-10-08)

- **Pages:**
  - **Land queue:** queued changes in order, deferred ones with the reason; what's in review; recent batches with outcome; lessons PRs (removed with the learning loop in cfef4b4).
  - **Agents:** the governor's state, machine-wide slots, spend by role, runs in flight with their last heartbeat, recent runs with outcome and cost.
  - **Activity:** every event, filterable by group and text.
  - **Deploys:** what each environment serves, landed but unverified changes, and history linked to issues.
  - **Reports:** the scorecard against the previous week, trust stage with health reasons and daily checks, a preview of the next report, posted reports. Since cfef4b4 the page shows only the preview and the posted reports.
  - **Settings:** read-only config; commands, connection fingerprints and deploy details stay out, and a test checks that.
- **Keyboard:** the new `g` chords exposed a real hazard. Page listeners run before the app's, so `g a` on Decisions would have approved the selected decision. Page shortcuts now refuse keys while a chord is pending.
- **Desktop window:** `worklane dashboard --app` opens the dashboard in a Tauri 2 shell built from source (`npm run build:desktop`), falling back to the browser. The shell accepts only a loopback http URL, keeps navigation on that origin, gets no IPC, and closing it stops the server. Rust tests cover both guards; CI runs them on macOS.
- **Bug found by the demo** (in the scorecard, since removed): with a deploy target, the scorecard counted no tasks as done. Done is now landed with no deploy target, or verified on an environment; regression test included.
- **Verified:** projection and API tests; screenshots of every new page against the demo (headless Chrome now runs with its own `--timeout`; the virtual-time budget never settles while the live stream is open).
- **Unproven:** the desktop shell on Windows and Linux (built and tested on macOS only); a human using the pages.

## Step 7: optional roles (2026-10-08)

All six roles were **removed in cfef4b4**, with the CI-status and PR methods only they used. CI repair came back on 2026-10-10 in a different form, as **CI fix runs** (see below). It fixes a harness PR's failed required check on the PR's own branch, rather than filing a triage issue. It keeps the `ci_repair` role name and `max_fixes_per_pr`.

- **Roles:** security, red_attributor, ci_repair, qa_playtester, monitor and release_prep. All are off by default, read-only (Read, Glob, Grep, read-only git; Edit and Write disallowed) and counted against the budget and governor. Each fires once per trigger. Their output becomes issues, comments or a higher review level; none edits code, deploys, tags or holds a write token.
- **Security:** sits in the task pipeline after the verdict, for its `applies_to` categories. Block means L3, concerns mean L2, never lower. Findings set a floor under its own verdict, and a reviewer that touches the worktree counts as a block.
- **Red attributor:** when main's baseline grows, a single landing in the window is blamed without an agent; with several, the agent attributes each failure or says unknown. The owner is told on their issue, and a triage issue is filed.
- **CI repair:** one diagnosed triage issue per red tip, with a proposed done_when contract; at most `max_fixes_per_pr` open at a time.
- **QA playtester:** each verified test deployment once, never production; capped per day; bugs de-duplicated by title. It needs a project-supplied browser tool (`tools`).
- **Monitor:** every `every_minutes`, re-runs each environment's verify check. A pass-to-fail change opens an incident with a diagnosis (production incidents say a human must act); a recovery is noted.
- **Release prep:** once a day, release notes for changes since the last tag, opened as a PR.
- **Verified:** a test per role with a scripted runner and a real git remote; a pipeline test where a blocking security review sends the change to the owner as L3 with the finding; a test that every role defaults off and a pass runs no agent.
- **Unproven until the always-on machine:** every role against a real model; the QA role needs a browser tool the project chooses; the monitor's schedule against real verify checks.

## Pruning (2026-10-09, cfef4b4)

Kept: what had caught real problems, plus the controls that limit damage whatever the evidence: separate OS users and credential checks, the sandbox, protected categories that need a human, checks the harness runs itself, and no push to main. Removed, none of them having caught anything on real work:

- the adaptive agent cap and its signals; a fixed, configurable cap remains (default 2)
- the six optional roles of step 7
- trust stages and their decisions
- the scorecard
- the learning loop
- the Stop gate hook

## Since the pruning: running real repos (2026-10-09 to 2026-10-10)

Each item merged as its own reviewed PR, with tests that fail without it, on CI for macOS, Linux and Windows.

- **Separate users, one identity:** agents commit with the harness's own identity (the GitHub App's bot), never one they pick. Checks run as the agent user and keep their failing output. Retries are judged against the base.
- **The worker loop:**
  - The worker's brief names the fast tests to run, and says the coordinator runs every check.
  - A project can give its agents and commands its own environment variables (`tests.yaml env`).
  - Once an issue's own check fails, the project's long checks are skipped.
- **Intake:** a refused issue is judged again when its done_when is edited, with a fresh comment for a new error.
- **Startup failures:** a worker run that fails within seconds having committed nothing blocks the issue at once, with claude's own error. It no longer spends every attempt and then reports "no passing change".
- **Runs and logins:** runs wait out Claude login and transient errors, one claude per login at a time.
- **Push limits:** every push of agent-written code goes through one check. It refuses files over the size limit, paths the repo refuses, too many changed lines and workflow changes, with every reason on the issue.
- **PR watch:** PRs open as drafts and are marked ready only when every required check passed on the exact commit the evaluator approved.
- **CI fix runs:** a failed required check on a harness PR gets a bounded number of fix runs on that PR's branch. It gives up to the owner with the reason, and never merges or reruns jobs.
- **Auto-merge:**
  - The harness merges its own PRs only under a merge policy. High-risk, design-level, big or doubtful changes wait for the owner.
  - It merges with a merge commit, pinned to the evaluated commit.
  - It has a per-instance kill switch, stops itself and opens a revert when main turns red after an auto-merge, and lists auto-merges in a daily digest.
- **Conflicts:**
  - A conflicting harness PR gets its base merged in and the hunks resolved, or goes to the owner.
  - Two tasks that would change the same shared file never run at once (hotspot holds).
  - A combined-state check runs the fast tier on PR plus main before an auto-merge, but only when main touched what the PR touches.
  - Merge metrics show what each of these costs per merged PR.
- **Frozen-test guard:** task files the agent can read, and a hook that fails closed when it can't check.
- **State privacy:** state files are closed to other users from the start, and the dashboard's access setup refuses to grant reads over open ones.
- **Instance settings:** the operator's policy wins over the repo for workers, budget, CI fix runs and run windows.
- **Machine:**
  - Machine settings go through one root-owned helper.
  - Engine updates come from a root timer: fast-forward only, after green checks and on a quiet machine, with rollback.
  - The App's token permissions are checked at install and with a read-only verify.
- **Reports:** a weekly section on how runs ended, the commonest causes with example runs, and fixes proposed for repeated causes as Inbox decisions. It also shows what conflict fixes, combined-state checks and hotspot holds cost.
- **Instruction evals:** a change to the agents' instructions is evaluated before it lands. A lower score waits for the owner.
- **Dashboard:**
  - For an instance (`--instance`), or every instance in one view through a hub.
  - Pages for each issue's checks, agent runs, the PR list, the service log, machine health, instance and machine settings, and an emergency stop in force (read-only).
  - Decisions answered only by their owner or a writer, and costs shown as estimates.
  - A visual pass with an MIT-licensed pattern library.
  - A control script, a feature map that a test keeps current, and a verify skill for agents.
- **Unproven:** days of unattended running on the always-on machine across several instances, and the engine updater's rollback on a real failure.
