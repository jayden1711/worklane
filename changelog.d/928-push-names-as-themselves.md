### Guardrail changes: what each one does

- **push.refuse_paths matches a name by its own bytes (#928):** the push limits read the paths a change touches with
  `-z`, so a refused file whose name has a non-ASCII byte, a newline, a quote or a backslash is refused (git's quoted
  form of the name matched no glob, and such a file was pushed). The workflow check and the SKILL.md lint read the
  same names; the lint reads each skill from the head's tree by its bytes, so a skill whose name isn't valid UTF-8 is
  linted too, and a touched SKILL.md it can't read (a symbolic link, a submodule link, one over 1 MB) is refused,
  never skipped or judged by a link's target. The tests that hold the rename and odd-name guarantees now wait for the owner like the other guard
  tests.
