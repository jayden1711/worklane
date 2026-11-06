### Guardrail changes: what each one does

- **The agents' commit scan takes its rules from no file the agent can write (#1128):** it read the gitleaks rules
  from the working tree's `.gitleaks.toml`, so an agent could choose which secrets it looked for. It now scans with
  the scanner's built-in rules always, and with the project's `.gitleaks.toml` as committed on origin's default
  branch (what `origin/HEAD` names, else `main`) when there is one, each on its own, a finding of either counting.
  A working-tree or staged `.gitleaks.toml` is never read as rules. A project that changes its rules sees them in the
  commit scan once they reach the default branch.
