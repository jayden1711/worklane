### Guardrail changes: what each one does

- **A task's hidden paths and the project's secret files are refused to every tool that reads or lists them, not to Read alone (#847).** Before, a Glob or a Grep over a hidden directory got through, and a Grep printed its files. Every tool call's paths now come from one classification (`src/guardrails/access.ts`). It covers:
  - Read, Edit, Write, NotebookRead and NotebookEdit;
  - Glob's path and pattern, Grep's path and glob, and LS;
  - every word of a Bash command, with what the shell expands a wildcard, brace or class word to, an option's value after `=`, and an input redirect's file;
  - every string of a tool the guard doesn't know, and of a field of a known tool it doesn't name.

  A Glob, Grep or LS is refused when its directory is a secret, or holds one its filter matches, through a symlink too. A directory too large to check (over 20,000 entries) is refused, never let through.

  New refusals:
  - A Grep with no path is refused in an experiment session (its config folder is hidden), and in a project whose root holds a real `.env` file, unless the Grep's glob leaves the file out.
  - A Grep or Glob over a directory of more than 20,000 entries is refused; give it a narrower path.

  Still open: Bash recursion from an ancestor directory (`grep -r x .`) and a path built inside a script; masking hidden paths at the OS level would close them.
