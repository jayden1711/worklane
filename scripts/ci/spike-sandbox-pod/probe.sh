#!/usr/bin/env bash
# SPIKE (do not merge), #698 decision 5. Runs inside one probe pod (the image's entrypoint) as a non-root user and
# prints one line per fact and per check, for run.sh to collect:
#   INFO|<name>|<value>          what the pod got (seccomp mode, AppArmor label, uid map, ...)
#   RESULT|<check>|<outcome>|<detail>
# It measures the sandbox itself, never a model: util-linux unshare, bubblewrap with the flags sandbox-runtime passes
# (@anthropic-ai/sandbox-runtime 0.0.78, src/sandbox/linux-sandbox-utils.ts:3033-3254 at tag v0.0.78), and the srt CLI
# on trivial commands. Never fails itself: every outcome is a printed fact.
set -u

SRT=/opt/srt/node_modules/.bin/srt
H="${KUBERNETES_SERVICE_HOST:-}"
P="${KUBERNETES_SERVICE_PORT:-443}"
W="$(mktemp -d /tmp/probe.XXXXXX)"
cd "$W" || exit 1
export HOME="$W" TMPDIR=/tmp

oneline() { printf '%s' "$1" | tr '\n|' ' /' | cut -c1-"${2:-400}"; }
info() { printf 'INFO|%s|%s\n' "$1" "$(oneline "$2" 4000)"; }
res() { printf 'RESULT|%s|%s|%s\n' "$1" "$2" "$(oneline "$3")"; }
# run <check> <cmd...>: yes when the command exits 0, no (with its exit code and words) otherwise.
run() {
  local name="$1" out
  shift
  if out="$(timeout 30 "$@" 2>&1)"; then res "$name" yes "$out"; else res "$name" no "exit $?: $out"; fi
}

info id "$(id)"
info kernel "$(uname -r)"
info status "$(grep -E '^(Seccomp|Seccomp_filters|NoNewPrivs|CapEff|CapBnd):' /proc/self/status | tr '\t' ' ')"
info apparmor "$(cat /proc/self/attr/apparmor/current 2> /dev/null || cat /proc/self/attr/current 2> /dev/null || echo none)"
info uid_map "$(cat /proc/self/uid_map)"
info max_user_namespaces "$(cat /proc/sys/user/max_user_namespaces 2>&1)"
info apparmor_restrict_unprivileged_userns "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>&1)"
info mounts_over_proc "$(awk '$5 ~ "^/proc/" { print $5 }' /proc/self/mountinfo | tr '\n' ' ')"
info bwrap "$(bwrap --version 2>&1)"
info srt "$("$SRT" --version 2>&1)"
info api "${H:-none}:$P"

# 1. Unprivileged user namespaces, then what bubblewrap needs inside one: a mount namespace with capabilities (what
#    Ubuntu's apparmor_restrict_unprivileged_userns strips) and a fresh /proc (what masked /proc paths refuse).
run unshare_user unshare -U true
run unshare_user_mount unshare -Ur -m true
run unshare_fresh_proc unshare -Ur -p -f --mount-proc true

# 2. bubblewrap as sandbox-runtime runs it: --new-session --die-with-parent, --unshare-net (network restricted),
#    --ro-bind / / plus the writable paths, --dev /dev, --unshare-pid, --unshare-user --cap-drop ALL, and --proc /proc
#    (or --bind /proc /proc under enableWeakerNestedSandbox).
BW=(bwrap --new-session --die-with-parent --unshare-net --ro-bind / / --bind "$W" "$W" --dev /dev --unshare-pid --unshare-user --cap-drop ALL)
run bwrap_srt_flags "${BW[@]}" --proc /proc -- /bin/bash -c true
run bwrap_weaker_proc "${BW[@]}" --bind /proc /proc -- /bin/bash -c true

# 3. Network isolation: the API server's service address answers from the pod, and not from inside the sandbox.
TCP='exec 3<>"/dev/tcp/$0/$1" && echo connected'
run net_outside timeout 10 bash -c "$TCP" "$H" "$P"
for proc in fresh weaker; do
  pa=(--proc /proc)
  [ "$proc" = weaker ] && pa=(--bind /proc /proc)
  out="$(timeout 30 "${BW[@]}" "${pa[@]}" -- /bin/bash -c "echo sandbox-started; timeout 10 bash -c '$TCP' \"\$0\" \"\$1\"" "$H" "$P" 2>&1)"
  case "$out" in
    *connected*) res "net_isolated_bwrap_$proc" NO-REACHED-NETWORK "$out" ;;
    *sandbox-started*) res "net_isolated_bwrap_$proc" yes "$out" ;;
    *) res "net_isolated_bwrap_$proc" n/a "sandbox did not start: $out" ;;
  esac
done

# 4. The srt CLI on trivial commands, no network allowed, writes only to the work dir, one file denied.
#    The command records the interfaces it sees (/proc/net/dev is the reader's network namespace): only lo means it
#    ran inside the sandbox's own network namespace.
printf 's3cret\n' > "$W/secret.txt"
cfg() {
  printf '{"network":{"allowedDomains":[],"deniedDomains":[]},"filesystem":{"denyRead":["%s/secret.txt"],"allowRead":[],"allowWrite":["%s"],"denyWrite":[]}%s}\n' "$W" "$W" "$1"
}
cfg '' > "$W/srt.json"
cfg ',"enableWeakerNestedSandbox":true' > "$W/srt-weaker.json"
IFACES='awk -F: "NR > 2 { gsub(/ /, \"\", \$1); printf \"%s \", \$1 }" /proc/net/dev'
info srt_wrapped "$(timeout 30 node /opt/probe/wrap.mjs "$W/srt.json" 2>&1)"

srt_marker() { # <check> <settings> <marker>
  local out code
  out="$(timeout 60 "$SRT" --settings "$2" -c "$IFACES > $3" 2>&1)"
  code=$?
  if [ "$code" = 0 ] && [ "$(tr -d ' ' < "$3")" = lo ]; then
    res "$1" yes "ran inside the sandbox; interfaces seen: $(cat "$3")"
  elif [ "$code" = 0 ]; then
    res "$1" RAN-UNSANDBOXED "exit 0 and the command saw interfaces: $(cat "$3" 2> /dev/null)"
  elif [ -e "$3" ]; then
    res "$1" no "exit $code after the command ran (interfaces: $(cat "$3")): $out"
  else
    res "$1" no "exit $code, the command never ran: $out"
  fi
}
srt_marker srt_true "$W/srt.json" "$W/marker-true"
# Fail closed: when srt can't sandbox, the command must not have run at all.
if [ -e "$W/marker-true" ]; then
  case "$(tr -d ' ' < "$W/marker-true")" in
    lo) res fail_closed n/a "the sandbox ran" ;;
    *) res fail_closed BROKEN "the command ran outside the sandbox" ;;
  esac
else
  res fail_closed held "srt refused and the command never ran"
fi
# Enforcement, where srt runs: a direct connection fails, the denied file can't be read, and the command can't see the
# pod's processes (only with a fresh /proc; under enableWeakerNestedSandbox the pod's /proc is bound in). n/a when the
# sandbox never started (the command printed nothing).
enforce() { # <suffix> <settings>
  local out code
  out="$(timeout 60 "$SRT" --settings "$2" -c "echo sandbox-started; timeout 10 bash -c '$TCP' $H $P" 2>&1)"
  code=$?
  case "$out" in
    *connected*) res "srt_net_blocked$1" NO-REACHED-NETWORK "$out" ;;
    *sandbox-started*) res "srt_net_blocked$1" "$([ "$code" != 0 ] && echo yes || echo no)" "exit $code: $out" ;;
    *) res "srt_net_blocked$1" n/a "sandbox did not start: exit $code: $out" ;;
  esac
  out="$(timeout 60 "$SRT" --settings "$2" -c "echo sandbox-started; cat $W/secret.txt" 2>&1)"
  code=$?
  case "$out" in
    *s3cret*) res "srt_deny_read$1" NO-READ-IT "$out" ;;
    *sandbox-started*) res "srt_deny_read$1" "$([ "$code" != 0 ] && echo yes || echo no)" "exit $code: $out" ;;
    *) res "srt_deny_read$1" n/a "sandbox did not start: exit $code: $out" ;;
  esac
  # PID 1 of the pod is probe.sh's bash; a sandbox with its own /proc sees its own PID 1 instead.
  out="$(timeout 60 "$SRT" --settings "$2" -c 'echo sandbox-started; tr "\0" " " < /proc/1/cmdline' 2>&1)"
  case "$out" in
    *probe.sh*) res "srt_pod_procs_hidden$1" no "the sandbox sees the pod's PID 1: $out" ;;
    *sandbox-started*) res "srt_pod_procs_hidden$1" yes "$out" ;;
    *) res "srt_pod_procs_hidden$1" n/a "sandbox did not start: $out" ;;
  esac
}
enforce '' "$W/srt.json"
srt_marker srt_weaker "$W/srt-weaker.json" "$W/marker-weaker"
enforce _weaker "$W/srt-weaker.json"
echo "PROBE-DONE"
