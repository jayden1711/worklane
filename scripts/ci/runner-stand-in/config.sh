#!/bin/bash
# CI only (.github/workflows/ci-runner-setup.yml): a stand-in for the runner's config.sh, in a stand-in release that
# job seeds where scripts/setup/ci-runner.sh keeps the pinned one (the real one is sha256-checked against the pin
# in its own step). The registration is faked; what is real is how the token gets here: it must arrive in
# ACTIONS_RUNNER_INPUT_TOKEN and in no argument. Only its sha256 is kept, so the job can tell it was the right one.
set -euo pipefail
tok="${ACTIONS_RUNNER_INPUT_TOKEN:-}"
[ -n "$tok" ] || { echo "stand-in config.sh: no token in ACTIONS_RUNNER_INPUT_TOKEN" >&2; exit 1; }
for a in "$@"; do [[ "$a" != *"$tok"* ]] || { echo "stand-in config.sh: the token is in an argument" >&2; exit 1; }; done
if [ "${1:-}" = remove ]; then
  echo "stand-in config.sh: deregistered, removal token sha256 $(printf '%s' "$tok" | sha256sum | cut -c1-64)"
  exit 0
fi
out=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --url | --name | --labels | --work) out+=("${1#--}=$2"); shift 2 ;;
    --unattended | --disableupdate | --replace) out+=("${1#--}=yes"); shift ;;
    *) echo "stand-in config.sh: unexpected argument $1" >&2; exit 1 ;;
  esac
done
{ printf '%s\n' "${out[@]}"; printf 'token_sha256=%s\n' "$(printf '%s' "$tok" | sha256sum | cut -c1-64)"; } > .runner
echo stand-in > .credentials
echo stand-in > .credentials_rsaparams
echo "stand-in config.sh: registered (faked)"
