### Guardrail changes: what each one does

- **The push limits refuse links where the agents' instructions are read, and match refused paths case folded
  (#951):**
  - a symlink or submodule link at or under `.claude/skills`, `.claude/commands`, `.claude/agents`, the config
    folder's `skills/` and `roles/`, or named `AGENTS.md`, `CLAUDE.md` or `SKILL.md` anywhere, and one at `.claude`
    or the config folder itself, is refused. Before, `.claude/skills/x -> <a directory>` added no SKILL.md name, so
    the skill there was never linted;
  - `push.refuse_paths` and the CI workflows check match case folded: `SECRETS/k.key` is refused by `secrets/**`,
    and `.GitHub/Workflows/x.yml` counts as a workflow change.
