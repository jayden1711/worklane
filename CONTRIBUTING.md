# Contributing

Thanks for helping. A few rules keep this project safe to depend on.

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
