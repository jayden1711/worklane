### Guardrail changes: what each one does

- **The tool guard reads the command after a shell reserved word (#1125):** a hook-skipping push behind `if`,
  `then`, `elif`, `else`, `do`, `while`, `until`, `!` or `coproc` (`if true; then git push --no-verify; fi`,
  `for x in 1; do git push --no-verify; done`, `! git push --no-verify`, `coproc git push --no-verify`) got
  through, since the reserved word was read as the program. Such a word at the start of a command is now skipped
  and the command after it judged like any other. A reserved word anywhere else stays an ordinary argument.
