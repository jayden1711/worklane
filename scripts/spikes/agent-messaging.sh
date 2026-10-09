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

say "2. cross-session inbox: can the coordinator user reach the agent session's socket?"
sudo -u "$agent" /usr/bin/env -i HOME="/home/$agent" PATH=/usr/local/bin:/usr/bin:/bin \
  claude -p "Run this with Bash and reply with its output only: echo \$CLAUDE_CODE_MESSAGING_SOCKET; ls -ld \"\$(dirname \"\$CLAUDE_CODE_MESSAGING_SOCKET\")\" \"\$CLAUDE_CODE_MESSAGING_SOCKET\"" \
  --allowedTools 'Bash(echo:*)' 'Bash(ls:*)' --permission-mode dontAsk --max-turns 3 2>&1 | tail -5
echo "(the socket lives under the agent user; if its directory is 0700, the coordinator user can't connect to it)"
