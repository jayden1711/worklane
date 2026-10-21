### Upgrading (from v0.5.2)

- **Every git the engine runs ignores replace refs and grafts (#927).** An agent could write `refs/replace/*` or
  `.git/info/grafts` in the shared repo and make the push limits, the secret scan and the review read other commits.
  Nothing to do; a change's recorded `patch_hash` now covers every file's lines, so it differs from an older engine's
  for the same change. Run `npm run setup:hooks` once to get the push-gate hook that also hands the gate these
  settings (the old hook keeps working).

### Guardrail changes: what each one does

- **The git runner (#927):** `src/os/git.ts` (and `scripts/lib/git.cjs` for scripts) starts every git with replace
  refs off and no graft file, over whatever environment the caller passes; gitleaks gets the same settings. A test
  fails on a git call in `src/` or `scripts/` that doesn't come through it, and the runner and that test wait for the
  owner.
- **What the owner sees (#927):** the decision diff, the fix-forward culprit diff and the patch hash show a file's
  lines even when the change's `.gitattributes` marks it `-diff` or `binary`.
