#!/bin/bash
# The CI runners' job hooks, installed root:root 0755 by scripts/setup/ci-runner.sh as both
#   /usr/local/libexec/worklane-ci/job-started.sh    (ACTIONS_RUNNER_HOOK_JOB_STARTED)
#   /usr/local/libexec/worklane-ci/job-completed.sh  (ACTIONS_RUNNER_HOOK_JOB_COMPLETED)
# and told apart by the name they're run as. The runner runs the started hook before the job's service
# containers start and the completed hook after they stop, so the lock covers the whole job.
#
# started:   takes the machine-wide full-run lock SHARED for the job: agents' full runs take it exclusively,
#            so a CI job never overlaps one, and CI jobs never serialize each other. A background holder
#            keeps it until the completed hook (or the runner's service stopping, which kills the holder
#            with the rest of its cgroup); nothing holds it while the runner sits idle. Waits at most
#            WORKLANE_CI_LOCK_WAIT_MIN minutes, then fails the job: never runs it without the lock. Jobs
#            named in WORKLANE_CI_NO_LOCK_JOBS (GITHUB_JOB ids, e.g. a verdict-only job) don't take it.
# completed: releases it.
# The lock is cooperative, like every flock: it keeps well-behaved runs apart, it is not a security boundary.
#
# From the runner's service unit (ci-runner.sh writes them):
#   WORKLANE_CI_LOCK            the lock file (root-owned, opened read-only: flock needs only a read fd)
#   WORKLANE_CI_LOCK_WAIT_MIN   how long to wait for it
#   WORKLANE_CI_NO_LOCK_JOBS    space-separated job ids that don't take it
#   WORKLANE_CI_STATE           a directory of this runner's own, for the holder's pid
set -euo pipefail
lock="${WORKLANE_CI_LOCK:?}"
state="${WORKLANE_CI_STATE:?}"
holder_file="$state/lock-holder"
held_file="$state/lock-held"

started() {
  local wait_min="${WORKLANE_CI_LOCK_WAIT_MIN:?}" job="${GITHUB_JOB:-}" holder start code
  [[ "$wait_min" =~ ^[1-9][0-9]*$ ]] || { echo "ci-lock: WORKLANE_CI_LOCK_WAIT_MIN is not a number of minutes; not starting" >&2; exit 1; }
  if [ -n "$job" ] && [[ " ${WORKLANE_CI_NO_LOCK_JOBS:-} " == *" $job "* ]]; then
    echo "ci-lock: job $job doesn't take $lock"
    exit 0
  fi
  if [ ! -e "$lock" ]; then
    echo "ci-lock: $lock is missing (the machine's locks aren't set up); not starting job ${job:-?}" >&2
    exit 1
  fi
  rm -f "$held_file"
  # The holder: open the lock read-only, wait for a shared lock, say so, then sleep with it held until killed.
  # Its output goes nowhere, so the runner doesn't wait on it when this hook exits.
  bash -c 'exec 9<"$1" || exit 2; flock -s -w "$2" 9 || exit 3; : > "$3"; exec sleep infinity' \
    _ "$lock" "$((wait_min * 60))" "$held_file" </dev/null >/dev/null 2>&1 &
  holder=$!
  echo "$holder" > "$holder_file"
  start=$(date +%s)
  echo "ci-lock: waiting for $lock (shared; an agent's full run holds it exclusively)"
  while [ ! -e "$held_file" ]; do
    if ! kill -0 "$holder" 2>/dev/null; then
      rm -f "$holder_file"
      code=0; wait "$holder" || code=$?
      if [ "$code" -eq 3 ]; then echo "ci-lock: $lock still held after $wait_min min (an agent's full run?); not starting job ${job:-?}" >&2
      else echo "ci-lock: could not take $lock (exit $code); not starting job ${job:-?}" >&2; fi
      exit 1
    fi
    sleep 1
  done
  echo "ci-lock: holding $lock (shared) for job ${job:-?}, after $(($(date +%s) - start)) s"
}

completed() {
  local pid
  if [ ! -f "$holder_file" ]; then echo "ci-lock: this job held no lock"; return 0; fi
  pid="$(cat "$holder_file")"
  rm -f "$holder_file" "$held_file"
  [[ "$pid" =~ ^[0-9]+$ ]] || { echo "ci-lock: bad holder pid in $holder_file" >&2; exit 1; }
  kill "$pid" 2>/dev/null || true
  # Gone before this returns, so the lock is free for the next run as soon as the job is.
  for _ in $(seq 100); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
  echo "ci-lock: released $lock"
}

case "$(basename "$0")" in
  job-started.sh) started ;;
  job-completed.sh) completed ;;
  *) echo "usage: run as job-started.sh or job-completed.sh" >&2; exit 2 ;;
esac
