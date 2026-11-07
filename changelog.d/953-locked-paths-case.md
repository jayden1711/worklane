### Guardrail changes: what each one does

- **Review levels match the locked categories case folded (#953):** a case variant of a locked path is in its
  locked category, L3, everywhere: `Decisions.md` or `Docs/adr/x.md` is a planners' decision record,
  `Docs/process.md` the merge process, `SRC/hook.ts` the tool guard, `.Claude/settings.json` harness config. On a
  case-insensitive checkout (macOS, Windows) each is that file. A folded match only raises a level: the categories
  that lower one (docs, tests) and a repo's own categories still match as written.
