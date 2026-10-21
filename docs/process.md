# How the engine repo itself is merged (owner decision, 2026-10-21)

This page is the process for this repo's own PRs, which builders write, reviewers check and an orchestrator merges. It is process, not design. It is not one of the engine's recorded decisions: the decisions index that planner agents read never includes it, even through a symlink or hard link (`PROCESS_DOC` in `src/plan-decisions.ts`, held by the locked `test/plan-decisions.test.ts`).

**This page changes nothing in the harness.** The harness's merge policy, review levels and holds ([design.md](design.md) §9 and §10, [guardrails.md](guardrails.md)) still apply to every project, unchanged. No plan, agent or PR can cite this page to let the engine merge more.

## Who merges

- **The orchestrator merges every PR** once all of these hold on the PR's current head:
  - **an independent final check:** a PASS posted on the PR, naming that head, from a reviewer who is neither the PR's builder nor the orchestrator;
  - **the combined check:** the batch merged together on a do-not-merge draft PR, built on main as it is now, with that combined commit green. A combined check built on an older main doesn't count;
  - **green required CI** on that head.
- **Green** means every check on main's required list reported success on that exact head commit (a PR) or that exact combined commit (the combined check). Pending, missing, failed, cancelled or skipped is not green. If the required list can't be read or is empty, nothing is green.
- **A PASS with conditions is not a pass** until a reviewer checks the head that meets them and posts a PASS naming that head.
- **Reviewers and builders never merge.**

## The critical set

- **A PR in the critical set also needs a second, adversarial review.** The second reviewer is not the builder, not the orchestrator and not the first reviewer. They pass the same current head, and post the PASS on the PR naming that head.
- **Any push to a PR in the critical set needs both reviews again**, on the new head.
- **A PR is in the critical set when its changed files touch any of these:**
  - merge policy;
  - review levels;
  - locks and the tool guard;
  - sudoers and root helpers;
  - setup and machine scripts;
  - release signing and the updater;
  - CI workflows;
  - any path locked as self-modification in `src/review.ts` (`SELF_MODIFICATION_PARTS`);
  - any path in the `release-signing` or `engine-guards` categories of this repo's review.yaml, this page included.
- **The changed files decide, never the title marker.** When unsure, the PR is in the critical set.
- **The `[PROTECTED: owner merges]` title marker no longer means the owner merges the PR.** It marks a PR that touches a protected path, which covers far more than the critical set (a dependency bump carries it too). The orchestrator merges such a PR under this page like any other. It needs the second review only if its changed files put it in the critical set.
- **A change to who may sign a release goes to the owner**, and so does a change to any place a release's signature is checked: for example a PR that touches `.github/release-signers`, `scripts/verify-release-tag*` or the signer check in the release workflow. The list is examples, not the whole set. The orchestrator never merges such a PR.

## The batch merge

The orchestrator runs the batch-merge procedure itself. **Every merge goes through it: a single PR is a batch of one.**

- before any merge, and after every batch, the orchestrator reads the ruleset and confirms strict up-to-date is on. If the exit trap didn't turn it back on, nothing merges until it is on again;
- strict up-to-date is turned off for the batch, then back on by an exit trap, on a normal or an error exit (not when the process is killed outright, as by SIGKILL);
- each merge is pinned to its tested head;
- after each merge, main's tree is compared with that step's tested tree (the combined branch after the same merges), and at the end with the whole tested combined tree;
- a mismatch, a failed step or a check that isn't green stops the batch. The PRs left need a new combined check, built on main as it is then, before any of them merges;
- no admin bypass, no force;
- the strict toggle is the only ruleset or settings change the orchestrator makes. Any other is the owner's.

## What goes to the owner

- **For merges, the owner is brought only:**
  - release signing, and any change to who may sign a release;
  - turning `auto_merge` on for a project;
  - direction changes;
  - steps that physically need the owner's hands or GitHub admin rights.
- **This removes no other owner approval.** A change that removes or weakens a check, lint, test or guard still needs the owner's explicit OK first. Adding an exception, allowlist entry or skip to one is a weakening.
- **A weekly summary of critical merges goes to the owner.**
