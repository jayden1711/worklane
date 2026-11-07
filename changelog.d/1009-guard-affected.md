### Guardrail changes: what each one does

- **A change to how the engine picks a pull request's test files waits for the owner (#1009).** `src/testrun/affected.ts` (`selectTests`, which `scripts/ci/affected.mjs` runs in each CI shard) is now a guard file beside `scripts/ci/**`: a removed or changed line in it holds the merge as `design: may weaken a check`. Before, a change there could drop a guard test from a PR's own CI run without the owner seeing it; a push to main still ran every test. Like the engine's other source guards, it stands aside in a managed app's repo.
