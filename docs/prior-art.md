# Prior art

Swept 2026-10-07. Repo facts (stars, SPDX license, last push, archived) were checked with `gh api`. Behavior comes from READMEs, docs and the most-discussed issues. Anything marked *(unverified)* is from secondary sources or memory.

## License key

| Mark | Meaning |
|---|---|
| ✅ | MIT, BSD or Apache-2.0. Code may be reused with credit in `THIRD_PARTY_NOTICES.md`. |
| 🚫 | AGPL, GPL, SSPL, BUSL, FSL, Commons Clause, source-available, custom, or no license. **Design reference only; no code copied.** |

No code has been copied so far. Everything below is a pattern we re-implement.

---

## 1. Multi-agent orchestrators

| Project | ★ | License | Status | What it does |
|---|---|---|---|---|
| [openai/symphony](https://github.com/openai/symphony) | 27.6k | ✅ Apache-2.0 | alive ("engineering preview") | Spec + Elixir daemon: polls a tracker, one workspace per issue, bounded concurrency, policy in `WORKFLOW.md` |
| [sortie-ai/sortie](https://github.com/sortie-ai/sortie) | 196 | ✅ Apache-2.0 | alive | Go + SQLite implementation of the Symphony model; supports GitHub Issues and Claude Code |
| [sipyourdrink-ltd/bernstein](https://github.com/sipyourdrink-ltd/bernstein) | 1.4k | ✅ Apache-2.0 | alive, beta | Deterministic Python scheduler, "janitor" that verifies concrete signals, replay journal, signed receipts |
| [OrchestratorInc/agent-orchestrator](https://github.com/OrchestratorInc/agent-orchestrator) (ex-Composio) | 12.9k | ✅ Apache-2.0 | alive | Daemon + desktop app; one task = one agent = one worktree; Kanban built from facts |
| [gastownhall/gastown](https://github.com/gastownhall/gastown) + [beads](https://github.com/gastownhall/beads) | 18.3k / 27.7k | ✅ MIT | alive, slowing (successor: Gas City) | LLM "Mayor" + 20–30 tmux workers on a git-backed issue graph; "Refinery" Bors-style merge queue |
| [paperclipai/paperclip](https://github.com/paperclipai/paperclip) | 98.4k | ✅ MIT | alive | "Company of agents" control plane: budgets, approval gates, activity log, atomic checkout |
| [coleam00/Archon](https://github.com/coleam00/Archon) | 23.6k | ✅ MIT | alive | YAML workflows mixing AI and bash nodes, worktree per run, approval gates, SQLite |
| [microsoft/conductor](https://github.com/microsoft/conductor) | 467 | ✅ MIT | alive | YAML multi-agent workflows with deterministic routing, human gates, DAG dashboard; Agent SDK provider |
| [Yeachan-Heo/oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) | 39.7k | ✅ MIT | alive | Claude Code plugin: plan → prd → exec → verify → fix team pipeline, tmux workers, HUD |
| [automazeio/ccpm](https://github.com/automazeio/ccpm) | 8.4k | ✅ MIT | dormant since 2026-03 | PRD → epic → GitHub Issues → worktrees → parallel agents, as slash commands |
| [no-human-ai/no_human](https://github.com/no-human-ai/no_human) | 330 | ✅ MIT | alive | Ticket → plan → coder → adversarial reviewer (different model, fresh session) → PR |
| [jedarden/NEEDLE](https://github.com/jedarden/NEEDLE) | 28 | ✅ MIT | alive | Headless workers on a shared SQLite queue with atomic claims and an explicit outcome state machine |
| [Get-Concord-AI/concord-mcp](https://github.com/Get-Concord-AI/concord-mcp) | 415 | ✅ MIT | alive | MCP server for file-level claims and overlap warnings between agents |
| [cyrusagents/cyrus](https://github.com/cyrusagents/cyrus) | 846 | ✅ Apache-2.0 | alive | Watches assigned Linear/GitHub issues, worktree per issue |
| [StuCM/pit-crew](https://github.com/StuCM/pit-crew) | 0 | ✅ Apache-2.0 | alive, tiny | Spec → worker in worktree → deterministic `crew gate` → read-only reviewer → human merge |
| [fcarrar/pitcrew](https://github.com/fcarrar/pitcrew) | 4 | ✅ MIT | tiny | 12 skills coordinating only through ticket states |
| [elicpeter/pitboss](https://github.com/elicpeter/pitboss) | 5 | ✅ Apache-2.0 | small | Rust CLI: one agent through a phased plan, commit per phase |
| [getcrew44/crew44](https://github.com/getcrew44/crew44) | 356 | ✅ MIT | quiet since 2026-06 | Local-first desktop app, append-only `events.jsonl` per chat, handover briefs |
| [orbi-build/orbi](https://github.com/orbi-build/orbi) | 195 | 🚫 AGPL-3.0 / SUL | alive | Timer picks `ai-ready` issues → worktree from frozen SHA → agent stops at commit → runner opens PR → independent review → merge reviewed SHA |
| [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad) | 8.6k | 🚫 AGPL-3.0 | alive | Go TUI: N agents in tmux, one worktree each |
| [briannaworkman/pitcrew](https://github.com/briannaworkman/pitcrew) | 2 | 🚫 no license | tiny | Label → 7-stage issue pipeline, one verifier per acceptance criterion |
| [multica-ai/multica](https://github.com/multica-ai/multica) | 52k | 🚫 Apache + extra conditions | alive | Managed-agents platform |
| [saltbo/agent-kanban](https://github.com/saltbo/agent-kanban) | 486 | 🚫 FSL-1.1 | alive | Agent Kanban |
| [ruvnet/ruflo](https://github.com/ruvnet/ruflo) (ex-claude-flow) | 74k | ✅ MIT | alive | LLM-driven swarms |

**What we take:**
- **Symphony / Sortie:** this is the closest blueprint for our coordinator.
  - Only the orchestrator mutates scheduling state.
  - Claim states: Unclaimed → Claimed → Running / RetryQueued → Released.
  - **Typed terminal reasons:** Succeeded, Failed, TimedOut, Stalled, CanceledByReconciliation.
  - **Every tick reconciles before it dispatches.** It re-reads tracker state, detects stalls from the time since the last agent event, and kills runs whose issue went terminal.
  - Backoff is `min(10s·2^(n-1), 5m)`.
  - Concurrency limits are global and per state.
  - Order is priority, then age, then id.
  - Workspace hooks: `after_create`, `before_run`, `after_run`, `before_remove`.
  - Path-safety invariants: cwd must equal the workspace, the workspace must be under the root, and keys are sanitized.
  - Startup cleanup of workspaces whose issues are terminal.
  - Tracker credentials stay host-side.
  - We *skip* Symphony's "no durable DB" stance. We keep SQLite and use tracker reconciliation as a cross-check.
- **Bernstein:** no LLM in the coordination loop; completion signals verified by code; a replayable journal; an optional hash-chained audit log.
  - Lesson from its issues: **store acceptance criteria on the task, not the attempt.** A retry that lost them looped forever.
- **Agent Orchestrator:** "display status is never stored; it is computed at read time from durable facts". SQLite facts are streamed to the UI over SSE.
  - Its "Needs you" column.
  - CI and review failures are routed back to the worker that owns the change.
- **Gas Town / Beads:**
  - Persistent worker identity with ephemeral sessions.
  - The Bors-style Refinery.
  - Severity-routed escalation into a human queue.
  - Atomic claim (assignee and in-progress together).
  - "Ready" means no open blockers.
  - A new session can read its predecessor's event log.
- **Paperclip:** atomic checkout with an execution lock; a wake queue that coalesces repeated wakeups; scoped budgets (agent, project, issue) with a warning threshold and a hard stop on recorded spend.
- **Orbi** 🚫 (ideas only):
  - Pin the base SHA at claim time.
  - **Only the reviewed head SHA may land.**
  - The agent stops at commit; a deterministic runner pushes.
  - One `run_id` across logs and GitHub comments.
  - A retry is a new run that keeps the old evidence.
  - Failures are classed as recoverable or not.
- **no_human:** an adversarial reviewer told to refute "done".
  - A **tamper guard** that mechanically counts deleted or skipped tests.
  - A reproduction gate: fails at the merge base, passes on the new tree.
  - Reports "NOT RUN" instead of claiming green when nothing ran.
  - Self-reported: the reviewer rejected 505 of 1,709 "done" claims.
- **StuCM/pit-crew:** a `files:` scope per task checked against the diff; `collisions` (unmerged branches touching the same files); a gate stamp re-verified at close; a cap on review rounds.
- **NEEDLE:** a shipped-work gate (a real commit must exist) before closing; explicit outcome paths.
- **Concord MCP:** soft file-level leases and overlap warnings as a hook, on top of worktree isolation.
- **Conductor:** an explicit `terminate` step with a reason; script steps that route on exit code; human gates answered from the dashboard; validation before runtime.
- **Archon:** deterministic nodes between agent nodes; a fresh context each loop iteration; workflows committed to the repo.
- **fcarrar/pitcrew:** only a human-facing path unblocks; a stale-sweep job prunes leaked worktrees and tickets whose state never caught up.
- **Pitboss:** the plan is read-only to agents; an agent-owned "deferred work" file is drained between phases.

**What we skip:**
- LLM coordinators: the Gas Town Mayor, OMC, CCPM, ruflo, fcarrar.
- Hard tmux dependency and pane scraping, which make Windows unworkable (claude-squad's top issue is "Error capturing pane content").
- Dolt, Electron weight, 25–50 adapters, and chat-platform breadth.

**Failure modes reported across these projects, and how we design against each:**

| Reported failure | Our counter |
|---|---|
| Orphan or zombie processes after a restart, crash or sleep | Persist pid and pgid **before** spawning; reap by process group; reconcile at startup; never match processes by name |
| Completion never detected | Use the SDK result message plus a stall timeout, not screen-scraping |
| Rate-limit pauses mistaken for hangs | Classify the error before using staleness to call a run stuck |
| Closed or merged work re-dispatched after a restart | Re-check tracker state before every dispatch; idempotent claims |
| Retry loops with no terminal outcome | Attempt cap and an explicit `blocked` state |
| Recovery logic reassigning a review to its own author | Coordinator enforces evaluator ≠ author |
| Wakeup or poll storms | Debounce and coalesce |
| Agents weakening tests to get green | Tamper guard plus reproduction gate |

## 2. Safety and verification

| Project | ★ | License | Status | TAKE | SKIP |
|---|---|---|---|---|---|
| [github/gh-aw](https://github.com/github/gh-aw) | 5.4k | ✅ MIT | alive | **Safe outputs**: agent holds a read-only token and writes NDJSON through a local MCP tool; a separate privileged step validates and applies. 7-stage validation, idempotent sanitizer, git-bundle patches with size and file limits, protected files on by default (unknown policy = block), staged dry-run, threat-detection pass, integrity filter for low-trust authors, threat model T1–T8 | Actions compiler and runtime |
| [OpenAutoCoder/Agentless](https://github.com/OpenAutoCoder/Agentless) | 2.1k | ✅ MIT | dormant (research) | Repro contract (`reproduced`/`resolved`/`other`); sample N tests, keep those that reproduce on base, majority vote; select regression tests that passed on base; rerank patches | SWE-bench and Docker scaffolding |
| [AutoCodeRoverSG/auto-code-rover](https://github.com/AutoCodeRoverSG/auto-code-rover) | 3.1k | 🚫 Sonar source-available | dormant | Reviewer sees the repro output on base and patched code and returns `{patch_correct, test_correct, advice}`; it can blame the *test* | all code |
| [affaan-m/ECC](https://github.com/affaan-m/ECC) | 275k | ✅ MIT | alive | plan → test → implement → review → verify → remember → improve loop; `tdd-workflow`, `verification-loop`, fresh-context `/code-review`; continuous learning where "instincts" are scored and promoted to skills by a human, with memory treated as "unreviewed context, not executable policy" | full install (conflicts with our hooks), the 293 skills, the learning daemon (Windows defects) |
| [affaan-m/agentshield](https://github.com/affaan-m/agentshield) | 1.3k | ✅ MIT | alive | 268 rules over hooks, MCP, permissions and agent config, graded A–F, with JSON output and a baseline. **Used as a dependency** (`ecc-agentshield`) in install, doctor and CI | – |
| [gitleaks/gitleaks](https://github.com/gitleaks/gitleaks) | 29.8k | ✅ MIT | **security patches only** | `git --staged` on commits; `stdin`/`dir` with `--max-decode-depth` for transcripts; `--redact`. Note that `SKIP=gitleaks` bypasses the pre-commit hook, so we re-scan at land | – |
| [betterleaks/betterleaks](https://github.com/betterleaks/betterleaks) | 2.2k | ✅ MIT | alive (gitleaks author) | migration target behind our scanner adapter; can validate whether a secret is live | – |
| [stryker-mutator/stryker-js](https://github.com/stryker-mutator/stryker-js) | 3.2k | ✅ Apache-2.0 | alive | `--incremental`; mutate only changed line ranges; `thresholds.break` gate. Runs nightly and on money-path changes | full-repo runs per change; its change detection is exact only for jest/vitest |
| [protectai/llm-guard](https://github.com/protectai/llm-guard) | – | MIT | **archived** | – | dead |

## 3. Merge and land

| Project | ★ | License | Status | TAKE | SKIP |
|---|---|---|---|---|---|
| [bors-ng/bors-ng](https://github.com/bors-ng/bors-ng) | 1.5k | ✅ Apache-2.0 | **archived** 2024 | staging branch = main + batch; fast-forward on green; split in half on red; failing singleton goes back to its author. Retry once before splitting (flaky tests) | one batch in flight |
| Mergify ([docs](https://github.com/Mergifyio/docs)) | – | SaaS (engine repo Apache, stale) | alive | **The bisection we copy**: seed the batch with the queue head; fill by scope similarity; on failure cancel later batches, split into k cumulative prefixes (never retesting the known-bad full set), test in parallel, land the longest passing prefix, recurse; only rerun the tests that failed in the parent; cap resolution attempts | – |
| GitHub merge queue | – | – | – | Available only for public org repos or Enterprise Cloud; **not** private Free/Pro/Team repos. Ejects the failing PR rather than bisecting. An optional hand-off in `pr` mode | default dependency |
| GitLab merge trains | – | – | Premium+ | Speculative cumulative pipelines in parallel (step 4+ option) | – |
| [funador/claude-code-merge-queue](https://github.com/funador/claude-code-merge-queue) | 128 | ✅ MIT | alive | Local queue for parallel Claude worktrees; **pid-liveness locks, not timeouts**; abort on rebase conflict and never guess; production promotion human-only; a port per lane; symlinked `.env`/`node_modules` | strictly serial; not a security boundary (its README says so) |
| Uber SubmitQueue (EuroSys '19) *(unverified details)* | – | paper | – | Changes with disjoint affected targets are independent and can batch freely | ML success prediction |
| [chdsbd/kodiak](https://github.com/chdsbd/kodiak) | 1.1k | 🚫 AGPL-3.0 | low activity | label-driven intent; update a branch only when it's next in line | code |
| [renovatebot/renovate](https://github.com/renovatebot/renovate) | 22.7k | 🚫 AGPL-3.0 | alive | grouping rules and concurrency/hourly limits as a model for "compatible" batches and landing rate | code |

## 4. Agent ↔ tracker

| Project | ★ | License | TAKE | SKIP |
|---|---|---|---|---|
| Linear agents ([docs](https://linear.app/developers/agents)) | – | – | Delegating sets **`delegate`, not `assignee`**, so a human keeps ownership. Typed activities (`thought`, `elicitation`, `action`, `response`, `error`); session state is derived from the last activity and never set directly; an acknowledgement SLA (10s) | Linear-specific APIs |
| [anthropics/claude-code-action](https://github.com/anthropics/claude-code-action) | 9.4k | ✅ MIT | Only write-access actors trigger runs; bots are denied unless allowlisted; `.claude/`, `CLAUDE.md` and `.mcp.json` are restored from base on PRs; its sanitizer list (HTML comments, invisible characters, alt text); by default a human opens the PR | the agent holding a write token |
| OpenHands resolver | – | ✅ MIT | label-as-trigger; a draft PR on success, a comment on failure *(unverified; the resolver no longer appears in the current repo, and the old one is archived)* | – |
| GitHub claim atomicity | – | – | The Issues API has **no compare-and-swap**: assign, label and comment are all last-writer-wins. **Creating a git ref is atomic** (the API returns 422 if it exists), and `--force-with-lease` gives compare-and-swap for leases. Our claim protocol uses this | comment-ID ordering (racy) |

## 5. Workflow practice

**Boris Cherny** (the Claude Code creator's workflow, Jan 2026; sources: [InfoQ summary](https://infoq.com/news/2026/01/claude-code-creator-workflow/) and his X threads).
- About 5 local plus 5–10 web sessions, each in its own checkout.
- Plan mode first, then auto-accept.
- A team CLAUDE.md of about 2.5k tokens, in git.
- Slash commands in `.claude/commands/` that precompute with inline bash.
- Subagents: `code-simplifier`, `verify-app`.
- A PostToolUse formatter hook.
- Pre-approved permissions instead of skip-permissions.
- His top tip: **give Claude a verification loop** (2–3x quality).

**We take all of it.**
- One worktree per worker.
- Plan mode for M and L tasks.
- The Stop gate as the verification loop.
- A formatter only when the project has one.
- A permission allowlist from config.
- A lean CLAUDE.md, linted in `doctor`.

**Lauren Tan** (Cursor; [pstack](https://github.com/cursor/plugins/tree/main/pstack), MIT).
- The "SpaceXAI" framing comes only from reposts; the primary source is pstack.
- Verified ideas:
  - A standing coordinator that never writes code.
  - "**Earn the trust before the loop**": autopilot-stack (a human lands work, each piece carrying a verifier verdict) comes before autopilot-full (auto-merge).
  - "No owner merges on its own verdict." Fresh verifiers re-run on every push that changes the patch, and a merge needs a clean verdict on the exact patch.
  - A `decisions.tsv` audit per run.
  - Repo design for agents that "take the shortest path that compiles" (the source of our "make the correct path the shortest").
  - Blind A/B evals for skill and prompt changes.
  - A separate PM role and "evals as unit tests" are not in the primary source; we keep both as our own choices.

**We take:**
- the deterministic coordinator
- evaluator ≠ author
- landing only the verified SHA
- trust stages as explicit config
- blind A/B evals for skills

**We skip** "20+ agents" as a starting point; she warns against it.

## 6. UI

| Item | License | Verdict |
|---|---|---|
| Linear ([display options](https://linear.app/docs/display-options), [views](https://linear.app/docs/custom-views)) | – | Design reference: Cmd/Ctrl+K, `/` search, list/board toggle, grouping, saved and starred views, go-to chords, right-hand properties panel |
| [makeplane/plane](https://github.com/makeplane/plane) | 🚫 AGPL-3.0 | Design reference only (saved views, keyboard nav, issue detail, live multi-user) |
| [shadcn/ui](https://github.com/shadcn-ui/ui) + Radix | ✅ MIT | **Base component layer.** "Beautifully designed" is its tagline, and the likeliest meaning of "Beautiful UI components" |
| [cmdk](https://github.com/dip/cmdk) | ✅ MIT | Cmd+K menu (wrapped by shadcn's Command component) |
| TanStack Router, Table, Query | ✅ MIT | routing, issue tables, data |
| [HeroUI](https://github.com/heroui-inc/heroui), Magic UI | ✅ Apache-2.0 / MIT | optional pieces if needed |
| react-bits | 🚫 MIT + Commons Clause | skip |
| Origin UI / coss | 🚫 AGPL-3.0 | skip |
| Tremor | ✅ Apache-2.0 | stale since 2025-10; skip |
| [Tauri](https://github.com/tauri-apps/tauri) v2.12 | ✅ Apache-2.0/MIT | desktop wrapper in step 6; v3 is alpha, so wait |

Live transport: **SSE**, one multiplexed stream that resumes from `Last-Event-ID`, with actions sent as POST. WebSocket only if a two-way terminal ever needs it.

## 7. Platform building blocks

| Need | Choice | License | Why |
|---|---|---|---|
| Agent runtime | `@anthropic-ai/claude-agent-sdk` | Anthropic terms (not OSS) | npm dependency, never vendored. `settingSources:['project']` keeps user plugins out; Stop hook `decision:block`; `maxBudgetUsd`; `modelUsage` for cost; sandbox on macOS, Linux and WSL2 only |
| Event log | `node:sqlite` (Node ≥ 24) | built-in | no native build; better-sqlite3 (MIT) as fallback behind the data-access layer |
| Config | `yaml` + `zod` 4 | ISC / MIT | `z.toJSONSchema()` for editor support |
| Locks | `open(wx)` + pid liveness; SQLite leases | built-in | proper-lockfile is unmaintained since 2022 |
| Services | generated launchd plist, systemd user unit, schtasks | built-in | node-windows, node-mac and node-linux are all dead |
| Load and disk | `os.loadavg` (CPU deltas on Windows), `fs.statfs` | built-in | systeminformation not needed |

## 8. Known dead or sunsetting (don't depend on these)

| Project | Status |
|---|---|
| Vibe Kanban (BloopAI) | README: "sunsetting" |
| Crystal (stravu) | became Nimbalyst; last push 2026-02 |
| uzi (devflowinc) | no push since 2025-06 |
| GSD | archived; moved to open-gsd/gsd-core |
| Roo Code | **archived** 2026-05 |
| Continue | README: "no longer actively maintained… read-only" |
| Sweep | pivoted; no push since 2025-09 |
| LLM Guard | **archived** |
| AutoGen | maintenance mode; successor is Microsoft Agent Framework |
| Daytona (public repo) | **archived**; development moved private in 2026-06 |
| CCPM | dormant 7 months (still a fine reference) |
| gitleaks | security patches only; plan a move to betterleaks |
