# Working on this repo

Engine for a multi-agent dev harness. Design: docs/design.md. Prior art: docs/prior-art.md.

- The product name lives only in `src/brand.ts`; never hardcode it in `src/` (a test enforces this). `npm run rename -- <name>` renames everywhere.
- No project-specific code or details (names, repos, people, environments, paths). Project behavior and notes live in the project's `.worklane/` folder; `npm run check:denylist` enforces this.
- OS-specific code only in the OS adapter layer. CI runs macOS, Linux, Windows.
- Never copy code from AGPL/GPL/SSPL/BUSL/Commons Clause projects. Credit reused MIT/Apache code in THIRD_PARTY_NOTICES.md.
- Commits: atomic, signed off (`git commit -s`).
- Verify with `npm test` and `npm run typecheck` before calling anything done. Every bug fix gets a test that fails without it.
- Fix ranking: make the wrong thing impossible > a test or lint > a written rule.
