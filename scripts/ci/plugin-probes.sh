#!/usr/bin/env bash
# Plugin design probes P1-P5, P7, P8 (docs: the Plugins design note, section 12). Read-only facts about the installed
# claude CLI; makes no model call that succeeds (a fake API key: the init event comes before any request).
# Usage: plugin-probes.sh <work dir> [<user to run claude as>]
# With a user (CI, as root through sudo): claude runs as that user with its own HOME, as the runner runs agents, and
# the empty plugins root is root-owned 0555. Prints one "PROBE <id> <result>" line per finding; exits 0 unless the
# script itself breaks. Interpretation is the reader's: no probe "passes" or "fails" here.
set -euo pipefail
W="$1"
U="${2:-}"
mkdir -p "$W"
H="$W/home"
mkdir -p "$H" "$W/work" "$W/plug/p1/.claude-plugin" "$W/plug/p1/skills/hello" "$W/plug/pm/.claude-plugin" \
  "$W/mkt/.claude-plugin" "$W/mkt/plugins/p2/.claude-plugin" "$W/mkt/plugins/p2/skills/two" "$W/empty-root"
git -C "$W/work" init -q 2>/dev/null || true

# Fixtures: p1 (a skill, loaded with --plugin-dir); pm (an .mcp.json stdio server that writes a marker when started);
# probe-mkt with probe-two (a skill), for a user-scope install.
echo '{"name":"probe-one","version":"0.0.1"}' > "$W/plug/p1/.claude-plugin/plugin.json"
printf -- '---\nname: hello\ndescription: probe skill\n---\nSay hi.\n' > "$W/plug/p1/skills/hello/SKILL.md"
echo '{"name":"probe-mcp","version":"0.0.1"}' > "$W/plug/pm/.claude-plugin/plugin.json"
cat > "$W/plug/pm/server.js" <<'EOF'
// A minimal stdio MCP server: records every message it receives, answers initialize and tools/list.
const fs = require('fs');
const log = process.env.PROBE_LOG || require('path').join(__dirname, 'mcp-log.jsonl');
fs.appendFileSync(log, JSON.stringify({ started: true, pid: process.pid }) + '\n');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    fs.appendFileSync(log, line + '\n');
    const m = JSON.parse(line);
    if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'probe', version: '0' } } }) + '\n');
    else if (m.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: 'probe', inputSchema: { type: 'object' } }] } }) + '\n');
    else if (m.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }) + '\n');
  }
});
EOF
echo "{\"mcpServers\":{\"probesrv\":{\"command\":\"node\",\"args\":[\"$W/plug/pm/server.js\"]}}}" > "$W/plug/pm/.mcp.json"
echo '{"name":"probe-two","version":"0.0.2"}' > "$W/mkt/plugins/p2/.claude-plugin/plugin.json"
printf -- '---\nname: two\ndescription: probe two\n---\nTwo.\n' > "$W/mkt/plugins/p2/skills/two/SKILL.md"
echo '{"name":"probe-mkt","owner":{"name":"probe"},"plugins":[{"name":"probe-two","source":"./plugins/p2"}]}' > "$W/mkt/.claude-plugin/marketplace.json"

if [ -n "$U" ]; then
  chown -R "$U" "$W/home" "$W/work" "$W/plug" "$W/mkt"
  chown root:root "$W/empty-root" && chmod 0555 "$W/empty-root"
  chmod 0755 "$W"
fi
CL="$(command -v claude)"
# Run as the user (or this process), with only the variables an agent run gets.
as() {
  local envs=(PATH="$PATH" HOME="$H" CLAUDE_CONFIG_DIR="$H/.claude" ANTHROPIC_API_KEY=sk-ant-probe-not-a-key PROBE_LOG="$W/plug/pm/mcp-log.jsonl")
  while [ "$#" -gt 0 ] && [[ "$1" == *=* ]]; do envs+=("$1"); shift; done
  if [ -n "$U" ]; then (cd "$W/work" && sudo -u "$U" env -i "${envs[@]}" "$@"); else (cd "$W/work" && env -i "${envs[@]}" "$@"); fi
}
# One session's init event, as compact JSON: plugin sources (builtins dropped), MCP servers, MCP tools.
init() {
  # The variadic flags (--mcp-config, --allowedTools) would swallow a trailing prompt: the prompt goes on stdin.
  { echo hi | as "$@" -p --output-format stream-json --verbose --max-turns 1 2> "$W/last.err" || true; } \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const l of s.split("\n")){if(!l.trim())continue;let j;try{j=JSON.parse(l)}catch{continue}
      if(j.type==="system"&&j.subtype==="init"){console.log(JSON.stringify({plugins:(j.plugins||[]).filter(p=>p.path!=="builtin").map(p=>p.source),builtin:(j.plugins||[]).filter(p=>p.path==="builtin").map(p=>p.source),mcp:j.mcp_servers,mcpTools:(j.tools||[]).filter(t=>String(t).startsWith("mcp__")),keys:Object.keys(j).sort()}));return}}
      console.log(JSON.stringify({noInit:true,stderr:require("fs").readFileSync(process.argv[1],"utf8").slice(-300)}))})' "$W/last.err"
}
probe() { echo "PROBE $1 $2"; }
FLAGS=(--setting-sources project --strict-mcp-config)

probe version "$("$CL" --version)"
probe os "$(uname -sr) user=${U:-$(id -un)}"

# P4: the init event's fields, with one --plugin-dir plugin.
probe P4 "$(init "$CL" "${FLAGS[@]}" --plugin-dir "$W/plug/p1" | tr -d '\n')"

# P1: a plugin installed at user scope in the agent's own home, from a local marketplace.
as "$CL" plugin marketplace add "$W/mkt" > "$W/p1-add.log" 2>&1 || true
as "$CL" plugin install probe-two@probe-mkt > "$W/p1-install.log" 2>&1 || true
probe P1.install "$(tail -n 1 "$W/p1-install.log")"
probe P1.user-settings "$(cat "$H/.claude/settings.json" 2>/dev/null | tr -d '\n ' || echo none)"
# Runner's flags (+ the runner's own --settings, which carries no enabledPlugins).
probe P1a.enabled-in-user.setting-sources-project "$(init "$CL" "${FLAGS[@]}" --settings '{"disableAllHooks":false}')"
probe P1b.enabled-in-user.all-sources "$(init "$CL" --strict-mcp-config)"
if [ -f "$H/.claude/settings.json" ]; then
  node -e 'const f=process.argv[1],fs=require("fs");const d=JSON.parse(fs.readFileSync(f));delete d.enabledPlugins;fs.writeFileSync(f,JSON.stringify(d))' "$H/.claude/settings.json"
  [ -n "$U" ] && chown "$U" "$H/.claude/settings.json"
fi
probe P1c.no-enabled-entry.setting-sources-project "$(init "$CL" "${FLAGS[@]}")"
probe P1d.no-enabled-entry.all-sources "$(init "$CL" --strict-mcp-config)"

# P2: the plugins root moved to an empty dir the user can't write.
probe P2.start "$(init CLAUDE_CODE_PLUGIN_CACHE_DIR="$W/empty-root" "$CL" "${FLAGS[@]}" --plugin-dir "$W/plug/p1")"
probe P2.start.stderr "$(tail -c 300 "$W/last.err" | tr '\n' ' ')"
set +e
as CLAUDE_CODE_PLUGIN_CACHE_DIR="$W/empty-root" "$CL" plugin marketplace add "$W/mkt" > "$W/p2-add.log" 2>&1; rc1=$?
as CLAUDE_CODE_PLUGIN_CACHE_DIR="$W/empty-root" "$CL" plugin install probe-two@probe-mkt > "$W/p2-install.log" 2>&1; rc2=$?
set -e
probe P2.marketplace-add "rc=$rc1 $(tr '\n' ' ' < "$W/p2-add.log" | head -c 600)"
probe P2.install "rc=$rc2 $(tr '\n' ' ' < "$W/p2-install.log" | head -c 600)"
probe P2.empty-root-after "$(find "$W/empty-root" -mindepth 1 | head -5 | tr '\n' ' ')(end)"
probe P2.user-plugins-ignored "$(init CLAUDE_CODE_PLUGIN_CACHE_DIR="$W/empty-root" "$CL" --strict-mcp-config)"

# P3: --plugin-dir with project-only sources and no enabledPlugins (P4 shows it); a plugin's .mcp.json under --strict-mcp-config.
rm -f "$W/plug/pm/mcp-log.jsonl"
probe P3.plugin-mcp.strict "$(init "$CL" "${FLAGS[@]}" --plugin-dir "$W/plug/pm") started=$( [ -s "$W/plug/pm/mcp-log.jsonl" ] && echo yes || echo no)"
rm -f "$W/plug/pm/mcp-log.jsonl"
probe P3.plugin-mcp.not-strict "$(init "$CL" --setting-sources project --plugin-dir "$W/plug/pm") started=$( [ -s "$W/plug/pm/mcp-log.jsonl" ] && echo yes || echo no)"

# P5: allowedMcpServers (serverCommand) in --settings, without --strict-mcp-config, against the plugin's own server.
rm -f "$W/plug/pm/mcp-log.jsonl"
probe P5.allowlist-other-command "$(init "$CL" --setting-sources project --settings '{"allowedMcpServers":[{"serverCommand":["/nonexistent/connector","x"]}]}' --plugin-dir "$W/plug/pm") started=$( [ -s "$W/plug/pm/mcp-log.jsonl" ] && echo yes || echo no)"

# P7: what claude sends an MCP server at connect (initialize, tools/list), from a --mcp-config server.
rm -f "$W/plug/pm/mcp-log.jsonl"
echo "{\"mcpServers\":{\"probecfg\":{\"command\":\"node\",\"args\":[\"$W/plug/pm/server.js\"]}}}" > "$W/mcp.json"
[ -n "$U" ] && chown "$U" "$W/mcp.json"
probe P7.init "$(init "$CL" "${FLAGS[@]}" --mcp-config "$W/mcp.json")"
grep -v '"started"' "$W/plug/pm/mcp-log.jsonl" 2>/dev/null | while IFS= read -r l; do probe P7.received "$l"; done

# P8: claude plugin validate --strict, with no network (unshare -n, as root in CI), on a good and a bad plugin.
mkdir -p "$W/bad/.claude-plugin" && echo '{"name":"bad","hooks":"../x.json"}' > "$W/bad/.claude-plugin/plugin.json"
for d in "$W/plug/p1" "$W/bad"; do
  set +e
  if [ -n "$U" ] && command -v unshare > /dev/null; then out="$(unshare -n env -i PATH="$PATH" HOME="$H" "$CL" plugin validate --strict "$d" 2>&1)"; rc=$?; net=off
  else out="$("$CL" plugin validate --strict "$d" 2>&1)"; rc=$?; net=on; fi
  set -e
  probe "P8.$(basename "$d")" "rc=$rc net=$net $(echo "$out" | tail -n 2 | tr '\n' ' ')"
done
