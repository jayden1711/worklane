### Guardrail changes: what each one does

- **A task's hidden paths and the project's secret files are refused to every tool that reads or lists them, not to Read alone (#847).** Before, a Glob or a Grep over a hidden directory got through, and a Grep printed its files. Every tool call's paths now come from one classification (`src/guardrails/access.ts`). It covers:
  - Read, Edit, Write, NotebookRead and NotebookEdit;
  - Glob's path and pattern, Grep's path and glob, and LS;
  - every word of a Bash command, with what the shell expands a wildcard, brace or class word to, an option's value after `=`, and an input redirect's file;
  - in the guard's rules, every string of a tool they don't know, and of a field of a known tool they don't name. The agents' hook runs today only for Bash, Edit, Write, MultiEdit, NotebookEdit, WebFetch, Read, Grep and Glob, so other tools don't reach it yet.

  A Glob, Grep or LS is refused when its directory is a secret, or holds one its filter matches, through a symlink too. A Glob pattern or Grep glob with a backslash is refused, since the guard can't read its escapes as the tools do. A Grep glob with a space, or a comma outside braces, filters nothing. One call's checks share one budget (20,000 entries, 5 seconds), and a call past it is refused, never let through.

  New refusals:
  - A Grep with no path is refused in an experiment session (its config folder is hidden), and in a project whose root holds a real `.env` file, unless the Grep's glob leaves the file out.
  - A Grep or Glob over a directory of more than 20,000 entries is refused; give it a narrower path.

  Still open: Bash recursion from an ancestor directory (`grep -r x .`), a path built inside a script, `git show <rev>:<path>`, `git grep`, and a short option's attached value (`-fFILE`). Masking hidden paths at the OS level would close them.
