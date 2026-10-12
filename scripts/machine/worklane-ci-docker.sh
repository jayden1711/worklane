#!/bin/bash
# `docker` for the CI runners, installed root:root 0755 by scripts/setup/ci-runner.sh as
# /usr/local/libexec/worklane-ci/bin/docker, first on the runner's PATH (the runner runs `docker` from PATH
# for service containers). It pins images without changing the workflows that name them:
#   docker pull <image>   an image listed in WORKLANE_CI_IMAGES ("<image>=<name>@sha256:<digest>" entries,
#                         space-separated) is pulled by its digest (or found locally by it) and tagged as
#                         <image>; any other image is refused, so nothing unpinned starts here.
#   anything else         passed to the real docker CLI (WORKLANE_CI_DOCKER), which talks to the runner
#                         user's own rootless daemon (DOCKER_HOST).
# A pin, not a boundary: the daemon is the runner user's own, and a job can always call the real CLI.
set -euo pipefail
real="${WORKLANE_CI_DOCKER:?}"
if [ "${1:-}" = pull ]; then
  want="${2:?usage: docker pull <image>}"
  [ "$#" -eq 2 ] || { echo "docker pull: only 'docker pull <image>' is supported on this runner" >&2; exit 1; }
  for pin in ${WORKLANE_CI_IMAGES:-}; do
    [ "${pin%%=*}" = "$want" ] || continue
    ref="${pin#*=}"
    [[ "$ref" =~ ^[a-z0-9./_-]+@sha256:[0-9a-f]{64}$ ]] || { echo "docker pull: the pin for $want ($ref) is not <name>@sha256:<digest>" >&2; exit 1; }
    if ! "$real" image inspect "$ref" >/dev/null 2>&1; then "$real" pull -q "$ref"; fi
    "$real" tag "$ref" "$want"
    echo "$want pinned to $ref"
    exit 0
  done
  echo "docker pull $want: not a pinned image on this runner (pins: ${WORKLANE_CI_IMAGES:-none}); add it with ci-runner.sh install --image" >&2
  exit 1
fi
exec "$real" "$@"
