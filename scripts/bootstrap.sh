#!/usr/bin/env bash
# Get Worklane installed and running on a fresh Mac or Linux machine, for one user, then set up a repo.
# Safe to run again: each step checks first and does nothing when it's already done.
#
#   bash scripts/bootstrap.sh <repo-dir>          install the tools and the engine, `worklane install` in the
#                                                 repo, then `worklane doctor` (its exit status is this script's)
#   bash scripts/bootstrap.sh --no-repo           the tools and the engine only (e.g. in an image)
#   bash scripts/bootstrap.sh --dry-run <repo>    print what it would do; change nothing
#   bash scripts/bootstrap.sh --engine <spec> ... install the engine from <spec> (an npm tarball or spec)
#                                                 instead of the pinned release
#   sudo bash scripts/bootstrap.sh --hardened [--machine-owner <login>] [--public-url <url>] <name> <owner/repo>
#                                                 Linux (apt + systemd): the multi-user setup scripts in
#                                                 scripts/setup/, in order, each printed for review first.
#                                                 You become the machine's first owner (your GitHub login:
#                                                 asked, or read from gh and confirmed); at the end it prints
#                                                 the dashboard's URL, where everything after this happens
#
# Nothing is piped from the network into a shell. Everything it downloads is pinned and checked: Node.js and
# gitleaks against the sha256 sums below, the engine by its release commit, Claude Code by npm's integrity
# check of a pinned version. On a Mac, Node comes from Homebrew (install Homebrew yourself first).
# Single-user installs go under $HOME/.local (override with WORKLANE_PREFIX); nothing needs sudo.
set -euo pipefail

CLI=worklane
NODE_VERSION=v24.21.0
# Node 22.13 or newer is supported and kept; when it is missing or older, the bootstrap installs Node 24 LTS.
NODE_MIN=22.13
NODE_SHA256_LINUX_X64=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
NODE_SHA256_LINUX_ARM64=6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2
GITLEAKS_VERSION=8.30.1
GITLEAKS_SHA256_LINUX_X64=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
GITLEAKS_SHA256_LINUX_ARM64=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080
GITLEAKS_SHA256_DARWIN_X64=dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709
GITLEAKS_SHA256_DARWIN_ARM64=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5
CLAUDE_VERSION=2.1.296
# The engine: a release tag, installed by its commit (the tag's commit carries the built dist/), from the repo
# this script ships in (package.json's repository, beside it or one level up).
ENGINE_TAG=v0.4.1
ENGINE_COMMIT=9c24a10eb91ffac894e24f0b0a54d8407f23d423

PREFIX="${WORKLANE_PREFIX:-$HOME/.local}"
DRY=0 NO_REPO=0 HARDENED=0 YES=0 AFTER_CREDENTIALS=0
REPO="" ENGINE="" NAME="" GITHUB="" OWNER="" PUBLIC_URL=""

usage() { sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; }
die() { echo "bootstrap: $*" >&2; exit 1; }
say() { printf '\n== %s\n' "$*"; }
ok() { printf '   ok: %s\n' "$*"; }
# Run a command, or in a dry run only print it.
run() {
  if [ "$DRY" = 1 ]; then printf '   would run: %s\n' "$*"; else "$@"; fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help) usage; exit 0 ;;
    --dry-run) DRY=1 ;;
    --no-repo) NO_REPO=1 ;;
    --yes) YES=1 ;;
    --engine) [ $# -ge 2 ] || die "--engine needs a value"; ENGINE="$2"; shift ;;
    --hardened) HARDENED=1 ;;
    --machine-owner) [ $# -ge 2 ] || die "--machine-owner needs a GitHub login"; OWNER="$2"; shift ;;
    --public-url) [ $# -ge 2 ] || die "--public-url needs a value"; PUBLIC_URL="$2"; shift ;;
    --after-credentials) AFTER_CREDENTIALS=1 ;;
    -*) echo "bootstrap: unknown option $1" >&2; usage >&2; exit 2 ;;
    *)
      if [ "$HARDENED" = 1 ] && [ -z "$NAME" ]; then NAME="$1"
      elif [ "$HARDENED" = 1 ] && [ -z "$GITHUB" ]; then GITHUB="$1"
      elif [ -z "$REPO" ]; then REPO="$1"
      else echo "bootstrap: unexpected argument $1" >&2; exit 2
      fi ;;
  esac
  shift
done

OS="$(uname -s)"
case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac
case "$OS" in Darwin | Linux) ;; *) die "unsupported system $OS (macOS and Linux only; on Windows, use WSL or the Docker image)" ;; esac

sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# Download $1 to $2 and refuse it unless its sha256 is $3.
fetch_checked() {
  local url="$1" out="$2" want="$3" got
  curl -fsSL -o "$out" "$url"
  got="$(sha256_of "$out")"
  [ "$got" = "$want" ] || { rm -f "$out"; die "checksum mismatch for $url: got $got, want $want"; }
}

# Is version $1 (x.y.z, a leading v allowed) at least $2 (x.y)?
at_least() {
  local have="${1#v}" want="$2" hmaj hmin wmaj wmin
  hmaj="${have%%.*}"; hmin="${have#*.}"; hmin="${hmin%%.*}"
  wmaj="${want%%.*}"; wmin="${want#*.}"
  [ "$hmaj" -gt "$wmaj" ] || { [ "$hmaj" -eq "$wmaj" ] && [ "$hmin" -ge "$wmin" ]; }
}

# ---------------------------------------------------------------- hardened (multi-user, Linux)

# The machine owners file (scripts/setup/lib.sh, src/machine-owners.ts).
MACHINE_OWNERS="/etc/$CLI/machine-owners.json"
LOGIN_RE='^[A-Za-z0-9](-?[A-Za-z0-9])*$'
login_ok() { [ "${#1}" -le 39 ] && [[ "$1" =~ $LOGIN_RE ]]; }

# Who is installing, as a GitHub login: the machine's first owner (src/machine-owners.ts), who may add projects
# from the dashboard. --machine-owner; else what gh says (as the person who ran sudo), confirmed; else asked.
first_owner() {
  local found="" answer=""
  if [ -z "$OWNER" ] && command -v gh >/dev/null 2>&1; then
    if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then found="$(sudo -H -u "$SUDO_USER" gh api user --jq .login 2>/dev/null || true)"
    else found="$(gh api user --jq .login 2>/dev/null || true)"; fi
    login_ok "$found" || found=""
  fi
  if [ -z "$OWNER" ] && [ -n "$found" ]; then
    if [ "$YES" = 1 ] || [ "$DRY" = 1 ]; then
      OWNER="$found"
    else
      printf "You are @%s on GitHub (from gh), and become this machine's first owner. Right? [Y/n] " "$found"
      read -r answer </dev/tty || answer=n
      case "$answer" in "" | y | Y | yes) OWNER="$found" ;; esac
    fi
  fi
  if [ -z "$OWNER" ] && [ "$DRY" = 1 ]; then
    OWNER="<login>"
    printf '   would ask for your GitHub login (or give --machine-owner <login>)\n'
    return 0
  fi
  if [ -z "$OWNER" ]; then
    [ "$YES" = 0 ] || die "who is installing? give your GitHub login with --machine-owner <login> (gh isn't signed in here)"
    printf "Your GitHub login (you become this machine's first owner, who adds projects from the dashboard): "
    read -r OWNER </dev/tty || OWNER=""
  fi
  login_ok "$OWNER" || die "\"$OWNER\" isn't a GitHub login (letters, digits and single dashes, at most 39)"
  ok "first machine owner: @$OWNER"
}

# The dashboard: its URL (--public-url, else this machine's Tailscale name), the sign-in App (made through
# GitHub's manifest flow when the hub is up; otherwise how to), and that everything after this happens there.
dashboard_next() {
  local url="$PUBLIC_URL" viewer_home="" dns="" later="https://<machine>.<tailnet>.ts.net"
  if [ -z "$url" ] && command -v tailscale >/dev/null 2>&1; then
    # The first DNSName in `tailscale status --json` is this machine's (Self comes before the peers).
    dns="$(tailscale status --json 2>/dev/null | sed -n 's/^ *"DNSName": *"\([a-z0-9.-]*[a-z0-9]\)\.\{0,1\}",\{0,1\} *$/\1/p' | head -1 || true)"
    [ -z "$dns" ] || url="https://$dns"
  fi
  if command -v getent >/dev/null 2>&1; then viewer_home="$(getent passwd wl-dash | cut -d: -f6 || true)"; fi
  say "the dashboard"
  if [ -n "$viewer_home" ] && [ -f "$viewer_home/.config/dashboard-signin/client-secret" ]; then
    ok "the sign-in App is set up"
  elif [ -n "$viewer_home" ] && [ -s "$viewer_home/.local/state/$CLI/dashboard-hub/dashboard-token" ] && [ -n "$url" ]; then
    echo "   no sign-in App yet: making one through GitHub's manifest flow (open the link it prints, approve on GitHub)"
    run "$CLI" app-manifest "$NAME" "$GITHUB" --signin --public-url "$url" || echo "   that didn't finish: run it again, or make the App by hand (bash scripts/setup/credentials.sh dashboard-signin)"
  else
    echo "   no sign-in App yet. People sign in to the dashboard with a GitHub App; make it once, either way:"
    echo "   - through GitHub's manifest flow, once the hub runs: sudo $CLI app-manifest $NAME $GITHUB --signin --public-url ${url:-$later}"
    echo "   - by hand: bash scripts/setup/credentials.sh dashboard-signin (docs/dashboard.md)"
  fi
  echo "   then: sudo bash scripts/setup/dashboards.sh --machine-owner $OWNER --client-id <the App's client id> --public-url ${url:-$later} $NAME"
  echo
  echo "dashboard: ${url:-$later (turn on Tailscale with MagicDNS and HTTPS certificates: docs/dashboard.md)}"
  echo "   sign in with GitHub as @$OWNER. Everything after this first install happens there: Setup console, Add project."
}

if [ "$HARDENED" = 1 ]; then
  [ "$OS" = Linux ] || die "--hardened is for Linux servers (apt and systemd); on a Mac use the single-user path"
  command -v apt-get >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1 || die "--hardened needs apt-get and systemd"
  [ -n "$NAME" ] && [ -n "$GITHUB" ] || die "usage: bootstrap.sh --hardened <instance-name> <owner/repo>"
  [[ "$NAME" =~ ^[a-z][a-z0-9-]{0,20}$ ]] || die "instance name must be lowercase letters, digits and dashes"
  [[ "$GITHUB" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]] || die "the repo must be owner/name"
  setup="$(cd "$(dirname "$0")" && pwd)/setup"
  [ -d "$setup" ] || die "run this from a checkout of the engine repo (no $setup)"
  [ "$DRY" = 1 ] || [ "$(id -u)" -eq 0 ] || die "--hardened runs the setup scripts as root: run it with sudo"
  [ -z "$PUBLIC_URL" ] || [[ "$PUBLIC_URL" =~ ^https://[a-z0-9.-]+$ ]] || die "--public-url: the dashboard's https origin (https://<machine>.<tailnet>.ts.net)"
  # After the credentials, the first owner is already on file: read it back rather than ask again.
  if [ "$AFTER_CREDENTIALS" = 1 ] && [ -z "$OWNER" ] && [ -s "$MACHINE_OWNERS" ]; then OWNER="$(sed -n 's/^{"owners":\["\([A-Za-z0-9-]*\)".*/\1/p' "$MACHINE_OWNERS")"; fi
  first_owner
  # Each step: the script and its arguments. Credentials need your hands in between (see below).
  steps=("node.sh $NODE_VERSION" "machine.sh" "machine-owners.sh --first $OWNER" "tools.sh $CLAUDE_VERSION" "instance.sh $NAME" "engine.sh $ENGINE_TAG $NAME $GITHUB")
  [ "$AFTER_CREDENTIALS" = 1 ] && steps=("checkout.sh $NAME $GITHUB" "service.sh $NAME" "check.sh $NAME")
  for step in "${steps[@]}"; do
    script="${step%% *}"
    say "scripts/setup/$step"
    [ -f "$setup/$script" ] || die "no $setup/$script"
    if [ "$YES" = 0 ] && [ "$DRY" = 0 ]; then
      ${PAGER:-less} "$setup/$script" </dev/tty || cat "$setup/$script"
      printf 'Run scripts/setup/%s as root now? [y/N] ' "$step"
      read -r answer </dev/tty
      [ "$answer" = y ] || die "stopped before $script; nothing after it ran"
    fi
    # shellcheck disable=SC2086 # the step's arguments are words
    run bash "$setup/$script" ${step#"$script"}
  done
  if [ "$AFTER_CREDENTIALS" = 0 ]; then
    say "next, by hand: the instance's credentials"
    echo "   bash scripts/setup/credentials.sh $NAME github-app <app-id> <installation-id> <key.pem> $GITHUB"
    echo "   bash scripts/setup/credentials.sh $NAME claude"
    echo "   then: sudo bash scripts/bootstrap.sh --hardened --after-credentials $NAME $GITHUB"
    echo "   (docs/separate-users.md has the details)"
  fi
  dashboard_next
  exit 0
fi

# ---------------------------------------------------------------- single user

[ "$NO_REPO" = 1 ] || [ -n "$REPO" ] || { echo "bootstrap: give the repo to set up, or --no-repo" >&2; usage >&2; exit 2; }
if [ "$NO_REPO" = 0 ]; then
  [ -d "$REPO" ] || die "no directory $REPO"
  REPO="$(cd "$REPO" && pwd)"
  git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || die "$REPO is not a git repository"
fi
ORIG_PATH="$PATH"
export PATH="$PREFIX/bin:$PATH"
run mkdir -p "$PREFIX/bin" "$PREFIX/lib" "$PREFIX/share/$CLI-bootstrap"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

say "Node.js $NODE_MIN or newer"
have_node="$(node --version 2>/dev/null || true)"
if [ -n "$have_node" ] && at_least "$have_node" "$NODE_MIN"; then
  ok "node $have_node ($(command -v node))"
elif [ "$OS" = Darwin ]; then
  command -v brew >/dev/null 2>&1 || die "no Node.js $NODE_MIN+ and no Homebrew: install Homebrew (https://brew.sh) or Node.js 24 yourself, then run this again"
  run brew install node@24
  nb="$(brew --prefix node@24 2>/dev/null || echo /opt/homebrew/opt/node@24)/bin"
  for b in node npm npx; do run ln -sfn "$nb/$b" "$PREFIX/bin/$b"; done
else
  name="node-$NODE_VERSION-linux-$ARCH"
  if [ "$ARCH" = x64 ]; then sum="$NODE_SHA256_LINUX_X64"; else sum="$NODE_SHA256_LINUX_ARM64"; fi
  if [ "$DRY" = 1 ]; then
    printf '   would download %s (sha256 %s) to %s/lib\n' "$name.tar.xz" "$sum" "$PREFIX"
  else
    fetch_checked "https://nodejs.org/dist/$NODE_VERSION/$name.tar.xz" "$work/$name.tar.xz" "$sum"
    rm -rf "$PREFIX/lib/$name" && tar -xJf "$work/$name.tar.xz" -C "$PREFIX/lib"
  fi
  for b in node npm npx; do run ln -sfn "$PREFIX/lib/$name/bin/$b" "$PREFIX/bin/$b"; done
fi

say "gitleaks (the secret scan every agent commit runs)"
if command -v gitleaks >/dev/null 2>&1; then
  ok "gitleaks $(gitleaks version 2>/dev/null || echo '?') ($(command -v gitleaks))"
else
  os_l="$(echo "$OS" | tr '[:upper:]' '[:lower:]')"
  var="GITLEAKS_SHA256_$(echo "${OS}_${ARCH}" | tr '[:lower:]' '[:upper:]')"
  sum="${!var}"
  tgz="gitleaks_${GITLEAKS_VERSION}_${os_l}_${ARCH}.tar.gz"
  if [ "$DRY" = 1 ]; then
    printf '   would download %s (sha256 %s) to %s/bin\n' "$tgz" "$sum" "$PREFIX"
  else
    fetch_checked "https://github.com/gitleaks/gitleaks/releases/download/v$GITLEAKS_VERSION/$tgz" "$work/$tgz" "$sum"
    tar -xzf "$work/$tgz" -C "$work" gitleaks && install -m 0755 "$work/gitleaks" "$PREFIX/bin/gitleaks"
  fi
fi

say "Claude Code (the agents' runtime)"
if command -v claude >/dev/null 2>&1; then
  ok "claude $(claude --version 2>/dev/null | head -1) ($(command -v claude))"
else
  run npm install -g --prefix "$PREFIX" --no-audit --no-fund "@anthropic-ai/claude-code@$CLAUDE_VERSION"
fi

say "the $CLI engine"
marker="$PREFIX/share/$CLI-bootstrap/engine"
if [ -n "$ENGINE" ] && [ -f "$ENGINE" ]; then
  spec="$(cd "$(dirname "$ENGINE")" && pwd)/$(basename "$ENGINE")"
  id="tarball:$(sha256_of "$spec")"
elif [ -n "$ENGINE" ]; then
  spec="$ENGINE" id="spec:$ENGINE"
else
  here="$(cd "$(dirname "$0")" && pwd)"
  pkg=""
  for f in "$here/package.json" "$here/../package.json"; do [ -f "$f" ] && { pkg="$f"; break; }; done
  engine_repo="$([ -n "$pkg" ] && sed -n 's#.*"url": *"[^"]*github\.com/\([^/"]*/[^/".]*\).*#\1#p' "$pkg" | head -1 || true)"
  [ -n "$engine_repo" ] || die "can't tell the engine's repo (no package.json with a GitHub repository next to this script); pass --engine <spec>"
  spec="" id="release:$ENGINE_TAG:$ENGINE_COMMIT"
fi
if [ "$(cat "$marker" 2>/dev/null || true)" = "$id" ] && command -v "$CLI" >/dev/null 2>&1; then
  ok "$CLI $("$CLI" --version) ($id)"
else
  if [ -z "$spec" ]; then
    # The release commit itself (a commit id is its own checksum), packed here: npm's own install from a git
    # spec "prepares" it with a nested install that fails under a --prefix.
    url="https://github.com/$engine_repo.git"
    if [ "$DRY" = 1 ]; then
      printf '   would fetch %s at %s (%s), check the commit, and pack it\n' "$url" "$ENGINE_COMMIT" "$ENGINE_TAG"
      spec="$work/engine.tgz"
    else
      git init -q "$work/engine"
      git -C "$work/engine" fetch -q --depth 1 "$url" "$ENGINE_COMMIT"
      git -C "$work/engine" checkout -q --detach FETCH_HEAD
      [ "$(git -C "$work/engine" rev-parse HEAD)" = "$ENGINE_COMMIT" ] || die "fetched $url but got $(git -C "$work/engine" rev-parse HEAD), not $ENGINE_COMMIT"
      [ -f "$work/engine/dist/src/cli.js" ] || die "$ENGINE_TAG ($ENGINE_COMMIT) carries no built dist/: not a release commit"
      spec="$work/$( (cd "$work/engine" && npm pack --ignore-scripts --silent --pack-destination "$work") | tail -1)"
    fi
  fi
  # --ignore-scripts: a release carries its built dist/, so nothing needs to run at install.
  run npm install -g --prefix "$PREFIX" --ignore-scripts --no-audit --no-fund "$spec"
  if [ "$DRY" = 1 ]; then printf '   would record %s in %s\n' "$id" "$marker"; else printf '%s\n' "$id" > "$marker"; fi
fi

if [ "$NO_REPO" = 1 ]; then
  if [ "$DRY" = 0 ]; then "$CLI" --version >/dev/null || die "the engine doesn't run"; fi
  say "done: $CLI is in $PREFIX/bin"
  exit 0
fi

say "set up $REPO"
run "$CLI" install --root "$REPO"

say "check it"
case ":$ORIG_PATH:" in
  *":$PREFIX/bin:"*) ;;
  *) echo "   note: $PREFIX/bin isn't on your PATH: add it in your shell profile (export PATH=\"$PREFIX/bin:\$PATH\")" ;;
esac
if [ "$DRY" = 1 ]; then
  printf '   would run: %s doctor --root %s\n' "$CLI" "$REPO"
  exit 0
fi
status=0
"$CLI" doctor --root "$REPO" || status=$?
if [ "$status" = 0 ]; then
  echo
  echo "next: $CLI up --root $REPO        (starts the coordinator as a service)"
  echo "      $CLI dashboard --root $REPO (the dashboard)"
  echo "      docs/quickstart.md: set the repo and its owners in .worklane/config.yaml (\"Setting up a project by"
  echo "      hand\"), then your first issue, and where to look"
fi
exit "$status"
