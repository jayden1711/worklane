#!/usr/bin/env bash
# CI only (the scope job of .github/workflows/ci-slow.yml): which of the slow jobs this run runs. It writes
# run=" <job key> <job key> " to $GITHUB_OUTPUT, and each slow job runs only when its key is in that list.
#   workflow_dispatch (a batch on main, from scripts/ci/batch.mjs; or one bisect step on a ci-bisect/ branch):
#     JOB=all runs every slow job, JOB=<key> that one only. WANT_SHA, when given, must be the commit this run is on
#     (SHA): a bisect step tests exactly the commit it asked for, or nothing.
#   pull_request: all of them with the full-ci label (FULL=true) or a workflow change; the bootstrap jobs when the
#     install path changes; the real systemd and real users jobs when the root and machine scripts, the OS layer, the
#     test-run host or the runner's sign-in check change; the wizard's end-to-end job when either of those changes, or
#     the wizard's own pages and server code do (PR_BASE, PR_HEAD: the PR's base and head commits).
set -euo pipefail

BOOTSTRAP="bootstrap bootstrap-windows"
MACHINE="testrun-real-systemd add-project-real-systemd auth-probe-real-users"
WIZARD="wizard-e2e-real-systemd"
ALL="$BOOTSTRAP $MACHINE $WIZARD"

run=""
case "${EVENT:-}" in
  workflow_dispatch)
    if [ -n "${WANT_SHA:-}" ] && [ "$WANT_SHA" != "${SHA:-}" ]; then
      echo "asked to test $WANT_SHA, but this run is on ${SHA:-nothing}" >&2
      exit 1
    fi
    job="${JOB:-all}"
    if [ "$job" = all ]; then
      run="$ALL"
    elif [[ " $ALL " == *" $job "* ]]; then
      run="$job"
    else
      echo "no slow job \"$job\" (one of: all $ALL)" >&2
      exit 1
    fi
    ;;
  pull_request)
    files="$(git diff --name-only "$(git merge-base "$PR_BASE" "$PR_HEAD")" "$PR_HEAD")"
    if [ "${FULL:-false}" = true ] || grep -qE '^\.github/workflows/' <<< "$files"; then
      run="$ALL"
    else
      if grep -qE '^(scripts/bootstrap\.sh|scripts/ci/wizard-url\.sh|src/dashboard-detach\.ts|web/src/components/DashboardKey\.tsx|Dockerfile|\.dockerignore|package(-lock)?\.json|scripts/ci/stand-ins/)' <<< "$files"; then run="$BOOTSTRAP"; fi
      if grep -qE '^(scripts/(setup|machine|ci)/|src/os/|src/testrun/|src/runner\.ts)' <<< "$files"; then run="$run $MACHINE"; fi
      # WHY: the wizard's walk runs the install and the machine scripts too, so either of the above runs it as well.
      if [ -n "$run" ] || grep -qE '^(web/src/(App\.tsx|api\.ts|pages/(FirstRun|Settings|Machine|Setup)\.tsx|components/(SetupScreens|SetupConfig|ClaudeSignin|DiscordSetup|PolicyForm|RepoConfigForm|TailscaleSetup|UpdaterSetup)\.tsx)|src/(setup-[a-z-]+|setup/[a-z-]+|claude-signin|gh-login|policy-edit|config-change|tailscale-setup|updater-setup|hub-setup|auto-config|init|dashboard|dashboard-hub|browser/cdp)\.ts)' <<< "$files"; then run="$run $WIZARD"; fi
    fi
    ;;
  *)
    echo "the slow jobs run on pull_request and workflow_dispatch, not \"${EVENT:-}\"" >&2
    exit 1
    ;;
esac

# Word-split on purpose: one space between keys, one at each end, for the jobs' contains(..., ' <key> ').
# shellcheck disable=SC2086
run=" $(echo $run) "
echo "event: $EVENT; full-ci label: ${FULL:-n/a}; slow jobs this run:${run% }"
# Outside Actions (the tests), to stdout: /dev/stdout can't be opened for append when stdout is a socket.
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "run=$run" >> "$GITHUB_OUTPUT"; else echo "run=$run"; fi
