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
  caches:
    - { name: npm, env: npm_config_cache, key: [package-lock.json] }
  shared:                           # directories all runs share, never wiped (e.g. a test-port registry)
    - { name: ports, env: TEST_PORTS_DIR }
  checks:                           # tier -> its GitHub check's name (default test-run/<tier>)
    chain: "test / chain"
  env: { TEST_WORKERS: "4" }        # never secrets: the same rules as tests.yaml env
```

- **Tiers.** `fast` tiers run on every PR, and again on each new head. `full` tiers run once per batch of approved PRs (PR mode). Each tier is one command, run under bash with pipefail in the run's workspace. It posts one check.
- **Placeholders.** `{changed_files}` is a file listing the change's paths, one per line: hand it to the project's own changed-plan command. The workspace has no `.git` (see below), so a plan that runs `git diff` itself won't work there. `{shard_index}` (1-based) and `{shard_total}`, or the short `{shard}` and `{total}`, place a shard in a sharded full run. Only a `full` tier marked `shardable` is split; every other tier runs in the first shard only.
- **Database.** A tier with `database: true` gets the run's own Postgres in `DATABASE_URL`: a container named after the run, on a port the daemon picks, on `127.0.0.1` only, with a random password. Its data is on a tmpfs, and it is removed with the run.
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
| `worklane-test-<name>-docker.service` | Rootless Docker as the test user, for the runs' databases. There is no root daemon and no `docker` group. Published ports bind `127.0.0.1`. |
| `/var/lib/worklane-test/<name>` | Per instance: `runs/<id>` (one per run), `cache/`, Docker's data. |

**One run.** The coordinator makes a run's workspace from `git archive` of the commit, piped to the helper, which unpacks it as the test user into `runs/<id>/work`. The test user never reads the coordinator's checkout or its `.git`. Each command runs as a transient unit `worklane-test-<name>-<id>-*` in `worklane-test.slice`, as the test user, with:

- a read-only system (`ProtectSystem=strict`), no `/home`, `/root` or `/run/user` (`ProtectHome=tmpfs`);
- every protected path above inaccessible, and the Docker socket too, so only the helper starts containers;
- no other run's workspace: `runs/` is an empty read-only tmpfs with only this run's directory bound in;
- a private `/tmp`, `TMPDIR` and `HOME` inside the run's directory, no devices, no new privileges;
- an environment of exactly `PATH`, `HOME`, `TMPDIR`, `LANG`, `CI`, `USER`, `LOGNAME` and the variables the run names. The helper refuses any variable that looks like a secret or that the sandbox sets. The coordinator passes only the project's own variables, the caches' directories and `DATABASE_URL`, never its own environment.

**The wipe.** After every run, pass or fail: the run's units are killed and stopped, its containers and volumes removed, and its directory deleted. The wipe then looks again and fails if anything is left.

**Caches** are shared by one instance's runs (never across instances). A run can write into a cache that a later run with the same lockfile uses. That is the same boundary as the agents' dependency cache (`src/dep-cache.ts`): npm and pnpm check every cached package against its integrity hash.

## Install

1. **root** The project's own machine script, for the full-run lock (`/run/lock/worklane-full-run.lock`, root-owned 0644) and its test tools.
2. Read `scripts/setup/test-user.sh` and `scripts/machine/worklane-testrun.sh` at the commit you'll run. Preview: `bash scripts/setup/test-user.sh --print install <name> --cpus <list> --memory-max <size>`.
3. **root** `sudo bash scripts/setup/test-user.sh install <name> --cpus <list> --memory-max <size>`. It checks the boundaries as the test user before installing anything else, and everything again at the end.

## Check

**root** `sudo bash scripts/setup/test-user.sh check <name>` prints PASS or FAIL for each check and exits non-zero on any FAIL:

- the user, its group and its lack of sudo;
- each protected path, probed as the test user: only an explicit "denied" passes, and a probe that didn't run is a FAIL;
- the same paths probed again from inside a sandboxed run;
- the lock file, the slice's caps against the instances', rootless Docker, and that the installed helper matches the checkout's.

## Undo

**root** `sudo bash scripts/setup/test-user.sh remove <name>` removes the sudoers rule, the Docker unit, the state, the ACL entries and the user. With no other test user left, it also removes the slice, the helper, the AppArmor profile and `/opt/worklane-test`.
