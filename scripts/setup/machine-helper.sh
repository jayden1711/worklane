#!/usr/bin/env bash
# Once per machine, as root (review it first): let instances change machine-wide settings from
# their dashboards, through one root-owned helper that validates and writes only those settings.
# The dashboard (hardened: NoNewPrivileges) never runs sudo itself: it records the request and the
# instance's coordinator runs the helper on its next tick (src/machine-requests.ts).
#
#   bash scripts/setup/machine-helper.sh <name> [<name>...]     every instance on this machine
#
#   - Installs the helper as /usr/local/libexec/worklane-machine (root:root 0755). It accepts
#     exactly `set-slots <1..16>`, `set-updates on|off` and `set-test-slots <1..8>`, writes atomically, and logs each
#     change to /var/lib/worklane/machine-changes.jsonl and the journal. And `add-project <name> <owner/repo>`,
#     which runs the installed engine's add-project.sh as root with exactly those (checked) arguments.
#     And `claude-account status` (claude-account.sh status), and the account profiles (issue #464): `claude-account
#     remove|use <profile>`, each its own unit, for the asking coordinator's instance alone. Nothing through the helper
#     takes a Claude credential (issue #711): the sudoers rule below still lists `claude-account switch`, `profile-add`
#     and `login` (lib.sh's machine_sudoers), and the helper refuses each of them, as claude-account.sh does.
#     And the engine updater's setup: `install-updater` (the installed engine's updates.sh, no arguments),
#     `set-update-channel release` (updates.json's channel, nothing else; following main is updates.sh --channel main,
#     at a root shell) and `stage-update-signer <principal> ssh-ed25519 <public key>`, which records a release signer
#     in /var/lib/worklane/pending-signers.json for an admin to confirm (`discard-update-signer` takes it back out).
#     Nothing in the helper writes /etc/worklane/allowed_signers, the keys a release tag's signature is checked
#     against: a staged key becomes a signer only through updates.sh --confirm-signer <fingerprint>, as root.
#     And `tailscale install|up|serve|public-url`, which start tailscale.sh with that one word as its own unit: the
#     pinned, signed install; `tailscale up` with no auth key; https 443 to the hub's sign-in port; the hub's URL.
#     And the plugin steps (plugins.sh): `plugin-fetch <id> <https url> <sha> [<path>]`, `plugin-stage <id> sha256:<hex>
#     <role+role>`, `plugin-withdraw <id>` and `plugin-remove <id>`, for the asking coordinator's instance alone. Nothing
#     in the helper adds or changes an approved plugin: an admin confirms a staged one with plugins.sh confirm. And the MCP
#     server steps: `mcp-fetch <id> <npm package> <x.y.z>`, `mcp-preview <id> <plugin> <server>`, `mcp-snapshot <id>` and
#     `mcp-stage <id> sha256:<hex> <role+role> <host+host|none> <SECRET+SECRET|none>`, confirmed the same way.
#     And `set-policy <key> <value>` (issue #726): one key of the asking coordinator's own root policy.yaml, through the
#     installed engine as root; never sandbox or allow_same_user, and land_mode, main_watch and auto_merge only toward
#     pr, auto and off.
#   - Lets each coordinator user wl-<name> run exactly those 34 commands as root (sudoers,
#     listed one by one), and add-project, stage-update-signer, discard-update-signer and the claude-account profile commands with arguments of their
#     fixed shapes (a pattern each; sudo 1.9.10 or later). The dashboard viewer wl-dash gets nothing.
#   - Makes /etc/worklane/slots.json root:root 0644: until now the agent-slots group could
#     write any content to it; from now on the cap changes only through the helper.
# Re-run it with the full list after adding an instance.
source "$(dirname "$0")/lib.sh"
as_root "$@"
[ "$#" -ge 1 ] || { echo "usage: machine-helper.sh <name> [<name>...]" >&2; exit 2; }
users=()
for name in "$@"; do
  need_instance_name "$name"
  id -u "wl-$name" >/dev/null 2>&1 || { echo "no wl-$name; run instance.sh $name first" >&2; exit 1; }
  users+=("wl-$name")
done
command -v node >/dev/null || { echo "needs node on root's PATH (node.sh)" >&2; exit 1; }
[ -d /etc/worklane ] || { echo "no /etc/worklane; run machine.sh first" >&2; exit 1; }

say "the helper, root-owned"
src="$(dirname "$0")/../machine/worklane-machine.cjs"
# The temp name ends in .cjs: node --check refuses an unknown extension such as .tmp.
tmp="$(dirname "$MACHINE_HELPER")/.worklane-machine.tmp.cjs"
install -d -o root -g root -m 0755 "$(dirname "$MACHINE_HELPER")"
rm -f "$(dirname "$MACHINE_HELPER")/.worklane-machine.tmp"   # left by an earlier run that failed on that name
install -o root -g root -m 0755 "$src" "$tmp"
node --check "$tmp"
mv -f "$tmp" "$MACHINE_HELPER"
echo "installed $MACHINE_HELPER"

say "its change log"
install -d -o root -g root -m 0755 /var/lib/worklane
[ -f /var/lib/worklane/machine-changes.jsonl ] || install -o root -g root -m 0644 /dev/null /var/lib/worklane/machine-changes.jsonl
chown root:root /var/lib/worklane/machine-changes.jsonl
chmod 0644 /var/lib/worklane/machine-changes.jsonl

say "the slot cap: root-owned, readable by all, changed only through the helper"
[ -f /etc/worklane/slots.json ] || printf '{"max_agents":2}\n' > /etc/worklane/slots.json
chown root:root /etc/worklane/slots.json
chmod 0644 /etc/worklane/slots.json
cat /etc/worklane/slots.json

say "sudoers: ${users[*]} may run exactly the helper's 34 commands, add-project <name> <owner/repo>, stage-update-signer or discard-update-signer <principal> ssh-ed25519 <public key>, and claude-account profile-add|remove|use <profile> (its own instance only)"
install_sudoers worklane-machine "$(machine_sudoers "${users[@]}")"
if sudo_regex_ok; then
  echo "sudo $(sudo_version): $SUDO_REGEX_MIN or later, so the add-project, stage-update-signer, discard-update-signer and claude-account profile rules are installed"
  left_out='[]'
else
  echo "REFUSED: the add-project, stage-update-signer, discard-update-signer and claude-account profile rules are NOT installed. This machine's sudo ($(sudo_version || echo unknown)) is older than $SUDO_REGEX_MIN, which would read their argument patterns as literal text. Every other rule is installed. The dashboard shows the root commands instead: add a project at a root shell with add-project.sh <name> <owner/repo>, and a release signer with updates.sh --signer." >&2
  left_out='["add-project","stage-update-signer","discard-update-signer","claude-account-profiles","plugins","set-policy"]'
fi
# For the dashboard (0644, written whole): which of the helper's commands this machine's sudo rule leaves out, so a
# page shows the root command for them instead of a button that would only fail.
printf '{"sudo":"%s","patterns_min":"%s","left_out":%s}\n' "$(sudo_version || true)" "$SUDO_REGEX_MIN" "$left_out" > "$(dirname "$HELPER_RULES")/.helper-rules.json.tmp"
chmod 0644 "$(dirname "$HELPER_RULES")/.helper-rules.json.tmp"
mv -f "$(dirname "$HELPER_RULES")/.helper-rules.json.tmp" "$HELPER_RULES"
echo "wrote $HELPER_RULES: $(cat "$HELPER_RULES")"

say "check"
for u in "${users[@]}"; do
  sudo -n -l -U "$u" "$MACHINE_HELPER" set-slots 1 >/dev/null || { echo "FAIL: $u can't run set-slots 1" >&2; exit 1; }
  if sudo -n -l -U "$u" "$MACHINE_HELPER" set-slots 17 >/dev/null 2>&1; then echo "FAIL: $u may run set-slots 17" >&2; exit 1; fi
  sudo -n -l -U "$u" "$MACHINE_HELPER" set-test-slots 2 >/dev/null || { echo "FAIL: $u can't run set-test-slots 2" >&2; exit 1; }
  if sudo -n -l -U "$u" "$MACHINE_HELPER" set-test-slots 9 >/dev/null 2>&1; then echo "FAIL: $u may run set-test-slots 9" >&2; exit 1; fi
  sudo -n -l -U "$u" "$MACHINE_HELPER" claude-account switch >/dev/null || { echo "FAIL: $u can't run claude-account switch" >&2; exit 1; }
  if sudo -n -l -U "$u" "$MACHINE_HELPER" claude-account switch --token-from x >/dev/null 2>&1; then echo "FAIL: $u may pass claude-account switch its own arguments" >&2; exit 1; fi
  for ok in install up serve public-url; do
    sudo -n -l -U "$u" "$MACHINE_HELPER" tailscale "$ok" >/dev/null || { echo "FAIL: $u can't run tailscale $ok" >&2; exit 1; }
  done
  for bad in "tailscale funnel" "tailscale funnel 443" "tailscale serve --funnel" "tailscale serve funnel on" "tailscale serve --bg --https=443 http://127.0.0.1:4399" "tailscale serve --set-path=/x http://127.0.0.1:4398" "tailscale serve http://0.0.0.0:4399" "tailscale serve --tcp=22 tcp://127.0.0.1:22" "tailscale up --advertise-exit-node" "tailscale up --advertise-routes=198.51.100.0/24" "tailscale up --ssh" "tailscale up --accept-routes" "tailscale up --login-server=https://x.example" "tailscale" "tailscale up --auth-key=tskey-auth-x" "tailscale up --authkey tskey-auth-x" "tailscale up x" "tailscale serve 4398" "tailscale serve --https=443 http://127.0.0.1:4398" "tailscale public-url https://x.example" "tailscale install 1.0.0" "tailscale status" "tailscale logout" "tailscale UP"; do
    # shellcheck disable=SC2086 # each case is its words
    if sudo -n -l -U "$u" "$MACHINE_HELPER" $bad >/dev/null 2>&1; then echo "FAIL: $u may run $bad" >&2; exit 1; fi
  done
  for bad in "add-project x" "add-project x o/r extra" "add-project X o/r" "add-project x o" "add-project x o/r/s" "add-project x;id o/r" "add-project -x o/r"; do
    # shellcheck disable=SC2086 # each case is its words
    if sudo -n -l -U "$u" "$MACHINE_HELPER" $bad >/dev/null 2>&1; then echo "FAIL: $u may run $bad" >&2; exit 1; fi
  done
  sudo -n -l -U "$u" "$MACHINE_HELPER" install-updater >/dev/null || { echo "FAIL: $u can't run install-updater" >&2; exit 1; }
  sudo -n -l -U "$u" "$MACHINE_HELPER" set-update-channel release >/dev/null || { echo "FAIL: $u can't run set-update-channel release" >&2; exit 1; }
  # A public key of the right shape, made up for this check (all zero bytes): nothing is run, sudo only says whether it would.
  probe_key="AAAAC3NzaC1lZDI1NTE5AAAAI$(printf 'A%.0s' $(seq 1 43))"
  for bad in "install-updater --check x" "set-update-channel" "set-update-channel main" "set-update-channel beta" "set-update-channel release x" "stage-update-signer" "stage-update-signer owner@example.com" \
    "stage-update-signer owner@example.com ssh-ed25519 ${probe_key}A" "stage-update-signer owner@example.com ssh-ed25519 ${probe_key%A}" "stage-update-signer owner@example.com ssh-rsa $probe_key" \
    "stage-update-signer * ssh-ed25519 $probe_key" "stage-update-signer owner@example.com,other@example.com ssh-ed25519 $probe_key" "stage-update-signer owner@example.com cert-authority ssh-ed25519 $probe_key" \
    "stage-update-signer owner@example.com ssh-ed25519 $probe_key extra" "add-update-signer owner@example.com ssh-ed25519 $probe_key" "confirm-update-signer owner@example.com ssh-ed25519 $probe_key" \
    "remove-update-signer owner@example.com ssh-ed25519 $probe_key" "set-update-signers /tmp/x" "set-update-verify off"; do
    # shellcheck disable=SC2086 # each case is its words; set -f: the * is a word, never a file list
    if (set -f; sudo -n -l -U "$u" "$MACHINE_HELPER" $bad >/dev/null 2>&1); then echo "FAIL: $u may run $bad" >&2; exit 1; fi
  done
  if sudo_regex_ok && ! sudo -n -l -U "$u" "$MACHINE_HELPER" stage-update-signer owner@example.com ssh-ed25519 "$probe_key" >/dev/null 2>&1; then
    echo "FAIL: sudo $(sudo_version) should match the stage-update-signer pattern, and $u can't run it" >&2; exit 1
  fi
  if sudo_regex_ok; then
    for ok in "profile-add work" "remove work" "use work" "use default" "login work" "failover work+default back" "failover off stay"; do
      # shellcheck disable=SC2086 # each case is its words
      sudo -n -l -U "$u" "$MACHINE_HELPER" claude-account $ok >/dev/null 2>&1 || { echo "FAIL: sudo $(sudo_version) should match the claude-account $ok pattern, and $u can't run it" >&2; exit 1; }
    done
    for bad in "profile-add" "profile-add Work" "profile-add work x" "profile-add work --token-from x" "remove work x" "use" "use work a b" "use ../x" "use work --for x" "use work;id" "use work alpha" "use default alpha" "use work all" "profile-add work alpha" "confirm-profile work" "use work --token-from x" "login work alpha" "login work --for x" "login" "login Work" "failover work+default back ci" "failover off stay alpha" "failover work,default back" "failover work+Home back" "failover work maybe" "failover work+default back --for x"; do
      # shellcheck disable=SC2086 # each case is its words
      if sudo -n -l -U "$u" "$MACHINE_HELPER" claude-account $bad >/dev/null 2>&1; then echo "FAIL: $u may run claude-account $bad" >&2; exit 1; fi
    done
  fi
  if sudo_regex_ok; then
    sha="$(printf '0%.0s' $(seq 1 40))" dig="sha256:$(printf 'a%.0s' $(seq 1 64))"
    for ok in "plugin-fetch kit https://example.com/o/kit.git $sha" "plugin-fetch kit https://example.com/o/mono $sha plugins/kit" "plugin-stage kit $dig builder" "plugin-stage kit $dig builder+reviewer" "plugin-withdraw kit" "plugin-remove kit" "mcp-fetch notes notes-server 1.2.3" "mcp-fetch notes @scope/notes 1.2.3" "mcp-fetch notes @scope/notes 1.2.3 registry.npmjs.org" "mcp-preview kit-notes kit notes" "mcp-snapshot kit-notes" "mcp-stage kit-notes $dig builder api.example.com NOTES_TOKEN" "mcp-stage kit-notes $dig builder none none"; do
      # shellcheck disable=SC2086 # each case is its words
      sudo -n -l -U "$u" "$MACHINE_HELPER" $ok >/dev/null 2>&1 || { echo "FAIL: sudo $(sudo_version) should match the $ok pattern, and $u can't run it" >&2; exit 1; }
    done
    for bad in "plugin-fetch kit http://example.com/o/kit $sha" "plugin-fetch kit https://example.com/o/kit main" "plugin-fetch Kit https://example.com/o/kit $sha" "plugin-fetch kit https://example.com/o/kit $sha a b" "plugin-fetch kit https://example.com/o/kit;id $sha" \
      "plugin-stage kit $dig" "plugin-stage kit sha256:abc builder" "plugin-stage kit $dig Builder" "plugin-stage kit $dig builder alpha" "plugin-confirm kit $dig" "plugin-remove" "plugin-remove kit alpha" "plugin-withdraw kit --instance alpha" "plugin-add kit" \
      "mcp-fetch notes notes-server latest" "mcp-fetch notes notes-server 1.2.3 x" "mcp-preview kit-notes kit notes alpha" "mcp-snapshot kit-notes alpha" "mcp-stage kit-notes $dig builder api.example.com" "mcp-stage kit-notes $dig builder x;id none" "mcp-confirm kit-notes $dig"; do
      # shellcheck disable=SC2086 # each case is its words
      if sudo -n -l -U "$u" "$MACHINE_HELPER" $bad >/dev/null 2>&1; then echo "FAIL: $u may run $bad" >&2; exit 1; fi
    done
  fi
  if sudo_regex_ok; then
    sudo -n -l -U "$u" "$MACHINE_HELPER" set-policy auto_merge on >/dev/null 2>&1 || { echo "FAIL: sudo $(sudo_version) should match the set-policy pattern, and $u can't run it" >&2; exit 1; }
    for bad in "set-policy auto_merge" "set-policy auto_merge on x" "set-policy Auto on" "set-policy auto_merge ON" "set-policy auto_merge on;id"; do
      # shellcheck disable=SC2086 # each case is its words
      if sudo -n -l -U "$u" "$MACHINE_HELPER" $bad >/dev/null 2>&1; then echo "FAIL: $u may run $bad" >&2; exit 1; fi
    done
  fi
  if sudo_regex_ok && ! sudo -n -l -U "$u" "$MACHINE_HELPER" add-project probe-name example-owner/probe.repo >/dev/null 2>&1; then
    echo "FAIL: sudo $(sudo_version) should match the add-project pattern, and $u can't run it" >&2; exit 1
  fi
done
if id -u wl-dash >/dev/null 2>&1 && sudo -n -l -U wl-dash "$MACHINE_HELPER" set-slots 1 >/dev/null 2>&1; then echo "FAIL: wl-dash may run the helper" >&2; exit 1; fi
echo "OK: each coordinator may run the helper's exact commands; nothing else, and not wl-dash"
