#!/usr/bin/env bash
# CI only (ci-slow's wizard job, server mode): the claude every root and agent-user call reaches is the stand-in
# (scripts/ci/claude-stand-in.cjs), never the real CLI, which refuses CI's random setup token on the login's proof (one
# real call, #463). tools.sh, run by bootstrap --hardened, links /usr/local/bin/claude to the real CLI in node's prefix,
# so a bootstrap that runs it undoes any earlier pin.
#   pin     the link goes first (install would write through it), the stand-in in its place, and every other claude
#           root or the agent user can reach (node's prefix, anything else on their PATH) linked to it; then check
#   check   as root and as the agent user, `claude --version` must name the stand-in (only the real CLI answers it):
#           else this fails loudly, with that user's PATH and every claude on it
#   claude-stand-in-pin.sh pin|check <agent user>
set -euo pipefail
mode="${1:?usage: claude-stand-in-pin.sh pin|check <agent user>}" agent="${2:?usage: claude-stand-in-pin.sh pin|check <agent user>}"
here="$(cd "$(dirname "$0")" && pwd)"
if [ "$mode" = pin ]; then
  sudo rm -f /usr/local/bin/claude
  sudo install -m 0755 "$here/claude-stand-in.cjs" /usr/local/bin/claude
  for c in /opt/node-*/bin/claude $(sudo sh -c 'which -a claude' 2>/dev/null || true) $(cd / && sudo -H -u "$agent" sh -c 'which -a claude' 2>/dev/null || true); do
    if [ "$c" != /usr/local/bin/claude ] && { [ -e "$c" ] || [ -L "$c" ]; }; then echo "the stand-in also at $c (was $(readlink -f "$c"))"; sudo ln -sfn /usr/local/bin/claude "$c"; fi
  done
elif [ "$mode" != check ]; then
  echo "usage: claude-stand-in-pin.sh pin|check <agent user>" >&2
  exit 2
fi
for u in root "$agent"; do
  v="$(cd / && sudo -H -u "$u" timeout 60 claude --version 2>&1 || true)"
  case "$v" in
    *"claude stand-in"*) ;;
    *) echo "as $u, the real claude answers, not the stand-in: $v" >&2; sudo -H -u "$u" sh -c 'echo "PATH=$PATH"; which -a claude' >&2 || true; exit 1 ;;
  esac
done
echo "claude is the stand-in, for root and $agent"
