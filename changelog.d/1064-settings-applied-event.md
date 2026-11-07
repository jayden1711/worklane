### Upgrading (from v0.5.2)

- **The settings event says the instance policy can't be used in the engine's words, never with its path or the
  parser's text (#1064).** When an instance's policy.yaml can't be read, or its settings can't be used (the machine's
  limits file is broken, say), the `settings.applied` event the dashboard's event log shows now reads "policy
  unreadable" or "policy settings unusable", followed by "the detail is in the dashboard's log on the machine". It used
  to quote the error, which named the file's absolute path and the JSON or YAML parser's words. The detail goes to the
  service log, redacted, once for each different detail rather than on every tick. The repo's values still apply until
  the file is fixed, as before.
