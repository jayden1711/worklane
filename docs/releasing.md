# Releasing

How a version reaches npm: the owner signs a tag, CI (`.github/workflows/release.yml`) checks the tag's signature against `.github/release-signers` on main and **stages** the version (`npm stage publish`, with provenance), and the owner approves the staged version on npmjs.com with 2FA. CI never publishes and never moves a dist-tag. The repo variable `NPM_PUBLISH=true` is the switch; without it every run is a dry run.

## Checklist

1. **Main is green** on the commit to release, and the release machine's preflight (`npm test` in a terminal) passes on that commit.
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
9. **After it installs on each release-channel machine** (the updater takes the new tag): when the release changes the machine helper's sudoers rules, rerun them as root, once, with every instance on that machine: `sudo bash /opt/worklane/current/scripts/setup/machine-helper.sh <every instance>`. Until then, coordinators can't run the helper's new commands (sudo refuses them), and nothing else changes. Not before the install: the rules must match the installed helper.
   - **0.5.1:** yes. It adds the Claude account profile commands (`claude-account profile-add|remove|use <profile>`, `failover … back|stay`, and `login <profile>` if #495 is in).
10. **GPU test runs, after it installs on a release-channel machine that has an NVIDIA GPU** (0.5.1 adds the `worklane-gpu` group): if you'll use `worklane gpu hold`, make yourself the GPU lock's holder once, then log in again: `sudo bash /opt/worklane/current/scripts/setup/testrun-gpu.sh holder <your user>`. Not before the install. Turning GPU runs on for an instance (`testrun-gpu.sh enable …`) is separate, and needs the owner's go per machine.
   - **Then close the GPU to everyone else** (docs/test-runs.md "GPU devices"; the nodes are `root:root 0666` until this runs), as root, once: `sudo bash /opt/worklane/current/scripts/setup/gpu-devices.sh check` (says FAIL; note who has a node open) → `sudo bash /opt/worklane/current/scripts/setup/gpu-devices.sh apply --users <your user>` (add `--no-dynamic-nodes` on a GPU that doesn't run MIG: NVML then changes no node, and `/dev/nvidia-caps` stays empty) → `sudo reboot` (not a driver reload) → `sudo bash /opt/worklane/current/scripts/setup/gpu-devices.sh check` **before touching anything** (must say PASS, with the `nvidia_uvm` module loaded and you, a member, opening `/dev/nvidia-uvm`) → `id <your user>` lists `worklane-gpu-dev` (log in again if a session doesn't have it). A FAIL after a boot is a bug to report, not something to fix by hand each time: `sudo /usr/local/libexec/worklane-gpu-devices` only sets the nodes back for now.
   - **Already applied on 0.5.1:** 0.5.2's `apply` adds a boot unit (`worklane-gpu-devices.service`) and drop-ins for `nvidia-cdi-refresh.service` and `nvidia-persistenced.service`, so rerun `apply --users <your user> [--no-dynamic-nodes]` as root once after the install, `sudo reboot`, then `check` before touching anything. It adds no sudoers rules, so there is no machine-helper rerun for it (step 9). It refuses while another `modprobe.d` file sets `NVreg_DeviceFile*` or `NVreg_ModifyDeviceFiles`: remove that file first.
11. **Test-run network, before it installs on a machine whose instance runs test runs** (0.5.1: a run's commands have no network, and its database is a Unix socket, docs/test-runs.md "Network"). No root step: the updater installs the new helper. But a project whose `tests.yaml` `test_run.setup` installs from the network (plain `npm ci`) fails every run after the update until its config changes, on main:
   - npm with a lockfile of registry packages: add `fetch: [{ npm: <its npm cache's name> }]` (a cache with `env: npm_config_cache`) and make the step `npm ci --offline`;
   - anything that can't be split (git or workspace packages, another package manager): root grants it, per instance, `sudo bash /opt/worklane/current/scripts/setup/testrun-network.sh enable <name> --tiers setup`, and the config sets `setup_network: true`;
   - a tier that needs the network itself: `network: true` on it, and root's `--tiers` names it too. Each grant needs the owner's go.
   - a database client that only takes a host and port (not a socket directory in `host=`) needs changing too.
12. **Siri Shortcut, after it installs on the release-channel machine that runs the hub** (0.5.1 adds it, #507), once, in this order:
   - root: `sudo bash /opt/worklane/current/scripts/setup/tailscale.sh serve-siri` (publishes 8443 on the tailnet, never Funnel);
   - root: `sudo bash /opt/worklane/current/scripts/setup/dashboards.sh --siri <your usual options> <every instance>` (the same run as before, plus `--siri`: lets the hub read each instance's Siri gateway token);
   - on a Mac: sign the two Shortcuts once (`shortcuts sign`, docs/siri.md), and sign again only when a Shortcut changes;
   - in the Tailscale admin console: the tailnet ACL that limits port 8443 to your phone (docs/siri.md gives it).

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
