#!/usr/bin/env bash
# Tools the users need, system-wide: gh (the coordinator reads its token
# through it) and a pinned Claude Code (agent users run it).
#   bash scripts/setup/tools.sh <claude-code version, e.g. 2.1.282>
source "$(dirname "$0")/lib.sh"
as_root "$@"
version="${1:?usage: tools.sh <claude-code version>}"
command -v node >/dev/null || { echo "install Node first (node.sh)" >&2; exit 1; }

say "gh, from the distribution"
apt-get install -y gh
gh --version | head -1

say "Claude Code $version, installed globally next to node and linked from /usr/local/bin"
npm install -g "@anthropic-ai/claude-code@$version"
prefix="$(npm prefix -g)"
ln -sfn "$prefix/bin/claude" /usr/local/bin/claude
# Root owns the install, so agent users can't update it; versions change only through this script.
/usr/local/bin/claude --version
