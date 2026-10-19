# Changelog

Every release, newest first: the PRs merged since the previous one, and what changed in guardrails.

## v0.5.3 (unreleased)

### Upgrading (from v0.5.2)

- **Project commands run as the agent user only inside a sandbox (#713).** Checks, worktree setup, full runs, suite tuning, a browser flow's app and auto-config now run in bubblewrap (`/usr/bin/bwrap`), which hides the agent's Claude logins, its API key and every file `credentials.yaml` names. This holds whatever `policy.yaml`'s `sandbox` says. There is no unsandboxed fallback. What an existing install may see:
  - **Bubblewrap can't run there** (not installed, or no AppArmor rule letting it make user and PID namespaces). Every project command is refused with exit 125 and `project command not run: its sandbox didn't start (...)`, so no checks, setup or full runs happen. This includes an instance set to `sandbox: false` because bubblewrap didn't work. Fix, as root: `sudo bash scripts/setup/machine.sh`, then `sudo bash scripts/setup/check.sh <name>`, whose `can start a project command's sandbox` line runs the exact sandbox the engine uses.
  - **An `idle_probe` that looks for processes (`pgrep`) no longer sees any outside its sandbox,** so it always reports idle. Move it to a lock file or a port (docs/slots.md).
  - **`credentials.yaml` paths must be absolute.** An instance with a relative one is refused at start, naming the field (`must be an absolute path`).
  - **`tests.yaml`'s `env` can't set bash's own variables:** `SHELLOPTS`, `BASHOPTS`, `GLOBIGNORE`, `EXECIGNORE` and any `BASH_*`. A config that sets one is refused, naming it (`set by the harness or the system; a project may not change it`). Set the option in the command itself instead (`shopt -s ...; npm test`).

- **GitHub-sourced intake reports are worked from the draft intake checked (#643).** Two cases change on upgrade:
  - An outsider's report filed `ready` on its own GitHub issue (the `<cli>:intake` label) by an older engine, and not started yet, has no checked draft kept, so it is now refused with a comment saying why. Removing `ready` doesn't bring it back to intake: its report stays in the seen ledger for 365 days. To have it worked, a writer opens a new issue with its contract.
  - A writer-authored intake issue with no checked draft kept (filed by an older engine, or after the instance's state dir was wiped or moved) is worked from its body, as before this release. It doesn't get the draft's `- repro: true` unless the body has it.
- Any issue with more than one ```` ```done_when ```` block is now refused rather than worked from the first one (#643). On upgrade, check open `ready` issues for a second block.
- **The dashboard's owner terminal is removed (#742).** The Setup console no longer opens a login shell as the machine's admin user; use ssh, or the break-glass (port 4398, through ssh). The device list for machine changes stays: it is now `dashboards.sh --machine-devices`, and a hub unit's older `--console-devices` is read as it, with no device added, so machine changes from the page keep the same gate before and after the rerun below. Migration, on a machine that had the terminal (`--console-user` in the hub's unit), as root, once, after the install:
  - `worklane doctor` prints the exact command, built from the hub unit's own `ExecStart` (`/etc/systemd/system/worklane-dashboard-hub.service`), every value single-quoted, and only when each value is one `dashboards.sh` itself accepts (otherwise it prints the placeholder version below, and why, never a word from the unit). By hand, fill in each `<...>` and `[...]` from that `ExecStart`, and leave out `--siri` and `--hooks` only if it has no `--siri-port` or `--hooks-port` (without them the rerun turns the Siri and hooks gateways off): `sudo bash /opt/worklane/current/scripts/setup/dashboards.sh [--machine-devices <the hub unit's --console-devices or --machine-devices, if it has one>] --client-id <its --client-id> --public-url <its --public-url> [--siri if it has --siri-port] [--hooks if it has --hooks-port] <each instance name in its --hub>...` (the older command line works too: `--console-user` is ignored and `--console-devices` is read as `--machine-devices`). It removes the console shell (`/usr/local/libexec/worklane-console-shell`) and its sudoers rule (`/etc/sudoers.d/worklane-console`), and writes the hub's unit with `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=read-only` and `PrivateTmp=yes` again. Add project, `tailscale.sh public-url` and instance removal rerun it the same way.
  - Until then the engine never starts the console shell, and the engine update itself replaces the installed console shell with a stub that refuses every command (the updater keeps the file's owner and mode, as for every root helper). But the sudoers rule is still there and the hub runs without its sandbox: the Setup console shows its owner a notice, and `doctor` fails (`owner terminal`, exit 1).
- The setup step `console-devices` (Owner terminal devices) is now `machine-devices` (Machine-change devices); a skip recorded for the old one doesn't carry over.

### After install

- **A machine whose hub unit has `--console-user` (it had the owner terminal):** rerun `dashboards.sh` as root, once, after the install, with the exact command `worklane doctor` prints (built from the hub unit's `ExecStart`), or by hand, each `<...>` and `[...]` filled in from that `ExecStart`: `sudo bash /opt/worklane/current/scripts/setup/dashboards.sh [--machine-devices <the hub unit's --console-devices or --machine-devices, if it has one>] --client-id <its --client-id> --public-url <its --public-url> [--siri if it has --siri-port] [--hooks if it has --hooks-port] <each instance name in its --hub>...` (the same command as under Upgrading; leaving out `--siri` or `--hooks` that the unit has turns that gateway off). It deletes the console shell (by then the update's refusing stub) and its sudoers rule, and gives the hub its sandbox back. Until then, `doctor` fails with `owner terminal`. The engine update can't do this itself: the installed updater is the older one, and it never touches sudoers.
- **Install this release's updater, so updates carry on once the `desktop` check stops running (#744).** Every install so far has `desktop` in `/etc/worklane/updates.json` `required_checks`. This release's updater no longer waits for that one retired check when a commit has no run of it. While CI still has the job, every commit gets a `desktop` run, and the updater judges it exactly as before. A later release removes the desktop window and its CI job, and from then on no commit has a `desktop` run.
  - An update doesn't yet replace the updater itself, so rerun `updates.sh` as root, once, after the install: `sudo bash /opt/worklane/current/scripts/setup/updates.sh`. It installs this release's updater and keeps `updates.json` as it is (on or off, channel and checks included).
  - A machine whose updater predates this release keeps waiting for `desktop` once the job is gone, so it installs nothing more (fail-closed). The journal says why: `required check "desktop" hasn't run on this commit`. Rerunning `updates.sh` from this release or a later one fixes it.
- **That same rerun is the last one an updater change needs on the release channel (#760).** It also records the installed updater's version in `/var/lib/worklane/updater.json` and keeps the one it replaces as `/usr/local/libexec/worklane-update.prev`. From the next release on, an updater on the release channel replaces itself after each healthy install. An update can't do this first step: until root installs an updater that has this code, the running one doesn't know how. Without the rerun the old updater keeps installing releases and never replaces itself.
  - A machine on the main channel never replaces its updater (main has no signature to check), so updater changes still need this rerun there.
- No new sudoers rules, so no machine-helper rerun.

### Guardrail changes

- **Added: a sandbox for every project command run as the agent user (#713).**
  - It hides `~/.claude*`, `~/.config/*-claude-key`, the instance home and every `credentials.yaml` path, each resolved once when the command starts.
  - It gives the command its own PID namespace and `/proc`, and keeps devices and the network.
  - It fails closed when it can't start.
  - Output from project commands (checks, setup errors, a browser check's tail) is redacted before it reaches an event or a prompt.
- **Removed: a sudoers rule and a root helper (#742).** The owner terminal's rule (the hub's viewer user may run the console shell as the admin user) and the root-owned console shell are gone; `dashboards.sh` removes both from an older install on its next run, and nothing installs them. The console shell in the engine is now a stub that refuses every command, so the engine updater (old or new) replaces a live one with it on the first update; the updater still never installs it where it is absent and never touches sudoers. The hub's unit always keeps its full sandbox. The device allowlist for machine changes is unchanged, under its new name `--machine-devices`.
- **The engine updater no longer waits for the retired `desktop` check when a commit has no run of it (#744).** It is the only name in the updater's own fixed list (`RETIRED_CHECKS` in `scripts/machine/worklane-update.cjs`). A `desktop` run that exists is judged as before: failed, skipped or cancelled refuses, and queued or running waits. A list of retired names alone, none of which ran on the commit, is refused, as an empty list is. Nothing changes while CI still runs the job. The window it tested was never built or installed by the updater.
- **The root updater replaces itself, on the release channel only (#760).** After a healthy install from a signed release tag, it takes that release's `scripts/machine/worklane-update.cjs`. It reads the file from the tag's commit in its root-owned verification clone after checking the tag's signature again, and only when the signed tag names itself and points at the engine just installed. Never from main, never from the build, and never an older or equal release than the running updater's recorded version, so an engine rollback doesn't take it back. The swap is atomic: a temp file, `node --check`, `root:root 0755`, read back as a regular file with the release's bytes, then renamed. Any failure leaves the running updater as it is and logs why. The previous one is kept as `/usr/local/libexec/worklane-update.prev` for a manual rollback (`sudo install -o root -g root -m 0755 /usr/local/libexec/worklane-update.prev /usr/local/libexec/worklane-update`). On by default; root turns it off with `sudo touch /etc/worklane/updater-no-self-update`. `updates.sh` no longer puts its updater over a newer one the updater took from a release.
- **The release channel installs a release only under its own signed name, and builds exactly the tag object it verified (#764).** It only refuses more:
  - A signed tag object whose own `tag` header isn't the ref it was fetched under is refused, and the reason is logged. Before, someone who could push tags could put an older release's signed tag at a higher version's ref (v0.4.0's at `refs/tags/v0.9.9`, say) and have it installed as newer. The existing "never older than the installed version" check now compares signed versions. There is no owner path for installing an older release, and none is added.
  - The tag is resolved once to one object id in the root-owned clone. Its signature, its name, its commit's shape and the checks are all read on that id. The tag object and commit `ls-remote` reported must be the ones verified, or the release is refused. Before, a tag moved between `ls-remote` and the fetch could have the engine built from a commit other than the one verified (an unsigned one, say). A ref that moves in the clone while it is being checked is refused too.
  - Every git command in the release check and in the updater's own self-update source runs with replace refs off (`git --no-replace-objects`, which sets `GIT_NO_REPLACE_OBJECTS=1`). A `refs/replace/<oid>` planted in the clone can no longer stand other bytes in for the tag or its commit.
  - How it reaches a machine: no extra step. The one `updates.sh` rerun this release already asks for (#760) installs this release's updater, with these checks. After that, updater changes reach a release-channel machine through its self-update. The install of this release is itself still checked by the machine's older updater.

## v0.5.2 (2026-10-17)

### Highlights

The GPU device nodes stay `root:worklane-gpu-dev 0660` after a reboot (#575). On Ubuntu's NVIDIA driver (measured on 24.04, driver 595), a root process that starts NVML, such as `nvidia-smi` or the container toolkit's `nvidia-cdi-refresh.service` at boot, put `nvidia-uvm` and `nvidia-uvm-tools` back to `root:root 0666` and the `nvidia-caps` nodes to `root:root`, and a node made after udev's own fixer run kept the wrong owner. `gpu-devices.sh apply` now also writes a boot unit that runs the fixer after udev has settled, a drop-in that runs it after `nvidia-cdi-refresh.service` (and when that unit fails), and a drop-in that gives `nvidia-persistenced` the device group, so it stops failing every boot. `check` fails when any of them is missing.

`apply --users <you> --no-dynamic-nodes` is opt-in and **not for MIG GPUs**: it also sets `NVreg_ModifyDeviceFiles=0`, so NVML changes no node at all, and `/dev/nvidia-caps` stays empty (MIG's capability nodes aren't made).

### After install

- **A machine whose GPU nodes were closed with `gpu-devices.sh`:** rerun it as root, once, after the install: `sudo bash /opt/worklane/current/scripts/setup/gpu-devices.sh apply --users <you> [--no-dynamic-nodes]`, then `sudo reboot`, then `sudo bash /opt/worklane/current/scripts/setup/gpu-devices.sh check` **before touching anything** (it shows whether the boot alone left the nodes right). `apply` refuses while another `modprobe.d` file sets `NVreg_DeviceFile*` or `NVreg_ModifyDeviceFiles`: remove that file first.
- No new sudoers rules, so no machine-helper rerun.

### What changed in guardrails

- A new root-owned boot unit (`worklane-gpu-devices.service`) and root-owned drop-ins for `nvidia-cdi-refresh.service` and `nvidia-persistenced.service`, written by `gpu-devices.sh apply` and removed by `revert`. They run the existing fixer (`root:root 0755`, no arguments) and give the persistence daemon the device group. No new sudoers rules, and no device access beyond `worklane-gpu-dev` (#575).

### Known advisories

- **node-forge** (Dependabot, high, runtime): no patched version exists. Tracked in #551. The MCP broker never enables sandbox-runtime's MITM proxy (the path the advisory reaches), and a test pins that (#552, in 0.5.1).

### Features

- Pin the engine to v0.5.1 (#558)

### Fixes

- gpu-devices: run the fixer after nvidia-cdi-refresh.service, and when it fails; fix stale nvidia-modprobe text (#575)

### Guardrail changes

- none in this release

## v0.5.1 (2026-10-16)

### Upgrading (from v0.5.0)

- **Test runs have no network by default.** A run's commands get only their own loopback, and its database is a Unix socket (docs/test-runs.md "Network"). A `tests.yaml` `test_run.setup` that downloads fails every run after the update until its config changes:
  - npm: move the downloads to `fetch: [{ npm: npm }]` and install with `npm ci --offline`. That needs no grant, unless an install script downloads at script time (Prisma engines, Puppeteer's Chrome).
  - npm setups with install scripts that download, and pip, pnpm and yarn setups, need root's grant, `sudo bash scripts/setup/testrun-network.sh enable <instance> --tiers setup`, plus `setup_network: true` under `test_run`.
  - v0.5.0 rejects `setup_network` (and `fetch`), so set them only after the machine has upgraded.

### After install

- **Rerun the machine helper's sudoers rules** as root, once per machine, with every instance on it: `sudo bash /opt/worklane/current/scripts/setup/machine-helper.sh <every instance>` (helper protocol 10). Until then, coordinators can't run the helper's new commands (sudo refuses them). Not before the install: the rules must match the installed helper (docs/releasing.md step 9).

### Preview

- **Slack and Linear intake** (#526) is a preview: it is tested only against fake Slack and Linear servers, never the real services.

### Features

- Pin the engine to v0.5.0: ENGINE_TAG now, ENGINE_COMMIT by pin-engine.mjs after the signed tag (draft until tagged) (#431)
- Release: CI stages on npm (owner approves with 2FA), only for a tag signed by main's release-signers (#460)
- Docs: lead with the npm install (npm i -g @worklane/cli, then worklane dashboard --detach); restore the npx hint in --help (#459)
- Decision detail views (1/2): decisions record what they rest on (change, verdict, checks, findings with file:line) (#475)
- Bootstrap with no https origin: always end with a working loopback URL and the ssh -L line; the App step points to screen 7 first (#425)
- Package (0.5.1, after 0.5.0): the built engine's imports and dependencies are the same set (#444)
- release.mjs: the tag exists afterwards only if it verified (#476)
- dashboard --detach: prove the key without sending it (#477)
- Updater: a channel-neutral unit Description; a current pass is recorded (#478)
- Tests: a test's Chrome reaches nothing outside this machine (#462, part 1) (#479)
- Dashboard key: its path on its own line, a quoted copy command, the same on the key page (#480)
- Release: licenses.txt reproducible for a lockfile; release.yml never stages a tree that isn't the signed one (#481)
- Chrome: never the macOS keychain on any engine or test launch (--use-mock-keychain --password-store=basic) (#435)
- Decision detail views: /decisions/:id from every decision card, with role gating (PR 2 of 2) (#485)
- Dashboard: people's pictures from the dashboard's own origin, never GitHub in the browser (#462, part 2) (#482)
- Install downloads try a passing server error again (--retry 3); checksums unchanged (#492)
- Test runs: per-instance, opt-in GPU for sandboxed runs (NVIDIA nodes only, off by default) (#493)
- Real-Chrome lock: no pinned test count; launchTestChrome refuses without the lock (#494)
- No CI (ci: none) judged by this machine's test runs from the event log; init never finishes without a CI choice (#469, part 2; stacks on #486) (#491)
- GPU test runs: locks for the worklane-gpu group only (owner alone, never agents); a cut-off GPU run's head gets a failing check (#500)
- Releasing: rerun machine-helper.sh per instance after a release that changes its sudoers installs (#501)
- Evaluator: calibrated confidence with a required reason; compromised-component question on protected changes (#498)
- GPU cut-off check: 'push again to run it' (#504)
- Board: a card's waiting reasons in full, one chip per merge-policy reason (#497)
- No CI: every tier runs on each merge commit and judges main; never green with nothing checked; unattended install ends at the wizard (#505)
- Service (#468, part 3): run node by Homebrew's stable bin/node or its own path, never one on PATH; doctor and first run flag a versioned one (owner merges) (#490)
- First run (#468, part 4): Your first task files an issue the harness takes (a checkout only); the Issues page says why an issue is ignored (owner merges) (#502)
- Siri Shortcuts: tell and ask through the hub's own gateway, per-device tokens that reach nothing else (owner merges) (#507)
- Claude account profiles (#464, part 3): sign an account in from the dashboard, the one-time code relayed once; staged until a root admin confirms it (#495)
- Runner probe: pull the image first; a failed container fetch says wget's error and exit status (#506)
- Package budget: tarball 1,650,000, unpacked 5,200,000 (0.5.1's growth) (#511)
- No late answer moves a control on Settings, Inbox or Decisions (#503)
- Releasing: Siri Shortcut steps after a 0.5.1 install (#510)
- Held-out evals: the case writer gets the replier's stage values (#188, #189, #190) (#512)
- First run (#468, part 1): one primary next step, done steps fold, one CLI line, plain protection wording, setup-mode nav, local owner label, worker model list (#487)
- Chat: conversations and Projects (owners and writers), on the attachment store (#513)
- no-late-shift: send every pending answer before turning Fetch interception off (#517)
- Plugins (1/6): inspector, wl-tree-v1 and a pinned fetch (no wiring yet) (#519)
- Chat: model and effort picker limited to routing, per-conversation budget cap (#514)
- Intake: Slack and Linear sources beside Discord (preview: tested against fakes only) (#526)
- GPU devices: NVIDIA nodes root:worklane-gpu-dev 0660, granted test runs through the unit's group (v0.5.1, protected) (#525)
- First run (#468, part 2): preview the config before its PR, merge from the wizard as the admin's approval, one merged-to-synced path for every config PR (owner merges) (#489)
- Automations: schedule, GitHub and Discord triggers; Extend -> Automations (#522)
- Daily budget: enforce on the local day, held until local midnight (#518)
- Test runs: one instance's wipe never stops another's units or Docker (helper protocol 9) [PROTECTED: owner merges] (#540)
- Package budget: temporary headroom for the v0.5.1 set (2,000,000 / 6,000,000) (#542)
- Refuse instance names whose machine users or units are another's (test-, ci-, dashboard-, ...) [PROTECTED: owner merges] (#534)
- Automations: webhooks through a tailnet-only hooks gateway, each run approved by an owner (#528)
- Optional cross-family evaluator: a second verdict on protected changes; disagreement holds the PR (#539)
- Plugins (6/6): update offers, update diffs, and what each run loaded (#533)
- Test runs: no network by default; root grants it per tier; a fetch phase that runs no repo code; Postgres on its socket only (protected) (#529)
- ci: new-deps check, new runtime dependencies named in the PR body with licence and why (#553)
- instance rename: export, add, import, re-key, remove; never two coordinators on one repo (v0.5.1, PROTECTED: owner merges; stacked on #548; supersedes #536) (#549)
- Package budget: v0.5.1 final, measured actual + 5% (1,850,000 / 5,810,000) (#556)

### Fixes

- Fix #452: an avatar's box is its size whatever its picture does, so a failed picture moves no card (#461)
- Fix #463 (1/2): a Claude login the API refuses ends runs auth_failed, turns red, holds the login until a tiny real check succeeds; failed runs keep their why (#473)
- Fix #463 (2/2): the Claude account switch proves the new login with a real call, and rolls back when the API refuses it (#474)
- Governor holds are seen: a banner with numbers and a fix on the Board and First run, doctor warns, disk floor max(10 GB, 5%) (#483)
- Fix: claude-failover 'back after the reset' deterministic (flake on main) (#537)
- Fix: siri-ask cost-leak check uses a value that can't occur by chance (#547)
- Claims labeled measured/inferred/guess, no handed-over checks, and the structural fix when corrected twice (#541)

### Security and guardrails

- CI: route main's agentshield, push-gate, denylist and scan to the self-hosted runner behind CI_SELF_HOSTED (owner merges) (#441)
- Claude account profiles (#464, part 1): several accounts per agent user, chosen from the dashboard after a real call (#484)
- Claude account failover (#464, part 2): on a usage limit, the next account in the order, proven by a real call; optionally back after the reset (#488)
- Chat attachments: drop, paste or upload files to the dashboard chat (owners and writers; allowlist, caps, 0600, retention, secret warning) (#499)
- Guardrails: agents never read a dashboard key (#509)
- Fix: siri token secret parsed by structure (flake on main) (#538)
- Experiments (4/4): Extend -> Experiments: a study's log, best so far, queue and spend; Review -> Confirm (#535)
- Test: the MCP broker never enables sandbox-runtime's MITM proxy (node-forge advisory path) (#552)

### Guardrail changes

- Claude account profiles (#464, part 1): several accounts per agent user, chosen from the dashboard after a real call (#484): src/sandbox.ts
- Claude account failover (#464, part 2): on a usage limit, the next account in the order, proven by a real call; optionally back after the reset (#488): src/sandbox.ts
- Chat attachments: drop, paste or upload files to the dashboard chat (owners and writers; allowlist, caps, 0600, retention, secret warning) (#499): src/scan/secrets.ts
- Guardrails: agents never read a dashboard key (#509): src/hook.ts
- Experiments (4/4): Extend -> Experiments: a study's log, best so far, queue and spend; Review -> Confirm (#535): src/hook.ts

## v0.5.0 (2026-10-14)

### Highlights

One command, one URL: `bash scripts/bootstrap.sh <repo>` (or `--hardened` on a server) installs pinned, checksum-checked tools and the engine, then prints a single first-run wizard URL with no key in it, where every remaining setup step happens on its own screen (#357, #380). Owners can now dictate into the Ask panel and hear answers read back, on-device and off by default (#404, #405), and with voice intake turned on, speak an idea or "approve <issue>" and confirm it within 10 seconds (#411). A goal issue is split into child tasks with "Depends on" edges, and the goal's page draws that task graph (#347, #351, #410). The engine updater drains a machine that is never quiet: new runs pause, in-flight work finishes, the update installs and the machine reopens (#407). A full disk no longer kills the coordinator: events wait in memory, new work pauses under a `disk_full` incident, and everything resumes on its own (#398). One start gate now sits in front of every test run, so the disk floor and `disk_full` hold all six paths that start one (#406). The dashboard is much faster: each dashboard reads its event log once and then only what is new, built files are compressed and cached, and pages switch from what the page already holds; at 120 ms latency and 10 Mbit/s a cold load shows real data in about 1 s and switches take under 100 ms, gated by a real-Chrome test (#442, #445). The test suite runs clean beside a live install, on its own temporary home, state and slots (#436).

### Upgrade notes (from v0.4.1)

- **Config keys removed.** `.worklane/` files are strict, and v0.5.0 refuses these keys, which v0.4.1 accepted: `every_minutes` and `tools` on a role in `agents.yaml` (v0.4.1's template set `monitor: { ..., every_minutes: 30 }`), the `trust:` block in `agents.yaml`, and `stages:` in `review.yaml`. Delete them, or the config fails to load with `Unrecognized key`. The optional roles and trust stages they configured were removed. `stage:` in `agents.yaml` is still accepted and ignored.
- **Plans wait for you.** `config.yaml` `plan_gate` defaults to `always`: every size:M/L plan waits for an owner's approval before any code is written. `plan_gate: risky` holds only high-risk or design-level plans (#334).
- **More attempts per task.** A task gets up to 8 worker attempts by default (it was a fixed 3). Set `agents.yaml` `max_attempts` (1-20) to change it (#338).
- **`land_mode: direct` needs branch protection.** The coordinator refuses to start in direct mode when the default branch is unprotected, or its protection can't be checked. Use `land_mode: pr` (the default) or turn protection on (#254).
- **Proxies and custom CAs come only from root's `/etc/worklane/network.json`.** Proxy, host-redirect and TLS-trust variables (`HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, `ANTHROPIC_BASE_URL` and the like) are stripped from every child's environment (#391, #396). See docs/network.md.
- **`WORKLANE_GITHUB_API` and `WORKLANE_GITHUB_WEB` are gone.** GitHub's hosts are constants (#381).
- **Reinstall through the bootstrap.** `bash scripts/bootstrap.sh <repo>` installs the engine release pinned in it, checked by its release commit. `worklane doctor` lists any pending config or state migration, and `worklane migrate` applies it after a backup (the coordinator won't start while one is pending).

### Features

- Run agents as their own OS user by default (#8)
- Ship machine setup as reviewed scripts; no coordinator Claude login with separate users (#11)
- Land by pull request; refuse admin tokens (#13)
- Authenticate an instance's coordinator as a GitHub App (#14)
- Run project commands as the agent user; App key install and cutover scripts (#15)
- Service resource limits; doctor checks repo config against the instance policy (#17)
- App key age instead of token expiry; a private /tmp per coordinator service (#18)
- Prompts on stdin, not the command line; agent-run diagnostics and a worktree-commit probe (#19)
- Locks: a stale-lock takeover never removes a fresh lock (#20)
- A 'no change needed' outcome, confirmed by the coordinator's own checks (#22)
- Checks can use git as the agent user; failing checks keep their output; retries judged against the base (#24)
- Worker prompt: the coordinator runs the checks; name the fast tests to run (#27)
- tests.yaml env: a project's own variables for its agents and commands (#28)
- Verify: skip the project's checks once an issue's own check failed (#29)
- Dashboard: only a decision's owner or a writer answers it; costs are today's estimates (#30)
- Engine install ships the dashboard's web UI (#32)
- Dashboard for an instance: --instance, a start script, tunnel docs (#34)
- Dashboard: each issue's check results, with failing output (#35)
- Dashboard: show an emergency stop in force, read-only (#37)
- Dashboard: the coordinator service's log, read-only (#38)
- Dashboard: what each agent run did, recorded by the runner (#40)
- Auto-merge policy: the harness merges its own clean PRs; the rest wait (#42)
- Dashboard hub: every instance in one view, writes through each instance (#41)
- Intake: an edit to a refused issue's done_when gets judged again (#43)
- Dashboard: a visual pass with Beautiful UI's palette and patterns (#44)
- Worker runs that fail at startup are reported with claude's error (#45)
- Dashboard: a control script, a feature map that can't go stale, and a verify skill (#48)
- Runs wait out auth and transient errors, one claude per login at a time (#50)
- Instruction evals: a change to the agents' instructions is evaluated before it lands (#49)
- State files are closed to other users; dashboards.sh refuses ACLs over open ones (#52)
- Health data: check durations, Claude login waits and retries, machine stats (#54)
- Dashboard: stable data-testids on every page and feature, in the feature map (#55)
- Frozen-guard acceptance test: let the other user reach the engine on CI (#60)
- Machine settings through one root-owned helper, not a group-writable file (#57)
- Engine updates from a root timer: fast-forward, green checks, quiet machine, rollback (#59)
- Dashboard: a machine health view (GET /api/health), server side (#53)
- Dashboard: a machine health panel on the overview, and per instance on the hub (#63)
- Dashboard: the instance's settings on the Settings page, owner only (#68)
- Dashboard: machine settings and engine update history on the Settings page (#69)
- Hotspot holds: two tasks that would change the same shared file never run at once (#62)
- Setup: node --check the helpers under a .cjs temp name (#70)
- State: close everything under state/ at start, and drop the old state/tasks/ (#71)
- Combined-state check before an auto-merge: the fast tier on PR + main, only when main touched what the PR touches (#66)
- Updater: required checks are whole names, and only ones a push to main runs (#72)
- Progress notes: mark what the pruning removed, and what has shipped since (#73)
- Off-machine backups: encrypted, and verified by reading the remote copy back (#74)
- Chat engine: chief_of_staff answers from a context bundle, under the login lock; proposals only (#82)
- Core budget: each task's share of the machine's cores, as {cores} in tests.yaml (#83)
- Faster worktrees: a per-instance dependency cache, and a pool of ready worktrees (#84)
- Tuning suggestions from what was measured, as Inbox decisions (#86)
- worklane tune: profile the test suite once and propose worker settings as a PR (#87)
- Dashboard: the chat panel — merge after #82 (#85)
- Merge: hold when a PR changes high-risk or design paths not in its approved plan (#111)
- Settings: a key the repo's config doesn't define says engine default (#93)
- Settings: names, real bounds and an on/off switch for the research rows (#94)
- Direct land: a rejected evaluator verdict holds for the owner (safety floor) (#110)
- Stuck-run guard module and a read-only stuck-scan command (not wired; part of H1) (#112)
- Skill eval CLI: judge opus by default; every call through the runner (#113)
- Compare screenshots: stopping it stops the screenshot run it started (#116)
- Intake design: reports from chat, SMS and in-product forms become issues (#89)
- Intake modules: sources, redaction, caps, triage, drafts and trust, against fakes (#90)
- Settings: a place, a name and bounds for the intake caps (main fails typecheck) (#127)
- Dashboard: a live view of each running agent, with the owner's console (#80)
- Health panel: the off-machine backup, with a red warning when it goes stale (#92)
- Worker contract: stop once done_when passes; at most one full-suite run after the final edit (#131)
- Runs: the owner's and the writers' to read; anyone else gets 403 (#102)
- Run page: a research run's searches and pages (merge after #102) (#96)
- Throughput panel: merges, cost per merged PR by stage, waits, the top costs with a tuning each (#137)
- Rate-limit, budget and auth blocks release the claim; rate-limit and budget blocks retry on their own (#128)
- No silent stalls: pipeline and land errors comment, record and release (#129)
- Emergency stop halts landing and auto-merge (safety floor) (#125)
- Intake page: each report, redacted, and what became of it; its numbers under the health panel (#132)
- Tiered evaluation: the review level picks the evaluator model, in code (#134)
- Unread files from the run record, not the reviewer's own list (#106, modules) (#135)
- Five-part issues: every issue the harness drafts has Outcome, Sources, Constraints, Deliverable and Review point (#136)
- Research on demand: the request, its caps and the brief section (modules) (#138)
- Claims receipts: VERIFIED, NOT VERIFIED and NOT CHECKED in every PR description (#139)
- Role contracts: the shape (Own, Sources, Output, Approval, Failure, Never), enforced over every role; worker and evaluator rewritten (#141)
- Split the coordinator into feature modules under src/coordinator/ (a pure move) (#147)
- Intake: remove SMS; Discord is the only chat source, one server, no DMs (#148)
- Waiting on you: every owner-held state, how long it has waited, its daily digest's Markdown, and a page (#142)
- Report preview: the owner's and the writers'; throughput in the preview only, never posted (#143)
- Role contracts: investigator and evaluator-repro in the contract shape, with eval cases (#145)
- Role contracts: the researcher in the contract shape, with eval cases (#146)
- Role contracts: the chat role (chief_of_staff) in the contract shape, with more eval cases (#149)
- Role contracts: the planner in the contract shape, with eval cases (#154)
- Role contracts: intake in the contract shape, with eval cases (#153)
- Browser checks, 1/5: .worklane/app.yaml (start, UI paths, thresholds, flows), strict and off when absent (#155)
- Browser checks, 2/5: run a project's flow (localhost only), shared DevTools driver (merge after #155) (#163)
- Browser checks, 3/5: the browser: check, with thresholds and a baseline (#166)
- Intake: Discord allowed senders; anyone else is dropped before anything is stored (#161)
- Browser checks, 4/5: the UI-paths gate (#170)
- Evaluator: tiered model by review level, one escalation, unread from the run record (#156)
- Review: big-PR limits default to 800 lines / 20 files (#158)
- Coordinator: post the daily "waiting on you" digest to one issue (#160)
- Research on demand: a worker's or evaluator's research request is answered and its task resumes (#169)
- Stuck-run guard wired in: dry-run by default, run.stuck events, a stuck stop is a failed attempt (H1) (#167)
- Earliest-failed-stage labels, wired into the weekly report: code labels first, capped judge calls, one event per label (H3) (#174)
- verify(): an unknown done_when kind fails the attempt instead of being skipped (#157)
- Browser checks, 5/5: evidence for the PR description and the claims receipts (#176)
- Browser checks, wired: verify() runs them, the PR shows them, a contract may ask (#183)
- Gradual delegation, suggest-only: a clean waiting category is put to the owner, never loosened automatically (#172)
- Caps on the coordinator's waits: deferred landing, mergeable rechecks, a pending light check, main checks after an auto-merge (#179)
- Digest: list an auto-merge whose checks on the merge commit never reported (after #179) (#192)
- Conflict give-up asked once per PR head; light checks debounced (#165)
- Deploy events name their issue; a failed deploy can be requeued; PR-mode tasks show as in review (#173)
- Redact what the harness writes to the backlog: comments, issues, pull requests (#162)
- Role contracts: no exceptions (merge after #153) (#159)
- evaluator-repro: run the test with the configured runner; it must be collected and fail on an assertion (#193)
- Browser checks: robust on a loaded machine (scalable timeouts, one restart, no leaks) (#219)
- Portability: setup and hardware assumptions detected or configurable (#212)
- Agents billed to an API key on the hardened path, through apiKeyHelper (#206)
- Model routing: haiku, sonnet or opus per kind of run; builds escalate after two failed attempts; the instance may cap (#209)
- Open-model providers: local and hosted models in model routing; keys only through apiKeyHelper; eval-gated, opt-in (#215)
- Releases: signed tags, a changelog, and an updater that follows verified releases (#205)
- Migrations: versioned config and state steps, doctor lists them, migrate applies them, the coordinator refuses to start until done (#208)
- Quick start: a bootstrap for a fresh Mac or Linux machine, a Docker image, and a CI job that runs both (#207)
- Stale docs and package contents: ship examples/basic; match design.md to the code (#204)
- Runner: role prompt file readable by the agent user under the service umask (#220)
- A held issue closed by hand on GitHub stops waiting on the owner (#223)
- Setup: offsite-backup.sh for Backblaze B2 with age (#224)
- Dashboard: viewers get an allowlist of the event log and the project part of the settings (#225)
- Machine changes from the dashboard: recorded by the dashboard, run by the coordinator (no sudo under NoNewPrivileges) (#227)
- Owner terminal: only from the owner's Tailscale devices (console_devices), identified by Tailscale (merge after Batch 6) (#221)
- Dashboard: the Board as home (stages across instances, role-checked inline actions) and a Machine page (merges after Batch 6) (#226)
- Batch 8: test runs, PR batching, Discord, logo, Ubuntu-only CI (#243)
- test-user.sh: Docker unit PATH has /usr/sbin and /sbin; check runs the helper as root (#244)
- Test runs: keep systemd-run's summary apart from the run's output; a CI job on real systemd (#246)
- Test runs: rootless Docker's containers get cgroups inside worklane-test.slice; CI starts a real database (#247)
- Test runs: each instance's state dir is root:<its test user> 0710 (#248)
- test-user.sh install: restart the test Docker unit when its unit changed or it's in the old layout (never under a run) (#249)
- Dashboard: an instance's pages get only its items; All instances is an explicit choice (#252)
- Test runs: test_run.database.max_connections (20..2000, default 200) (#250)
- land_mode direct only on a protected default branch (#254)
- Decisions: a recommendation is an option (the pill) or wrapped prose with Show more (#256)
- Machine owners: only they change the machine, freshly signed in from an allowed device (#258)
- GitHub Apps through the manifest flow: the agent App and the sign-in App (#259)
- Discord chat and thread questions: answered as they arrive, typing until the reply, not behind agent runs (#260)
- Setup console: Add project, and the first machine owner at install (#261)
- Discord as the owner's complete channel: L3 approvals, setup links by DM, one bot for several instances (#265)
- Trust, measured: per-instance DORA-style numbers, the Trust panel and a weekly digest (read-only) (#272)
- Usage-limit pause: pause on the Claude limit, requeue, one notice, resume at the reset; banner and usage line (#274)
- Push gate: allow the repo owner in GitHub's merge subject; scan only a PR's own commits (#281)
- main watch: judge a merge by the required_checks in force at it (#280)
- Main watch: an admin accepts a hand merge as a bootstrap merge (#273)
- Intake: production alerts as a second read-only prod-read query (owner merges) (#267)
- Watchdog and Health page: incidents posted once to the ops channel, per-instance status dots (#268)
- Self-modification guard: the harness's own controls always wait for the owner (owner merges) (#269)
- Canary tied to auto-update: rollback on a failed canary, and the Updates panel (#270)
- Claude account switch: claude-account.sh switch|status, and a machine-owner panel (owner merges) (#271)
- Guided init with --mode local|server: one resumable checklist, in doctor and on a First-run page (#278)
- export / import: move an instance's config and history to a server, one file, no ssh (#279)
- Plans cite decisions: a Decisions section, checked by the plan contract and at plan review (#276)
- Tests: a leak marker number matches only as a whole number (#286)
- Config follows the default branch: loaded from git when main moves, validated, swapped in whole (#285)
- CI: local mode end to end on Windows, inside WSL2 (bootstrap (windows-wsl)) (#287)
- Watchdog: the Claude sign-in probe looks in the agent user's home (#289)
- Init: auto-config drafts the repo's config, checks it on main, proposes it as a PR (#290)
- Shutdown on SIGTERM: abort and requeue work in flight, exit within 20 s; a stopping watchdog stays out of the election (#291)
- Branch protection: not strict by default, strict is a per-repo opt-in (#294)
- Test runs: helper protocol version; updater keeps root helpers in step; setup failures in the check (#293)
- CI: fast checks on PRs, every job on main; the updater waits on all of them (#295)
- Merge train: up to land.parallel_merges green PRs merge per pass, no merging main in first (#296)
- Pre-deploy gate: a deploy branch fast-forwarded only to green main commits (#297)
- Push gate: a sign-off with the commit's own email is inherent to it, name included (#300)
- CI: the unit tests in 4 shards per Node version, behind the same required names (#298)
- Post-deploy check: smoke-test production after a deploy, roll back on failure (#303)
- Updater: one red main tip no longer blocks updates (newest green first-parent commit) (#301)
- Tests: example repos run no background git maintenance (#307)
- Merge posts: every merge to main posted once in the Discord ops channel (#304)
- Server setup: the App written in for you, auto-config's setup PR, waiting not failing, init's true status (audit B3-B7) (#306)
- Release prep: v0.5.0 (version and changelog) (#311)
- Main watch: a commit on main without a PR is posted to the ops channel at once, mentioning the owners (#299)
- Test runs: a PR older than the test-run config says so; every tier check shows its last lines (#310)
- Main watch: a merge GitHub hasn't linked to its PR yet is judged by the PR its subject names (#315)
- Flaky tests: re-run a red main's failing checks on the same commit first; quarantine what passes (#302)
- Deploy gate: an explicit off switch, deploy_gate.enabled (default false) (#308)
- Stale PRs: merge main into old agent PRs, hand conflicts on, close abandoned ones (item 19) (#316)
- Dashboard on a phone: nav drawer from a menu button; every page fits 390 px with 44 px tap targets (#317)
- Roles: no defenses for hypothetical concerns (item 11) (#322)
- Test selection: PRs run only the tests their change can affect (CI and test_run.select) (#319)
- Review rules: PR intent and risk class, a size limit, a docs-only fast path (item 10) (#314)
- CI: slow checks in 30-minute batches on main, a red batch bisected (item 24) (#313)
- CI: timings for the 24 test files added since the last measurement (main red at 7e13344) (#329)
- Feedback routing: CI failures, conflicts and reviews go back to the session that wrote the PR (item 29) (#328)
- First run: a live checklist of every setup step, one registry for doctor, init and the page (#305)
- Weekly optimization pass: PR only for a measured gain beyond the noise (item 20) (#323)
- Test runs: one object store per instance, each run sent only what it lacks; sparse_exclude in run workspaces (items 12, 16; helper protocol 3) (#327)
- Main watch, merge posts: PR facts from the GitHub API, not commit history (item 17) (#336)
- Test runs: shell-only variables in a tier command reach bash, not systemd-run (helper protocol 4) (#339)
- Loop control: attempt cap from agents.yaml (default 8), reflection before each retry, reassign after 3 identical failures, per-issue budget (item 31) (#338)
- Checks from repeated feedback: twice-seen constraints become a draft ast-grep rule or test PR (issue for protected areas) (#325)
- Intake: GitHub issues as a source, off by default (item 37) (#342)
- Previews: a Railway environment per open PR, off by default (item 35) (#346)
- Plan gate: size:M/L plans, with acceptance criteria, wait for an owner's approval before any code (item 30) (#334)
- Model routing: one routing section keyed by task type, old keys as aliases, read-only Settings panel (item 32) (#340)
- First run, tools and hooks: install tools, hooks, git hooks and fingerprints from the page (wizard screen 10) (#344)
- Superfans: a watcher per instance and one for the engine, posting only what is new or odd (#324)
- Task graph: Depends on holds, plan files as per-task file ownership (item 34, parts 1-2) (#347)
- Setup: a self-hosted CI runner for trusted jobs only (ci-runner.sh) (#348)
- Test runs: a short TMPDIR of each run's own, so Chrome's SingletonSocket fits (helper protocol 5) (#355)
- discord channels: list the bot's channel ids, read-only, for superfan setup (#354)
- Runners: Codex and Gemini CLIs behind AgentRunner, opt-in for easy builds only (item 38) (#345)
- Goal split: a goal issue becomes child issues with Depends on edges (item 34, part 3; stacked on #347) (#351)
- One command, one URL: the install ends with the first-run wizard's URL, no key in it (local and server) (#357)
- Push gate hook: load the gate and its rules from origin's default branch on every push (#368)
- CLI: silence node:sqlite's experimental warning, and only that one (#369)
- Test runs: a run's TMPDIR off /tmp, so the helper works from inside the coordinator's unit (helper protocol 6) (#373)
- ci batch: start a batch when the fast checks finish on main or a batch ends, not only on the schedule (#363)
- CI shards: a test file with no timing is a warning, never a failure; timings for the 26 untimed files (#379)
- updater: say why it is waiting on every run; don't wait on a commit with no batch and nothing in flight (#364)
- intake check: validate an instance's intake.yaml on demand, and in doctor (#376)
- updater: alert when the engine has been on one commit for 2 hours while main moved on (#367)
- testrun measure: time one test_run env value per sandboxed run, in sequence, with no check and no PR (#386)
- GitHub's hosts are constants: remove the WORKLANE_GITHUB_API / WORKLANE_GITHUB_WEB override (#381)
- Test runs: a tier stopped at its own cap says it timed out, naming the tier and the cap (#385)
- updater: redact everything written to updates.jsonl, update-state.json and update-held.json (#389)
- Test runs: no value of a run's variables in any argv, the journal or the unit (helper protocol 7) (#388)
- Children get no host-redirect variable; an outbound proxy only from root's network.json (#381 follow-up) (#391)
- CI: the argv canary step records every docker call, so the old helper's password leak is caught on every run (#395)
- Children get no inherited TLS trust variable; a custom CA only from root's network.json (#391 follow-up) (#396)
- CI: real TLS handshakes through root's CA for both CLIs on a real unit, refused without it (#396 follow-up) (#397)
- A full disk never kills the coordinator: events wait in memory, new work pauses, disk_full is raised, and it resumes on its own (#398)
- Dashboard: owners-only mic in the Ask panel, off by default, on-device only, never sends (#404)
- Dashboard: owners-only talk-back in the Ask panel, off by default, on-device voices only (#405)
- One start gate in front of every test run: the disk floor and disk_full hold all six paths, through a list of refusal sources (#406)
- Dashboard: an owners-only wake word, "hey <product name>", off by default, on-device only, no model bundled (#408)
- Stage labels: plan and review from the run's trace, with their evidence in the Reports stage section (#409)
- Dashboard: a goal's task graph on its page, read-only, from the split and task-graph.ts (#410)
- Viewer state test: a sentinel run cost and a walk for cost-shaped fields, not the text 1.25 (#412)
- Real-Chrome click helper: wait for the target to stop moving, and hit-test the point before pressing (#413)
- Runner probe: fetch https://github.com/, not GitHub's rate-limited unauthenticated API (#419)
- Real-Chrome tests: one Chrome at a time across test files (main red on 6a30f66) (#420)
- Updater: drain a machine that is never quiet, install once in-flight runs finish, reopen on every exit (#407)
- Reland #416 with control-dashboard starting Chrome through the engine's launchChrome (#422)
- First run wizard: screens 2-11, integrated (#380)
- Voice intake and spoken approvals: owners only, off by default, a 10 s spoken or clicked confirm (#411)
- Real-Chrome lock: appear whole with its owner; take over a dead owner's only under a guard (main red on 729b51e) (#426)
- docs: getting started around the one install command and the first-run wizard (#423)
- docs: a short, current README; voice intake and approvals in getting started (#427)
- cli: drop the npx hint from --help until the package is on npm (#428)
- updates.sh --add-check: add required checks to an existing updates.json (#424)
- live config: resolve a stale config_invalid when the coordinator starts on a valid config (#432)
- Hub: keep a down instance listed (as down) while the person's role copy is fresh (#434)
- Dashboard truth: current coordinator errors with time, local-day today, grey dot for an unread status, hub list refreshed (#433)
- Dashboard reads wait out an event-log lock (no 500); phone test waits for the status dot it checks (#437)
- Coordinator start: wait out an event-log lock, never exit 2 (wizard Start read 'activating'); stacked on #437 (#438)
- Updater: a slot pid below 2 is no holder, so a corrupt slot file can't hold updates off for good (#439)
- ci-runner: deny /var/lib/worklane-test to the runner user by ACL, as the other worklane paths (#440)
- github_auth resolves once GitHub works again; not reaching GitHub is amber; App token mint gets a timeout (#430)
- Tests run clean beside a live install: temporary home/state/slots, held ports, no pid <= 0 (#436)
- Dashboard speed (server): incremental event reads, one-pass Board/trust, compression, year-cached hashed assets (#442)
- Package (0.5.0): installed-tarball run test, size budget; doctor/dashboard --help print usage (#443)
- Dashboard speed (client): switches from cache, prefetch, code split; a real-Chrome speed test gates cold load < 3 s and switches < 300 ms (#445)

### Fixes

- Site-type instance fixes: review categories, service unit, pinned gitleaks, agent-user check (#16)
- Dashboard: a pull requests page (checks, fix runs, merge calls, auto-merge state) (#46)
- Dashboard: three fixes from verification (recommended option, hub probe, PR wait reasons) (#51)
- Reports: how runs ended each week, the commonest causes, and fixes to decide on (#47)
- Instance settings: the operator's policy wins for workers, budget, CI fix runs and run windows (#58)
- Reports: weekly fixes for repeated failures go to the owner's Inbox, once (#61)
- Conflict fix runs: a conflicting harness PR gets its base merged in and the hunks resolved (#64)
- Merge metrics: what conflict fixes, combined-state checks and hotspot holds cost per merged PR (#65)
- Weekly report: what conflict fixes, combined-state checks and hotspot holds cost (#67)
- Updater: bin targets executable, a rolled-back commit held, crash loops caught early (#78)
- Queue test: wait for the job to finish, not a fixed deadline; add a test under load (#91)
- Dashboard: conflict fixes, light checks and hotspot holds on the PRs page and in the health panel (#77)
- Attempt caps survive restarts and requeues; a lost-claim fix run counts (#126)
- Chat: a running summary under fixed headings instead of the transcript (#140)
- Intake: the casual replier role, with every reply checked in code and a fixed-reply fallback (#168)
- Corrections become durable rules: each writer correction gets the strongest durable fix, once (#164)
- The gardener: a weekly off-hours read-only scan, one log issue, fixes only for patterns seen 3+ times (#178)
- Test-run helper and test-user.sh: fixed PATH with sbin, clear "missing tool" errors (#245)
- Dashboard auth: drop the fresh sign-in; fix the terminal's CSRF over WebSocket and the device on machine views (#292)
- Metrics: merges per day, main red, time to green, fix-forward vs revert, PR CI wall-clock, agent startup, flake rate and the slowest tests (items 9, 27) (#318)
- Fix forward with culprit finding (items 2 and 8) (#337)
- Fix red main: ownership tests under #334's default plan gate (item 34) (#358)
- Harness evals: fixed past tasks replayed through the real coordinator, weekly and on src/ changes (item 36) (#335)
- Release notes for v0.5.0: every PR since v0.4.1, highlights and upgrade notes (changelog tool fixed) (#429)

### Security and guardrails

- Run project commands under bash with pipefail (#1)
- Release 0.4.1 (lock race and pipefail fixes) (#7)
- Sandbox agents per lane with Claude Code's native sandbox (#9)
- Durable slot locations; repo-scoped GitHub credentials only (#10)
- Stage 3: remove unproven features; partial-review refusal; emergency stop; credential setup (#12)
- Keep the sandbox's empty mount points out of worktrees and commits (#21)
- Agents commit with one harness identity (the App's bot), never one they pick (#25)
- Sandbox placeholders: cover all of .claude/; keep the exclude block current (#26)
- Setup: check the App token's permissions, and verify an installed App read-only (#33)
- Push limits: every push of agent-written code is checked first (#31)
- PR watch: drafts until required checks pass on the evaluated commit (#36)
- CI fix runs: a failed required check on a harness PR gets a bounded fix (#39)
- Frozen-test guard: task files the agent can read, and a hook that fails closed (#56)
- Unknown domains: a refused host becomes the owner's decision, never a silent failure (#79)
- Plan mode for size:M/L: plan read-only first; high-risk or design-level plans wait for the owner (#81)
- Researcher: web-only research runs, no repo access by default, daily caps (#75)
- Research runs: start them for research issues, record every search and fetch, stop at the cap, post the report (#88)
- Post-edit check hook: a fast one-file check after each agent edit, findings back to the agent (H2) (#109)
- Intake: caps as instance settings, credentials for the sources, a guarded intake.yaml (#95)
- Intake in the coordinator: pull, redact, cap, triage read-only, file or ask, reply (merge after #95) (#108)
- Exactly-once intake and chat: dedupe by message id, arrival order, crash recovery that never reruns (merge after #108) (#114)
- Intake: the bug-store cursor moves only past rows that are recorded (merge after #114) (#115)
- Skill lint: every SKILL.md has When to use, Inputs and access, Steps, Validate, Return and Approval (#133)
- Denylist: allow the owner's handle in .worklane/config.yaml (#177)
- Guardrail hooks for an instance's agent runs only (no .claude/settings.json in the repo) (#175)
- Evals: held-out cases per role, written by a separate agent; the held-out score decides (#191)
- Dashboard: per-person sign-in with GitHub; role per instance from repo permission; token only as the owner's break-glass (#213)
- Setup console: asks (secrets, links, questions, root steps) and the owner terminal (merge after #197) (#210)
- Unprotected default branch: never push it, watch every commit on it, batch people's PRs (#251)
- Discord: decision threads in plain language, and chat channels (#253)
- credentials.sh dashboard-signin: set $dir before the line that names it (#255)
- npm release path: npx init from the package, and a release workflow (dry run until npm is set up) (#288)
- Learnings: per-task failure notes grouped on Reports; owner promotes one to AGENTS.md as an L3 PR; agents never write AGENTS.md (item 33) (#343)
- Test runs: a failed sandbox check at start never silently switches test runs off (journal, alert, retry) (#375)
- Guardrails: agents never use the push gate's first-time-setup hatch or swap the pre-push hook (#378)
- updater: roll back when an instance's test sandbox check passed before an update and fails after it (#372)

### Reverted in this release

- CI: build the dashboard UI before each shard's tests, and fail a web-UI test that would skip there (#416): reverted by #421

### Guardrail changes

- Run project commands under bash with pipefail (#1): src/guardrails/context.ts
- Release 0.4.1 (lock race and pipefail fixes) (#7): src/guardrails/context.ts
- Sandbox agents per lane with Claude Code's native sandbox (#9): src/sandbox.ts
- Stage 3: remove unproven features; partial-review refusal; emergency stop; credential setup (#12): src/hook.ts
- Agents commit with one harness identity (the App's bot), never one they pick (#25): src/guardrails/engine.ts, src/guardrails/shell.ts
- Push limits: every push of agent-written code is checked first (#31): src/push-check.ts, templates/project/guardrails.yaml
- PR watch: drafts until required checks pass on the evaluated commit (#36): src/push-check.ts, templates/project/guardrails.yaml
- CI fix runs: a failed required check on a harness PR gets a bounded fix (#39): src/push-check.ts, templates/project/guardrails.yaml
- Frozen-test guard: task files the agent can read, and a hook that fails closed (#56): src/hook.ts
- Unknown domains: a refused host becomes the owner's decision, never a silent failure (#79): src/guardrails/engine.ts, src/hook.ts, src/sandbox.ts
- Plan mode for size:M/L: plan read-only first; high-risk or design-level plans wait for the owner (#81): src/guardrails/engine.ts, src/hook.ts, src/sandbox.ts
- Researcher: web-only research runs, no repo access by default, daily caps (#75): src/hook.ts
- Research runs: start them for research issues, record every search and fetch, stop at the cap, post the report (#88): src/hook.ts
- Post-edit check hook: a fast one-file check after each agent edit, findings back to the agent (H2) (#109): src/hook.ts
- Intake in the coordinator: pull, redact, cap, triage read-only, file or ask, reply (merge after #95) (#108): src/hook.ts
- Exactly-once intake and chat: dedupe by message id, arrival order, crash recovery that never reruns (merge after #108) (#114): src/hook.ts
- Intake: the bug-store cursor moves only past rows that are recorded (merge after #114) (#115): src/hook.ts
- Skill lint: every SKILL.md has When to use, Inputs and access, Steps, Validate, Return and Approval (#133): src/push-check.ts
- Guardrail hooks for an instance's agent runs only (no .claude/settings.json in the repo) (#175): src/guardrails/engine.ts, src/guardrails/shell.ts, templates/project/guardrails.yaml
- Evals: held-out cases per role, written by a separate agent; the held-out score decides (#191): src/hook.ts
- Unprotected default branch: never push it, watch every commit on it, batch people's PRs (#251): src/push-check.ts
- Discord: decision threads in plain language, and chat channels (#253): src/hook.ts
- npm release path: npx init from the package, and a release workflow (dry run until npm is set up) (#288): src/scan/secrets.ts
- Learnings: per-task failure notes grouped on Reports; owner promotes one to AGENTS.md as an L3 PR; agents never write AGENTS.md (item 33) (#343): src/guardrails/engine.ts
- Guardrails: agents never use the push gate's first-time-setup hatch or swap the pre-push hook (#378): src/guardrails/engine.ts, src/guardrails/push-hook.ts
