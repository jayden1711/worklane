#!/usr/bin/env bash
# CI only (the changes job of .github/workflows/ci.yml): whether a pull request touches code, for the systemd
# acceptance job's gate (the owner's decision, 2026-11-14: on a ready PR from this repo, only when it touches code).
# Code: every path but the few that name only prose (NOT_CODE below: docs/, changelog.d/, top-level *.md, LICENSE,
# NOTICE, .github/ISSUE_TEMPLATE/, .github/PULL_REQUEST_TEMPLATE.md; the owner's to adjust). WHY a list of what is not
# code (R1309b D1): a list of what is code missed inputs of the job (.gitignore and .gitattributes shape the copy the
# DynamicUser build gets; tsconfig.json; web/), and a path nobody listed fails open. A path nobody lists now runs it.
# It writes code=true or code=false to $GITHUB_OUTPUT (to stdout outside Actions, for the tests).
#   PR_BASE, PR_HEAD: the PR's base and head commits. The files are the head's changes since their merge base (the
#   diff base...head), as scripts/ci/slow-jobs.sh reads them.
# Any error exits non-zero with no output, and the systemd job then runs (its gate fails closed on a changes job
# that didn't succeed).
set -euo pipefail

: "${PR_BASE:?the PR base commit}" "${PR_HEAD:?the PR head commit}"
# --no-renames: a file moved out of code still names its old path. -z: each path as itself, never C-quoted. The NULs
# become newlines for grep: a newline inside a name only adds a line after the name's own start (which keeps its real
# top folder), so it can make a change code, never hide code.
files="$(git diff --name-only --no-renames -z "$(git merge-base "$PR_BASE" "$PR_HEAD")" "$PR_HEAD" | tr '\0' '\n')"
NOT_CODE='^(docs/|changelog\.d/|[^/]*\.md$|LICENSE$|NOTICE$|\.github/ISSUE_TEMPLATE/|\.github/PULL_REQUEST_TEMPLATE\.md$)'
# Code when any line is neither empty (an empty diff is one empty line here) nor one of NOT_CODE. One grep, no pipe:
# under pipefail, `grep -v | grep -q` could fail when -q stops early, and read as no code.
code=false
if grep -qvE "^\$|$NOT_CODE" <<< "$files"; then code=true; fi
echo "changed files: $(grep -c . <<< "$files" || true); touches code: $code"
# Outside Actions (the tests), to stdout: /dev/stdout can't be opened for append when stdout is a socket.
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "code=$code" >> "$GITHUB_OUTPUT"; else echo "code=$code"; fi
