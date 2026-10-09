#!/usr/bin/env bash
# One credential at a time, for one instance. Secrets are read from files or
# the terminal (never echoed) and installed with the right owner; tokens are
# never printed. Creating the credentials themselves (the GitHub App, the
# Claude subscription) is up to you.
#
#   bash scripts/setup/credentials.sh <name> github-app <app-id> <installation-id> <key.pem> <owner/repo>
#       The coordinator's GitHub identity: a GitHub App installed on only the instance's repo.
#       Installs the App's private key for wl-<name> (0400), then verifies it by minting an
#       installation token and checking the installation reaches exactly <owner/repo>.
#   bash scripts/setup/credentials.sh <name> claude
#       The agent user's Claude login (interactive).
#   bash scripts/setup/credentials.sh <name> github
#       Fallback only: a fine-grained personal access token instead of an App.
#   bash scripts/setup/credentials.sh <name> eval-key --evals-on
#       The eval user's API key; only once evals are on.
#
# The App's permissions: Contents read/write (fetch, push task branches, lease refs), Issues read/write
# (the backlog), Pull requests read/write (open PRs; Worklane never merges), Metadata read. Nothing else.
# Workflows is deliberately left out: GitHub refuses a push that changes .github/workflows without it,
# so such a change can't go out through the coordinator. No webhook.
source "$(dirname "$0")/lib.sh"
as_root "$@"
name="${1:?usage: credentials.sh <name> github-app|claude|github|eval-key ...}"
what="${2:?usage: credentials.sh <name> github-app|claude|github|eval-key ...}"
flag="${3:-}"
coord="wl-$name" agent="wl-$name-agent" eval_user="wl-$name-eval"

case "$what" in
  github-app)
    app_id="${3:?usage: credentials.sh <name> github-app <app-id> <installation-id> <key.pem> <owner/repo>}"
    inst_id="${4:?installation id missing}"
    src="${5:?path to the App private key (.pem) missing}"
    repo="${6:?the instance repo (owner/name) missing}"
    [[ "$app_id" =~ ^[0-9]+$ && "$inst_id" =~ ^[0-9]+$ ]] || { echo "App and installation ids are numbers" >&2; exit 1; }
    [[ "$repo" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]] || { echo "repo must be owner/name" >&2; exit 1; }
    grep -q -- '-----BEGIN [A-Z ]*PRIVATE KEY-----' "$src" || { echo "$src is not a PEM private key" >&2; exit 1; }
    dir="/home/$coord/.config/$name-app"
    key="$dir/private-key.pem"
    say "install the App's private key for $coord only ($key, 0400)"
    install -d -o "$coord" -g "$coord" -m 0700 "$dir"
    install -o "$coord" -g "$coord" -m 0400 "$src" "$key"
    say "verify as $coord: mint an installation token and list what the installation reaches"
    sudo -u "$coord" node - "$key" "$app_id" "$inst_id" "$repo" <<'JS'
const [key, appId, instId, repo] = process.argv.slice(2);
const { createSign } = require('node:crypto');
const { readFileSync } = require('node:fs');
const b64 = (x) => Buffer.from(x).toString('base64url');
const iat = Math.floor(Date.now() / 1000) - 60;
const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
const body = b64(JSON.stringify({ iat, exp: iat + 600, iss: appId }));
const jwt = `${head}.${body}.${b64(createSign('RSA-SHA256').update(`${head}.${body}`).sign(readFileSync(key, 'utf8')))}`;
const h = (auth) => ({ authorization: `Bearer ${auth}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' });
(async () => {
  const app = await fetch('https://api.github.com/app', { headers: h(jwt) });
  if (!app.ok) throw new Error(`the key does not sign for App ${appId} (GitHub ${app.status})`);
  const t = await fetch(`https://api.github.com/app/installations/${instId}/access_tokens`, { method: 'POST', headers: h(jwt) });
  if (!t.ok) throw new Error(`could not mint a token for installation ${instId} (GitHub ${t.status})`);
  const { token, permissions } = await t.json();
  const r = await fetch('https://api.github.com/installation/repositories?per_page=100', { headers: h(token) });
  const repos = (await r.json()).repositories.map((x) => x.full_name.toLowerCase());
  console.log(`App ${appId} (${(await app.json()).slug}), installation ${instId}`);
  console.log(`reaches: ${repos.join(', ') || 'nothing'}`);
  console.log(`permissions: ${Object.entries(permissions).map(([k, v]) => `${k}:${v}`).join(', ')}`);
  if (repos.length !== 1 || repos[0] !== repo.toLowerCase()) throw new Error(`the installation must reach exactly ${repo}`);
  if (permissions.workflows) throw new Error('the App has the Workflows permission; remove it');
  if (permissions.administration) throw new Error('the App has the Administration permission; remove it');
  console.log('OK: the key works and the installation reaches only the instance repo');
})().catch((e) => { console.error(`FAILED: ${e.message}`); process.exit(1); });
JS
    echo
    echo "set credentials.yaml github: { kind: app, app_id: $app_id, installation_id: $inst_id, key_path: $key }"
    read -rp "Delete the copy you brought to this machine ($src) now with shred? [y/N] " yn
    if [ "$yn" = y ]; then shred -u "$src" && echo "deleted $src"; else echo "kept $src; delete it yourself"; fi
    echo "Now delete the key on your other machine (the downloaded .pem). If it's ever lost, generate a new one in the App's settings."
    ;;
  github)
    echo "fallback: a personal access token instead of a GitHub App (prefer github-app)"
    dir="/home/$coord/.config/$name-gh"
    say "GitHub: a fine-grained token limited to this instance's repo, with an expiry, stored in $dir"
    sudo -u "$coord" install -d -m 0700 "$dir"
    read -rsp "Paste the token, then Enter (it is not shown): " token; echo
    case "$token" in github_pat_*) ;; *) echo "not a fine-grained token (github_pat_...); refusing" >&2; exit 1 ;; esac
    printf '%s\n' "$token" | sudo -u "$coord" env GH_CONFIG_DIR="$dir" gh auth login --hostname github.com --with-token
    unset token
    # git pushes from the coordinator authenticate through gh, using the same dir (GH_CONFIG_DIR is set by the coordinator).
    sudo -u "$coord" env GH_CONFIG_DIR="$dir" gh auth setup-git --hostname github.com
    echo "set credentials.yaml github: { kind: gh-config-dir, path: $dir }"
    echo "then check it: sudo -iu $coord npx worklane instance show $name   (refuses a token that reaches other repos)"
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
    file="/home/$eval_user/.config/eval/anthropic_key"
    read -rsp "Paste the API key, then Enter (it is not shown): " key; echo
    printf '%s' "$key" | sudo -u "$eval_user" sh -c 'umask 077; mkdir -p "$(dirname "$1")"; cat > "$1"; chmod 0400 "$1"' _ "$file"
    unset key
    echo "set credentials.yaml eval_key: $file   (readable only by $eval_user)"
    ;;
  *) echo "unknown credential $what" >&2; exit 2 ;;
esac
