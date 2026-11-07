### Guardrail changes: what each one does

- **Planner and plan-reviewer runs load nothing from their checkout's project settings (#973):** they start with
  `--setting-sources ''` instead of `project`, so no CLAUDE.md, `.claude/settings.json` or project hooks from the
  checkout reach them; their instructions are the engine's role prompt and its `--settings` only (the guard's hooks
  and rules among them). A setup step could leave such files in the checkout, and in the engine's repo they need
  one review, not two. What it costs: a project's own hooks and permission rules no longer apply to these two
  read-only runs. Every other run loads its project settings as before. docs/process.md drops this route.
