# How the engine repo itself is merged (owner decision, 2026-10-21)

This page is the process for this repo's own PRs, which builders write, reviewers check and an orchestrator merges. It is process, not design. It is not one of the engine's recorded decisions, and two things keep it out of the decisions index that planner agents read. Neither closes every route: the known open ones are listed below them, and that list isn't proven complete.
- **The index reads only committed records.** `recordEntries` (`src/plan-decisions.ts`) indexes a record only when it is a regular file at a decision record path in the plan's base commit, which the coordinator gives. It reads the commit, the trees and the text from the instance's own clone, never through the worktree's `.git` file, and checks every object it reads against its id. A file left at a record path untracked (by a setup step, an install script or a pooled worktree), an uncommitted edit, a later commit, a record committed as a symlink, and an object store that maps a real id to other text add no record (to the index; what planners read in the checkout is an open route, below). If git can't tell, or any object fails its check, no record is indexed. As a second check on the working tree, it also leaves out a record that is this page under another name (a hard link) or whose real path isn't a record path inside the checkout, and indexes no record when this page exists but can't be read (decisions already made stay citable). It can't recognise a copy of this page's text under another name. These checks cover what the base commit holds, not which commit is the base (an open route, below).
- **Every committed record path is locked.** In this repo every decision record path (`DECISION_FILES` and `DECISION_DIRS` in `src/review.ts`) and the index code are locked as self-modification, and `.worklane/review.yaml` lists them under `engine-guards`. So a PR that brings a copy of this page, whole, in part or reworded, into a committed record is L3 and in the critical set below, whatever it says. That PR is not the only way in: see the known open routes below. As a backstop, the locked `test/plan-decisions.test.ts` fails when a record indexed from this repo's checkout carries one of four key phrases of this page; a reworded copy gets past that test, but not past the lock.

**Open routes into the decisions index.** These are the known open routes onto text presented to planners (and the plan reviewer) as a recorded decision or as instructions, which the two checks above don't close. Reviews found them one by one, and the list is not proven complete: assume there are others. The by-design closure is #975: planner and plan-reviewer runs take input only from an allowlist enforced in code. Until then, other text in this repo (docs, changelog, PRs) points here and never says a route is the only one. The task text (the issue's title, body and done-when list) and the checkout itself are data that planners read by design, not decisions or instructions, so they aren't routes on this list. A route leaves the list only when its fix merges.
- **Who picks the base (#962).** The coordinator takes the plan's base from a fetch. A process running as the engine's user can still reach the source that fetch reads from, so it can choose a base whose committed records are then indexed. That includes agents and setup steps when no agent user is configured. When one is, the agent user may reach that source too if it can write the clone's shared git directory (a guess, not measured).
- **Question and answer text in decisions already made (#956).** A decision already made is indexed with its question and its answer. An agent or a reporter may have written the question. The answer is one of the asker's options, so for an agent's question an agent wrote it too, and the answer is neither capped nor redacted. So text that isn't a committed record, a copy of this page included, can be cited once it is answered: by an owner on any surface, or by a writer on the dashboard, in a chat thread or in a comment. The CLI records its answers as the owner's, and the engine's user can run it; that, and the index not checking who answered, are #969.
- **Decisions already made that no one answered (#969).** The index takes decisions already made from the instance's event log. It doesn't check who answered or how. So whatever can write that log can add a citable decision that no one answered. That includes the engine's user: agents and setup steps when no agent user is configured.
- **The checkout copy planners read (#970).** Planners and the plan reviewer are told to read the record files in their checkout, where setup steps have already run. So the text they read and rely on can differ from the committed text the index cites, for example an uncommitted edit.
- **Project instructions in planner runs (#973).** Planner and plan-reviewer runs load the agent's project instructions and config from their checkout. That text isn't a decision and can't be cited, but it reaches every planner as instructions. In this repo a change to it is L3, but no subject of the critical set below names it, so a copy of this page there may get one review, not two. A setup step can also leave such files in the checkout, as with #970.
- **Messages into a live planner run (#975).** Owners and writers may send a message to a live run, planner and plan-reviewer runs included, and it reaches the run as instructions. The coordinator takes the request's own word for who sent it, so whatever can write the instance's state can send one in an owner's name.
- **The owner's revise note (#975).** When the owner asks for a revised plan, the planner gets the note as the owner's words. The coordinator reads it from the event log without checking who wrote it, so whatever can write that log can give the planner instructions in the owner's name.

The plan reviewer's reason for sending a plan back also reaches the planner, as feedback. The reviewer's known inputs are the task text, the checkout and the routes above, and its reason can carry what those hold to the planner.

**This page changes nothing in the harness.** The harness's merge policy, review levels and holds ([design.md](design.md) §9 and §10, [guardrails.md](guardrails.md)) still apply to every project, unchanged. No plan, agent or PR can cite this page to let the engine merge more (a copy of its text: see the open routes above).

## Who merges

- **The orchestrator merges every PR, except those that go to the owner (see "What goes to the owner", below),** once all of these hold on the PR's current head:
  - **an independent final check:** a PASS posted on the PR, naming that head, from a reviewer who is neither the PR's builder nor the orchestrator;
  - **the combined check:** the batch merged together on a do-not-merge draft PR, built on main's tip, with that combined commit green. Main's tip must still be the combined check's base commit when the batch's first merge runs (compare the SHAs). A combined check built on an older main doesn't count;
  - **green required CI** on that head.
- **Green** means the newest run of every check on main's required list reported success on that exact head commit (a PR) or that exact combined commit (the combined check). An older success doesn't count when a newer run of the same check failed or hasn't finished. Pending, missing, failed, cancelled or skipped is not green. If the required list can't be read or is empty, nothing is green.
- **A PASS with conditions is not a pass** until a reviewer checks the head that meets them and posts a PASS naming that head. That reviewer is as independent as the review the conditions came from: for the final check, not the builder and not the orchestrator; for the second review, not the first reviewer either.
- **Reviewers and builders never merge.**

## The critical set

- **A PR in the critical set also needs a second, adversarial review.** The second reviewer is not the builder, not the orchestrator and not the first reviewer. They pass the same current head, and post the PASS on the PR naming that head.
- **Any push to a PR in the critical set needs both reviews again**, on the new head.
- **A PR is in the critical set when its changed files touch any of these subjects**, or when the engine's own `computeLevel` (`src/review.ts`), run on the PR's diff, puts any changed file under `self-modification`, `engine-guards` or `release-signing`. The changed files include both paths of a rename or copy: the old path too, which GitHub's PR file list leaves out. The code can only add a PR to the set, never take one out: a file under one of these subjects is in whatever the code says of it (for example `scripts/lib/signing.mjs`, `src/update-drain.ts` or `src/updater-setup.ts`, under release signing and the updater). When it's unsure whether a file is under a subject, or the code's result can't be run or read, the PR is in. "Setup and machine scripts" includes what sets up a worktree: the project's setup steps (`.worklane/tests.yaml`), `package.json`'s install-time scripts (`prepare`, `postinstall` and the like) and the scripts they run. Files such a step leaves in the worktree, commits it makes there, objects it writes to the object store and a redirected `.git` add no record to the decisions index, which reads only records committed at the base. But a setup step still runs code on every new worktree, and it can still take the open routes above (for example #970, or #962 and #969 when it runs as the engine's user).
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
