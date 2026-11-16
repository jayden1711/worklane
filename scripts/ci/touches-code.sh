#!/usr/bin/env bash
# CI only (the changes job of .github/workflows/ci.yml): whether a pull request touches code, for the systemd
# acceptance job's gate (the owner's decision, 2026-11-14: on a ready PR from this repo, only when it touches code).
# Code: every path but the few that name only prose (NOT_CODE below: docs/, changelog.d/, top-level *.md, LICENSE,
# NOTICE, .github/ISSUE_TEMPLATE/, .github/PULL_REQUEST_TEMPLATE.md; the owner's to adjust). WHY a list of what is not
# code (R1309b D1): a list of what is code missed inputs of the job (.gitignore and .gitattributes shape the copy the
# DynamicUser build gets; tsconfig.json; web/), and a path nobody listed fails open. A path nobody lists now runs it.
# It writes code=true or code=false to $GITHUB_OUTPUT (to stdout outside Actions, for the tests).
#   Run in the checkout of GitHub's merge commit (refs/pull/<n>/merge, the tree the systemd job tests), PR_HEAD the
#   PR's head commit. The files are what that merge changes on the branch it merged into: HEAD^1..HEAD. WHY not the
#   diff from a merge base (R1309d D2): with two merge bases (criss-cross merges), git merge-base picks one, and the
#   diff from it can miss a file the merge changes; HEAD^1..HEAD is exactly the change the job tests.
#   BASE_REF, DEFAULT_BRANCH: the PR's base branch and the repo's default branch. A PR into any other branch is code
#   (R1309c D2, R1309d D1: a retarget to main fires only `edited`, no run, so a skip computed against another branch
#   would stand). ci.yml's gate says so too, but GitHub's != ignores case, and branch names don't: compared here.
# Any error exits non-zero with no code= line, and the systemd job then runs (its gate fails closed on a changes job
# that didn't succeed). So does a HEAD that isn't a merge of PR_HEAD (not the tree the job tests).
set -euo pipefail

: "${PR_HEAD:?the PR head commit}" "${BASE_REF:?the PR base branch}" "${DEFAULT_BRANCH:?the default branch}"
if [ "$(git rev-parse --verify -q 'HEAD^2^{commit}' || true)" != "$(git rev-parse --verify -q "$PR_HEAD^{commit}" || echo none)" ]; then
  echo "HEAD ($(git rev-parse -q HEAD || true)) is not GitHub's merge of the PR head $PR_HEAD: its second parent differs" >&2
  exit 1
fi
list="$(mktemp)"; trap 'rm -f "$list"' EXIT
# --no-renames: a file moved out of code still names its old path. -z, read by grep -z: each path is one record, as
# itself; a newline in a name is an ordinary character (R1309c D1: split into lines, `README.md<newline>docs/a.ts`
# read as two not-code paths).
git diff --name-only --no-renames -z 'HEAD^1' HEAD > "$list"
NOT_CODE='^(docs/|changelog\.d/|[^/]*\.md$|LICENSE$|NOTICE$|\.github/ISSUE_TEMPLATE/|\.github/PULL_REQUEST_TEMPLATE\.md$)'
# Code when any path is not one of NOT_CODE (an empty diff has no record: no code). One grep, no pipe: under
# pipefail, `grep -v | grep -q` could fail when -q stops early, and read as no code.
paths=false
if grep -zqvE "$NOT_CODE" "$list"; then paths=true; fi
code=$paths
if [ "$BASE_REF" != "$DEFAULT_BRANCH" ]; then code=true; fi
echo "changed files: $(tr -cd '\0' < "$list" | wc -c); the paths touch code: $paths; base $BASE_REF (default $DEFAULT_BRANCH); touches code: $code"
# Outside Actions (the tests), to stdout: /dev/stdout can't be opened for append when stdout is a socket.
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "code=$code" >> "$GITHUB_OUTPUT"; else echo "code=$code"; fi
