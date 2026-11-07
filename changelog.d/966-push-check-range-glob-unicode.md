### Guardrail changes: what each one does

- **A glob's `?` and a character outside the BMP, by what a match does (#966):** `?` matched one UTF-16 unit, so
  `keys/?.pem` missed a name with one emoji in that slot (`keys/**` still caught it). The engine's one glob compiler
  (`src/guardrails/glob.ts`) now makes each matcher say what a match does there:
  - **Deny.** A `?` matches one character or one unit, so these never match less than before: push.refuse_paths,
    the guard hook's secret globs and a search's or Grep's own glob, the sandbox read-deny entries worked out from them, money
    globs, review categories when they raise a level, self-modification paths, the merge-policy weakening scan,
    fix_forward.revert_first_paths, browser ui_paths, hotspots, owner areas, the tamper guard's and the vacuity
    command's test globs, and the study check that an editable glob covers no eval file.
  - **Allow.** A `?` matches only what both a unit and a character do, so these never match more than before: the
    secret globs' `!` exceptions (in the hook and the sandbox entries alike), docs, tests and harness-config when they
    leave a path out of the app code, the docs-only class, the lockfile and `generated` size skips, an experiment's
    editable paths, and the money list's test of whether a cut comment's glob covers its line.
  - **Unchanged.** A glob with no `?` reads exactly as before, as does what an earlier version counted as money (a
    money glob's earlier reading, and main's kept readings). Still read as before, as follow-ups: the protected,
    agent-editable and AGENTS.md paths (`src/guardrails/engine.ts`), the vacuity test and app globs
    (`src/merge-policy-vacuity.ts`, `src/vacuity.ts`), and the look-alike check's own glob matcher
    (`src/confusables.ts`).
- **push.refuse_paths matches a name in NFC or NFD (#966):** `secrets/café.pem` committed in its decomposed spelling
  (an `e` and a combining accent) got past a refuse glob written in the composed one, and the other way round. Each
  path is now matched in its own, NFC and NFD spellings against the glob in its own, NFC and NFD spellings, so
  `secrets/cafe*` also refuses `secrets/café.pem`, whose NFD spelling starts with `cafe`.
- **The push check takes only commits as a range's ends (#966):** a tree, a blob or a tag of either as the head or
  the base is refused (as since #981), and the check's judging code now takes only the commit ids it read, so a later
  change can't hand it a name or a tree id.
