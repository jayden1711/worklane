#!/usr/bin/env bash
# Tools the users need, system-wide: gh (the coordinator reads its token
# through it), a pinned Claude Code (agent users run it), and a pinned
# gitleaks (the pre-commit secret scan on every agent commit fails closed
# without it).
#   bash scripts/setup/tools.sh <claude-code version, e.g. 2.1.282>
source "$(dirname "$0")/lib.sh"
as_root "$@"
version="${1:?usage: tools.sh <claude-code version>}"
command -v node >/dev/null || { echo "install Node first (node.sh)" >&2; exit 1; }

# gitleaks: the version and the sha256 of each release tarball are pinned here,
# so a download that doesn't match is refused. Change them only together.
gitleaks_version=8.30.1
gitleaks_sha256_x64=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
gitleaks_sha256_arm64=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080

say "gh, from the distribution"
apt-get install -y gh
gh --version | head -1

say "Claude Code $version, installed globally next to node and linked from /usr/local/bin"
npm install -g "@anthropic-ai/claude-code@$version"
prefix="$(npm prefix -g)"
ln -sfn "$prefix/bin/claude" /usr/local/bin/claude
# Root owns the install, so agent users can't update it; versions change only through this script.
/usr/local/bin/claude --version

say "gitleaks $gitleaks_version, checksum-pinned, in /usr/local/bin"
case "$(uname -m)" in
  x86_64) arch=x64 sum="$gitleaks_sha256_x64" ;;
  aarch64 | arm64) arch=arm64 sum="$gitleaks_sha256_arm64" ;;
  *) echo "no pinned gitleaks for $(uname -m)" >&2; exit 1 ;;
esac
if [ "$(/usr/local/bin/gitleaks version 2>/dev/null || true)" = "$gitleaks_version" ]; then
  echo "gitleaks $gitleaks_version already installed"
else
  work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
  tgz="gitleaks_${gitleaks_version}_linux_${arch}.tar.gz"
  curl -fsSL -o "$work/$tgz" "https://github.com/gitleaks/gitleaks/releases/download/v$gitleaks_version/$tgz"
  echo "$sum  $work/$tgz" | sha256sum -c -
  tar -xzf "$work/$tgz" -C "$work" gitleaks
  install -o root -g root -m 0755 "$work/gitleaks" /usr/local/bin/gitleaks
fi
/usr/local/bin/gitleaks version
