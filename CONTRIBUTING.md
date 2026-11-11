# Contributing

Thanks for helping. A few rules keep this project safe to depend on.

## Commit messages

Line 1 is the subject, at most 180 characters, and line 2 is blank before any body: the push gate (pre-push hook and CI) refuses anything else, since rewording a pushed commit takes a force-push.

## Sign-off

Every commit must carry a [Developer Certificate of Origin](https://developercertificate.org/) sign-off matching the commit author:

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it. CI rejects pull requests with unsigned commits (`npm run check:dco -- origin/main` checks locally).

The sign-off is the repo's only attribution. A commit message with a `Co-Authored-By` trailer (any address) or a coding tool's "Generated with" line is refused by the push gate, and a PR body with one fails the `new-deps` check. The harness's own agents run with attribution turned off.

## Licensing of borrowed code

- The project is Apache-2.0.
- **Never copy code from AGPL, GPL, SSPL, BUSL or Commons Clause projects.** Reading them for design ideas is fine; say so in the PR.
- MIT, BSD or Apache-2.0 code you reuse must be credited in `THIRD_PARTY_NOTICES.md` with its license text, and the file header should name the source.
- **A new runtime dependency** (package.json `dependencies`, `optionalDependencies` or `peerDependencies`, or any
  package-lock.json entry that isn't dev-only, transitive ones and version changes included) is named in the PR body
  under `## New dependencies`, one line each: `- <name> | <licence> | <why>`, the licence as package-lock.json gives it.
  The `new-deps` check (scripts/ci/new-deps.mjs) fails without it. A green check is not approval: a new runtime
  dependency still waits for the owner's OK before it merges.

## Project-specific code

Nothing specific to one project belongs in this repo: no project or repo names, people's handles, environment or service names, file paths, or domain details. Describe the need generically (e.g. "a project whose staging and prod databases share a host name"); project behavior and notes live in that project's `.worklane/` folder. If the engine can't express what a project needs, add a generic extension point and an example under `examples/`.

CI runs `npm run check:denylist`, which fails on known project-specific terms (stored hashed in `.denylist.json`) and on email addresses. Intentional mentions go in `.denylist-allow`.

### The push gate

A pre-push hook refuses a push that carries private details or a secret (`scripts/push-gate.mjs`: the denylist over the pushed commits, their messages and the pushed tree, then gitleaks). Install it once per clone, and again whenever the hook itself changes:

```sh
npm run setup:hooks
```

That copies the hook into the repo's common hooks dir (`.git/hooks/pre-push` and `push-gate-hook.mjs` beside it), where every worktree runs it. It replaces its own earlier install and an earlier gate hook (kept as `pre-push.before-push-gate`), unsets the old `core.hooksPath=.githooks`, and refuses to overwrite any other pre-push hook. When the installed hook is no longer the one on `origin/main`, each push says so.

- **The rules come from `origin/main`, fetched on that push**, never from your checkout or the branch you are pushing. The hook fetches the default branch (20 s limit; `PUSH_GATE_FETCH_TIMEOUT` in seconds), copies the gate, the files it imports, `.denylist.json`, `.denylist-allow` and `.gitleaks.toml` from it into a private temp dir, runs the gate there and removes the dir. A stale checkout is judged by today's rules.
- **A branch can't allow its own mention.** A `.denylist-allow` entry (or any change to the gate or its rules) counts once it is on `origin/main`: land the entry in a PR of its own first, then push the branch that needs it. CI's `push-gate` job still reads the PR's own files, so the reviewer sees the entry.
- **Offline** (the fetch fails): the hook uses `origin/main` as last fetched and prints a loud warning naming that commit. A clone that has never fetched it falls back to the checkout's own copy, with the checkout's commit in the warning. No gate anywhere refuses the push.
- **First-time setup** (no `origin` remote, no default branch on it, or the gate isn't on it yet): the push is refused with the reason. `PUSH_GATE_BOOTSTRAP=1 git push ...` runs the checkout's own copy for that one push, under the same warning.
  - **The hatch is a person's, never an agent's.** Each use prints `FIRST-TIME-SETUP HATCH USED by <user> at <time>` in the push output and appends one JSON line (time, user, commit, branch, reason) to `push-gate-bootstrap.log` in the repo's common git dir (`.git/`; local, never pushed). A use that can't be recorded is refused. The record is local to the machine that pushed: nothing is sent anywhere.
  - Inside an agent run (`WORKLANE_AGENT=1`) the hook refuses the hatch. The engine's guardrails also refuse any agent command that sets, exports, passes or stores `PUSH_GATE_BOOTSTRAP`, uses `git push --no-verify`, or points git at other hooks, and the runner drops the variable from every agent's environment (`src/guardrails/push-hook.ts`).
- `npm run check:push` runs the same thing over `origin/main..HEAD` from any worktree, without pushing.
- **A commit-msg hook, installed beside it, judges each message's shape before `git commit` makes the commit** (#1259): a subject over 180 characters, or a line 2 that isn't blank, is refused by `git commit` itself, so such a commit isn't made only to be refused at push. It runs the push gate's own rule (`scripts/push-gate.mjs --commit-msg`, from the copy of the gate setup-hooks puts in `.git/hooks/commit-msg-gate/`; the gate takes that mode only from there, and only with the stub's own marker), so the two can't drift. It judges the message as git will commit it, by the cleanup git applies: `commit.cleanup` when set, else `strip` for a message you edit (comment lines left out) and `whitespace` for `-m`, `-F` and `-C` (a `#` line is kept). git cuts at the first scissors line that a newline follows, and only with `-v` or `cleanup=scissors`; in `strip` mode, which can't tell a `-v` from a scissors line you typed, it judges the message both cut and uncut. The comment prefix is git's: `core.commentChar`, and from git 2.45 `core.commentString`, whichever is set last. With `core.commentChar=auto` (any case, as git reads it) git picks its character from the message as it stood before the editor ran, which a hook never sees, and git versions pick differently; so the hook doesn't guess: it judges every reading git might commit (each candidate character that starts a line, and nothing stripped) and refuses if any fails. That can refuse a commit git would make (an `auto` commit typed on line 1 of an empty template, where one reading keeps the help lines), never pass one the push gate refuses.
  - **What it can't see:** a `--cleanup=` given on the command line: then it judges by the mode above, not git's, so such a commit may be refused when it would pass, or pass when the gate refuses it, whenever that mode and the flag's treat a line differently (for example `--cleanup=verbatim` with a leading blank line; `--cleanup=strip` with `-m` or `-F`, a `#` line stripped that the hook keeps; `--cleanup=scissors` or `--cleanup=whitespace` on an edited message, a `#` line kept that the hook strips). The push gate judges what git committed, so such a commit is refused at push. Also `--no-status` or `-v` on the command line (it judges both readings, so such a commit may be refused when it would pass), and a `GIT_EDITOR=:` you set yourself while editing (git's own sign of an unedited message, so it judges as `whitespace` while git strips). It fails closed rather than model what git would do with: `i18n.commitEncoding` set to anything but UTF-8, or a message that isn't valid UTF-8, or holds a Unicode noncharacter (U+FDD0–U+FDEF, U+xxFFFE, U+xxFFFF), whose bytes git rewrites (refused: set i18n.commitEncoding to UTF-8 or unset it); and a `core.commentChar` or `core.commentString` that isn't `auto` or printable ASCII with no whitespace (refused, naming the value). The push gate reads each commit's raw object as UTF-8, so `log.showSignature` or `i18n.logOutputEncoding` at push time don't change what it judges. It reads the header block strictly, as git does (lines split on LF only), and refuses a commit whose header holds a CR, a NUL or a byte that isn't ASCII (a non-ASCII author name included), more than one `encoding` header, or an `encoding` value other than exactly UTF-8: it never decodes another encoding.
  - **What it doesn't cover:** commits git makes without running the commit-msg hook: `git revert`, `git cherry-pick` and a rebase's picks. Nor the push gate's other checks (the denylist, attribution): those run at push.
  - It refuses to overwrite another commit-msg hook. The pre-push gate and CI still judge every pushed commit, so a commit made with `--no-verify` is refused at push. The installed pre-push hook marks a push (`--pre-push`), and the launcher refuses a remote whose name starts with `-` (`--range`, `--print-gate-files`, `--commit-msg`) before anything reads it, ends the gate's options with `--` before the remote's name, and never hands the commit-msg hook's marker to the gate. A pre-push hook installed before this needs `npm run setup:hooks` again for the first of these; each push says so while it differs from origin's.

## Development

```sh
npm install
npm test          # builds, then runs node:test
npm run typecheck
```

- Node 22.13 or newer. CI runs macOS, Linux and Windows on Node 22 and 24.
- OS-specific code lives only in the OS adapter layer.
- Prefer making the wrong thing impossible (architecture) over a test or lint, and a test or lint over a written rule.
- Every bug fix comes with a test that fails without the fix.

## Releasing

The owner cuts releases with a signed tag (`scripts/release.mjs`). CI (`.github/workflows/release.yml`) checks the tag's SSH signature against `.github/release-signers` on main and only **stages** the version on npm (`npm stage publish`); it goes live when the owner approves it on npmjs.com with 2FA. The repo variable `NPM_PUBLISH=true` is the switch; without it every run is a dry run. The checklist: [docs/releasing.md](docs/releasing.md).

## Pull requests

Keep them small and focused, with atomic commits. Describe how you verified the change, not just that tests pass.
