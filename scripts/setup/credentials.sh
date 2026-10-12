#!/usr/bin/env bash
# One credential at a time, for one instance. Secrets are read from files or
# the terminal (never echoed) and installed with the right owner; tokens are
# never printed. Creating the credentials themselves (the GitHub App, the
# Claude subscription) is up to you.
#
#   bash scripts/setup/credentials.sh <name> github-app <app-id> <installation-id> <key.pem> <owner/repo>
#       The coordinator's GitHub identity: a GitHub App installed on only the instance's repo.
#       Installs the App's private key for wl-<name> (0400), then verifies it by minting an
#       installation token and checking the installation reaches exactly <owner/repo> with the
#       permissions below. <key.pem> may be - (the key on stdin). With a 7th argument --shared (one App for
#       several projects), it checks a token limited to <owner/repo> instead of the whole installation.
#   bash scripts/setup/credentials.sh <name> verify-app
#       Read-only: the same check with the key already installed (after changing the App's permissions).
#   bash scripts/setup/credentials.sh <name> claude
#       The agent user's Claude login (interactive).
#   bash scripts/setup/credentials.sh <name> github
#       Fallback only: a fine-grained personal access token instead of an App.
#   bash scripts/setup/credentials.sh <name> eval-key --evals-on
#       The eval user's API key; only once evals are on.
#   bash scripts/setup/credentials.sh <name> api-key [<key-file>]
#       Bill the agents' runs to an Anthropic API key instead of the agent user's Claude login. The key is pasted
#       (not shown) or read from <key-file>, and installed for wl-<name>-agent only (0400, in a 0700 directory
#       of its own). claude reads it through apiKeyHelper, as the agent user: it is never in an environment, the
#       coordinator user can't read it, and the sandbox denies it to agent commands. Prints the credentials.yaml
#       line to add. Spend caps (daily_budget_usd, each role's budget_usd, --max-budget-usd) apply as before.
#   bash scripts/setup/credentials.sh <name> intake-discord
#       Work intake (docs/intake.md): the chat bot's token. Pasted (not shown) and installed for wl-<name>
#       only, 0400, in the instance home, which no agent user can read. Prints the credentials.yaml line to add.
#
# The App's permissions (checked by app-permissions.mjs): Contents read/write (fetch, push task branches,
# lease refs), Issues read/write (the backlog), Pull requests read/write (open PRs; Worklane never merges),
# Checks read (CI results on its PRs), Metadata read; and Actions read, which CI fix runs need for job
# logs. Workflows is deliberately left out: GitHub refuses a push that changes .github/workflows without
# it, so such a change can't go out through the coordinator. Administration and Actions write are refused
# too. No webhook.
source "$(dirname "$0")/lib.sh"
as_root "$@"
name="${1:?usage: credentials.sh <name> github-app|verify-app|claude|api-key|github|eval-key|intake-discord ...}"
what="${2:?usage: credentials.sh <name> github-app|verify-app|claude|api-key|github|eval-key|intake-discord ...}"
flag="${3:-}"
coord="wl-$name" agent="wl-$name-agent" eval_user="wl-$name-eval"
here="$(cd "$(dirname "$0")" && pwd)"
# Mint a token as the coordinator user (who alone can read the key) and check what it reaches and may do.
verify_app() { (cd / && sudo -u "$coord" node --input-type=module - "$@" < "$here/app-permissions.mjs"); }
# Intake secrets: one file each, for the coordinator user only (0400), in a 0700 directory of its own.
intake_dir="$(home_of "$coord" 2>/dev/null || echo "/home/$coord")/.config/$name-intake"
install_secret() {
  local file="$1" secret="$2"
  printf '%s' "$secret" | sudo -u "$coord" sh -c 'umask 077; mkdir -p "$(dirname "$1")"; chmod 0700 "$(dirname "$1")"; rm -f "$1"; cat > "$1"; chmod 0400 "$1"' _ "$file"
}

case "$what" in
  github-app)
    app_id="${3:?usage: credentials.sh <name> github-app <app-id> <installation-id> <key.pem> <owner/repo>}"
    inst_id="${4:?installation id missing}"
    src="${5:?path to the App private key (.pem) missing}"
    repo="${6:?the instance repo (owner/name) missing}"
    # --shared: one App for several projects. Its installation reaches more than this repo, so the check mints a
    # token limited to this repo (as the coordinator always does) and checks that token instead.
    shared=""; [ "${7:-}" = --shared ] && shared=shared
    [[ "$app_id" =~ ^[0-9]+$ && "$inst_id" =~ ^[0-9]+$ ]] || { echo "App and installation ids are numbers" >&2; exit 1; }
    [[ "$repo" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]] || { echo "repo must be owner/name" >&2; exit 1; }
    from_stdin=""
    if [ "$src" = - ]; then
      # The key on stdin (the machine helper's install-app-key): kept in a root-only temp file just long enough to install it.
      from_stdin=1
      src="$(mktemp)"; chmod 0600 "$src"; trap 'rm -f "$src"' EXIT
      head -c 16384 > "$src"
    fi
    grep -q -- '-----BEGIN [A-Z ]*PRIVATE KEY-----' "$src" || { echo "$src is not a PEM private key" >&2; exit 1; }
    dir="$(home_of "$coord")/.config/$name-app"
    key="$dir/private-key.pem"
    say "install the App's private key for $coord only ($key, 0400)"
    install -d -o "$coord" -g "$coord" -m 0700 "$dir"
    install -o "$coord" -g "$coord" -m 0400 "$src" "$key"
    say "verify as $coord: mint an installation token and list what the installation reaches"
    verify_app "$key" "$app_id" "$inst_id" "$repo" $shared
    echo
    creds="$(home_of "$coord")/.local/state/worklane/instances/$name/credentials.yaml"
    if [ -f "$creds" ]; then
      sudo -u "$coord" sh -c 'umask 077; printf "%s\n" "version: 1" "github: { kind: app, app_id: $1, installation_id: $2, key_path: $3 }" > "$4"' _ "$app_id" "$inst_id" "$key" "$creds"
      echo "wrote $creds (the App; agents sign in to Claude as their own user)"
    else
      echo "no instance home yet (run engine.sh first); then set in credentials.yaml: github: { kind: app, app_id: $app_id, installation_id: $inst_id, key_path: $key }"
    fi
    if [ -n "$from_stdin" ]; then
      echo "the key came on stdin; its temp copy is removed"
    else
      read -rp "Delete the copy you brought to this machine ($src) now with shred? [y/N] " yn || yn=
      if [ "$yn" = y ]; then shred -u "$src" && echo "deleted $src"; else echo "kept $src; delete it yourself"; fi
    fi
    echo "Now delete the key on your other machine (the downloaded .pem). If it's ever lost, generate a new one in the App's settings."
    ;;
  verify-app)
    # Nothing is installed or written: the key, ids and repo come from the instance's own files.
    home="$(home_of "$coord")/.local/state/worklane/instances/$name"
    say "verify as $coord: the installed App key, its installation, and the token's permissions"
    read -r key app_id inst_id repo < <(cd / && sudo -u "$coord" node --input-type=module - "$home" <<'JS'
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const { parse } = createRequire('/opt/worklane/current/package.json')('yaml');
const home = process.argv[2];
const gh = parse(readFileSync(`${home}/credentials.yaml`, 'utf8')).github;
if (gh?.kind !== 'app') { console.error(`${home}/credentials.yaml has no GitHub App (github.kind is ${gh?.kind})`); process.exit(1); }
const repo = parse(readFileSync(`${home}/instance.yaml`, 'utf8')).repos[0].repo;
console.log(gh.key_path, gh.app_id, gh.installation_id, repo);
JS
)
    [ -n "${repo:-}" ] || { echo "could not read the instance's App settings" >&2; exit 1; }
    verify_app "$key" "$app_id" "$inst_id" "$repo"
    ;;
  github)
    echo "fallback: a personal access token instead of a GitHub App (prefer github-app)"
    dir="$(home_of "$coord")/.config/$name-gh"
    say "GitHub: a fine-grained token limited to this instance's repo, with an expiry, stored in $dir"
    sudo -u "$coord" install -d -m 0700 "$dir"
    read -rsp "Paste the token, then Enter (it is not shown): " token; echo
    case "$token" in github_pat_*) ;; *) echo "not a fine-grained token (github_pat_...); refusing" >&2; exit 1 ;; esac
    printf '%s\n' "$token" | sudo -u "$coord" env GH_CONFIG_DIR="$dir" gh auth login --hostname github.com --with-token
    unset token
    # git pushes from the coordinator authenticate through gh, using the same dir (GH_CONFIG_DIR is set by the coordinator).
    sudo -u "$coord" env GH_CONFIG_DIR="$dir" gh auth setup-git --hostname github.com
    echo "set credentials.yaml github: { kind: gh-config-dir, path: $dir }"
    echo "then check it: sudo -H -u $coord worklane instance show $name   (refuses a token that reaches other repos)"
    ;;
  claude)
    # Only the agent user signs in. An eval user needs a Claude login only once evals are on.
    say "Claude: sign in as $agent. In the session, run /login and follow the link; then /exit."
    sudo -iu "$agent" claude
    sudo -iu "$agent" claude auth status --json
    ;;
  eval-key)
    # Evals are off unless you turn them on: no key, no eval lane, and the eval user needs no Claude login.
    [ "$flag" = --evals-on ] || { echo "evals are off for $name: no eval key is needed. Pass --evals-on only once you have an API key and want an eval lane." >&2; exit 2; }
    id -u "$eval_user" >/dev/null 2>&1 || { echo "no $eval_user; run instance.sh $name --eval first" >&2; exit 1; }
    file="$(home_of "$eval_user")/.config/eval/anthropic_key"
    read -rsp "Paste the API key, then Enter (it is not shown): " key; echo
    printf '%s' "$key" | sudo -u "$eval_user" sh -c 'umask 077; mkdir -p "$(dirname "$1")"; cat > "$1"; chmod 0400 "$1"' _ "$file"
    unset key
    echo "set credentials.yaml eval_key: $file   (readable only by $eval_user)"
    ;;
  api-key)
    id -u "$agent" >/dev/null 2>&1 || { echo "no $agent; run instance.sh $name first" >&2; exit 1; }
    dir="$(home_of "$agent")/.config/$name-claude-key"
    file="$dir/api_key"
    if [ -n "$flag" ]; then
      [ -f "$flag" ] || { echo "$flag: no such file" >&2; exit 1; }
      key="$(tr -d '[:space:]' < "$flag")"
    else
      read -rsp "Paste the Anthropic API key, then Enter (it is not shown): " key; echo
    fi
    case "$key" in sk-ant-*) ;; *) unset key; echo "that doesn't look like an Anthropic API key (sk-ant-...); nothing installed" >&2; exit 1 ;; esac
    say "install the key for $agent only ($file, 0400, in a 0700 directory)"
    printf '%s' "$key" | sudo -u "$agent" sh -c 'umask 077; mkdir -p "$1"; chmod 0700 "$1"; rm -f "$2"; cat > "$2"; chmod 0400 "$2"' _ "$dir" "$file"
    unset key
    # claude auth status (the runner's preflight, run as the agent user) reads the agent's own settings; runs get the
    # same helper in --settings from the coordinator, which passes only this path.
    say "point $agent's Claude settings at it (apiKeyHelper), keeping its other settings"
    (cd / && sudo -u "$agent" node --input-type=module - "$(home_of "$agent")/.claude/settings.json" "cat -- $file") <<'JS'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const [file, helper] = process.argv.slice(2);
const s = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
s.apiKeyHelper = helper;
mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
JS
    say "check, as $agent: claude reports API-key auth"
    sudo -iu "$agent" claude auth status --json
    echo "In credentials.yaml set:"
    echo "  agent_api_key: $file"
    echo "then restart the instance. Its agents bill to this key; to go back to the Claude login, remove that line"
    echo "and the apiKeyHelper entry from $(home_of "$agent")/.claude/settings.json."
    ;;
  intake-discord)
    read -rsp "Paste the chat bot's token, then Enter (it is not shown): " token || true; echo
    [[ "$token" =~ ^[A-Za-z0-9._-]{50,100}$ ]] || { echo "that doesn't look like a bot token; nothing installed" >&2; exit 1; }
    install_secret "$intake_dir/discord-token" "$token"; unset token
    echo "installed $intake_dir/discord-token (0400, $coord only). In credentials.yaml set:"
    echo "  intake: { discord_token: $intake_dir/discord-token }"
    ;;
  *) echo "unknown credential $what" >&2; exit 2 ;;
esac
