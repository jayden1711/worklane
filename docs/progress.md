# Progress

One short note per step: what shipped, how it was verified, what's still unproven.

## Steps 0-2 (2026-10-07)

- **Step 0:** scaffold, open-source hygiene, prior art, design, names. Repo history cleaned of project specifics.
- **Step 1 (v0.1.0, v0.1.1):** config schemas, `install`/`doctor`, guardrail hooks (agent and human modes), secret scanning on commits and transcripts, vacuity check, Stop gate, rule-conflict check, production read path, machine-wide slots and run queue. CI on macOS, Linux and Windows.
- **Step 2 (v0.2.0):** event log, verified backups, compare-and-swap claims, GitHub backlog, review levels, coordinator (repro-first evaluator, independent verify, serial land queue, staging verification), baseline gate, investigations, skill evals.
  - Verified live with the real `claude` CLI on a local demo repo.
  - Unproven until the NUC: a coordinator running for days; real GitHub issues end to end.

## Step 3: dashboard v0 (2026-10-08)

- **What:** a local dashboard served by `worklane dashboard`. Pages: Overview, Inbox, Decisions, Issues (list and board, tabs, filter chips, saved views, swimlanes by area) and an issue detail page with a properties panel.
- **Interaction:** Cmd+K menu, keyboard-first (`g` chords, `j`/`k`, `1-9`/`a`/`r` to answer decisions, `/` to search, `b` to toggle board), dark and light themes.
- **Data:** reads only the event log, through a pure projection. Live updates arrive over one SSE stream. Binds to 127.0.0.1 with a per-install token. Its one write is a human answering a decision, recorded as an event.
- **UI stack:** React + Tailwind, components in the style of shadcn/ui (MIT), cmdk and Radix. Bundled licenses ship in `dist/web/licenses.txt`.
- **Demo:** `worklane demo <dir>` seeds a project worked by the real coordinator with scripted agents, covering every state.
- **Verified:** API tests (token, SSE on log growth from another process, decisions recorded once with a valid option, path traversal blocked, saved views). Projection tests. Headless-Chrome screenshots of every page read and checked.
- **Bugs the screenshots found:** the coordinator re-recorded unchanged issues every tick (now only on change, with a regression test); avatar fallback; CLI option parsing.
- **Unproven:** the Chrome extension couldn't reach this Mac's localhost, so screenshots came from a local headless Chrome. Not yet used by a human.
