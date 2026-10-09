#!/usr/bin/env bash
# Install a pinned Node.js system-wide, verified against the release's
# SHASUMS256.txt from the same nodejs.org directory.
#   bash scripts/setup/node.sh v22.23.3
source "$(dirname "$0")/lib.sh"
as_root "$@"
version="${1:?usage: node.sh <version, e.g. v22.23.3>}"
case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;; esac
existing="$(command -v node || true)"
if [ -n "$existing" ] && [ "$existing" != /usr/local/bin/node ]; then echo "another node is on PATH ($existing); remove it first" >&2; exit 1; fi
name="node-$version-linux-$arch"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
cd "$work"
say "download $name and its release checksums"
curl -fsSLO "https://nodejs.org/dist/$version/$name.tar.xz"
curl -fsSLO "https://nodejs.org/dist/$version/SHASUMS256.txt"
grep " $name.tar.xz\$" SHASUMS256.txt | sha256sum -c -
say "install to /opt/$name, linked from /usr/local/bin"
tar -xJf "$name.tar.xz" -C /opt
chown -R root:root "/opt/$name"
for b in node npm npx corepack; do ln -sfn "/opt/$name/bin/$b" "/usr/local/bin/$b"; done
/usr/local/bin/node --version
