### Guardrail changes: what each one does

- **The agents' commit scan takes its rules from no file the agent can write (#1128):** it read the gitleaks rules
  from the working tree's `.gitleaks.toml`, so an agent could choose which secrets it looked for. It now uses the
  project's `.gitleaks.toml` as committed on origin's default branch (what `origin/HEAD` names, else `main`), its
  allowlists included, and the scanner's built-in rules when there is none there. A working-tree or staged
  `.gitleaks.toml` is never read as rules. A project that changes its rules sees them in the commit scan once they
  reach the default branch.
