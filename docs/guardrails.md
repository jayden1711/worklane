# How the guardrails work

This page is for someone deciding whether to trust the engine with their repo. It says how a pull request gets merged, what each guardrail stops, and what none of them cover.

**How to read it.** Every guarantee names the code that enforces it and the test that fails if it stops holding. Each one carries a label:

- **measured**: the cited tests passed in CI on main (the `ci` workflow's run for commit `71316ebd`, 2026-10-19);
- **inferred**: read from the code, with nothing run;
- **guess**: neither.

Code is cited as a file and a symbol in it (`src/pr-watch.ts#readiness`), and a test as its file and its exact title. `test/docs-guardrails.test.ts` reads this page on every CI run. It fails if a cited file, line, symbol or test title no longer exists, if a quoted or arrowed test citation isn't in the exact form used below (a test file in code followed by any quote or arrow, or a curly opening quote or arrow anywhere outside such a citation), or if the hold kinds listed below stop matching what the code gives. A cited symbol must be declared at the top level of its file, or be a member of a top-level class there. A test mentioned without a quote or an arrow (in italics, say, or in brackets) isn't seen by the test. So a citation in the checked form can't quietly go stale.

The known gaps are at the end, in [What isn't covered](#what-isnt-covered). Gaps found and fixed in October 2026 are in [security.md](security.md).

## The merge decision is code

The engine merges a pull request itself only when one pure function says so. A model never decides a merge. The evaluator, a model, gives a verdict, and that verdict is one input among several: it can hold a merge, but it can't release one on its own.

A PR goes through two steps before the engine merges it.

**1. Ready.** Every required check passed on the exact commit the evaluator approved. If no required checks are configured, nothing is ever ready.

- Code: `src/pr-watch.ts#readiness`.
- Tests:
  - `test/pr-watch.test.ts` › “ready: every required check passed on the evaluated head, and the evaluator approved”
  - `test/pr-watch.test.ts` › “no required checks configured: never ready (fails closed)”
  - `test/pr-watch.test.ts` › “a head other than the evaluated commit, a rejection, or no verdict: not ready, with the reason”
  - `test/pr-watch.test.ts` › “missing, pending, cancelled, skipped and neutral required checks are not passed; only a failure counts as failed”
- Label: measured.

**2. The decision.** `src/merge-policy.ts#mergeDecision` takes the facts about a ready PR and returns `auto: true` only when it finds no reason to wait. Any reason makes the PR wait for a person, and the reasons are shown on the PR's decision card.

- The inputs are gathered in one place, `src/coordinator/merge-flow.ts#mergeDecisionFor`:
  - the PR's changed paths;
  - their review categories;
  - its size;
  - the evaluator's verdict on this head;
  - the instance's and the repo's auto-merge switches;
  - whether auto-merge is stopped;
  - CI fix runs;
  - pushes by anyone else;
  - push-limit hits;
  - evals of changed agent instructions;
  - an approved plan's file list.
- A change with nothing to hold it merges: `test/merge-policy.test.ts` › “merge policy: a clean change merges”. Label: measured.
- Every kind of doubt holds it: `test/merge-policy.test.ts` › “merge policy: any doubt waits”. Label: measured.

**The policy comes from main.** The review config, the required checks and the rest of the project config are read from the default branch with git. The coordinator's own checkout isn't used for this, and a config that fails validation is never applied.

- Code: `src/config/live.ts#configTree`.
- Tests:
  - `test/live-config.test.ts` › “live config: the checkout's stale working tree is ignored once main has moved”
  - `test/live-config.test.ts` › “live config: an invalid config pushed to main keeps the last good one and records why”
- Label: measured.

**Auto-merge starts off.** An instance's kill switch is off until someone turns it on, and the instance switch, the repo switch and a stop each hold every PR.

- Tests:
  - `test/merge-policy.test.ts` › “the kill switch defaults to off in an instance policy”
  - `test/merge-policy.test.ts` › “merge policy: the kill switch, the repo switch and a stop each make every PR wait”
- Label: measured.

### Hold kinds

Every reason `mergeDecision` gives starts with one of these. `test/docs-guardrails.test.ts` turns every input on and compares each reason's kind (its text up to and including the first colon, or `auto-merge is off`) with this list exactly, not by prefix. A new kind of reason fails that test until it is listed here. A reason that only an input value the test doesn't use could trigger would go unseen; the test must set every input, so a new input can't be added without it (inferred).

| Kind | What holds the PR | Code | Test (label: measured) |
|---|---|---|---|
| `never auto-merged:` | The engine didn't open the PR, or it is one of the engine's own revert PRs, or it is a check proposed from repeated feedback. A person merges these. | `src/merge-policy.ts#neverAutoMerge` | `test/merge-policy.test.ts` › “merge policy: a PR the harness didn't open (a person's, a bot's) never auto-merges, however green”; `test/merge-policy.test.ts` › “merge policy: a revert the harness opened never auto-merges, however clean” |
| `auto-merge is off` | The instance's kill switch (`policy.yaml`) or the repo's switch (`review.yaml` `merge.auto`) is off. | `src/merge-policy.ts#mergeDecision` | `test/merge-policy.test.ts` › “merge policy: the kill switch, the repo switch and a stop each make every PR wait” |
| `auto-merge is stopped:` | Auto-merge was stopped, for example because main went red after an auto-merge. An unreadable stop file counts as stopped (inferred, from the code). | `src/coordinator/merge-flow.ts#autoMergeStopped` | `test/coordinator.test.ts` › “auto-merge stop: main red after an auto-merge (green before it) stops auto-merge, opens a revert PR that never auto-merges, and asks the owner; only the operator resumes it” |
| `high-risk:` | The change touches a category that always waits: the review config's L3 categories, CI config, the repo's own wait categories, and a floor no config can remove (the agents' own instructions, the engine's own controls, odd path names, attributes that hide a diff). A worker marking its change protected counts too. | `src/merge-policy.ts#riskAndDesignReasons`, `src/merge-policy.ts#waitCategoriesOf` | `test/merge-policy.test.ts` › “merge policy: high-risk paths wait (L3 categories, CI config, and the repo’s own categories)”; `test/merge-policy.test.ts` › “regression: a harness PR touching any self-modification file waits for the owner at L3 and never auto-merges, whatever review.yaml tries” |
| `design:` | The evaluator flagged a design change (binding), or dependency manifests change, or a new top-level directory appears. Also, whatever the review level, the change may remove or weaken a test, a lint or a guard (`design: may weaken a check:`), read line by line from its diff: a removed or changed line with an assertion or a test on it, or a deleted test file (a pure rename that the same runner still runs, under the same test folder, is not one); any removed line of a test's expected output or fixture, or of a guard or lint file; a registered check table gone or renamed, an entry taken out of a rule or guard list, an entry added to an allowlist, exception or good-fixture list, or the table changed outside its own lines; any line added to an allowlist file or a package manager's settings; an added line with a skip, only or suppression mark, in any file but docs. A diff it can't read in full (over its size bound, cut short, not text, a table it can't read or whose declaring line changed, a git failure) waits too. The engine's own source paths stand aside in a managed app's repo. A word list, not a parse: an assertion through another name (an alias, a helper) gets past it (inferred, from the code). | `src/merge-policy.ts#riskAndDesignReasons`, `src/merge-policy-weakening.ts#weakeningReasons`, `src/merge-policy-weakening.ts#weakeningOf` | `test/merge-policy.test.ts` › “merge policy: design-level waits: the evaluator's flag is binding, dependencies and new top-level modules are seen in code”; `test/merge-policy.test.ts` › “weakening: the merge decision waits on it whatever the level, so it still holds if a lock is ever narrowed”; `test/merge-policy.test.ts` › “acceptance (#783): a PR that weakens a guard file waits for the owner, on its own reason beside any lock”; `test/merge-policy.test.ts` › “weakening: bounded and fail closed: too many changed characters, a diff that doesn't match its counts, a file that isn't text, a table file it can't read, a git failure” |
| `big:` | More changed lines or files than the repo's limits. | `src/merge-policy.ts#mergeDecision` | `test/merge-policy.test.ts` › “merge policy: big changes wait, by lines or files; at the limit they merge” |
| `doubt:` | No verdict; the evaluator rejected the patch or doubts the test; its confidence isn't high; it didn't read a changed file; it gave no design answer. Also: a CI fix run happened, someone else pushed to the branch, or a push limit was hit. | `src/merge-policy.ts#mergeDecision` | `test/merge-policy.test.ts` › “merge policy: any doubt waits” |
| `eval:` | A changed role or skill wasn't evaluated, scored lower, hit its cost cap, or (for a role) has no held-out score. | `src/merge-policy.ts#instructionEvalReasons` | `test/merge-policy.test.ts` › “instruction evals: a drop waits with the per-case diff; a cap hit, an error or no eval waits; a clean eval does not” |
| `not in the approved plan:` | A planned task's PR changes a high-risk or design-level path its approved plan didn't list. | `src/merge-policy.ts#outsidePlanReasons` | `test/merge-plan-scope.test.ts` › “outside the plan: a high-risk or design path the plan did not list is named; planned ones and ordinary ones are not” |

### After the decision

Even when `mergeDecision` says yes, the merge call can still be held.

- **GitHub's own answer.** A person decides if GitHub can't merge the PR cleanly, or if a merge failed three times at this head. While GitHub is still computing whether it can merge, the engine asks again on the next poll; only after `MERGEABLE_CAP` polls of the same head (10) does that hold the PR for a person (`src/coordinator/merge-flow.ts#mergeOrWait`, `src/coordinator/wait-caps.ts#MERGEABLE_CAP`). Label: inferred.
- **Emergency stop.** It is checked again as the last step before every merge call, an owner's approval included. Nothing merges or lands while it is in force.
  - Code: `src/coordinator/base.ts#emergencyInForce`, `src/slots.ts#emergencyStop`.
  - Tests:
    - `test/estop-merge-gate.test.ts` › “emergency stop raised during the combined gate: no merge”
    - `test/coordinator.test.ts` › “emergency stop: one command halts every agent across instances; their tasks requeue; nothing starts until resumed”
  - Label: measured.

## The inputs

**Changed paths.** The engine lists a change's paths and line counts through one helper. A renamed file counts under its old path and its new one, so renaming a guarded file can't move it out of its category.

- Code: `src/coordinator/change-files.ts#changeFiles`.
- Outside the helper, each on a list in the test with its reason:
  - in `src/`, two readers: the comment lint (`src/comment-policy.ts`), which pairs a renamed file's lines; and the push check's path rules (`src/push-check.ts`), which read `git log --name-only --no-renames`, so a rename shows both paths;
  - in `scripts/`, a keyed list: CI test and slow-job selection, the release and updater "changes only `dist/`" checks, the push gate's denylist scan, and the bench.
- Tests:
  - `test/change-files-renames.test.ts` › “one helper is the only way src/ lists changed names or counts; scripts/ only on this keyed list”
  - `test/change-files-renames.test.ts` › “a rename with an edit of a locked test file lists both paths and comes out L3 / self-modification”
  - `test/change-files-renames.test.ts` › “a changed path with a control character is L3 "path with a control character" and never merges itself, whatever review.yaml lists”
- Label: measured for the renames, and for the list: the first test searches every file under `src/` and `scripts/` for the git flags and patch headers that list changed names or counts, and finds them only in the helper and the listed files. Inferred that no other reader exists: the search is a word list, and the test names its own gaps (a flag built by joining strings, for one).

**Review level.** Code computes the level from the changed paths, labels and size. Some categories are locked: the agents' own instructions and the engine's own controls always wait, whatever a repo's `review.yaml` says.

- Code: `src/review.ts#computeLevel`, `src/review.ts#LOCKED_CATEGORIES`, `src/review.ts#SELF_MODIFICATION_PARTS`.
- Test: `test/merge-policy.test.ts` › “regression: a change to the agents' role prompts, skills, AGENTS.md or any CLAUDE.md never auto-merges, whatever review.yaml tries”
- Label: measured.

**The evaluator's verdict.** The engine reads the verdict for the PR's current head only. Every way the verdict falls short is a `doubt:` reason (above). A verdict can add a hold; there is no verdict field that removes one.

- Code: `src/merge-policy.ts#mergeDecision`.
- Label: measured for the holds (`test/merge-policy.test.ts` › “merge policy: any doubt waits”); inferred for "no field removes one", from reading `mergeDecision`, which only ever adds reasons.

## The guards around the agents

**Tool guard.** A hook runs before every agent tool call (`src/hook.ts`), and the rules decide (`src/guardrails/engine.ts#evaluate`). Agents can't:

- write the engine's config folder or `.claude/`, including by a shell redirect;
- read secret files;
- fetch a domain outside the allowlist.

A person's own session isn't affected.

- Tests:
  - `test/guardrails.test.ts` › “protected harness files: agents denied (including shell redirects); humans unaffected”
  - `test/guardrails.test.ts` › “secret files: agents may not read them by tool or shell; exclusions apply; humans unaffected”
  - `test/guardrails.test.ts` › “agents can only fetch allowlisted domains”
- Label: measured.
- A rule that would block a must-allow example can't be activated: `test/guardrails.test.ts` › “guardrails check catches a new rule that conflicts with a must-allow example”. Label: measured.
- A task file the guard can't read denies the call. The guard is never skipped: `test/frozen-guard.test.ts` › “a missing, malformed or unreadable task file denies the agent's call instead of skipping the guard”. Label: measured.

**Settings check.** An agent run starts only with the instance's agent settings (hooks and deny rules). A project `.claude/settings.json` that could loosen them refuses the run.

- Every run's `--settings` carries a fresh check value. The run stops unless the agent CLI's first event echoes that value, because one invalid value makes the CLI drop the whole file without a word.
- Code: `src/agent-settings.ts#projectSettingsRefusal`, `src/agent-settings.ts#settingsCheckValue`, `src/agent-settings.ts#settingsAppliedProblem`.
- Tests:
  - `test/agent-settings.test.ts` › “an agent run without agent settings never starts, and the error names the exact install command”
  - `test/agent-settings.test.ts` › “a project .claude/settings.json that could loosen agent runs refuses them; hooks and tightening rules are fine”
  - `test/runner-settings-applied.test.ts` › “a run whose --settings claude dropped is refused, naming the instance's agent settings file, and the agent does no work”
  - `test/runner-settings-applied.test.ts` › “an agent turn before any init event confirmed the --settings stops the run”
- Label: measured.

**Sandbox.** An agent's shell commands run in the agent CLI's OS sandbox.

- If the sandbox can't start, the run exits instead of running unsandboxed. A blocked command can't be retried outside the sandbox.
- The Read tool is denied the same paths as the commands.
- Code: `src/sandbox.ts#sandboxSettings`.
- Tests:
  - `test/separate-users.test.ts` › “sandbox settings fail closed and deny the same paths to commands and to the Read tool”
  - `test/separate-users.test.ts` › “an agent run as its own user gets its home and login, git trusts its worktrees, and no tokens”
- On a server, each project's tests run as a test user of their own, and none of the coordinator's secret variables reach them: `test/testrun-sandbox.test.ts` › “isolation: no secret or credential variable of the coordinator's reaches a run”.
- Label: measured.

## The guards around pushes and secrets

**Push guard.** The engine pushes code through one function, `checkedPush`. It refuses the default branch however the ref is spelled, and refuses a change over the push limits. Each checkout also gets a pre-push hook that refuses the default branch.

- Two other pushes exist, and neither pushes code to a branch:
  - issue claims, a compare-and-swap push to a claim ref under `refs/` (`src/claims.ts`);
  - the demo, which seeds its own local bare repo (`src/demo.ts`).
- Code: `src/push-check.ts#checkedPush`, `src/push-check.ts#pushProblems`, `src/push-guard.ts#defaultBranchRefusal`, `src/push-guard.ts#prePushHook`.
- Tests:
  - `test/push-check.test.ts` › “the engine pushes code only through checkedPush (lease refs and the demo seed are the only other pushes)”
  - `test/push-check.test.ts` › “checkedPush refuses the default branch, however the ref is spelled, records it, and pushes nothing”
  - `test/push-check.test.ts` › “a change over max_changed_lines is refused with its size; at the limit it passes”
  - `test/push-guard.test.ts` › “the checkout's pre-push hook refuses a push to the default branch, records it, and lets a task branch through”
- Label: measured for the refusals, and for the one function: the first test searches every `.ts` file under `src/` for `push` passed as a git argument, and finds it only in `src/push-check.ts`, `src/claims.ts` and `src/demo.ts`. Inferred that no push is spelled some other way.

**Push gate and secret scan.** A push gate scans what is pushed for secrets and project-specific terms (`scripts/push-gate.mjs`). With no scanner, nothing is pushed.

- An agent can't set the gate's first-time-setup hatch, skip the pre-push hook or swap it. No agent starts with the hatch in its environment.
  - Code: `src/guardrails/push-hook.ts#pushHookShellRefusal`, `src/guardrails/push-hook.ts#withoutPushGateHatch`.
- Tests:
  - `test/push-gate.test.ts` › “push gate refuses a committed secret (gitleaks)”
  - `test/push-gate.test.ts` › “push gate fails closed: no gitleaks, no push”
  - `test/push-hook-guard.test.ts` › “an agent may not skip or swap the pre-push hook”
  - `test/push-hook-guard.test.ts` › “no agent starts with the hatch: not from the coordinator's environment, a project's env, or a caller's extras”
- Label: measured.

**Commit scan and redaction.** Agent commits are scanned before they happen. A scanner that can't run is reported as unavailable, never as clean. Secrets in event payloads and transcripts are redacted before they are stored.

- Code: `src/scan/secrets.ts#scanCommit`, `src/events/redact.ts#redact`.
- Tests:
  - `test/install.test.ts` › “agent commits are secret-scanned before they happen”
  - `test/boundaries.test.ts` › “a secret scanner that cannot run is reported as unavailable, never clean”
  - `test/redact.test.ts` › “every secret shape in the corpus is redacted by default, and secretKinds names it”
- Label: measured.

## Watching main

**Main watch.** It is on by default when GitHub reports no protection for the default branch. It judges every commit that lands there, wherever it came from.

- A commit is accounted for when it is the engine's own merge, or a mapped writer's PR merge, with the required checks green. A merge is judged by the required checks committed at its first parent, not by the config the coordinator started with.
- Anything else is unaccounted: a PR merged with a failing, pending or missing required check, a merge by an unknown actor or a bot, or a direct push. An unaccounted commit stops auto-merge, alerts, and opens a revert PR that only a person merges.
- Code: `src/main-watch.ts#judge`, `src/main-watch.ts#requiredAt`.
- Tests:
  - `test/main-watch.test.ts` › “main watch: a merge is judged by the required_checks committed at its first parent, not the startup config's”
  - `test/main-watch.test.ts` › “main watch: a PR merged with a failing, pending or missing required check is unaccounted”
  - `test/main-watch.test.ts` › “main watch: a merge by an unknown actor, an unmapped person or a bot is unaccounted”
  - `test/main-watch-coordinator.test.ts` › “main watch: a direct push stops auto-merge, alerts, and opens a revert PR the harness can never merge”
- Label: measured.
- The main watch notices a bad commit **after** it lands. It doesn't prevent one; on a protected branch, GitHub's protection is what prevents. Label: inferred.

## What isn't covered

**A small, clean change merges on the evaluator's PASS and green checks.** A change below every hold has no other gate. The evaluator is a model, and a wrong PASS on such a change merges. Label: measured for the merge (`test/merge-policy.test.ts` › “merge policy: a clean change merges”); inferred for the consequence.

**Direct landing doesn't go through the merge decision.** With `land_mode: direct`, a change is gated by its review level and the land-gate tests, not by `mergeDecision`.

- L3 asks the owner. Below L3, a change lands without one (`src/coordinator.ts`). Label: inferred, from reading the code.
- One floor holds whatever the config says: a change the evaluator rejected is held for the owner. Label: measured.
  - `test/direct-land-rejected.test.ts` › “direct mode: a change the evaluator rejected is held for the owner (L3), never landed”
  - `test/direct-land-rejected.test.ts` › “direct mode: the floor holds even when the review levels are configured to ask for nothing”
- Direct mode refuses to start on a branch GitHub doesn't protect, or when protection can't be checked (`src/direct-land.ts#directLandStartGate`; `test/direct-land.test.ts` › “land_mode direct when the protection can't be checked (GitHub errors): fail closed, the coordinator refuses to start”). Label: measured.
- One exception: when the repo's `origin` is a path on the machine (a `file://` URL or a directory, as in the demo and the tests), there is no host to ask, and direct mode starts and lands without the check (`src/direct-land.ts#localRemote`, `src/direct-land.ts#directLandRefusal`). Label: inferred, from reading the code.

**People aren't gated by the engine.** The merge decision governs only the engine's own merges. Anyone with push access to a repo can merge through GitHub as GitHub allows. Where the main watch runs, it flags such a merge after the fact, and only when its checks weren't green or its author isn't a mapped writer. Label: inferred.

**Known open gaps.** Each has an open issue or a PR in review. None of the PRs in review counts as shipped until it merges.

- **Hidden paths can be listed and searched (#847).** The tool guard refuses Read on a task's hidden paths, but allows Glob and Grep over them. So a Grep can print their contents, and a Glob can list their names. Label: measured by the evaluator on PR #839's review, as the issue cites.
- **Child processes inherit `Object.prototype` keys (#846).** Node copies an env object's inherited enumerable keys into a child's environment. So code already running in the engine's process could reach every child the engine spawns. Label: measured in the issue (a scratch script on Node 22); the reach is inferred. In review: #844 makes the engine's own environment reads own-only, and #883 starts every child through `src/os/child-process.ts`, which gives it only the variables that are set.
- **Tests can reach real host tools (#838).** A test that sets its own `PATH` to include `/usr/bin` or `/bin` runs the real `gh`, `loginctl` and similar tools. Label: measured in the issue. A GitHub token exported in the shell isn't stripped from test processes: `test/isolate.ts` removes only the engine's own variables and `AGENT_SLOTS_*`. Label: inferred, from reading `test/isolate.ts`; that such a token would reach those `gh` calls is inferred in the issue too (none was set in its measured run).
- **Main needs 0 approvals.** On this repository, GitHub's rules for `main` require 0 approving reviews. Only the engine's own merge policy keeps its high-risk changes with the owner; GitHub doesn't. Label: measured (`gh api repos/<owner>/<repo>/rules/branches/main`, `required_approving_review_count` is `0`, 2026-10-19).
- **The agents that build this repository act as the owner's account.** A move to a separate unprivileged account, with its own GitHub App and an owner-only update ruleset, is approved but not done. Label: measured (`gh api user` is the repository owner, 2026-10-19).
- **A fresh hardened install trusts main as of its clone (#845's body).** On a fresh hardened install, the checkout is a clone of origin's main. So its release signers, its engine pin and every script root runs come from main at clone time.
  - With 0 required approvals, anyone who can land a change on main before that clone is trusted by it.
  - #845 (in review) verifies the release tag before building as root, but this gap stays open. It closes with the owner-only update ruleset, or with an anchor the operator checks outside GitHub.
  - Label: measured by #845's round-1 reviewer, with throwaway keys.

**Guard work in review, not shipped:**

- #820: a PR that removes or weakens a test, lint or guard waits for the owner.
- #788 and #789: a required check counts only from the workflow or App pinned for its name.
- #769 and #770: on a single machine, the policy file is root's, and dashboard policy changes go through root's helper.
- #834: resuming auto-merge after a stop waits for green main.
- #839: the tool guard's own module tree is locked.
- #844: environment reads see only variables that are set.
- #845: the hardened install verifies the release tag.

**Attack tests (#707).** `test/adversarial/adversarial.test.ts` attacks the merge decision, and `test/adversarial/guards.test.ts` attacks the guards around the agents, pushes and secrets, each through its own entry point. For the second file, a guarantee counts as **covered** only when:
- it isn't open on main;
- every mutant listed for it in `test/adversarial/mutants.json` is killed by the suite.

A mutant breaks the guarantee in memory, and some case of that guarantee must then fail. Run `node test/adversarial/run-mutants.mjs` after a build to re-measure; `--whole` also checks that no other guarantee's case fails. A mutant found to survive is added to the list, and its guarantee isn't covered until a case kills it. A guarantee open on main is listed as open, with its issue.
