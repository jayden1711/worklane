# Test runs: a project's CI on the machine

The coordinator can run a project's tests itself for every PR, as a sandboxed test user, and post each tier as a GitHub check through the instance's App. The project's branch protection can then require those checks. The code is in `src/testrun/`; the machine side is `scripts/setup/test-user.sh` and the helper it installs, `scripts/machine/worklane-testrun.sh`.

Linux with systemd only (written for Ubuntu 24.04, x86_64). Every command marked **root** needs `sudo`.

## Configuration: tests.yaml `test_run:`

```yaml
test_run:
  setup: ["npm ci"]                 # before the tiers, with the caches set; a failure fails every tier
  tiers:
    - { name: chain,    command: "npm run chain",                 kind: fast }
    - { name: affected, command: "node scripts/plan.mjs {changed_files}", kind: fast, database: true }
    - { name: suite,    command: "npm test -- --shard={shard_index}/{shard_total}", kind: full, database: true, shardable: true, timeout_s: 3600 }
  database:
    image: postgres:16@sha256:<64 hex>   # pinned to its digest; a tag alone is refused
    name: test                           # the database DATABASE_URL names
    max_connections: 200                 # 20 to 2000; lanes x (pool + ORM connections) + headroom
  caches:
    - { name: npm, env: npm_config_cache, key: [package-lock.json] }
  shared:                           # directories all runs share, never wiped (e.g. a test-port registry)
    - { name: ports, env: TEST_PORTS_DIR }
  checks:                           # tier -> its GitHub check's name (default test-run/<tier>)
    chain: "test / chain"
  env: { TEST_WORKERS: "4" }        # never secrets: the same rules as tests.yaml env
```

- **Tiers.** `fast` tiers run on every PR, and again on each new head. `full` tiers run once per batch of approved PRs (PR mode). Each tier is one command, run under bash with pipefail in the run's workspace. It posts one check.
- **Placeholders.** `{changed_files}` is a file listing the change's paths, one per line: hand it to the project's own changed-plan command. A plan that runs `git diff` against `main` works too: the workspace is a git clone (see below). `{shard_index}` (1-based) and `{shard_total}`, or the short `{shard}` and `{total}`, place a shard in a sharded full run. Only a `full` tier marked `shardable` is split; every other tier runs in the first shard only.
- **Database.** A tier with `database: true` gets the run's own Postgres in `DATABASE_URL`: a container named after the run, on a port the daemon picks, on `127.0.0.1` only, with a random password. Its data is on a tmpfs, and it is removed with the run.
- **Database connections.** `max_connections` (20 to 2000, default 200) starts the run's Postgres with `-c max_connections=<n>`; the image's own default, 100, runs out ("sorry, too many clients already") once many lanes share the database. Size it as lanes x (each lane's pool + its ORM's own connections) + headroom for migrations, psql and Postgres's reserved superuser slots: 22 lanes with a pool of 8 and 2 ORM connections each need 22 x 10 + 20 = 240. `shared_buffers` stays at the image's 128 MB: the per-connection shared memory (lock and process slots) is small, a few tens of MB even at 2000, and each connection's working memory is its own process's, not shared buffers. The helper takes it as a number in that range only, never as text.
- **Checks.** Several tiers of one kind may map to one check (say three full tiers to `suite`): it passes only when all of them passed. A check can't have both fast and full tiers.
- **Shared directories.** Concurrent runs that must coordinate (a registry of test ports, say) get a directory of the instance's that every run can write and no wipe removes, in the variable named. It lives outside each run's `TMPDIR`, which is wiped.
- **Caches.** Each cache is a directory, given to the run in `env`. Its key is the sha256 of its `key` files at the run's commit, so a changed lockfile starts a new cache. The two newest keys of each cache are kept.

## The sandbox

`scripts/setup/test-user.sh install <name>` sets up one test user per instance:

| Piece | What it is |
|---|---|
| `wl-test-<name>` | The test user. Its own group only, no sudo, no login shell. It can't read, write or enter `/srv/worklane`, `/opt/worklane`, `/var/lib/worklane` or `/etc/worklane` (an ACL entry denies each to it), any other `wl-*` home (instance homes hold App keys and credentials), `/root`, `/etc/sudoers.d` or a root Docker socket. |
| `/usr/local/libexec/worklane-testrun` | The helper, root-owned. sudoers lets `wl-<name>` run it for `<name>` only; it checks every other argument itself. |
| `worklane-test.slice` | A top-level slice for all test runs: `AllowedCPUs` and a matching `CPUQuota`, `MemoryMax` with no swap, and CPU and IO weights below `worklane.slice`'s. `check` fails if its memory cap isn't below every instance's. |
| `worklane-test-<name>-docker.service` | Rootless Docker as the test user, for the runs' databases. There is no root daemon and no `docker` group. Published ports bind `127.0.0.1`. It uses the `cgroupfs` driver (the default systemd driver needs a user session the test user doesn't have). The daemon runs in the unit's subgroup `daemon` (`DelegateSubgroup=`), with `cpu io memory pids` delegated, so each container gets a cgroup of its own in the unit's, under the slice's caps. `check` fails otherwise. |
| `/var/lib/worklane-test/<name>` | Per instance: `runs/<id>` (one per run), `store/` (the object store), `cache/`, Docker's data. |

**One run.** A run's workspace is a git repo of its own, owned by the test user, so suites that call git (`git log main`, a diff against `origin/main`, LFS paths) work as on CI.
- Its objects come from the instance's **object store**, `/var/lib/worklane-test/<name>/store`: a bare repo of the test user's (0700), which every run's workspace reads through `objects/info/alternates`. It is never the coordinator's `.git`, which the test user can't read.
- The coordinator asks the helper the store's tips (`store-tips`: the commits it keeps, the newest 50), and writes a `git bundle` of only what the store lacks: the commit and the default branch, minus everything those tips reach. The first run of an instance sends the history; a run of a commit the store already has sends nothing at all; a new PR head sends its own commits. The bundle is made under temporary refs the coordinator removes at once, and is piped to the helper.
- As the test user, before anything of the run's runs, the helper fetches the bundle into the store (git checks every object it takes; objects are named by their hashes, so one run's objects never change what another reads), keeps the two commits under `refs/keep/`, and makes `runs/<id>/work`: the commit checked out, and the default branch as `main` and `origin/main` (and `origin/HEAD`).
- A run's own commands read the store and never write it: in the sandbox (below) everything outside the run's directory, the caches and the shared directories is read-only. `check` proves it on the host: its probe run reads its commit through the store and fails to write the store's objects, refs or files.
- `tests.yaml` `checkout.sparse_exclude` (directories no test reads, such as design files and art) is left out of the checkout (sparse; the commit still has them). A tier that needs them sets `full_checkout: true`, and then its whole run checks everything out (a run's tiers share one workspace).
- The workspace has no remote URL and an empty credential helper, `core.hooksPath=/dev/null`, and nothing of the coordinator's `.git/config` or anyone's global config. Neither has the store.
- The test user never reads the coordinator's checkout, and has no path back to it to write. Each command runs as a transient unit `worklane-test-<name>-<id>-*` in `worklane-test.slice`, as the test user, with:

- a read-only system (`ProtectSystem=strict`), no `/home`, `/root` or `/run/user` (`ProtectHome=tmpfs`);
- every protected path above inaccessible, and the Docker socket too, so only the helper starts containers;
- no other run's workspace: `runs/` is an empty read-only tmpfs with only this run's directory bound in;
- a private `/tmp`, `TMPDIR` and `HOME` inside the run's directory, no devices, no new privileges;
- an environment of exactly `PATH`, `HOME`, `TMPDIR`, `LANG`, `CI`, `USER`, `LOGNAME` and the variables the run names. The helper refuses any variable that looks like a secret or that the sandbox sets. The coordinator passes only the project's own variables, the caches' directories and `DATABASE_URL`, never its own environment.

**The wipe.** After every run, pass or fail: the run's units are killed and stopped, its containers and volumes removed, and its directory deleted. The wipe then looks again and fails if anything is left.

**Caches** are shared by one instance's runs (never across instances). A run can write into a cache that a later run with the same lockfile uses. That is the same boundary as the agents' dependency cache (`src/dep-cache.ts`): npm and pnpm check every cached package against its integrity hash.

## Runs

`startTestRun(req)` (src/testrun/index.ts) is the one way a run starts:

```ts
interface TestRunRequest { repo: string; sha: string; kind: 'fast' | 'full'; prs: number[]; changedFiles?: string[]; shard?: { index: number; total: number } }  // index is 1-based
interface TierResult { tier: string; ok: boolean; durationMs: number; summary: string; logRef: string }
interface TestRunResult { id: string; sha: string; kind: 'fast'|'full'; ok: boolean; tiers: TierResult[]; outcome: 'done' | 'cancelled' | 'error' }  // anything but done: no verdict
startTestRun(req, opts?: { signal?: AbortSignal }): Promise<TestRunResult>
postChecks(sha, result, checkNames): Promise<void>
```

1. **A slot.** The run waits for a test-run slot: `test-<i>.lock` in the machine's slot directory (docs/slots.md). The machine's cap is `max_test_runs`, changed from the dashboard's machine settings through the machine helper (`set-test-slots <1..8>`).
2. **The full-run lock**, `/run/lock/worklane-full-run.lock`, taken **shared**. Test runs never wait on each other. Agents' and other full runs take it exclusive, so a test run waits for one in progress and then proceeds; it never fails for the wait. The wait is recorded (`lock_wait_ms`). A missing lock file fails the run: it is never run unlocked.
3. **The run.** The workspace, the change's files, the caches, the shared directories and the database (only if a tier needs it) are set up first. Then the setup steps run, then the tiers. A failed setup step fails every tier. A tier that needs `{changed_files}` fails when the run was given none. No tiers of the kind is never a pass.
4. **The wipe**, pass, fail or cancel. A wipe that leaves anything is recorded (`testrun.wipe_failed`) and shown in health.
5. **Events:** `testrun.queued`, `testrun.started`, `testrun.tier` (with the tier's CPU time and peak memory, as the sandbox's unit reports them) and `testrun.finished`. Each tier's full log is in the instance's state (`state/test-runs/<id>/`), never in an event or a check.

**Cancel.** Aborting `signal` stops a run that is queued, waiting for the lock or running. It is wiped and recorded as `cancelled`.

**Sharding.** One `startTestRun` per shard, `shard.index` 1-based. Shardable full tiers run in every shard with `{shard_index}/{shard_total}`. Every other tier of the run runs in shard 1 only. `mergeShards` folds the shards' results into one: a tier passes only if it passed in every shard.

## Checks

`postChecks(sha, result, checkNames)` posts one completed check run per check name on `sha` through the instance's App. The check's output lists each tier's pass or fail and duration, never a log: a check is readable by everyone who can read the repo.

Posting needs the App's **Checks: read & write** permission, which only the owner adds. Without it, GitHub answers 403. That is recorded (`testrun.checks_failed`, `no_permission`), and health and the dashboard say so plainly. At start the coordinator also reads the App's permission on its installation (`testrun.checks_permission`), so a read-only App is reported before any post fails.

## On every PR

With `test_run` in tests.yaml and the sandbox's check passing at start (`testrun.sandbox`), the coordinator's tick (src/coordinator/test-runs.ts) works like this:

- At most every 90 s, one API call lists the open PRs. That covers the harness's, the owner's and bots' alike.
- It fetches each new head (`refs/pull/<n>/head`) and runs the fast tiers on it, with the files the PR changes against its base. Then it posts the checks on that head.
- **New head:** the run on the old head is cancelled, and a run starts on the new one. A closed PR's run is cancelled too. A cancelled run posts no check.
- **Restarts:** a head already run isn't run again. A run a restart cut short is wiped at start, recorded as `interrupted`, and run again.
- **Bots:** a bot's PR gets the fast tier. Its full tiers (a batch, in PR mode) wait until the owner approves it (`fullRunAllowed`).

## Agents skip local full runs

With `test_run` on and full tiers in it, the coordinator's test run is the full run. So neither an agent nor the coordinator's verify of its change runs the full suite on the machine as well (src/testrun/local.ts):

- A done_when `suite: full` is recorded as the issue says. The agent's brief and the verify use `suite: changed` instead, and so do CI fix runs and conflict runs.
- The full tiers still run, once per batch, as the test run's checks, which the PR waits for. Nothing CI checks is removed; only the duplicate local run goes.
- Direct landing (`land_mode: direct`) has no PR to carry the test run's checks, so its land gates are unchanged. `land.pre` steps aren't test runs. The nightly full run stays: it records main's baseline.
- With `test_run` off, nothing changes.

## How many at once

The default is 2 slots. For a machine with 24 cores and 30 GB running three instances (memory caps of 8G, 6G and 6G) and 6 agent slots:

- **Cores.** 24, less about 2 per agent slot (12), less 2 for the system and the coordinators, leaves 10. A run's test workers take about 4, so the cores allow 2 runs.
- **Memory.** 30 GB, less the instances' caps (20 GB), less 2 GB for the system, leaves 8 GB. A run with its Postgres takes about 2.5 GB, so memory allows 3 runs.

The smaller of the two is 2 (`recommendTestSlots`). Give `worklane-test.slice` the cores and memory to match, below the smallest instance's cap: `--cpus 16-23 --memory-max 5G`. Each tier's measured CPU time and peak memory are on the dashboard's machine page: change the count once real runs show what they take.

## Install

1. **root** The project's own machine script, for the full-run lock (`/run/lock/worklane-full-run.lock`, root-owned 0644) and its test tools.
2. Read `scripts/setup/test-user.sh` and `scripts/machine/worklane-testrun.sh` at the commit you'll run. Preview: `bash scripts/setup/test-user.sh --print install <name> --cpus <list> --memory-max <size>`.
3. **root** `sudo bash scripts/setup/test-user.sh install <name> --cpus <list> --memory-max <size>`. It checks the boundaries as the test user before installing anything else, and everything again at the end.
4. **root** `sudo bash scripts/setup/machine-helper.sh <every instance>` again, so the coordinators may run `set-test-slots`.
5. **owner** In the App's settings, add **Checks: read & write**, then accept the new permission on the installation. Then restart the instance: it records the permission at start.
6. **owner** Once the checks show on PRs, require them in the branch protection (not strict, unless `config.yaml` `protection.strict` opts the repo in).

## Check

**root** `sudo bash scripts/setup/test-user.sh check <name>` prints PASS or FAIL for each check and exits non-zero on any FAIL:

- the user, its group and its lack of sudo;
- each protected path, probed as the test user: only an explicit "denied" passes, and a probe that didn't run is a FAIL;
- the same paths probed again from inside a sandboxed run;
- the lock file, the slice's caps against the instances', rootless Docker and its cgroups (the daemon in its unit's `daemon` subgroup, the controllers delegated), and that the installed helper matches the checkout's.

## The helper's protocol

The engine and the helper change together, but root installs the helper. So at start the coordinator asks the helper its protocol version (`worklane-testrun <name> version`), once, and starts no test run unless it is exactly the engine's (`HELPER_PROTOCOL` in `src/testrun/helper.ts`, `PROTOCOL` in the helper; a test keeps them equal). A helper too old to have `version` counts as outdated. When it is outdated, each PR gets a failing check saying so and how to fix it, and the watchdog raises one `helper_outdated` incident. The fix only reinstalls the helper and changes nothing else:

**root** `sudo bash /opt/worklane/current/scripts/setup/test-user.sh update-helper`, then restart the instance.

The updater keeps the helpers in step on its own. With the services stopped, just before it switches to a new engine, it replaces each root helper the machine has (this one, the machine helper and the console shell) with the new engine's copy when they differ. It writes a checked temp file beside the helper with the same owner and mode, then renames it over the helper. It never touches sudoers. If a helper can't be replaced, it rolls back and holds the update. Every rollback puts the old engine's helpers back.

A setup step that fails (the workspace, a cache, the database, a setup command) is named in the check, with the last 20 lines of its stderr, redacted. Its stdout is never shown: `db-start` prints the database's password there.

## Undo

**root** `sudo bash scripts/setup/test-user.sh remove <name>` removes the sudoers rule, the Docker unit, the state, the ACL entries and the user. With no other test user left, it also removes the slice, the helper, the AppArmor profile and `/opt/worklane-test`.
