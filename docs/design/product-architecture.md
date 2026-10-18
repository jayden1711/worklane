# Product architecture: deployment modes, execution isolation and guard guarantees

Status: **proposal for the owner's review** (2026-10-18). Nothing here is built. It is item 0 (#699) of the product epic #709, and the gate before #702 (per-task isolation) and #703 (deployment). The epic's other items: #700 auth, #701 runner, #704 governance mode, #705 docs and proof, #706 first-time polish, #707 adversarial suite, #708 value report. Baseline: `origin/main` at `40b7b2bc`.

**Labels.** Every claim about today's code or the world carries one:
- **measured**: read in the code at the cited `file:line`, or the output of the cited command, on the baseline;
- **inferred**: reasoned from what was read, not run;
- **guess**: not checked; it needs a measurement before anything is built on it.

Text marked **Proposal** is a design choice for the owner, not a claim. "The engine" is the product; `<cli>` stands for its command name (`src/brand.ts`).

## 0. Positioning and the three modes

The engine is the deterministic merge authority for agent-written code, on the customer's own infrastructure. The merge decision is plain code reading policy from the default branch; a model's verdict is one input that can hold a merge and never make one.

Three deployment modes, built in this order:
1. **Cloud account**: Kubernetes in the customer's own AWS, GCP or Azure account, installed with a Helm chart.
2. **Servers**: the customer's own machines, either their Kubernetes (the same chart) or one VM (docker-compose, with a Terraform module for the cloud-VM case).
3. **Single machine**: today's install (`scripts/setup/*`).

**The single-machine install is a first-class, supported mode.** It is not deprecated or secondary: it keeps its own CI jobs, its own docs and every guard guarantee in §5. Cloud comes first in build order only, not in importance. One codebase serves all three, selected by configuration (§2.4).

## 1. How true "the merge decision is plain code" is today

**PR mode (the default, `land_mode: pr`, measured `src/instance.ts:137`): true, with one input from a model that can only hold.**
- The engine merges in one place, `mergeOurs`. It merges pinned to the head SHA, after `neverAutoMerge` (measured: `src/coordinator/merge-flow.ts:356-365`, `src/github.ts:211`, `src/merge-policy.ts:32-38`).
- The decision is `mergeDecision`, a pure function of `MergeInput`. `auto` is true only when the list of reasons is empty (measured: `src/merge-policy.ts:40-73`, `:219-252`).
- `review.yaml` is read from the default branch's ref through `git show`, not from the PR head or the working tree (measured: `src/coordinator.ts:549-571`, `src/config/live.ts:1-6`, `src/config/load.ts:69-88`).
- The evaluator's verdict is a necessary input, never a sufficient one. A missing verdict, a rejection, a doubted test, confidence below high, unread files or no design answer each add a hold reason, and a design flag is binding (measured: `src/merge-policy.ts:225-244`). A positive verdict removes none of the reasons code computes: the level and wait categories, size, the kill switches, a foreign push, CI fix runs (measured: same lines). `unread` comes from the run record, not from the model's claim, and confidence is recomputed in code (measured: `src/coordinator.ts:1648`, `:1699`, `:1707`).
- A verdict can raise the review level by one and never lower it (measured: `src/review.ts:192-196`).
- `mergeOrWait` adds the emergency stop, the mergeable state and the 3-failures limit after the decision (measured: `src/coordinator/merge-flow.ts:487-549`).
- No decision defaults on a timeout: `ask` only records the question and labels the issue (measured: `src/coordinator/base.ts:589-602`).

**Where a model or a lesser gate decides more than it should:**
1. **Direct land mode skips `mergeDecision`.** L0 to L2 changes go to `land.queued` with only the review level and the gates. The design flag, medium confidence and the size limits aren't checked; the only verdict floor is "rejected goes to L3" (measured: `src/coordinator.ts:1084-1100`). The level and gates are still code, but here the evaluator's approval is the only judgement between an L2 change and main (inferred). **Proposal:** cloud and servers modes refuse `land_mode: direct`; single machine keeps it as an explicit owner opt-in.
2. **Money paths are read from the coordinator's working tree**, not from the default branch (measured: `src/review.ts:138-140`, called from `src/coordinator/merge-flow.ts:439`; `src/config/live.ts:1-3` says that tree goes stale). This isn't a model deciding, but it isn't "policy from main" either. **Proposal:** read it with `loadConfigAt` like the rest (S).
3. **Intake triage** can turn a report into a reply or a drop instead of an issue on the model's call alone (measured: `src/intake/decide.ts:21-27`). That doesn't touch merges; labels and `ready` are decided in code (measured: `src/intake/decide.ts:146-148`).
4. **Human approvals have inconsistent gates.** A `/<cli> approve` comment from anyone in `owners.writers` answers any issue decision, `land` included (measured: `src/coordinator/decisions.ts:241-262`). The dashboard limits `land`, `plan` and `automation` to owners (measured: `src/dashboard-auth.ts:119-120`, `src/decide.ts:51`). `<cli> decide` checks no role at all (measured: `src/cli.ts:1049-1071`). That isn't a model deciding either, but a cloud mode with many users widens it (inferred). **Proposal:** one gate, `mayAnswerKind`, on every surface (S).
5. **The worker's retry after a rejection** is model output steering control flow, not a merge (measured: `src/coordinator.ts:1075-1079`).

## 2. Components and where each runs

### 2.1 Today (single machine)

| Component | Process and user today | State and network |
|---|---|---|
| Coordinator | `<cli> coordinator run --instance <name>` in the system unit `<cli>-<name>.service` as `wl-<name>` (measured: `scripts/setup/service.sh:34`, `:80-84`); `ProtectSystem=full`, `PrivateTmp`, no `NoNewPrivileges` because it uses sudo (measured: `:100-108`). | Instance home `~wl-<name>/.local/state/<cli>/instances/<name>/` (measured: `src/os/index.ts:351-356`, `src/instance.ts:235-236`). Outbound only: GitHub API, git, Anthropic, through root's optional proxy (measured: `src/service.ts:148-150`). It listens on nothing (inferred). |
| Evaluator | An agent run (read-only tools, JSON schema) started by the coordinator (measured: `src/coordinator.ts:1626-1727`), as `wl-<name>-agent` or `wl-<name>-eval` (measured: `src/runner.ts:514-521`). | Its verdict is the `eval.verdict` event (measured: `src/events/types.ts:364-395`). |
| Merge policy, main watch | Code inside the coordinator process (measured: `src/service.ts:249-252`, `:267`; `src/coordinator.ts:156`; `src/main-watch.ts:1-31`). | Main watch polls the default branch's first-parent commits; GitHub backlogs only (measured: `src/service.ts:250`). |
| Dashboard | A separate process per instance, `<cli>-dashboard-<name>.service`, as `wl-<name>`, loopback only (measured: `scripts/setup/dashboards.sh:209-224`, `src/dashboard.ts:216`, `:1033`). The hub `<cli>-dashboard-hub.service` runs as `wl-dash` on 4399 (sign-in) and 4398 (break-glass), loopback (measured: `src/dashboard-hub.ts:106-108`, `:307`). | HTTPS only through `tailscale serve`, tailnet only, Funnel refused (measured: `scripts/setup/dashboards.sh:66`). |
| Agent runs | `claude -p ... --setting-sources project --strict-mcp-config` (measured: `src/runner.ts:432`) through `sudo -n -u <agent> -- /usr/bin/env -i K=V...` (measured: `src/os/index.ts:593-602`). Environment is an allowlist (measured: `src/runner.ts:178-206`). | Worktrees under `/srv/<cli>/<name>` (measured: `src/os/system-paths.ts:133`). Egress through Claude Code's sandbox proxy only (measured: `src/sandbox.ts:28-46`; `scripts/setup/egress-firewall.sh:5-6` excludes agents). |
| Test runs | `wl-test-<name>` through the root helper `worklane-testrun`, each command a transient unit with `PrivateNetwork=yes` unless root grants it (measured: `scripts/setup/test-user.sh:230-239`; docs/test-runs.md). Rootless Docker for the database, `--network none` (measured: `scripts/setup/test-user.sh:89`, `:112`). | `/var/lib/<cli>-test/<name>/` (measured: `src/os/system-paths.ts:135`). GPU through `testrun-gpu.sh` grants (measured: `scripts/setup/gpu-devices.sh:9-11`). |
| Experiment and scorer jobs | `wl-exp-<name>`, `wl-score-<name>`, no home, no sudo, through `worklane-exp` (measured: `scripts/setup/experiments.sh:17-28`). | `PrivateNetwork` plus the nftables rule (measured: same). |
| State store | SQLite event log `<home>/state/events.db`, WAL, through built-in `node:sqlite` (measured: `src/instance.ts:306`, `:383`). Run records, the held-out store (measured: `src/held-out.ts:19-21`), the machine-wide slot directory `/var/lib/<cli>/agent-slots` and the emergency `STOP` file in it (measured: `src/slots.ts:123-128`). | One machine. |
| Secrets | GitHub App key 0400 for `wl-<name>` (measured: `scripts/setup/credentials.sh:123-127`); hour-long installation tokens cached 0600 (measured: `src/github-app.ts:54-71`); the agent's Claude login or API key 0400 in the agent's home, read through `apiKeyHelper` (measured: `scripts/setup/credentials.sh:227`, `src/runner.ts:210-216`); dashboard keys and sign-in App secrets for `wl-dash` (measured: `src/dashboard.ts:983`, `scripts/setup/credentials.sh:69`). | Root-owned machine files in `/etc/<cli>/` (network, providers, plugins, slots, signers). |
| Root helper | `/usr/local/libexec/<cli>-machine`, a fixed verb list each `wl-<name>` may sudo; `wl-dash` may not (measured: `scripts/setup/machine-helper.sh:9-25`). | Logs to `/var/lib/<cli>/machine-changes.jsonl` (measured: `:10`). |

GitHub is polled, never a webhook: the App manifest has no webhook (measured: `src/setup/app-manifest.ts:113`). The only inbound webhook is the opt-in automations gateway on the tailnet (measured: docs/automations.md:90-118). Two docs are stale: docs/separate-users.md:55 says the engine never merges, and docs/design.md:579 says the coordinator serves the dashboard (measured against the code above).

### 2.2 Per mode

| Component | Cloud account (Kubernetes) | Servers: one VM (compose) | Single machine |
|---|---|---|---|
| Coordinator | A one-replica StatefulSet per instance, its own ServiceAccount, the only holder of the GitHub App key | A container under its own uid | Unchanged |
| Evaluator, merge policy, main watch | Inside the coordinator; the evaluator's run is a pod like any agent run | Inside the coordinator; evaluator in a container | Unchanged |
| Dashboard and hub | A Deployment behind a private ingress, OIDC sign-in (§11) | A container behind the VM's reverse proxy or Tailscale | Unchanged (loopback plus Tailscale) |
| Agent runs | One pod per run in a worker namespace (§4) | One container per run, by a launcher that holds the runtime (§3.2) | OS user, as now; container opt-in later (§7) |
| Test runs | One pod per run, the database as a sidecar on a shared socket | One container group per run | OS user, as now |
| State store | SQLite on the StatefulSet's volume; slots and `STOP` as a cluster object | SQLite on a host volume; slots on the host | Unchanged |
| Secrets | Cloud secret manager and KMS through workload identity (§6) | A file store on the VM, or the cloud's manager when the VM is in a cloud | Unchanged files |
| Root helper | Replaced by Helm values and RBAC: the admin's `helm upgrade` is "root" | Replaced by the VM's admin and the compose file | Unchanged |

### 2.3 Why the coordinator stays one process per instance

The event log is one SQLite file with one writer, and the engine's design says one coordinator per repo per instance (measured: docs/design.md:64-86). **Proposal:** keep SQLite on a persistent volume, one replica, `Recreate` update strategy. A server database (Postgres) would need a client library, which is a new runtime dependency (measured: the runtime dependencies are `@anthropic-ai/sandbox-runtime`, `ws`, `yaml` and `zod`, `package.json:62-67`; docs/design.md:48 still says two), so it is an owner decision and not proposed now.

### 2.4 One codebase, selected by config

**Proposal:** one setting chooses how runs execute, `execution: os-user | container | pod`, in root's machine file (single machine and VM) or the Helm values (Kubernetes). It is never in the repo's `.worklane/` and never in a file the coordinator can write. The run's command line, `--settings`, the guard hooks and every check are built by the same code in all three. Only an **executor adapter** differs: how a run is started, how its stdout is streamed and how its workspace comes back. The adapters live in one directory, as the OS adapter does today (measured: docs/design.md:50-58). `src/testrun/host.ts` already abstracts where a test run executes (measured: `src/testrun/host.ts:496-505`), so the test-run side starts there.

## 3. Deployment targets

### 3.1 Helm chart (cloud account first, also servers with Kubernetes)

- **Identity.** One ServiceAccount per component. The coordinator's maps to a cloud role through workload identity (IRSA or EKS Pod Identity, GKE Workload Identity, Azure Workload Identity) that can read only its own instance's secrets. Agent and test pods get a ServiceAccount with `automountServiceAccountToken: false` and no cloud role (Proposal).
- **RBAC.** The coordinator may create, watch and delete pods only in its worker namespace. "Create pod" is close to node-level power, so a ValidatingAdmissionPolicy on that namespace refuses any pod that isn't the engine's: image digest from the allowlist, `runAsNonRoot`, `readOnlyRootFilesystem`, no `hostPath`, no host namespaces, no privilege escalation, the chosen `runtimeClassName`, no ServiceAccount token (Proposal; inferred that RBAC alone isn't enough). The worker namespace enforces Pod Security `restricted`.
- **Networking.** Default-deny NetworkPolicy in every namespace. Egress is allowed only to: GitHub (coordinator), the model endpoint (through the model gateway, §6), the in-cluster read-only git mirror (agents), the egress proxy (agent hosts allowlisted per lane). Plain NetworkPolicy can't match host names, so host allowlists go through an egress proxy or a CNI with FQDN rules (inferred).
- **Storage.** A ReadWriteOnce volume for the coordinator's state; per-run ephemeral volumes for workspaces; one cache volume per instance for test caches. Volume snapshots for backups (docs/backups.md covers the single-machine side).
- **Ingress.** The dashboard behind a private ingress (internal load balancer) with TLS. GitHub needs no inbound route, because the engine polls. Webhooks are optional: an ingress path with GitHub's HMAC check, off by default (Proposal).

### 3.2 One VM: docker-compose, with Terraform for a cloud VM

- **Identity.** On a cloud VM, the instance profile or attached service account, scoped to the instance's secrets. On a customer server, files owned by the coordinator's uid, as today.
- **The container runtime is root-equivalent for whoever reaches it.** #686's review measured that a test run sharing a uid with rootless Docker could `nsenter` into the containers' network namespace and reach the network (measured: the evaluator's comment on #686). **Proposal:** the runtime runs under its own uid that no workload shares. The coordinator never holds the socket; it asks a small launcher that accepts only the engine's run specs (the same checks as the admission policy above). Compose mode refuses to start if any workload container shares the runtime's uid or mounts its socket.
- **Networking.** An internal network with no egress, plus an egress proxy container for allowlisted hosts. The dashboard binds to the VM's loopback, exposed through Tailscale or a reverse proxy with OIDC.
- **Storage.** Host volumes for the coordinator's state and caches.
- **Terraform** creates the VM, its role, the secret-manager entries, KMS keys and the private network. It never creates GitHub credentials; those come from the add-project flow (Proposal).

### 3.3 Single machine: the existing install

`scripts/setup/*` stays as it is, with its CI jobs (the ci-slow real-users and real-systemd jobs) and its docs (measured: `.github/workflows/ci-slow.yml`; docs/separate-users.md). Identity is OS users and sudoers; networking is the Claude sandbox proxy, `PrivateNetwork` and the nftables rule; storage is local disk; ingress is loopback plus Tailscale serve (measured: §2.1). The root `Dockerfile` (a single-user trial image) stays a trial: it is built in CI but never published (measured: `Dockerfile:1-5`, `.github/workflows/ci-slow.yml:99-101`).

## 4. Execution isolation

### 4.1 One pod (or container) per agent run and per test run: the primary mode for cloud and servers

**Proposal for an agent run:**
1. The coordinator makes the run's spec as today (argv, `--settings`, allowlisted env) and asks the executor for a pod: engine image by digest, read-only root, non-root uid, ephemeral workspace, no ServiceAccount token, the run's NetworkPolicy label.
2. The pod clones the base commit from the coordinator's read-only git mirror. The mirror serves this instance's repo only, with no credentials, and only agent pods of this instance may reach it. Agents never hold a GitHub token, as today (measured: docs/design.md:22).
3. The coordinator streams the pod's stdout exactly as it reads `claude`'s stdout now, so the run record, stuck guard, settings check and refusal tracker are unchanged (inferred from `src/runner.ts:776-790`).
4. When `claude` exits, the pod writes a `git bundle` of its branch to stdout after the stream ends. The coordinator fetches from that bundle into its own clone and runs `inspect` on the diff, as today (measured: `src/coordinator.ts:1505-1527`). No volume is shared between an agent pod and the coordinator.
5. The pod is deleted. Nothing persists from one run to the next.

**A test run** gets a pod with the tiers' container and, when `database: true`, Postgres as a sidecar reached on a Unix socket in a shared `emptyDir`, with no network at all (today: `--network none` and a socket, measured: docs/test-runs.md:34). The `fetch` step runs in a separate pod with egress to the package registries only, and the tiers run without network, as now (measured: docs/test-runs.md:11-13).

**Claude Code's command sandbox inside a pod.** The engine sets `failIfUnavailable: true` and `allowUnsandboxedCommands: false` (measured: `src/sandbox.ts:33-35`). So if bubblewrap can't create a user namespace in the pod, the run refuses to start; it never runs unsandboxed (inferred). Whether bubblewrap works under a `restricted` pod with the runtime's default seccomp profile is a guess until measured; it may need Kubernetes user namespaces (`hostUsers: false`) or a seccomp profile that allows `unshare(CLONE_NEWUSER)` (guess). This is the first thing #702 must measure.

### 4.2 Stronger options

| Option | What it adds | Startup | Compatibility | GPU | Operations |
|---|---|---|---|---|---|
| gVisor (`runsc`) as a RuntimeClass | A user-space kernel between the run and the host kernel | Adds tens to a few hundred ms per pod (guess) | Most build and test tools work; some syscalls, `/proc` details and file-heavy I/O are slower or missing (guess: 10 to 50% slower on file-heavy builds) | Limited: gVisor's GPU proxy supports a subset of CUDA (guess) | Managed as GKE Sandbox (inferred from vendor docs, not checked today); self-installed elsewhere |
| Kata Containers (a light VM per pod) | A separate guest kernel per pod | About 1 to 3 s per pod (guess) | Close to a normal container (inferred) | Possible with device passthrough, complex (guess) | Needs nested virtualization or bare-metal nodes; offered as AKS pod sandboxing (inferred, not checked today) |
| Firecracker-style microVMs | A minimal VM per run, small attack surface | Fast boot, low hundreds of ms (guess, from vendor claims) | Needs a guest image with the full toolchain; Docker inside is awkward (inferred) | None in Firecracker (inferred) | Needs KVM (bare-metal instances); the most operations work (inferred) |

**Proposal:** pods with the runtime's default sandboxing are the default; gVisor is the recommended upgrade for agent pods where the cloud offers it; Kata and microVMs are documented options, not built. GPU test runs use the NVIDIA device plugin on plain pods.

### 4.3 OS-user mode stays

OS-user mode is the single machine's mode, and the mode for GPU work there (measured: `scripts/setup/gpu-devices.sh:9-11`, `:37-40`; docs/test-runs.md GPU section). It keeps every guarantee it has today.

## 5. Guard guarantees per mode

**Owner rule:** nothing may reopen a route that an existing install had closed, whatever its flags. Each row below holds in every mode unless it says otherwise.

| Guarantee | Enforced today | Pods (cloud, servers) | One VM (compose) | Weakens? |
|---|---|---|---|---|
| Self-modification locks | `SELF_MODIFICATION_PARTS` and `AGENT_INSTRUCTIONS`, always L3, merged last so `review.yaml` can't drop them (measured: `src/review.ts:19`, `:31-77`, `:152`, `:189`). The tool guard's lock is a hand list; the import-tree lock is #665 / PR #691, open (measured: `gh issue view 665`, `gh pr view 691`). | Same code in the coordinator | Same | No. #691 must land before product GA in every mode. |
| Policy from main | `review.yaml` through `git show` of the default branch's ref (measured: `src/coordinator.ts:549-571`) | Same | Same | No. Money paths need the fix in §1 item 2, in every mode. |
| Deterministic merge | `mergeDecision` (measured: `src/merge-policy.ts:219-252`) | Same; direct land refused (§1) | Same; direct land refused | No |
| Rename resistance | Not on main: a rename prints `{old => new}` and matches no glob (measured: `src/coordinator/base.ts:533-543`; #683 open, PR #688 open). `-diff` attributes hiding content: #693, open (measured: `gh issue view 693`). | Same code | Same | No; but the gap is open in every mode until #688 and #693 land. |
| Settings-file refusal and the applied-settings check | `projectSettingsRefusal` refuses a project's `.claude/settings.json` beyond hooks and permissions (measured: `src/agent-settings.ts:134-164`, `src/runner.ts:635`). #626 / PR #649: the run stops unless `claude`'s init echoes a fresh value from `--settings` (measured: `src/agent-settings.ts:203-228`, `src/runner.ts:693-694`, `:783-785`). | Same: the check reads the pod's stdout | Same | No |
| Tool guard (PreToolUse hook) | `--settings` hooks that fail closed with `exit 2`; `disableAllHooks` pinned false (measured: `src/agent-settings.ts:37`, `:62-91`; `src/hook.ts:77-156`). The hook runs as the agent user from a root-owned engine install (inferred). | The hook runs in the pod from the image's read-only root filesystem | Same, in the container | No, provided the root filesystem is read-only and the image digest is pinned (Proposal; a test checks the pod spec). Still Claude-dependent, as #701 records. |
| Agent command sandbox (files) | bubblewrap `denyRead` of credential stores and the coordinator's paths, fail closed (measured: `src/sandbox.ts:28-48`) | The pod has none of those files; bubblewrap still applies if it can start (§4.1) | Same | **Can weaken**: if bubblewrap can't run in a pod, the run refuses (no silent loss), but enabling it may need user namespaces. Replaced by: nothing secret is mounted in an agent pod (§6). |
| Egress control | Agents: the Claude sandbox proxy and the WebFetch allowlist (measured: `src/sandbox.ts:36`, `src/hook.ts:133-139`). Experiment and scorer users: nftables by uid; test users only with `--with-test-users` (measured: `scripts/setup/egress-firewall.sh:4-5`, `:25`, `:39`, `:51`). #543 open, PR #686 open, #545 open (measured: `gh`). | **Stronger**: a default-deny NetworkPolicy per pod, which agents don't have today | Default-deny network plus an egress proxy; the runtime under its own uid (§3.2) | Not in pods. In compose, the #686 route (same uid as the runtime) must be impossible: the compose launcher refuses it. On single machine, PR #686 stays gated on #545 (owner's decision). |
| Push gate, denylist, gitleaks | `scripts/push-gate.mjs` in the pre-push hook and in CI; `check:denylist`; gitleaks pinned and checksum-checked (measured: `scripts/push-gate.mjs:1-18`, `.github/workflows/ci.yml:180-223`, `.github/workflows/gitleaks.yml`). The coordinator's pushes go through `checkedPush` (measured: `src/coordinator/fix-runs.ts:324`). The hook scans each agent commit with gitleaks (measured: `src/hook.ts:143-151`). | Same; the engine image includes gitleaks (the trial image already does, measured: `.github/workflows/ci-slow.yml:101`) | Same | No |
| Signed releases | Signed tags checked against `.github/release-signers` read from main; tree verified byte for byte; npm staged publish with provenance (measured: `.github/workflows/release.yml:191-236`, `scripts/verify-release-tag.mjs`). On a machine, root's `allowed_signers` and the updater (measured: docs/separate-users.md:37). | **New**: images built only from a verified signed tag, signed, digest-pinned in the chart; the cluster verifies signatures at admission | Same; the launcher verifies the signature before it runs an image | Adds a registry to trust. Replaced by: signature and digest checks, with the signer keys from the customer, not the registry (Proposal). |
| Main watch | In the coordinator; polls; stops auto-merge and opens a revert PR on an unaccounted commit (measured: `src/main-watch.ts:1-31`, `src/coordinator/merge-flow.ts:940-960`) | Same | Same | No |
| Real-state isolation of tests | `test/isolate.ts` moves HOME, state, slots and system paths into a throwaway machine for every test (measured: `test/isolate.ts:1-60`, `src/os/system-paths.ts:29-62`) | New chart tests run against a throwaway cluster in CI only (Proposal) | Same | No; new tests must use the same isolation and never a real kubeconfig or cloud credential (Proposal: a test fails if one is visible). |
| Account and credential visibility | Viewers learn only that an account is set; ops posts carry no login (measured: #663 and #682 merged; `src/claude-account.ts:226`, `src/claude-auth-failure.ts:76-156`) | Same code; plus cloud IAM decides who reads the secret store | Same | No, inside the engine. A cloud admin sees everything, as root does today (§9). |
| Separate users | Coordinator and agent users. The coordinator may run anything as its agent user (measured: `scripts/setup/instance.sh:40`), so it can read the agent's key files: docs/auth.md:22 says otherwise, a current weakness (#711) | Separate pods and ServiceAccounts; the coordinator can create agent pods (equivalent power) but has no read on the gateway's secret (Proposal) | Separate uids | No; pod mode can make #711's doc claim true |
| Root's consent files (providers, network, plugins, signers) | Root-owned files the coordinator can't write (measured: docs/separate-users.md:33-37) | Helm values in a namespace the coordinator's ServiceAccount can't write (RBAC) | Root-owned files on the VM | No, if RBAC is tested: a test asserts the coordinator role has no write on its own config (Proposal). |
| Emergency stop and slots | A `STOP` file and lock files in the machine-wide slot directory (measured: `src/slots.ts:123-128`; docs/slots.md) | A cluster object every coordinator watches, writable by admins only (Proposal) | The host directory, as today | No, once moved; until then cloud mode can't start (Proposal). |
| Secrets out of argv | Env through `sudo ... env -i K=V`, so a secret in a cross-user run's env is on argv (measured: `src/os/index.ts:597-602`, `test/testrun-env-argv.test.ts:1-4`) | No sudo; secrets only as mounted files, never env (a pod's env is readable by anyone who can read the pod) | Same | No |
| Dashboard exposure | Loopback plus tailnet only, Funnel refused (measured: `scripts/setup/dashboards.sh:66`) | Private ingress with OIDC; no public ingress unless an admin opts in | Loopback plus Tailscale or a private proxy | **Opt-in only**. A migrated install keeps tailnet-only. |
| GitHub inbound | None: polled (measured: `src/setup/app-manifest.ts:113`) | Polled by default; webhooks opt-in | Same | No |

**Every guarantee that can weaken, and its replacement:**
1. **The agent command sandbox in pods** (bubblewrap may not start). It fails closed, so there is no silent loss (inferred from `src/sandbox.ts:33-35`). Replacement: no secret or coordinator file exists in an agent pod; default-deny network; a read-only root. Measure first (§12, step 6).
2. **A container runtime on a VM**, the #686 class of route. Replacement: the runtime under its own uid and a launcher with a fixed spec; compose mode refuses a shared uid (§3.2).
3. **A new image registry to trust.** Replacement: digest pinning and signature checks against the customer's signer list.
4. **A dashboard reachable from a network** instead of a tailnet. Replacement: private ingress, OIDC, and opt-in for anything wider. Migrated installs keep what they had.
5. **"Create pod" permission** for the coordinator. Replacement: an admission policy that admits only the engine's pod shape.

**Current weaknesses on the single machine. These are not guarantees, and no mode may count them as one:**
- **#710.** Re-running a setup script without its earlier flags loosens what the earlier run set. Example: the egress rule loses the test users (measured in #710: `scripts/setup/egress-firewall.sh:93`). Until #710 lands, a re-run is not a safe upgrade step (§7).
- **#711.** The coordinator can read the agents' key files through its sudo rule. docs/auth.md now says so ("Who can reach the agents' credentials"); narrowing the rule is #711's later option A. The dashboard's token paste is gone: no route takes a Claude credential (#711 part 2).

## 6. Secrets

| Secret | Today | Cloud account | Servers (VM) |
|---|---|---|---|
| GitHub App private key | 0400 file for the coordinator (measured: `scripts/setup/credentials.sh:123-127`) | Phase 1: in the cloud secret manager (AWS Secrets Manager, GCP Secret Manager, Azure Key Vault), mounted as a file at the same path through the Secrets Store CSI driver. Phase 2: an asymmetric KMS key that signs the App's JWT, so the private key never leaves KMS (inferred: all three KMSes sign RS256; GitHub App JWTs are RS256). | A file for the coordinator's uid; or the cloud's manager on a cloud VM |
| GitHub installation tokens | Hour-long, cached 0600, never given to agents (measured: `src/github-app.ts:54-71`) | Same, in the coordinator's volume | Same |
| Model access | Claude login or API key file in the agent's home, read through `apiKeyHelper` (measured: `src/runner.ts:210-216`) | **Proposal:** a model gateway in the instance's namespace holds the cloud identity (workload identity to Bedrock or Vertex, or an API key from the secret manager). Each agent pod gets a token that is valid for that run only and capped at its budget. The pod holds no model credential. | The same gateway as a container, or #700's credential files mounted read-only |
| Dashboard sign-in and break-glass keys | Files for `wl-dash` (measured: `src/dashboard.ts:983`) | OIDC client secret in the secret manager; break-glass through `kubectl port-forward` only | Files |
| MCP server secrets | 0400 per server for the broker user (measured: docs/separate-users.md:34) | The broker as its own pod with its own ServiceAccount | Its own container |

**Short-lived credentials for workers.** Agent and test pods get no cloud identity at all. An agent pod has two run-scoped tokens: one for the git mirror and one for the model gateway. Both expire when the run ends (Proposal).

**Keeping secrets out of argv, events and logs:** files, never environment variables or arguments; redaction on write stays as the last layer (measured: `src/events/log.ts:97`, `src/run-record.ts:217`, `src/run-feed.ts:136`); #700's planted-canary leak test runs in every mode, including the pod spec and the cluster's audit log (Proposal).

**A conflict with #700.** #700 says the runner never sets a `*_BASE_URL` or `CLAUDE_CODE_SKIP_*_AUTH`. A model gateway needs `claude` pointed at it, which is the same kind of setting as a provider endpoint set after `outboundEnv` (measured: `src/runner.ts:584-587`). That is an owner decision (decision 4).

**Current weakness, not a guarantee (#711).** The coordinator's sudo rule lets it run anything as the agent user (measured: `scripts/setup/instance.sh:40`), so it can read the agent's key file (inferred); docs/auth.md says so. The dashboard no longer takes or stores a Claude token at all (#711 part 2). On the single machine the sudo rule stays as it is until #711's option A narrows it. In pod mode the gateway's secret is readable by the gateway's ServiceAccount alone, and the coordinator's role has no read on it. The claim would then hold there, enforced by RBAC, and a test should check that RBAC (Proposal).

## 7. Migration for existing single-host installs

**What stays:** the scripts, OS users, sudoers, root files, the updater, Tailscale, the CI jobs and the docs. The default for every existing install is `execution: os-user`, and nothing changes without an admin acting at a root shell.

**What changes:** the executor seam (§2.4) is extracted with a golden test: today's instance configs produce byte-identical argv, `--settings`, environment and denied reads before and after (Proposal; the same method as #701's golden test).

**Re-runs and upgrades never loosen (#710).** Today a plain re-run of some setup scripts drops what an earlier run set. `egress-firewall.sh apply` without `--with-test-users` takes the test users out of the rule (measured in #710: `scripts/setup/egress-firewall.sh:93`). `service.sh` resets resource limits to their defaults (measured in #710: `scripts/setup/service.sh:35`). `gpu-devices.sh` may do the same (inferred in #710). That is a current weakness, not a guarantee. A migration that re-runs setup has to fix it first. #710 makes each script read its own root-owned record and treat it as a floor.

A Helm upgrade has the same trap: `helm upgrade` without the earlier values resets them to the chart's defaults (inferred). **Proposal:**
- the chart's defaults are its strictest settings;
- the chart records the floor it applied in an object the coordinator can't write;
- an upgrade that would loosen it fails unless an explicit loosening value is set;
- a chart test proves this.

**Container mode on one machine** is opt-in and refused unless the runtime runs under its own uid and no workload shares it, so it can't reopen the #686 route (Proposal).

**Moving an install to a cloud account:** `<cli> export` and `<cli> import` exist (measured: `src/cli.ts:409`, `:432`). The path is the one #472 describes for moving to a server: export, import into the new coordinator's volume, move the App key into the secret manager, hand over leases by exact commit (as `instance-rename.sh` does, measured: docs/separate-users.md:40), stop the old coordinator, then remove it. The new install starts with the same policy; dashboard exposure stays tailnet-equivalent (private ingress) unless an admin widens it.

**No loss of guarantees:** each row of §5 gets a test in the mode it applies to, and the single-machine jobs stay required checks throughout.

## 8. A hosted control plane (BYOC): later, not built now

- **The split.** The data plane, in the customer's account, holds the coordinator, agents, tests, the event log, code, prompts and secrets. A hosted control plane could hold the fleet view, aggregated value reports, update channels and support (Proposal).
- **What crosses the boundary.** The data plane connects outbound only. It sends aggregates (counts, hold-reason kinds, costs, versions), never code, prompts, diffs or secrets. It receives only signed release notices, which it verifies against the customer's own signer list.
- **What it can never do.** The control plane can't merge, change policy (policy is in the repo, read from main) or start a run. The merge decision stays in the data plane.
- **What it would need:** tenant isolation (per-tenant keys and storage, no shared credentials), a tenant-scoped identity for each data plane, its own threat model, and a security review. It is a separate epic.

## 9. Threat model per mode

| Actor | Single machine | One VM | Cloud account (Kubernetes) |
|---|---|---|---|
| **Agent** (model output running tools) | The agent user's files, through the sandbox; the network only to lane hosts; no GitHub token (measured: §2.1) | The container: its workspace, the egress proxy's allowlist | The pod: its workspace, the mirror, the gateway with a run-capped token |
| **Test code** (the repo's tests) | The test user, `PrivateNetwork`, rootless Docker under the same uid (the #686 route when network is granted) | The container group, no network, a separate runtime uid | The pod, no network; a kernel escape reaches the node (gVisor reduces it) |
| **Malicious PR author** (outside contributor) | Their issue isn't worked unless a writer opened it or labelled it `ready` (measured: `src/backlog/types.ts:254-264`); their PR is never auto-merged (`neverAutoMerge`) | Same | Same |
| **Cluster tenant** (another team's workload on the cluster) | Not applicable; other instances on the machine are separate users | Not applicable | Can't reach engine pods (NetworkPolicy); a node escape could; dedicated node pool recommended (Proposal) |
| **Cloud admin** | Root equivalent: can read everything | Same | Same: secret manager, volumes, etcd. Out of scope; KMS signing narrows the GitHub key's exposure |
| **Compromised dependency** (npm package of the engine, test deps) | Engine runtime deps are four packages (measured: `package.json:62-67`); test deps run as the test user | Same, in containers | Same; images built from the signed tag, `npm ci --ignore-scripts` as the updater does (measured: docs/separate-users.md:37) |
| **Model provider** | Sees prompts and the repo content agents read (measured: docs/providers.md:105) | Same | Same; Bedrock or Vertex keeps it inside the customer's cloud contract (inferred) |

## 10. Trust boundaries and data flow

### 10.1 Cloud account (pods); the single machine has the same boundaries, drawn with OS users

```
 Customer's cloud account ─────────────────────────────────────────────────────────────────────────────
 │                                                                                                    │
 │  secret manager / KMS ──(workload identity, files)──► coordinator pod ◄────── poll ──────► GitHub  │──► github.com or GHES
 │    App key, OIDC secret                                │  event log (SQLite volume)   App token, │
 │                                                        │  merge policy, main watch   never sent │
 │                                                        │  read-only git mirror        to agents │
 │                                     creates pods (admission policy) │ ▲ stdout stream + git bundle │
 │                                                        ▼            │                          │
 │   ┌─ worker namespace (default-deny network) ──────────────────────────────────────────────┐   │
 │   │  agent pod: claude + hook, workspace ──clone──► mirror     ──► egress proxy (lane hosts)│───│──► allowlisted hosts
 │   │      │ run-scoped token                                                                  │   │
 │   │      ▼                                                                                   │   │
 │   │  model gateway (workload identity) ──────────────────────────────────────────────────────│───│──► Anthropic API, or Bedrock / Vertex
 │   │  test pod: tiers + DB sidecar (no network)   fetch pod ──► package registries             │   │     in the same account
 │   └──────────────────────────────────────────────────────────────────────────────────────────┘   │
 │  dashboard ◄── private ingress, OIDC ◄── people                                                   │
 └────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 10.2 Where each kind of data goes

- **Code:** GitHub to the coordinator's clone, then to agent and test pods through the mirror. It goes back as a bundle, the coordinator inspects it, and it goes to GitHub through `checkedPush` (measured today: `src/coordinator/fix-runs.ts:324`). Code also reaches the model provider: the files the agent reads are in its prompts (measured: docs/providers.md:105).
- **Prompts:** the agent pod to the model gateway, then to the provider. Prompts aren't stored by the engine beyond the run record and feed, which are redacted on write (measured: `src/run-record.ts:217`, `src/run-feed.ts:136`).
- **Secrets:** the secret manager to the coordinator (GitHub App) and to the gateway (model access). Neither reaches an agent or test pod.
- **Logs and events:** the coordinator's volume. Pod logs live only as long as the pod, because the coordinator keeps the stream. The cluster's own log collection must be told to skip the worker namespace, or to redact it (Proposal; inferred that a default cluster logging agent would otherwise copy run output).

### 10.3 Air-gapped installs

An air-gapped install needs, each inside the boundary (inferred):
- **Model access:** a model inside the network. Bedrock or Vertex through private endpoints still leaves the network for the provider's service; a self-hosted open model needs #701's capability gate (docs/providers.md).
- **The code host:** GitHub Enterprise Server inside the network (GitLab later). The engine's GitHub host override would point there.
- **Package mirrors:** npm, pip and container registries for the `fetch` step and image builds.
- **Updates:** signed release bundles carried in by hand. They're verified against the customer's signer list with key-based signing; keyless signing needs online transparency services (inferred).

## 11. Interfaces per deployment mode

**Primary surfaces, in order:** GitHub (issues in, PRs out, the merge decision and reasons posted on the PR); the web dashboard; the CLI (admins); chat intake and notifications (Discord, Slack, Linear). **Secondary:** the desktop app, single machine only.

### 11.1 What ships, and its auth, per mode

| Surface | Auth today (measured) | Cloud account | Servers | Single machine |
|---|---|---|---|---|
| GitHub | The instance's App; issues count from writers or a writer's `ready` label (`src/backlog/types.ts:254-264`); review packet and hold reasons on the PR (`src/coordinator/merge-flow.ts:678-698`, `src/coordinator/review-packet.ts:1-5`). GitLab: none (only a CI path pattern, `src/review.ts:97`). | Supported | Supported | Supported |
| Web dashboard | GitHub sign-in through the hub's App; role from repo permission: admin is owner, maintain or write is writer, triage or read is viewer, re-checked every 5 minutes (`src/dashboard-auth.ts:98-112`, `:312-351`). Break-glass key on loopback 4398 (`src/dashboard-hub.ts:18-21`). Machine changes also need root's machine-owners list and an allowed Tailscale device (`src/machine-owners.ts:1-13`). No OIDC or SAML (`src/github/errors.ts:55` is the only SSO hit). Mobile: viewport and media rules, no PWA (`web/index.html:5-8`, `web/src/styles.css:142`). | Supported, with OIDC to the customer's IdP (new) mapped to the same three roles | Supported, OIDC or GitHub sign-in | Supported, as today |
| CLI | Whoever has the files; `decide` checks no role (`src/cli.ts:1049-1071`). No `upgrade` command (`src/cli.ts:90-233`). | Admins only, through `kubectl exec`; CI scripting with `--json` | Admins on the VM | As today |
| Discord | Senders mapped to a GitHub login; role from repo permission; high-risk approvals need `discord.owners` and admin (`src/coordinator/channel.ts:4-6`, `src/intake/people.ts:58-60`). There is no "Discord root" role: a step that needs root is only announced, with a link, and is done at a root shell (`src/coordinator/channel.ts:9-10`). | Supported | Supported | Supported |
| Slack | Socket Mode, mentions from allowed senders and channels; intake and replies only (`src/intake/slack.ts:1-8`) | Supported | Supported | Supported |
| Linear | Polled API key, allowed senders' issues only; intake and comments only (`src/intake/linear.ts:1-8`) | Supported | Supported | Supported |
| Siri | Device token on gateway port 4397, idea or question only (`src/siri/instance.ts:1-16`) | Not shipped (inferred: it depends on the tailnet gateway) | Optional | Supported |
| Desktop app | A window locked to a loopback dashboard URL, no IPC; asks for the dashboard key (`desktop/src/main.rs:1-47`). It doesn't manage the engine or notify (inferred: that file is its only source). | Not shipped | Not shipped | Supported (secondary) |

### 11.2 Which surface carries each action today (measured)

| Action | Where it exists |
|---|---|
| Approve a held change | GitHub (a human merge, or the owner's review under batching, `src/coordinator/merge-flow.ts:664-677`); Discord "approve N" (`:606-628`); dashboard answers a `land` decision, owner only (`src/decide.ts:50`); CLI `decide` |
| See the hold reason | GitHub review packet (`src/coordinator/merge-flow.ts:690-695`); Discord merge post (`src/intake/channel.ts:83`); dashboard board, writers (`src/board.ts:252`) |
| Policy change | Dashboard instance settings and policy form, owner (`src/dashboard.ts:2043`, `:2249-2257`); `review.yaml` by a PR on GitHub |
| Auto-merge on or off | Dashboard policy form, owner (`src/policy-edit.ts:13`) |
| Resume auto-merge after a stop | Dashboard, owner (`src/dashboard.ts:2750-2756`) |
| Emergency stop and resume | CLI `stop-all`, `resume-all`, machine-wide (`src/cli.ts:1128-1138`); the dashboard shows status only (`src/dashboard.ts:1355`) |
| Cancel a run | Dashboard, owner (`src/dashboard.ts:1783`) |
| Start or stop an instance | CLI `up`, `down` (`src/cli.ts:771`, `:799`) |
| Machine changes (slots, updates, add project, account switch) | Dashboard, owner plus machine owner plus device (`src/dashboard.ts:2561-2645`); add project also CLI `instance init` |
| Answer a decision | Dashboard, GitHub comment, Discord thread, CLI (§1 item 4: different gates) |
| Intake | GitHub issues, Discord, Slack, Linear, Siri, dashboard voice (`src/intake/*`, `src/dashboard.ts:2781`) |

### 11.3 Actions on one surface that should be on another

1. **Emergency stop**: CLI only (measured: `src/cli.ts:1128-1138`). Missing on the dashboard (mobile), in Discord and Slack for owners, and in the desktop app. It is also machine-wide only; a per-instance pause exists nowhere (measured: `src/slots.ts:123`).
2. **Approve a held change through the engine's merge path**: Discord only (measured: `src/coordinator/merge-flow.ts:606-659`). The dashboard links to GitHub's merge button instead (measured: `src/board.ts:230-236`). Missing as an owner button on the dashboard.
3. **Auto-merge on or off, and resume after a stop**: dashboard only (measured: `src/policy-edit.ts:13`, `src/dashboard.ts:2750`). Missing in the CLI for admins and CI, and as an owner "stop merging" in chat.
4. **Cancel a run**: dashboard only (measured: `src/dashboard.ts:1783`). Missing in the CLI.
5. **Start or stop an instance**: CLI only (measured: `src/cli.ts:771`, `:799`). Missing on the dashboard for machine owners (cloud: scale the coordinator to zero).
6. **Decisions and hold notices in Slack**: Discord only (measured: no Slack path in `src/coordinator/channel.ts`; `src/intake/slack.ts:1-8`). Missing in Slack.
7. **One approval gate**: the dashboard's owner-only kinds aren't enforced on GitHub comments or the CLI (§1 item 4).
8. **The desktop app** doesn't manage the local engine or notify (inferred: `desktop/src/main.rs` is its only source). Missing for single-machine mode.

## 12. Build plan

Sizes: **S** less than a day or under 300 lines; **M** one or two PRs; **L** several. Every step keeps the single-machine CI jobs (ci-slow real users, real systemd) green and required, and its docs current. No step changes a single-machine install's behaviour without the golden test in §7.

**Before anything in #702 or #703 (guard gaps that hold in every mode):**
1. Land #691 (#665, tool-guard import tree) and #688 (#683, renames), then #693 (attribute-hidden content). S each, already in review.
2. Money paths from the default branch (§1 item 2). S.
3. One approval gate on every surface (§1 item 4). S.
4. Direct land refused outside single-machine mode (§1 item 1). S.

Also first: #710 (re-runs never loosen) and a decision on #711 (who can read the agents' credentials), before any migration step re-runs setup. S to M.

**#702: per-task isolation (L overall):**

5. The executor seam with the golden no-change test (§2.4, §7). M.
6. Measure Claude Code's sandbox in a restricted pod and in a container (§4.1), and record the result in the doc. S.
7. Engine images (coordinator, agent, test) built from the signed tag, signed, with an SBOM; CI builds them on every PR and never publishes from a branch. M.
8. The pod executor for agent runs: read-only mirror, bundle return, NetworkPolicy, admission policy, a test of the pod spec. L.
9. The pod executor for test runs: database sidecar, caches, the fetch pod, GPU through the device plugin. M.
10. Compose launcher for one VM, with the separate-runtime-uid refusal (§3.2). M.

**#703: deployment (L overall):**

11. Cluster state: SQLite on a volume; slots and `STOP` as a cluster object. M.
12. Secrets phase 1 (CSI mount at today's paths), then the model gateway with run-scoped tokens. S, then L.
13. The Helm chart and a throwaway-cluster CI job. M.
14. Terraform module for a cloud VM, and the compose file. M.
15. Dashboard OIDC and private ingress; optional webhooks with HMAC. M.
16. Image signature verification at admission and in the launcher; the air-gap bundle. M.
17. Export and import to a cluster, and the move guide (with #472). M.
18. The interface gaps in §11.3, one issue each. S each.

**Epic items this changes:**
- **#702 (per-task isolation)** becomes steps 5 to 10.
- **#703 (deployment)** becomes steps 11 to 17, adds this mode table to its acceptance, and depends on #710.
- **#700 (auth):** in pod mode the model credential sits behind the gateway, not in the pod. #700's "never set a base URL" constraint needs an exception for the gateway (decision 4). The leak test runs in every mode. #711 is decided alongside it.
- **#701 (runner):** "provided by the run environment" includes a pod's NetworkPolicy as the egress capability, which makes `cli:codex` and `cli:gemini` routes guardable in pod mode (inferred).
- **#707 (adversarial suite):** gains the pod-mode and VM-mode routes in §5 and §9: the #686-class same-uid route, a pod spec the admission policy must refuse, and RBAC on the gateway's secret.
- **#705 (docs and proof):** gains this doc's per-mode guarantee table as something to prove per mode, with single-machine docs kept current.
- **#704 (governance mode), #706 (first-time polish) and #708 (value report):** no change from this doc. The value report is the first aggregate a control plane (§8) would read.

## 13. Decisions for the owner

1. **Modes and order.** Cloud account first in build order; servers second; the single machine stays first-class with its own CI and docs. Recommended: yes.
2. **Direct land outside the single machine.** Refuse `land_mode: direct` in cloud and servers modes, so every merge there goes through `mergeDecision`. Recommended: yes.
3. **State store.** SQLite on a persistent volume, one coordinator replica per instance; no Postgres, because Postgres needs a new dependency. Recommended: yes.
4. **Model credentials in pod mode.** A model gateway with run-scoped tokens, which needs an exception to #700's "never set a base URL" rule; or #700's credential files mounted into each agent pod. Recommended: the gateway for pods, files for the single machine and VM.
5. **Isolation runtime.** Plain pods by default, gVisor recommended where the cloud offers it, Kata and microVMs documented only. Recommended: yes, after step 6 measures the sandbox in a pod.
6. **Moving code to and from runs.** A read-only git mirror in, a git bundle out, and no volume shared with the coordinator. Recommended: yes.
7. **Dashboard sign-in in cloud mode.** OIDC to the customer's identity provider, mapped to the existing three roles; private ingress, with public ingress opt-in only. Recommended: yes.
8. **GitHub webhooks.** Keep polling as the default, so no inbound route is needed; webhooks are opt-in. Recommended: yes.
9. **Image signing keys.** A key held by the owner (works air-gapped), or keyless signing through CI's identity (needs online services). Recommended: key-based, with the signer list from the customer's side.
10. **Gate fixes first.** Money paths from main and one approval gate on every surface, as S issues before #702; #710 before any migration step. Recommended: yes.
11. **BYOC control plane.** Not now; record the boundary rules in §8 only. Recommended: yes.
12. **Siri and the desktop app** ship in single-machine mode only. Recommended: yes.
