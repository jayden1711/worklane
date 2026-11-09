### Guardrail changes: what each one does

- **A guarded agent run loads nothing from its checkout (#958, the owner's decision).** A project command (a worktree setup step, a dependency's install script) runs as the agent user and could write `.claude/settings.json` with a `SessionStart` hook, or a `CLAUDE.md`, into the checkout; the next agent run loaded it and ran the hook outside any sandbox, because project hooks were allowed ("they only add"). A guarded run (an instance's agent settings) now starts Claude Code with `--setting-sources ''`, as planner runs already did: no project, local or user settings, hooks or `CLAUDE.md` (a parent folder's included) reach it, and its settings are the instance's own (`--settings`). Project permission rules and hooks no longer apply to guarded runs. CI proves it on the real `claude` at the version the machine installs (`scripts/ci/setting-sources-probe.mjs`), through the runner's own guarded run with an instance's agent settings. It plants:

  - a hook on every event in the checkout's, the local and the home settings;
  - an MCP server;
  - `CLAUDE.md` in the checkout, `.claude/`, `CLAUDE.local.md`, a parent folder, the agent's home and a nested folder a tool reads;
  - rules (one scoped to a path), skills (one nested), an agent, a command;
  - an auto-memory file.

  None of it reaches a request or runs. Its controls show each plant loads where it should: under `project`, the checkout's files and hooks; under every source, all of them; and the auto memory without the runner's `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, which (not `''`) is what keeps it out. #958's earlier second-line checks, which refused a run over an uncommitted `.claude/` file or `CLAUDE.md`, are dropped with the owner's approval (2026-11-08).
