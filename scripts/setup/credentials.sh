#!/usr/bin/env bash
# One credential at a time, for one instance. Secrets are read from the
# terminal without echo and passed on stdin; nothing is written to disk
# except by the tool that owns it. Creating the credentials themselves
# (the token on github.com, the Claude subscription) is up to you.
#   bash scripts/setup/credentials.sh <name> github                  coordinator's repo-scoped GitHub token
#   bash scripts/setup/credentials.sh <name> claude                  the agent user's Claude login (interactive)
#   bash scripts/setup/credentials.sh <name> eval-key --evals-on     the eval user's API key (only when evals are on)
#
# The GitHub token: fine-grained, "Only select repositories" = this instance's repo, an expiry set, and:
#   Contents: Read and write       fetch, land on the default branch, lease refs under refs/worklane/claims/
#   Issues: Read and write         the backlog: issues, labels, assignees, comments, label history
#   Metadata: Read                 required by GitHub; the start-up scope check lists the token's repos
# Nothing else. Workflows is deliberately left out: GitHub refuses a push that changes .github/workflows
# without it, so a change touching workflow files can't land through the coordinator, by design.
source "$(dirname "$0")/lib.sh"
as_root "$@"
name="${1:?usage: credentials.sh <name> github|claude|eval-key}"
what="${2:?usage: credentials.sh <name> github|claude|eval-key}"
flag="${3:-}"
coord="wl-$name" agent="wl-$name-agent" eval_user="wl-$name-eval"

case "$what" in
  github)
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
