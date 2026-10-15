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

## Rotating the release key

`.github/release-signers` is in ssh-keygen's allowed-signers format, one key per line under the principal `release-signer`. CI reads it from main, never from the tagged commit, and a change to it always waits for the owner (src/review.ts). To rotate: add the new key's line in a PR, sign the next tag with it, then remove the old line in a later PR.
