# Gated-merge benchmark on SWE-bench Verified (#748)

This runs the engine's full loop on SWE-bench Verified tasks, in local clones only: worker, evaluator with a fail-without repro, tests, a merge decision in PR mode. It then grades every exported patch with SWE-bench's hidden tests, after the run, in fresh containers. It reports:
- merge precision;
- false holds;
- caught bad fixes;
- the B0 (agent alone), B1 (agent + CI only) and plain `claude -p` baselines.

Every rate comes with a Wilson 95% interval. It is a gated-merge benchmark built on SWE-bench Verified, not a SWE-bench score.

**Status: Phase 0, nothing has run.** No model call, image pull, registry request or download has been made from this code.

What is here so far:
- **Preflight** (`paths.ts`, `auth.ts`, `caps.ts`, `usage.ts`): the bench user, login and CLI pin checks, the caps, and the usage meter with its clean stop.
- **Containers** (`container.ts`, `agent.ts`, `hidden.ts`, `probe.ts`): the rootless Docker launcher with required limits, the exec-only task runner, the hidden-field guards, the agents' environment and sandbox, and the srt sandbox probe.
- **Driver** (`driver.ts`, `confirm.ts`, `grade.ts`, `aggregate.ts`, `store.ts`): the run loop, the sandbox confirmation, patch export, the predictions for grading, and the aggregate. `srt-fingerprint.mjs` compares a sandbox-runtime release with the build a Claude Code binary bundles.
- **The `bench` command** (`cli.ts`): `bench preflight` runs the model-free, container-free checks above and prints a PASS/FAIL/SKIP line each (setup step 6).
- **Pinned downloads** (`pins.json`, `pins.ts`, `download.ts`): `bench download` fetches the dataset file at its pinned revision and sha256 into the held-out store, and `pullImage` pulls a task image by pinned digest only (step 7). The dataset isn't pinned yet, so `bench download` refuses until the owner records the pin.
- **Task selection** (`select.ts`): `bench select` chooses the tasks by a fixed rule and seed from the pinned rows, writes the manifest into the held-out store, and prints keys and the smoke run's plan, never an instance id (step 8). `loadTasks` hands the run its tasks and their image references from the store. The rows aren't pinned yet, so `bench select` refuses and prints their digest for the owner to record.
- **Task images** (`images.ts`): `bench images` writes each selected task's image reference into the held-out store, from the store's manifest, with each digest taken only when `pins.json` pins it (step 9). No image digest is pinned yet, so it refuses.
- **Pulls and base trees** (`pull.ts`): `bench pull --tasks smoke|baseline` pulls that task set's images by their pinned digests (never a tag) and reads each digest back. It then copies each task's base tree out of its own image's `/testbed`, through the bench's container runner, into the held-out store, as a bare remote with one commit (no upstream history) and a clone of it (step 10).

Still to come:
- the PR-mode task runner on the replay harness (`src/harness-evals/replay.ts`), with stub CI, and the agent's test relay into the container: both need the engine's runner seam (#701);
- `bench run`, the grading run and the B0, B1 and `claude -p` baselines.

See "The smoke run plan" below for the order.

## How it is isolated

- **One OS user runs everything:** the bench user (default `wl-bench`, `WORKLANE_BENCH_USER` names another). It has its own clone of this repo at the pinned commit, its own `claude`, its own rootless Docker, and data in `~/bench` (`WORKLANE_BENCH_ROOT` overrides it). There is no sudo and no switching users. The driver refuses to start as any other user, and as root (uid 0 or the name root) even when `WORKLANE_BENCH_USER` names it.
  - Its home is the one in the user database (its passwd entry), never `$HOME`: a `$HOME` that differs is refused, since claude would follow it to another login. Log in with `sudo -iu wl-bench`, which sets it right.
  - A bench root through a link that doesn't resolve (dangling, or a loop) is refused.
- **No API key.** `claude` is the unmodified CLI, signed in once by the owner through Anthropic's own `/login`.
  - Before any run, the driver asks `claude auth status --json`. It starts only on `authMethod` `claude.ai` with `apiProvider` `firstParty`, whatever the plan (enterprise, team, personal), and records the plan and the login's `configDirectory`, which must be inside the bench user's home.
  - It refuses `oauth_token` (also a gateway bearer, federation or a Console profile), an API key, an API key helper, Bedrock, Vertex, Foundry, a signed-out status and an unreadable one.
  - It refuses, before asking, any variable that can switch the login, by prefix: every `ANTHROPIC_*`, `CLAUDE_CODE_USE_*`, `CLAUDE_CODE_OAUTH_*`, `CLAUDE_CODE_SKIP_*_AUTH`, `CLAUDE_CODE_API_KEY*`, `CLAUDE_CODE_PROVIDER_*`, `CLAUDE_CODE_CLIENT_*`, any `*_FILE_DESCRIPTOR` or `*_BASE_URL`, `AWS_*`, `AZURE_*`, Google credentials and anything naming Bedrock, Vertex, Foundry or Mantle (`auth.ts` `LOGIN_SWITCH_VAR`).
  - It never reads, copies, mounts or relays the login.
- **Pinned CLI.** Before the run, `claude --version` must equal the pin: `2.1.303` by default, or `WORKLANE_BENCH_CLAUDE_VERSION` once the owner approves another. Every `claude` the bench starts gets `DISABLE_UPDATES=1`. The version is recorded with the results.
- **Agents run on the host, in the engine's sandbox, with no network for their commands.**
  - Model traffic comes only from the host `claude` process.
  - The sandbox denies the agents' commands and Read tool: the login (`~/.claude`, `~/.claude.json`), the other credential stores, `$XDG_RUNTIME_DIR` (the Docker socket and the user bus), the system Docker sockets, a unix `DOCKER_HOST`'s socket, the rootless daemon's data root (`~/.local/share/docker`), the system journal (`/var/log/journal`, `/run/log/journal`: the bench user can read its own journal there, and its dockerd may log the task images it pulls), and the bench's state and held-out store. The Read tool gets each path's exact rule as well as its folder rule, so a file such as `~/.claude.json` is matched itself.
  - The agent's environment has no `DOCKER_*`, `XDG_RUNTIME_DIR` or `DBUS_SESSION_BUS_ADDRESS`. An agent that could reach the daemon could mount the login into a container and send it out.
  - **Where an agent may write.** That deny list covers reads only.
    - Its Bash commands write only where the sandbox lets them: the run's working folder and the temp folder, plus the paths of its Edit allow rules (Claude Code's sandboxing docs, **inferred**). The bench's only Edit allow rule is the run's working folder, so it adds nothing.
    - Its Edit, Write, MultiEdit and NotebookEdit tools run outside the sandbox, as the bench user. Pre-approved without a scope, they could change unprotected files the bench user owns, such as `~/.docker/config.json` (a `credsStore` helper that the driver's own `docker` would run), `~/.config/systemd/user/` or `~/.local/bin/`. `dontAsk` mode already denies writes to protected paths such as `~/.profile`, `~/.bashrc`, `~/.claude/` and `.git/`, even with an allow rule (Claude Code's permission-modes docs, **inferred**).
    - So they are confined to the run's own working folder, which must be inside the task's folder (`runs/<run>/<key>/`). Every agent run goes through the task's meter. It refuses, unstarted, a run with no working folder, or one outside the task's folder by path or where it really is (its realpath; a task folder that is itself a link is refused too, since the driver builds it on the bench root's real path), or one reached through any link at all, even one that stays inside. It scopes a bare `Edit`, `Write`, `MultiEdit` or `NotebookEdit` to `Edit(//<working folder>/**)`, and refuses a run that grants any of them anywhere else. Not the whole task folder: an Edit allow rule would also let sandboxed Bash write there, and the sandbox protects `.claude/` and `.git/` hooks and config only in and above the working folder (**inferred** from the sandboxing docs).
    - **The folder is checked before the engine spawns claude in it, after some awaits.** In between, anything that can write a parent of one of its folders could swap that folder for a link out. In the bench, that is another of the task's runs: its sandboxed Bash may write its own working folder. That this is the only such writer is **inferred**: it assumes nothing outside the task folder's own runs writes inside it while a run starts (the driver writes only its records, between tasks; the container has no mount). So the meter refuses two kinds of run, unstarted:
      - a run whose working folder is nested with the folder of a run of the task still going: the same folder, or one inside the other, either way;
      - a run strictly inside the folder of an earlier run, which a process it left behind could still write.

      Runs in disjoint folders, and runs one after another in the same folder, are fine.
    - **Folders are compared by device and inode as well as by path** (round 7).
      - **A rename** while a run is going (**measured**, test): the renamed folder, and what is under it, are still the same folder.
      - **A second spelling** on a case- or normalisation-insensitive filesystem (**inferred**, not measured: making one needs root): caught the same way. That rests on the filesystem giving each folder a stable, unique device and inode. ext4 with casefold does. vfat and exFAT keep a folder's number only while its inode stays in memory: an ended run's folder, with nothing holding it, can get a new number after eviction (**inferred**, from how their kernel drivers number inodes). Some FUSE or network filesystems don't promise it either, for example sshfs without `use_ino`. So keep the bench root on a filesystem with stable inode numbers, such as ext4 (the README's setup puts it under the bench user's home).
      - **When the chain is recorded:** each run's folder and its parents, up to the task folder, are recorded when the run registers. A running folder moved under a new parent later isn't seen in its new parents. Only a writer outside the task's runs could make that move, which the assumption above excludes (**inferred**).
    - **One meter per task folder** (round 7). The driver makes the run folder and each task folder fresh, and refuses one that already exists, so a run id is never used twice (pick a new one after a crash). It also refuses a task key that appears twice in one run. So no task folder ever has runs that its meter hasn't seen.
    - **What this means for RunTask** (the task runner still to come):
      - no run can sit below an earlier run's folder. A run at the clone's root followed by runs in worktrees under it (the engine's default `.claude/worktrees`) is refused, so the task's worktrees go outside the clone, side by side in the task folder;
      - runs of one task can be concurrent only in disjoint folders.
    - A path that goes into a rule (the task's folder, the working folder) must have no glob or rule character (`* ? [ ] { } ! ( ) \`, a comma, whitespace, a control character (C0, DEL or C1), a format character such as a zero-width space or a bidi override, or a lone surrogate) and no trailing slash. Format characters include the zero-width non-joiner and joiner (U+200C, U+200D) and the soft hyphen (U+00AD), so a name that uses them (some Persian or Indic names, emoji ZWJ sequences) is refused too. Such a path is refused, not escaped. A bench root with a space in it is therefore refused.
    - Claude Code asks before any other file edit, and the bench runs in `dontAsk` mode, which refuses anything that would ask.
    - Nothing the driver reads back trusts that folder either: patches are exported from the clone's objects only, in a bare repo the driver makes, with no config but its own.
  - **No retry.** A run that fails is recorded, never retried (the engine's runner is built with retries off). Any usage or rate limit stops the bench: a `rate_limited` result, and a failed run on a 429 alike.
- **The repo's environment and tests run in one throwaway container per task**, from the task's SWE-bench image, in rootless Docker.
  - Each container has `--network none`, `--cap-drop ALL` and `no-new-privileges`, and mounts nothing.
  - The worktree reaches the container as a tar stream on `docker exec -i`.
  - Task commands go through a runner that sends only `docker exec <that task's container> argv`, with a normalized work dir under `/work` and `NAME=value` variables. Any other verb, any mount or privilege flag, and any credential or daemon variable are refused.
  - The driver's own `docker` always gets an absolute `DOCKER_HOST` (the bench user's, or `unix://$XDG_RUNTIME_DIR/docker.sock`), so a docker context never picks its daemon. `DOCKER_CONTEXT` and a relative `unix://` `DOCKER_HOST` are refused.
- **Limits are required.** Every container gets `--memory` with an equal `--memory-swap`, `--cpus` and `--pids-limit`.
  - Defaults: 8g, 4 CPUs, 4096 pids. Override them with `WORKLANE_BENCH_MEMORY`, `WORKLANE_BENCH_CPUS` and `WORKLANE_BENCH_PIDS`. Refused: a zero or missing value, more CPUs than the host has, memory over 75% of the host's, and memory that isn't a multiple of 4096 bytes.
  - Before the first task, a probe container is created with the limits. They are read back through `docker inspect` (Memory, MemorySwap, NanoCpus, PidsLimit), then from inside the container (`memory.max`, `memory.swap.max`, which must be 0, `cpu.max`, `pids.max`).
  - Each task's container is checked the same way before any agent or command runs.
  - A limit that didn't apply refuses the run and names the controller. Fix it with the drop-in in step 2 below.
  - **Wall-clock cap.** The driver has its own cap per task (3 h), always enforced.
    - Every agent run and every command in the task's container gets the task's stop signal, whatever the task passes. At the cap they are killed, and none starts after it.
    - The driver waits for the runs in flight to end before it records the task's spend and starts the next task. If one is still going 5 minutes later, the bench halts rather than overlap, and every later task is "not run (halted)".
    - A command in the container is ended by killing its `docker exec` and then removing the container.
- **Hidden tests stay hidden.**
  - The dataset, the manifest, the hidden fields (`patch`, `test_patch`, `FAIL_TO_PASS`, `PASS_TO_PASS`, `hints_text`, difficulty) and the predictions live in `$HOME/bench/state/evals/held-out/swebench/`, owner-only. That path is also on the engine's held-out deny glob.
  - A container and the agents get only the base commit, the problem statement and the test runner.
  - As a narrow second wall against a driver bug, every docker command is scanned (UTF-8 substrings) and refused on a match:
    - its argv for the gold and test patches' added lines of at least 24 characters, test ids of at least 12, the hints and the instance id;
    - its stdin (a worktree's tar stream) only for the instance id, the hints, or 3 or more consecutive test-patch lines that the task's base tree lacks. An agent's own fix that equals the gold line, or its own test with the upstream test's name, goes through, and a stdin refusal never says which field matched.
  - That scan can't see compressed or binary content, other encodings or shorter lines; the first wall (nothing hidden is ever handed over) covers those.
  - Known issue for the test relay still to come: an argv naming a FAIL_TO_PASS or PASS_TO_PASS test by its pytest id is refused (naming the field), though the base tree may have that test.
- **Grading reads only the exported patches** (`runs/<run>/patches/<key>/<label>.diff`, plain files only). It runs the official harness in fresh containers after the run. Only the held-out store maps a task key (`t01`, ...) to its instance id.
- **Research-on-demand is off.** Every research cap is 0, and the driver checks it before starting.

## Sandbox checks, before every run

Two checks that an agent really can't reach the daemon's sockets or the credential files. Both run before the first task, and both are recorded in `runs/<run>/sandbox.json`, `results.json` and the aggregate.

1. **The srt probe (no model call).**
   - **Why srt:** Claude Code 2.1.303 has no command that runs a command in its own sandbox without a model, so this check runs under `srt`, the CLI of sandbox-runtime, the library Claude Code's sandbox is built on.
   - **The version:** `srt --version` must be exactly `0.0.79` (step 4 of the setup installs it), or the run is refused.
   - **Label:** sandbox-runtime 0.0.79 is close to, not identical with, the build bundled in Claude Code 2.1.303. `srt-fingerprint.mjs` compares the binary's `[Sandbox Linux]` log strings with each release's. On 2026-10-18 it placed the bundled build between 0.0.79 (1 string apart each way) and 0.0.80 (4 apart each way).
   - **What it does:** with the agents' own lane settings (the same `denyRead`, no hosts), it tries to connect to each Docker socket (`$XDG_RUNTIME_DIR/docker.sock`, `/run/docker.sock`, `/var/run/docker.sock`, a unix `DOCKER_HOST`), the user bus (`$XDG_RUNTIME_DIR/bus`) and the rootless containerd socket, and to open `~/.claude.json`, `~/.netrc`, `~/.npmrc` and `~/.pypirc`. It reports only what each one is and never reads a byte.
   - **The verdict:** every attempt must be refused, with the lane's deny rule for the path in place. A missing file counts as refused only when its rule is there; the deny rule is checked in the settings, and whether the path exists on the host is recorded beside it.
2. **The confirmation in Claude Code (one model call).**
   - The run's first model call, on `claude-haiku-5-5`, through the usage meter: capped at $0.50 and counted against the run's ceiling. Claude Code runs these with the agents' lane:
     - `curl --unix-socket <sock> http://localhost/_ping` for each socket;
     - for each **sentinel**, two reads:
       - `cat '<s>'`. Claude Code's permission layer parses `cat`, so the lane's Read deny rule most likely refuses it before the OS sandbox runs anything (**inferred** from its permissions docs). It tests the permission layer, not the sandbox;
       - `node -e "<READ_JS>" '<s>'`, a read the permission layer doesn't parse. So the OS sandbox's own `denyRead` is what has to stop it. READ_JS opens the sentinel and `fstat`s it. The sandbox masks a denied file with `/dev/null`, so a file that isn't regular exits 3 and counts as refused (as in the srt probe). A regular file is read and printed, which is a leak.
   - **Sentinels, never real credentials.** Where `~/.netrc`, `~/.npmrc` or `~/.pypirc` doesn't exist, the driver creates a sentinel there with random content (never over anything: it creates new files only) and removes it after, on SIGINT, SIGTERM and SIGHUP too.
   - `~/.claude.json` is never touched, whether or not it exists. Its sentinel always goes in `~/.claude/`, under the login folder's rule (`Read(//<home>/.claude/**)` and the sandbox's denyRead of `~/.claude`), and there is none when that folder is missing. The other three test the exact-path form.
   - A path that already holds a real file gets no sentinel and is never put to the model. The srt probe covers it.
   - **The verdict is read from Claude Code's stream-json transcript** (which tools and commands ran, and what each returned), not from the model's prose. Per attempt:
     - **refused** only when the exact listed command ran and its tool result is an error (`is_error`, which Claude Code sets on a non-zero exit). Exact means the same command with no Bash input but `command` (a string) and `description` (absent or a string). A timeout, a background run, or a command or description of another type makes it an extra call: Claude Code would refuse that shape without running it;
     - **reached** when any command naming the target exited 0, or a sentinel's content or a `_ping` `OK` came back. Any reached attempt, or any sentinel's content anywhere in the transcript, refuses the run;
     - anything else counts as not run.
   - **Which layer stopped each attempt** (`layer`), from the transcript's own markers only, failing closed:
     - **permission layer:** the result line's `permission_denials` lists the call, or its error result says "Permission to use … has been denied" (or the don't-ask-mode variant). Both markers are **inferred** from public docs and Claude Code's known wording, not verified against 2.1.303; the smoke's first call measures them;
     - **OS sandbox:** only the exact listed read of a sentinel that ran and failed on a masked or unreadable file (READ_JS's mask, `EACCES`, `EPERM` or `ENOENT`; for `cat`, "Permission denied", "Operation not permitted" or "No such file or directory"), and only when the model ran nothing else. An extra command could make that mark itself (a `chmod` through a glob, say), so with any extra call no attempt gets this layer and `os_sandbox_read_deny` is false;
     - **unknown:** the exact command failed with neither marker. This is every socket attempt that the permission layer didn't refuse, since curl failing to connect can't tell a sandbox from a missing socket. It is never counted as the OS sandbox;
     - **model declined:** the exact command never ran.
   - **The status:**
     - **"all refused"** only when every attempt was refused and the model ran nothing but the listed commands;
     - **"sandbox confirmation: model declined"** when the model ran any other command or tool call (a `server_tool_use` included), or skipped a listed one. The run goes on only because the srt probe passed, and the summary says so in a warning;
     - when every attempt was refused but the OS sandbox didn't refuse every `node -e` read itself (`os_sandbox_read_deny` false), the summary warns that the sandbox's own read-deny rests on the srt probe.
3. **Keeping the probe current.** On each new sandbox-runtime release, run `node scripts/bench/srt-fingerprint.mjs <unpacked package> ~/.local/share/claude/versions/<pin>`. When a release shows no difference, switch `SRT_VERSION` (`probe.ts`) and step 4's install (its version and checksums) to it, as a reviewed change.

## Caps (usage-equivalent dollars)

A subscription bills nothing per run. The bench records, per task, what the CLI's own accounting says each run would have cost (`total_cost_usd` in its JSON result) and caps on that:

| | Cap |
|---|--:|
| One smoke round (`--tasks smoke`) | $40 |
| Baseline (`--tasks baseline`) | about $300, re-derived from the smoke |
| Per task (`--per-task-cap`, default and maximum) | $15 |

- Without `--spend <usd>` the driver prints its plan and exits 2.
- If the smoke round averages over $8 per task, the baseline needs the owner's re-approval.
- **At any usage or rate limit the bench stops cleanly.** There is no retry and no other account. The task in flight is recorded as stopped, every later task as "not run (usage limit)", and the aggregate says it is partial.

## One-time setup (the owner runs these; Ubuntu with systemd, WSL2 included)

### 1. Docker Engine packages (an admin account, with sudo)

**This is Docker Engine, not Docker Desktop.** On WSL2, turn Docker Desktop's WSL integration off for this distro (Docker Desktop, Settings, Resources, WSL integration), so no Desktop daemon or socket is reachable from it. The preflight refuses a daemon that isn't rootless, and Desktop's isn't.

Install from Docker's apt repository (https://docs.docker.com/engine/install/ubuntu/), pinned and held:

    sudo apt-get update
    sudo apt-get install -y ca-certificates curl uidmap slirp4netns
    sudo install -m 0755 -d /etc/apt/keyrings
    sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    sudo chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list
    sudo apt-get update
    apt-cache madison docker-ce | head -3          # pick VERSION
    sudo apt-get install -y docker-ce=VERSION docker-ce-cli=VERSION containerd.io docker-ce-rootless-extras=VERSION
    sudo apt-mark hold docker-ce docker-ce-cli docker-ce-rootless-extras containerd.io

Turn the root daemon off, so the rootless one is the only daemon:

    sudo systemctl disable --now docker.service docker.socket
    sudo rm -f /var/run/docker.sock

Add no one to the `docker` group.

### 2. The user, its subordinate ids, linger, and cgroup delegation (admin, with sudo)

    sudo apt-get install -y bubblewrap socat         # the sandbox's own dependencies (Claude Code's and srt's)
    sudo useradd -m -s /bin/bash wl-bench
    grep wl-bench /etc/subuid /etc/subgid          # one line in each; if missing:
    sudo usermod --add-subuids <start>-<end> --add-subgids <start>-<end> wl-bench
    sudo loginctl enable-linger wl-bench           # its user manager: /run/user/<uid> and a user bus

**Required:** delegate the cgroup controllers to user managers. Without this, rootless Docker can't apply the memory and CPU limits, and the driver refuses to run.

    sudo mkdir -p /etc/systemd/system/user@.service.d
    printf '[Service]\nDelegate=cpu cpuset io memory pids\n' | sudo tee /etc/systemd/system/user@.service.d/delegate.conf
    sudo systemctl daemon-reload
    sudo systemctl restart user@$(id -u wl-bench).service
    cat /sys/fs/cgroup/user.slice/user-$(id -u wl-bench).slice/user@$(id -u wl-bench).service/cgroup.controllers
                                                   # expect: cpuset cpu io memory pids

Keep the admin account's own home closed to the bench user (the agents' sandbox denies only the bench user's own credential places, so this is the OS wall for everything else of yours):

    chmod 750 "$HOME"                              # as the admin account, on its own home
    sudo -u wl-bench ls "$HOME"                    # expect: Permission denied

### 3. As the bench user

    sudo -iu wl-bench

Then, in that shell:

    echo 'export XDG_RUNTIME_DIR=/run/user/$(id -u)' >> ~/.profile
    echo 'export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus' >> ~/.profile
    echo 'export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock' >> ~/.profile
    echo 'export DISABLE_UPDATES=1' >> ~/.profile
    . ~/.profile

    # rootless Docker
    dockerd-rootless-setuptool.sh install
    systemctl --user enable --now docker
    docker info | grep -E 'Context|rootless|Cgroup'   # expect rootless, cgroup v2, the systemd driver, no limit warnings

    # Claude Code at the pin. The installer works only with DISABLE_UPDATES unset:
    curl -fsSL https://claude.ai/install.sh | env -u DISABLE_UPDATES bash -s 2.1.303
    ~/.local/bin/claude --version                  # expect 2.1.303 (Claude Code)

    # sign in with the owner's account, through Anthropic's own flow, in this terminal
    ~/.local/bin/claude                            # then /login, then /exit
    ~/.local/bin/claude auth status                # expect a claude.ai sign-in

### 4. sandbox-runtime for the srt probe (as the bench user)

Where it comes from: the npm registry, package `@anthropic-ai/sandbox-runtime`, version **0.0.79** (`SRT_VERSION` in `probe.ts`), tarball `https://registry.npmjs.org/@anthropic-ai/sandbox-runtime/-/sandbox-runtime-0.0.79.tgz`. Its registry checksums (read from `npm view @anthropic-ai/sandbox-runtime@0.0.79 dist` on 2026-10-19):
- integrity: `sha512-WjBmS9fbTpnQwQkM9SU+JjhM2CcXo9eWEELktY1100RMvTy/jPhP44yZ3NXhh+GHB350OgPbM3+FubE5WVRtSA==`
- shasum (sha1): `89b8735f51ad38791cb1a2913b616745dc5c04dc`

Fetch the tarball, check it against the pin, and install that file, for this user only (it is no repo dependency). The install is chained on the check, so a checksum mismatch, a failed fetch or a missing `openssl` installs nothing (`test/bench-cli.test.ts` runs this block with stand-ins):

    mkdir -p ~/src/srt-0.0.79 && cd ~/src/srt-0.0.79 &&
      npm pack @anthropic-ai/sandbox-runtime@0.0.79 &&
      test "sha512-$(openssl dgst -sha512 -binary anthropic-ai-sandbox-runtime-0.0.79.tgz | base64 -w0)" = "sha512-WjBmS9fbTpnQwQkM9SU+JjhM2CcXo9eWEELktY1100RMvTy/jPhP44yZ3NXhh+GHB350OgPbM3+FubE5WVRtSA==" &&
      echo "checksum OK" &&
      npm install -g --ignore-scripts --prefix ~/.local ./anthropic-ai-sandbox-runtime-0.0.79.tgz
    ~/.local/bin/srt --version                     # expect 0.0.79 (no such file: the checksum didn't match, nothing was installed)
    cd ~

The tarball is pinned; its four dependencies (`zod`, `commander`, `node-forge`, `@pondwader/socks5-server`) are resolved by npm within their semver ranges when it installs (**inferred** from the package's metadata: it ships no lock file). `--ignore-scripts` keeps any of their install scripts from running as the bench user; sandbox-runtime 0.0.79 has none of its own (`npm view ... scripts`, measured by the #851 review).

### 5. The bench's own clone, at the pinned commit (as the bench user)

The clone comes from this repository's own URL: `repository.url` in `package.json`, without its `git+` prefix (written there, not here, so this folder names no project). The pinned commit is a commit on `main` that has `scripts/bench/cli.ts`: for the first preflight, the merge commit of the PR that added it. Every run records the CLI version and the results; keep the commit you used with them.

If `~/src/bench-engine` already exists (an earlier clone), move it aside first, under a name of its own each time (`mv ~/src/bench-engine ~/src/bench-engine.$(date +%Y%m%d-%H%M%S)`): `git clone` refuses a folder that is there and not empty, and the chain then stops. A fixed name such as `bench-engine.old` works only once; the next `mv` would put the clone inside it. This step is redone after every reviewed change to `pins.json`, since the bench reads its pins from this clone. Replace the two PASTE_ values first. Each command is chained on the one before, so a clone at any other commit is never built or installed:

    BENCH_REPO=PASTE_THE_HTTPS_CLONE_URL
    BENCH_SHA=PASTE_THE_40_HEX_PINNED_COMMIT
    git clone "$BENCH_REPO" ~/src/bench-engine &&
      git -C ~/src/bench-engine checkout --detach "$BENCH_SHA" &&
      test "$(git -C ~/src/bench-engine rev-parse HEAD)" = "$BENCH_SHA" &&
      (cd ~/src/bench-engine && npm ci --ignore-scripts && npm run build) &&
      mkdir -p ~/.local/bin &&
      printf '#!/bin/sh\nexec node %s/src/bench-engine/dist/scripts/bench/cli.js "$@"\n' "$HOME" > ~/.local/bin/bench &&
      chmod 755 ~/.local/bin/bench &&
      echo "bench installed at $BENCH_SHA"

### 6. The preflight

From the admin account:

    sudo -iu wl-bench

Then, in that shell (a new login shell, so `~/.local/bin` is on PATH: Ubuntu's default `~/.profile` adds it when it exists, **inferred**; otherwise run `~/.local/bin/bench preflight`):

    bench preflight

It runs every check a run makes before any model call or container, as the bench user only (it refuses any other user, and root, before anything else runs), and prints one line per check: PASS, FAIL (with why) or SKIP. It exits 0 only when every check passes. It starts no container, makes no model call, downloads nothing and keeps nothing on disk (the srt probe's settings go in a 0600 temporary file, removed when srt ends); it prints no variable's value, no token and no account detail but the login's method and plan. The checks:

- the bench user (never root: neither the real nor the effective uid is 0, and both are known), and HOME is its home in the user database; when either fails nothing else runs;
- the bench root (outside every checkout, credential store and engine state), and the held-out store: not made yet, or a folder of this user at exactly 0700, with no link anywhere from the bench root down to it;
- research-on-demand off (every cap 0);
- `claude --version` is the pin, and `claude auth status` reports a claude.ai login on Anthropic's own API (no login-switching variable set);
- the srt probe (step 4's srt, the agents' lane): every socket and credential attempt refused;
- `docker info`: this user's daemon is rootless, through an absolute `DOCKER_HOST` (no docker context);
- the containers' limits are valid for this machine.

Left to the run: the limits read back from a probe container (it needs a task image), and the sandbox confirmation, the run's first model call.

### 7. The pinned download (needs the owner's OK; on the bench machine only)

Every pin is in one file, `scripts/bench/pins.json`. Nothing else sets one: no variable, flag or argument (`bench download` takes none), and the code takes a pin only as `pins.ts` parsed it from that file. It holds:
- `dataset`: the file's url (`base` + `revision` + `/` + `path`, so it is at the pinned revision by construction), the `revision` (a 40-hex commit), the file's `sha256`, `max_bytes` (the most it reads) and `hosts` (where a redirect may lead: each host or its subdomains, https only). `revision` and `sha256` are both set or both null. They are null now, so `bench download` refuses and fetches nothing. The `path` there is a guess until the owner pins it (**guess**): check it names the file meant.
- `image_digests`: sha256 digests only, sorted, none or at least 100 of them. Never an image name, an instance id or a task selection: the agents can read this clone, and an image name carries its instance id. Which image a task uses comes from the held-out store. Each is the digest of the manifest the registry serves for an image's `latest` tag: the image index's digest when the image has one, which is what `docker pull` records in `RepoDigests` (**inferred**). `bench images` (step 9) takes a task's digest only when it is one of these.
- `selection`: how tasks are chosen, never which: `rule`, `seed` and `rows_sha256` (step 8), or null.

The whole file is refused for:
- an unknown key;
- anything shaped like an instance id or an instance image name;
- any text but its canonical form (`JSON.stringify(pins, null, 2)` and a newline), so a repeated key can't hide an unchecked copy;
- a `base` that isn't written exactly as the url it is, or whose path has a segment that isn't a plain name (no percent escape).

To pin the dataset, the owner records the commit and the file's sha256 (a reviewed change to `pins.json`). Then, as the bench user:

    bench download

What it does, in order:
- refuses unless it runs as the bench user with its own home, and unless the held-out store passes the preflight's check (absent, or a real 0700 folder of this user with no link from the bench root down). It never chmods or replaces a store that fails: the owner fixes it;
- keeps a file already at its name (`dataset/<sha256>-<name>` in the store) when it matches, fetching nothing. It refuses one that doesn't match, or a link there, and leaves it for the owner to look at;
- fetches the bytes into memory over https, from the pinned host, through at most five redirects (each to a pinned host or its subdomain, with no credentials and no port), up to `max_bytes`. Their sha256 must equal the pin. Until then it makes and writes nothing, not even the store;
- makes the store and its `dataset/` folder (0700, one folder at a time, never through a link), then writes a new temporary file there. That file is created exclusively, refuses a link and is 0600. It is synced and read back, and renamed to its name only when the read-back matches the pin.

**Collecting the image digests is not built yet (an open gap).** No command lists the `latest` manifest digests of SWE-bench Verified's images. Without them, `image_digests` stays empty and step 9 refuses. Collecting them by hand would mean typing image names, which carry instance ids, into a shell. On the bench user's account that is ruled out above, since its shell history is readable by the agents. Whether to add a `bench digests` command (the registry lookups `bench images` makes, for every row of the pinned dataset, printing only the sorted set) or to collect them some other way is a decision still to make.

Images (`download.ts` `pullImage`, called by `bench pull`, step 10): only `docker pull <name>@sha256:<digest>` and `docker image inspect` (to read the digest back) are sent. The argv is built only from a reference `pins.ts` checked: a pinned digest, no tag, no port, no option. The argv is checked again before docker runs. No command takes an image name on the command line, since the bench user's shell history is readable by the agents (**inferred**: the sandbox's read-deny list doesn't name it). Task selection hands each task's reference over from the store.

### 8. The rows and the task selection (on the bench machine only)

**Why a rows file.** The selection reads JSON lines, one task per line, with no new dependency. The file pinned in step 7 is most likely parquet (**guess**: the `path` in `pins.json` is). Nothing in this repo reads parquet. So there are two ways to give the bench its rows, and both keep every byte pinned:
- **Preferred, if one exists:** an upstream JSON-lines copy of the dataset at a pinned revision. Pin it in step 7 (its `path` ends in `.jsonl`), and `bench select` reads that verified file itself, with no conversion. Whether such a copy exists is a **guess**: none is known here.
- **Otherwise:** convert the downloaded parquet file once, on the bench machine, into `rows.jsonl` beside it, with a tool of your choice (it is not a repo dependency). For example, as the bench user, if Python and pyarrow are installed (**not run here**: nothing may be downloaded):

      cd ~/bench/state/evals/held-out/swebench/dataset &&
        umask 077 &&
        python3 -I -c 'import json, sys, pyarrow.parquet as pq; [print(json.dumps(r)) for r in pq.read_table(sys.argv[1]).to_pylist()]' PASTE_THE_PINNED_FILE_NAME > rows.jsonl.new &&
        chmod 600 rows.jsonl.new && mv rows.jsonl.new rows.jsonl

**The rows are pinned by their canonical digest** (`select.ts` `canonicalRows`), in `pins.json` `selection.rows_sha256`. The digest is taken over each row's known fields only (`instance_id`, `repo`, `base_commit`, `problem_statement`, `patch`, `test_patch`, `FAIL_TO_PASS`, `PASS_TO_PASS`, `hints_text`, `difficulty`, and `version` and `environment_setup_commit` when present), in that order, with the test lists as compact JSON, the rows sorted by instance id. So a converter's spelling, key order or extra columns change nothing, and a conversion on another machine must give the same rows or the selection refuses. The run gets those canonical rows only: a field outside the digest never reaches it.

A row without one of the required fields, a field of the wrong type, an instance id twice, text that isn't UTF-8 or a file with no rows refuses the whole file. The rows file must be a 0600 regular file of the bench user, never a link.

**The rule** (`selection.rule`, `sha256-rank-v1`): each row's rank is the sha256 of `<seed>:<instance id>` as hex, ascending. The first 50, in rank order, are `t01` to `t50`. The smoke round runs `t01` to `t04`, and the baseline runs all 50. A row's rank depends only on its own id and the seed, so the file's order, and any row ranked after the 50th, change nothing chosen. A rule never changes; a new one gets a new name. The seed is `selection.seed`, 20261018 in `pins.json`.

**Was the seed picked for the tasks it chooses?** Not that anyone can prove (**inferred**). The rule reads only the instance ids and the seed, and SWE-bench Verified's ids are public. So anyone holding them could try seeds offline and commit one that chooses tasks they like. Each nearby seed chooses a different smoke set (measured in review: seed + 1, + 2 and + 3).
- The evidence against it: the seed is the date the owner approved the bench, and the commit that records it comes before any rows digest is pinned (the digest is still null).
- The residual: that is evidence, not proof. A test pins the exact seed and rule (`test/bench-select.test.ts`), so any change to either changes a test, and the owner reviews it.

**Pinning the rows.** Run, as the bench user:

    bench select

While `rows_sha256` is null it refuses and prints the rows' canonical digest. Check that `rows.jsonl` came from the pinned file, then record the digest in `pins.json` (a reviewed change), and run `bench select` again. It:
- refuses unless the dataset, the selection and the rows are pinned, the store passes the preflight's held-out check, and the pinned dataset file is there and verified;
- writes `manifest.json` into the store (0600, through a verified temporary file): each key with its instance id, and the dataset revision, rule, seed and rows digest it came from. Run again with the same pins, it keeps the same manifest. It never replaces a different one, since grading maps each run's keys through it: move the old one aside to select again;
- checks the smoke's image references (below), and prints the smoke run's plan.

It prints keys, counts and digests only. As a backstop, every line the `bench` command prints first has any word shaped like an instance id or an instance image name withheld, whoever writes it. That happens before anything splits or cuts the word, and the word is judged in all of these spellings:
- decoded until it is stable: percent, `\u`, `\x`, numeric entities, and the named entities for `_`, `-` and the like. A word still decoding after 16 rounds is withheld;
- NFKC-normalised, and with combining marks removed;
- with each non-ASCII character read as a possible look-alike, by its own role: a dash as `-`, other punctuation, a symbol or a modifier letter as `_`, a digit as `0`, another letter as `a`;
- **read loosely**, which closes non-ASCII look-alikes by construction rather than by a list. In some loose reading, every non-ASCII character of any kind may stand in any `_` place, any `-` place, any letter of the repo's name, or before the digits:
  - letters, punctuation, symbols, format and invisible characters, private-use and unassigned ones, always;
  - a combining mark, or a character carrying marks (`̲`, `l̲`);
  - a non-ASCII digit.

  A non-ASCII digit may also stand for any digit.

A word over 512 characters is withheld without being judged, so the check stays linear and fails closed.

Not defended by it (**inferred**; the messages being built from keys is what covers these):
- an id split across a real space, or across two lines;
- an id in base64 or another encoding not listed above;
- ASCII stand-ins (`~` for `-`, `O` or `l` for a digit);
- an id whose digits are all replaced by letters;
- digits used as the separators in a word whose own digits are non-ASCII too (`example٠٠proj٠٤٢٤٢`), or fullwidth zeros as the separators (`example００proj−４２４２`: after NFKC, an ASCII stand-in). These aren't look-alikes of `_` or `-`. Catching them would withhold Arabic-Indic dates such as `٢٠٢٦-١٠`, which are kept.

It errs closed (measured), withholding:
- a word with two non-ASCII characters in a row that later reaches a `-` and a digit (`éé-1`, `東京都-1`);
- three non-ASCII characters before a digit;
- decomposed (NFD) text with two marks on one letter, or with marks next to `_` before `-N` (`Việt-1`, `Nguyễn-3`, a decomposed `ä_ö-1`). The composed (NFC) forms are kept. The messages being built from keys is what covers those.

**Image references** live in the store, in `images.json`: `{"<instance id>": "<name>@sha256:<digest>", ...}`, a 0600 file of the bench user.
- **`bench images` writes it** (step 9). Until then, `bench select` reports the images line as FAIL.
- **Never write it by hand in a shell:** no instance id or image name typed into a command, an editor's command line, or a `docker` command. The bench user's shell history is readable by the agents (**inferred**).

A task's reference is taken only when:
- it is `<name>@sha256:<digest>` with no tag, port or option;
- its digest is one of `pins.json` `image_digests`;
- its name is the task's own: its last part is, or ends in `.`, the instance id in lower case with `__` written as `_1776_`. That is SWE-bench's image naming (**inferred**; a name that doesn't follow it is refused, failing closed);
- no other task of the run has its digest.

**What the run gets** (`select.ts` `loadTasks`, called in-process by `bench run`, still to come): it re-reads the rows and checks them against the pin, re-derives the selection, refuses a manifest that differs (an edit, or other pins since `bench select`), and takes each task's image reference as above. Its refusals name keys, never a task. No command takes an instance id, a seed, a count or an image name, so none is ever typed into the bench user's shell, whose history the agents may read (**inferred**: its sandbox's read-deny list doesn't name it).

### 9. The task images (on the bench machine only)

Once the owner has pinned the image digests (step 7) and `bench select` has written the manifest (step 8), run, as the bench user:

    bench images

It takes no argument. For each of the 50 selected tasks, in key order:
- **the task:** from the store's manifest, only when it is exactly what the pins select now (the rows re-read and checked against their pin, the selection re-derived, as the run does). A missing or different manifest is refused: run `bench select`;
- **the name:** the task's own, under SWE-bench's image naming: `swebench/sweb.eval.x86_64.` and the instance id in lower case, with `__` written as `_1776_` (**inferred** from SWE-bench's harness; a name that doesn't follow it fails at the registry). An id that isn't `<owner>__<repo>-<number>`, or that makes a name docker wouldn't take, is refused;
- **the digest:** the sha256 of the manifest Docker Hub's registry serves for that name's `latest` tag. It is taken only when it is one of `pins.json` `image_digests`, and no other task has it.
  - The registry is asked at fixed addresses (`auth.docker.io` for an anonymous pull token, `registry-1.docker.io` for the manifest), for manifests only: no image is pulled, no credential is sent, no redirect is followed, and every answer is capped (4 MiB).
  - The digest is the sha256 of the bytes served, never only the registry's header; a header that disagrees is refused.
  - So the registry says which image is the task's, and the pins say which images may be used at all. A tag moved to an image that isn't pinned is refused, never followed. `pullImage` reads the digest back for the name when it pulls.

Only when every task has its reference, and the store and the manifest pass their checks again, is the file written: 0600, through a verified temporary file linked to its name, never over anything. A different `images.json` already there, or a link there, is refused and left as it is: move it aside to write it again. Then it runs the run's own check (`loadTasks`, smoke and baseline).

It prints keys, counts and the file's sha256. A refusal names keys, and the digest the registry served when that digest isn't pinned, so the owner can check it. Never an instance id or an image name, and every line goes through the withholding backstop above. Then `bench select` passes every line.

### 10. The pulls and the base trees (on the bench machine only)

After `bench images`, run, as the bench user:

    bench pull --tasks smoke

`--tasks` is its one argument, and it is required: `smoke` (`t01` to `t04`) or `baseline` (all 50), the same choice `bench run` takes. There is no default, and anything else exits 2 before anything runs. Run `bench pull --tasks baseline` before the baseline run; it keeps the smoke's trees as they are.

What it does, in order, stopping at the first refusal:
- **The tasks:** from the store only, as the run takes them (`loadTasks`): the manifest checked against the pins, and each task's reference from `images.json`, a pinned digest under the task's own name. A missing or odd `images.json` refuses before any docker command.
- **The daemon:** this user's Docker daemon must be rootless (as the preflight checks).
- **The pulls:** each image goes through `pullImage`: `docker pull <name>@sha256:<digest>`, never a tag. Its digest is read back from the daemon (`RepoDigests`) and must be the one `images.json` and `pins.json` give. Then `images.json` is read again, and if it changed during the pulls nothing more happens.
- **The base trees**, one task at a time. The source comes from the task's own image, never from upstream: no fetch, no network, no GitHub.
  - A throwaway container is started from the image, with the run's own limits, `--network none` and no mount. The limits are read back before anything runs in it. The commands only read `/testbed`; whatever the container does goes when it is removed.
  - **With git metadata in `/testbed`:** its HEAD must be the task's `base_commit`, or the task is refused. Then base_commit's own commit object (none of its parents) and exactly its tree's objects are packed out. On the host the commit must hash to `base_commit` and name that tree, so the tree is base_commit's by its hash, not by the container's word. The tree hash is recorded.
  - **With no git metadata in `/testbed`:** refused, and nothing is copied out. Nothing would bind its files to `base_commit`, and an image would take that path just by having no `/testbed/.git`. SWE-bench's own images keep `/testbed` as a git checkout, since its harness runs git there (**inferred**). A fallback that records a content hash would be a loosening, for the owner to decide.
  - **Bounded:** what comes out of the container is capped in bytes as it arrives. That is 64 KiB for the probe, and 384 MiB of base64 (a 288 MiB pack) for the tree. Past a cap the copy is ended and refused, and the container is removed.
  - **The pack is walked before `index-pack` sees it, against one budget of 1 GiB.** Each entry is charged a fixed 1 KiB, the bytes its data inflates to (a delta's own data counts, not only its target), and, for a delta, its target size (from its delta header). The charge is made before the data is inflated, so the walk never inflates past the budget. Any one object, or one delta's data, is capped at 256 MiB. The trailer must be the pack's checksum, and a delta's base must start inside the pack. What git read is checked against 1 GiB again before anything is fetched or checked out.
  - **Why before `index-pack`:** it builds each object in memory, and a delta of a few bytes can declare gigabytes. A 1,115-byte pack made it peak at 1.58 GB in review (measured). Such a pack is now refused before git runs (measured, test).
  - **Why every byte and entry counts:** uncounted delta data let a 300 MB pack take the walk 302.6 s (measured in review), and 18 million tiny blobs in a 288 MB pack took it 49.7 s and `index-pack --threads=1` 1.41 GB (measured). Each is now refused in under 0.5 s (measured).
  - **One thread:** host git runs with `pack.threads=1`, and `index-pack` with `--threads=1`. Each thread holds its own objects, so with git's default threads an admitted 12.5 MB pack peaked `index-pack` at 0.86 to 1.96 GB on 16 CPUs, and at 3.27 GB with 16 threads (measured in review). That pack is now refused by the budget.
  - **What a pack under the budget can still cost the host** (measured with crafted packs, git 2.43.0, 16 CPUs): `index-pack --threads=1` peaked at 756 MiB for a 250 MiB delta made only of inserts on a 250 MiB base (the walk charged 752 MiB), and at 505 MiB for a chain of four 250 MiB deltas. Its peak stayed near what the walk charged, so at most about the 1 GiB budget (**inferred** for other shapes). The walk itself reads at most a million entries and inflates at most 1 GiB. Its longest measured runs: 3.5 to 4.6 s for a chain of 900,000 tiny deltas, a 14.4 MB pack (measured in review), and 2.63 s for a million tiny objects (measured). A bound in seconds for every shape is **inferred**, not measured. `index-pack`'s memory follows the budget, but not its time: a 51 KB pack of 19 chained 50 MiB deltas made `index-pack --threads=1` rebuild bases for 18.6 s at 106 MB (measured in review). Its time is bounded by the 30-minute git timeout.
  - **`bench pull`'s own memory:** it holds a copy-out as buffers, a string and the decoded pack at once. Just under the 384 MiB cap it peaked at 1,509 to 1,894 MiB over 6 runs, the same whether the walk took the pack or refused it at once (measured). Over the cap it stops at about the cap.
  - **The caps are guesses:** all three are **guesses** at what SWE-bench Verified's largest base tree needs, with room. A tree over any of them is refused, naming the cap; raising one is a reviewed change (`pull.ts` `TREE_CAPS`).
  - Submodules: a gitlink in the tree becomes an empty folder in the clone. Its contents are never fetched.
  - On the host: one root commit on that tree (fixed author and date), in a fresh bare remote that holds exactly that commit's objects (no upstream history, checked), and a clone of it, with that bare remote as its `origin`. A record, `tree.json` (0600), keeps the key, the instance id, `base_commit`, the image digest, the source, the tree and the commit. It is all built in a temporary folder, and renamed to `trees/<key>/` in the store only when done, never over anything.
  - **Run again:** a task's tree already there is kept when it is the same task from the same image, and its bare remote and clone still check out. Anything else there (another task's or another image's tree, an unfinished one, a link) is refused and left as it is: move it aside to build it again.
- **Where the trees live:** `state/evals/held-out/swebench/trees/<key>/` (`remote.git`, `clone`, `tree.json`), inside the held-out store. The agents' sandbox denies the store, so no agent ever sees the task set. `bench run` (still to come) copies one task's tree into that task's own folder when the task starts.

It prints keys and counts only: never an instance id, an image name, a digest beside its key or a tree hash. docker's own error text names the image, so a failure says only its stage and exit status. Every line goes through the withholding backstop.

**The daemon's log names images (a guess).** `bench pull` is the first command that hands task image names to the bench user's dockerd. Whether dockerd logs a pulled reference, or only a failed pull's error, is a **guess**: no stand-in can measure what a real dockerd writes. Its log goes to the system journal, which the agents' sandbox now denies (`/var/log/journal`, `/run/log/journal`). To see why a pull failed, read that log on screen only, never save or copy journal output into a file, an issue, a chat or anywhere under the bench user's home or the bench root: it may name the task. As the bench user: `journalctl --user -u docker -n 50 --no-pager` (**inferred**, not run here).

**Not known until the first real pull (inferred, not measured here):**
- that every SWE-bench image's `/testbed` is a git checkout at `base_commit`, with `git`, `sh`, `printf` and `base64` in the image. A missing tool, or no `.git`, fails closed, as a refusal;
- whether the caps above fit every selected task's tree;
- how long the pulls take (each image is several GB) and how much space the trees take.

## The smoke run plan

The 4-task smoke on current main, in this order. Each step needs the one before it:
1. **Setup and preflight** (steps 1 to 6): `bench preflight` passes as the bench user. Done by the owner on 2026-10-18; confirm with the preflight.
2. **Pins and download** (step 7): the owner records the dataset's revision and sha256 and the image digests; `bench download`.
3. **Rows and selection** (step 8): the rows file and its digest recorded, then `bench select` writes the manifest. It prints the plan: `t01` to `t04`, at most $40 for the round, $15 per task. Its images line stays FAIL until step 4 writes `images.json`.
4. **Task setup** (slice 4, built; it needs the image digests pinned, which has no command yet: see step 7):
   - `bench images` (step 9) writes `images.json` from the store, never typed;
   - then `bench select` passes every line;
   - then `bench pull --tasks smoke` (step 10) pulls the four images by digest, reading each back, and puts each task's base tree in the store: a bare remote with one commit and a clone of it. `pullImage` reads the digest back for the pinned name, so an image whose digest isn't the one its own repository serves fails there (**inferred**). `loadTasks` checks only that an image's name is its task's own, and that its digest is pinned; `bench images` took each digest from the registry for that name.
5. **The engine's runner seam and the test relay** (still to come; #701, Lane C and Lane A): the engine's check and test commands run through the bench's `TaskRunner`.
6. **`bench run --tasks smoke --spend <usd>`** (still to come): with `--spend` at most 40. Its first model call is the sandbox confirmation. It stops cleanly at any usage limit, with no retry.
7. **Grading** of the exported patches in fresh containers, then the aggregate. If the round averaged over $8 per task, the baseline needs the owner's re-approval.

## The owner's steps, in order (from a new machine to the smoke run)

Each block below is copied from the setup step it names, and a test (`test/bench-pull.test.ts`) holds each one equal to that step's commands, so the two can't drift apart. Each step says how sure it is: **done** (the owner did it, with the date), **measured** (a test runs it, with stand-ins), **inferred** (nobody has run it here).

The bench reads its pins from the bench user's own clone (`scripts/bench/pins.json` in `~/src/bench-engine`). So after each reviewed change to `pins.json` merges, redo step E at that merge commit before the next `bench` command.

**A. Docker Engine, as an admin account with sudo (setup step 1).** Done by the owner on 2026-10-18 (the smoke run plan, step 1). Skip it when `bench preflight` (F) passes. Otherwise (**inferred**: it needs sudo, so it is not run here):

    sudo apt-get update
    sudo apt-get install -y ca-certificates curl uidmap slirp4netns
    sudo install -m 0755 -d /etc/apt/keyrings
    sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    sudo chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list
    sudo apt-get update
    apt-cache madison docker-ce | head -3          # pick VERSION
    sudo apt-get install -y docker-ce=VERSION docker-ce-cli=VERSION containerd.io docker-ce-rootless-extras=VERSION
    sudo apt-mark hold docker-ce docker-ce-cli docker-ce-rootless-extras containerd.io
    sudo systemctl disable --now docker.service docker.socket
    sudo rm -f /var/run/docker.sock

**B. The bench user, its subordinate ids, linger and cgroup delegation, as the admin account (setup step 2).** Done on 2026-10-18. Otherwise (**inferred**). Replace `<start>-<end>` only if the `grep` shows no line:

    sudo apt-get install -y bubblewrap socat         # the sandbox's own dependencies (Claude Code's and srt's)
    sudo useradd -m -s /bin/bash wl-bench
    grep wl-bench /etc/subuid /etc/subgid          # one line in each; if missing:
    sudo usermod --add-subuids <start>-<end> --add-subgids <start>-<end> wl-bench
    sudo loginctl enable-linger wl-bench           # its user manager: /run/user/<uid> and a user bus
    sudo mkdir -p /etc/systemd/system/user@.service.d
    printf '[Service]\nDelegate=cpu cpuset io memory pids\n' | sudo tee /etc/systemd/system/user@.service.d/delegate.conf
    sudo systemctl daemon-reload
    sudo systemctl restart user@$(id -u wl-bench).service
    cat /sys/fs/cgroup/user.slice/user-$(id -u wl-bench).slice/user@$(id -u wl-bench).service/cgroup.controllers
                                                   # expect: cpuset cpu io memory pids
    chmod 750 "$HOME"                              # as the admin account, on its own home
    sudo -u wl-bench ls "$HOME"                    # expect: Permission denied

**C. As the bench user: its profile, rootless Docker, Claude Code at the pin, and the sign-in (setup step 3).** Done on 2026-10-18. Otherwise (**inferred**). Everything after the first line runs in the bench user's shell:

    sudo -iu wl-bench
    echo 'export XDG_RUNTIME_DIR=/run/user/$(id -u)' >> ~/.profile
    echo 'export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus' >> ~/.profile
    echo 'export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock' >> ~/.profile
    echo 'export DISABLE_UPDATES=1' >> ~/.profile
    . ~/.profile
    # rootless Docker
    dockerd-rootless-setuptool.sh install
    systemctl --user enable --now docker
    docker info | grep -E 'Context|rootless|Cgroup'   # expect rootless, cgroup v2, the systemd driver, no limit warnings
    # Claude Code at the pin. The installer works only with DISABLE_UPDATES unset:
    curl -fsSL https://claude.ai/install.sh | env -u DISABLE_UPDATES bash -s 2.1.303
    ~/.local/bin/claude --version                  # expect 2.1.303 (Claude Code)
    # sign in with the owner's account, through Anthropic's own flow, in this terminal
    ~/.local/bin/claude                            # then /login, then /exit
    ~/.local/bin/claude auth status                # expect a claude.ai sign-in

**D. sandbox-runtime for the srt probe, as the bench user (setup step 4).** Done on 2026-10-18. The checksum gate is **measured** (a test runs this block with stand-ins); the real install is **inferred**:

    mkdir -p ~/src/srt-0.0.79 && cd ~/src/srt-0.0.79 &&
      npm pack @anthropic-ai/sandbox-runtime@0.0.79 &&
      test "sha512-$(openssl dgst -sha512 -binary anthropic-ai-sandbox-runtime-0.0.79.tgz | base64 -w0)" = "sha512-WjBmS9fbTpnQwQkM9SU+JjhM2CcXo9eWEELktY1100RMvTy/jPhP44yZ3NXhh+GHB350OgPbM3+FubE5WVRtSA==" &&
      echo "checksum OK" &&
      npm install -g --ignore-scripts --prefix ~/.local ./anthropic-ai-sandbox-runtime-0.0.79.tgz
    ~/.local/bin/srt --version                     # expect 0.0.79 (no such file: the checksum didn't match, nothing was installed)
    cd ~

**E. The bench's own clone at the pinned commit, as the bench user (setup step 5).** Redo it now: a clone from 2026-10-18 predates `bench select`, `bench images` and `bench pull`. Pin a commit on `main` that has `bench pull`, and redo this step after each change to `pins.json` merges. First move the old clone aside, under a new name each time: `mv ~/src/bench-engine ~/src/bench-engine.$(date +%Y%m%d-%H%M%S)`. Then replace the two PASTE_ values and run (**inferred**; the block's syntax is **measured**):

    BENCH_REPO=PASTE_THE_HTTPS_CLONE_URL
    BENCH_SHA=PASTE_THE_40_HEX_PINNED_COMMIT
    git clone "$BENCH_REPO" ~/src/bench-engine &&
      git -C ~/src/bench-engine checkout --detach "$BENCH_SHA" &&
      test "$(git -C ~/src/bench-engine rev-parse HEAD)" = "$BENCH_SHA" &&
      (cd ~/src/bench-engine && npm ci --ignore-scripts && npm run build) &&
      mkdir -p ~/.local/bin &&
      printf '#!/bin/sh\nexec node %s/src/bench-engine/dist/scripts/bench/cli.js "$@"\n' "$HOME" > ~/.local/bin/bench &&
      chmod 755 ~/.local/bin/bench &&
      echo "bench installed at $BENCH_SHA"

**F. The preflight (setup step 6).** From the admin account. Every line must be PASS. Its checks are **measured** with stand-ins; on the machine they are **inferred**:

    sudo -iu wl-bench
    bench preflight

**G. The dataset pin and the download (setup step 7).** The dataset's Hugging Face page gives the commit to pin (40 hex) and the parquet file's SHA256 (**inferred**: check that it is the file `path` names). Record both in `pins.json` (`dataset.revision`, `dataset.sha256`) as a reviewed change. Once that merges, redo E at that commit. Then, as the bench user (**measured** with a stand-in fetch; the real download is **inferred**):

    bench download

**H. The rows and the selection (setup step 8).** As the bench user:
- Convert the parquet file into `rows.jsonl`. This needs Python and pyarrow on the bench machine, and is **not run here**. Replace PASTE_THE_PINNED_FILE_NAME with the file name `bench download` printed.
- Run `bench select`. It refuses and prints the rows' canonical sha256. Record that as `selection.rows_sha256` in `pins.json` (a reviewed change).
- Once that merges, redo E, then run `bench select` again. It writes the manifest. Its images line stays FAIL until J.

The selection is **measured** with fixture rows:

      cd ~/bench/state/evals/held-out/swebench/dataset &&
        umask 077 &&
        python3 -I -c 'import json, sys, pyarrow.parquet as pq; [print(json.dumps(r)) for r in pq.read_table(sys.argv[1]).to_pylist()]' PASTE_THE_PINNED_FILE_NAME > rows.jsonl.new &&
        chmod 600 rows.jsonl.new && mv rows.jsonl.new rows.jsonl
    bench select

**I. The image digests: blocked.** `image_digests` needs at least 100 pinned digests, including every selected task's. No command collects them yet (step 7, "Collecting the image digests is not built yet"). That needs a decision before J can run.

**J. The task images (setup step 9).** Once the digests are pinned and merged, redo E. Then, as the bench user (**measured** with a stand-in registry; the real lookups are **inferred**), run the command below. After it, `bench select` passes every line:

    bench images

**K. The pulls and the base trees (setup step 10).** As the bench user. This is **measured** with a stand-in docker, and the in-container scripts are **measured** with `sh` on a stand-in `/testbed`. The real pulls and copies are **inferred**:

    bench pull --tasks smoke

**L. The smoke run: not built yet.** It needs the engine's runner seam and the test relay (#701), then `bench run --tasks smoke --spend <usd>`, with `--spend` at most 40 (the smoke run plan, steps 5 and 6).

## Data and results

Everything lives under `$HOME/bench`, outside every repository and engine state dir. The driver refuses a root inside a git checkout, a credential store or real engine state. Results are private.

- `state/evals/held-out/swebench/`: the dataset copy (`dataset/<sha256>-<name>`, 0600, step 7), the rows (`dataset/rows.jsonl`, step 8), the manifest (`manifest.json`), the image references (`images.json`), each task's base tree (`trees/<key>/`: `remote.git`, `clone` and `tree.json`, step 10), the predictions and grades (0700).
- `runs/<run>/<key>/`: each task's clone, local remote and engine state.
- `runs/<run>/patches/<key>/<label>.diff`: the exported patches (`final`, `attempt-N`, `b0`, `b1`, `bare`).
- `runs/<run>/sandbox.json`: the two sandbox checks, per attempt, and the confirmation's usage.
- `runs/<run>/results.json`: per task, the decision, usage-equivalent dollars, runs by role and model, tokens, the limits read back, and wall time. It also records the CLI version, the plan and the sandbox checks.
- `runs/<run>/aggregate.json`: counts and rates only, never an instance id. It says whether the run is complete, and carries the sandbox checks' results.
