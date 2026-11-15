#!/usr/bin/env bash
# CI only (the changes job of .github/workflows/ci.yml): whether a pull request touches code, for the systemd
# acceptance job's gate (the owner's decision, 2026-11-14: on a ready PR from this repo, only when it touches code).
# Code: anything under src/, scripts/, test/ or .github/workflows/, or package.json or package-lock.json. It writes
# code=true or code=false to $GITHUB_OUTPUT (to stdout outside Actions, for the tests).
#   PR_BASE, PR_HEAD: the PR's base and head commits. The files are the head's changes since their merge base (the
#   diff base...head), as scripts/ci/slow-jobs.sh reads them.
# Any error exits non-zero with no output, and the systemd job then runs (its gate fails closed on a changes job
# that didn't succeed).
set -euo pipefail

: "${PR_BASE:?the PR base commit}" "${PR_HEAD:?the PR head commit}"
# --no-renames: a file moved out of code still names its old path. -z: each path as itself, never C-quoted. The NULs
# become newlines for grep: a newline inside a name only adds a line, which can make it code, never hide code.
files="$(git diff --name-only --no-renames -z "$(git merge-base "$PR_BASE" "$PR_HEAD")" "$PR_HEAD" | tr '\0' '\n')"
code=false
if grep -qE '^(src/|scripts/|test/|\.github/workflows/|package\.json$|package-lock\.json$)' <<< "$files"; then code=true; fi
echo "changed files: $(grep -c . <<< "$files" || true); touches code: $code"
# Outside Actions (the tests), to stdout: /dev/stdout can't be opened for append when stdout is a socket.
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "code=$code" >> "$GITHUB_OUTPUT"; else echo "code=$code"; fi
