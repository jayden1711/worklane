### Guardrail changes: what each one does

- **The push gate's term scan of a file holding a NUL byte misses less (#1057):** a short term in an ASCII text run
  with a NUL on both sides (a C string) now refuses the push, as does a term in UTF-16BE text. The exception is a term
  in the first word of UTF-16BE text with a printable byte before it and a NUL after it: that text is read only as
  UTF-16LE, with the byte glued to its first word. A run of exactly 8 characters is still the minimum for a short term
  elsewhere. UTF-16LE text is no longer also read one byte late as UTF-16BE, which dropped its first letter (`Azqx` was
  read as `zqx`), unless one printable byte with no NUL after it follows the text.
- **The binary scan reads one run at a time and a long run in 64K-character pieces (#1057),** so 64 MiB of random
  bytes, of UTF-16LE text or of an ASCII log after a NUL takes no more memory than reading the file in did. A single
  token filling most of a run is still held whole.
- **An added line starting `++ /dev/null` or `++ b/<path>` is scanned as content (#1057):** it was read as a diff
  header, which hid the rest of a file added and deleted again within one push from the added-lines scan.
- **A commit diff or a tip file over the gate's 256 MiB read limit refuses the push by name (#1057),** instead of the
  gate failing with a bare buffer error. Either way nothing is pushed.
- **`npm run check:denylist` scans a file holding a NUL byte for the hashed terms (#1057),** as the push gate does. It
  skipped such files before.
