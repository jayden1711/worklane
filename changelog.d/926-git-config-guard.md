### Upgrading (from v0.5.2)

- **An instance's checkout `.git/` is its coordinator's alone (#926).** Until now `.git/` was writable by the agents'
  group, so an agent could plant git config (a filter, a signing program, an include, a URL rewrite) that the
  coordinator's git then ran as itself. Each coordinator now locks its checkout's `.git/` when it starts (everything
  but `objects/`, `refs/`, `logs/`, `worktrees/`, `lfs/` and `modules/`, which agents' worktrees write). If it can't
  (a symlink there, or a directory another user owns), the instance doesn't start and says so: run
  `sudo bash scripts/setup/checkout.sh <name> <owner/repo>`, which locks it as root. Agents can no longer delete a
  branch or tag, or set an upstream, from their worktrees (those rewrite `.git/packed-refs` or `.git/config`).
- **An instance's git reads no system or global config (#926).** A gh-config-dir instance's git now authenticates
  through `gh auth git-credential` set by the engine, not the helper `gh auth setup-git` wrote into the coordinator
  user's `~/.gitconfig`. The landing's cherry-pick commits as the harness identity. A checkout whose `.git/config`
  sets anything the guard refuses (below) stops every git there until that key is taken out; the refusal names the
  file and the key.

### Guardrail changes: what each one does

- **The instance git guard (#926):** in an instance's coordinator (and its auto-config), every git the runner
  (`src/os/git.ts`) starts reads no system or global config, gets command-scope settings over every file (no
  credential helper but the instance's own, no fsmonitor, editor, pager, external diff, ssh, askpass or signing
  program of a file's; no `ext::` transport, submodule recursion or bundle URIs), and first reads the config it would
  use: if a file sets an include, a filter, diff or merge driver, a URL rewrite, a remote's command or proxy, an
  `http.*` proxy, TLS or header setting, `core.worktree`, `core.gitProxy` or `core.hooksPath`, it runs no git at all.
  gitleaks is refused on such a checkout too (the scan reports itself unavailable, so the change isn't accepted).
  `checkout.sh` runs the same check before its own pull. Local mode is unchanged: the owner's own config is theirs.
