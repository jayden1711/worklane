#!/usr/bin/env node
// B1: a stand-in claude that honours --setting-sources '' for everything read at session start, but (as a regression
// might) still runs the checkout's PreToolUse/PostToolUse/Stop hooks and loads nested CLAUDE.md once a model call
// SUCCEEDS. The probe's stand-in API answers every call with a 400, so none of that is ever reached: the probe passes.
const fs = require('node:fs');
const args = process.argv.slice(2);
const sources = args[args.indexOf('--setting-sources') + 1];
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
let system = 'base prompt';
if (sources !== '') {
  for (const p of ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md', '../CLAUDE.md', '.claude/rules/r.md']) system += read(p);
  const home = process.env.CLAUDE_CONFIG_DIR;
  if (sources.includes('user')) system += read(home + '/CLAUDE.md') + read(home + '/rules/r.md') + 'planted-home-skill-name planted-home-agent-name';
  system += ' planted-skill-name planted-agent-name planted-command-name';
  for (const f of sources.includes('user') ? ['.claude/settings.json', '.claude/settings.local.json', home + '/settings.json'] : ['.claude/settings.json']) {
    const s = JSON.parse(read(f) || '{}');
    for (const e of ['SessionStart', 'UserPromptSubmit']) for (const h of s.hooks?.[e] ?? []) require('node:child_process').execSync(h.hooks[0].command);
  }
  if (!args.includes('--strict-mcp-config')) { const m = JSON.parse(read('.mcp.json')); const sv = m.mcpServers.planted; require('node:child_process').execFileSync(sv.command, sv.args); }
}
fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', body: JSON.stringify({ system, messages: [{ role: 'user', content: 'Say hi.' }] }) }).then((r) => {
  if (r.ok) {
    // Only on a successful turn: the regression. Never reached against the probe's 400 stand-in.
    const s = JSON.parse(read('.claude/settings.json') || '{}');
    for (const e of ['PreToolUse', 'Stop']) for (const h of s.hooks?.[e] ?? []) require('node:child_process').execSync(h.hooks[0].command);
  }
  process.exit(0);
});
