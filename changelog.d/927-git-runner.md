### Upgrading (from v0.5.2)

- **Every git the engine's JS and TS code runs ignores replace refs and grafts (#927).** An agent could write
  `refs/replace/*` or `.git/info/grafts` in the shared repo and make the push limits, the secret scan and the review
  read other commits. The `.sh` helpers under `scripts/` don't go through the runner. A change's recorded
  `patch_hash` now covers every file's lines, so it differs from an older engine's for the same change. Run
  `npm run setup:hooks` once after upgrading: until then, an install's old copy of the push-gate hook runs its own
  git calls (the one that loads the gate among them) without these settings. It keeps working.
- **A `GIT_CONFIG_COUNT` that isn't a plain decimal from 0 to 9999 now makes git refuse (#927)**, for every git the
  runner starts and in the push gate: the runner can't add its setting after a count it can't read. Nothing in the
  engine writes such a count; an environment that sets one must write it plainly.

### Guardrail changes: what each one does

- **The git runner (#927):** `src/os/git.ts` (and `scripts/lib/git.cjs` for scripts) starts every git with replace
  refs off and no graft file, over whatever environment the caller passes; gitleaks gets the same settings. A test
  fails on a git call in the JS and TS files under `src/` and `scripts/` that doesn't come through it (it doesn't
  read `.sh` files, git named in a shell string, or a name built at run time), and the runner and that test wait for
  the owner.
- **A shallow cut in a pushed range is refused (#927):** a `.git/shallow` (a shallow clone's, or one written by hand)
  that cuts the range being pushed made the push limits read only part of it. The push is now refused, and the
  message names `git fetch --unshallow`. A shallow clone still pushes changes that lie wholly above its cut. The push
  limits and the change's secret scan read one checked copy of the shallow file, so changing it while they run
  changes nothing, and a shallow file with a line git might read differently is refused.
- **The commit-graph is off for every git the runner starts (#927):** a forged commit-graph could make a walk skip a
  commit; git now reads each commit's own parents (measured: about 30 ms more for three walks over 2,900 commits).
- **The patch hash (#927)** covers a file's lines even when the change's `.gitattributes` marks it `-diff` or
  `binary`. The owner's decision diff and the fix-forward culprit diff are as before: a binary file shows as
  "Binary files ... differ".
