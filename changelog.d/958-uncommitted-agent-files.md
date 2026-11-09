### Guardrail changes: what each one does

- **A guarded agent run loads nothing from its checkout (#958, the owner's decision).** A project command (a worktree setup step, a dependency's install script) runs as the agent user and could write `.claude/settings.json` with a `SessionStart` hook, or a `CLAUDE.md`, into the checkout; the next agent run loaded it and ran the hook outside any sandbox, because project hooks were allowed ("they only add"). A guarded run (an instance's agent settings) now starts Claude Code with `--setting-sources ''`, as planner runs already did: no project, local or user settings, hooks or `CLAUDE.md` (a parent folder's included) reach it, and its settings are the instance's own (`--settings`). Project permission rules and hooks no longer apply to guarded runs. CI proves it on the real `claude` at the version the machine installs (`scripts/ci/setting-sources-probe.mjs`), through the runner's own guarded run with an instance's agent settings. It plants:

  - a hook on every event in the checkout's, the local and the home settings;
  - an MCP server;
  - `CLAUDE.md` in the checkout, `.claude/`, `CLAUDE.local.md`, a parent folder, the agent's home and a nested folder a tool reads;
  - rules (one scoped to a path), skills (one nested), an agent, a command;
  - an auto-memory file;
  - an env in the local and home settings (a request header, and a variable a tool would see) and an allow rule for Bash and Write.

  None of it reaches a request or runs: not in a Read-only run (where Bash and Write stay denied), not in one shaped as a coordinator worker's (its role prompt, schema, tools and apiKeyHelper), and not in a resumed session. Its controls show each plant loads where it should: under `project`, the checkout's files and hooks; under `user`, the home's files and env; under every source, all of them, on a fresh session and a resumed one; and the auto memory without the runner's `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, which (not `''`) is what keeps it out. CI also runs it against five wrappers around the real claude that each leak one of these, and fails unless the probe catches each. A pull request touching any module the probe loads runs it. #958's earlier second-line checks, which refused a run over an uncommitted `.claude/` file or `CLAUDE.md`, are dropped with the owner's approval (2026-11-08).
