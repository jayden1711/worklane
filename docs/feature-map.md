# Dashboard feature map

Every page and feature of the dashboard, how a person reaches it, and how a
script finds it. `scripts/dev/control-dashboard.mjs` reads this file: `open
<page>` takes a page id from the first table, and `check` opens every page in
it. `test/feature-map.test.ts` fails when a route, page file, sidebar row,
shortcut or `data-testid` in `web/src/` is missing here, or when this file
names one that no longer exists. Change the map in the same commit as the UI.

Selectors are `[data-testid="…"]`. A page is open once its **Root** element
is there and its heading (`[data-testid="page-title"]`, inside
`main header`) contains the **Ready when** text. `<n>` is an issue number,
`<id>` a run id.

## Pages

| Page | Route | File | Sidebar | Shortcut | Root | Ready when |
|---|---|---|---|---|---|---|
| `overview` | `/` | `web/src/pages/Overview.tsx` | Overview | `g o` | `[data-testid="page-overview"]` | `Overview` |
| `inbox` | `/inbox` | `web/src/pages/Inbox.tsx` | Inbox | `g i` | `[data-testid="page-inbox"]` | `Inbox` |
| `decisions` | `/decisions` | `web/src/pages/Decisions.tsx` | Decisions | `g d` | `[data-testid="page-decisions"]` | `Decisions` |
| `issues` | `/issues` | `web/src/pages/Issues.tsx` | Issues | `g s` | `[data-testid="page-issues"]` | `Issues` |
| `issue-detail` | `/issues/<n>` | `web/src/pages/IssueDetail.tsx` | – | `Enter` on an issue row | `[data-testid="page-issue-detail"]` | `#<n>` |
| `land` | `/land` | `web/src/pages/Landing.tsx` | Land queue | `g l` | `[data-testid="page-land"]` | `Land queue` |
| `prs` | `/prs` | `web/src/pages/PullRequests.tsx` | Pull requests | `g p` | `[data-testid="page-prs"]` | `Pull requests` |
| `agents` | `/agents` | `web/src/pages/Agents.tsx` | Agents | `g a` | `[data-testid="page-agents"]` | `Agents` |
| `activity` | `/activity` | `web/src/pages/Activity.tsx` | Activity | `g e` | `[data-testid="page-activity"]` | `Activity` |
| `deploys` | `/deploys` | `web/src/pages/Deploys.tsx` | Deploys | `g y` | `[data-testid="page-deploys"]` | `Deploys` |
| `reports` | `/reports` | `web/src/pages/Reports.tsx` | Reports | `g r` | `[data-testid="page-reports"]` | `Reports` |
| `logs` | `/logs` | `web/src/pages/Logs.tsx` | Logs | `g j` | `[data-testid="page-logs"]` | `Logs` |
| `settings` | `/settings` | `web/src/pages/Settings.tsx` | Settings | `g ,` | `[data-testid="page-settings"]` | `Settings` |
| `run-detail` | `/runs/<id>` | `web/src/pages/RunDetail.tsx` | – | a run row on an issue page | `[data-testid="page-run-detail"]` | `run` |

Any other path shows Overview.

## Features

| Feature | Where | How a person reaches it | Keys | Selector |
|---|---|---|---|---|
| Page heading | every page | the bar at the top of the page | – | `[data-testid="page-title"]` |
| Sidebar navigation | every page | the left column; the current page is highlighted. Rows: `nav-overview`, `nav-inbox`, `nav-decisions`, `nav-issues`, `nav-land`, `nav-prs`, `nav-agents`, `nav-activity`, `nav-deploys`, `nav-reports`, `nav-logs`, `nav-settings` | `g` then the page's key (table above) | `[data-testid="nav-overview"]`, `[data-testid="nav-inbox"]`, `[data-testid="nav-decisions"]`, `[data-testid="nav-issues"]`, `[data-testid="nav-land"]`, `[data-testid="nav-prs"]`, `[data-testid="nav-agents"]`, `[data-testid="nav-activity"]`, `[data-testid="nav-deploys"]`, `[data-testid="nav-reports"]`, `[data-testid="nav-logs"]`, `[data-testid="nav-settings"]` |
| Pull requests count | every page | the Pull requests row shows how many PRs wait for you | `g p` | `[data-testid="nav-prs"]` |
| Command menu | every page | the sidebar's Search field | `⌘K` / `Ctrl+K` | `[data-testid="search-button"]`, `[data-testid="command-menu"]` |
| Theme toggle | every page | sun/moon button at the bottom of the sidebar | – | `[data-testid="theme-toggle"]` |
| Live indicator | every page | dot and event count at the bottom of the sidebar | – | `[data-testid="live-indicator"]` |
| Instance switcher | every page, hub only | the list at the top of the sidebar | – | `[data-testid="instance-switcher"]`, `[data-testid="instance-row"]` |
| Emergency-stop banner | every page, while a stop is in force | shown at the top of the page | – | `[data-testid="emergency-stop"]` |
| Decision answers | `decisions`, `inbox` | one button per option on a decision card | `1`–`9`, `a` approve, `r` reject, `j`/`k` move | `[data-testid="decision-card"]`, `[data-testid="decision-option"]` |
| Show answered | `decisions` | header button | – | `[data-testid="show-answered"]` |
| Issue tabs and views | `issues` | Current / Planning / Backlog / Done tabs, built-in and saved views | – | `[data-testid="issues-tab"]` |
| Issue filters and search | `issues` | owner, status, level, label and text filters | `/` focuses search, `Esc` leaves it | `[data-testid="issues-filter"]` |
| List or board | `issues` | toggle in the header | `b` | `[data-testid="issues-list-mode"]`, `[data-testid="issues-board-mode"]` |
| Move between issues | `issues` | rows in the list, cards on the board | `j`/`k`, `Enter` opens | `[data-testid="issue-row"]`, `[data-testid="issue-card"]` |
| Back to issues | `issue-detail` | – | `Esc` | – |
| Checks run by the coordinator | `issue-detail` | the checks card, newest run first; one table per run | – | `[data-testid="checks-card"]`, `[data-testid="checks-table"]` |
| Agent runs of an issue | `issue-detail` | the runs card; a row opens `run-detail` | – | `[data-testid="runs-card"]`, `[data-testid="run-row"]` |
| A run's steps and final message | `run-detail` | the steps card and the final message | – | `[data-testid="run-steps"]`, `[data-testid="run-final"]` |
| Next report preview | `reports` | the preview card | – | `[data-testid="report-preview"]` |
| Pull requests page | `prs` | the page itself | – | `[data-testid="prs-page"]` |
| Auto-merge state | `prs` | the card at the top: on or off, why, the kill switch and the repo's setting | – | `[data-testid="prs-auto-merge"]`, `[data-testid="prs-auto-merge-state"]`, `[data-testid="prs-auto-merge-why"]` |
| Last auto-merge stop and its revert | `prs` | the auto-merge card's last line, after a stop | – | `[data-testid="prs-revert-link"]` |
| PRs waiting for you | `prs` | the "Waiting for you" section: one card per PR | – | `[data-testid="prs-waiting"]`, `[data-testid="pr-wait-card"]` |
| Why a PR waits | `prs` | on a waiting card: why the merge rules left it to you, and why a CI fix run stopped | – | `[data-testid="pr-wait-reasons"]`, `[data-testid="pr-gave-up-reasons"]` |
| A PR's links | `prs` | the PR number, its issue, and Review on GitHub | – | `[data-testid="pr-link"]`, `[data-testid="pr-issue-link"]`, `[data-testid="pr-review-link"]` |
| A PR's checks and fix runs | `prs` | the check pills and the fix-run count on a card or row | – | `[data-testid="pr-checks"]`, `[data-testid="pr-fixes"]` |
| PRs in progress | `prs` | the "In progress" list; a row expands | – | `[data-testid="prs-in-progress"]`, `[data-testid="pr-row"]`, `[data-testid="pr-github-link"]` |
| Auto-merged PRs | `prs` | the "Auto-merged" table: merge commit, main afterwards, why it merged | – | `[data-testid="prs-auto-merged"]`, `[data-testid="prs-auto-merged-table"]`, `[data-testid="pr-merged-row"]`, `[data-testid="pr-merge-commit-link"]`, `[data-testid="pr-merge-reasons"]` |
| Closed without merging | `prs` | the "Closed" list | – | `[data-testid="prs-closed"]` |
| Refused pushes | `prs` | the "Pushes the harness refused" table | – | `[data-testid="prs-refused"]`, `[data-testid="prs-refused-table"]`, `[data-testid="refused-row"]`, `[data-testid="refused-issue-link"]` |
| Machine health | `overview` | the "Machine health" section below the headline figures; on a hub it also compares the instances | – | `[data-testid="health-panel"]` |
| Health suggestions | `overview` | the Suggestions card: each line a suggestion ("Consider …"), or "Nothing to suggest" | – | `[data-testid="health-suggestions"]`, `[data-testid="health-suggestion"]` |
| Memory, swap, load and disk | `overview` | the health figures: memory available, swap in use, 5-minute load, free disk per volume | – | `[data-testid="health-machine"]`, `[data-testid="health-memory"]`, `[data-testid="health-swap"]`, `[data-testid="health-load"]`, `[data-testid="health-disk"]` |
| The harness's services | `overview` | the services table: state, memory against its limit, swap, CPU time | – | `[data-testid="health-units"]`, `[data-testid="health-unit-row"]` |
| Instances side by side | `overview`, hub only | the instances table: service memory, today's runs, estimated cost, usage-limit hits, suggestions | – | `[data-testid="health-instances"]`, `[data-testid="health-instance-row"]` |
| Check times | `overview` | the Check times table: last 5 against before, change, recent runs (hover a point for its time); a check that got slower is flagged | – | `[data-testid="health-checks"]`, `[data-testid="health-checks-table"]`, `[data-testid="health-check-row"]`, `[data-testid="health-regression"]`, `[data-testid="health-sparkline"]` |
| Claude usage per day | `overview` | the usage table, and the note that the subscription's remaining quota isn't visible | – | `[data-testid="health-usage"]`, `[data-testid="health-usage-table"]`, `[data-testid="health-usage-row"]`, `[data-testid="health-quota-note"]` |
| What wasn't measured | `overview` | the last line of the health section, when the machine couldn't be read in full | – | `[data-testid="health-unavailable"]` |
