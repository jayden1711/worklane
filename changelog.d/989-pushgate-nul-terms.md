### Guardrail changes: what each one does

- **The push gate scans a file holding a NUL byte for the hashed terms (#989):** such a file, in a pushed commit's
  added lines or in a pushed tip's tree, was skipped by the term scan (gitleaks still ran). Now its printable ASCII and
  UTF-16LE text runs are scanned, and a denied term refuses the push, naming the file, when its run is at least 8
  characters or the term at least 6 (shorter ones turn up in compressed bytes by chance). `.denylist-allow` applies as
  for text. The regex patterns (emails, home paths, private addresses and the like) are still not run on such a file,
  since their short shapes match binary data by chance. Text files are scanned as before.
