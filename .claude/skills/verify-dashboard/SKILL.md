---
name: verify-dashboard
description: Confirm a dashboard UI change in a real browser before calling it done. Use after any change under web/ or to the dashboard server (src/dashboard*.ts, src/projection.ts): drive every affected page with scripts/dev/control-dashboard.mjs, compare before and after screenshots, and show zero new console errors.
---

# Verify a dashboard change

Tests that render pages in Node don't show what a person sees. Before you say a
UI change works, open it in a real browser with the control script and say
what you checked.

## Tools

- `docs/feature-map.md`: every page (its id, route, sidebar row, shortcut) and
  every feature, with the selector to drive it. If you add a page, route,
  sidebar row, shortcut or `data-testid`, add it to the map in the same commit;
  `test/feature-map.test.ts` fails otherwise.
- `scripts/dev/control-dashboard.mjs`: seeds a demo project in a temporary
  directory, starts its dashboard and drives a headless Chrome over the
  DevTools protocol. Nothing is written outside that directory.
  - `check --out <dir> [--baseline <file>]`: every page in the map, one
    screenshot each, console errors per page, as JSON lines.
  - `open <page|/path> [--screenshot <file>]`: one page.
  - `run <commands file>`: open, click, type, key, text, wait, screenshot,
    console, trace, eval; one JSON result per line. See the script's header.
  - `probe`: what works where you are (temp dir, loopback port, built engine,
    Chrome, the dashboard over DevTools).
  - `--engine <checkout>` points it at another built checkout, for "before".

## Steps

1. Build both versions. "Before" is the base branch in its own worktree;
   "after" is your branch. Each needs `npm run build && npm run build:web`.
2. Before: `node scripts/dev/control-dashboard.mjs check --engine <base worktree> --out <dir>/before > <dir>/before.jsonl`
3. After: `node scripts/dev/control-dashboard.mjs check --out <dir>/after --baseline <dir>/before.jsonl > <dir>/after.jsonl`.
   It exits non-zero if a page didn't render or has a console error the
   baseline didn't have.
4. For each feature you changed, script it with `run`: reach it the way a
   person would (sidebar, shortcut, click), read the text you expect, and take
   a screenshot after the interaction. Use `testid:` targets where the map has
   them, `text:` for buttons, CSS otherwise.
5. Look at the before and after screenshots of every page you touched, both
   themes if colours changed (`--theme dark`).
6. Report, in this order:
   - the pages and features you exercised, and how (the commands)
   - the screenshot paths, before and after
   - console errors: none new, or each new one with its page
   - anything that looked wrong, even if it's outside your change

Don't call a UI change verified from a test run or a build alone, and don't
skip a page because the change "can't affect it": shared styles and components
reach every page.

## In the agent sandbox

The script needs a writable temp directory, a loopback port for the dashboard,
and permission to launch Chrome. Run `probe` first: each step says what failed.

- Linux (bubblewrap): loopback works inside the sandbox's own network
  namespace. If Chrome fails to start because it can't create its own sandbox
  inside this one, add `--no-chrome-sandbox` (only ever for the throwaway
  demo profile this script makes).
- macOS (Seatbelt): commands may not listen on a port unless the sandbox
  allows local binding, so the dashboard can't start; `probe` reports it at
  "a loopback port can be opened".
- If the sandbox blocks it, don't work around it, and say so in your report.
  The sanctioned way is a project check: the owner puts the `check` command in
  the project's `tests.yaml` `checks`, and the coordinator runs it as the agent
  user, outside Claude's sandbox, after your run, and sends any failure back to
  you. (The instance policy's `sandbox` setting is all or nothing for every
  lane; there is no per-lane switch, and turning it off is not a fix for this.)
