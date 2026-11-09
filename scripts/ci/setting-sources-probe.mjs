// #958 (the owner's decision, 2026-11-08): a guarded run loads nothing from its checkout, its parent folders or the
// agent's own home, because it starts claude with --setting-sources '' (and CLAUDE_CODE_DISABLE_AUTO_MEMORY=1). This
// proves it on the REAL claude binary, through the runner's own path: guarded `CliRunner.run()`s (dist/src/runner.js)
// with an instance's agent settings installed as `install --instance` writes them, so claude gets the runner's argv,
// --settings and environment. Between the runner and claude stands one shim, which only answers `auth status`, logs
// what it was given, and adds ANTHROPIC_BASE_URL (the runner drops every redirecting variable) pointing at a local
// stand-in for the API that records every request, headers and body.
//
// It plants, under a marker each: CLAUDE.md in the checkout, in .claude/, as CLAUDE.local.md, in a parent folder and
// in the agent's home; a rules file; a skill, an agent and a command, in the checkout and the home; an MCP server
// (.mcp.json); a hook on SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd and
// InstructionsLoaded in each of the checkout's, the local and the home's settings; files loaded only when a tool
// touches a folder (sub/CLAUDE.md, sub/.claude/CLAUDE.md, a skill under sub/.claude/, a rule scoped to `sub/**`, and
// sub2/CLAUDE.md, which only a resumed session reads); in the local and home settings, an env (ANTHROPIC_CUSTOM_HEADERS,
// shown as a request header, and a variable a tool sees) and an allow rule for Bash and Write; and an auto-memory file
// for the checkout. The stand-in answers its model calls with a Read of a planted folder's file, a Bash that prints the
// environment, a Write, then end_turn, each tool id this run's own: so a tool runs, a turn ends, and what the tools'
// environment holds is in a request.
//
// Controls run first, so a marker's absence below is measured, not a broken plant (R1185l):
//   - `project` (an unguarded run's sources): the checkout's markers, the lazy ones included, and its hooks on every
//     event a turn with a tool fires;
//   - every source, without --strict-mcp-config and without CLAUDE_CODE_DISABLE_AUTO_MEMORY: every marker, the memory
//     and both tool env variables included, every settings file's hooks, the MCP server, and Bash and Write run under
//     the planted allow rules in a Read-only run;
//   - `user`: the home's CLAUDE.md and its env (the local env replaces the home's header under every source);
//   - the guarded run's own argv without CLAUDE_CODE_DISABLE_AUTO_MEMORY: the memory is loaded, so the runner's
//     variable is what keeps it out.
// Then the guarded runs, exactly as the runner starts them, must each run the tool, reach no marker, and run no
// planted hook and no MCP server:
//   - a Read-only run, where Bash and Write must also stay denied;
//   - one shaped as a coordinator worker run (its role prompt, JSON schema, tools and an apiKeyHelper key file);
//   - a resumed session, shaped as a fix run is (worker-shaped, R1185q): a guarded worker run, then one resuming it in
//     the same tree, with every source (a control: it loads the plants, sub2/CLAUDE.md included) and guarded.
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

const repoRoot = join(import.meta.dirname, '..', '..');
/** The src/ modules the probe loads; with what they import, at any depth, the files a change to which runs it. */
const ROOTS = ['runner', 'install', 'agent-settings', 'brand', 'roles'];
/**
 * The probe's import closure (R1185p D3): ROOTS and every src/ module they import, statically or by a literal
 * import(), at any depth, plus this script and scripts/lib/git.cjs. scripts/ci/setting-sources-probe.files holds it
 * (slow-jobs.sh reads it); test/setting-sources-probe.test.ts checks the two match.
 */
function closure() {
  const seen = new Set();
  const todo = ROOTS.map((r) => `src/${r}.ts`);
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f) || !existsSync(join(repoRoot, f))) continue;
    seen.add(f);
    const text = readFileSync(join(repoRoot, f), 'utf8');
    for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      const parts = f.split('/').slice(0, -1);
      for (const x of m[1].split('/')) {
        if (x === '..') parts.pop();
        else if (x !== '.') parts.push(x);
      }
      todo.push(parts.join('/').replace(/\.js$/, '.ts'));
    }
  }
  return [...seen, 'scripts/ci/setting-sources-probe.mjs', 'scripts/lib/git.cjs'].sort();
}
if (process.argv[2] === '--files') {
  console.log(closure().join('\n'));
  process.exit(0);
}

// Absolute: claude starts in the planted checkout, not here.
const bin = process.argv[2]?.includes('/') ? resolve(process.argv[2]) : process.argv[2];
if (!bin) {
  console.error('usage: node scripts/ci/setting-sources-probe.mjs <claude binary>');
  process.exit(2);
}
const dist = (f) => import(pathToFileURL(join(repoRoot, 'dist', 'src', f)).href);
const { CliRunner } = await dist('runner.js');
const { install } = await dist('install.js');
const { guardrailSettings } = await dist('agent-settings.js');
const { BRAND } = await dist('brand.js');
const { rolePrompt, WORKER_SCHEMA } = await dist('roles.js');
/** A coordinator worker run's tools (src/coordinator/fix-runs.ts), for the worker-shaped run (R1185p D2). */
const WORKER_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'];

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
  // itself reads: ANTHROPIC_CUSTOM_HEADERS, a header on each request (R1185n C1).
  localEnv: 'PLANTED-HEADER-LOCAL-ENV',
  homeEnv: 'PLANTED-HEADER-HOME-ENV',
  // And what a tool sees (R1185p D1): a second env variable each, shown by the stand-in's Bash `env`.
  localToolEnv: 'PLANTED-TOOL-ENV-LOCAL',
  homeToolEnv: 'PLANTED-TOOL-ENV-HOME',
  // A CLAUDE.md in a folder only the resumed session reads, so a resume's folder-loaded files are measured (R1185p).
  resumeNested: 'PLANTED-SUB2-CLAUDE-MD',
};
/** Files a tool leaves under ran/ (the stand-in's Bash and Write), beside the hooks' and the MCP server's. */
const TOOL_FILES = ['tool-bash', 'tool-write'];
const hooksOf = (ran) => ran.filter((f) => !TOOL_FILES.includes(f));
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
  w(join(repo, 'sub2', 'x.txt'), 'a file only a resumed session reads\n');
  w(join(repo, 'sub2', 'CLAUDE.md'), `# Read on resume\n${MARKS.resumeNested}\n`);
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
  // The local and home files also allow Bash and Write (R1185p D1): a run that doesn't allow them must not get them.
  const hooks = (who) => ({ hooks: hookSet(who), enableAllProjectMcpServers: true, permissions: { allow: ['Bash', 'Write'] }, env: { ANTHROPIC_CUSTOM_HEADERS: `x-planted-${who}: ${MARKS[`${who}Env`]}`, [`PLANTED_TOOL_ENV_${who.toUpperCase()}`]: MARKS[`${who}ToolEnv`] } });
  w(join(repo, '.claude', 'settings.json'), JSON.stringify({ hooks: hookSet('project') }));
  w(join(repo, '.claude', 'settings.local.json'), JSON.stringify(hooks('local')));
  w(join(cfg, 'settings.json'), JSON.stringify(hooks('home')));
  w(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { planted: { type: 'stdio', command: 'touch', args: [join(ran, 'mcp')] } } }));
  return { root, repo, home, cfg, ran, instances, instanceHome };
}

/**
 * The stand-in API: records each request (headers and body). Its model calls get `steps`, one tool_use each, in order
 * (a Read of a planted folder's file, a Bash that leaves tool-bash and prints the environment, a Write of tool-write),
 * then end_turn. Each tool_use id carries `tag`, this run's own, so a resumed session's old ids never count (R1185o N1).
 */
async function standIn(repo, ran, sub = 'sub') {
  const seen = [];
  let calls = 0;
  const tag = Math.random().toString(36).slice(2, 10);
  const steps = [
    { name: 'Read', input: { file_path: join(repo, sub, 'x.txt') } },
    { name: 'Bash', input: { command: `touch '${join(ran, 'tool-bash')}'; env`, description: 'the environment' } },
    { name: 'Write', input: { file_path: join(ran, 'tool-write'), content: 'x' } },
  ];
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
      const step = steps[calls - 1];
      const tool = !!step;
      const content = tool ? [{ type: 'tool_use', id: `toolu_${tag}_${calls}`, ...step }] : [{ type: 'text', text: 'done' }];
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
  return { seen, tag, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
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
 * One guarded run through the runner, in a fresh plant (or `o.p`, an earlier run's), resuming `o.resume` when given,
 * its stand-in reading `o.sub`'s file. A read-only run (Read only allowed) by default; `o.worker`: shaped as a
 * coordinator worker run (R1185p D2): the worker's role prompt (--append-system-prompt-file), its JSON schema
 * (--json-schema) and tools, and an API key file, so --settings carries apiKeyHelper. `control` changes its argv or env
 * as shim() says.
 */
async function run(control = null, o = {}) {
  const p = o.p ?? plant();
  const ranBefore = new Set(readdirSync(p.ran));
  const api = await standIn(p.repo, p.ran, o.sub);
  const varName = `${BRAND.envPrefix}_INSTANCES_DIR`;
  const before = process.env[varName];
  process.env[varName] = p.instances;
  let r;
  try {
    install({ root: p.repo, engineCli: join(repoRoot, 'dist', 'src', 'cli.js'), instance: 'probe' });
    const keyFile = join(p.root, 'api-key');
    writeFileSync(keyFile, 'sk-ant-not-a-key\n', { mode: 0o600 });
    const base = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: p.home, CLAUDE_CONFIG_DIR: p.cfg, ...(o.worker ? {} : { ANTHROPIC_API_KEY: 'sk-ant-not-a-key' }), [varName]: p.instances };
    const runner = new CliRunner('api_key', base, shim(p.root, api.url, control), undefined, undefined, undefined, {}, () => guardrailSettings(p.instanceHome, 'probe', p.repo), o.worker ? keyFile : undefined);
    const shape = o.worker ? { appendSystemPrompt: rolePrompt(p.repo, 'worker'), jsonSchema: WORKER_SCHEMA, allowedTools: WORKER_TOOLS } : { allowedTools: ['Read'] };
    r = await runner.run({ prompt: 'Do the task.', model: 'claude-sonnet-4-5', cwd: p.repo, maxTurns: 6, maxBudgetUsd: 1, stallMs: 120_000, timeoutMs: 180_000, role: 'worker', ...shape, ...(o.resume ? { resume: o.resume } : {}) });
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
    toolRan: model.some((s) => s.body.includes('tool_result') && s.body.includes(`toolu_${api.tag}_1`)),
    reached: Object.entries(MARKS).filter(([, m]) => text.includes(m)).map(([k]) => k),
    ran: readdirSync(p.ran).filter((f) => !ranBefore.has(f)),
  };
}

const say = (what, r) => console.log(`${what}: ${r.model.length} model call(s) to the stand-in, the tool ${r.toolRan ? 'ran' : "didn't run"}; markers reached: ${r.reached.join(', ') || 'none'}; hooks, MCP or tools run: ${r.ran.join(', ') || 'none'}`);
const problems = [];
const measured = (what, r) => {
  if (!r.model.length) problems.push(`${what}: no model call reached the stand-in, so nothing is measured (${r.result?.reason}: ${String(r.result?.detail).slice(0, 300)})`);
  else if (!r.toolRan) problems.push(`${what}: the stand-in's Read never ran in this run, so nothing loaded by a tool or a turn's end is measured`);
};
const ranName = (f) => (f === 'mcp' ? "the checkout's MCP server" : `the ${f.split('-')[0]} settings' ${f.split('-').slice(1).join('-')} hook`);
/** A guarded run's leaks: a marker in a request, a planted hook or the MCP server run, and (`readOnly`) Bash or Write run. */
const leaks = (what, r, readOnly) => {
  for (const k of r.reached) problems.push(`${what}'s request carries ${k} (${MARKS[k]}): that was loaded`);
  for (const f of hooksOf(r.ran)) problems.push(`${what} ran ${ranName(f)}`);
  if (readOnly) for (const f of r.ran.filter((x) => TOOL_FILES.includes(x))) problems.push(`${what} ran ${f === 'tool-bash' ? 'Bash' : 'Write'}, which it doesn't allow: a settings file's allow rule was loaded`);
};

const project = await run({ sources: 'project' });
say("control (--setting-sources project, an unguarded run's)", project);
measured('the project control', project);
for (const k of PROJECT_MARKS) if (!project.reached.includes(k)) problems.push(`with project sources, ${k} (${MARKS[k]}) didn't reach a request: its plant is broken, so its absence proves nothing`);
for (const e of TURN_EVENTS) if (!project.ran.includes(`project-${e}`)) problems.push(`with project sources, the checkout's ${e} hook didn't run: its plant is broken`);

const all = await run({ sources: 'user,project,local', mcp: true, memory: true });
say('control (every source, no --strict-mcp-config, no CLAUDE_CODE_DISABLE_AUTO_MEMORY)', all);
measured('the every-source control', all);
// One header wins: the local settings' ANTHROPIC_CUSTOM_HEADERS replaces the home's, so the home's is shown alone below.
for (const k of Object.keys(MARKS).filter((x) => x !== 'homeEnv' && x !== 'resumeNested')) if (!all.reached.includes(k)) problems.push(`with every source, ${k} (${MARKS[k]}) didn't reach a request: its plant is broken, so its absence proves nothing`);
for (const who of ['project', 'local', 'home']) for (const e of TURN_EVENTS) if (!all.ran.includes(`${who}-${e}`)) problems.push(`with every source, the ${who} settings' ${e} hook didn't run: its plant is broken`);
if (!all.ran.includes('mcp')) problems.push("with every source and no --strict-mcp-config, the checkout's MCP server didn't start: its plant is broken");
for (const f of TOOL_FILES) if (!all.ran.includes(f)) problems.push(`with every source, the settings' allow rules didn't let ${f === 'tool-bash' ? 'Bash' : 'Write'} run in a Read-only run: their plant is broken`);

const user = await run({ sources: 'user' });
say('control (--setting-sources user)', user);
measured('the user control', user);
for (const k of ['homeClaudeMd', 'homeEnv', 'homeToolEnv']) if (!user.reached.includes(k)) problems.push(`with user sources, ${k} (${MARKS[k]}) didn't reach a request: its plant is broken, so its absence proves nothing`);

const memory = await run({ memory: true });
say("control (the guarded run's argv, no CLAUDE_CODE_DISABLE_AUTO_MEMORY)", memory);
measured('the memory control', memory);
if (!memory.reached.includes('memory')) problems.push("without CLAUDE_CODE_DISABLE_AUTO_MEMORY, the guarded argv didn't load the auto memory: its plant is broken, so its absence proves nothing");

const guarded = await run(null);
const sources = guarded.given.args[guarded.given.args.indexOf('--setting-sources') + 1];
say(`guarded, Read only (the runner's own argv and env: --setting-sources ${JSON.stringify(sources)}, --settings, CLAUDE_CODE_DISABLE_AUTO_MEMORY=${guarded.given.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY})`, guarded);
measured('the guarded run', guarded);
if (!guarded.given.args.includes('--settings')) problems.push("the guarded run's argv has no --settings: the instance's agent settings weren't passed");
leaks('a guarded run', guarded, true);

// Shaped as a coordinator worker run (R1185p D2): its role prompt, schema, tools and apiKeyHelper. Bash and Write are
// its own here, so the stand-in's Bash shows what the tools' environment holds.
const worker = await run(null, { worker: true });
say('guarded, as a worker runs (--append-system-prompt-file, --json-schema, its tools, apiKeyHelper)', worker);
measured('the guarded worker run', worker);
const arg = (k) => worker.given.args[worker.given.args.indexOf(k) + 1] ?? '';
if (!worker.given.args.includes('--append-system-prompt-file') || !worker.given.args.includes('--json-schema') || !/"apiKeyHelper"/.test(arg('--settings'))) problems.push("the guarded worker run isn't shaped as a worker's: its argv lacks --append-system-prompt-file, --json-schema or apiKeyHelper in --settings");
if (!worker.ran.includes('tool-bash')) problems.push("the guarded worker run's Bash didn't run, so what its tools see is unmeasured");
leaks('the guarded worker run', worker, false);

// Resumed (R1185n C3): the only runs that resume are fix runs (src/coordinator/fix-runs.ts), which are worker-shaped,
// so both runs of each pair are (R1185q): a guarded worker run, then a run resuming its session in the same planted
// tree, whose stand-in reads sub2/, a folder the first run never read (R1185p).
for (const [what, control] of [['control', { sources: 'user,project,local', mcp: true, memory: true }], ['guarded', null]]) {
  const first = await run(null, { worker: true });
  const id = first.result?.sessionId;
  if (!id) {
    problems.push(`the ${what} resume: the first run gave no session id to resume (${first.result?.reason}: ${String(first.result?.detail).slice(0, 200)})`);
    continue;
  }
  const r = await run(control, { p: first.p, resume: id, sub: 'sub2', worker: true });
  say(`${what} resumed run (--resume ${id})`, r);
  measured(`the ${what} resumed run`, r);
  if (!r.given.args.includes('--resume')) problems.push(`the ${what} resumed run's argv has no --resume`);
  if (control) {
    // What loads at a session's start, and sub2/CLAUDE.md, loaded when the resumed session reads that folder.
    for (const k of ['projectClaudeMd', 'dotClaudeMd', 'localClaudeMd', 'parentClaudeMd', 'rules', 'skill', 'agent', 'command', 'homeClaudeMd', 'localEnv', 'resumeNested']) if (!r.reached.includes(k)) problems.push(`a resumed run with every source didn't reach ${k} (${MARKS[k]}): its plant is broken, so the guarded resume proves nothing`);
  } else leaks('the guarded resumed run', r, false);
}

if (problems.length) {
  console.error(`setting-sources probe (${bin}):\n${problems.map((x) => `  ${x}`).join('\n')}`);
  process.exit(1);
}
console.log("a guarded run loaded nothing planted, Read-only, worker-shaped or resumed: no CLAUDE.md (checkout, .claude/, local, parent, home, nested, read on resume), rules (path-scoped included), skill (nested included), agent, command, hook on any event, MCP server, settings env (headers or a tool's), allow rule or auto memory");
