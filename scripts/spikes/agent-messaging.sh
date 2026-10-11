#!/usr/bin/env bash
# Spike, not setup: can the coordinator get a message to a running agent
# that runs as another OS user? Needs the agent user's Claude login. Spends a
# little subscription usage (two short turns). Results go to stdout.
#   bash scripts/spikes/agent-messaging.sh <name>
source "$(dirname "$0")/../setup/lib.sh"
as_root "$@"
name="${1:?usage: agent-messaging.sh <name>}"
coord="wl-$name" agent="wl-$name-agent"
out="$(mktemp)"; trap 'rm -f "$out"' EXIT

say "1. streaming input: the coordinator holds the agent's stdin and sends a second message mid-turn"
# The agent is told to wait 20s in Bash, so the second message arrives while its first turn is still running.
{
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Run `sleep 20` with Bash, then reply with exactly DONE-1."}}'
  sleep 5
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Second message: reply with exactly PING-2."}}'
  sleep 60
} | sudo -u "$coord" sudo -n -u "$agent" -- /usr/bin/env -i HOME="/home/$agent" PATH=/usr/local/bin:/usr/bin:/bin \
    claude -p --input-format stream-json --output-format stream-json --verbose --max-turns 6 \
    --allowedTools 'Bash(sleep:*)' --permission-mode dontAsk > "$out" 2>&1 || true
node -e '
const lines=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
const text=(m)=>JSON.stringify(m);
const i1=lines.findIndex(m=>/DONE-1/.test(text(m)) && m.type==="assistant");
const i2=lines.findIndex(m=>/PING-2/.test(text(m)) && m.type==="assistant");
const results=lines.filter(m=>m.type==="result").length;
console.log("assistant DONE-1 at line", i1, "| assistant PING-2 at line", i2, "| result events", results);
console.log(i2<0 ? "PING-2 never answered: mid-run messages are not delivered this way" : i2<i1 ? "PING-2 answered before DONE-1: delivered mid-turn" : "PING-2 answered after DONE-1: queued until the first turn ended");
' "$out"

say "2. cross-session inbox: which unix sockets does a live agent session listen on, and can the coordinator user connect?"
# Checked from outside, as root: the agent needs no tool permissions. Its stdin stays open, so the session stays up.
out2="$(mktemp)"
{
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Reply with exactly READY."}}'
  sleep 45
} | sudo -u "$coord" sudo -n -u "$agent" -- /usr/bin/env -i HOME="/home/$agent" PATH=/usr/local/bin:/usr/bin:/bin \
    claude -p --input-format stream-json --output-format stream-json --verbose --max-turns 2 --permission-mode dontAsk > "$out2" 2>&1 &
bg=$!
for _ in $(seq 1 40); do grep -q READY "$out2" 2>/dev/null && break; sleep 1; done
grep -q READY "$out2" || { echo "the agent session never answered READY:"; tail -5 "$out2"; }
pids="$(pgrep -u "$agent" | paste -sd'|' - || true)"
echo "agent processes: ${pids:-none}"
socks="$( [ -n "$pids" ] && ss -xlpn | grep -E "pid=($pids)," | awk '{print $5}' | sort -u || true)"
if ! ss -xlpn | grep -q 'users:'; then
  echo "INCONCLUSIVE: ss shows no process for any socket (needs root with CAP_SYS_PTRACE)"
elif [ -z "$socks" ]; then
  echo "RESULT: the agent session listens on no unix socket; nothing for the coordinator to connect to"
else
  for s in $socks; do
    echo "socket: $s"
    case "$s" in
      @*) echo "  abstract socket: no file permissions; any process in this network namespace can connect" ;;
      *) ls -ld "$(dirname "$s")" "$s" ;;
    esac
    path="$s"; [ "${s#@}" != "$s" ] && path="\0${s#@}"
    for u in "$coord" "$agent"; do
      if sudo -u "$u" python3 -c 'import socket,sys; p=sys.argv[1].replace("\\0","\0",1); s=socket.socket(socket.AF_UNIX); s.settimeout(3); s.connect(p)' "$path" 2>/dev/null; then
        echo "  $u: connect OK"
      else
        echo "  $u: connect refused"
      fi
    done
  done
fi
wait "$bg" 2>/dev/null || true
rm -f "$out2"

say "3. interrupt: does a control_request interrupt on the stream-json input stop the current turn?"
# The agent is told to wait 20s in Bash; an interrupt goes in 5s later. Honored = a control_response
# for it, then a result ending the turn without the reply the sleep was for.
out3="$(mktemp)"
{
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Run `sleep 20` with Bash, then reply with exactly DONE-1."}}'
  sleep 5
  printf '%s\n' '{"type":"control_request","request_id":"int-1","request":{"subtype":"interrupt"}}'
  sleep 10
} | sudo -u "$coord" sudo -n -u "$agent" -- /usr/bin/env -i HOME="/home/$agent" PATH=/usr/local/bin:/usr/bin:/bin \
    claude -p --input-format stream-json --output-format stream-json --verbose --max-turns 6 \
    --allowedTools 'Bash(sleep:*)' --permission-mode dontAsk > "$out3" 2>&1 || true
node -e '
const lines=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
const ack=lines.find(m=>m.type==="control_response" && m.response && m.response.request_id==="int-1");
const result=lines.find(m=>m.type==="result");
const done=lines.some(m=>m.type==="assistant" && /DONE-1/.test(JSON.stringify(m)));
console.log("control_response:", ack ? JSON.stringify(ack.response).slice(0,200) : "none", "| result:", result ? result.subtype : "none", "| DONE-1 answered:", done);
console.log(ack && result && !done ? "RESULT: interrupt honored: the turn ended without finishing" : "RESULT: interrupt NOT confirmed");
' "$out3"
rm -f "$out3"
