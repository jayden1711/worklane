# Progress

One short note per step: what shipped, how it was verified, what's still unproven.

## Steps 0-2 (2026-10-07)

- **Step 0:** scaffold, open-source hygiene, prior art, design, names. Repo history cleaned of project specifics.
- **Step 1 (v0.1.0, v0.1.1):** config schemas, `install`/`doctor`, guardrail hooks (agent and human modes), secret scanning on commits and transcripts, vacuity check, Stop gate, rule-conflict check, production read path, machine-wide slots and run queue. CI on macOS, Linux and Windows.
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

- **Scorecard:** computed from the event log over a window, never stored. Evaluator pass rate, unverified-claim rate (a worker said done, then inspection or checks disagreed), reverts, new reds caught and baseline growth, cost per finished task, ready-to-done time, interventions per task, **idle hours** (ready work waiting with nothing running; ticks now record active and ready counts) and **hours blocked on the owner** (decisions waiting, tasks blocked).
- **Reports:** at each `reports.times` slot the coordinator posts one comment to a single report issue, mentioning `reports.to` (or the default owner). The comment lists what landed (and whether it is verified on staging), what's in review, decisions waiting with owner and wait time, what's blocked and why, spend, governor holds, and the scorecard with changes since the last report. `worklane report` prints the current one. The dashboard Reports page comes in step 6.
- **Trust stages:** once a day the window is scored. After `promote_after_days` healthy days the owner is asked to promote to the next stage defined in review.yaml; only an approval promotes. A quality regression (pass rate, unverified claims, reverts, baseline growth) demotes one stage on its own; too little work is not a regression. A stage relaxes only the categories it lists. Money-path, migration, auth, secrets, deploy, release, harness and guardrail config can never be relaxed: config validation rejects it, and the level computation ignores it even if asked.
- **Learning loop:** once a day, new lessons go to `<config dir>/lessons/<day>.md` on a branch, opened as a PR. They reach main only when the owner merges. Advice that recurs across three or more tasks is listed as a skill candidate; turning one into a skill (with evals) stays a human step.
- **Also fixed:**
  - Each tick step is guarded on its own, so a GitHub error in reconcile no longer stops landing.
  - Coordinator tests now use fixed machine readings; CI macOS runners' low disk had held dispatch.
  - A task blocked before any claim now reaches its owner's inbox.
  - release.mjs returns to the starting commit when run detached.
  - Each fix has a regression test.
- **Released:** v0.3.0 (steps 3 and 4), from a clean worktree after CI was green on all six OS x Node jobs.
- **Unproven until the always-on machine:** promotion and demotion thresholds against real work (defaults: 10 tasks in 7 days, pass rate 0.8, unverified claims 0.1, zero reverts); report posting with real GitHub permissions; lessons PRs opened by the coordinator's token.

## Step 6: the remaining dashboard pages and a desktop window (2026-10-08)

- **Pages:**
  - **Land queue:** queued changes in order, deferred ones with the reason; what's in review; recent batches with outcome; lessons PRs.
  - **Agents:** the governor's state, machine-wide slots, spend by role, runs in flight with their last heartbeat, recent runs with outcome and cost.
  - **Activity:** every event, filterable by group and text.
  - **Deploys:** what each environment serves, landed but unverified changes, and history linked to issues.
  - **Reports:** the scorecard against the previous week, trust stage with health reasons and daily checks, a preview of the next report, posted reports.
  - **Settings:** read-only config; commands, connection fingerprints and deploy details stay out, and a test checks that.
- **Keyboard:** the new `g` chords exposed a real hazard. Page listeners run before the app's, so `g a` on Decisions would have approved the selected decision. Page shortcuts now refuse keys while a chord is pending.
- **Desktop window:** `worklane dashboard --app` opens the dashboard in a Tauri 2 shell built from source (`npm run build:desktop`), falling back to the browser. The shell accepts only a loopback http URL, keeps navigation on that origin, gets no IPC, and closing it stops the server. Rust tests cover both guards; CI runs them on macOS.
- **Bug found by the demo:** with a deploy target, the scorecard counted no tasks as done. Done is now landed with no deploy target, or verified on an environment; regression test included.
- **Verified:** projection and API tests; screenshots of every new page against the demo (headless Chrome now runs with its own `--timeout`; the virtual-time budget never settles while the live stream is open).
- **Unproven:** the desktop shell on Windows and Linux (built and tested on macOS only); a human using the pages.

## Step 7: optional roles (2026-10-08)

- **Roles:** security, red_attributor, ci_repair, qa_playtester, monitor and release_prep. All are off by default, read-only (Read, Glob, Grep, read-only git; Edit and Write disallowed) and counted against the budget and governor. Each fires once per trigger. Their output becomes issues, comments or a higher review level; none edits code, deploys, tags or holds a write token.
- **Security:** sits in the task pipeline after the verdict, for its `applies_to` categories. Block means L3, concerns mean L2, never lower. Findings set a floor under its own verdict, and a reviewer that touches the worktree counts as a block.
- **Red attributor:** when main's baseline grows, a single landing in the window is blamed without an agent; with several, the agent attributes each failure or says unknown. The owner is told on their issue, and a triage issue is filed.
- **CI repair:** one diagnosed triage issue per red tip, with a proposed done_when contract; at most `max_fixes_per_pr` open at a time.
- **QA playtester:** each verified test deployment once, never production; capped per day; bugs de-duplicated by title. It needs a project-supplied browser tool (`tools`).
- **Monitor:** every `every_minutes`, re-runs each environment's verify check. A pass-to-fail change opens an incident with a diagnosis (production incidents say a human must act); a recovery is noted.
- **Release prep:** once a day, release notes for changes since the last tag, opened as a PR.
- **Verified:** a test per role with a scripted runner and a real git remote; a pipeline test where a blocking security review sends the change to the owner as L3 with the finding; a test that every role defaults off and a pass runs no agent.
- **Unproven until the always-on machine:** every role against a real model; the QA role needs a browser tool the project chooses; the monitor's schedule against real verify checks.
