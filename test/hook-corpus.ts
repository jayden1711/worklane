// A corpus of tool calls for the agents' tool guard (#785), and what the guard answers to each. test/hook.test.ts
// holds the answers the guard gave before its import tree was cut (test/fixtures/hook-corpus.json, recorded from
// main), so a moved module that decides anything differently fails there, naming the call.
// Each case runs in a fresh temporary tree; its paths are written back as <T> so the answers compare across runs.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { runHook, type HookOutput } from '../src/hook.js';
import { exampleProject } from './helpers.js';

const P = BRAND.envPrefix;
const RESEARCH_ROOT = `${P}_RESEARCH_ROOT`;
const CHAT_ROOT = `${P}_CHAT_ROOT`;

type Input = Record<string, unknown>;
interface Case { name: string; event?: string; cwd: string; tool: string; input: Input; env: Record<string, string> }

/** The trees the cases run in: a research bundle and a checkout beside it, and a project copied from examples/basic. */
function trees() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'corpus-')));
  const researchRoot = join(base, 'research');
  const bundle = join(researchRoot, 'run-1');
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, 'issue.md'), '# Q');
  writeFileSync(join(bundle, 'research.json'), JSON.stringify({ blocklist: ['tracker.example', '*.ads.example'] }));
  const noManifest = join(researchRoot, 'run-2');
  mkdirSync(noManifest);
  const checkout = join(base, 'repo');
  mkdirSync(join(checkout, 'src', 'deep'), { recursive: true });
  mkdirSync(join(checkout, 'docs'), { recursive: true });
  mkdirSync(join(checkout, '.git'), { recursive: true });
  for (const f of ['src/a.ts', 'src/deep/b.ts', 'docs/x.md', '.env', '.env.example', 'src/server.pem', '.git/config', 'README.md']) writeFileSync(join(checkout, f), 'x\n');
  const outside = join(base, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'x\n');
  symlinkSync(outside, join(checkout, 'link-out'));
  const { dir: project, stateDir } = exampleProject();
  const cfg = join(project, BRAND.configDir, 'config.yaml');
  writeFileSync(cfg, `${readFileSync(cfg, 'utf8')}\nresearch:\n  domain_blocklist: ["blocked.example"]\n`);
  return { base, researchRoot, bundle, noManifest, checkout, outside, project, stateDir };
}

function cases(t: ReturnType<typeof trees>): Case[] {
  const agent = (role: string | null, extra: Record<string, string> = {}) => ({ [`${P}_AGENT`]: '1', ...(role ? { [`${P}_ROLE`]: role } : {}), [`${P}_STATE_DIR`]: t.stateDir, ...extra });
  const research = agent('researcher', { [RESEARCH_ROOT]: t.researchRoot });
  const intakeLane = agent('intake', { [RESEARCH_ROOT]: t.researchRoot });
  const chat = agent('channel-chat', { [CHAT_ROOT]: t.checkout });
  const c: Case[] = [];
  const add = (name: string, cwd: string, tool: string, input: Input, env: Record<string, string>, event?: string) => c.push({ name, cwd, tool, input, env, ...(event ? { event } : {}) });

  // The research lane: its tools only, reads inside its root, fetches past its bundle's blocklist.
  for (const tool of ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Task', 'mcp__x__y', 'WebSearch', 'TodoWrite']) add(`research: ${tool}`, t.bundle, tool, { command: 'ls', file_path: join(t.bundle, 'a'), query: 'q' }, research);
  add('research: read in the bundle', t.bundle, 'Read', { file_path: join(t.bundle, 'issue.md') }, research);
  add('research: read relative', t.bundle, 'Read', { file_path: 'issue.md' }, research);
  add('research: read the checkout', t.bundle, 'Read', { file_path: join(t.checkout, 'src', 'a.ts') }, research);
  add('research: read climbing out', t.bundle, 'Read', { file_path: join('..', '..', 'repo', '.env') }, research);
  add('research: glob an absolute pattern out', t.bundle, 'Glob', { pattern: join(t.checkout, '**', '*.ts') }, research);
  add('research: glob a relative pattern', t.bundle, 'Glob', { pattern: '**/*.md' }, research);
  add('research: grep a path out', t.bundle, 'Grep', { pattern: 'x', path: t.checkout }, research);
  add('research: grep with no path', t.bundle, 'Grep', { pattern: 'x' }, research);
  add('research: cwd outside the root', t.checkout, 'Read', { file_path: join(t.bundle, 'issue.md') }, research);
  for (const url of ['https://tracker.example/a', 'https://sub.tracker.example/a', 'http://WWW.Tracker.Example./', 'https://x.ads.example/', 'https://ads.example/', 'https://example.org/docs', 'ftp://example.org/f', 'not a url', '']) {
    add(`research: fetch ${url || '(empty)'}`, t.bundle, 'WebFetch', { url, prompt: 'p' }, research);
  }
  add('research: fetch with no manifest', t.noManifest, 'WebFetch', { url: 'https://example.org/', prompt: 'p' }, research);
  add('research: fetch with no url', t.bundle, 'WebFetch', { prompt: 'p' }, research);

  // The intake run: Read, Glob and Grep only, in the research lane and in a project.
  for (const tool of ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch', 'Edit']) add(`intake lane: ${tool}`, t.bundle, tool, { file_path: join(t.bundle, 'issue.md'), pattern: '*', url: 'https://example.org/' }, intakeLane);
  add('intake lane: read the checkout', t.bundle, 'Read', { file_path: join(t.checkout, 'README.md') }, intakeLane);
  for (const tool of ['Read', 'Bash', 'WebFetch']) add(`intake in a project: ${tool}`, t.project, tool, { file_path: join(t.project, 'README.md'), command: 'ls', url: 'https://example.org/' }, agent('intake'));

  // The chat lane: its three read tools inside the checkout, never a secret-like file, nothing without its root.
  for (const tool of ['Bash', 'Edit', 'WebFetch', 'LS', 'NotebookRead']) add(`chat: ${tool}`, t.checkout, tool, { command: 'ls', file_path: join(t.checkout, 'README.md') }, chat);
  add('chat: no root', t.checkout, 'Read', { file_path: join(t.checkout, 'README.md') }, agent('channel-chat'));
  for (const f of ['README.md', 'src/a.ts', '.env', '.env.example', 'src/server.pem', '.git/config', 'missing/new.ts', 'credentials.yaml', 'id_rsa', 'a/secrets.json', 'x.tfvars']) {
    add(`chat: read ${f}`, t.checkout, 'Read', { file_path: join(t.checkout, f) }, chat);
  }
  add('chat: read relative', join(t.checkout, 'src'), 'Read', { file_path: 'a.ts' }, chat);
  add('chat: read outside', t.checkout, 'Read', { file_path: join(t.outside, 'secret.txt') }, chat);
  add('chat: read through a symlink out', t.checkout, 'Read', { file_path: join(t.checkout, 'link-out', 'secret.txt') }, chat);
  add('chat: cwd outside', t.outside, 'Read', { file_path: join(t.checkout, 'README.md') }, chat);
  add('chat: read with no path', t.checkout, 'Read', {}, chat);
  for (const [label, pattern] of [['**/*.ts', '**/*.ts'], ['../**', '../**'], ['src/../../x', 'src/../../x'], ['absolute, outside', join(t.outside, '*')], ['absolute, inside', join(t.checkout, 'src', '*')], ['(empty)', '']]) {
    add(`chat: glob ${label}`, t.checkout, 'Glob', { pattern }, chat);
  }
  // In a project, so a call the chat rule lets through reaches the project's guardrails and is allowed.
  const chatInProject = agent('channel-chat', { [CHAT_ROOT]: t.project });
  for (const f of ['README.md', '.env.example', '.env', 'src/x.ts']) add(`chat in a project: read ${f}`, t.project, 'Read', { file_path: join(t.project, f) }, chatInProject);
  add('chat in a project: glob', t.project, 'Glob', { pattern: '**/*.md' }, chatInProject);
  add('chat in a project: grep src', t.project, 'Grep', { pattern: 'x', path: 'src' }, chatInProject);
  add('chat in a project: grep with a glob', t.project, 'Grep', { pattern: 'x', glob: '*.js' }, chatInProject);
  add('chat in a project: Bash', t.project, 'Bash', { command: 'ls' }, chatInProject);
  add('chat: grep the checkout', t.checkout, 'Grep', { pattern: 'x' }, chat);
  add('chat: grep src', t.checkout, 'Grep', { pattern: 'x', path: join(t.checkout, 'src') }, chat);
  add('chat: grep docs', t.checkout, 'Grep', { pattern: 'x', path: 'docs' }, chat);
  add('chat: grep a file', t.checkout, 'Grep', { pattern: 'x', path: join(t.checkout, 'src', 'a.ts') }, chat);
  add('chat: grep a missing path', t.checkout, 'Grep', { pattern: 'x', path: join(t.checkout, 'nope') }, chat);
  for (const glob of ['*.ts', '*.{ts,md}', '*.{env,ts}', '**/*.pem', '[a-z]*', '{a,{b}}', '*']) add(`chat: grep glob ${glob}`, t.checkout, 'Grep', { pattern: 'x', glob }, chat);

  // A project's guardrails, for agents and people, and a researcher without its lane.
  const plain = agent(null);
  add('agent: read .env', t.project, 'Read', { file_path: join(t.project, '.env') }, plain);
  add('agent: edit .env.example', t.project, 'Edit', { file_path: join(t.project, '.env.example'), old_string: 'a', new_string: 'b' }, plain);
  add('agent: edit the guardrails', t.project, 'Edit', { file_path: join(t.project, BRAND.configDir, 'guardrails.yaml'), old_string: 'a', new_string: 'b' }, plain);
  add('agent: fetch unlisted', t.project, 'WebFetch', { url: 'https://unlisted.example/docs', prompt: 'p' }, plain);
  add('agent: fetch listed', t.project, 'WebFetch', { url: 'https://nodejs.org/api', prompt: 'p' }, plain);
  add('agent: fetch allowed once', t.project, 'WebFetch', { url: 'https://once.example/a', prompt: 'p' }, agent(null, { [`${P}_ALLOW_HOSTS`]: 'once.example' }));
  add('agent: npm test', t.project, 'Bash', { command: 'npm test' }, plain);
  add('agent: user-agent spoofing', t.project, 'Bash', { command: "curl -A 'Mozilla/5.0' https://example.com" }, plain);
  add('agent: held-out read', t.project, 'Read', { file_path: '/srv/x/evals/held-out/case.json' }, plain);
  add('agent: a missing task file', t.project, 'Read', { file_path: join(t.project, 'README.md') }, agent(null, { [`${P}_TASK_FILE`]: join(t.base, 'nope.json') }));
  add('agent: no config above', t.outside, 'Read', { file_path: join(t.outside, 'secret.txt') }, plain);
  add('person: read .env', t.project, 'Read', { file_path: join(t.project, '.env') }, { [`${P}_STATE_DIR`]: t.stateDir });
  add('person: no config above', t.outside, 'Bash', { command: 'ls' }, { [`${P}_STATE_DIR`]: t.stateDir });
  const researcher = agent('researcher');
  add('researcher in a project: fetch blocked', t.project, 'WebFetch', { url: 'https://blocked.example/a', prompt: 'p' }, researcher);
  add('researcher in a project: fetch another', t.project, 'WebFetch', { url: 'https://unlisted.example/a', prompt: 'p' }, researcher);
  add('researcher in a project: Bash', t.project, 'Bash', { command: 'ls' }, researcher);
  add('researcher in a project: read', t.project, 'Read', { file_path: join(t.project, 'README.md') }, researcher);

  // The other events.
  add('post-tool-use: a read', t.project, 'Read', { file_path: join(t.project, 'README.md') }, plain, 'post-tool-use');
  add('post-tool-use: an edit outside', t.project, 'Edit', { file_path: join(t.outside, 'secret.txt') }, plain, 'post-tool-use');
  add('session-start', t.project, '', {}, plain, 'session-start');
  add('stop', t.project, '', {}, plain, 'stop');
  add('session-end without a transcript', t.project, '', {}, plain, 'session-end');
  add('an unknown event', t.project, '', {}, plain, 'no-such-event');
  return c;
}

/** The guard's whole answer as one line: exit code, stdout and stderr, byte for byte but for the names written as placeholders. */
const answer = (r: HookOutput, shown: (s: string) => string) => [`exit ${r.exitCode}`, ...(r.stdout ? [`stdout ${shown(r.stdout)}`] : []), ...(r.stderr ? [`stderr ${shown(r.stderr)}`] : [])].join(' | ');

/**
 * Each case's name and the guard's answer. Its temporary paths are written as <T> (and the project as <P>), and the
 * engine's names as <cli>, <PREFIX> and <configDir>, so the answers compare across machines and a rename.
 */
export async function runCorpus(): Promise<Record<string, string>> {
  const t = trees();
  const shown = (s: string) => s.split(t.project).join('<P>').split(t.base).join('<T>').split(BRAND.configDir).join('<configDir>').split(`${P}_`).join('<PREFIX>_').split(`[${BRAND.cli}]`).join('[<cli>]');
  const out: Record<string, string> = {};
  for (const k of cases(t)) {
    if (k.name in out) throw new Error(`two corpus cases are named ${k.name}`);
    const r = await runHook(k.event ?? 'pre-tool-use', { hook_event_name: 'PreToolUse', cwd: k.cwd, tool_name: k.tool, tool_input: k.input, session_id: 's' }, { ...process.env, ...k.env });
    out[k.name] = answer(r, shown);
  }
  return out;
}
