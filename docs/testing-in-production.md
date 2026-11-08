# Testing in production: what the engine covers, what it doesn't, and the plan

The engine runs real agents on real repositories on real machines, so some failures only show in production. This page
checks the engine against seven "testing in production" layers: an audit log, property-based and fuzz tests, feature
flags, chaos tests, shadow runs, canary rollout and a soak test. For each layer it says what is covered today, with the
code, tests and workflows that show it, and what is missing, with a risk rating. Then it gives the plan: one PR per
gap, highest risk first.

Audited against `main` at `b17398e1` (2026-11-07).

**Risk ratings** (for a gap):
- **High:** the gap can let a wrong merge, a widened permission or an untraceable action through without anyone seeing it.
- **Medium:** the gap can cost a machine, a run or a day, and someone notices, but late or by hand.
- **Low:** the gap costs time or money slowly, and existing monitoring would catch it eventually.

## Summary

| Layer | Today | Gap risk | Plan item |
|---|---|---|---|
| Audit log | Partial: the event log is append-only and merges get signed, chained receipts; nothing else is tamper-evident | High | a |
| Property-based / fuzz tests | Partial: seeded fuzz for redaction only; none for the merge guards or the auth paths | High | b |
| Chaos tests | Partial: disk full, a GPU run cut off, and a shifted clock are tested; GPU device loss, an unreachable host, a changed host key and self-matching waiters are not | High | d |
| Feature flags | Partial: per-feature config switches, off by default; no general flag for a risky engine change, and a flip isn't audited as one | Medium | c |
| Canary rollout | Partial: one scratch-repo canary after each update, with rollback; no rollout order across instances | Medium | f |
| Shadow runs | Partial: harness evals replay past tasks with no side effects; nothing runs two engine versions side by side or compares their decisions | Medium | e |
| Soak test | Missing | Low | g |

## 1. Audit log

**Covered.**
- **The event log is append-only.** SQLite triggers refuse `UPDATE` and `DELETE` on `events`, so no code path can
  rewrite history (`src/events/log.ts`, the `events_no_update` and `events_no_delete` triggers). Every payload is
  redacted before it is written (`src/events/redact.ts`). Agent runs (`run.started`, `run.finished`, `run.killed`,
  `run.cost`), guardrail blocks, decisions and merges are all events (`src/events/types.ts`).
- **Every write a person makes is audited.** `auditWrite` (`src/decide.ts`) appends `dashboard.audit` with the login,
  role, how they came in and what they did. The owners read it on the dashboard (`GET /api/audit`, `src/dashboard.ts`).
- **Merges have signed, chained receipts.** Each merge decision and result is signed with the instance's key and
  chained to the receipt before it. `worklane receipts verify` checks a chain offline with only the receipts and the
  public key (`src/signed-receipts.ts`, `src/signed-receipts-store.ts`, `src/signed-receipts-cli.ts`;
  [receipts.md](receipts.md); tests: `test/signed-receipts*.test.ts`, 25 files).

**Missing.**
- **Nothing but merges is tamper-evident.** The triggers stop the engine's own code, not the coordinator user: it owns
  `events.db` and can drop a trigger, or rewrite the file, and no check would show it. An agent run, a guardrail
  block, a decision answer or a dashboard audit row can be changed or removed without a trace. The receipts design
  lists "agent runs, an audit export" as step 4, not built ([design.md §5a](design.md#5a-signed-receipts-717)).
- **No stated retention, and no single verify** for the whole log.

**Risk: High.** Every other layer reports through the event log. If the record of what an agent did can be changed
silently, nothing built on it (chaos reports, shadow diffs, flag flips) can be trusted after an incident.

## 2. Property-based and fuzz tests

**Covered.**
- **Seeded fuzz for redaction.** `test/redact-broad-union.test.ts` generates inputs from a small seeded generator
  (a failure names an input that can be run again; `REDACT_FUZZ_N` and `REDACT_FUZZ_SEED` run it longer).
- **Fixed adversarial cases** for the commit scan, tool guard and merge door (`test/adversarial/`,
  `test/adversarial/cases`).
- **Example-based tests** for the merge decision and the auth rules (`test/merge-policy*.test.ts`,
  `test/dashboard-auth.test.ts`).

**Missing.**
- **No property or fuzz test of the merge guards:** `mergeDecision`, `neverAutoMerge` (`src/merge-policy.ts`), or
  the default-branch push refusal (`destinationRef`, `isDefaultBranchRef`, `defaultBranchRefusal` in
  `src/push-guard.ts`). Their tests are examples someone thought of.
- **No property or fuzz test of the auth paths:** `roleFromPermission`, `mayAnswerKind`, `validLogin`,
  `parseCookies`, `breakGlassAllowed`, `isLoopback` (`src/dashboard-auth.ts`).
- **No property-test library in the dependencies** (no `fast-check`). The redaction fuzz shows a seeded generator
  in the test itself is enough; the plan uses that, so no new dependency is needed.

**Risk: High.** These functions are the money path: one wrong `true` in a guard merges a change that should wait, or
lets a viewer answer an owner's decision. Examples miss the input nobody thought of.

## 3. Chaos tests (the failures of the weekend of 2026-11-07)

**Covered.**
- **Disk full.** A write the disk refuses is kept in memory and written later, a `disk_full` incident is raised, and
  no new run starts below the floor (`src/disk-guard.ts`; `test/disk-full.test.ts`, 11 tests).
- **A GPU run cut off or stopped is never run again by itself.** A run planned for the GPU is recorded as
  `gpu=planned` before any GPU command, so a run cut off by a hung machine isn't repeated after the restart; a GPU
  command stopped at its cap, killed, or with no exit is `gpuStopped` (`src/testrun/gpu.ts`,
  `gpuRunsNotToRepeat`; `test/testrun-gpu.test.ts` "the runs never to repeat"). The test runs, the batch and the
  deploy gate all check it (`src/coordinator/test-runs.ts`, `src/coordinator/pr-batch.ts`,
  `src/deploy-gate/gate.ts`).
- **A shifted clock.** The unit tests run weekly 45 and 400 days ahead (`.github/workflows/clock-shift.yml`).
- **A restart with checks unknown** (`test/main-checks-unknown-restart.test.ts`), and a stuck run repeating one
  tool call (`src/stuck.ts`; `test/stuck-guard.test.ts`).
- **A step past its cap** is stopped and says so (`src/testrun/timeout.ts`; `test/testrun-tier-timeout.test.ts`).

**Missing.**
- **GPU device loss mid-run.** When the GPU falls off the bus (PCIe fatal error, Xid 79), the next GPU command exits
  on its own, non-zero, saying "No devices were found". `gpuStopped` counts only a timeout, a kill or no exit
  (`src/testrun/gpu.ts`), so this is an ordinary failed tier: it isn't held from running again, and nothing says the
  GPU is gone.
- **A reboot that hangs** (host unreachable until a power cycle): the GPU case above is covered after the restart,
  but no test injects "the machine never came back" and checks that what was running is reported cut off, not
  repeated.
- **Disk full below the floor while a run writes**: covered (above); no gap beyond adding it to the chaos suite
  so all of a weekend's faults are in one place.
- **SSH host key change.** The engine's own git uses HTTPS with App tokens, but a project's test-run step or deploy
  command may SSH to a host whose IP changed. "Host key verification failed" is an ordinary failure today; nothing
  says the run must stop and ask, and nothing proves the engine never accepts a new key by itself.
- **Self-matching waiters.** A step that waits with `until ! pgrep -f X` or `ps … | grep X` matches its own shell
  and never ends. Today only the step's cap ends it, after up to 30 minutes, with nothing saying why.

**Risk: High.** These happened. A GPU loss repeated hangs the machine again; a waiter that never ends holds a slot
and the GPU lock until its cap.

## 4. Feature flags

**Covered.**
- **Per-feature switches in the project's config, off by default for six of them** (`src/config/schema.ts`: six
  `enabled: z.boolean().default(false)`), changed only through a reviewed config PR (`src/config-change.ts`,
  `src/config-pr.ts`), so git history records each change.
- **Staged modes** for some guards: the stuck guard is `off`, `dry-run` (log only) or `on` (`src/stuck.ts`).
- **Root's kill switch** turns auto-merge off for one instance and can't be undone by the coordinator
  (`src/policy-kill.ts`; `test/policy-kill.test.ts`).

**Missing.**
- **No general flag for a risky engine change.** A new behaviour ships on for every instance with the update that
  carries it. There is no "default off, on per repository" switch for engine code.
- **A flip isn't audited as one**: the config PR shows the file changed, not "flag X on for repo Y by Z", and the
  event log has no record of which flags a run had.

**Risk: Medium.** The canary and the updater's rollback limit the damage, but only after a bad change is live
everywhere.

## 5. Canary rollout

**Covered.**
- **A canary after every update and daily**: a scratch repo of its own gets a one-line issue that must go issue,
  plan, PR, green checks, merged, in a time limit. A failed or late canary after an update rolls the engine back and
  holds that commit (`src/canary.ts`, [canary.md](canary.md); `test/update-canary.test.ts`).
- **Release and main channels** for the updater (`src/updates.ts` `updateChannel`).

**Missing.**
- **No rollout order across instances.** One engine serves every instance on a machine, and one install switches them
  all. There is no ring order (the engine's own repo first, then each project in turn), no promotion criteria between
  rings, and no per-ring rollback.

**Risk: Medium.** The canary repo is tiny; a change that breaks only on a large repo reaches every project at once.

## 6. Shadow runs

**Covered.**
- **Harness evals replay fixed past tasks through the real coordinator** in a scratch instance with its own event
  log, on a scratch clone pushed to a local bare remote, so nothing reaches GitHub (`src/harness-evals/replay.ts`).
  The scores are compared with the last baseline and posted on the PR (`src/harness-evals/score.ts`;
  `test/harness-evals.test.ts`).
- **Dry-run modes** for some guards log what they would do without doing it (`src/stuck.ts`).

**Missing.**
- **No shadow of a candidate engine beside the current one** on the same live tasks, and no diff of their
  decisions (claims, plans, review levels, merge decisions, stops). The evals compare scores, not decisions.

**Risk: Medium.** A change in a decision (say, a merge that now waits, or one that no longer does) shows only once it
is live.

## 7. Soak test

**Covered.** Nothing runs the engine for hours. The longest CI jobs are the slow suite (`.github/workflows/ci-slow.yml`)
and the weekly clock shift.

**Missing.** No long run measuring memory and file handle growth, event log and journal growth, stuck or orphaned
runs, and slot or lock leaks.

**Risk: Low.** Leaks show over days. The watchdog's `stalled` and `crash_loop` incidents (`src/watchdog/`) would
catch the result, late.

## The plan

One PR per item, highest risk first. Each PR states its risk class, has a test for every behaviour that fails
without the change, and a "What this can never do" section.

**Order, and why.**
1. **a. Tamper-evident audit log.** High, and first because every later item reports through the event log. A chain
   that shows a changed or missing event makes the chaos reports, shadow diffs and flag flips trustworthy.
2. **b. Property-based / fuzz tests for the merge guards and the auth paths.** High: the money path. Tests only,
   unless they find a bug (then the fix is protected and the owner merges it).
3. **d. Chaos tests for the weekend's failures.** High: they happened. The GPU device-loss gap above is a real bug
   that this item fixes.
4. **c. Feature flags.** Medium. Before e and f, because a shadow or canary of a risky change needs a way to keep
   that change off where it isn't being tried.
5. **f. Canary rollout order.** Medium. Uses the canary that exists, and flags (c) for per-ring behaviour.
6. **e. Shadow runs.** Medium. Builds on the harness-eval replay.
7. **g. 8-hour soak test.** Low, and last: it measures, it protects nothing by itself.

| Item | What it adds | Risk class of the PR |
|---|---|---|
| a | A hash chain over every event in the log (agent runs, merges, decisions, audit rows, guardrail blocks): the head is checkpointed to a file of its own, and `audit verify` recomputes the chain and names the first event that differs. What is logged, retention and where it lives, in a doc. | logic |
| b | Seeded property and fuzz tests (no new dependency) for `mergeDecision`, `neverAutoMerge`, the push guard and the dashboard auth rules. | logic (tests only); a bug fix it leads to is protected |
| d | One chaos test per fault: GPU loss mid-run (Xid 79, "No devices were found"), a reboot that hangs, disk full below the floor, an SSH host key change, a self-matching waiter. Each injects the fault and asserts the engine detects it, stops cleanly, reports it, and never retries it blindly; plus the fixes those tests need. | logic |
| c | Feature flags: default off, on per repository, each flip an audited event. | logic |
| f | The rollout order (ring 0: the engine's own repo; then the project instances in the order the machine config lists), promotion criteria and rollback, as configuration and a doc. The instances' names live in the machine's config, never in this repository. | logic |
| e | Shadow runs: a candidate engine runs the same tasks as the current one with no side effects (no pushes, no merges), and a diff of their decisions and outputs is produced. | logic |
| g | An 8-hour soak test: a manual and scheduled workflow (never on every PR), with time and resource limits, measuring leaks, stuck runs and log growth. | protected (CI/workflows): the owner merges |
