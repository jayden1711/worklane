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
- **Containers** (`container.ts`, `agent.ts`, `hidden.ts`): the rootless Docker launcher with required limits, the exec-only task runner, the hidden-field guards, and the agents' environment and sandbox.
- **Driver** (`driver.ts`, `grade.ts`, `aggregate.ts`, `store.ts`): the run loop, patch export, the predictions for grading, and the aggregate.

Still to come:
- the PR-mode task runner on the replay harness (`src/harness-evals/replay.ts`), with stub CI;
- the agent's test relay into the container;
- task selection;
- the pinned-download scripts;
- the grading run and the B0, B1 and `claude -p` baselines;
- the `bench` command.

## How it is isolated

- **One OS user runs everything:** the bench user (default `wl-bench`, `WORKLANE_BENCH_USER` names another). It has its own clone of this repo at the pinned commit, its own `claude`, its own rootless Docker, and data in `$HOME/bench` (`WORKLANE_BENCH_ROOT` overrides it). There is no sudo and no switching users. The driver refuses to start as any other user.
- **No API key.** `claude` is the unmodified CLI, signed in once by the owner through Anthropic's own `/login`.
  - Before any run, the driver asks `claude auth status --json`. It starts only on `authMethod` `claude.ai` or `oauth_token`, whatever the plan (enterprise, team, personal), and records the plan.
  - It refuses an API key, an API key helper, Bedrock, Vertex, Foundry, a signed-out status and an unreadable one.
  - It never reads, copies, mounts or relays the login.
- **Pinned CLI.** Before the run, `claude --version` must equal the pin: `2.1.303` by default, or `WORKLANE_BENCH_CLAUDE_VERSION` once the owner approves another. Every `claude` the bench starts gets `DISABLE_UPDATES=1`. The version is recorded with the results.
- **Agents run on the host, in the engine's sandbox, with no network for their commands.**
  - Model traffic comes only from the host `claude` process.
  - The sandbox denies the agents' commands and Read tool: the login (`~/.claude`, `~/.claude.json`), the other credential stores, `$XDG_RUNTIME_DIR` (the Docker socket and the user bus), the system Docker sockets, and the bench's state and held-out store.
  - The agent's environment has no `DOCKER_*`, `XDG_RUNTIME_DIR` or `DBUS_SESSION_BUS_ADDRESS`. An agent that could reach the daemon could mount the login into a container and send it out.
- **The repo's environment and tests run in one throwaway container per task**, from the task's SWE-bench image, in rootless Docker.
  - Each container has `--network none`, `--cap-drop ALL` and `no-new-privileges`, and mounts nothing.
  - The worktree reaches the container as a tar stream on `docker exec -i`.
  - Task commands go through a runner that sends only `docker exec <that task's container> argv`, with a work dir and plain variables. Any other verb, any mount or privilege flag, and any credential or daemon variable are refused.
- **Limits are required.** Every container gets `--memory` with an equal `--memory-swap`, `--cpus` and `--pids-limit`.
  - Defaults: 8g, 4 CPUs, 4096 pids. Override them with `WORKLANE_BENCH_MEMORY`, `WORKLANE_BENCH_CPUS` and `WORKLANE_BENCH_PIDS`. A zero, a missing value, more CPUs than the host has, or memory over 75% of the host's is refused.
  - Before the first task, a probe container is created with the limits. They are read back through `docker inspect` (Memory, MemorySwap, NanoCpus, PidsLimit), then from inside the container (`memory.max`, `cpu.max`, `pids.max`).
  - Each task's container is checked the same way before any agent or command runs.
  - A limit that didn't apply refuses the run and names the controller. Fix it with the drop-in in step 2 below.
  - The driver also has its own wall-clock cap per task (3 h), always enforced.
- **Hidden tests stay hidden.**
  - The dataset, the manifest, the hidden fields (`patch`, `test_patch`, `FAIL_TO_PASS`, `PASS_TO_PASS`, `hints_text`, difficulty) and the predictions live in `$HOME/bench/state/evals/held-out/swebench/`, owner-only. That path is also on the engine's held-out deny glob.
  - A container and the agents get only the base commit, the problem statement and the test runner.
  - Every docker command is checked against the task's hidden fields and refused on a match.
- **Grading reads only the exported patches** (`runs/<run>/patches/<key>/<label>.diff`, plain files only). It runs the official harness in fresh containers after the run. Only the held-out store maps a task key (`t01`, ...) to its instance id.
- **Research-on-demand is off.** Every research cap is 0, and the driver checks it before starting.

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

## Data and results

Everything lives under `$HOME/bench`, outside every repository and engine state dir. The driver refuses a root inside a git checkout, a credential store or real engine state. Results are private.

- `state/evals/held-out/swebench/`: the dataset copy, the manifest, the predictions and grades (0700).
- `runs/<run>/<key>/`: each task's clone, local remote and engine state.
- `runs/<run>/patches/<key>/<label>.diff`: the exported patches (`final`, `attempt-N`, `b0`, `b1`, `bare`).
- `runs/<run>/results.json`: per task, the decision, usage-equivalent dollars, runs by role and model, tokens, the limits read back, and wall time. It also records the CLI version and the plan.
- `runs/<run>/aggregate.json`: counts and rates only, never an instance id. It says whether the run is complete.
