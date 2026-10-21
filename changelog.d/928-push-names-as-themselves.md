### Guardrail changes: what each one does

- **push.refuse_paths matches a name by its own bytes (#928):** the push limits read the paths a change touches with
  `-z`, so a refused file whose name has a non-ASCII byte, a newline, a quote or a backslash is refused (git's quoted
  form of the name matched no glob, and such a file was pushed). The workflow check and the SKILL.md lint read the
  same names. The tests that hold the rename and odd-name guarantees now wait for the owner like the other guard
  tests.
