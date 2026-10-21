# Releasing

How a version reaches npm: the owner signs a tag, CI (`.github/workflows/release.yml`) checks the tag's signature against `.github/release-signers` on main and **stages** the version (`npm stage publish`, with provenance), and the owner approves the staged version on npmjs.com with 2FA. CI never publishes and never moves a dist-tag. The repo variable `NPM_PUBLISH=true` is the switch; without it every run is a dry run.

## Checklist

1. **Main is green** on the commit to release, and the release machine's preflight (`npm test` in a terminal) passes on that commit.
   - **That commit has the release's changelog and version bump.** On a branch from main: `node scripts/release.mjs changelog X.Y.Z` and bump `package.json` to X.Y.Z, then review and merge them in one PR, with the fragment deletions the step makes (`git add CHANGELOG.md changelog.d package.json`). The release's hand-written notes are the `changelog.d/<n>-<slug>.md` fragments, one per change (changelog.d/README.md); CHANGELOG.md holds only released sections. The changelog step writes `## vX.Y.Z (YYYY-MM-DD)` with every fragment's lines, verbatim, under the fixed headings in their fixed order (fragments by number), then the PR lists, and deletes the fragments it used. It writes and deletes nothing when a fragment line could be dropped or moved (an unknown heading, a `#` or `##` line, an empty fragment, text before the first heading), or when CHANGELOG.md already has a section for X.Y.Z (to pick up fragments merged since, start the branch again from main). A rerun with no fragments left keeps the section's notes and rewrites the lists. The tag step (step 4) refuses a version whose section isn't in the form that step writes: an `(unreleased)` heading or any heading other than `## vX.Y.Z (YYYY-MM-DD)` with a real date, no generated lists (`### Guardrail changes`), or a second section for the version (`## Unreleased` included).
2. **npm trusted publisher.** On npmjs.com, `@worklane/cli` → Settings → Trusted publishing: the publisher for this repo's `release.yml` (no environment, staging only) shows as validated. If it is still "Pending validation" past its deadline, or has lapsed, remove it and add it again before pushing the tag. (The current one is pending until 2026-10-17 10:18 UTC and is validated by one `release.yml` stage publish. Don't create a release just to validate it.)
3. **The signing key** is the one in `.github/release-signers`. Before building, probe that it signs and verifies:
   ```sh
   echo probe > /tmp/probe && ssh-keygen -Y sign -f <your key> -n git /tmp/probe
   ssh-keygen -Y verify -f .github/release-signers -I release-signer -n git -s /tmp/probe.sig < /tmp/probe
   ```
4. **Cut it** in a clean, detached checkout at that commit: `node scripts/release.mjs X.Y.Z`. It verifies the tag against the checkout's `.github/release-signers` (what CI checks), or your `gpg.ssh.allowedSignersFile` when the repo has none, and refuses before building when it can verify against neither. It ends with `vX.Y.Z: signed and verified`; on any failure after tagging (a bad signature, Ctrl-C) it deletes the tag and exits non-zero.
5. **Push only behind the verify**, as a separate step, never batched after `release.mjs`:
   ```sh
   git tag -v vX.Y.Z && git push origin vX.Y.Z
   ```
   Push only after `release.mjs` has printed `vX.Y.Z: signed and verified`. A failed run leaves no tag (#457); if one is there from an older run, check it isn't pushed, then `git tag -d vX.Y.Z` (the script refuses to tag over it).
6. **Watch `release.yml` on the tag:** the build, npx-init, the tag check (`verify the release tag`) and `npm stage publish`.
7. **Approve** the staged version on npmjs.com (`@worklane/cli` → Staged Packages) with 2FA, then check:
   ```sh
   npm view @worklane/cli version dist-tags
   ```
8. **Pin the bootstrap** for its PR: `node scripts/pin-engine.mjs vX.Y.Z --allowed-signers .github/release-signers`.
9. **After it installs on each release-channel machine** (the updater takes the new tag): when the release changes the machine helper's sudoers rules, rerun them as root, once, with every instance on that machine. Until then, coordinators can't run the helper's new commands (sudo refuses them), and nothing else changes. Not before the install: the rules must match the installed helper.
   - **To tell whether a machine needs it, and which command:** `sudo bash /opt/worklane/current/scripts/setup/machine-helper.sh --check`. It only reads, and answers one of:
     - `current` or `absent`: nothing to do;
     - `stale`: the installed rule is in the engine's own shape and the rewrite only drops whole commands or users, so it needs no flag: `sudo bash /opt/worklane/current/scripts/setup/machine-helper.sh <every instance>`;
     - `wider`: anything else (the engine's rule grants more, or the installed rule isn't in its shape), so it needs the flag: `sudo bash /opt/worklane/current/scripts/setup/machine-helper.sh --replace-sudoers <every instance>`.
   - **The owner's rule (#898):** nothing rewrites the rule on its own unless the result is narrower than or equal to what is installed, and that check fails closed. A rewrite happens on its own only when the installed rule is in the engine's own exact shape (comments, one `Cmnd_Alias WORKLANE_MACHINE`, one `<users> ALL=(root) NOPASSWD: WORKLANE_MACHINE` line) and the engine's rule only drops whole commands or users from it. The one user it adds on its own is the coordinator of an instance being created: `instance.sh` marks it on root's list, and every `machine-helper.sh` run unmarks the names it writes. Otherwise `machine-helper.sh`, `add-project.sh`, `instance-remove.sh` and `instance-rename.sh` change nothing, and `--check` says `wider`. That covers a command or user the installed rule lacks, and any other line, tag, Defaults, include, negation or escape in it. They print a unified diff headed `--- installed /etc/sudoers.d/worklane-machine` and `+++ engine (machine-helper.sh)`, then `rerun as root with --replace-sudoers to install the engine's rule: <command>`. Read the diff, then run that command. Only root, at a root shell, can pass the flag: the machine helper runs `add-project.sh` with exactly a name and a repo.
   - **The updater** runs `--check` every run and names a stale or wider rule in its journal and as a `machine_sudoers_stale` incident, with the command for the case. A rerun of `add-project.sh` rewrites a stale rule itself, and waits on a wider one.
   - **0.5.1:** yes. It adds the Claude account profile commands (`claude-account profile-add|remove|use <profile>`, `failover … back|stay`, and `login <profile>` if #495 is in).
   - **0.5.3:** yes (set-policy, #726). It adds `set-policy`'s pattern (sudo 1.9.10 or later) and `set-policy auto_merge off`, `land_mode pr` and `main_watch auto` listed whole on every sudo: rerun with every instance after the install, with `--replace-sudoers`, since this widens the rule (`--check` says `wider`). The same rerun drops every `claude-account` rule but `status` (#758): `switch`, and the six patterns for `profile-add`, `remove`, `use`, `login` and `failover … back|stay`. The updated helper refuses each of them already (#749, #736), so until the rerun those lines grant nothing; the rerun makes the rules say so. Its other root steps are in v0.5.3's "After install" notes (changelog.d until the changelog step moves them into CHANGELOG.md).
10. **GPU test runs, after it installs on a release-channel machine that has an NVIDIA GPU** (0.5.1 adds the `worklane-gpu` group): if you'll use `worklane gpu hold`, make yourself the GPU lock's holder once, then log in again: `sudo bash /opt/worklane/current/scripts/setup/testrun-gpu.sh holder <your user>`. Not before the install. Turning GPU runs on for an instance (`testrun-gpu.sh enable …`) is separate, and needs the owner's go per machine.
   - **Then close the GPU to everyone else** (docs/test-runs.md "GPU devices"; the nodes are `root:root 0666` until this runs), as root, once: `sudo bash /opt/worklane/current/scripts/setup/gpu-devices.sh check` (says FAIL; note who has a node open) → `sudo bash /opt/worklane/current/scripts/setup/gpu-devices.sh apply --users <your user>` (`--no-dynamic-nodes`, only on a GPU that doesn't run MIG, leaves `/dev/nvidia-caps` empty; it does not stop a root NVML call such as `sudo nvidia-smi -L` putting `nvidia-uvm` and `nvidia-uvm-tools` back to `root:root 0666`, measured in #583, corrected 2026-10-19) → `sudo reboot` (not a driver reload) → `sudo bash /opt/worklane/current/scripts/setup/gpu-devices.sh check` **before touching anything** (must say PASS, with the `nvidia_uvm` module loaded and you, a member, opening `/dev/nvidia-uvm`) → `id <your user>` lists `worklane-gpu-dev` (log in again if a session doesn't have it). A FAIL after a boot is a bug to report, not something to fix by hand each time: `sudo /usr/local/libexec/worklane-gpu-devices` only sets the nodes back for now. After any root NVML call (with `--no-dynamic-nodes` too), run `sudo /usr/local/libexec/worklane-gpu-devices`, then `check`, until #583's fixer lands.
   - **Already applied on 0.5.1:** 0.5.2's `apply` adds a boot unit (`worklane-gpu-devices.service`) and drop-ins for `nvidia-cdi-refresh.service` and `nvidia-persistenced.service`, so rerun `apply --users <your user> [--no-dynamic-nodes]` as root once after the install, `sudo reboot`, then `check` before touching anything. It adds no sudoers rules, so there is no machine-helper rerun for it (step 9). It refuses while another `modprobe.d` file sets `NVreg_DeviceFile*` or `NVreg_ModifyDeviceFiles`: remove that file first.
11. **Test-run network, before it installs on a machine whose instance runs test runs** (0.5.1: a run's commands have no network, and its database is a Unix socket, docs/test-runs.md "Network"). No root step: the updater installs the new helper. But a project whose `tests.yaml` `test_run.setup` installs from the network (plain `npm ci`) fails every run after the update until its config changes, on main:
   - npm with a lockfile of registry packages: add `fetch: [{ npm: <its npm cache's name> }]` (a cache with `env: npm_config_cache`) and make the step `npm ci --offline`;
   - anything that can't be split (git or workspace packages, another package manager): root grants it, per instance, `sudo bash /opt/worklane/current/scripts/setup/testrun-network.sh enable <name> --tiers setup`, and the config sets `setup_network: true`;
   - a tier that needs the network itself: `network: true` on it, and root's `--tiers` names it too. Each grant needs the owner's go.
   - a database client that only takes a host and port (not a socket directory in `host=`) needs changing too.
12. **Voice and Siri removed (#743), on every server machine after it installs.** Nothing listens and nothing is taken once it installs. Every server instance had a Siri gateway token (Siri on or not): each instance's dashboard deletes its own token and device store when it starts on this version. Then, as root, `worklane doctor`: under "voice and Siri removed" it fails, naming each leftover, until they are gone, and finds nothing on a machine that never used voice or Siri once each instance's dashboard has restarted. On a machine that did (the hub unit `/etc/systemd/system/worklane-dashboard-hub.service` has `--siri-port`, or an instance's `intake.yaml` has `voice:` or `siri:`), once:
   - root: `sudo bash /opt/worklane/current/scripts/setup/tailscale.sh unserve-siri` (takes the 8443 forward away; 443 and 8444 are untouched; done already when there is none);
   - root, when the hub unit has `--siri-port`: the `dashboards.sh` rerun doctor prints (it drops the option and deletes any Siri files an instance still has; the `--siri` it passes is accepted and ignored);
   - each instance's `intake.yaml`: delete its `voice:` and `siri:` sections;
   - ideas spoken before the upgrade and never taken, in an instance's `state/voice/inbox/` (doctor names them): read them, file any you want, then delete `state/voice/`;
   - in the Tailscale admin console: delete the tailnet ACL rule for port 8443, and remove the two Shortcuts from the phone.

## Publishing by hand

Only if CI can't stage it. Publish only the signed tree: in a clean checkout of the tag, build and pack, and stop if the tarball isn't the tag's commit byte for byte (what `release.yml` checks before staging, #458):

```sh
git tag -v vX.Y.Z && git checkout --detach vX.Y.Z
npm ci && npm run build && npm run build:web
git status --porcelain -- dist/src dist/web    # must print nothing
npm pack --pack-destination /tmp/release-pack
node scripts/verify-release-tree.mjs /tmp/release-pack/*-X.Y.Z.tgz --commit vX.Y.Z
```

Publish that tarball (`npm publish /tmp/release-pack/<file>.tgz`), never a rebuild made after the check.

## Rotating the release key

`.github/release-signers` is in ssh-keygen's allowed-signers format, one key per line under the principal `release-signer`. CI reads it from main, never from the tagged commit, and a change to it always waits for the owner (src/review.ts). To rotate: add the new key's line in a PR, sign the next tag with it, then remove the old line in a later PR.
