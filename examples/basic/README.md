# Example project

A tiny shop used to demonstrate and test the harness. Its `.worklane/` shows a
filled-in configuration for a common setup: a project whose staging and
production databases share a host name (only the password differs), deployed
with a platform CLI that remembers a "linked" environment.

`scripts/print-prod-env.mjs` stands in for a platform command that prints
production variables, so `guardrails refresh` works without real credentials.
