#!/usr/bin/env bash
# One credential at a time, for one instance. Secrets are read from the
# terminal without echo and passed on stdin; nothing is written to disk
# except by the tool that owns it. Creating the credentials themselves
# (the token on github.com, the Claude subscription) is up to you.
#   bash scripts/setup/credentials.sh <name> github     coordinator's repo-scoped GitHub token
#   bash scripts/setup/credentials.sh <name> claude     the agent user's Claude login (interactive)
#   bash scripts/setup/credentials.sh <name> eval-key   the eval user's API key (eval lanes only)
source "$(dirname "$0")/lib.sh"
as_root "$@"
name="${1:?usage: credentials.sh <name> github|claude|eval-key}"
what="${2:?usage: credentials.sh <name> github|claude|eval-key}"
coord="wl-$name" agent="wl-$name-agent" eval_user="wl-$name-eval"

case "$what" in
  github)
    dir="/home/$coord/.config/$name-gh"
    say "GitHub: a fine-grained token limited to this instance's repo, stored in $dir"
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
    say "Claude: sign in as $agent. In the session, run /login and follow the link; then /exit."
    sudo -iu "$agent" claude
    sudo -iu "$agent" claude auth status --json
    ;;
  eval-key)
    id -u "$eval_user" >/dev/null 2>&1 || { echo "no $eval_user; run instance.sh $name --eval first" >&2; exit 1; }
    file="/home/$eval_user/.config/eval/anthropic_key"
    read -rsp "Paste the API key, then Enter (it is not shown): " key; echo
    printf '%s' "$key" | sudo -u "$eval_user" sh -c 'umask 077; mkdir -p "$(dirname "$1")"; cat > "$1"; chmod 0400 "$1"' _ "$file"
    unset key
    echo "set credentials.yaml eval_key: $file   (readable only by $eval_user)"
    ;;
  *) echo "unknown credential $what" >&2; exit 2 ;;
esac
