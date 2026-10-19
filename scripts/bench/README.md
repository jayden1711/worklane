# Gated-merge benchmark on SWE-bench Verified (#748)

This runs the engine's full loop on SWE-bench Verified tasks, in local clones only: worker, evaluator with a fail-without repro, tests, a merge decision in PR mode. It then grades every exported patch with SWE-bench's hidden tests, after the run, in fresh containers. It reports:
- merge precision;
- false holds;
- caught bad fixes;
- the B0 (agent alone), B1 (agent + CI only) and plain `claude -p` baselines.

Every rate comes with a Wilson 95% interval. It is a gated-merge benchmark built on SWE-bench Verified, not a SWE-bench score.

**Status: Phase 0, nothing has run.** No model call, image pull or download has been made from this code.

What is here so far:
- **Preflight** (`paths.ts`, `auth.ts`, `caps.ts`, `usage.ts`): the bench user, login and CLI pin checks, the caps, and the usage meter with its clean stop.
- **Containers** (`container.ts`, `agent.ts`, `hidden.ts`, `probe.ts`): the rootless Docker launcher with required limits, the exec-only task runner, the hidden-field guards, the agents' environment and sandbox, and the srt sandbox probe.
- **Driver** (`driver.ts`, `confirm.ts`, `grade.ts`, `aggregate.ts`, `store.ts`): the run loop, the sandbox confirmation, patch export, the predictions for grading, and the aggregate. `srt-fingerprint.mjs` compares a sandbox-runtime release with the build a Claude Code binary bundles.

Still to come:
- the PR-mode task runner on the replay harness (`src/harness-evals/replay.ts`), with stub CI;
- the agent's test relay into the container;
- task selection;
- the pinned-download scripts;
- the grading run and the B0, B1 and `claude -p` baselines;
- the `bench` command.

## How it is isolated

- **One OS user runs everything:** the bench user (default `wl-bench`, `WORKLANE_BENCH_USER` names another). It has its own clone of this repo at the pinned commit, its own `claude`, its own rootless Docker, and data in `~/bench` (`WORKLANE_BENCH_ROOT` overrides it). There is no sudo and no switching users. The driver refuses to start as any other user.
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
  - The sandbox denies the agents' commands and Read tool: the login (`~/.claude`, `~/.claude.json`), the other credential stores, `$XDG_RUNTIME_DIR` (the Docker socket and the user bus), the system Docker sockets, a unix `DOCKER_HOST`'s socket, the rootless daemon's data root (`~/.local/share/docker`), and the bench's state and held-out store. The Read tool gets each path's exact rule as well as its folder rule, so a file such as `~/.claude.json` is matched itself.
  - The agent's environment has no `DOCKER_*`, `XDG_RUNTIME_DIR` or `DBUS_SESSION_BUS_ADDRESS`. An agent that could reach the daemon could mount the login into a container and send it out.
  - **Where an agent may write.** That deny list covers reads only.
    - Its Bash commands write only where the sandbox lets them: the run's working folder and the temp folder, plus the paths of its Edit allow rules (Claude Code's sandboxing docs, **inferred**). The bench's only Edit allow rule is the run's working folder, so it adds nothing.
    - Its Edit, Write, MultiEdit and NotebookEdit tools run outside the sandbox, as the bench user. Pre-approved without a scope, they could change unprotected files the bench user owns, such as `~/.docker/config.json` (a `credsStore` helper that the driver's own `docker` would run), `~/.config/systemd/user/` or `~/.local/bin/`. `dontAsk` mode already denies writes to protected paths such as `~/.profile`, `~/.bashrc`, `~/.claude/` and `.git/`, even with an allow rule (Claude Code's permission-modes docs, **inferred**).
    - So they are confined to the run's own working folder, which must be inside the task's folder (`runs/<run>/<key>/`). Every agent run goes through the task's meter. It refuses, unstarted, a run whose working folder is outside the task's folder, scopes a bare `Edit`, `Write`, `MultiEdit` or `NotebookEdit` to `Edit(//<working folder>/**)`, and refuses a run that grants any of them anywhere else. Not the whole task folder: an Edit allow rule would also let sandboxed Bash write there, and the sandbox protects `.claude/` and `.git/` hooks and config only in and above the working folder (**inferred** from the sandboxing docs).
    - A path that goes into a rule (the task's folder, the working folder) must have no glob or rule character (`* ? [ ] { } ! ( ) \`, a comma or whitespace) and no trailing slash. Such a path is refused, not escaped. A bench root with a space in it is therefore refused.
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
   - **The version:** `srt --version` must be exactly `0.0.79` (step 3 installs it), or the run is refused.
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
     - **refused** only when the exact listed command ran and its tool result is an error (`is_error`, which Claude Code sets on a non-zero exit);
     - **reached** when any command naming the target exited 0, or a sentinel's content or a `_ping` `OK` came back. Any reached attempt, or any sentinel's content anywhere in the transcript, refuses the run;
     - anything else counts as not run.
   - **Which layer stopped each attempt** (`layer`), from the transcript's own markers only, failing closed:
     - **permission layer:** the result line's `permission_denials` lists the call, or its error result says "Permission to use … has been denied" (or the don't-ask-mode variant). Both markers are **inferred** from public docs and Claude Code's known wording, not verified against 2.1.303; the smoke's first call measures them;
     - **OS sandbox:** only the exact listed read of a sentinel that ran and failed on a masked or unreadable file (READ_JS's mask, `EACCES`, `EPERM` or `ENOENT`; for `cat`, "Permission denied", "Operation not permitted" or "No such file or directory");
     - **unknown:** the exact command failed with neither marker. This is every socket attempt that the permission layer didn't refuse, since curl failing to connect can't tell a sandbox from a missing socket. It is never counted as the OS sandbox;
     - **model declined:** the exact command never ran.
   - **The status:**
     - **"all refused"** only when every attempt was refused and the model ran nothing but the listed commands;
     - **"sandbox confirmation: model declined"** when the model ran any other command or tool, or skipped a listed one. The run goes on only because the srt probe passed, and the summary says so in a warning;
     - when every attempt was refused but the OS sandbox didn't refuse every `node -e` read itself (`os_sandbox_read_deny` false), the summary warns that the sandbox's own read-deny rests on the srt probe.
3. **Keeping the probe current.** On each new sandbox-runtime release, run `node scripts/bench/srt-fingerprint.mjs <unpacked package> ~/.local/share/claude/versions/<pin>`. When a release shows no difference, switch `SRT_VERSION` (`probe.ts`) and step 3's install to it, as a reviewed change.

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

    # the bench's own clone, at the pinned commit
    git clone <this repository> ~/src/bench-engine && git -C ~/src/bench-engine checkout <pinned sha>

    # sandbox-runtime for the srt probe: this exact version, for this user only (no repo dependency)
    npm install -g --prefix ~/.local @anthropic-ai/sandbox-runtime@0.0.79
    ~/.local/bin/srt --version                     # expect 0.0.79

## Data and results

Everything lives under `$HOME/bench`, outside every repository and engine state dir. The driver refuses a root inside a git checkout, a credential store or real engine state. Results are private.

- `state/evals/held-out/swebench/`: the dataset copy, the manifest, the predictions and grades (0700).
- `runs/<run>/<key>/`: each task's clone, local remote and engine state.
- `runs/<run>/patches/<key>/<label>.diff`: the exported patches (`final`, `attempt-N`, `b0`, `b1`, `bare`).
- `runs/<run>/sandbox.json`: the two sandbox checks, per attempt, and the confirmation's usage.
- `runs/<run>/results.json`: per task, the decision, usage-equivalent dollars, runs by role and model, tokens, the limits read back, and wall time. It also records the CLI version, the plan and the sandbox checks.
- `runs/<run>/aggregate.json`: counts and rates only, never an instance id. It says whether the run is complete, and carries the sandbox checks' results.
