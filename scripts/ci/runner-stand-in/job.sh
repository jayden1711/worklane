#!/bin/bash
# CI only: the stand-in runner's "job" (see run.sh beside it), as the runner user inside the runner's sandbox. Each
# probe prints PROBE <job> PASS|FAIL <what>; the last line is PROBE <job> DONE fail=<0|1>.
set -u
j="$JOB_ID" fail=0
ok() { echo "PROBE $j PASS $*"; }
bad() { echo "PROBE $j FAIL $*"; fail=1; }
# One TCP connection attempt: "connected", or the error.
try() { local out; if out="$(timeout 5 bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ "$1" "$2" 2>&1)"; then echo connected; elif [ -z "$out" ]; then echo "timed out"; else echo "${out##*$'\n'}"; fi; }
refused() { case "$1" in *"No route to host"* | *"Permission denied"*) return 0 ;; *) return 1 ;; esac; }

# Files: none of worklane's, no other user's home, not this runner's registration. The CI job put a .ci-sentinel in
# each beforehand: the job must not see it, nor anything else inside. Each write tried here (.ci-written-<job>) must
# not reach the machine: the CI job looks for them afterwards (a private, empty tmpfs such as ProtectHome= mounts on
# /root may take them, and goes with the job).
for p in /srv/worklane /opt/worklane /var/lib/worklane /etc/worklane /var/lib/worklane-test "/home/$DEMO_USER" /root "$REG_DIR"; do
  if [ -e "$p/.ci-sentinel" ] || [ -n "$(ls -A "$p" 2>/dev/null)" ]; then bad "sees inside $p: $(ls -A "$p" 2>/dev/null | head -n 3 | tr '\n' ' ')"
  else ok "can't see inside $p"; fi
  : > "$p/.ci-written-$j" 2>/dev/null || true
done
if [ "$HOME" = /home/runner ] && [ -w "$HOME" ]; then ok "HOME is /home/runner, writable"; else bad "HOME is $HOME"; fi
if compgen -G "$HOME/marker-*" >/dev/null; then bad "an earlier job's file is in HOME: $(ls "$HOME")"; else ok "HOME is new"; fi
: > "$HOME/marker-$j"
if [ -d /proc/1 ]; then bad "sees pid 1"; else ok "other users' processes are invisible"; fi
if sudo -n true 2>/dev/null; then bad "sudo works"; else ok "no sudo"; fi
if flock -n -x "$WORKLANE_CI_LOCK" true; then bad "the full-run lock is free during the job"; else ok "the job holds the full-run lock (shared)"; fi

# Network: the internet, but nothing on this machine, the LAN or Tailscale.
if getent hosts github.com >/dev/null; then ok "DNS"; else bad "DNS"; fi
out="$(try github.com 443)"; if [ "$out" = connected ]; then ok "reaches github.com:443"; else bad "github.com:443: $out"; fi
for t in "127.0.0.1 $LISTEN_PORT" "$HOST_IP $LISTEN_PORT" "10.255.255.1 9" "100.100.100.100 80"; do
  # shellcheck disable=SC2086 # host and port
  out="$(try $t)"; if refused "$out"; then ok "refused $t ($out)"; else bad "not refused $t: $out"; fi
done

# Docker: its own rootless daemon; containers reach the internet, not this machine.
if docker info --format '{{json .SecurityOptions}}' 2>/dev/null | grep -q rootless; then ok "Docker is rootless"; else bad "Docker isn't rootless or isn't up"; fi
if [ -n "$(docker ps -aq)" ]; then bad "an earlier job's container is still here: $(docker ps -a --format '{{.Names}}')"; else ok "no containers from an earlier job"; fi
img=alpine:3.20
if out="$(docker run --rm "$img" wget -q -T 10 -O- https://api.github.com/zen 2>&1)"; then ok "a container reaches the internet"; else bad "a container can't reach the internet: $out"; fi
for u in "http://$HOST_IP:$LISTEN_PORT/" "http://10.0.2.2:$LISTEN_PORT/"; do
  if out="$(docker run --rm "$img" wget -q -T 5 -O- "$u" 2>&1)"; then bad "a container reached $u"; else ok "a container can't reach $u (${out##*$'\n'})"; fi
done
b="$(mktemp -d)"
printf 'FROM %s\nRUN wget -q -T 10 -O /zen https://api.github.com/zen\n' "$img" > "$b/Dockerfile"
if out="$(docker build -q -t ci-probe "$b" 2>&1)"; then ok "docker build, with the network"; else bad "docker build: $out"; fi
docker run -d --name "leftover-$j" "$img" sleep 600 >/dev/null && ok "left a container running, for the reset"

echo "PROBE $j DONE fail=$fail"
