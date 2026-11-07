### Guardrail changes: what each one does

- **A git remote name that isn't a plain name is refused before git sees it (#952).** git read a remote name starting
  with `-` as an option, so `--upload-pack=<command>` ran that command through `git fetch` and `git ls-remote`. The
  coordinator, its PR batcher and PR test runs, the main watch, the deploy gate, the live config and issue claims now
  take a remote only when it is letters, digits, `.`, `_` and `-`, starting with a letter or digit, and refuse any
  other before their first git call. Every engine caller passes `origin`, so nothing changes for an install.
