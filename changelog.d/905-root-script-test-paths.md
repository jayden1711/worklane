### Guardrail changes: what each one does

- **In a test, the machine helper and `updates-root.cjs` refuse any of the machine's own paths, and never run the
  real system journal's `logger` (#905).** Tests run copies of these two root scripts with their fixed paths pointed
  into a temporary root. A path a copy left real is now refused when the script would use it, without being looked at.
  This covers the change log, the pending signers, `/etc/worklane`'s files, the signers record and the updater's hold
  file. Before, `test/updater-setup.test.ts`'s copies of `updates-root.cjs` kept the real
  `/var/lib/worklane/update-held.json`, so its `release-hold` read the real hold file and could have moved it. Every
  copy also called the real `logger`, so it wrote to the machine's journal.
  - What counts as a test process: one with any of these environment variables set: `NODE_TEST_CONTEXT`,
    `WORKLANE_TEST_RUN`, `WORKLANE_TEST_ISOLATION`, `WORKLANE_TEST_MACHINE`. These are the environment signs among
    the test-run signs `src/os/system-paths.ts` reads. A test's copies inherit them from the test process. In such a
    process, a path is used only when it is inside the test machine (`WORKLANE_TEST_MACHINE`), checked by name and
    through links. A link that doesn't resolve (dangling, to a file or a directory) is refused, wherever it points.
    With no test machine named, every path is refused.
  - In a test, `logger` runs only when the first one on PATH is inside the test machine, and it runs by that path.
  - These variables can only make a path refused. They never move one. Outside a test none of them is set, and
    sudo's `env_reset` drops them.
  - `test/updater-setup.test.ts` now points every fixed path its copies declare into its root, not a hand-picked
    few. Its copies log to a recording `logger` first on PATH. New tests check each of these.
  - Not covered yet: the helper still checks for its root scripts under `/opt/worklane/current` (add-project,
    claude-account, tailscale, plugins, the engine CLI) and the plugin host and MCP registry lists in
    `/etc/worklane`, unguarded, for copies that leave them real. Other tests' copies still leave some paths real.
  - Nothing changes for an install.
