#!/usr/bin/env bash
# Tailscale for the dashboard hub: put this machine on your tailnet and the hub on HTTPS, one step at a time. As root
# (review it first), except status. Optional: a machine without Tailscale keeps its hub where it is, and no step here
# runs unless you run it.
#
#   bash scripts/setup/tailscale.sh status [--json]
#   sudo bash scripts/setup/tailscale.sh install
#   sudo bash scripts/setup/tailscale.sh up
#   sudo bash scripts/setup/tailscale.sh serve
#   sudo bash scripts/setup/tailscale.sh serve-siri
#   sudo bash scripts/setup/tailscale.sh public-url
#
# status      whether tailscale is installed, its state, this machine's tailnet name, whether the tailnet issues an
#             HTTPS certificate for it, whether tailscale serve forwards to the hub, and the hub's URL now. Changes
#             nothing; any user may run it.
# install     Tailscale's own package from its apt repository for this distribution (Ubuntu, Debian), pinned: the
#             repository's signing key is fetched over https and must be the one key whose fingerprint lib.sh pins
#             (TAILSCALE_SIGNER_FPR), apt checks the index and the package against that key (signed-by), and the version
#             is the one lib.sh pins (TAILSCALE_VERSION). No install script is fetched or run. A tailscale that is
#             already there is left as it is.
# up          `tailscale up`, with no auth key (this script takes none, passes none, and drops TS_AUTHKEY from its
#             environment): it prints a login link and waits up to 10 minutes for you to open it and approve this
#             machine. The link is Tailscale's login page, checked strictly; it goes to your terminal, or, with
#             --for <instance> (which the machine helper passes, for the coordinator that asked), only to
#             $TAILSCALE_DIR/login-url, 0400 and that coordinator user's alone, for its dashboard to show a machine
#             owner. It is never in the journal, steps.jsonl or the machine changes log, and is deleted when up ends.
# serve       `tailscale serve --bg --https=443 http://127.0.0.1:4399`: https on this machine's tailnet name to the
#             hub's sign-in port, and to nothing else. Refused when the tailnet doesn't issue HTTPS certificates yet
#             (MagicDNS and HTTPS certificates, in Tailscale's admin console), when 443 already forwards somewhere
#             else, when anything forwards to the break-glass port 4398, and when Tailscale Funnel is on.
#             Never Funnel: this script has no funnel command and no flag that turns it on; serve is tailnet-only.
# serve-siri  `tailscale serve --bg --https=8443 http://127.0.0.1:4397`: https 8443 on this machine's tailnet name to the
#             hub's Siri gateway (dashboards.sh --siri; docs/siri.md), and to nothing else. Its own port, so the tailnet
#             policy can let only your phone reach it. Refused under the same conditions as serve, and when 8443
#             already forwards somewhere else. Never Funnel.
# public-url  the hub's URL becomes https://<this machine's tailnet name>, through dashboards.sh with the hub's other
#             settings as its unit has them (the sign-in App's client id, the instances, the owner terminal). Only once
#             serve forwards to the hub, and never while Funnel is on. The name is read here, from tailscale status,
#             and must be a *.ts.net name: no caller gives it, and no other host can be set. It writes the hub's and
#             the instance dashboards' units and restarts them; the hub still listens on 127.0.0.1 only, so this makes
#             nothing reachable that tailscale serve didn't already forward. The same as running, yourself:
#               sudo bash scripts/setup/dashboards.sh --client-id <id> --public-url https://<name> <instance>...
#             Then set the sign-in App's callback URL to exactly https://<name>/auth/callback.
#
# Each root step writes its progress to $TAILSCALE_DIR/steps.jsonl (root's, 0644: one JSON line per change, for the
# dashboard) and to its output. One step at a time on a machine. Exit 0 when the step is done or was already.
source "$(dirname "$0")/lib.sh"
usage="usage: tailscale.sh status [--json] | install | up [--for <instance>] | serve | serve-siri | public-url"
cmd="${1:-}"
case "$cmd" in
  status) ;;
  install | up | serve | serve-siri | public-url) as_root "$@" ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
shift
here="$(cd "$(dirname "$0")" && pwd)"
# Root's tools wherever this is started from (sudo, a systemd unit): sbin included.
PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
for_instance="" json=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --for) [ "$cmd" = up ] && [ "$#" -ge 2 ] || { echo "$usage" >&2; exit 2; }; for_instance="$2"; shift 2 ;;
    --json) [ "$cmd" = status ] || { echo "$usage" >&2; exit 2; }; json=1; shift ;;
    *) echo "$usage" >&2; exit 2 ;;
  esac
done
if [ -n "$for_instance" ]; then
  instance_name_ok "$for_instance" || { echo "--for: an instance name" >&2; exit 2; }
  user_exists "wl-$for_instance" || { echo "--for: no wl-$for_instance on this machine" >&2; exit 2; }
fi
command -v node >/dev/null || { echo "needs node (node.sh)" >&2; exit 1; }

# --- what tailscale says

installed() { [ -x "$TAILSCALE_BIN" ]; }
# tailscale itself, never with an auth key from the environment.
ts() { env -u TS_AUTHKEY -u TS_AUTH_KEY "$TAILSCALE_BIN" "$@"; }

# f_state (tailscale's BackendState, or - without one), f_name (this machine's tailnet name, or -), and yes or no for:
# f_https (the tailnet issues a certificate for that name), f_serve (https 443 on it forwards / to the hub's sign-in
# port), f_other443 (443 forwards somewhere else), f_break_glass (anything forwards to the break-glass port) and
# f_funnel (Tailscale Funnel, the public internet, is on for anything on this machine: read only, never changed
# here). Every value is checked here before bash sees it: a name is a ts.net name or nothing.
read_facts() {
  local status="" serve="" out
  if installed; then
    status="$(ts status --json 2>/dev/null || true)"
    serve="$(ts serve status --json 2>/dev/null || true)"
  fi
  out="$(node -e '
const [statusText, serveText, hubPort, breakGlassPort, siriPort, siriTailnetPort] = process.argv.slice(1);
const parse = (t) => {
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};
const s = parse(statusText);
const sv = parse(serveText);
const state = typeof s.BackendState === "string" && /^[A-Za-z]{1,30}$/.test(s.BackendState) ? s.BackendState : "-";
let name = s.Self && typeof s.Self.DNSName === "string" ? s.Self.DNSName.replace(/\.$/, "").toLowerCase() : "";
if (name.length > 253 || !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(name)) name = "";
const certs = Array.isArray(s.CertDomains) ? s.CertDomains.filter((x) => typeof x === "string").map((x) => x.toLowerCase()) : [];
const hub = `http://127.0.0.1:${hubPort}`;
const web = sv.Web && typeof sv.Web === "object" ? sv.Web : {};
const root = (hostPort) => {
  const h = web[hostPort] && web[hostPort].Handlers;
  return h && h["/"] && typeof h["/"].Proxy === "string" ? h["/"].Proxy : null;
};
const serves = !!name && root(`${name}:443`) === hub;
const siri = !!name && root(`${name}:${siriTailnetPort}`) === `http://127.0.0.1:${siriPort}`;
const onSiriPort = Object.keys(web).some((k) => k.endsWith(`:${siriTailnetPort}`)) || !!(sv.TCP && sv.TCP[siriTailnetPort]);
const on443 = Object.keys(web).some((k) => k.endsWith(":443")) || !!(sv.TCP && sv.TCP["443"]);
const yn = (b) => (b ? "yes" : "no");
const all = JSON.stringify(sv);
const breakGlass = new RegExp(`(127\\.0\\.0\\.1|localhost|\\[::1\\]):${breakGlassPort}(?![0-9])`).test(all);
// Funnel: any AllowFunnel entry that is on, anywhere in the serve config (a background one, or a foreground session).
const funnelOn = (v) => !!v && typeof v === "object" && Object.entries(v).some(([k, x]) => (k === "AllowFunnel" && !!x && typeof x === "object" ? Object.values(x).some((on) => on === true) : funnelOn(x)));
process.stdout.write([state, name || "-", yn(!!name && certs.includes(name)), yn(serves), yn(on443 && !serves), yn(breakGlass), yn(funnelOn(sv)), yn(siri), yn(onSiriPort && !siri)].join("\n") + "\n");
' "$status" "$serve" "$HUB_PORT" "$BREAK_GLASS_PORT" "$SIRI_GATEWAY_PORT" "$SIRI_TAILNET_PORT")"
  { read -r f_state; read -r f_name; read -r f_https; read -r f_serve; read -r f_other443; read -r f_break_glass; read -r f_funnel; read -r f_siri; read -r f_other_siri; } <<< "$out"
}

# --- progress

# One progress line: emit <state> <detail>, for this step. To steps.jsonl and to the output; a login link or a key is
# never part of one (none is ever put in a detail; this is the second check).
emit() {
  local detail
  detail="$(printf '%s' "$2" | sed -E -e 's#https?://login\.tailscale\.com[^[:space:]"]*#[the login link, not logged]#g' -e 's#tskey-[A-Za-z0-9_-]+#[a key, not logged]#g')"
  if [ -f "$TAILSCALE_DIR/steps.jsonl" ]; then
    printf '{"at":%s,"step":%s,"state":%s,"detail":%s}\n' "$(json_str "$(date -u +%Y-%m-%dT%H:%M:%SZ)")" "$(json_str "$cmd")" "$(json_str "$1")" "$(json_str "$detail")" >> "$TAILSCALE_DIR/steps.jsonl"
  fi
  echo "$cmd $1: $detail"
}
fail() { emit failed "$1"; exit 1; }
need_installed() { installed || fail "tailscale isn't installed on this machine: run the install step first (or leave it: the hub keeps its URL)"; }

# --- status: reads only

do_status() {
  local version="" hub_url
  read_facts
  if installed; then
    version="$(ts version 2>/dev/null | head -1 | tr -d '[:space:]' || true)"
    [[ "$version" =~ ^[0-9][0-9A-Za-z.+~-]{0,40}$ ]] || version=""
  fi
  hub_url="$(hub_option --public-url)"
  local name="${f_name#-}" state="${f_state#-}"
  if [ -n "$json" ]; then
    printf '{"installed":%s,"version":%s,"pinned_version":%s,"state":%s,"name":%s,"https":%s,"serve":%s,"other_443":%s,"break_glass_forwarded":%s,"funnel":%s,"siri":%s,"hub_url":%s}\n' \
      "$(if installed; then echo true; else echo false; fi)" "$(json_str "$version")" "$(json_str "$TAILSCALE_VERSION")" "$(json_str "$state")" "$(json_str "$name")" \
      "$([ "$f_https" = yes ] && echo true || echo false)" "$([ "$f_serve" = yes ] && echo true || echo false)" "$([ "$f_other443" = yes ] && echo true || echo false)" "$([ "$f_break_glass" = yes ] && echo true || echo false)" "$([ "$f_funnel" = yes ] && echo true || echo false)" "$([ "$f_siri" = yes ] && echo true || echo false)" "$(json_str "$hub_url")"
    return 0
  fi
  if ! installed; then
    echo "tailscale: not installed (optional; to install the pinned $TAILSCALE_VERSION: sudo bash $here/tailscale.sh install)"
  else
    echo "tailscale: ${version:-installed}, ${state:-no state}${name:+, this machine is $name}"
    echo "https certificate for this name: $f_https; tailscale serve forwards 443 to the hub ($HUB_PORT): $f_serve"
    echo "tailscale serve forwards $SIRI_TAILNET_PORT to the Siri gateway ($SIRI_GATEWAY_PORT): $f_siri"
    [ "$f_break_glass" = no ] || echo "WARNING: tailscale serve forwards to the break-glass port $BREAK_GLASS_PORT, which must never be forwarded: tailscale serve reset"
    echo "Tailscale Funnel (the public internet): $([ "$f_funnel" = yes ] && echo "ON; nothing here changes it, and serve and public-url do nothing while it is on (tailscale funnel reset)" || echo off)"
  fi
  echo "the hub's URL: ${hub_url:-none (no hub on this machine yet)}"
}

# --- install: the signed apt repository, the key and the version pinned
work=""

# The fingerprint of each primary key in a key file, one per line.
key_fingerprints() {
  install -d -m 0700 "$1/gnupg"
  gpg --no-default-keyring --homedir "$1/gnupg" --show-keys --with-colons --with-fingerprint "$1/key.gpg" 2>/dev/null | awk -F: '$1 == "pub" { p = 1 } $1 == "fpr" && p { print $10; p = 0 }'
}

do_install() {
  local id="" codename="" got have
  if installed; then
    emit done "tailscale $(ts version 2>/dev/null | head -1 | tr -cd '0-9A-Za-z.+~-') is already installed; left as it is"
    return 0
  fi
  [ -r "$OS_RELEASE" ] || fail "no $OS_RELEASE: can't tell the distribution, so nothing was installed"
  id="$(sed -n 's/^ID=//p' "$OS_RELEASE" | head -1 | tr -d "\"'")"
  codename="$(sed -n 's/^VERSION_CODENAME=//p' "$OS_RELEASE" | head -1 | tr -d "\"'")"
  case "$id" in
    ubuntu | debian) ;;
    *) fail "the pinned install is for Ubuntu and Debian (apt), not ${id:-this system}: install Tailscale's package for it yourself, then run the next step" ;;
  esac
  [[ "$codename" =~ ^[a-z]{3,20}$ ]] || fail "no release codename in $OS_RELEASE, so nothing was installed"
  command -v apt-get >/dev/null || fail "no apt-get on this machine, so nothing was installed"
  command -v gpg >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q gnupg
  work="$(mktemp -d)"
  # Whatever goes wrong from here: no key and no source are left behind.
  trap 'rm -rf "$work"; installed || rm -f "$TAILSCALE_LIST" "$TAILSCALE_KEYRING"' EXIT

  emit running "fetching the signing key of $TAILSCALE_REPO/$id ($codename)"
  curl -fsSL --proto '=https' --tlsv1.2 --max-time 60 --retry 3 -o "$work/key.gpg" "$TAILSCALE_REPO/$id/$codename.noarmor.gpg" || fail "couldn't fetch the signing key for $id $codename from $TAILSCALE_REPO (is this release one Tailscale packages for?); nothing installed"
  got="$(key_fingerprints "$work" | tr '\n' ' ' | sed 's/ $//')"
  # Exactly one key, and it is the pinned one. Never loosened: a different key is a reviewed change to lib.sh.
  [ "$got" = "$TAILSCALE_SIGNER_FPR" ] || fail "the signing key fetched isn't the pinned one (pinned $TAILSCALE_SIGNER_FPR, got ${got:-none}); nothing installed"

  put_file root root 0644 "$TAILSCALE_KEYRING" < "$work/key.gpg"
  printf '# Tailscale packages for %s %s (worklane tailscale.sh); every package checked against this one key\ndeb [signed-by=%s] %s/%s %s main\n' "$id" "$codename" "$TAILSCALE_KEYRING" "$TAILSCALE_REPO" "$id" "$codename" | put_file root root 0644 "$TAILSCALE_LIST"

  emit running "apt: the signed index, then tailscale $TAILSCALE_VERSION"
  # Signatures are required whatever this machine's apt configuration says.
  local strict=(-o Acquire::AllowInsecureRepositories=false -o Acquire::AllowDowngradeToInsecureRepositories=false -o APT::Get::AllowUnauthenticated=false)
  DEBIAN_FRONTEND=noninteractive apt-get "${strict[@]}" -o Dir::Etc::sourcelist="$TAILSCALE_LIST" -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0 update -q || fail "apt couldn't verify Tailscale's index for $id $codename against the pinned key; nothing installed"
  DEBIAN_FRONTEND=noninteractive apt-get "${strict[@]}" install -y -q --no-install-recommends "tailscale=$TAILSCALE_VERSION" || fail "apt couldn't install tailscale $TAILSCALE_VERSION from the signed repository; nothing installed"
  have="$(dpkg-query -W -f='${Version}' tailscale 2>/dev/null || true)"
  [ "$have" = "$TAILSCALE_VERSION" ] && installed || fail "tailscale $TAILSCALE_VERSION didn't end up installed (dpkg has: ${have:-nothing})"
  systemctl enable --now tailscaled >/dev/null 2>&1 || fail "tailscale $TAILSCALE_VERSION is installed, but its service didn't start: see journalctl -u tailscaled"
  emit done "tailscale $TAILSCALE_VERSION installed from $TAILSCALE_REPO/$id, signed by the pinned key; not logged in yet"
}

# --- up: no auth key; the login link to the owner only

relay_login_url() {
  local minutes=$((TAILSCALE_UP_SECONDS / 60))
  if [ -n "$for_instance" ]; then
    printf '%s\n' "$1" | put_file "wl-$for_instance" root 0400 "$TAILSCALE_DIR/login-url"
    emit waiting "log this machine in to your tailnet: the login link is in $for_instance's dashboard, shown to machine owners only; waiting up to $minutes min"
  elif [ -t 2 ]; then
    printf '\nTo log this machine in to your tailnet, open:\n\n  %s\n\n' "$1" >&2
    emit waiting "open the login link printed above; waiting up to $minutes min"
  else
    emit waiting "tailscale printed a login link, and this isn't a terminal to show it in: run this step in a terminal"
  fi
}

do_up() {
  local line url rc
  need_installed
  read_facts
  if [ "$f_state" = Running ]; then
    emit done "already on the tailnet as ${f_name#-}"
    return 0
  fi
  rm -f "$TAILSCALE_DIR/login-url" "$TAILSCALE_DIR/.login-url.tmp"
  emit running "tailscale up (no auth key): it prints a login link and waits"
  set +e
  # tailscale's own output never reaches the journal as it is: the login link goes to the owner, the rest is redacted.
  ts up --timeout="${TAILSCALE_UP_SECONDS}s" 2>&1 | while IFS= read -r line; do
    url="$(printf '%s\n' "$line" | grep -Eo 'https?://[^[:space:]"]+' | head -1)"
    if [ -n "$url" ]; then
      if tailscale_login_url_ok "$url"; then relay_login_url "$url"; else emit waiting "tailscale printed a link that isn't its login page, so it wasn't passed on: run sudo tailscale up in a terminal"; fi
    elif [ -n "${line//[[:space:]]/}" ]; then
      printf 'tailscale: %s\n' "$line" | tailscale_redact
    fi
  done
  rc="${PIPESTATUS[0]}"
  set -e
  rm -f "$TAILSCALE_DIR/login-url" "$TAILSCALE_DIR/.login-url.tmp"
  [ "$rc" = 0 ] || fail "tailscale up ended without a login (nobody opened the link within $((TAILSCALE_UP_SECONDS / 60)) min, or it failed): run this step again"
  read_facts
  [ "$f_state" = Running ] || fail "tailscale up returned, but this machine isn't on a tailnet (state: ${f_state#-})"
  emit done "on the tailnet as ${f_name#-}"
}

# --- serve: https 443 to the hub's sign-in port, nothing else; tailnet only, never Funnel
FUNNEL_ON="Tailscale Funnel is on for this machine, which publishes to the public internet. This step never turns Funnel on or off, and does nothing while it is on: an admin turns it off (tailscale funnel reset), then run this again"

do_serve() {
  local out rc
  need_installed
  read_facts
  [ "$f_state" = Running ] || fail "this machine isn't on a tailnet yet: run the up step first"
  [ "$f_break_glass" = no ] || fail "tailscale serve forwards to the break-glass port $BREAK_GLASS_PORT, which must never be forwarded: remove it (tailscale serve reset), then run this again"
  [ "$f_funnel" = no ] || fail "$FUNNEL_ON"
  if [ "$f_serve" = yes ]; then
    emit done "https 443 on $f_name already forwards to the hub's sign-in port ($HUB_PORT)"
    return 0
  fi
  [ "$f_other443" = no ] || fail "tailscale serve already forwards https 443 somewhere else; left as it is (see: tailscale serve status)"
  [ "$f_https" = yes ] || fail "the tailnet doesn't issue an HTTPS certificate for ${f_name#-} yet: turn on MagicDNS and HTTPS certificates in Tailscale's admin console (DNS), then run this again"
  emit running "tailscale serve --bg --https=443 to 127.0.0.1:$HUB_PORT"
  set +e
  out="$(timeout "$TAILSCALE_SERVE_SECONDS" env -u TS_AUTHKEY -u TS_AUTH_KEY "$TAILSCALE_BIN" serve --bg --https=443 "http://127.0.0.1:$HUB_PORT" 2>&1)"
  rc=$?
  set -e
  [ -z "$out" ] || printf '%s\n' "$out" | tailscale_redact | sed 's/^/tailscale: /'
  read_facts
  [ "$rc" = 0 ] && [ "$f_serve" = yes ] || fail "tailscale serve didn't start forwarding within $TAILSCALE_SERVE_SECONDS s (see: tailscale serve status)"
  [ "$f_break_glass" = no ] || fail "tailscale serve forwards to the break-glass port $BREAK_GLASS_PORT: tailscale serve reset"
  [ "$f_funnel" = no ] || fail "$FUNNEL_ON"
  emit done "https 443 on $f_name forwards to the hub's sign-in port ($HUB_PORT), and to nothing else"
}

# --- serve-siri: https 8443 to the hub's Siri gateway, nothing else; tailnet only, never Funnel

do_serve_siri() {
  local out rc
  need_installed
  read_facts
  [ "$f_state" = Running ] || fail "this machine isn't on a tailnet yet: run the up step first"
  [ "$f_break_glass" = no ] || fail "tailscale serve forwards to the break-glass port $BREAK_GLASS_PORT, which must never be forwarded: remove it (tailscale serve reset), then run this again"
  [ "$f_funnel" = no ] || fail "$FUNNEL_ON"
  if [ "$f_siri" = yes ]; then
    emit done "https $SIRI_TAILNET_PORT on $f_name already forwards to the Siri gateway ($SIRI_GATEWAY_PORT)"
    return 0
  fi
  [ "$f_other_siri" = no ] || fail "tailscale serve already forwards https $SIRI_TAILNET_PORT somewhere else; left as it is (see: tailscale serve status)"
  [ "$f_https" = yes ] || fail "the tailnet doesn't issue an HTTPS certificate for ${f_name#-} yet: turn on MagicDNS and HTTPS certificates in Tailscale's admin console (DNS), then run this again"
  emit running "tailscale serve --bg --https=$SIRI_TAILNET_PORT to 127.0.0.1:$SIRI_GATEWAY_PORT"
  set +e
  out="$(timeout "$TAILSCALE_SERVE_SECONDS" env -u TS_AUTHKEY -u TS_AUTH_KEY "$TAILSCALE_BIN" serve --bg "--https=$SIRI_TAILNET_PORT" "http://127.0.0.1:$SIRI_GATEWAY_PORT" 2>&1)"
  rc=$?
  set -e
  [ -z "$out" ] || printf '%s\n' "$out" | tailscale_redact | sed 's/^/tailscale: /'
  read_facts
  [ "$rc" = 0 ] && [ "$f_siri" = yes ] || fail "tailscale serve didn't start forwarding $SIRI_TAILNET_PORT within $TAILSCALE_SERVE_SECONDS s (see: tailscale serve status)"
  [ "$f_break_glass" = no ] || fail "tailscale serve forwards to the break-glass port $BREAK_GLASS_PORT: tailscale serve reset"
  [ "$f_funnel" = no ] || fail "$FUNNEL_ON"
  emit done "https $SIRI_TAILNET_PORT on $f_name forwards to the Siri gateway ($SIRI_GATEWAY_PORT), and to nothing else. In the tailnet policy, let only your phone reach $f_name:$SIRI_TAILNET_PORT (docs/siri.md)"
}

# --- public-url: the hub's URL, through dashboards.sh

do_public_url() {
  local id old user devices siri_port names new args
  need_installed
  read_facts
  [ "$f_state" = Running ] && [ "$f_name" != - ] || fail "this machine isn't on a tailnet yet: run the up step first; the hub keeps its URL"
  [ "$f_funnel" = no ] || fail "$FUNNEL_ON; the hub keeps its URL"
  [ "$f_serve" = yes ] || fail "tailscale serve doesn't forward to the hub yet, so the new URL would reach nothing: run the serve step first; the hub keeps its URL"
  new="https://$f_name"
  [ -f "$HUB_UNIT" ] || fail "no dashboard hub on this machine yet: set it up first (credentials.sh dashboard-signin, then dashboards.sh --client-id <id> --public-url $new <instance>...)"
  id="$(hub_option --client-id)"; old="$(hub_option --public-url)"; user="$(hub_option --console-user)"; devices="$(hub_option --console-devices)"; siri_port="$(hub_option --siri-port)"
  names="$(hub_instances | tr '\n' ' ' | sed 's/ $//')"
  [ -n "$id" ] && [ -n "$names" ] || fail "the hub's unit ($HUB_UNIT) doesn't name its sign-in App or its instances: run dashboards.sh yourself with --public-url $new"
  if [ "$old" = "$new" ]; then
    emit done "the hub's URL is already $new"
    return 0
  fi
  args=(--client-id "$id" --public-url "$new")
  [ -z "$user" ] || args+=(--console-user "$user")
  [ -z "$devices" ] || args+=(--console-devices "$devices")
  [ -z "$siri_port" ] || args+=(--siri)
  emit running "dashboards.sh ${args[*]} $names"
  # shellcheck disable=SC2086 # one word per instance name, none with spaces (hub_instances checks each)
  bash "$here/dashboards.sh" "${args[@]}" $names || fail "dashboards.sh failed (its output is above); check the hub: systemctl status worklane-dashboard-hub.service"
  emit done "the hub's URL is now $new (it was ${old:-not set}). To sign in there, set the sign-in App's callback URL to exactly $new/auth/callback"
}

if [ "$cmd" = status ]; then
  do_status
  exit 0
fi

# One step at a time on a machine; each starts steps.jsonl afresh.
if command -v flock >/dev/null 2>&1; then
  install -d -m 0755 "$(dirname "$TAILSCALE_LOCK")"
  exec 8> "$TAILSCALE_LOCK"
  flock -n 8 || { echo "another tailscale step is running on this machine; wait for it to finish" >&2; exit 1; }
fi
install -d -m 0755 "$TAILSCALE_DIR"
: | put_file root root 0644 "$TAILSCALE_DIR/steps.jsonl"
emit started ""
case "$cmd" in
  install) do_install ;;
  up) do_up ;;
  serve) do_serve ;;
  serve-siri) do_serve_siri ;;
  public-url) do_public_url ;;
esac
