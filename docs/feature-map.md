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
