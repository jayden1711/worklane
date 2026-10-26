### Guardrail changes: what each one does

- **The push gate's term scan of a file holding a NUL byte misses less (#1057):** a short term in an ASCII text run
  with a NUL on both sides (a C string) now refuses the push, as does a term in UTF-16BE text. A run of exactly 8
  characters is still the minimum for a short term elsewhere. UTF-16LE text is not read again one byte late as
  UTF-16BE, which dropped its first letter: `Azqx` was read as `zqx`.
- **An added line starting `++ /dev/null` or `++ b/<path>` is scanned as content (#1057):** it was read as a diff
  header, which hid the rest of a file added and deleted again within one push from the added-lines scan.
- **A commit diff or a tip file over the gate's 256 MiB read limit refuses the push by name (#1057),** instead of the
  gate failing with a bare buffer error. Either way nothing is pushed.
- **`npm run check:denylist` scans a file holding a NUL byte for the hashed terms (#1057),** as the push gate does. It
  skipped such files before.
