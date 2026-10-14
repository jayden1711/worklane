#!/bin/bash
# CI only: a stand-in for the runner's run.sh --once (see config.sh beside it). It waits, as an idle runner does, for
# one "job": a next.env the CI job drops into this runner's workspace with the GITHUB_* variables a real runner would
# set. It runs the job-started hook as the runner does; only if the hook lets it, the probes (job.sh), then the
# job-completed hook. Then it exits, and the unit starts it again (reset first), as for a real runner.
set -uo pipefail
[ "${1:-}" = --once ] || { echo "stand-in run.sh: expected --once" >&2; exit 2; }
here="$(cd "$(dirname "$0")" && pwd)"
work="$(sed -n 's/^work=//p' "$here/.runner")"
[ -n "$work" ] && [ -x "$here/bin/Runner.Listener" ] || { echo "stand-in run.sh: no registration or no bin/ bind" >&2; exit 1; }
echo "STANDIN idle"
while [ ! -f "$work/next.env" ]; do sleep 1; done
set -a
# shellcheck disable=SC1091
. "$work/next.env"
set +a
rm -f "$work/next.env"
echo "STANDIN job $JOB_ID start"
if bash "$ACTIONS_RUNNER_HOOK_JOB_STARTED"; then
  bash "$here/job.sh"
  bash "$ACTIONS_RUNNER_HOOK_JOB_COMPLETED"
  echo "STANDIN job $JOB_ID ran"
else
  echo "STANDIN job $JOB_ID refused by the started hook"
fi
