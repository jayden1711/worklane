// #958 (the owner's decision, 2026-11-08): a guarded run loads nothing from its checkout, its parent folders or the
// agent's own home, because it starts claude with --setting-sources '' (and CLAUDE_CODE_DISABLE_AUTO_MEMORY=1). This
// proves it on the REAL claude binary, through the runner's own path: a guarded `CliRunner.run()` (dist/src/runner.js)
// with an instance's agent settings installed as `install --instance` writes them, so claude gets production's argv,
// --settings and environment. Between the runner and claude stands one wrapper, which only answers `auth status`, logs
// what it was given, and adds ANTHROPIC_BASE_URL (the runner drops every redirecting variable) pointing at a local
// stand-in for the API that records every request.
//
// It plants, under a marker each: CLAUDE.md in the checkout, in .claude/, as CLAUDE.local.md, in a parent folder and
// in the agent's home; a rules file; a skill, an agent and a command, in the checkout and the home; an MCP server
// (.mcp.json); a hook on SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd and
// InstructionsLoaded in each of the checkout's, the local and the home's settings; files loaded only when a tool
// touches a folder (sub/CLAUDE.md, sub/.claude/CLAUDE.md, a skill under sub/.claude/, a rule scoped to `sub/**`); an
// env in the local and home settings (ANTHROPIC_CUSTOM_HEADERS, so a loaded env shows as a request header, which the
// stand-in records with the body); and an auto-memory file for the checkout. The stand-in answers the first model call with a Read of sub/x.txt and the
// rest with end_turn, so a tool runs and a turn ends: the lazy files and the tool and stop hooks get their chance.
//
// Controls run first, so a marker's absence below is measured, not a broken plant (R1185l):
//   - `project` (an unguarded run's sources): the checkout's markers, the lazy ones included, and its hooks on every
//     event a turn with a tool fires;
//   - every source, without --strict-mcp-config and without CLAUDE_CODE_DISABLE_AUTO_MEMORY: every marker, the
//     memory included, and every settings file's hooks, and the MCP server;
//   - the guarded run's own argv without CLAUDE_CODE_DISABLE_AUTO_MEMORY: the memory is loaded, so the runner's
//     variable is what keeps it out.
// Then the guarded run, exactly as the runner starts it, must run the tool, reach no marker, run no hook (but the
// instance's own) and no MCP server. Last, a session resumed (as fix runs resume one): a guarded run, then a run
// resuming its session in the same tree, with every source (a control: it loads the plants) and guarded (nothing).
//
// No real API key: a dummy one, and the stand-in, which never calls out. So nothing leaves the machine and no secret
// is needed (it runs on a pull request).
//
//   node scripts/ci/setting-sources-probe.mjs <claude binary>     (after the build)
//
// Exit 0: the controls loaded the plants and the guarded run loaded none. Exit 1: a marker or a hook reached the
// guarded run, the tool didn't run, or a control didn't load its plants. Exit 2: usage, or the binary can't start.
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gitExecFileSync } from '../lib/git.cjs';

// Absolute: claude starts in the planted checkout, not here.
const bin = process.argv[2]?.includes('/') ? resolve(process.argv[2]) : process.argv[2];
if (!bin) {
  console.error('usage: node scripts/ci/setting-sources-probe.mjs <claude binary>');
  process.exit(2);
}
const repoRoot = join(import.meta.dirname, '..', '..');
const dist = (f) => import(pathToFileURL(join(repoRoot, 'dist', 'src', f)).href);
const { CliRunner } = await dist('runner.js');
const { install } = await dist('install.js');
const { guardrailSettings } = await dist('agent-settings.js');
const { BRAND } = await dist('brand.js');

/** Each planted file's marker: a word no request carries unless that file was loaded. */
const MARKS = {
  projectClaudeMd: 'PLANTED-PROJECT-CLAUDE-MD',
  dotClaudeMd: 'PLANTED-DOTCLAUDE-CLAUDE-MD',
  localClaudeMd: 'PLANTED-CLAUDE-LOCAL-MD',
  parentClaudeMd: 'PLANTED-PARENT-CLAUDE-MD',
  rules: 'PLANTED-RULES-FILE',
  skill: 'planted-skill-name',
  agent: 'planted-agent-name',
  command: 'planted-command-name',
  nestedClaudeMd: 'PLANTED-NESTED-CLAUDE-MD',
  nestedDotClaudeMd: 'PLANTED-NESTED-DOTCLAUDE-MD',
  nestedSkill: 'planted-nested-skill-name',
  pathRule: 'PLANTED-PATH-RULE',
  homeClaudeMd: 'PLANTED-HOME-CLAUDE-MD',
  homeRules: 'PLANTED-HOME-RULES-FILE',
  homeSkill: 'planted-home-skill-name',
  homeAgent: 'planted-home-agent-name',
  memory: 'PLANTED-AUTO-MEMORY',
  // A settings file's env reaches claude's own process, so a request carries it only through a variable claude
  // itself reads: ANTHROPIC_CUSTOM_HEADERS, a header on each request (R1185m C1).
  localEnv: 'PLANTED-HEADER-LOCAL-ENV',
  homeEnv: 'PLANTED-HEADER-HOME-ENV',
};
/** The checkout's own markers: what `project` sources load. */
const PROJECT_MARKS = ['projectClaudeMd', 'dotClaudeMd', 'parentClaudeMd', 'rules', 'skill', 'agent', 'command', 'nestedClaudeMd', 'nestedDotClaudeMd', 'nestedSkill', 'pathRule'];
/** Every hook event planted; the ones a session with one tool turn fires in -p mode are required in the controls. */
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd', 'InstructionsLoaded'];
const TURN_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
/** Claude Code's folder name for a project under its config dir. */
const projectFolder = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

/** A fresh tree: <root>/parent/repo (the checkout, a git repo with the example project), <root>/home, an instance home. */
function plant() {
  // Its real path: claude names a project's memory folder, and reads a nested folder, by the real cwd (on macOS,
  // /var is /private/var).
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'setting-sources-')));
  const parent = join(root, 'parent');
  const repo = join(parent, 'repo');
  const home = join(root, 'home');
  const cfg = join(home, '.claude');
  const ran = join(root, 'ran');
  const instances = join(root, 'instances');
  const instanceHome = join(instances, 'probe');
  cpSync(join(repoRoot, 'examples', 'basic'), repo, { recursive: true });
  const git = (...a) => gitExecFileSync(a, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'probe@example.com');
  git('config', 'user.name', 'Probe');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'example');
  mkdirSync(instanceHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(instanceHome, 'instance.yaml'), `version: 1\nname: probe\nrepos:\n  - path: ${JSON.stringify(repo)}\n    repo: example-org/example-probe\n`);
  const w = (p, t) => {
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, t);
  };
  const skill = (dir, name) => w(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} does a planted thing\n---\n${name}\n`);
  const agent = (dir, name) => w(join(dir, 'a.md'), `---\nname: ${name}\ndescription: ${name} is a planted agent\n---\n${name}\n`);
  mkdirSync(ran, { recursive: true });
  w(join(parent, 'CLAUDE.md'), `# Parent\n${MARKS.parentClaudeMd}\n`);
  w(join(repo, 'CLAUDE.md'), `# Project\n${MARKS.projectClaudeMd}\n`);
  w(join(repo, '.claude', 'CLAUDE.md'), `# Project, .claude\n${MARKS.dotClaudeMd}\n`);
  w(join(repo, 'CLAUDE.local.md'), `# Local\n${MARKS.localClaudeMd}\n`);
  w(join(repo, '.claude', 'rules', 'r.md'), `# Rule\n${MARKS.rules}\n`);
  w(join(repo, '.claude', 'rules', 'paths.md'), `---\npaths: ["sub/**"]\n---\n${MARKS.pathRule}\n`);
  skill(join(repo, '.claude', 'skills'), MARKS.skill);
  agent(join(repo, '.claude', 'agents'), MARKS.agent);
  w(join(repo, '.claude', 'commands', `${MARKS.command}.md`), `---\ndescription: ${MARKS.command} is a planted command\n---\n${MARKS.command}\n`);
  w(join(repo, 'sub', 'x.txt'), 'a file the stand-in has claude read\n');
  w(join(repo, 'sub', 'CLAUDE.md'), `# Nested\n${MARKS.nestedClaudeMd}\n`);
  w(join(repo, 'sub', '.claude', 'CLAUDE.md'), `# Nested, .claude\n${MARKS.nestedDotClaudeMd}\n`);
  skill(join(repo, 'sub', '.claude', 'skills'), MARKS.nestedSkill);
  w(join(cfg, 'CLAUDE.md'), `# Home\n${MARKS.homeClaudeMd}\n`);
  w(join(cfg, 'rules', 'r.md'), `# Home rule\n${MARKS.homeRules}\n`);
  skill(join(cfg, 'skills'), MARKS.homeSkill);
  agent(join(cfg, 'agents'), MARKS.homeAgent);
  w(join(cfg, 'projects', projectFolder(repo), 'memory', 'MEMORY.md'), `- ${MARKS.memory}\n`);
  // A hook on every event, in each settings file: each touches its own file under ran/. The checkout's settings.json
  // holds hooks only, which the runner's first line (projectSettingsRefusal) lets through, so the run starts; the
  // local and home files also turn the checkout's MCP servers on and set an env.
  const hookSet = (who) => Object.fromEntries(EVENTS.map((e) => [e, [{ ...(e === 'PreToolUse' || e === 'PostToolUse' ? { matcher: '*' } : {}), hooks: [{ type: 'command', command: `touch '${join(ran, `${who}-${e}`)}'` }] }]]));
  const hooks = (who) => ({ hooks: hookSet(who), enableAllProjectMcpServers: true, env: { ANTHROPIC_CUSTOM_HEADERS: `x-planted-${who}: ${MARKS[`${who}Env`]}` } });
  w(join(repo, '.claude', 'settings.json'), JSON.stringify({ hooks: hookSet('project') }));
  w(join(repo, '.claude', 'settings.local.json'), JSON.stringify(hooks('local')));
  w(join(cfg, 'settings.json'), JSON.stringify(hooks('home')));
  w(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { planted: { type: 'stdio', command: 'touch', args: [join(ran, 'mcp')] } } }));
  return { root, repo, home, cfg, ran, instances, instanceHome };
}

/** The stand-in API: records each request; the first model call gets a Read of sub/x.txt (a tool_use), the rest end_turn. */
async function standIn(repo) {
  const seen = [];
  let calls = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end('{"type":"error","error":{"type":"not_found_error","message":"the probe serves messages only"}}');
      }
      calls++;
      const tool = calls === 1;
      const content = tool ? [{ type: 'tool_use', id: 'toolu_probe_1', name: 'Read', input: { file_path: join(repo, 'sub', 'x.txt') } }] : [{ type: 'text', text: 'done' }];
      const msg = { id: `msg_probe_${calls}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
      let j = {};
      try {
        j = JSON.parse(body);
      } catch {}
      const stop = tool ? 'tool_use' : 'end_turn';
      if (!j.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ...msg, content, stop_reason: stop }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
      ev('message_start', { message: msg });
      content.forEach((c, i) => {
        if (c.type === 'text') {
          ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } });
          ev('content_block_delta', { index: i, delta: { type: 'text_delta', text: c.text } });
        } else {
          ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } });
          ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } });
        }
        ev('content_block_stop', { index: i });
      });
      ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
      ev('message_stop', {});
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/**
 * The one shim between the runner and `bin`: answers `auth status` (an API-key login, as the api_key runtime runs on),
 * logs the argv and env it was given, and runs `bin` with them plus ANTHROPIC_BASE_URL. A control's change, when
 * given, is made here, to the runner's own argv and env: `sources` swapped in, --strict-mcp-config dropped, the
 * memory variable dropped. SETTING_SOURCES_REAL_CLAUDE, when the probe has it (a must-fail run, where `bin` is a wrapper
 * around the real claude, test/fixtures/setting-sources/wrap-*.cjs), is passed on: the runner keeps no such variable.
 */
function shim(dir, url, control) {
  const f = join(dir, 'claude-shim.cjs');
  writeFileSync(f, `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'api_key' })); process.exit(0); }
fs.writeFileSync(${JSON.stringify(join(dir, 'given.json'))}, JSON.stringify({ args, env: process.env }));
const c = ${JSON.stringify(control ?? {})};
let argv = args.slice();
if (c.sources !== undefined) argv[argv.indexOf('--setting-sources') + 1] = c.sources;
if (c.mcp) argv = argv.filter((a) => a !== '--strict-mcp-config');
const env = { ...process.env, ANTHROPIC_BASE_URL: ${JSON.stringify(url)}${process.env.SETTING_SOURCES_REAL_CLAUDE ? `, SETTING_SOURCES_REAL_CLAUDE: ${JSON.stringify(process.env.SETTING_SOURCES_REAL_CLAUDE)}` : ''} };
if (c.memory) delete env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
// A script (a test's stand-in or wrapper) runs on this node: the runner's PATH needn't have one.
const r = /\.[cm]?js$/.test(${JSON.stringify(bin)}) ? spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(bin)}, ...argv], { stdio: 'inherit', env }) : spawnSync(${JSON.stringify(bin)}, argv, { stdio: 'inherit', env });
process.exit(r.status ?? 1);
`);
  chmodSync(f, 0o755);
  return f;
}

/**
 * One guarded run through the runner, in a fresh plant (or `o.p`, an earlier run's), resuming `o.resume` when given;
 * `control` changes its argv or env as shim() says.
 */
async function run(control = null, o = {}) {
  const p = o.p ?? plant();
  const ranBefore = new Set(readdirSync(p.ran));
  const api = await standIn(p.repo);
  const varName = `${BRAND.envPrefix}_INSTANCES_DIR`;
  const before = process.env[varName];
  process.env[varName] = p.instances;
  let r;
  try {
    install({ root: p.repo, engineCli: join(repoRoot, 'dist', 'src', 'cli.js'), instance: 'probe' });
    const base = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: p.home, CLAUDE_CONFIG_DIR: p.cfg, ANTHROPIC_API_KEY: 'sk-ant-not-a-key', [varName]: p.instances };
    const runner = new CliRunner('api_key', base, shim(p.root, api.url, control), undefined, undefined, undefined, {}, () => guardrailSettings(p.instanceHome, 'probe', p.repo));
    r = await runner.run({ prompt: 'Read sub/x.txt.', model: 'claude-sonnet-4-5', cwd: p.repo, allowedTools: ['Read'], maxTurns: 3, maxBudgetUsd: 1, stallMs: 120_000, timeoutMs: 180_000, role: 'worker', ...(o.resume ? { resume: o.resume } : {}) });
  } finally {
    if (before === undefined) delete process.env[varName];
    else process.env[varName] = before;
    api.close();
  }
  const givenFile = join(p.root, 'given.json');
  if (!existsSync(givenFile)) {
    console.error(`the runner never started ${bin}: ${r?.reason}: ${r?.detail}`);
    process.exit(2);
  }
  const given = JSON.parse(readFileSync(givenFile, 'utf8'));
  // Bodies and headers: a settings file's env shows as a header (MARKS.localEnv, homeEnv).
  const text = api.seen.map((s) => `${JSON.stringify(s.headers)}\n${s.body}`).join('\n');
  const model = api.seen.filter((s) => s.url.startsWith('/v1/messages') && !s.url.includes('count_tokens'));
  return {
    p,
    given,
    result: r,
    model,
    toolRan: model.some((s) => s.body.includes('tool_result') && s.body.includes('toolu_probe_1')),
    reached: Object.entries(MARKS).filter(([, m]) => text.includes(m)).map(([k]) => k),
    ran: readdirSync(p.ran).filter((f) => !ranBefore.has(f)),
  };
}

const say = (what, r) => console.log(`${what}: ${r.model.length} model call(s) to the stand-in, the tool ${r.toolRan ? 'ran' : "didn't run"}; markers reached: ${r.reached.join(', ') || 'none'}; hooks or MCP run: ${r.ran.join(', ') || 'none'}`);
const problems = [];
const measured = (what, r) => {
  if (!r.model.length) problems.push(`${what}: no model call reached the stand-in, so nothing is measured (${r.result?.reason}: ${String(r.result?.detail).slice(0, 300)})`);
  else if (!r.toolRan) problems.push(`${what}: the stand-in's Read never ran, so nothing loaded by a tool or a turn's end is measured`);
};

const project = await run({ sources: 'project' });
say("control (--setting-sources project, an unguarded run's)", project);
measured('the project control', project);
for (const k of PROJECT_MARKS) if (!project.reached.includes(k)) problems.push(`with project sources, ${k} (${MARKS[k]}) didn't reach a request: its plant is broken, so its absence proves nothing`);
for (const e of TURN_EVENTS) if (!project.ran.includes(`project-${e}`)) problems.push(`with project sources, the checkout's ${e} hook didn't run: its plant is broken`);

const all = await run({ sources: 'user,project,local', mcp: true, memory: true });
say('control (every source, no --strict-mcp-config, no CLAUDE_CODE_DISABLE_AUTO_MEMORY)', all);
measured('the every-source control', all);
// One env wins: the local settings' ANTHROPIC_CUSTOM_HEADERS replaces the home's, so the home's is shown alone below.
for (const k of Object.keys(MARKS).filter((x) => x !== 'homeEnv')) if (!all.reached.includes(k)) problems.push(`with every source, ${k} (${MARKS[k]}) didn't reach a request: its plant is broken, so its absence proves nothing`);
for (const who of ['project', 'local', 'home']) for (const e of TURN_EVENTS) if (!all.ran.includes(`${who}-${e}`)) problems.push(`with every source, the ${who} settings' ${e} hook didn't run: its plant is broken`);
if (!all.ran.includes('mcp')) problems.push("with every source and no --strict-mcp-config, the checkout's MCP server didn't start: its plant is broken");

const user = await run({ sources: 'user' });
say('control (--setting-sources user)', user);
measured('the user control', user);
for (const k of ['homeClaudeMd', 'homeEnv']) if (!user.reached.includes(k)) problems.push(`with user sources, ${k} (${MARKS[k]}) didn't reach a request: its plant is broken, so its absence proves nothing`);

const memory = await run({ memory: true });
say("control (the guarded run's argv, no CLAUDE_CODE_DISABLE_AUTO_MEMORY)", memory);
measured('the memory control', memory);
if (!memory.reached.includes('memory')) problems.push("without CLAUDE_CODE_DISABLE_AUTO_MEMORY, the guarded argv didn't load the auto memory: its plant is broken, so its absence proves nothing");

const guarded = await run(null);
const sources = guarded.given.args[guarded.given.args.indexOf('--setting-sources') + 1];
say(`guarded (the runner's own argv and env: --setting-sources ${JSON.stringify(sources)}, --settings, CLAUDE_CODE_DISABLE_AUTO_MEMORY=${guarded.given.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY})`, guarded);
measured('the guarded run', guarded);
if (!guarded.given.args.includes('--settings')) problems.push("the guarded run's argv has no --settings: the instance's agent settings weren't passed");
for (const k of guarded.reached) problems.push(`a guarded run's request carries ${k} (${MARKS[k]}): that file was loaded`);
for (const f of guarded.ran) problems.push(`a guarded run ran ${f === 'mcp' ? "the checkout's MCP server" : `the ${f.split('-')[0]} settings' ${f.split('-').slice(1).join('-')} hook`}`);

// Resumed (R1185n C3: fix runs resume a session, src/coordinator/fix-runs.ts): a guarded run, then a run resuming its
// session in the same planted tree. With every source the resumed run loads the plants; guarded, nothing.
for (const [what, control] of [['control', { sources: 'user,project,local', mcp: true, memory: true }], ['guarded', null]]) {
  const first = await run(null);
  const id = first.result?.sessionId;
  if (!id) {
    problems.push(`the ${what} resume: the first run gave no session id to resume (${first.result?.reason}: ${String(first.result?.detail).slice(0, 200)})`);
    continue;
  }
  const r = await run(control, { p: first.p, resume: id });
  say(`${what} resumed run (--resume ${id})`, r);
  measured(`the ${what} resumed run`, r);
  if (!r.given.args.includes('--resume')) problems.push(`the ${what} resumed run's argv has no --resume`);
  if (control) {
    // What loads at a session's start (a resumed session read its nested files the first time, not again).
    for (const k of ['projectClaudeMd', 'dotClaudeMd', 'localClaudeMd', 'parentClaudeMd', 'rules', 'skill', 'agent', 'command', 'homeClaudeMd', 'localEnv']) if (!r.reached.includes(k)) problems.push(`a resumed run with every source didn't reach ${k} (${MARKS[k]}): its plant is broken, so the guarded resume proves nothing`);
  } else {
    for (const k of r.reached) problems.push(`the guarded resumed run's request carries ${k} (${MARKS[k]}): that file was loaded`);
    for (const f of r.ran) problems.push(`the guarded resumed run ran ${f === 'mcp' ? "the checkout's MCP server" : `the ${f.split('-')[0]} settings' ${f.split('-').slice(1).join('-')} hook`}`);
  }
}

if (problems.length) {
  console.error(`setting-sources probe (${bin}):\n${problems.map((x) => `  ${x}`).join('\n')}`);
  process.exit(1);
}
console.log("a guarded run loaded nothing planted, fresh or resumed: no CLAUDE.md (checkout, .claude/, local, parent, home, nested), rules (path-scoped included), skill (nested included), agent, command, hook on any event, MCP server, settings env or auto memory");
