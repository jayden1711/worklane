#!/bin/sh
# CI only (the argv canary step of "test-run sandbox (real systemd)" in .github/workflows/ci-slow.yml): put in place of
# the test user's docker CLI for the step's runs, it appends its own argv to @LOG@, one call a line, then runs the real
# CLI (@REAL@) with the same arguments. WHY: sampling ps can miss a docker call that lasts a moment; this records every
# one, so a helper that puts the database password in docker's argv is caught on every run, not by luck.
printf '%s\n' "$*" >> '@LOG@'
exec '@REAL@' "$@"
