# Dashboard feature map

Every page and feature of the dashboard, how a person reaches it, and how a
script finds it. `scripts/dev/control-dashboard.mjs` reads this file: `open
<page>` takes a page id from the first table, and `check` opens every page in
it. `test/feature-map.test.ts` fails when a route, page file, sidebar row,
shortcut or `data-testid` in `web/src/` is missing here, or when this file
names one that no longer exists. Change the map in the same commit as the UI.

Selectors: prefer `[data-testid="…"]`. Until a page has test ids, the
**Ready when** column is the text of the page's heading (`main header h1`),
which the control script waits for after navigating. `<n>` is an issue
number, `<id>` a run id.

## Pages

| Page | Route | File | Sidebar | Shortcut | Ready when |
|---|---|---|---|---|---|
| `overview` | `/` | `web/src/pages/Overview.tsx` | Overview | `g o` | `Overview` |
| `inbox` | `/inbox` | `web/src/pages/Inbox.tsx` | Inbox | `g i` | `Inbox` |
| `decisions` | `/decisions` | `web/src/pages/Decisions.tsx` | Decisions | `g d` | `Decisions` |
| `issues` | `/issues` | `web/src/pages/Issues.tsx` | Issues | `g s` | `Issues` |
| `issue-detail` | `/issues/<n>` | `web/src/pages/IssueDetail.tsx` | – | `Enter` on an issue row | `#<n>` |
| `land` | `/land` | `web/src/pages/Landing.tsx` | Land queue | `g l` | `Land queue` |
| `prs` | `/prs` | `web/src/pages/PullRequests.tsx` | Pull requests | `g p` | `Pull requests` |
| `agents` | `/agents` | `web/src/pages/Agents.tsx` | Agents | `g a` | `Agents` |
| `activity` | `/activity` | `web/src/pages/Activity.tsx` | Activity | `g e` | `Activity` |
| `deploys` | `/deploys` | `web/src/pages/Deploys.tsx` | Deploys | `g y` | `Deploys` |
| `reports` | `/reports` | `web/src/pages/Reports.tsx` | Reports | `g r` | `Reports` |
| `logs` | `/logs` | `web/src/pages/Logs.tsx` | Logs | `g j` | `Logs` |
| `settings` | `/settings` | `web/src/pages/Settings.tsx` | Settings | `g ,` | `Settings` |
| `run-detail` | `/runs/<id>` | `web/src/pages/RunDetail.tsx` | – | a run row on an issue page | `run` |

Any other path shows Overview.

## Features

| Feature | Where | How a person reaches it | Keys | Selector |
|---|---|---|---|---|
| Sidebar navigation | every page | the left column; the current page is highlighted | `g` then the page's key (table above) | `aside nav a[href="<route>"]` |
| Pull requests row | every page | its sidebar row, with a count of PRs waiting for you | `g p` | `[data-testid="nav-prs"]` |
| Command menu | every page | the sidebar's Search field | `⌘K` / `Ctrl+K` | `[cmdk-root]` |
| Theme toggle | every page | sun/moon button at the bottom of the sidebar | – | `button[aria-label="Toggle theme"]` |
| Live indicator | every page | dot and event count at the bottom of the sidebar | – | `aside` footer text `Live` |
| Instance switcher | every page, hub only | the list at the top of the sidebar | – | `aside` instance list |
| Emergency-stop banner | every page, while a stop is in force | shown at the top of the page | – | `[data-emergency-stop]` |
| Decision answers | `decisions`, `inbox` | one button per option on a decision card | `1`–`9`, `a` approve, `r` reject, `j`/`k` move | decision card buttons |
| Show answered | `decisions` | header button | – | button text `Show answered` |
| Issue tabs and views | `issues` | Current / Planning / Backlog / Done tabs, built-in and saved views | – | tab and view buttons |
| Issue filters and search | `issues` | owner, status, level, label and text filters | `/` focuses search, `Esc` leaves it | search input |
| List or board | `issues` | toggle in the header | `b` | header toggle |
| Move between issues | `issues` | – | `j`/`k`, `Enter` opens | issue rows |
| Back to issues | `issue-detail` | – | `Esc` | – |
| Checks run by the coordinator | `issue-detail` | the checks card, newest run first | – | checks card |
| Agent runs of an issue | `issue-detail` | the runs card; a row opens `run-detail` | – | runs card rows |
| Next report preview | `reports` | the preview card | – | preview card |
| Pull requests page | `prs` | the page itself | – | `[data-testid="prs-page"]` |
| Auto-merge state | `prs` | the card at the top: on or off, why, the kill switch and the repo's setting | – | `[data-testid="prs-auto-merge"]`, `[data-testid="prs-auto-merge-state"]`, `[data-testid="prs-auto-merge-why"]` |
| Last auto-merge stop and its revert | `prs` | the auto-merge card's last line, after a stop | – | `[data-testid="prs-revert-link"]` |
| PRs waiting for you | `prs` | the "Waiting for you" section: one card per PR | – | `[data-testid="prs-waiting"]`, `[data-testid="pr-wait-card"]` |
| Why a PR waits | `prs` | the reasons on a waiting card | – | `[data-testid="pr-wait-reasons"]` |
| A PR's links | `prs` | the PR number, its issue, and Review on GitHub | – | `[data-testid="pr-link"]`, `[data-testid="pr-issue-link"]`, `[data-testid="pr-review-link"]` |
| A PR's checks and fix runs | `prs` | the check pills and the fix-run count on a card or row | – | `[data-testid="pr-checks"]`, `[data-testid="pr-fixes"]` |
| PRs in progress | `prs` | the "In progress" list; a row expands | – | `[data-testid="prs-in-progress"]`, `[data-testid="pr-row"]`, `[data-testid="pr-github-link"]` |
| Auto-merged PRs | `prs` | the "Auto-merged" table: merge commit, main afterwards, why it merged | – | `[data-testid="prs-auto-merged"]`, `[data-testid="prs-auto-merged-table"]`, `[data-testid="pr-merged-row"]`, `[data-testid="pr-merge-commit-link"]`, `[data-testid="pr-merge-reasons"]` |
| Closed without merging | `prs` | the "Closed" list | – | `[data-testid="prs-closed"]` |
| Refused pushes | `prs` | the "Pushes the harness refused" table | – | `[data-testid="prs-refused"]`, `[data-testid="prs-refused-table"]`, `[data-testid="refused-row"]`, `[data-testid="refused-issue-link"]` |
