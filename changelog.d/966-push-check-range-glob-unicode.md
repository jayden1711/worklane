### Guardrail changes: what each one does

- **A glob's `?` matches one character outside the BMP (#966):** `?` matched one UTF-16 unit, so `keys/?.pem` missed
  a name with one emoji in that slot (`keys/**` still caught it). It now matches such a character too, in every glob
  the engine reads (push.refuse_paths, protected paths, review categories and the rest). It still matches a single
  unit, so no glob matches fewer paths than before.
- **push.refuse_paths matches a name in NFC or NFD (#966):** `secrets/café.pem` committed in its decomposed spelling
  (an `e` and a combining accent) got past a refuse glob written in the composed one, and the other way round. Each
  path is now matched in its own, NFC and NFD spellings against the glob in its own, NFC and NFD spellings.
- **The push check takes only commits as a range's ends (#966):** a tree, a blob or a tag of either as the head or
  the base is refused (as since #981), and the check's judging code now takes only the commit ids it read, so a later
  change can't hand it a name or a tree id.
