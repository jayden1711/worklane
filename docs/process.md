# How the engine repo itself is merged (owner decision, 2026-10-21)

This page is the process for this repo's own PRs, which builders write, reviewers check and an orchestrator merges. It is process, not design. It is not one of the engine's recorded decisions, and two things keep it out of the decisions index that planner agents read:
- **The index code** (`recordEntries` in `src/plan-decisions.ts`) leaves out a record that is this page under another name (a symlink or hard link to it), and a record whose real path isn't itself a decision record path inside the checkout (a link out of the checkout, or to any other file). When this page exists but can't be read, it indexes no record at all. It can't recognise a copy of this page's text under another name.
- **A lock covers copies.** In this repo every decision record path (`DECISION_FILES` and `DECISION_DIRS` in `src/review.ts`) and the index code are locked as self-modification, and `.worklane/review.yaml` lists them under `engine-guards`. So a PR that adds or changes a decision record, whole copy, partial copy or reworded, is L3 and in the critical set below, whatever it says. As a backstop, the locked `test/plan-decisions.test.ts` fails when a record indexed from this repo's checkout carries one of four key phrases of this page; a reworded copy can get past it, the lock can't.

**This page changes nothing in the harness.** The harness's merge policy, review levels and holds ([design.md](design.md) §9 and §10, [guardrails.md](guardrails.md)) still apply to every project, unchanged. No plan, agent or PR can cite this page to let the engine merge more.

## Who merges

- **The orchestrator merges every PR** once all of these hold on the PR's current head:
  - **an independent final check:** a PASS posted on the PR, naming that head, from a reviewer who is neither the PR's builder nor the orchestrator;
  - **the combined check:** the batch merged together on a do-not-merge draft PR, built on main's tip, with that combined commit green. Main's tip must still be the combined check's base commit when the batch's first merge runs (compare the SHAs). A combined check built on an older main doesn't count;
  - **green required CI** on that head.
- **Green** means the newest run of every check on main's required list reported success on that exact head commit (a PR) or that exact combined commit (the combined check). An older success doesn't count when a newer run of the same check failed or hasn't finished. Pending, missing, failed, cancelled or skipped is not green. If the required list can't be read or is empty, nothing is green.
- **A PASS with conditions is not a pass** until a reviewer checks the head that meets them and posts a PASS naming that head.
- **Reviewers and builders never merge.**

## The critical set

- **A PR in the critical set also needs a second, adversarial review.** The second reviewer is not the builder, not the orchestrator and not the first reviewer. They pass the same current head, and post the PASS on the PR naming that head.
- **Any push to a PR in the critical set needs both reviews again**, on the new head.
- **A PR is in the critical set when its changed files touch any of these.** The changed files include both paths of a rename or copy: the old path too, which GitHub's PR file list leaves out. The engine's own `computeLevel` or `selfModificationPart` (`src/review.ts`), run on the PR's diff, decides; when it can't be run or its result can't be read, the PR is in the critical set.
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

- before a batch starts (a single PR included), and after every batch, the orchestrator reads the ruleset and confirms strict up-to-date is on. If the exit trap didn't turn it back on, nothing merges until it is on again;
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
