// #958 (the owner's decision, 2026-11-08): a guarded run loads nothing from its checkout, its parent folders or the
// agent's own home, because it starts claude with --setting-sources ''. This proves it on the REAL claude binary, not
// a stand-in: it plants, under a marker each, a hook in each settings file, an MCP server, CLAUDE.md in the checkout,
// in .claude/, as CLAUDE.local.md and in a parent folder, a rules file, a skill, an agent and a command, and the same
// in the agent's home; it runs claude with the runner's own argv for a guarded run (cliArgs, dist/src/runner.js),
// against a local stand-in for the API that records every request; and it fails if any marker reaches a request, or
// any hook or MCP server ran.
//
// The control comes first: the same files with --setting-sources project (an unguarded run's) must reach the run
// (the checkout's CLAUDE.md in a request, its hook run), so a marker's absence under '' means it wasn't loaded, not
// that the plant or the stand-in is broken.
//
// No real API key: claude gets a dummy one and ANTHROPIC_BASE_URL at the stand-in, which answers every model call
// with an error, so nothing leaves the machine and no secret is needed (it can run on a pull request).
//
//   node scripts/ci/setting-sources-probe.mjs <claude binary>     (after the build)
//
// Exit 0: the control loaded the files and the guarded run loaded none. Exit 1: a marker or a hook reached the
// guarded run, or the control didn't load them. Exit 2: usage, or the binary can't start.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const bin = process.argv[2];
if (!bin) {
  console.error('usage: node scripts/ci/setting-sources-probe.mjs <claude binary>');
  process.exit(2);
}
const { cliArgs } = await import(pathToFileURL(join(import.meta.dirname, '..', '..', 'dist', 'src', 'runner.js')).href);

/** Each planted file's marker: a word no request would carry unless that file was loaded. */
const MARKS = {
  projectClaudeMd: 'PLANTED-PROJECT-CLAUDE-MD',
  dotClaudeMd: 'PLANTED-DOTCLAUDE-CLAUDE-MD',
  localClaudeMd: 'PLANTED-CLAUDE-LOCAL-MD',
  parentClaudeMd: 'PLANTED-PARENT-CLAUDE-MD',
  rules: 'PLANTED-RULES-FILE',
  skill: 'planted-skill-name',
  agent: 'planted-agent-name',
  command: 'planted-command-name',
  homeClaudeMd: 'PLANTED-HOME-CLAUDE-MD',
  homeRules: 'PLANTED-HOME-RULES-FILE',
  homeSkill: 'planted-home-skill-name',
  homeAgent: 'planted-home-agent-name',
};

/** A fresh tree: <root>/parent/CLAUDE.md, <root>/parent/repo (the checkout) and <root>/home. */
function plant() {
  const root = mkdtempSync(join(tmpdir(), 'setting-sources-'));
  const parent = join(root, 'parent');
  const repo = join(parent, 'repo');
  const home = join(root, 'home');
  const ran = join(root, 'ran');
  for (const d of [join(repo, '.claude', 'rules'), join(repo, '.claude', 'skills', MARKS.skill), join(repo, '.claude', 'agents'), join(repo, '.claude', 'commands'), join(home, '.claude', 'rules'), join(home, '.claude', 'skills', MARKS.homeSkill), join(home, '.claude', 'agents'), ran]) mkdirSync(d, { recursive: true });
  const w = (p, t) => writeFileSync(p, t);
  w(join(parent, 'CLAUDE.md'), `# Parent\n${MARKS.parentClaudeMd}\n`);
  w(join(repo, 'CLAUDE.md'), `# Project\n${MARKS.projectClaudeMd}\n`);
  w(join(repo, '.claude', 'CLAUDE.md'), `# Project, .claude\n${MARKS.dotClaudeMd}\n`);
  w(join(repo, 'CLAUDE.local.md'), `# Local\n${MARKS.localClaudeMd}\n`);
  w(join(repo, '.claude', 'rules', 'r.md'), `# Rule\n${MARKS.rules}\n`);
  w(join(repo, '.claude', 'skills', MARKS.skill, 'SKILL.md'), `---\nname: ${MARKS.skill}\ndescription: ${MARKS.skill} does a planted thing\n---\n${MARKS.skill}\n`);
  w(join(repo, '.claude', 'agents', 'a.md'), `---\nname: ${MARKS.agent}\ndescription: ${MARKS.agent} is a planted agent\n---\n${MARKS.agent}\n`);
  w(join(repo, '.claude', 'commands', `${MARKS.command}.md`), `---\ndescription: ${MARKS.command} is a planted command\n---\n${MARKS.command}\n`);
  w(join(home, '.claude', 'CLAUDE.md'), `# Home\n${MARKS.homeClaudeMd}\n`);
  w(join(home, '.claude', 'rules', 'r.md'), `# Home rule\n${MARKS.homeRules}\n`);
  w(join(home, '.claude', 'skills', MARKS.homeSkill, 'SKILL.md'), `---\nname: ${MARKS.homeSkill}\ndescription: ${MARKS.homeSkill} does a planted thing\n---\n${MARKS.homeSkill}\n`);
  w(join(home, '.claude', 'agents', 'a.md'), `---\nname: ${MARKS.homeAgent}\ndescription: ${MARKS.homeAgent} is a planted agent\n---\n${MARKS.homeAgent}\n`);
  // A hook on every event a session starts with, in each settings file: each touches its own file under ran/.
  const hooks = (who) => {
    const touch = (event) => [{ hooks: [{ type: 'command', command: `touch '${join(ran, `${who}-${event}`)}'` }] }];
    return { hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'].map((e) => [e, e === 'PreToolUse' ? [{ matcher: '*', ...touch(e)[0] }] : touch(e)])), enableAllProjectMcpServers: true, env: { PLANTED_SETTINGS_ENV: `${who}-env` } };
  };
  w(join(repo, '.claude', 'settings.json'), JSON.stringify(hooks('project')));
  w(join(repo, '.claude', 'settings.local.json'), JSON.stringify(hooks('local')));
  w(join(home, '.claude', 'settings.json'), JSON.stringify(hooks('home')));
  // An MCP server in the checkout's .mcp.json: started, it leaves a file under ran/.
  w(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { planted: { type: 'stdio', command: 'touch', args: [join(ran, 'mcp')] } } }));
  return { root, repo, home, ran };
}

/** A stand-in for the API: records each request (method, path, body); every model call gets an error, so claude stops. */
async function standIn() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body });
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'the setting-sources probe answers no model call' } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/** One run of `bin` in a fresh plant, with the runner's argv for a guarded run, `sources` swapped in for the control. */
async function run(sources, o = {}) {
  const p = plant();
  const api = await standIn();
  const req = { prompt: 'p', model: 'claude-sonnet-4-5', cwd: p.repo, allowedTools: ['Read'], maxTurns: 1, maxBudgetUsd: 1, stallMs: 60_000, timeoutMs: 60_000, role: 'worker' };
  const argv = cliArgs(req, undefined, undefined, [], undefined, { guarded: true });
  const i = argv.indexOf('--setting-sources');
  if (i < 0) throw new Error(`the runner's argv has no --setting-sources: ${JSON.stringify(argv)}`);
  if (sources !== null) argv[i + 1] = sources;
  if (o.mcp) argv.splice(argv.indexOf('--strict-mcp-config'), 1);
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: p.home, CLAUDE_CONFIG_DIR: join(p.home, '.claude'), ANTHROPIC_API_KEY: 'sk-ant-not-a-key', ANTHROPIC_BASE_URL: api.url, DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  const out = await new Promise((resolve) => {
    const child = spawn(bin, argv, { cwd: p.repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('error', (e) => resolve({ error: e, stdout, stderr }));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Say hi.' } })}\n`);
  });
  api.close();
  if (out.error) {
    console.error(`${bin} didn't start: ${out.error.message}`);
    process.exit(2);
  }
  const text = api.seen.map((s) => s.body).join('\n') + out.stdout;
  return { p, argv, out, seen: api.seen, reached: Object.entries(MARKS).filter(([, m]) => text.includes(m)).map(([k]) => k), ran: readdirSync(p.ran), envSeen: /PLANTED_SETTINGS_ENV/.test(text) };
}

const say = (what, r) => console.log(`${what}: ${r.seen.length} request(s) to the stand-in (${[...new Set(r.seen.map((s) => `${s.method} ${s.url.split('?')[0]}`))].join(', ')}); markers reached: ${r.reached.join(', ') || 'none'}; hooks or MCP run: ${r.ran.join(', ') || 'none'}`);

const control = await run('project');
say("control (--setting-sources project, an unguarded run's)", control);
const problems = [];
if (!control.seen.some((s) => s.url.startsWith('/v1/messages'))) problems.push(`the control made no model call to the stand-in, so nothing here is measured (exit ${control.out.code}; stderr: ${control.out.stderr.slice(-400)})`);
if (!control.reached.includes('projectClaudeMd')) problems.push("the control's requests don't carry the checkout's CLAUDE.md: the plant or the stand-in is broken");
if (!control.ran.some((f) => f.startsWith('project-'))) problems.push("the control didn't run the checkout's hook: the plant is broken");

// Every source, and the checkout's MCP servers (no --strict-mcp-config): each planted file must reach the run, so
// each one's absence below is measured.
const all = await run('user,project,local', { mcp: true });
say('control (every source, no --strict-mcp-config)', all);
for (const k of Object.keys(MARKS)) if (!all.reached.includes(k)) problems.push(`with every source, ${k} (${MARKS[k]}) didn't reach a request: its plant is broken, so its absence proves nothing`);
for (const f of ['project-SessionStart', 'local-SessionStart', 'home-SessionStart', 'mcp']) if (!all.ran.includes(f)) problems.push(`with every source, ${f} didn't run: its plant is broken`);

const guarded = await run(null);
say(`guarded (the runner's argv: --setting-sources ${JSON.stringify(guarded.argv[guarded.argv.indexOf('--setting-sources') + 1])})`, guarded);
if (!guarded.seen.some((s) => s.url.startsWith('/v1/messages'))) problems.push(`the guarded run made no model call to the stand-in, so its requests can't be read (exit ${guarded.out.code}; stderr: ${guarded.out.stderr.slice(-400)})`);
for (const k of guarded.reached) problems.push(`a guarded run's request carries ${k} (${MARKS[k]}): that file was loaded`);
for (const f of guarded.ran) problems.push(`a guarded run ran ${f === 'mcp' ? "the checkout's MCP server" : `the ${f.split('-')[0]} settings' ${f.split('-').slice(1).join('-')} hook`}`);
if (guarded.envSeen) problems.push("a guarded run's request carries a settings file's env");
if (!existsSync(guarded.p.repo)) problems.push('the plant is gone');

if (problems.length) {
  console.error(`setting-sources probe (${bin}):\n${problems.map((x) => `  ${x}`).join('\n')}`);
  process.exit(1);
}
console.log("a guarded run loaded nothing planted: no CLAUDE.md (checkout, .claude/, local, parent, home), rules, skill, agent, command, hook or MCP server");
