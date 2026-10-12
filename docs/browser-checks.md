# Browser checks for a project's app

Status: being built as modules (Track B). Nothing runs yet: the coordinator doesn't start apps or run browser
checks until Track B's wiring lands, and a project without an app never will.

A project with a web app can have its changes checked in a real browser: the harness starts the app in the
task's worktree, drives headless Chromium through named flows, and records console errors, failed and slow
requests, a performance-trace summary and a screenshot. A UI fix is reproduced first (evidence attached), fixed,
and the same flow run again (after-evidence attached). Only PRs that touch the app's UI paths, or issues that
ask for it, run a browser check; everything else pays nothing.

## `.worklane/app.yaml`

Optional. Absent, browser checks are off for the project.

```yaml
version: 1
start:
  command: npm run dev -- --port 5173   # run in the worktree; serves the app on the port
  port: 5173                            # 1024-65535; the browser only opens http://127.0.0.1:<port>
  ready: { path: /, timeout_s: 60 }     # ready once the path answers 2xx (defaults shown)
ui_paths: [web/**]                      # a PR touching none of these runs no browser check
thresholds:                             # defaults shown
  max_long_task_ms: 200                 # no main-thread task longer than this
  max_dropped_frame_pct: 25             # at most this share of frames dropped during the flow
  slow_request_ms: 3000                 # a slower request is reported as slow
flows:
  checkout:
    - goto: /cart                       # a path on the app, never a host
    - click: testid:checkout            # stable targets only: testid:<data-testid> or text:<visible text>
    - type: { target: testid:email, text: a@example.com }
    - key: Enter
    - wait: testid:done                 # a target to appear, or milliseconds (at most 60000)
    - expect_text: { target: testid:total, text: "$10.01" }
```

The file is strict: an unknown key, a CSS-path target, a step that names a host, a port below 1024, or a flow
name other than lowercase letters, digits and dashes is refused, with the reason.

## Running a flow (`src/browser/run.ts`)

`runFlow({ app, flow, cwd, outDir })` runs one flow and returns its evidence:

1. Starts `start.command` in the worktree as a project command, like any check (bash with pipefail; the agent user
   when there is one; its own process group), and waits until `ready.path` answers 2xx on
   `127.0.0.1:<port>` within `ready.timeout_s`. If it never does, the run fails with the app's last output.
2. Starts headless Chrome or Chromium on a temporary profile and drives it over the DevTools protocol, with no
   browser dependency (the same driver the dashboard's own checks use, `src/browser/cdp.ts`).
3. **Localhost only**: every request is intercepted; one to any host but `127.0.0.1`, `localhost` or `[::1]` (or
   an in-page `data:`, `blob:`, `about:` URL) is refused before it leaves, and listed as blocked.
4. Runs the steps. A step that fails ends the flow; it is evidence, not a crash.
5. Records console errors and uncaught exceptions, failed requests (4xx/5xx or a network error), requests slower
   than `slow_request_ms`, a trace summary (main-thread long tasks of 50 ms or more, the longest task, the share
   of frames dropped; "not measured" when the trace has no frame events), and a screenshot in `outDir`.
6. Always stops Chrome and the app, the app's own children included (`taskkill /T` on Windows), however it ends.

With no Chrome or Chromium on the machine (set `CHROME` to its path), the run is skipped with that reason and
nothing is started.

## The `browser:` check (`src/browser/check.ts`)

`- browser: checkout` in `done_when` runs the app's `checkout` flow and judges it. It passes only when:

- every step ran and held;
- there are no new console errors or uncaught exceptions;
- there are no new failed requests (4xx/5xx or a network error);
- the longest main-thread task is within `max_long_task_ms`, and the share of dropped frames within
  `max_dropped_frame_pct`.

"New" is against a baseline run of the same flow when there is one (before the change). An error or failed
request already there is the same one even on another port, line or query string. With no baseline, every one
counts. Slow requests, refused requests to other hosts, and frames that couldn't be measured are notes, never
judged.

With no app declared, or no browser on the machine, the check is **unavailable**, never passed. An unknown flow
fails.

## Which tasks run browser checks (`src/browser/gate.ts`)

- An issue whose `done_when` has `browser:` items runs those flows, and only those, whatever the change
  touches. With no app declared they are unavailable (and say so), never skipped as passed.
- Otherwise, a change touching any of the app's `ui_paths` runs every flow the app declares, and lists the UI
  files it touched (the first 10).
- Anything else, or a project with no app, runs none.

## Evidence in the PR and its receipts (`src/browser/evidence.ts`)

The PR description gets a `BROWSER CHECKS` section:
- why checks ran or didn't, and the UI files touched;
- per flow: its result, a one-line summary (steps held, console errors, failed and slow requests, the longest
  task, dropped frames), the reasons it failed, and the errors and requests seen (5 of each at most);
- for a UI fix, the reproduction run before the change beside the run after it.

Text from the app (console messages, URLs) is shown as code, so its markup or mentions never render. The
screenshot is named, not given by path: the path is on the machine that ran the check.

In the claims receipts, a passing browser check is recorded as one (`kind: browser` on the check, never inferred
from its name). It backs a worker's claim about the browser, the UI or a screenshot. It doesn't back a claim
about a phone, another browser, staging or checking by hand.

## Not yet

- A `browser:` check in an issue's `done_when` is refused until the coordinator runs browser checks, so one can
  never be skipped and counted as passed.
