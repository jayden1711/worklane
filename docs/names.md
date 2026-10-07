# Name candidates

**Decision (2026-10-07): Worklane.** GitHub org `worklane-dev` is free (checked 2026-10-07) for a later move; the repo stays at `jayden1711/worklane` for now.

Checked 2026-10-07. "Pitcrew" was dropped: GitHub org taken, all three domains registered, and `@stucm/pit-crew` (2026-09-22) is a near-identical coding-agent harness.

## How each name was checked

- **GitHub org:** `gh api users/<name>`.
- **npm scope:** `registry.npmjs.org/-/org/<name>/package`. A 404 means no npm org exists. A personal npm *user* with that name can't be detected without trying to register it.
- **Bare npm name:** `npm view <name>`.
- **Collisions:** `gh search repos`, restricted to dev and agent tools.
- Domains were skipped, as requested.

## Ranked

| # | Name | GitHub org | npm `@scope` org | Bare npm | Dev/agent collisions | Notes |
|---|---|---|---|---|---|---|
| 1 | **Rollcall** | taken (2014 org, 1 repo) | free | free | none in dev/agent tools. Nearest: `withtally/rollcall` (77★, cross-chain governance libs), attendance apps | Fits "who's on which task". `rollcall up`, `rollcall doctor` read well. **Current working name.** |
| 2 | **Taskhouse** | taken (2018 org, 3 repos) | free | free | none; one abandoned 0★ repo | Plain and descriptive, but generic. |
| 3 | **Worklane** | taken (user, 0 repos) | free | free | `ericgichuri/worklane` (1★, workflow automation) | "Lane" echoes the land queue. Weak collision. |
| 4 | **Crewroom** | taken (user since 2025, 0 repos) | free | free | a few 0-1★ unrelated repos | Close to Pitcrew's "crew" metaphor without the racing theme. |
| 5 | **Shopwork** | taken (2014 org, 0 repos) | free | free | `shopworker` repos (Shopify scripts, ~20★) | The Shopify association weakens it. |

**Rejected:**
- Taken npm scope or a direct agent-tool collision: docket, rota, tandem, steward, quorum, joinery, tally, handoff, overseer, cohort, atelier, workroom, benchwork, teamroom, openbench, floorplan.
- Strong collisions in the agent space:
  - **headcount:** `cbrock84/headcount`, 2k★ "agent organization structured as a company".
  - **handover:** `AgentHandover`, 699★.
  - **taskyard:** an agent-first PM tool.

None of the five has a free GitHub org of the exact name. The repo stays under `jayden1711` for now; when moving to an org, use a variant such as `<name>-dev` or `<name>hq`.
