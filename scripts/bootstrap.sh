#!/usr/bin/env bash
# Get Worklane installed and running on a fresh Mac or Linux machine, for one user, then set up a repo.
# Safe to run again: each step checks first and does nothing when it's already done.
#
#   bash scripts/bootstrap.sh [--mode local] <repo-dir>
#                                                 local mode (as you, no server): install the tools and the
#                                                 engine, start the repo's dashboard in the background, and
#                                                 print one URL, last: its first-run wizard, where every setup
#                                                 step happens. Rerun: the same URL, nothing changed. The URL
#                                                 carries no key: the page asks once for the dashboard key,
#                                                 kept in a file only you can read (the path is printed).
#                                                 Without --mode it asks; with no terminal to ask on, local.
#   bash scripts/bootstrap.sh --config <file> <repo-dir>
#                                                 the same, unattended: the wizard's steps run here first
#                                                 (`worklane init --yes`, with the file's answers), then
#                                                 `worklane doctor`, then the same URL. The file holds
#                                                 key=value lines: mode=local|server, answer=<id>=<choice>
#                                                 (repeatable), machine_owner=<login>, public_url=<https url>.
#                                                 --yes alone: the same with no answers.
#   bash scripts/bootstrap.sh --no-repo           the tools and the engine only (e.g. in an image)
#   bash scripts/bootstrap.sh --dry-run <repo>    print what it would do; change nothing
#   bash scripts/bootstrap.sh --engine <spec> ... install the engine from <spec> (an npm tarball or spec)
#                                                 instead of the pinned release
#   sudo bash scripts/bootstrap.sh --hardened [--machine-owner <login>] [--public-url <url>] <name> <owner/repo>
#                                                 Linux (apt + systemd): the multi-user setup scripts in
#                                                 scripts/setup/, in order, each printed for review first.
#                                                 You become the machine's first owner (your GitHub login:
#                                                 asked, or read from gh and confirmed); it ends with one URL,
#                                                 checked to answer first: on a fresh machine the hub's setup
#                                                 mode (it makes the sign-in App) at the https origin (from
#                                                 Tailscale or --public-url); with no origin yet, the same page on
#                                                 http://127.0.0.1:4399/, with the ssh -L line that reaches it
#                                                 (its App step shows Tailscale and HTTPS first); then the hub's
#                                                 first-run wizard. No key or token in it: the page asks, from a
#                                                 0600 file. When nothing answers, no URL: the reason, the fix,
#                                                 exit 4.
#                                                 The instance's credentials, checkout and service: Add project,
#                                                 add-project.sh at a root shell for the machine's first project
#                                                 (the dashboard's Add project for the ones after it).
#                                                 This is server mode (--mode server alone points here).
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
# this script ships in (package.json's repository, beside it or one level up). Both lines are written by
# `node scripts/pin-engine.mjs <tag>` once the signed tag exists: it checks the tag's signature and that its commit
# is a release commit, then writes them. Never by hand: an empty or partial ENGINE_COMMIT is refused below.
ENGINE_TAG=v0.5.2
ENGINE_COMMIT=0b98938563617e74686bf913fc922ee77cb68f90

PREFIX="${WORKLANE_PREFIX:-$HOME/.local}"
DRY=0 NO_REPO=0 HARDENED=0 YES=0 AFTER_CREDENTIALS=0
REPO="" ENGINE="" NAME="" GITHUB="" OWNER="" PUBLIC_URL="" MODE="" CONFIG=""
ANSWERS=()

usage() { sed -n '2,/^# Nothing is piped/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'; }
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
    --mode)
      [ $# -ge 2 ] || die "--mode needs local or server"
      case "$2" in local | server) MODE="$2" ;; *) die "--mode is local or server, not $2" ;; esac
      shift ;;
    --machine-owner) [ $# -ge 2 ] || die "--machine-owner needs a GitHub login"; OWNER="$2"; shift ;;
    --public-url) [ $# -ge 2 ] || die "--public-url needs a value"; PUBLIC_URL="$2"; shift ;;
    --after-credentials) AFTER_CREDENTIALS=1 ;;
    --config) [ $# -ge 2 ] || die "--config needs a file"; CONFIG="$2"; YES=1; shift ;;
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

# WHY: the unattended twin of the wizard. key=value lines, read as data (never sourced); what the command line
# gives wins over the file.
read_config() {
  local line key val n=0
  [ -f "$CONFIG" ] && [ -r "$CONFIG" ] || die "--config: no readable file $CONFIG"
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    line="${line%$'\r'}"
    case "$line" in "" | "#"*) continue ;; esac
    [[ "$line" == *=* ]] || die "$CONFIG:$n: not key=value: $line"
    key="${line%%=*}" val="${line#*=}"
    case "$key" in
      mode)
        case "$val" in local | server) [ -n "$MODE" ] || MODE="$val" ;; *) die "$CONFIG:$n: mode is local or server, not $val" ;; esac ;;
      answer)
        [[ "$val" =~ ^[a-z0-9-]+=.+$ ]] || die "$CONFIG:$n: answer is <question id>=<choice>, not $val"
        ANSWERS+=(--answer "$val") ;;
      machine_owner) [ -n "$OWNER" ] || OWNER="$val" ;;
      public_url) [ -n "$PUBLIC_URL" ] || PUBLIC_URL="$val" ;;
      *) die "$CONFIG:$n: unknown key $key (mode, answer, machine_owner, public_url)" ;;
    esac
  done < "$CONFIG"
}
[ -z "$CONFIG" ] || read_config

OS="$(uname -s)"
case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac
case "$OS" in Darwin | Linux) ;; *) die "unsupported system $OS (macOS and Linux only; on Windows, use WSL or the Docker image)" ;; esac

sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# Download $1 to $2 and refuse it unless its sha256 is $3. --retry: a CDN's passing 5xx (a 504 from GitHub's release
# host failed main's bootstrap job, 2026-10-15) is tried again, up to 3 times; the checksum below decides either way.
fetch_checked() {
  local url="$1" out="$2" want="$3" got
  curl -fsSL --retry 3 -o "$out" "$url"
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

# The hub's ports (src/dashboard-hub.ts): its sign-in port (tailscale serve forwards the https origin to it; setup mode
# serves there too) and the owner's break-glass, loopback only. Its units are dashboards.sh's.
HUB_PORT=4399
HUB_BREAK_GLASS_PORT=4398
HUB_UNIT=worklane-dashboard-hub.service
HUB_SETUP_UNIT=worklane-dashboard-hub-setup.service

# One scripts/setup step as root: printed for review and confirmed first, unless --yes (or a dry run).
setup_step() {
  local step="$1" script="${1%% *}" answer
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
}

# WHY: a printed URL that answers nothing (HTTP 000 on a fresh server, #393) is worse than none: each is asked first.
answers() { [ "$DRY" = 1 ] || [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" 2>/dev/null || true)" = 200 ]; }
unit_active() { systemctl is-active --quiet "$1" 2>/dev/null; }
# Setup mode running with these arguments (--loopback, or --public-url <url>): a rerun leaves it, and its token, alone.
setup_serves() { unit_active "$HUB_SETUP_UNIT" && systemctl show -p ExecStart --value "$HUB_SETUP_UNIT" 2>/dev/null | grep -qF -- " $1 "; }
# Where an ssh tunnel to this machine starts from: the user who ran sudo and this machine's name, each only when it is
# a plain name (it is printed as a command to copy); otherwise <you>@<this machine>.
ssh_target() {
  local u="${SUDO_USER:-}" h=""
  h="$(hostname 2>/dev/null || true)"
  [[ "$u" =~ ^[a-z_][a-z0-9_.-]{0,31}$ ]] && [ "$u" != root ] || u=""
  [[ "$h" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ ]] || h=""
  if [ -n "$u" ] && [ -n "$h" ]; then printf '%s@%s' "$u" "$h"; else printf '%s@%s' "${u:-<you>}" "${h:-<this machine>}"; fi
}
# No URL this time: why, and the command that fixes it. Exit 4: installed, but nothing to open yet.
no_url() {
  if [ "$DRY" = 1 ]; then printf '   would end with no URL: %s (fix: %s)\n' "$1" "$2"; exit 0; fi
  echo
  echo "no URL to open yet: $1."
  echo "   fix: $2"
  exit 4
}

# The dashboard hub: everything after this first install happens there.
# INVARIANT: the output ends with one URL that answered 200 just now, the only URL in this block, with no key or
# token in it; or with no URL at all, the reason and the fix (no_url). Rerun, it changes nothing that's running.
#   - no sign-in App yet: the hub's setup mode (dashboards.sh --setup) at the hub's https origin; it asks for its
#     one-time setup token, from a 0600 file of the hub's user. With no origin yet (owner, 2026-10-14: the one command
#     always ends with a working URL), setup mode on loopback (--setup --loopback) at http://127.0.0.1:4399/, reached
#     through the ssh -L line printed above it; its App step waits for the origin (screen 7, Tailscale and HTTPS), and
#     the run after that restarts setup mode at the origin.
#   - the sign-in App made, no hub yet: the hub alone (dashboards.sh --no-instances, with what setup mode stored).
#   - a hub: its https origin's /first-run, else the owner's break-glass on this machine (it asks for the hub's key).
dashboard_next() {
  local url="$PUBLIC_URL" viewer_home="" dns="" signin_dir hub_state final="" c
  if [ -z "$url" ] && command -v tailscale >/dev/null 2>&1; then
    # The first DNSName in `tailscale status --json` is this machine's (Self comes before the peers).
    dns="$(tailscale status --json 2>/dev/null | sed -n 's/^ *"DNSName": *"\([a-z0-9.-]*[a-z0-9]\)\.\{0,1\}",\{0,1\} *$/\1/p' | head -1 || true)"
    [ -z "$dns" ] || url="https://$dns"
  fi
  if command -v getent >/dev/null 2>&1; then viewer_home="$(getent passwd wl-dash | cut -d: -f6 || true)"; fi
  signin_dir="${viewer_home:-~wl-dash}/.config/dashboard-signin"
  hub_state="${viewer_home:-~wl-dash}/.local/state/$CLI/dashboard-hub"
  # What setup mode stored, when not given: the hub's https origin.
  if [ -z "$url" ] && [ -s "$signin_dir/public-url" ]; then url="$(cat "$signin_dir/public-url")"; fi

  if [ ! -f "$signin_dir/client-secret" ]; then
    if [ -z "$url" ]; then
      setup_serves --loopback || setup_step "dashboards.sh --setup --loopback"
      say "the dashboard: everything after this first install happens there"
      echo "   No sign-in App yet, and no https origin for it: the hub's setup mode answers on this machine only (port $HUB_PORT)."
      echo "   Its sign-in App step needs the https origin first: the page shows Tailscale and HTTPS (screen 7) and how;"
      echo "   run this again once that's done, and setup mode moves to the origin, where the App step goes on."
      echo "   From your own computer, first: ssh -L $HUB_PORT:127.0.0.1:$HUB_PORT $(ssh_target)"
      echo "   The page asks for a one-time setup token: sudo cat $hub_state/setup-token on this machine (it is never"
      echo "   printed, logged or put in a link)."
      final="http://127.0.0.1:$HUB_PORT/"
      answers "$final" || no_url "the hub's setup mode doesn't answer on this machine (port $HUB_PORT)" \
        "sudo systemctl status $HUB_SETUP_UNIT (journalctl -u $HUB_SETUP_UNIT says why), then run this again"
    else
      setup_serves "--public-url $url" || setup_step "dashboards.sh --setup --public-url $url"
      say "the dashboard: everything after this first install happens there"
      echo "   No sign-in App yet: the hub's setup mode makes it with GitHub (Connect GitHub), then turns itself off."
      echo "   The page asks for a one-time setup token: sudo cat $hub_state/setup-token on this machine (it is never"
      echo "   printed, logged or put in a link)."
      final="$url/"
      answers "$final" || no_url "the hub's setup mode runs on this machine (port $HUB_PORT), but $url doesn't reach it" \
        "sudo tailscale serve --bg --https=443 http://127.0.0.1:$HUB_PORT, then run this again"
    fi
  else
    if ! unit_active "$HUB_UNIT"; then
      [ ! -f "/etc/systemd/system/$HUB_UNIT" ] || no_url "the hub is installed but not running" "sudo systemctl start $HUB_UNIT (journalctl -u $HUB_UNIT says why it stopped), then run this again"
      [ -s "$signin_dir/client-id" ] && [ -n "$url" ] || no_url "the sign-in App is set up, but the hub has no client id or https origin on file" \
        "sudo bash scripts/setup/dashboards.sh --no-instances --client-id <the App's client id> --public-url https://<machine>.<tailnet>.ts.net, then run this again"
      setup_step "dashboards.sh --no-instances"
    fi
    say "the dashboard: everything after this first install happens there"
    for c in ${url:+"$url/first-run"} "http://127.0.0.1:$HUB_BREAK_GLASS_PORT/first-run"; do
      if answers "$c"; then final="$c"; break; fi
    done
    [ -n "$final" ] || no_url "the hub doesn't answer on this machine" "sudo systemctl status $HUB_UNIT; then sudo bash scripts/setup/dashboards.sh <name>... (or --no-instances before the first project)"
    if [ "$final" != "http://127.0.0.1:$HUB_BREAK_GLASS_PORT/first-run" ]; then
      ok "sign in with GitHub as @$OWNER"
    else
      if [ -n "$url" ]; then
        echo "   The hub's https origin doesn't reach it yet (tailscale serve on port 443 to the hub's port $HUB_PORT: docs/dashboard.md);"
      else
        echo "   This machine has no https origin yet (Tailscale with MagicDNS and HTTPS certificates, or --public-url);"
      fi
      echo "   until then, the owner's way in, on this machine only."
      echo "   From your own computer, first: ssh -L $HUB_BREAK_GLASS_PORT:127.0.0.1:$HUB_BREAK_GLASS_PORT $(ssh_target)"
      echo "   The page asks once for the hub's key: it is in $hub_state/dashboard-token (root and the hub's user only)."
    fi
  fi
  echo "   The same steps from a terminal: sudo $CLI init --mode server <owner/repo> --instance $NAME"
  echo "$final"
}

# The mode: --hardened is server mode; without either, ask (or, with no terminal to ask on, local).
if [ "$HARDENED" = 1 ]; then
  [ "$MODE" != local ] || die "--hardened is server mode, not local; leave out one of them"
  MODE=server
elif [ "$MODE" = server ]; then
  die "server mode is the hardened multi-user Linux setup: sudo bash scripts/bootstrap.sh --hardened <instance-name> <owner/repo>"
elif [ -z "$MODE" ] && [ "$NO_REPO" = 0 ]; then
  if [ "$YES" = 0 ] && [ "$DRY" = 0 ] && [ -t 0 ] && [ -t 1 ]; then
    printf 'Where should %s run?\n  local   on this machine, as you (macOS, Linux, or Windows through WSL2); no server, no ssh\n  server  a hardened multi-user Linux server (as root: separate users per project)\nlocal or server? ' "$CLI"
    read -r answer || answer=""
    case "$answer" in
      l | local) MODE=local ;;
      s | server) die "server mode: sudo bash scripts/bootstrap.sh --hardened <instance-name> <owner/repo> (docs/quickstart.md)" ;;
      *) die "\"$answer\" is neither local nor server" ;;
    esac
  else
    MODE=local
    echo "bootstrap: no --mode, and no terminal to ask on: local mode (this machine, as you)"
  fi
fi

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
  # The engine (#832): the pinned release, its tag checked by engine.sh at install time against ENGINE_COMMIT and the
  # signers in this checkout's .github/release-signers, then built by that commit id; never origin's tag by name.
  # A full commit id in ENGINE_TAG (only in a copy made for a test install, as CI's server-mode jobs make) is installed
  # by that id: a commit id is its own checksum, so no tag is involved.
  if [[ "$ENGINE_TAG" =~ ^[0-9a-f]{40}$ ]]; then
    engine_step="engine.sh $ENGINE_TAG"
  elif [[ "$ENGINE_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    [[ "$ENGINE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "the pinned engine $ENGINE_TAG has no release commit in this script (ENGINE_COMMIT is '$ENGINE_COMMIT', not a full commit id): use a copy of this script from after it was pinned"
    engine_step="engine.sh --release $ENGINE_TAG $ENGINE_COMMIT"
  else
    die "the pinned engine ENGINE_TAG=$ENGINE_TAG is neither a release tag vX.Y.Z nor a full commit id: nothing to install it by"
  fi
  # After the credentials, the first owner is already on file: read it back rather than ask again.
  if [ "$AFTER_CREDENTIALS" = 1 ] && [ -z "$OWNER" ] && [ -s "$MACHINE_OWNERS" ]; then OWNER="$(sed -n 's/^{"owners":\["\([A-Za-z0-9-]*\)".*/\1/p' "$MACHINE_OWNERS")"; fi
  first_owner
  # Each step: the script and its arguments. Credentials need your hands in between (see below).
  steps=("node.sh $NODE_VERSION" "machine.sh" "machine-owners.sh --first $OWNER" "tools.sh $CLAUDE_VERSION" "instance.sh $NAME" "$engine_step $NAME $GITHUB")
  [ "$AFTER_CREDENTIALS" = 1 ] && steps=("checkout.sh $NAME $GITHUB" "service.sh $NAME" "check.sh $NAME")
  for step in "${steps[@]}"; do
    script="${step%% *}"
    rc=0
    setup_step "$step" || rc=$?
    # 3 is a setup script's "waiting" (service.sh: the repo's setup PR isn't merged yet): not done, and not a failure.
    if [ "$rc" = 3 ]; then
      echo
      echo "waiting: scripts/setup/$script waits for what it says above; once that's done, run this again (it picks up there):"
      echo "   sudo bash scripts/bootstrap.sh --hardened --after-credentials $NAME $GITHUB"
      exit 3
    fi
    [ "$rc" = 0 ] || exit "$rc"
  done
  if [ "$AFTER_CREDENTIALS" = 0 ]; then
    # WHY (#739): one answer for the instance's credentials, the same steps as the dashboard's: Add project. It makes the
    # agents' App through GitHub's manifest flow only, waits for root to install the agents' Claude login, then the
    # checkout and the service. Never an App made by hand or a token pasted here. --after-credentials stays, for an
    # install whose credentials were stored by hand.
    # A machine's first project has no dashboard of its own yet (the hub runs with no instance, and Add project's page
    # is an instance dashboard's): the root shell leads; the dashboard's Add project is for the projects after it.
    say "next: Add project, for $NAME's credentials, checkout and service"
    echo "   At a root shell on this machine (a machine's first project has no dashboard of its own to do it from yet):"
    echo "   sudo bash scripts/setup/add-project.sh $NAME $GITHUB"
    echo "   It makes the agents' GitHub App through GitHub's manifest flow (installed on $GITHUB only), waits for the"
    echo "   agents' Claude login, then sets up the checkout and starts the service; run it again after a wait or a stop."
    echo "   Later projects: the dashboard's Setup console's Add project, once you are signed in."
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
  # WHY: the commit is the engine's only checksum; without a full one there is nothing to check a fetch against.
  [[ "$ENGINE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "the pinned engine $ENGINE_TAG has no release commit in this script yet (ENGINE_COMMIT is '$ENGINE_COMMIT', not a full commit id): use a copy of this script from after it was pinned, or pass --engine <spec>"
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

path_note() {
  case ":$ORIG_PATH:" in
    *":$PREFIX/bin:"*) ;;
    *) echo "   note: $PREFIX/bin isn't on your PATH: add it in your shell profile (export PATH=\"$PREFIX/bin:\$PATH\")" ;;
  esac
}

# WHY: an engine older than the wizard (the pinned release can be) has no `dashboard --detach`: the checklist then
# runs here, as it always has, and the script says so.
WIZARD=0
engine_help="$(command -v "$CLI" >/dev/null 2>&1 && "$CLI" --help 2>/dev/null || true)"
[[ "$engine_help" != *"dashboard --detach"* ]] || WIZARD=1

# INVARIANT: this is the script's last output, ending with the one URL (`dashboard --detach` prints it last); its
# exit status is the script's. A browser opens only for a person at a terminal.
open_wizard() {
  local args=(dashboard --detach --root "$REPO")
  [ "$YES" = 0 ] && [ -t 1 ] || args+=(--no-open)
  say "the first-run wizard: $REPO's dashboard, in the background"
  run "$CLI" "${args[@]}"
}

if [ "$WIZARD" = 1 ] && [ "$YES" = 0 ]; then
  path_note
  open_wizard
  exit $?
fi
[ "$WIZARD" = 1 ] || [ "$YES" = 1 ] || [ "$DRY" = 1 ] || echo "   note: this engine ($("$CLI" --version 2>/dev/null || echo '?')) has no first-run wizard to open yet: the checklist runs here instead"

say "set up $REPO: the guided checklist ($CLI init, $MODE mode)"
init_args=(init --mode "$MODE")
[ "$YES" = 0 ] || init_args+=(--yes)
status=0
run "$CLI" "${init_args[@]}" ${ANSWERS[@]+"${ANSWERS[@]}"} "$REPO" || status=$?
# WHY (#469): init stopped only for the CI choice (exit 5: the repo names no required check and no ci: none). That
# choice is the wizard's (Required checks named: a starter CI, or No CI), so unattended too it ends at the wizard's
# URL, as the interactive install does.
if [ "$status" = 5 ] && [ "$WIZARD" = 1 ] && [ "$DRY" = 0 ]; then
  echo
  echo "init stopped only for the CI choice: make it in the wizard (Required checks named), then run this again"
  path_note
  open_wizard
  exit $?
fi
if [ "$status" != 0 ]; then
  echo
  echo "init stopped (exit $status): fix what it says, then run this again; it picks up where it stopped"
  exit "$status"
fi

say "check it"
path_note
if [ "$DRY" = 1 ]; then
  printf '   would run: %s doctor --root %s\n' "$CLI" "$REPO"
  [ "$WIZARD" = 0 ] || open_wizard
  exit 0
fi
"$CLI" doctor --root "$REPO" || status=$?
if [ "$status" = 0 ]; then
  echo
  echo "next: $CLI up --root $REPO        (starts the coordinator as a service; or the wizard's Start)"
  [ "$WIZARD" = 1 ] || echo "      $CLI dashboard --root $REPO (the dashboard; its First-run page has the checklist)"
  echo "      docs/quickstart.md: look over the owners in .worklane/config.yaml (\"Setting up a project by"
  echo "      hand\"), then your first issue, and where to look"
  if [ "$WIZARD" = 1 ]; then
    open_wizard
    exit $?
  fi
fi
exit "$status"
