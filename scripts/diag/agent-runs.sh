#!/usr/bin/env bash
# Read-only: what an instance's agents did for one issue. Prints the
# coordinator's events for the issue (check results in full), then, for each agent session in the
# issue's worktrees (oldest first), every shell command with its exit status
# and the first lines of its output, every file written, and the session's
# final message. Reads the agent user's Claude session files and the
# instance's event log; changes nothing.
#   bash scripts/diag/agent-runs.sh <name> <issue number>
source "$(dirname "$0")/../setup/lib.sh"
as_root "$@"
name="${1:?usage: agent-runs.sh <name> <issue>}"
issue="${2:?usage: agent-runs.sh <name> <issue>}"
[[ "$issue" =~ ^[0-9]+$ ]] || { echo "issue must be a number" >&2; exit 2; }
coord="wl-$name" agent="wl-$name-agent"
events="/home/$coord/.local/state/worklane/instances/$name/state/events.db"
sessions="/home/$agent/.claude/projects"

say "coordinator events for #$issue"
node - "$events" "$issue" <<'JS'
const [db, issue] = process.argv.slice(2);
const { DatabaseSync } = require('node:sqlite');
const d = new DatabaseSync(db, { readOnly: true });
for (const e of d.prepare("SELECT ts, type, payload FROM events WHERE json_extract(payload, '$.issue') = ? ORDER BY id").all(Number(issue))) {
  const p = JSON.parse(e.payload);
  delete p.issue;
  if (e.type === 'check.result') {
    // In full: each check's status, exit code and, for a failure, the end of its output.
    console.log(`${e.ts}  check.result  stage ${p.stage}, head ${String(p.head).slice(0, 8)}`);
    for (const c of p.checks) {
      console.log(`    ${c.status} (exit ${c.exitCode})  ${c.check}`);
      if (c.tail) console.log(c.tail.split('\n').map((l) => `        ${l}`).join('\n'));
    }
    continue;
  }
  console.log(`${e.ts}  ${e.type}  ${JSON.stringify(p).slice(0, 400)}`);
}
JS

say "agent sessions in #$issue's worktrees"
node - "$sessions" "$issue" <<'JS'
const [root, issue] = process.argv.slice(2);
const fs = require('node:fs');
const path = require('node:path');
// Session folders are named after the worktree path, with every non-alphanumeric character as "-".
const dirs = fs.readdirSync(root).filter((d) => new RegExp(`worktrees-.*issue-${issue}(-|$)`).test(d));
const files = dirs.flatMap((d) => fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(root, d, f)));
const first = (f) => { for (const l of fs.readFileSync(f, 'utf8').split('\n')) { try { const j = JSON.parse(l); if (j.timestamp) return j.timestamp; } catch {} } return ''; };
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)} …` : s);
for (const f of files.sort((a, b) => first(a).localeCompare(first(b)))) {
  console.log(`\n### ${path.basename(path.dirname(f))}/${path.basename(f)}  started ${first(f)}`);
  const pending = new Map();
  let last = '';
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    const content = Array.isArray(j.message?.content) ? j.message.content : [];
    for (const c of content) {
      if (c.type === 'tool_use') {
        const i = c.input ?? {};
        const what = c.name === 'Bash' ? `$ ${i.command}` : i.file_path ? `${c.name} ${i.file_path}` : null;
        if (what) pending.set(c.id, `${j.timestamp ?? ''}  ${clip(what, 300)}`);
      } else if (c.type === 'tool_result' && pending.has(c.tool_use_id)) {
        const out = (Array.isArray(c.content) ? c.content.map((x) => x.text ?? '').join('') : String(c.content ?? '')).trim();
        console.log(pending.get(c.tool_use_id));
        console.log(`    ${c.is_error ? 'ERROR' : 'ok'}: ${clip(out.split('\n').slice(0, 6).join('\n      '), 600)}`);
        pending.delete(c.tool_use_id);
      } else if (c.type === 'text' && j.type === 'assistant') last = c.text;
    }
  }
  console.log(`  final message: ${clip(last.replace(/\s+/g, ' '), 500)}`);
}
if (!files.length) console.log(`no sessions found under ${root} for issue ${issue}`);
JS
