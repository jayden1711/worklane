### Guardrail changes: what each one does

- **The engine's own check tables are data, compared parsed and frozen at load (#941, part).** The weakening hold read
  registered tables as lines of code, and every review round found code that changed or emptied a table where no line
  showed it. Now the 43 tables `src/` and `scripts/` registered by a mark live in data-only files beside their modules
  (`<module>.tables.json`). The hold compares each one as parsed data, before and after, and never runs code: a table
  or its file gone, its kind changed, a file that doesn't parse, an entry lost or changed in a rule list, or an entry
  added or changed in an allowlist waits for the owner; an entry added to a rule list passes. Each module loads its
  own file by its own URL and gets its tables deep-frozen, so a write from any file (a `splice`, `length = 0`,
  `delete`, a callback given the list, a regexp's `compile`) throws instead of loosening a check. Scripts that run on
  their own (the push gate's hook, the gate and its denylist, the App permission check, the pin check, the root
  helpers) carry a generated frozen copy of their file that a test holds to it. The tables registered in tests stay
  code, read as before, and are frozen by the test loader right after their declaration; one may not be a Set or a
  Map. A removed or changed line that loads a table waits (its `TABLES.get` line included), an added line that loads
  the loader any other way waits, and each table has one load site. A table that any change can loosen (the git
  guard's command-scope pairs, cp's and ln's options) waits on any change. The syntax matcher this PR first added is
  gone. Still open, and named by the owner: a use moved off a data table while its data and its load line stay the
  same (a decoy, a shadow, a re-pointed import of its module, a tsconfig line that takes its user out of the build).
  Also open, and the owner's call: code that runs before a table's load and replaces a built-in the loader calls
  (`JSON.parse`, `Array.prototype.map`, `Object.freeze`, `readFileSync`) changes what the load returns.
