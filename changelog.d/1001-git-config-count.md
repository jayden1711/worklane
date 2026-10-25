### Guardrail changes: what each one does

- **A git config count in a child's environment that isn't a plain decimal makes git fail (#1001).** The engine strips
  TLS, proxy and URL-rewrite keys from git config carried in a child's environment (`GIT_CONFIG_COUNT` and its
  pairs). It read the count with `Number()`: a count git refuses (`1 `, `0x1`, `1e0`) was rewritten into one git
  reads, so a pair git would have refused was applied, and a count over 1000 was left as it was with its pairs
  unstripped, so `http.sslVerify=false` among them reached git. Now any count but empty or a plain decimal from 0 to
  1000 is replaced with one git refuses, and that git fails instead of running. Counts the engine writes are read as
  before.
