# Guard gaps: found, fixed and open

This page lists gaps in the engine's own guards: the ones found and fixed in October 2026, and the ones still open. [guardrails.md](guardrails.md) explains how the guards work. To report a vulnerability, follow [SECURITY.md](../SECURITY.md).

**The rules for this page:**

- A gap is listed as fixed only after its fix PR has merged. Each fixed row gives the merge commit.
- Each gap gets one plain paragraph: what could happen, who could do it, the fix and the test that holds it. There are no reproduction steps; the test is the proof.
- Every claim is labeled **measured** (from a command or CI output), **inferred** (read from the code) or **guess**. For each fixed gap, "What could happen" and "Who could do it" are inferred, from the issue and the fix PR. The tests are measured: they passed in CI on main (the `ci` workflow's run for commit `71316ebd`, 2026-10-19).
- `test/docs-guardrails.test.ts` checks every file and test this page cites, on every CI run.

## Fixed in October 2026

The merge states and commits are measured, from `gh pr view <n> --json state,mergeCommit` on 2026-10-19. Each test below arrived in its fix PR's own commits; that is measured with `git merge-base --is-ancestor`, which places the commit that added the test inside the PR and not on main before it.

| Gap | Issue | Fix PR | Merge commit |
|---|---|---|---|
| A rename plus an edit slipped past every exact-path lock | #683 | #688 | `521ce276` |
| Removing an instance could re-own a file through a link swapped in mid-walk | #555 | #601 | `d9b3a96a` |
| A provider's key and every prompt went wherever a repo's `agents.yaml` pointed | #392 | #607 | `d2fa3d2e` |
| A refusal message could quote a credential-shaped provider host entry | #392 | #675 | `4b90a3e7` |
| The agent CLI could drop the whole `--settings` file, and its guards with it | #626 | #649 | `c6fb4045` |

### A rename plus an edit slipped past the path locks (#683, fixed by #688)

**What could happen.** The engine read a renamed file's path in git's combined form, so a locked file that was renamed and edited in one change didn't match its lock. A change to a guarded file could then be judged as an ordinary one.

**Who could do it.** Any agent whose change reached review.

**The fix.** One helper reads every change's paths, and a renamed file counts under both its old path and its new one (`src/coordinator/change-files.ts#changeFiles`).

**The tests.** Label: measured.

- `test/change-files-renames.test.ts` › “a rename with an edit of a locked test file lists both paths and comes out L3 / self-modification”
- `test/change-files-renames.test.ts` › “a rename with an edit of a review.yaml engine-guards file comes out L3”

### Removing an instance: a link swapped in mid-walk (#555, fixed by #601)

**What could happen.** When an instance is removed on a server, a root step gives its leftover files back to root. Another member of the shared agent group could rename a link over one of those files while the step was walking them. The step would then follow the link and change the owner or mode of whatever it pointed at. Files whose names weren't valid UTF-8 were also missed.

**Who could do it.** Another instance's agent user on the same machine, timing the removal.

**The fix.** Each file is re-owned through one handle opened without following links, and found by its name's own bytes.

**The tests.** Label: measured.

- `test/instance-records.test.ts` › “a link renamed over a removed user's file mid-walk (by another agent-slots member) is never followed: what it points at keeps its owner and mode”
- `test/instance-records.test.ts` › “a removed user's file whose name is not UTF-8 (or inside such a directory) is re-owned like any other, listed by its own bytes”

The real-root behaviour also runs in CI's slow workflow (`.github/workflows/ci-slow.yml`).

### A provider's key went wherever the repo said (#392, fixed by #607)

**What could happen.** A repo's `agents.yaml` could name a provider `base_url`. The engine sent that provider's API key, and every prompt, to the host it named.

**Who could do it.** Anyone who could land a change to the repo's agent config.

**The fix.** A provider host is used only if root's own list on the machine allows it, exactly: no suffix, look-alike or other port. With no list, provider runs are off.

**The tests.** Label: measured.

- `test/provider-hosts.test.ts` › “a base_url's host and port must match an entry exactly: no suffix, look-alike, other port or other scheme's default”
- `test/provider-hosts.test.ts` › “no file, or a refused one, means no provider host at all: provider runs are off”

### A refusal could quote a credential-shaped host entry (#392, fixed by #675)

**What could happen.** If root mistyped an entry in that host list, for example with a credential pasted into it, the refusal message quoted the entry. The message was shown to dashboard writers.

**Who could do it.** No attacker was needed: a typo exposed the entry to writers.

**The fix.** A refused entry is named by its position only, never quoted.

**The tests.** Label: measured.

- `test/provider-hosts.test.ts` › “a refused entry is named by its position, never quoted while it could hold a credential: not in the refusal, nor at start”
- `test/provider-hosts.test.ts` › “GET /api/health: a writer is never sent a credential from a mistyped entry in root's file”

### The agent CLI could silently drop its guards (#626, fixed by #649)

**What could happen.** One invalid value in the `--settings` file made the agent CLI ignore the whole file without an error. Its deny rules and hooks were then off while the run went on.

**Who could do it.** Nobody had to: any one invalid value did it.

**The fix.** Every run's settings carry a fresh check value. The run stops unless the CLI's first event echoes it (`src/agent-settings.ts#settingsAppliedProblem`).

**The tests.** Label: measured.

- `test/runner-settings-applied.test.ts` › “a run whose --settings claude dropped is refused, naming the instance's agent settings file, and the agent does no work”
- `test/runner-settings-applied.test.ts` › “a tool result before the init event stops the run, and the line reaches nothing that reads the stream”

### Not a gap: the project settings refusal (#579, #590)

A project `.claude/settings.json` with an `effortLevel` made the engine refuse every agent run. That was the guard working: a project settings file that could loosen agent runs refuses them. The result was an outage, not a bypass. #590 removed the file and made the refusal name the feature issue behind it (#579).

- Test: `test/agent-settings.test.ts` › “a project .claude/settings.json that could loosen agent runs refuses them; hooks and tightening rules are fine”
- Label: measured.

## Open

These are not fixed. A PR "in review" hasn't merged, so it isn't shipped.

- **Hidden paths can be listed and searched (#847).** The tool guard refuses Read on a task's hidden paths (an experiment's eval and scorer), but allows Glob and Grep over them. Label: measured by the evaluator in PR #839's review.
- **Child processes inherit `Object.prototype` keys (#846).** Code already running in the engine's process could set an inherited key, and every child the engine spawns would see it as an environment variable. Label: measured in the issue; the reach is inferred. #844 (in review) covers the engine's own reads, not children.
- **Tests can reach real host tools (#838).** A test that puts `/usr/bin` on its own `PATH` runs the real tools, and a GitHub token in the shell isn't stripped from test processes. Label: measured in the issue.
- **Main needs 0 approvals.** GitHub's rules for this repository's `main` require 0 approving reviews, so only the engine's own merge policy keeps its high-risk changes with the owner. Label: measured, 2026-10-19.
- **The agents that build this repository act as the owner's GitHub account.** A move to a separate unprivileged account, with its own GitHub App and an owner-only update ruleset, is approved but not done. Label: measured, 2026-10-19.
- **A fresh hardened install trusts main as of its clone.** The checkout's release signers, engine pin and scripts come from main when it is cloned. Anyone who can land a change on main before then is trusted by that install. #845 (in review) verifies the release tag, but doesn't close this. Label: measured by #845's round-1 reviewer.
