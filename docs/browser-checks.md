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

## Not yet

- A `browser:` check in an issue's `done_when` is refused until the coordinator runs browser checks, so one can
  never be skipped and counted as passed.
