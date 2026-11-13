#!/bin/bash
# The one way a script starts claude (#1262; R1264g/h: the shell lint refuses any other, unless pinned). Scripts call
# it through lib.sh's claude_guarded, which runs this file in a clean bash (`/usr/bin/env -i … /bin/bash --norc
# --noprofile`, by absolute paths): no caller's shell function (a `command`, `sudo` or `env` of its own, R1264i D1) and
# no caller's environment reaches it.
#   claude_guarded [--as <user>]... [--timeout <seconds>] [--env <NAME>=<value>]... -- <settings> -p|--print [<word>...]
# Its PATH is fixed by the wrapper (/usr/local/bin:/usr/bin:/bin), so sudo, timeout, printenv and claude are the
# machine's own (R1264k D2). Runs claude as each --as user in turn (sudo -H -u <user>), under timeout if given, in an EMPTY environment but for
# HOME (the last --as user's own, as sudo -H gives it, or --env HOME=), USER and LOGNAME (that user), a fixed PATH,
# CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 and the few --env names allowed below (no CLAUDE_CODE_PLUGIN_DIRS, NODE_OPTIONS or
# BUN_*). Its words come next, then the launch's guards, last: --settings <settings> --setting-sources ''
# --strict-mcp-config. <settings> is '{}' or {"apiKeyHelper":"cat -- <plain absolute path>"}. Fail closed on words:
# the first is -p or --print (no subcommand), every word that starts with '-' is one of the flags allowed below
# exactly (or <flag>=<value>), a value-taking flag has its value (none last, to take the guards), --permission-mode
# takes only dontAsk and --input-format only text (stream-json's control requests load settings, MCP servers and
# agents past the guards, R1264j D1).
set -euo pipefail
# R1264k D3: no file descriptor of the caller's but stdin, stdout and stderr reaches claude.
for cg_fd in /dev/fd/*; do
  cg_fd="${cg_fd##*/}"
  if [ "$cg_fd" -gt 2 ] 2>/dev/null; then eval "exec $cg_fd>&-" 2>/dev/null || true; fi
done
cg_sudo=() cg_timeout=() cg_env=()
cg_home="" cg_bin="" cg_settings="" cg_w="" cg_n="" cg_prev="" cg_user=""
while [ $# -gt 0 ]; do
  case "$1" in
    --as)
      [[ "${2:-}" =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo "claude_guarded: --as needs a user name" >&2; exit 2; }
      cg_sudo+=(sudo -H -u "$2"); cg_user="$2"; shift 2 ;;
    --timeout)
      [[ "${2:-}" =~ ^[0-9]+$ ]] || { echo "claude_guarded: --timeout needs whole seconds" >&2; exit 2; }
      cg_timeout=(timeout "$2"); shift 2 ;;
    --env)
      cg_n="${2:-}"; cg_n="${cg_n%%=*}"
      [[ "${2:-}" == *=* ]] || { echo "claude_guarded: --env needs NAME=value" >&2; exit 2; }
      case "$cg_n" in
        HOME) cg_home="${2#*=}" ;;
        CLAUDE_CONFIG_DIR|ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|LANG|TERM) cg_env+=("$2") ;;
        *) echo "claude_guarded: --env $cg_n is not one claude may be given" >&2; exit 2 ;;
      esac
      shift 2 ;;
    --) shift; break ;;
    *) echo "claude_guarded: unknown option $1 (its own options end with --)" >&2; exit 2 ;;
  esac
done
[ $# -ge 1 ] || { echo "claude_guarded: no settings given" >&2; exit 2; }
cg_settings="$1"; shift
if [ "$cg_settings" != '{}' ]; then
  { [[ "$cg_settings" =~ ^\{\"apiKeyHelper\":\"cat\ --\ (/[A-Za-z0-9._/-]+)\"\}$ ]] && [[ "${BASH_REMATCH[1]}/" != *//* && "${BASH_REMATCH[1]}/" != */./* && "${BASH_REMATCH[1]}/" != */../* ]]; } ||
    { echo "claude_guarded: settings may be only {} or one apiKeyHelper reading a plain absolute path" >&2; exit 2; }
fi
# R1264i D3, R1264j D4: the first word is -p/--print, so no word is read as a subcommand (`respawn`, `stop`, …).
case "${1:-}" in -p | --print) ;; *) echo "claude_guarded: its words start with -p or --print (${1:-none} isn't)" >&2; exit 2 ;; esac
cg_need=""
for cg_w in "$@"; do
  if [ -n "$cg_need" ]; then
    # The value of the flag before: --permission-mode takes only dontAsk.
    if [ "$cg_need" = --permission-mode ] && [ "$cg_w" != dontAsk ]; then echo "claude_guarded: --permission-mode $cg_w is not allowed (dontAsk only)" >&2; exit 2; fi
    if [ "$cg_need" = --input-format ] && [ "$cg_w" != text ]; then echo "claude_guarded: --input-format $cg_w is not allowed (text only: stream-json takes control requests that load settings, MCP servers and agents)" >&2; exit 2; fi
    cg_need=""
    continue
  fi
  case "$cg_w" in
    -p | --print | --verbose | --no-session-persistence | --permission-mode=dontAsk | --input-format=text) ;;
    --model | --max-turns | --max-budget-usd | --output-format | --input-format | --permission-mode | --json-schema | --fallback-model | --effort) cg_need="$cg_w" ;;
    --allowedTools | --allowed-tools | --disallowedTools | --disallowed-tools | --tools) cg_need="$cg_w" ;;
    --model=* | --max-turns=* | --max-budget-usd=* | --output-format=* | --json-schema=* | --fallback-model=* | --effort=*) ;;
    --allowedTools=* | --allowed-tools=* | --disallowedTools=* | --disallowed-tools=* | --tools=*) ;;
    -*) echo "claude_guarded: $cg_w is not a flag a script may give claude" >&2; exit 2 ;;
  esac
done
# R1264i D2, R1264j D5: a value-taking flag last would take the appended --settings as its value.
[ -z "$cg_need" ] || { echo "claude_guarded: $cg_need needs a value" >&2; exit 2; }
cg_bin="$(command -v claude)" || { echo "claude_guarded: claude is not installed" >&2; exit 1; }
case "$cg_bin" in /*) ;; *) echo "claude_guarded: claude is not a file on PATH ($cg_bin)" >&2; exit 2 ;; esac
if [ -z "$cg_home" ]; then
  if [ -n "$cg_user" ]; then cg_home="$(command "${cg_sudo[@]}" printenv HOME)" || cg_home=""; else cg_home="$HOME"; fi
fi
case "$cg_home" in /*) ;; *) echo "claude_guarded: no home for the session" >&2; exit 2 ;; esac
[ -z "$cg_user" ] || cg_env+=("USER=$cg_user" "LOGNAME=$cg_user")
command ${cg_sudo[@]+"${cg_sudo[@]}"} ${cg_timeout[@]+"${cg_timeout[@]}"} /usr/bin/env -i "HOME=$cg_home" PATH=/usr/local/bin:/usr/bin:/bin CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 ${cg_env[@]+"${cg_env[@]}"} "$cg_bin" "$@" --settings "$cg_settings" --setting-sources '' --strict-mcp-config
