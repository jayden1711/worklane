// The adversarial suite's second half (#707): the guards around the agents and around pushes and secrets
// (docs/guardrails.md, "The guards around the agents" and "The guards around pushes and secrets"). The first half
// (adversarial.test.ts) feeds hostile PRs to the merge gate; this file feeds hostile inputs to each guard's own entry
// point, as the engine calls it:
//   - the tool guard through the hook (src/hook.ts runHook 'pre-tool-use'), in an agent's environment, on a project
//     whose guardrails.yaml lists no path of its own, so what holds is held by the engine;
//   - the settings check, the sandbox settings and the hatch-free environment through a real agent run
//     (src/runner.ts CliRunner) with a stand-in claude that records what it was given;
//   - the push guard through checkedPush and the pre-push hook it installs, against a scratch bare remote;
//   - the push gate (scripts/push-gate.mjs) as the pre-push hook of a scratch checkout;
//   - the commit scan through the hook, and the scanner's own entry points with broken scanners;
//   - redaction through the event log and the run record, read back from what they stored.
//
// Each test names the guarantee's text in docs/guardrails.md (`doc()` finds its line, and the file fails to load if
// the text moved away). Each attack is one line: what it tries and the input. A test passes only if every attack is
// refused, and its controls show the refusal isn't everything refused.
//
// A hole an open PR is closing is a known-hole case (knownHole): a strict expected failure that names the PR. It
// passes while every one of its attacks still gets through, and fails the suite, saying "this hole is closed: turn
// this into a normal case", once any is refused. So the fix PR goes red in its own CI until it turns the case into a
// normal one, and the flip can't be forgotten. They show no more than that PR's own tests or issue already do (#707).
//
// Every fixture is fake and assembled at runtime (stand-in tokens, a hashed made-up term), so no secret-, address- or
// path-shaped literal sits in this file for the repo's own scans to find. Nothing touches the machine's own state: the
// test isolation (test/isolate.ts) gives this process its own home, state dir and temporary directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardrailSettings, agentSettingsPath, type Settings } from '../../src/agent-settings.js';
import { BRAND } from '../../src/brand.js';
import { GuardrailsConfig } from '../../src/config/schema.js';
import { EventLog } from '../../src/events/log.js';
import { checkGuardrails } from '../../src/guardrails/check.js';
import { globToRegExp } from '../../src/guardrails/glob.js';
import { runHook, type HookOutput } from '../../src/hook.js';
import { agentSettings } from '../../src/install.js';
import { laneRuns, PolicyFile, type Instance } from '../../src/instance.js';
import { which } from '../../src/os/index.js';
import { checkedPush, type PushLimits } from '../../src/push-check.js';
import { installPrePushHook } from '../../src/push-guard.js';
import { RunRecorder } from '../../src/run-record.js';
import { CliRunner, type RunRequest } from '../../src/runner.js';
import { scanCommit, scanPath, scanRange } from '../../src/scan/secrets.js';
import { engineCli, exampleProject, repoRoot, STDIN_LINE } from '../helpers.js';

const posix = process.platform !== 'win32';
const asRoot = process.getuid?.() === 0;
const AGENT = `${BRAND.envPrefix}_AGENT`;
const TASK = `${BRAND.envPrefix}_TASK_FILE`;
const STATE = `${BRAND.envPrefix}_STATE_DIR`;
const C = BRAND.configDir;
const HATCH = 'PUSH_GATE_BOOTSTRAP';

// ---- Where each guarantee is written. ----

const docLines = readFileSync(join(repoRoot, 'docs', 'guardrails.md'), 'utf8').split('\n');
/** docs/guardrails.md and the line that says `phrase`; the file fails to load once no line does (re-map the case). */
function doc(phrase: string): string {
  const n = docLines.findIndex((l) => l.includes(phrase));
  if (n < 0) throw new Error(`docs/guardrails.md no longer says "${phrase}": map this case to the guarantee's new text`);
  return `docs/guardrails.md:${n + 1}`;
}

/** Each attack whose answer isn't the refusal it must be, with that answer; [] when every one was refused. */
async function letThrough<A extends { what: string }>(attacks: readonly A[], refused: (a: A) => Promise<string | null> | string | null): Promise<string[]> {
  const out: string[] = [];
  for (const a of attacks) {
    const why = await refused(a);
    if (why !== null) out.push(`${a.what}: ${why}`);
  }
  return out;
}

// ---- Known holes: strict expected failures. ----

/** A route main doesn't close yet: the attacks its case makes, and the ones that still get through on this tree. */
interface Hole {
  attacks: string[];
  open: string[];
}

/**
 * Why a known hole's case fails the suite, or null while every one of its attacks still gets through. WHY: a hole
 * case is a strict expected failure, not a node:test todo (which reports a passing body as `ok # TODO`, so a
 * regression of a fix would stay green). The fix PR that closes the hole goes red in its own CI until it turns the
 * case into a normal one; main never does, as only that PR changes what the attacks get.
 */
function holeStatus(closes: string, h: Hole): string | null {
  const unknown = h.open.filter((a) => !h.attacks.includes(a));
  if (!h.attacks.length || unknown.length) return `known-hole bookkeeping is wrong (${closes}): attacks ${JSON.stringify(h.attacks)}, open ${JSON.stringify(h.open)}`;
  const closed = h.attacks.filter((a) => !h.open.includes(a));
  if (!closed.length) return null;
  if (closed.length === h.attacks.length) return `this hole is closed: turn this into a normal case (it closes with ${closes}): ${closed.join('; ')} are now refused`;
  return `this hole is partly closed: turn these attacks into a normal case (it closes with ${closes}), and keep the rest here: ${closed.join('; ')} are now refused`;
}

/** The status of one hole case: its body runs first, so a body that can't run fails the case and never counts as open. */
const holeVerdict = async (closes: string, body: () => Promise<Hole> | Hole) => holeStatus(closes, await body());

/** A case for a hole an open PR closes: green while the hole is open on this tree, red with what to do once it isn't. */
function knownHole(name: string, closes: string, opts: { skip?: string | false }, body: () => Promise<Hole> | Hole) {
  test(`${name} [known hole, open on main: closes with ${closes}]`, opts, async () => {
    const why = await holeVerdict(closes, body);
    assert.equal(why, null, why ?? '');
  });
}

test('adversarial guards / known-hole helper: an open hole passes; a closed one, wholly or in part, fails with what to do; a body that cannot run fails', async () => {
  const closes = 'PR #1 (#2)';
  assert.equal(holeStatus(closes, { attacks: ['a', 'b'], open: ['b', 'a'] }), null, 'every attack still gets through');
  assert.match(holeStatus(closes, { attacks: ['a', 'b'], open: [] }) ?? '', /^this hole is closed: turn this into a normal case \(it closes with PR #1 \(#2\)\): a; b are now refused$/);
  assert.match(holeStatus(closes, { attacks: ['a', 'b'], open: ['a'] }) ?? '', /^this hole is partly closed: turn these attacks into a normal case .*: b are now refused$/);
  assert.match(holeStatus(closes, { attacks: [], open: [] }) ?? '', /bookkeeping is wrong/, 'a hole with no attacks proves nothing');
  assert.match(holeStatus(closes, { attacks: ['a'], open: ['a', 'z'] }) ?? '', /bookkeeping is wrong/, 'an open attack the case never made');
  await assert.rejects(holeVerdict(closes, () => { throw new Error('the fixture broke'); }), /the fixture broke/);
  assert.equal(await holeVerdict(closes, async () => ({ attacks: ['a'], open: ['a'] })), null);
});

// ---- Stand-in secrets, made at runtime. ----

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** `n` random letters and digits, starting with an upper, a lower and a digit (so every "mixed case with a digit" rule sees one). */
const alnum = (n: number) => `Aa1${[...randomBytes(n)].map((b) => ALNUM[b % ALNUM.length]).join('')}`.slice(0, n);
const UPPER_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const upperDigits = (n: number) => [...randomBytes(n)].map((b) => UPPER_DIGITS[b % UPPER_DIGITS.length]).join('');
const hex = (n: number) => randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
/** A GitHub-token-shaped stand-in (gitleaks and the redactor both know the shape; the value is random). */
const ghToken = () => ['gh', 'p_', alnum(36)].join('');

// ---- The tool guard, through the hook. ----

interface Answer {
  decision: string;
  reason: string;
}
function answerOf(o: HookOutput): Answer {
  if (!o.stdout) return { decision: o.exitCode === 0 ? 'none' : `exit ${o.exitCode}`, reason: o.stderr ?? '' };
  const h = (JSON.parse(o.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput;
  return { decision: h.permissionDecision, reason: h.permissionDecisionReason };
}

/**
 * A project whose guardrails.yaml protects no path of its own, has secret files (.env, a home key) and an allowlist,
 * a task file that hides one directory, and `call`: the hook's answer for one tool call. By default the call is an
 * agent's (`agent: false`: a person's session) with that task file (`task: null`: none; a path: that file).
 */
function guardProject() {
  const { dir, stateDir } = exampleProject();
  writeFileSync(join(dir, C, 'guardrails.yaml'), JSON.stringify({ version: 1, rules: [], protected_paths: [], secret_paths: ['./.env', './.env.*', '!./.env.example', '~/.ssh/**'], network: { allow: ['docs.github.com', '*.npmjs.org'] }, examples: { must_block: [], must_ask: [], must_allow: [] } }));
  writeFileSync(join(dir, '.env'), 'TOKEN=stand-in\n');
  writeFileSync(join(dir, '.env.example'), 'TOKEN=\n');
  mkdirSync(join(dir, 'evals-secret'));
  writeFileSync(join(dir, 'evals-secret', 'score.py'), 'EXPECTED = 42\n');
  const tasks = mkdtempSync(join(tmpdir(), 'adv-tasks-'));
  const taskFile = join(tasks, 'exp-1.json');
  writeFileSync(taskFile, JSON.stringify({ id: 'exp-1', done_when: [{ manual: 'checked by the coordinator' }], frozen: [], hidden: ['evals-secret/**'] }));
  const call = async (tool: string, input: Record<string, unknown>, o: { cwd?: string; task?: string | null; agent?: boolean } = {}): Promise<Answer> => {
    const task = o.agent === false || o.task === null ? {} : { [TASK]: o.task ?? taskFile };
    const env = { ...process.env, [STATE]: stateDir, ...(o.agent === false ? {} : { [AGENT]: '1' }), ...task };
    return answerOf(await runHook('pre-tool-use', { hook_event_name: 'PreToolUse', cwd: o.cwd ?? dir, tool_name: tool, tool_input: input, session_id: 'adversarial' }, env));
  };
  return { dir, tasks, taskFile, call };
}

interface ToolAttack {
  what: string;
  tool: string;
  input: Record<string, unknown>;
  cwd?: string;
}
const bash = (what: string, command: string, cwd?: string): ToolAttack => ({ what, tool: 'Bash', input: { command }, ...(cwd ? { cwd } : {}) });

/** The answer for each attack that isn't a deny by `rule`. */
const refusedBy = (g: ReturnType<typeof guardProject>, rule: RegExp, o: { task?: string | null } = {}) => async (a: ToolAttack) => {
  const v = await g.call(a.tool, a.input, { ...(a.cwd ? { cwd: a.cwd } : {}), ...o });
  return v.decision === 'deny' && rule.test(v.reason) ? null : `${v.decision} ${v.reason}`.trim();
};

test(`adversarial guards / tool.no-write-config (${doc("write the engine's config folder")}): no agent writes the config folder or .claude/, by any tool or shell route`, { skip: !posix && 'POSIX shells' }, async () => {
  const g = guardProject();
  const d = g.dir;
  const attacks: ToolAttack[] = [
    { what: 'Edit the review config', tool: 'Edit', input: { file_path: join(d, C, 'review.yaml'), old_string: 'a', new_string: 'b' } },
    { what: 'Write the guardrails config by a relative path', tool: 'Write', input: { file_path: `${C}/guardrails.yaml`, content: 'x' } },
    { what: 'MultiEdit the project config', tool: 'MultiEdit', input: { file_path: join(d, C, 'config.yaml'), edits: [] } },
    { what: 'NotebookEdit a notebook under .claude', tool: 'NotebookEdit', input: { notebook_path: join(d, '.claude', 'n.ipynb'), new_source: 'x' } },
    { what: 'Write .claude/settings.json', tool: 'Write', input: { file_path: join(d, '.claude', 'settings.json'), content: '{}' } },
    { what: 'Write .claude/settings.local.json', tool: 'Write', input: { file_path: join(d, '.claude', 'settings.local.json'), content: '{}' } },
    { what: 'Write a hook under .claude', tool: 'Write', input: { file_path: join(d, '.claude', 'hooks', 'pre.sh'), content: 'exit 0' } },
    { what: 'Write a skill under .claude', tool: 'Write', input: { file_path: join(d, '.claude', 'skills', 'x', 'SKILL.md'), content: 'x' } },
    { what: 'Write a command under .claude', tool: 'Write', input: { file_path: join(d, '.claude', 'commands', 'x.md'), content: 'x' } },
    { what: 'Write an agent under .claude', tool: 'Write', input: { file_path: join(d, '.claude', 'agents', 'x.md'), content: 'x' } },
    { what: 'Write through ../ from a subfolder', tool: 'Write', input: { file_path: `../${C}/review.yaml`, content: 'x' }, cwd: join(d, 'src') },
    { what: 'Write an absolute path that climbs back in', tool: 'Write', input: { file_path: `${d}/src/../${C}/review.yaml`, content: 'x' } },
    bash('a redirect', `echo x > ${C}/review.yaml`),
    bash('an appending redirect', 'echo x >> .claude/settings.json'),
    bash('a clobbering redirect', `echo x >| ${C}/review.yaml`),
    bash('a redirect of both streams', 'echo x &> .claude/settings.local.json'),
    bash('a numbered redirect', `echo x 1> ${C}/review.yaml`),
    bash('a redirect with no space', `echo x >${C}/review.yaml`),
    bash('a redirect to an absolute path', `echo x > ${d}/.claude/settings.json`),
    bash('a redirect through ./ and ../', `echo x > ./${C}/../${C}/review.yaml`),
    bash('a redirect from a subfolder', `echo x > ../${C}/review.yaml`, join(d, 'src')),
    bash('tee', `echo x | tee ${C}/review.yaml`),
    bash('tee -a', 'echo x | tee -a .claude/settings.json'),
    bash('cp onto a file', `cp /dev/null ${C}/review.yaml`),
    bash('cp into the folder', 'cp settings.json .claude'),
    bash('mv into the folder', `mv x ${C}/`),
    bash('mv -t', 'mv -t .claude x'),
    bash('ln -sf over a file', 'ln -sf /dev/null .claude/settings.json'),
    bash('install', `install -m 644 x ${C}/review.yaml`),
    bash('rsync', 'rsync x .claude/'),
    bash('sed -i', `sed -i s/a/b/ ${C}/review.yaml`),
    bash('perl -pi', 'perl -pi -e s/a/b/ .claude/settings.json'),
    bash('dd of=', `dd if=/dev/null of=${C}/review.yaml`),
    bash('rm -rf the folder', 'rm -rf .claude'),
    bash('rm a file', `rm ${C}/review.yaml`),
    bash('touch', 'touch .claude/settings.local.json'),
    bash('truncate', `truncate -s 0 ${C}/review.yaml`),
    bash('mkdir', 'mkdir -p .claude/hooks'),
    bash('bash -c', `bash -c 'echo x > ${C}/review.yaml'`),
    bash('sh -c', 'sh -c "cp x .claude/settings.json"'),
    bash('eval', `eval "echo x > ${C}/review.yaml"`),
    bash('a command substitution', `echo $(echo x > ${C}/review.yaml)`),
    bash('backticks', 'echo `echo x > .claude/settings.json`'),
    bash('a subshell', `(echo x > ${C}/review.yaml)`),
    bash('after &&', `true && echo x > ${C}/review.yaml`),
    bash('sudo tee', `echo x | sudo tee ${C}/review.yaml`),
    bash('env', 'env A=1 cp x .claude/settings.json'),
    bash('timeout', `timeout 5 cp x ${C}/review.yaml`),
    bash('nohup', `nohup cp x ${C}/review.yaml`),
    bash('xargs', 'xargs -I{} cp {} .claude/settings.json'),
  ];
  assert.deepEqual(await letThrough(attacks, refusedBy(g, /protected-path/)), [], 'writes into the config folder or .claude/ that the guard let through');
  // Controls: the agents' own instructions, an ordinary file, and a person's session are not refused.
  for (const [what, input, o] of [
    ['a role prompt (agent-editable)', { file_path: join(d, C, 'roles', 'worker.md'), content: 'x' }, {}],
    ['a source file', { file_path: join(d, 'src', 'price.js'), content: 'x' }, {}],
    ["a person's own session", { file_path: join(d, '.claude', 'settings.json'), content: '{}' }, { agent: false }],
  ] as const) assert.notEqual((await g.call('Write', input, o)).decision, 'deny', `control: ${what}`);
});

test(`adversarial guards / tool.no-read-secrets (${doc('- read secret files;')}): no agent reads a secret file or a task's hidden path, by tool or shell`, { skip: !posix && 'POSIX shells' }, async () => {
  const g = guardProject();
  const d = g.dir;
  const key = join(homedir(), '.ssh', 'id_ed25519');
  const secrets: ToolAttack[] = [
    { what: 'Read .env by its absolute path', tool: 'Read', input: { file_path: join(d, '.env') } },
    { what: 'Read .env by a relative path', tool: 'Read', input: { file_path: '.env' } },
    { what: 'Read .env through ../ from a subfolder', tool: 'Read', input: { file_path: '../.env' }, cwd: join(d, 'src') },
    { what: 'Read .env by an absolute path that climbs back', tool: 'Read', input: { file_path: `${d}/src/../.env` } },
    { what: 'Read .env.local', tool: 'Read', input: { file_path: '.env.local' } },
    { what: 'Read .env.production', tool: 'Read', input: { file_path: join(d, '.env.production') } },
    { what: 'Edit .env.local', tool: 'Edit', input: { file_path: '.env.local', old_string: 'a', new_string: 'b' } },
    { what: 'Write .env', tool: 'Write', input: { file_path: '.env', content: 'x' } },
    { what: 'Grep the .env file', tool: 'Grep', input: { pattern: 'TOKEN', path: '.env' } },
    { what: 'Read a key in the home', tool: 'Read', input: { file_path: key } },
    bash('cat', 'cat .env'),
    bash('cat ./', 'cat ./.env'),
    bash('cat by an absolute path', `cat ${d}/.env`),
    bash('cat through ../', 'cat src/../.env'),
    bash('cat from a subfolder', 'cat ../.env', join(d, 'src')),
    bash('head', 'head -n1 .env'),
    bash('tail', 'tail .env'),
    bash('less', 'less .env'),
    bash('base64', 'base64 .env'),
    bash('xxd', 'xxd .env'),
    bash('strings', 'strings .env'),
    bash('grep', 'grep TOKEN .env'),
    bash('awk', 'awk 1 .env'),
    bash('cp it out', `cp .env ${join(g.tasks, 'copy')}`),
    bash('source', 'source .env'),
    bash('.', '. .env'),
    bash('bash -c', "bash -c 'cat .env'"),
    bash('a command substitution', 'echo $(cat .env)'),
    bash('after ;', 'true; cat .env.local'),
    bash('a home key', 'cat ~/.ssh/id_ed25519'),
    bash('a home key by its absolute path', `cat ${key}`),
  ];
  assert.deepEqual(await letThrough(secrets, refusedBy(g, /secret-path/)), [], 'reads of secret files the guard let through');

  const hidden: ToolAttack[] = [
    { what: 'Read a hidden file by its absolute path', tool: 'Read', input: { file_path: join(d, 'evals-secret', 'score.py') } },
    { what: 'Read a hidden file by a relative path', tool: 'Read', input: { file_path: 'evals-secret/score.py' } },
    { what: 'Read a hidden file through ../', tool: 'Read', input: { file_path: '../evals-secret/score.py' }, cwd: join(d, 'src') },
    { what: 'NotebookRead in the hidden folder', tool: 'NotebookRead', input: { notebook_path: 'evals-secret/nb.ipynb' } },
    { what: 'Grep a hidden file', tool: 'Grep', input: { pattern: 'EXPECTED', path: 'evals-secret/score.py' } },
    bash('cat a hidden file', 'cat evals-secret/score.py'),
    bash('head a hidden file through ./ and ../', 'head ./evals-secret/../evals-secret/score.py'),
    bash('bash -c on a hidden file', 'bash -c "cat evals-secret/score.py"'),
    bash('copy a hidden file out', `cp evals-secret/score.py ${join(g.tasks, 'copy')}`),
  ];
  assert.deepEqual(await letThrough(hidden, refusedBy(g, /secret-path/)), [], "reads of the task's hidden paths the guard let through");

  // Controls: an excluded file, an ordinary file, the hidden folder in a run whose task doesn't hide it, a person.
  for (const [what, tool, input, o] of [
    ['.env.example (excluded)', 'Read', { file_path: '.env.example' }, {}],
    ['a source file', 'Read', { file_path: join(d, 'src', 'price.js') }, {}],
    ['the folder with no task hiding it', 'Read', { file_path: 'evals-secret/score.py' }, { task: null }],
    ["a person's own session", 'Read', { file_path: '.env' }, { agent: false }],
  ] as const) assert.notEqual((await g.call(tool, input, o)).decision, 'deny', `control: ${what}`);
});

test(`adversarial guards / tool.no-read-secrets (${doc('- read secret files;')}): a Glob, Grep, directory read or recursive shell search over a hidden directory or the secret files is refused`, { skip: !posix && 'POSIX shells' }, async () => {
  const g = guardProject();
  const hidden: ToolAttack[] = [
    { what: 'Glob its pattern', tool: 'Glob', input: { pattern: 'evals-secret/**' } },
    { what: 'Glob with it as the path', tool: 'Glob', input: { pattern: '*', path: 'evals-secret' } },
    { what: 'Grep it as a directory', tool: 'Grep', input: { pattern: 'EXPECTED', path: 'evals-secret' } },
    { what: 'Grep with no path (the root holds it)', tool: 'Grep', input: { pattern: 'EXPECTED' } },
    { what: 'Read the directory', tool: 'Read', input: { file_path: join(g.dir, 'evals-secret') } },
    bash('grep -r it', 'grep -r EXPECTED evals-secret'),
    bash('ls it', 'ls evals-secret'),
  ];
  assert.deepEqual(await letThrough(hidden, refusedBy(g, /secret-path/)), [], 'searches over the hidden directory the guard let through');
  writeFileSync(join(g.dir, '.env.production'), 'TOKEN=stand-in\n');
  const secrets: ToolAttack[] = [
    { what: 'Grep the root, which holds .env', tool: 'Grep', input: { pattern: 'TOKEN' } },
    { what: 'Glob the secret files', tool: 'Glob', input: { pattern: '.env*' } },
    bash('an input redirect', 'cat < .env'),
    bash('a wildcard the shell expands to it', 'cat .env*'),
  ];
  assert.deepEqual(await letThrough(secrets, refusedBy(g, /secret-path/, { task: null })), [], 'searches over the secret files the guard let through');
});

test(`adversarial guards / tool.domain-allowlist (${doc('- fetch a domain outside the allowlist.')}): no agent fetches a host off the allowlist, however the URL spells it`, async () => {
  const g = guardProject();
  const fetches = [
    ['an unlisted host', 'https://evil.example/x'],
    ['an unlisted host in capitals', 'https://EVIL.example/x'],
    ['an allowed name as userinfo', 'https://docs.github.com@evil.example/'],
    ['an allowed name as a subdomain of another', 'https://docs.github.com.evil.example/'],
    ['a name that ends like a wildcard entry, without its dot', 'https://evilnpmjs.org/'],
    ['a name that ends with an exact entry, without a dot before it', 'https://evildocs.github.com/'],
    ['a name that ends with an exact entry after another label', 'https://evil.docs.github.com/'],
    ['an allowed name as a path', 'https://evil.example/docs.github.com'],
    ['an IPv4 literal', 'http://127.0.0.1:8080/'],
    ['an IPv6 literal', 'http://[::1]/'],
    ['a decimal IP', 'http://2130706433/'],
    ['punycode', 'https://xn--dcs-github-123.com/'],
    ['a trailing dot', 'https://docs.github.com./'],
    ['a file URL', 'file:///etc/passwd'],
    ['an unparseable URL', 'not a url'],
  ].map(([what, url]) => ({ what: what!, url: url! }));
  assert.deepEqual(
    await letThrough(fetches, async (f) => {
      const v = await g.call('WebFetch', { url: f.url, prompt: 'x' });
      return v.decision === 'deny' && /network/.test(v.reason) ? null : `${v.decision} ${v.reason}`.trim();
    }),
    [],
    'fetches off the allowlist the guard let through',
  );
  for (const url of ['https://docs.github.com/x', 'https://registry.npmjs.org/x', 'https://npmjs.org/']) assert.notEqual((await g.call('WebFetch', { url, prompt: 'x' })).decision, 'deny', `control: ${url} is on the allowlist`);
});

test(`adversarial guards / tool.must-allow-conflict (${doc("A rule that would block a must-allow example can't be activated")}): a new rule that blocks or asks on a must-allow example fails the check`, () => {
  const base = {
    version: 1,
    rules: [{ id: 'no-prod-shell', action: 'block', reason: 'x', match: { command: { pattern: '^railway ssh' } } }],
    examples: { must_block: [{ bash: 'railway ssh' }], must_ask: [], must_allow: [{ bash: 'npm test' }, { bash: 'git status' }, { tool: 'Edit', path: 'src/payments/ledger.js' }] },
  };
  assert.deepEqual(checkGuardrails(GuardrailsConfig.parse(base), '/project'), [], 'control: the rule set before the new rule is consistent');
  const added = [
    { what: 'a path block over an allowed edit', id: 'no-money-edits', rule: { action: 'block', match: { path: { globs: ['src/payments/**'] } } } },
    { what: 'a command block over an allowed command', id: 'no-npm', rule: { action: 'block', match: { command: { pattern: '^npm\\b' } } } },
    { what: 'an ask over an allowed command', id: 'ask-git', rule: { action: 'ask', match: { command: { pattern: '^git status' } } } },
    { what: 'a block for agents only over an allowed command', id: 'agents-no-npm', rule: { action: 'block', applies_to: ['agent'], match: { command: { pattern: 'npm' } } } },
  ];
  assert.deepEqual(
    added.flatMap((a) => {
      const cfg = GuardrailsConfig.parse({ ...base, rules: [...base.rules, { id: a.id, reason: 'x', ...a.rule }], examples: { ...base.examples, must_block: [...base.examples.must_block, { bash: 'railway ssh' }] } });
      const problems = checkGuardrails(cfg, '/project');
      return problems.some((p) => p.kind === 'expected_allow' && p.rule === a.id) ? [] : [`${a.what}: ${JSON.stringify(problems)}`];
    }),
    [],
    'conflicting rules the check let through',
  );
});

test(`adversarial guards / tool.unreadable-task-file-denies (${doc("A task file the guard can't read denies the call")}): a task file that can't be read or parsed refuses every agent call`, { skip: !posix && 'POSIX file modes' }, async () => {
  const g = guardProject();
  const file = (name: string, text: string) => {
    const p = join(g.tasks, name);
    writeFileSync(p, text);
    return p;
  };
  const files = [
    { what: 'missing', path: join(g.tasks, 'nope.json') },
    { what: 'malformed', path: file('bad.json', '{ not json') },
    { what: 'empty', path: file('empty.json', '') },
    { what: 'not a task', path: file('shape.json', JSON.stringify({ id: 'x' })) },
    { what: 'an array', path: file('array.json', '[]') },
    { what: 'null', path: file('null.json', 'null') },
    { what: 'a directory', path: g.tasks },
    { what: 'a symlink to /dev/null', path: (() => { const p = join(g.tasks, 'devnull.json'); symlinkSync('/dev/null', p); return p; })() },
    { what: 'a dangling symlink', path: (() => { const p = join(g.tasks, 'dangling.json'); symlinkSync(join(g.tasks, 'gone.json'), p); return p; })() },
    ...(asRoot ? [] : [{ what: 'unreadable', path: (() => { const p = file('locked.json', JSON.stringify({ id: 'issue-1', done_when: [{ repro: true }], frozen: [] })); chmodSync(p, 0o000); return p; })() }]),
  ];
  assert.deepEqual(
    await letThrough(files, async (f) => {
      const v = await g.call('Read', { file_path: join(g.dir, 'src', 'price.js') }, { task: f.path });
      return v.decision === 'deny' && /task file .* can't be read/.test(v.reason) ? null : `${v.decision} ${v.reason}`.trim();
    }),
    [],
    'task files the guard skipped instead of refusing the call',
  );
  assert.notEqual((await g.call('Read', { file_path: join(g.dir, 'src', 'price.js') })).decision, 'deny', 'control: a readable task file lets an ordinary read through');
});

test(`adversarial guards / tool.hook-covers-tools (${doc('A hook runs before every agent tool call')}): every tool the guard's rules decide on reaches the hook`, { skip: !posix && 'POSIX stand-in claude' }, async () => {
  // The tools src/guardrails/engine.ts decides on: its EDIT_TOOLS and its file-reading READ_TOOLS, Bash and WebFetch.
  const tools = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'Read', 'Grep', 'Glob'];
  const missed = (where: string, entries: { matcher?: string; hooks: { command: string }[] }[]) => {
    const pre = entries.filter((e) => e.hooks.some((h) => h.command.includes(`${BRAND.envPrefix}_HOOK=1`)));
    assert.equal(pre.length, 1, `${where}: one guard hook entry`);
    const matcher = pre[0]!.matcher;
    const reaches = (tool: string) => matcher === undefined || matcher === '*' || new RegExp(`^(?:${matcher})$`).test(tool);
    return tools.filter((t) => !reaches(t)).map((t) => `${where}: ${t} (matcher ${matcher})`);
  };
  // What install writes, and what a run's --settings really carries (runSettings rebuilds the hooks).
  const cwd = mkdtempSync(join(tmpdir(), 'adv-cwd-'));
  const { r, s } = await agentRun({ guardrails: instanceHome(JSON.stringify(goodSettings()), cwd).guardrails, cwd });
  assert.ok(s.ran(), `${r.reason}: ${r.detail}`);
  const atRun = (s.log().settings as { hooks?: Record<string, { matcher?: string; hooks: { command: string }[] }[]> }).hooks?.PreToolUse ?? [];
  assert.deepEqual([...missed('install', agentSettings(engineCli, [], [], []).hooks?.PreToolUse ?? []), ...missed("a run's --settings", atRun)], [], 'tools the guard hook never sees');
});

// ---- Agent runs: the settings check, the sandbox settings, the environment. ----

type Mode = 'applied' | 'dropped' | 'stale' | 'no-style' | 'assistant-first' | 'tool-result-first' | 'result-only';

/**
 * A stand-in claude. It records its arguments, --settings and environment names, then answers as `mode` says: its
 * init event echoes the --settings check value (`applied`), the default style as after a dropped file (`dropped`),
 * another run's value read from `staleFrom` (`stale`), no style (`no-style`); or a turn or a tool result comes before
 * the init (`assistant-first`, `tool-result-first`); or only a result (`result-only`). Then, a while later, it does the
 * agent's work (a file written, standing for a tool call) and ends with a result.
 */
function standIn(mode: Mode = 'applied', staleFrom = '') {
  const d = mkdtempSync(join(tmpdir(), 'adv-claude-'));
  const bin = join(d, 'claude');
  const log = join(d, 'log.json');
  const work = join(d, 'work');
  const value = join(d, 'value');
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
${STDIN_LINE};
const at = args.indexOf('--settings');
const settings = at >= 0 ? JSON.parse(args[at + 1]) : null;
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args, settings, env: Object.keys(process.env) }));
const mode = ${JSON.stringify(mode)};
const mine = settings ? settings.outputStyle : undefined;
if (mine !== undefined) fs.writeFileSync(${JSON.stringify(value)}, String(mine));
const style = mode === 'dropped' ? 'default' : mode === 'stale' ? fs.readFileSync(${JSON.stringify(staleFrom)}, 'utf8') : mode === 'no-style' ? undefined : mine;
const say = (o) => console.log(JSON.stringify(o));
if (mode === 'result-only') { say({ type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0, num_turns: 1 }); process.exit(0); }
if (mode === 'assistant-first') say({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't0', name: 'Bash', input: { command: 'true' } }] } });
if (mode === 'tool-result-first') say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't0', content: 'early' }] } });
say({ type: 'system', subtype: 'init', session_id: 's', tools: ['Bash', 'Read'], mcp_servers: [], plugins: [], ...(style === undefined ? {} : { output_style: style }) });
setTimeout(() => {
  fs.writeFileSync(${JSON.stringify(work)}, 'done');
  say({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
  say({ type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0, num_turns: 1 });
}, 600);
`,
  );
  chmodSync(bin, 0o755);
  return { bin, value, ran: () => existsSync(log), worked: () => existsSync(work), log: () => JSON.parse(readFileSync(log, 'utf8')) as { args: string[]; settings: Record<string, unknown> | null; env: string[] } };
}

/** An instance home holding `content` as its agent settings file (null: no file), and the reader the service gives the runner. */
function instanceHome(content: string | null, cwd: string) {
  const home = mkdtempSync(join(tmpdir(), 'adv-inst-'));
  if (content !== null) writeFileSync(agentSettingsPath(home), content, { mode: 0o600 });
  return { home, guardrails: () => guardrailSettings(home, 'adversarial', cwd) };
}
const goodSettings = () => agentSettings(engineCli, [], [], ['~/.ssh/**']);

const settle = () => new Promise((r) => setTimeout(r, 1200));
const request = (cwd: string, more: Partial<RunRequest> = {}): RunRequest => ({ role: 'worker', prompt: 'p', cwd, model: 'm', allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, stallMs: 30_000, timeoutMs: 30_000, ...more });

/** One agent run through the real runner with a stand-in claude; settled, so work a killed run would have done shows. */
async function agentRun(o: { guardrails?: () => Settings; lanes?: ReturnType<typeof laneRuns>; base?: NodeJS.ProcessEnv; mode?: Mode; staleFrom?: string; cwd?: string; req?: Partial<RunRequest> }) {
  const s = standIn(o.mode, o.staleFrom);
  const cwd = o.cwd ?? mkdtempSync(join(tmpdir(), 'adv-cwd-'));
  const r = await new CliRunner('cli', o.base ?? { PATH: process.env.PATH, HOME: homedir() }, s.bin, undefined, o.lanes, undefined, {}, o.guardrails).run(request(cwd, o.req));
  await settle();
  return { r, s, cwd };
}

test(`adversarial guards / settings.required (${doc("An agent run starts only with the instance's agent settings")}): a run never starts without complete agent settings`, { skip: !posix && 'POSIX stand-in claude' }, async () => {
  const good = goodSettings();
  const without = (f: (s: Settings) => void) => {
    const s = structuredClone(good);
    f(s);
    const out = JSON.stringify(s);
    assert.notEqual(out, JSON.stringify(good), 'each variant changes the settings');
    return out;
  };
  const ours = (s: Settings, event: string) => s.hooks![event]!.flatMap((e) => e.hooks).find((h) => h.command.includes(`${BRAND.envPrefix}_HOOK=1`))!;
  const files = [
    { what: 'no agent settings file', content: null },
    { what: 'malformed JSON', content: '{ not json' },
    { what: 'a JSON array', content: '[]' },
    { what: 'no PreToolUse guard hook', content: without((s) => delete s.hooks!.PreToolUse) },
    { what: 'no SessionEnd hook', content: without((s) => delete s.hooks!.SessionEnd) },
    { what: 'no SessionStart hook', content: without((s) => delete s.hooks!.SessionStart) },
    { what: "a guard hook whose missing-engine agent branch doesn't exit 2", content: without((s) => (ours(s, 'PreToolUse').command = ours(s, 'PreToolUse').command.replace('>&2; exit 2;', '>&2; exit 0;'))) },
    { what: 'the guard hook twice', content: without((s) => s.hooks!.PreToolUse!.push(structuredClone(s.hooks!.PreToolUse![0]!))) },
    { what: 'a guard hook that does not fail closed', content: without((s) => (ours(s, 'PreToolUse').command = ours(s, 'PreToolUse').command.replaceAll('|| exit 2', '|| true'))) },
    { what: 'a guard hook whose engine is gone', content: without((s) => (ours(s, 'PreToolUse').command = ours(s, 'PreToolUse').command.replace(/E="[^"]+"/, `E="${join(tmpdir(), 'no-engine.js')}"`))) },
    { what: 'disableAllHooks true', content: without((s) => (s.disableAllHooks = true)) },
    { what: 'disableAllHooks not pinned', content: without((s) => delete s.disableAllHooks) },
  ];
  const left = await letThrough(files, async (f) => {
    const cwd = mkdtempSync(join(tmpdir(), 'adv-cwd-'));
    const { r, s } = await agentRun({ guardrails: instanceHome(f.content, cwd).guardrails, cwd });
    return r.reason === 'failed' && /not starting/.test(r.detail) && !s.ran() ? null : `${r.reason}: ${r.detail.slice(0, 200)}${s.ran() ? ' (claude ran)' : ''}`;
  });
  if (!asRoot) {
    const cwd = mkdtempSync(join(tmpdir(), 'adv-cwd-'));
    const i = instanceHome(JSON.stringify(good), cwd);
    chmodSync(agentSettingsPath(i.home), 0o000);
    const { r, s } = await agentRun({ guardrails: i.guardrails, cwd });
    if (!(r.reason === 'failed' && !s.ran())) left.push(`an unreadable file: ${r.reason}`);
  }
  assert.deepEqual(left, [], 'agent settings a run started with anyway');
  const cwd = mkdtempSync(join(tmpdir(), 'adv-cwd-'));
  const { r, s } = await agentRun({ guardrails: instanceHome(JSON.stringify(good), cwd).guardrails, cwd });
  assert.ok(r.reason === 'succeeded' && s.worked(), `control: complete agent settings start the run (${r.reason}: ${r.detail})`);
});

test(`adversarial guards / settings.project-loosen-refused (${doc('A project `.claude/settings.json` that could loosen them refuses the run')}): a checkout's own settings that could loosen the run refuse it`, { skip: !posix && 'POSIX stand-in claude' }, async () => {
  const files = [
    { what: 'an allow rule for any command', content: { permissions: { allow: ['Bash(*)'] } } },
    { what: 'an allow rule for the web', content: { permissions: { allow: ['WebFetch'] } } },
    { what: 'an allow rule next to hooks and denies', content: { hooks: {}, permissions: { deny: ['Read(./x)'], allow: ['Read(**)'] } } },
    { what: "env that unsets the agent's marker", content: { env: { [AGENT]: '0' } } },
    { what: 'bypassPermissions', content: { permissions: { defaultMode: 'bypassPermissions' } } },
    { what: 'additionalDirectories', content: { permissions: { additionalDirectories: ['/'] } } },
    { what: 'the sandbox off', content: { sandbox: { enabled: false } } },
    { what: 'unsandboxed retries on', content: { sandbox: { allowUnsandboxedCommands: true } } },
    { what: 'every hook off', content: { disableAllHooks: true } },
    { what: "every project MCP server on", content: { enableAllProjectMcpServers: true } },
    { what: 'an API key helper', content: { apiKeyHelper: 'cat /dev/null' } },
    { what: 'the check key', content: { outputStyle: 'default' } },
    { what: 'malformed JSON', content: '{ not json' },
    { what: 'a JSON array', content: '[]' },
  ];
  const left = await letThrough(files, async (f) => {
    const cwd = mkdtempSync(join(tmpdir(), 'adv-cwd-'));
    mkdirSync(join(cwd, '.claude'));
    writeFileSync(join(cwd, '.claude', 'settings.json'), typeof f.content === 'string' ? f.content : JSON.stringify(f.content));
    const { r, s } = await agentRun({ guardrails: instanceHome(JSON.stringify(goodSettings()), cwd).guardrails, cwd });
    return r.reason === 'failed' && /could loosen agent runs|can't be read/.test(r.detail) && !s.ran() ? null : `${r.reason}: ${r.detail.slice(0, 200)}${s.ran() ? ' (claude ran)' : ''}`;
  });
  assert.deepEqual(left, [], 'project settings a run started with anyway');
  // Control: hooks and tightening rules are fine; a settings.local.json beside them is never loaded (project only).
  const cwd = mkdtempSync(join(tmpdir(), 'adv-cwd-'));
  mkdirSync(join(cwd, '.claude'));
  writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'true' }] }] }, permissions: { deny: ['Read(./secret)'], ask: ['Bash(rm:*)'] } }));
  writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(*)'], defaultMode: 'bypassPermissions' } }));
  const { r, s } = await agentRun({ guardrails: instanceHome(JSON.stringify(goodSettings()), cwd).guardrails, cwd });
  assert.ok(r.reason === 'succeeded' && s.worked(), `control: hooks and deny rules start the run (${r.reason}: ${r.detail})`);
  const args = s.log().args;
  assert.equal(args[args.indexOf('--setting-sources') + 1], 'project', 'the run loads the project settings source only, never settings.local.json');
});

test(`adversarial guards / settings.applied-echo (${doc("Every run's `--settings` carries a fresh check value")}): a run stops before any work unless claude's first event echoes this run's own check value`, { skip: !posix && 'POSIX stand-in claude' }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'adv-cwd-'));
  const guardrails = instanceHome(JSON.stringify(goodSettings()), cwd).guardrails;
  const first = await agentRun({ guardrails, cwd });
  assert.ok(first.r.reason === 'succeeded' && first.s.worked(), `control: a run whose settings claude applied does its work (${first.r.reason}: ${first.r.detail})`);
  const modes: { what: string; mode: Mode }[] = [
    { what: 'claude dropped the settings (default style)', mode: 'dropped' },
    { what: "another run's check value echoed back", mode: 'stale' },
    { what: 'an init with no style', mode: 'no-style' },
    { what: 'an agent turn before the init', mode: 'assistant-first' },
    { what: 'a tool result before the init', mode: 'tool-result-first' },
    { what: 'a result and no init', mode: 'result-only' },
  ];
  const left = await letThrough(modes, async (m) => {
    const { r, s } = await agentRun({ guardrails, cwd, mode: m.mode, staleFrom: first.s.value });
    return r.reason === 'failed' && !s.worked() ? null : `${r.reason}${s.worked() ? ' (the agent worked)' : ''}: ${r.detail.slice(0, 200)}`;
  });
  assert.deepEqual(left, [], 'runs that went on without their settings confirmed');
  const second = await agentRun({ guardrails, cwd });
  assert.notEqual(readFileSync(second.s.value, 'utf8'), readFileSync(first.s.value, 'utf8'), "each run's check value is its own");
});

/** The lanes an instance with the sandbox on gives the runner (src/instance.ts laneRuns), for a checkout at `cwd`. */
function sandboxLanes(cwd: string) {
  const base = mkdtempSync(join(tmpdir(), 'adv-lanes-'));
  // Every path the lane denies exists, as the kind it is on a real machine (src/sandbox.ts homeCredentialStores; the
  // instance home; claude's login file), so the Read-rule cases can tell a file entry from a directory one. The home
  // is this test process's own (test/isolate.ts).
  for (const d of ['.ssh', '.aws', '.config/gh', '.gnupg', '.docker']) mkdirSync(join(homedir(), d), { recursive: true });
  for (const f of ['.netrc', '.npmrc', '.pypirc', '.docker/config.json']) if (!existsSync(join(homedir(), f))) writeFileSync(join(homedir(), f), '');
  mkdirSync(join(base, 'inst-home'));
  mkdirSync(join(base, 'agent-claude'));
  writeFileSync(join(base, 'agent-claude', '.credentials.json'), '{}');
  const inst = {
    name: 'adversarial',
    runAs: null,
    evalAs: null,
    home: join(base, 'inst-home'),
    stateDir: join(base, 'state'),
    repo: { path: cwd, repo: 'example/adversarial' },
    policy: PolicyFile.parse({ version: 1, budget: { daily_usd: 20 }, agents: { max_workers: 2 }, land_mode: 'pr', sandbox: true }),
    credentials: { claude: { config_dir: join(base, 'agent-claude') } },
  } as unknown as Instance;
  return laneRuns(inst);
}

interface SandboxSettings {
  sandbox?: { enabled?: unknown; failIfUnavailable?: unknown; allowUnsandboxedCommands?: unknown; filesystem?: { denyRead?: string[] } };
  permissions?: { deny?: string[] };
  hooks?: Record<string, { hooks: { type: string; command: string; onFailure?: string }[] }[]>;
}
/** The --settings of a sandboxed run as claude got them: a plain run, and one with an "allow once" host. */
let sandboxRuns: Promise<{ what: string; settings: SandboxSettings }[]> | null = null;
const sandboxed = () =>
  (sandboxRuns ??= (async () => {
    const out: { what: string; settings: SandboxSettings }[] = [];
    const variants: [string, Partial<RunRequest>][] = [['a run', {}], ['a run with an allow-once host', { allowOnce: ['example.org'] }]];
    for (const [what, req] of variants) {
      const cwd = mkdtempSync(join(tmpdir(), 'adv-cwd-'));
      const { r, s } = await agentRun({ guardrails: goodSettings, lanes: sandboxLanes(cwd), cwd, req });
      assert.ok(r.reason === 'succeeded' && s.ran(), `${what}: ${r.reason}: ${r.detail}`);
      out.push({ what, settings: s.log().settings as SandboxSettings });
    }
    return out;
  })());

test(`adversarial guards / sandbox.fail-closed (${doc("If the sandbox can't start, the run exits instead of running unsandboxed")}): every sandboxed run's settings say no sandbox, no run`, { skip: !posix && 'POSIX stand-in claude' }, async () => {
  for (const { what, settings } of await sandboxed()) {
    assert.equal(settings.sandbox?.enabled, true, `${what}: the sandbox is on`);
    assert.equal(settings.sandbox?.failIfUnavailable, true, `${what}: a sandbox that can't start ends the run`);
  }
});

test(`adversarial guards / sandbox.no-unsandboxed-retry (${doc("A blocked command can't be retried outside the sandbox")}): every sandboxed run's settings refuse a retry outside it`, { skip: !posix && 'POSIX stand-in claude' }, async () => {
  for (const { what, settings } of await sandboxed()) assert.equal(settings.sandbox?.allowUnsandboxedCommands, false, `${what}: no unsandboxed retry`);
});

const isGlob = (p: string) => /[*?[{]/.test(p);
const unrooted = (p: string) => p.replace(/^\/+/, '');
/**
 * Whether the sandbox's denyRead hides `target` from commands, as sandbox-runtime reads an entry: a path hides itself
 * and everything under it, a trailing `/**` is that directory, and any other glob matches by its pattern.
 */
const sandboxHides = (entries: string[], target: string) =>
  entries.some((e) => {
    const p = e.replace(/\/\*\*$/, '');
    return isGlob(p) ? globToRegExp(unrooted(p)).test(unrooted(target)) : target === p || target.startsWith(`${p}/`);
  });
/** The paths a run's Read rules name (Claude Code's `Read(//<absolute path>)` form), each as an absolute path or glob. */
const readRulePaths = (deny: string[] | undefined) => (deny ?? []).flatMap((x) => /^Read\((\/\/.*)\)$/.exec(x)?.[1]?.slice(1) ?? []);
/** Whether a Read rule denies `target`, read as the gitignore-style pattern it is: `p/**` is what's under p, never p itself. */
const readRuleDenies = (rules: string[], target: string) => rules.some((r) => (isGlob(r) ? globToRegExp(unrooted(r)).test(unrooted(target)) : target === r));
/** Each denyRead entry, as a file or a directory on this machine (the fixture made every one), or `missing`. */
const entryKinds = (entries: string[]) => entries.filter((e) => !isGlob(e)).map((e) => ({ entry: e.replace(/\/\*\*$/, ''), kind: !existsSync(e.replace(/\/\*\*$/, '')) ? 'missing' : statSync(e.replace(/\/\*\*$/, '')).isDirectory() ? 'dir' : 'file' }));

test(`adversarial guards / sandbox.read-tool-same-deny (${doc('The Read tool is denied the same paths as the commands')}): everything under each directory the sandbox hides from commands is denied to the Read tool`, { skip: !posix && 'POSIX stand-in claude' }, async () => {
  for (const { what, settings } of await sandboxed()) {
    const kinds = entryKinds(settings.sandbox?.filesystem?.denyRead ?? []);
    assert.deepEqual(kinds.filter((k) => k.kind === 'missing').map((k) => k.entry), [], `${what}: the fixture made every denied path, so each is a file or a directory`);
    const dirs = kinds.filter((k) => k.kind === 'dir');
    assert.ok(dirs.length > 0, `${what}: the sandbox hides a directory`);
    const rules = readRulePaths(settings.permissions?.deny);
    assert.deepEqual(dirs.filter((k) => !readRuleDenies(rules, `${k.entry}/a-file`)).map((k) => k.entry), [], `${what}: directories hidden from commands whose files the Read tool may read`);
  }
});

knownHole(`adversarial guards / sandbox.read-tool-same-deny (${doc('The Read tool is denied the same paths as the commands')}): Read rules for file entries`, "the owner's private issue", { skip: !posix && 'POSIX stand-in claude' }, async () => {
  const attacks: string[] = [];
  const open: string[] = [];
  for (const { what, settings } of await sandboxed()) {
    const files = entryKinds(settings.sandbox?.filesystem?.denyRead ?? []).filter((k) => k.kind === 'file');
    assert.ok(files.length > 0, `${what}: the sandbox hides a file`);
    const rules = readRulePaths(settings.permissions?.deny);
    files.forEach((f, i) => {
      const name = `${what}: file entry ${i + 1} of ${files.length}`;
      attacks.push(name);
      if (!readRuleDenies(rules, f.entry)) open.push(name);
    });
  }
  return { attacks, open };
});

knownHole(`adversarial guards / tool.no-read-secrets (${doc('- read secret files;')}): a task's hidden paths and the project's secret files are denied by the sandbox and the Read rules too, not only by the hook`, 'PR #893 (#890)', { skip: !posix && 'POSIX stand-in claude' }, async () => {
  const { dir } = exampleProject();
  writeFileSync(join(dir, '.env'), 'TOKEN=stand-in\n');
  mkdirSync(join(dir, 'evals-secret'));
  writeFileSync(join(dir, 'evals-secret', 'score.py'), 'EXPECTED = 42\n');
  const taskFile = join(mkdtempSync(join(tmpdir(), 'adv-tasks-')), 'exp.json');
  writeFileSync(taskFile, JSON.stringify({ id: 'exp', done_when: [{ manual: 'x' }], frozen: [], hidden: ['evals-secret/**'] }));
  const { r, s } = await agentRun({ guardrails: goodSettings, lanes: sandboxLanes(dir), cwd: dir, req: { taskFile } });
  assert.ok(s.ran(), `${r.reason}: ${r.detail}`);
  const settings = s.log().settings as SandboxSettings;
  const denyRead = settings.sandbox?.filesystem?.denyRead ?? [];
  const readRules = readRulePaths(settings.permissions?.deny);
  const checks = [['the hidden file', join(dir, 'evals-secret', 'score.py')], ['.env', join(dir, '.env')]].flatMap(([what, target]) => [
    { what: `a command reads ${what} (the sandbox doesn't hide it)`, open: !sandboxHides(denyRead, target!) },
    { what: `the Read tool reads ${what} (no Read rule denies it)`, open: !readRuleDenies(readRules, target!) },
  ]);
  return { attacks: checks.map((c) => c.what), open: checks.filter((c) => c.open).map((c) => c.what) };
});

test(`adversarial guards / tool.unreadable-task-file-denies (${doc("A task file the guard can't read denies the call")}): a guard hook that fails rather than answers (a timeout, a crash) blocks the call`, { skip: !posix && 'POSIX stand-in claude' }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'adv-cwd-'));
  const { r, s } = await agentRun({ guardrails: instanceHome(JSON.stringify(goodSettings()), cwd).guardrails, cwd });
  assert.ok(s.ran(), `${r.reason}: ${r.detail}`);
  const pre = ((s.log().settings as SandboxSettings).hooks?.PreToolUse ?? []).flatMap((e) => e.hooks).filter((h) => h.type === 'command');
  assert.ok(pre.length > 0, 'the run carries a guard hook');
  assert.deepEqual(pre.filter((h) => h.onFailure !== 'block').map((h) => h.command.slice(0, 80)), [], 'guard hooks a failure lets the call through');
});

test(`adversarial guards / pushgate.no-hatch-in-env (${doc('No agent starts with the hatch in its environment')}): the hatch reaches no agent run, from the coordinator's environment or a project's`, { skip: !posix && 'POSIX stand-in claude' }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'adv-cwd-'));
  const base = { PATH: process.env.PATH, HOME: homedir(), [HATCH]: '1', [HATCH.toLowerCase()]: '1', Push_Gate_Bootstrap: '1' };
  const { r, s } = await agentRun({ guardrails: instanceHome(JSON.stringify(goodSettings()), cwd).guardrails, cwd, base, req: { env: { [HATCH]: '1' } } });
  assert.ok(r.reason === 'succeeded' && s.ran(), `control: the run started (${r.reason}: ${r.detail})`);
  const log = s.log();
  assert.deepEqual(log.env.filter((k) => k.toUpperCase() === HATCH), [], "the hatch in the agent's environment");
  assert.deepEqual(Object.keys((log.settings?.env ?? {}) as object).filter((k) => k.toUpperCase() === HATCH), [], "the hatch in the run's pinned settings env");
});

// ---- The push guard: checkedPush and the pre-push hook, against a scratch bare remote. ----

const run = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A checkout with one commit on `branch` (its default), pushed to a bare remote (`base`); `put` and `commit` add to it. */
function pushRepo(branch = 'main') {
  const root = mkdtempSync(join(tmpdir(), 'adv-push-'));
  const dir = join(root, 'work');
  const remote = join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', branch, remote]);
  mkdirSync(dir);
  run(dir, 'init', '-q', '-b', branch);
  for (const [k, v] of [['user.email', 'ada@example.com'], ['user.name', 'Ada'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) run(dir, 'config', k!, v!);
  const put = (p: string, text: string) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  };
  const commit = (msg = 'change') => {
    run(dir, 'add', '-A');
    run(dir, 'commit', '-q', '--allow-empty', '-m', msg);
    return run(dir, 'rev-parse', 'HEAD');
  };
  put('README.md', 'A project.\n');
  const base = commit('base');
  run(dir, 'remote', 'add', 'origin', remote);
  run(dir, 'push', '-q', 'origin', branch);
  const at = (ref: string) => spawnSync('git', ['rev-parse', '--verify', '-q', ref], { cwd: remote, encoding: 'utf8' }).stdout.trim() || null;
  return { root, dir, remote, base, put, commit, at };
}

const guardOf = (blocked: string[], defaultBranch = 'main') => ({ defaultBranch, blocked: (ref: string) => blocked.push(ref) });

test(`adversarial guards / push.default-branch-refused (${doc('It refuses the default branch however the ref is spelled')}): checkedPush never pushes the default branch, however the ref is spelled`, async () => {
  // A default branch that isn't `main`, so a refusal that only knows `main` fails here.
  const D = 'trunk';
  const r = pushRepo(D);
  r.put('a.txt', 'a\n');
  const head = r.commit();
  const limits: PushLimits = { max_file_mb: 10, max_changed_lines: 1500, refuse_paths: [] };
  const refs = [
    { what: 'its name', ref: D },
    { what: 'its full ref', ref: `refs/heads/${D}` },
    { what: 'heads/', ref: `heads/${D}` },
    { what: 'a forced name', ref: `+${D}` },
    { what: 'a forced full ref', ref: `+refs/heads/${D}` },
    { what: 'a refspec with a source', ref: `HEAD:${D}` },
    { what: 'a refspec with a full destination', ref: `task:refs/heads/${D}` },
    { what: 'a forced refspec', ref: `+HEAD:refs/heads/${D}` },
  ];
  const left = await letThrough(refs, (x) => {
    const blocked: string[] = [];
    const out = [checkedPush({ cwd: r.dir, remote: 'origin', base: r.base, head, ref: x.ref, limits, guard: guardOf(blocked, D) }), checkedPush({ cwd: r.dir, remote: 'origin', base: r.base, head, ref: x.ref, limits, guard: guardOf(blocked, D), force: true, expect: r.base })];
    const refused = out.every((o) => !o.ok && 'refused' in o && /default branch/.test(o.refused.join(' ')));
    return refused && blocked.length === 2 && blocked.every((b) => b === `refs/heads/${D}`) && r.at(`refs/heads/${D}`) === r.base ? null : JSON.stringify({ out, blocked, default: r.at(`refs/heads/${D}`) });
  });
  assert.deepEqual(left, [], 'default-branch pushes checkedPush let through');
  for (const ref of ['refs/heads/task-1', 'refs/heads/main']) {
    assert.deepEqual(checkedPush({ cwd: r.dir, remote: 'origin', base: r.base, head, ref, limits, guard: guardOf([], D) }), { ok: true }, `control: ${ref} (not the default branch) is pushed`);
    assert.equal(r.at(ref), head);
  }
});

const limits: PushLimits = { max_file_mb: 0.01, max_changed_lines: 20, refuse_paths: ['secrets/**'] };
const lines = (n: number, tag = 'l') => Array.from({ length: n }, (_, i) => `${tag}${i}`).join('\n') + '\n';
/** One line of `bytes` characters: over max_file_mb (0.01 MB) at 20,000, and one changed line only. */
const bigLine = (bytes = 20_000) => `${'x'.repeat(bytes)}\n`;

test(`adversarial guards / push.size-limit (${doc('refuses a change over the push limits')}): checkedPush refuses a change over the limits, wherever in the range it hides`, async () => {
  const changes: { what: string; make: (r: ReturnType<typeof pushRepo>) => void }[] = [
    { what: 'over the line limit', make: (r) => (r.put('a.txt', lines(21)), r.commit()) },
    { what: 'over the line limit across commits', make: (r) => [1, 2, 3].forEach((n) => (r.put(`a${n}.txt`, lines(8)), r.commit())) },
    { what: 'a file over the size limit', make: (r) => (r.put('big.txt', bigLine()), r.commit()) },
    { what: 'a big file added, then deleted again', make: (r) => (r.put('big.txt', bigLine()), r.commit(), unlinkSync(join(r.dir, 'big.txt')), r.commit()) },
    { what: 'a big file marked binary', make: (r) => (r.put('.gitattributes', '*.dat binary\n'), r.put('big.dat', bigLine()), r.commit()) },
    { what: 'a refused path', make: (r) => (r.put('secrets/key.pem', 'stand-in\n'), r.commit()) },
    { what: 'a refused path added, then deleted again', make: (r) => (r.put('secrets/key.pem', 'stand-in\n'), r.commit(), unlinkSync(join(r.dir, 'secrets', 'key.pem')), r.commit()) },
    { what: 'a refused path under a -diff attribute', make: (r) => (r.put('.gitattributes', '*.pem -diff\n'), r.put('secrets/key.pem', 'stand-in\n'), r.commit()) },
    { what: 'a refused path renamed away', make: (r) => (r.put('secrets/key.pem', 'stand-in\n'), r.commit(), run(r.dir, 'mv', 'secrets/key.pem', 'key.pem'), r.commit()) },
    { what: 'a CI workflow', make: (r) => (r.put('.github/workflows/x.yml', 'on: push\n'), r.commit()) },
  ];
  const left = await letThrough(changes, (c) => {
    const r = pushRepo();
    c.make(r);
    const head = run(r.dir, 'rev-parse', 'HEAD');
    const out = checkedPush({ cwd: r.dir, remote: 'origin', base: r.base, head, ref: 'refs/heads/task-1', limits, guard: guardOf([]) });
    return !out.ok && 'refused' in out && out.refused.length > 0 && r.at('refs/heads/task-1') === null ? null : JSON.stringify(out);
  });
  assert.deepEqual(left, [], 'changes over the limits checkedPush pushed');
  const r = pushRepo();
  r.put('a.txt', lines(20));
  const head = r.commit();
  assert.deepEqual(checkedPush({ cwd: r.dir, remote: 'origin', base: r.base, head, ref: 'refs/heads/task-1', limits, guard: guardOf([]) }), { ok: true }, 'control: a change at the limits is pushed');
});

knownHole(`adversarial guards / push.size-limit (${doc('refuses a change over the push limits')}): a replace ref of the pushed commit hides nothing from checkedPush`, 'PR #927 (#807), or PR #928 (#724) if it lands first (it closes this too)', {}, () => {
  const attacks = ['a refused path', 'a file over the size limit'];
  const left: string[] = [];
  for (const [what, file, text] of [[attacks[0]!, 'secrets/key.pem', 'stand-in\n'], [attacks[1]!, 'big.txt', bigLine()]] as const) {
    const r = pushRepo();
    const benign = run(r.dir, 'commit-tree', `${r.base}^{tree}`, '-p', r.base, '-m', 'benign');
    r.put(file, text);
    const head = r.commit();
    run(r.dir, 'replace', head, benign);
    const out = checkedPush({ cwd: r.dir, remote: 'origin', base: r.base, head, ref: 'refs/heads/task-1', limits, guard: guardOf([]) });
    if (out.ok || r.at('refs/heads/task-1') !== null) left.push(what);
  }
  return { attacks, open: left };
});

knownHole(`adversarial guards / push.size-limit (${doc('refuses a change over the push limits')}): a refused path with a non-ASCII name is refused`, 'PR #928 (#724)', {}, () => {
  const r = pushRepo();
  r.put('secrets/kéy.pem', 'stand-in\n');
  const head = r.commit();
  const out = checkedPush({ cwd: r.dir, remote: 'origin', base: r.base, head, ref: 'refs/heads/task-1', limits, guard: guardOf([]) });
  const what = 'a refused path with a non-ASCII name';
  return { attacks: [what], open: out.ok || r.at('refs/heads/task-1') !== null ? [what] : [] };
});

test(`adversarial guards / push.prepush-hook (${doc('Each checkout also gets a pre-push hook that refuses the default branch')}): git itself refuses a push to the default branch from the checkout, however it is spelled`, { skip: !posix && 'POSIX hook' }, async () => {
  // The configured default branch isn't `main`, so a hook that only knows `main` fails here.
  const B = 'release';
  const setup = () => {
    const r = pushRepo(B);
    // The remote's own default (origin/HEAD) is refused too, whatever the hook was told.
    run(r.dir, 'push', '-q', 'origin', `${B}:refs/heads/trunk`);
    run(r.dir, 'remote', 'set-head', 'origin', 'trunk');
    installPrePushHook(join(r.dir, '.git', 'hooks'), { branches: [B] });
    r.put('a.txt', 'a\n');
    r.commit();
    return r;
  };
  const pushes = [
    { what: 'HEAD to its name', args: ['origin', `HEAD:${B}`] },
    { what: 'HEAD to its full ref', args: ['origin', `HEAD:refs/heads/${B}`] },
    { what: 'a forced refspec', args: ['origin', `+HEAD:${B}`] },
    { what: '--force', args: ['--force', 'origin', `HEAD:${B}`] },
    { what: 'the local branch of that name', args: ['origin', B] },
    { what: 'beside a task branch', args: ['origin', 'HEAD:refs/heads/task-1', `HEAD:refs/heads/${B}`] },
    { what: "the remote's own default branch", args: ['origin', 'HEAD:trunk'] },
  ];
  const left = await letThrough(pushes, (p) => {
    const r = setup();
    const out = spawnSync('git', ['push', '-q', ...p.args], { cwd: r.dir, encoding: 'utf8' });
    const untouched = r.at(`refs/heads/${B}`) === r.base && r.at('refs/heads/trunk') === r.base && r.at('refs/heads/task-1') === null;
    return out.status !== 0 && /refusing to push/.test(out.stderr) && untouched ? null : `exit ${out.status}: ${out.stderr.trim().slice(0, 200)}`;
  });
  assert.deepEqual(left, [], 'default-branch pushes the hook let through');
  for (const ref of ['refs/heads/task-1', 'refs/heads/main']) {
    const r = setup();
    assert.equal(spawnSync('git', ['push', '-q', 'origin', `HEAD:${ref}`], { cwd: r.dir, encoding: 'utf8' }).status, 0, `control: ${ref} (not a default branch) goes through the hook`);
  }
});

// ---- The push gate (scripts/push-gate.mjs), as a checkout's pre-push hook. ----

const gate = fileURLToPath(new URL('../../../scripts/push-gate.mjs', import.meta.url));
const gitleaks = which('gitleaks');
/** Without gitleaks the gate refuses every push, so its cases can't run; CI installs it, and there they must. */
const needsGitleaks = !posix ? 'POSIX hook' : !gitleaks && !process.env.CI ? 'gitleaks not installed (CI installs it and runs these)' : false;
/** A made-up project term: the gate's denylist holds only its hash, as the repo's holds the real ones'. */
const TERM = ['zorblax', 'quantoria'].join('');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** A checkout with this repo's denylist patterns plus the made-up term's hash, and the gate as its pre-push hook. */
function gateRepo() {
  const r = pushRepo();
  const real = JSON.parse(readFileSync(join(repoRoot, '.denylist.json'), 'utf8')) as { patterns: string[] };
  writeFileSync(join(r.dir, '.denylist.json'), JSON.stringify({ hashed: [sha256(TERM)], patterns: real.patterns }));
  r.commit('denylist');
  run(r.dir, 'push', '-q', 'origin', 'main');
  r.put('.githooks/pre-push', `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(gate)} "$@"\n`);
  chmodSync(join(r.dir, '.githooks', 'pre-push'), 0o755);
  run(r.dir, 'config', 'core.hooksPath', '.githooks');
  const push = (env: NodeJS.ProcessEnv = process.env) => spawnSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/feature'], { cwd: r.dir, encoding: 'utf8', env });
  // The hook file itself stays out of the commits.
  writeFileSync(join(r.dir, '.git', 'info', 'exclude'), '.githooks/\n');
  return { ...r, push };
}
const refusedPush = (r: ReturnType<typeof gateRepo>, out: { status: number | null; stderr: unknown }) =>
  out.status !== 0 && /push gate: REFUSED/.test(String(out.stderr)) && r.at('refs/heads/feature') === null ? null : `exit ${out.status}: ${String(out.stderr).trim().slice(-300)}`;

test(`adversarial guards / pushgate.secret-scan (${doc('A push gate scans what is pushed for secrets and project-specific terms')}): a secret or a project term anywhere in what is pushed refuses the push`, { skip: needsGitleaks }, async () => {
  const changes: { what: string; make: (r: ReturnType<typeof gateRepo>) => void }[] = [
    { what: 'a token in an added file', make: (r) => (r.put('notes.md', `token: ${ghToken()}\n`), r.commit()) },
    { what: 'a token in a file added, then deleted again', make: (r) => (r.put('notes.md', `token: ${ghToken()}\n`), r.commit(), unlinkSync(join(r.dir, 'notes.md')), r.commit()) },
    { what: 'a token in the first of two commits', make: (r) => (r.put('a.md', `token: ${ghToken()}\n`), r.commit(), r.put('b.md', 'fine\n'), r.commit()) },
    { what: 'a project term in a file', make: (r) => (r.put('notes.md', `deployed by ${TERM}\n`), r.commit()) },
    { what: 'a project term in the commit message', make: (r) => (r.put('ok.md', 'fine\n'), r.commit(`fix the ${TERM} deploy`)) },
    { what: 'a project term in a file under a -diff attribute, deleted again', make: (r) => (r.put('.gitattributes', '*.txt -diff\n'), r.put('n.txt', `by ${TERM}\n`), r.commit(), unlinkSync(join(r.dir, 'n.txt')), r.commit()) },
  ];
  assert.deepEqual(
    await letThrough(changes, (c) => {
      const r = gateRepo();
      c.make(r);
      return refusedPush(r, r.push());
    }),
    [],
    'pushes the gate let through',
  );
  const r = gateRepo();
  r.put('ok.md', 'fine\n');
  r.commit();
  const out = r.push();
  assert.equal(out.status, 0, `control: a clean change is pushed: ${out.stderr}`);
});

test(`adversarial guards / pushgate.no-scanner-no-push (${doc('With no scanner, nothing is pushed')}): a missing or broken scanner refuses even a clean push`, { skip: needsGitleaks }, async () => {
  const gitBin = which('git');
  assert.ok(gitBin, 'git on PATH');
  /** A PATH holding git and, per `scanner`, a gitleaks that is missing, fails, is killed or can't be run. */
  const pathWith = (scanner: string | null, mode = 0o755) => {
    const bin = mkdtempSync(join(tmpdir(), 'adv-bin-'));
    symlinkSync(gitBin!, join(bin, 'git'));
    if (scanner !== null) {
      writeFileSync(join(bin, 'gitleaks'), scanner);
      chmodSync(join(bin, 'gitleaks'), mode);
    }
    return bin;
  };
  const scanners = [
    { what: 'no gitleaks', path: () => pathWith(null) },
    { what: 'a gitleaks that fails', path: () => pathWith('#!/bin/sh\nexit 2\n') },
    { what: 'a gitleaks that is killed', path: () => pathWith('#!/bin/sh\nkill -9 $$\n') },
    { what: "a gitleaks that can't be run", path: () => pathWith('#!/bin/sh\nexit 0\n', 0o644) },
  ];
  assert.deepEqual(
    await letThrough(scanners, (s) => {
      const r = gateRepo();
      r.put('ok.md', 'fine\n');
      r.commit();
      return refusedPush(r, r.push({ ...process.env, PATH: s.path() }));
    }),
    [],
    'pushes made without a working scanner',
  );
});

test(`adversarial guards / pushgate.no-hatch-skip-swap (${doc("An agent can't set the gate's first-time-setup hatch, skip the pre-push hook or swap it")}): no agent sets the hatch, skips the hook or points git at another`, { skip: !posix && 'POSIX shells' }, async () => {
  const g = guardProject();
  const attacks: ToolAttack[] = [
    bash('the hatch before a push', `${HATCH}=1 git push origin HEAD`),
    bash('the hatch exported', `export ${HATCH}=1`),
    bash('the hatch in lower case', `export ${HATCH.toLowerCase()}=1`),
    bash('the hatch through env', `env ${HATCH}=1 git push origin HEAD`),
    bash('the hatch stored in a shell rc', `echo export ${HATCH}=1 >> ~/.bashrc`),
    bash('the hatch in a nested shell', `bash -c "${HATCH}=1 git push origin HEAD"`),
    { what: 'Write the hatch into a shell rc', tool: 'Write', input: { file_path: join(homedir(), '.bashrc'), content: `export ${HATCH}=1` } },
    { what: 'Edit the hatch into .envrc', tool: 'Edit', input: { file_path: join(g.dir, '.envrc'), old_string: 'a', new_string: `export ${HATCH}=1` } },
    bash('push --no-verify', 'git push --no-verify origin HEAD'),
    bash('push --no-verify after the refspec', 'git push origin HEAD --no-verify'),
    bash('push --no-verify with -C', 'git -C . push --no-verify origin HEAD'),
    bash('-c core.hooksPath', 'git -c core.hooksPath=/dev/null push origin HEAD'),
    bash('-c core.hookspath in another case', 'git -c core.hookspath=/dev/null push origin HEAD'),
    bash('git config core.hooksPath', 'git config core.hooksPath /dev/null'),
    bash('git config --local core.hooksPath', 'git config --local core.hooksPath /dev/null'),
    bash('core.hooksPath from the environment', 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git push origin HEAD'),
    bash('a global config of its own for a push', 'GIT_CONFIG_GLOBAL=/dev/null git push origin HEAD'),
    bash('a redirect over the hook', 'echo exit 0 > .git/hooks/pre-push'),
    bash('cp over the hook', 'cp /dev/null .git/hooks/pre-push'),
    bash('rm the hook', 'rm .git/hooks/pre-push'),
    bash('a redirect into the git config', 'echo x >> .git/config'),
    { what: 'Write the hook', tool: 'Write', input: { file_path: join(g.dir, '.git', 'hooks', 'pre-push'), content: 'exit 0' } },
    { what: 'Edit the git config', tool: 'Edit', input: { file_path: join(g.dir, '.git', 'config'), old_string: 'a', new_string: 'b' } },
  ];
  assert.deepEqual(await letThrough(attacks, refusedBy(g, /push-gate-hatch|push-hook-bypass/)), [], 'hatch, skip or swap the guard let through');
  for (const command of [`grep -r ${HATCH} scripts`, 'git push origin HEAD']) assert.notEqual((await g.call('Bash', { command })).decision, 'deny', `control: ${command}`);
});

// ---- The commit scan. ----

test(`adversarial guards / commit.scan-before (${doc('Agent commits are scanned before they happen')}): an agent's commit that would record a secret is refused before it happens`, { skip: needsGitleaks }, async () => {
  const g = guardProject();
  // A tracked file, changed but not staged (for commit -a), and a new file staged.
  writeFileSync(join(g.dir, 'notes.md'), 'notes\n');
  run(g.dir, 'add', 'notes.md');
  run(g.dir, 'commit', '-q', '-m', 'notes');
  writeFileSync(join(g.dir, 'notes.md'), `token: ${ghToken()}\n`);
  const staged = () => {
    writeFileSync(join(g.dir, 'config.txt'), `token: ${ghToken()}\n`);
    run(g.dir, 'add', 'config.txt');
  };
  const unstagedOnly = () => spawnSync('git', ['reset', '-q', 'config.txt'], { cwd: g.dir });
  const commits = [
    { what: 'git commit', command: 'git commit -m x', stage: true },
    { what: 'git commit -q', command: 'git commit -qm x', stage: true },
    { what: 'git -C', command: `git -C ${g.dir} commit -m x`, stage: true },
    { what: 'git -c', command: 'git -c core.quotepath=off commit -m x', stage: true },
    { what: 'commit --no-verify', command: 'git commit --no-verify -m x', stage: true },
    { what: 'in a nested shell', command: 'bash -c "git commit -m x"', stage: true },
    { what: 'after &&', command: 'true && git commit -m x', stage: true },
    { what: 'through env', command: 'env git commit -m x', stage: true },
    { what: 'commit -a with the secret unstaged', command: 'git commit -am x', stage: false },
    { what: 'commit -a -m with the secret unstaged', command: 'git commit -a -m x', stage: false },
    { what: 'commit --all with the secret unstaged', command: 'git commit --all -m x', stage: false },
  ];
  assert.deepEqual(
    await letThrough(commits, async (c) => {
      if (c.stage) staged();
      else unstagedOnly();
      const v = await g.call('Bash', { command: c.command }, { task: null });
      return v.decision === 'deny' && /gitleaks found a secret/.test(v.reason) ? null : `${v.decision} ${v.reason}`.trim();
    }),
    [],
    'commits carrying a secret the guard let through',
  );
  // Control: a clean staged change commits.
  unstagedOnly();
  run(g.dir, 'checkout', '--', 'notes.md');
  writeFileSync(join(g.dir, 'config.txt'), 'fine\n');
  run(g.dir, 'add', 'config.txt');
  assert.equal((await g.call('Bash', { command: 'git commit -m x' }, { task: null })).decision, 'none', 'control: a clean commit is not refused');
});

test(`adversarial guards / commit.scanner-unavailable-not-clean (${doc("A scanner that can't run is reported as unavailable, never as clean")}): a scanner that is missing, fails, is killed or can't be run is never clean`, { skip: !posix && 'POSIX scanner stand-ins' }, async () => {
  const r = pushRepo();
  r.put('a.txt', 'a\n');
  r.commit();
  r.put('b.txt', 'b\n');
  run(r.dir, 'add', 'b.txt');
  const bin = (name: string, text: string, mode = 0o755) => {
    const p = join(mkdtempSync(join(tmpdir(), 'adv-scanner-')), name);
    writeFileSync(p, text);
    chmodSync(p, mode);
    return p;
  };
  const scanners = [
    { what: 'missing', path: join(tmpdir(), 'no-such-gitleaks') },
    { what: 'exits 1', path: bin('gitleaks', '#!/bin/sh\nexit 1\n') },
    { what: 'exits 2', path: bin('gitleaks', '#!/bin/sh\nexit 2\n') },
    { what: 'killed', path: bin('gitleaks', '#!/bin/sh\nkill -9 $$\n') },
    { what: "can't be run", path: bin('gitleaks', '#!/bin/sh\nexit 0\n', 0o644) },
    { what: 'a directory', path: mkdtempSync(join(tmpdir(), 'adv-scanner-dir-')) },
  ];
  const left = await letThrough(scanners, async (s) => {
    const results = { commit: scanCommit(r.dir, false, s.path), commitAll: scanCommit(r.dir, true, s.path), path: scanPath(join(r.dir, 'a.txt'), s.path), range: await scanRange(r.dir, `${r.base}..HEAD`, s.path) };
    const bad = Object.entries(results).filter(([, v]) => v.status !== 'unavailable');
    return bad.length ? JSON.stringify(Object.fromEntries(bad)) : null;
  });
  assert.deepEqual(left, [], 'broken scanners reported as something other than unavailable');
});

// ---- Redaction: what the event log and the run record store. ----

/** Every credential shape the redactor knows, as a fake value (`secret`) inside the text that carries it. */
function corpus(): { what: string; text: string; secret: string }[] {
  const one = (what: string, secret: string, text = `found ${secret} in the output`) => ({ what, text, secret });
  const keyBody = alnum(64);
  const password = alnum(20);
  const jsonValue = alnum(24);
  const bearer = alnum(32);
  return [
    one('a GitHub token', ghToken()),
    one('a fine-grained GitHub token', ['github', '_pat_', alnum(22), '_', alnum(59)].join('')),
    one('an API key (sk-ant-)', ['sk', '-ant-', alnum(40)].join('')),
    one('a Stripe live key', ['sk', 'live', alnum(24)].join('_')),
    one('a Google API key', ['AI', 'za', alnum(35)].join('')),
    one('a JWT', ['ey', 'J', alnum(20), '.', 'ey', 'J', alnum(20), '.', alnum(30)].join('')),
    one('an AWS access key', ['AK', 'IA', upperDigits(16)].join('')),
    one('a Slack bot token', ['xo', 'xb-', alnum(12), '-', alnum(24)].join('')),
    one('a Slack rotation token', ['xo', 'xe-1-', alnum(30)].join('')),
    one('a Slack app token', ['xa', 'pp-1-', alnum(30)].join('')),
    one('a Linear key', ['lin', '_api_', alnum(40)].join('')),
    one('a Slack webhook', ['https://hooks.', 'slack.com/services/', alnum(9), '/', alnum(9), '/', alnum(24)].join('')),
    { what: 'a private key', text: ['-----BEGIN ', 'RSA PRIVATE', ' KEY-----\n', keyBody, '\n-----END ', 'RSA PRIVATE', ' KEY-----'].join(''), secret: keyBody },
    one('a bearer token', bearer, `Authorization: Bearer ${bearer}`),
    { what: 'a password in a URL', text: `connect postgres://app:${password}@db.example.com/app`, secret: password },
    one('a 32-byte hex key', `0x${hex(64)}`),
    { what: 'a value under a credential key', text: JSON.stringify({ id: 3, api_key: jsonValue }), secret: jsonValue },
  ];
}

/** What each store kept of `text`: the event log's stored payload (written at once, and held then flushed), and the run record's file. */
function stored(text: string): { where: string; raw: string }[] {
  const log = new EventLog(':memory:');
  let events: string;
  try {
    log.append('issue.seen', { issue: 7, title: text, labels: [text], author: 'ada', owner: null, actionable: true, why: text }, 'adversarial');
    events = (log.db.prepare('SELECT payload FROM events').all() as { payload: string }[]).map((x) => x.payload).join('\n');
  } finally {
    log.close();
  }
  // The buffered path: while the storage refuses writes (a full disk, stood in for at the log's own insert), events
  // wait in memory (hold) and are written later (flush). Two appends: the one that fails, and one held behind it.
  const buffered = new EventLog(':memory:', { buffer: {} });
  let held: string;
  try {
    const own = buffered as unknown as { insert?: unknown };
    own.insert = () => {
      throw Object.assign(new Error('No space left on device'), { code: 'ENOSPC' });
    };
    for (let i = 0; i < 2; i++) buffered.append('issue.seen', { issue: 7, title: text, labels: [text], author: 'ada', owner: null, actionable: true, why: text }, 'adversarial');
    delete own.insert;
    assert.equal(buffered.flush().written, 2, 'the held events were written once the storage took them');
    held = (buffered.db.prepare('SELECT payload FROM events').all() as { payload: string }[]).map((x) => x.payload).join('\n');
  } finally {
    buffered.close();
  }
  const stateDir = mkdtempSync(join(tmpdir(), 'adv-state-'));
  const rec = new RunRecorder(stateDir, { role: 'worker', model: 'm', cwd: stateDir });
  rec.line({ type: 'assistant', message: { content: [{ type: 'text', text }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: `echo ${text}` } }] } });
  rec.line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: text }] } });
  const file = rec.finish({ reason: 'failed', costUsd: 0, turns: 1, model: 'm', final: text, detail: text });
  return [
    { where: 'the event log', raw: events },
    { where: 'the event log, held while its storage was full', raw: held },
    { where: 'the run record', raw: file ? readFileSync(file, 'utf8') : '(no record written)' },
  ];
}

test(`adversarial guards / redact.before-store (${doc('Secrets in event payloads and transcripts are redacted before they are stored')}): no credential shape the redactor knows reaches the event log or a run record`, () => {
  const left = corpus().flatMap((c) => stored(c.text).flatMap((s) => (s.raw.includes(c.secret) || s.raw === '(no record written)' ? [`${c.what} in ${s.where}`] : [])));
  assert.deepEqual(left, [], 'secrets stored as they were');
  assert.ok(stored('an ordinary line').every((s) => s.raw.includes('an ordinary line')), 'control: ordinary text is stored as it is');
});

knownHole(`adversarial guards / redact.before-store (${doc('Secrets in event payloads and transcripts are redacted before they are stored')}): a Discord bot token is redacted before it is stored`, 'PR #921 (#889)', {}, () => {
  const token = [`M${alnum(23)}`, alnum(6), alnum(27)].join('.');
  const stores = stored(`bot token=${token} in a log line`);
  return { attacks: stores.map((s) => `a Discord bot token kept by ${s.where}`), open: stores.filter((s) => s.raw.includes(token)).map((s) => `a Discord bot token kept by ${s.where}`) };
});
