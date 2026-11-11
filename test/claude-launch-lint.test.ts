// lint-test
// One launch for every Claude Code session the engine starts (#958, the owner's decision, 2026-11-09): src/
// claude-launch.ts's launchClaude (and its sync sibling), which always loads no setting source, reads no MCP config but
// its own, takes its settings only from --settings, keeps the auto memory off and owns its environment. This holds src/
// to it, and it FAILS CLOSED (R1185ab, R1185ac; the structural move of #1264): it doesn't follow callees.
//
// - Every string literal and template part in src/ (typescript's parser, every .ts file) that IS the claude binary
//   (`claude`, ends in `/claude`, names `@anthropic-ai/claude-code` or `claude-code/cli.js`), outside
//   src/claude-launch.ts and outside a type (`'claude' | 'default'` runs nothing), is refused unless its whole line is
//   pinned in PINS, by file and line text, with why: an auth login or status, a `--version`, a lookup (`findTool`,
//   `which`), the runner's or skill-eval's binary handed to the launch, or a value that names claude as data (a step
//   id, an event field). So `findTool('claude') ?? 'claude'`, a template `${dir}/claude`, `join(bin, 'claude')`, a
//   ternary, `{ file: 'claude' }`, a tuple, `promisify(exec)`, a dynamic import or `Reflect.apply` are all refused,
//   whatever calls them; a new launch must go through the launch function, or be pinned with its reason in review.
// - `this.bin` (the runner's binary) may go nowhere but `bin: this.bin` in a launchClaude call, the three
//   auth-status helpers' binary argument, or claudeBin's first (the launch's resolver: it starts nothing).
// - The names are read in any case and with Windows' `.exe` and `.cmd` (R1185ae D4: `Claude` is `claude` on a
//   case-insensitive volume, and the npm package's file is bin/claude.exe), the package's name as a part of a path
//   (`join(…, '@anthropic-ai', 'claude-code', …)`) and its launcher cli-wrapper.cjs (R1185ad D1), the Agent SDK's package
//   (`@anthropic-ai/claude-agent-sdk`: it starts its own claude, and its settingSources loads every source), and a
//   shell string that runs claude however its words are spelled before a flag or after a pipe, a template read whole
//   as well as by part (R1185ag D1). A pin covers as many lines with its
//   exact text as it says (one by default), so a pinned line copied into new code is refused.
//
// What it can't see (named limits):
// - a pinned line's value used somewhere else (a lookup's result handed to a launch), or claudeBin's result: the pin's
//   reason says where it goes, and review holds it;
// - a binary name built at run time from parts (`'clau' + 'de'`) or from data with no `claude` in it (a config value,
//   an env variable, a constructor parameter that holds one: R1185ai M11);
// - a launch through a module outside src/ (scripts/: test/claude-launch-shell-lint.test.ts reads those), or a child
//   process that itself runs claude (a hook, a project command: the sandbox's job).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';
import { repoRoot } from './helpers.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;
const ts = createRequire(join(repoRoot, 'package.json'))('typescript') as Node;

/** A text that IS the claude binary: its name, a path to it (the native installer's `claude/versions/<v>` too: R1185ak K1/K2), its npm package, or its cli.js. */
const BINARY = /^claude(?:\.exe|\.cmd|\.ps1)?$|[\/\\]claude(?:\.exe|\.cmd|\.ps1)?$|^claude-code$|@anthropic-ai[\/\\]claude-code|claude-code[\/\\]cli\.js|cli-wrapper\.cjs|@anthropic-ai[\/\\]claude-agent-sdk|^claude-agent-sdk$|(?:^|[\/\\])claude[\/\\]versions(?:[\/\\]|$)/i;
/**
 * A string that runs claude as a shell command (R1185ag D1, as R1185ag measured it): the binary as a word, quoted or
 * from a `$(…)`, then any words and a flag (`claude "$1" -p`, `exec "claude" -p`, `"$(command -v claude)" -p`), or a
 * pipe into it (`… | claude $ARGS`); or (R1185ah D1, as R1185ah measured it) in a shell command's position with no
 * flag needed after it, its flags coming from outside the string (`exec claude "$@"`, `claude $ARGS`, a template's
 * substitution, `xargs claude`): at the start or after `;` `&` `|` `(` a backtick, a newline or `$(`, optionally after
 * a wrapper (exec, nohup, xargs, command, env, time, sudo, then, do) and its words, quoted or not, then the end, a
 * redirect, `;` `&` `|` `)`, or a space and a quote, `$`, `<` or a substitution.
 */
const COMMAND = /(?:^|[\s;&|(`"'])(?:\S*[\/\\])?claude(?:\.exe|\.cmd|\.ps1)?["'`)]*(?:\s+[^\s;&|]+)*?\s+--?[a-z]|\|\s*(?:\S*[\/\\])?claude(?:\.exe|\.cmd|\.ps1)?\b|(?:^|[;&|(`\n]|\$\()\s*(?:(?:exec|nohup|xargs|command|env|time|sudo|then|do)\s+(?:[^\s;&|]+\s+)*?)?["']?(?:\S*[\/\\])?claude(?:\.exe|\.cmd|\.ps1)?["']?(?=\s*(?:$|[<>;&|)])|\s+["'$<X])/i;
/**
 * A token of a shell string that is the binary (R1185aj/ak D1: no launcher list, so `setsid claude`, `FOO=1 claude` and
 * `timeout -k 5 3600 claude` are read too): exactly `claude`, or ending in `/claude`, `.exe`, `.cmd` or `.ps1`, once its
 * quotes, a `$(` or a `(` before it and a `)` `;` `&` `|` after it are taken off. Read only in a shell context
 * (shellContext), so prose elsewhere is untouched.
 */
const SHELL_TOKEN = /^(?:.*[\/\\])?claude(?:\.exe|\.cmd|\.ps1)?$/i;
/**
 * The same token in ANY string, wherever it ends up (R1185al/am D1, as R1185am measured it: a script held in a const, a
 * non-literal `shell`, an `exec` under another name all pass a syntactic gate): lower-case only, so prose (`Claude …`)
 * isn't one, and split at redirects and separators too (`claude>>"$LOG"`, `claude</dev/null`, `a;claude`).
 */
// The binary's token followed by what a shell call has after its command word (the end, a quote, `$`, `%`, `@`, a
// redirect, a separator, a flag, a substitution), not by a word, which is how prose reads ("claude exited …").
const WORD_TOKEN = /(?:^|[\s;&|<>(`'"{]|:[-=])(?:[^\s;&|<>()`'"{}]*[\/\\])?claude(?:\.exe|\.cmd|\.ps1)?(?=$|["$<>;&|)}`%@]|'(?![a-z])|\s+(?:["'$<>;&|)`%@-]|X(?![\w])|$)|\s*$)/;
const shellTokens = (t: string) => t.split(/[\s<>;&|]+/).map((w) => w.replace(/^(?:\$\(|[("'`])+/, '').replace(/[)"'`;&|]+$/, '')).filter(Boolean);

/**
 * Whether `n` is in a string a shell runs: inside an argv element after a `-c`-style flag (`sh -c`, `bash -lc`), the
 * first argument of `exec`/`execSync`, the first argument of a call given `{ shell: true }`, or a `$`-tagged template
 * (zx, execa). Anything inside that argument counts (a concatenation, a template, an array joined into it).
 */
function shellContext(n: Node): boolean {
  for (let x = n; x.parent && !ts.isFunctionLike(x.parent); x = x.parent) {
    const p = x.parent;
    if (ts.isTaggedTemplateExpression(p) && p.tag.getText() === '$') return true;
    if (ts.isArrayLiteralExpression(p)) {
      const k = p.elements.indexOf(x);
      const prev = k > 0 ? p.elements[k - 1] : null;
      if (prev && ts.isStringLiteralLike(prev) && /^-[A-Za-z]*c$/.test(prev.text)) return true;
    }
    if (ts.isCallExpression(p) && p.arguments[0] === x) {
      const callee = p.expression.getText();
      if (/(?:^|\.)exec(?:Sync)?$/.test(callee)) return true;
      if (p.arguments.some((a: Node) => ts.isObjectLiteralExpression(a) && a.properties.some((q: Node) => ts.isPropertyAssignment(q) && q.name.getText() === 'shell' && q.initializer.kind === ts.SyntaxKind.TrueKeyword))) return true;
    }
  }
  return false;
}
const LAUNCHER = 'src/claude-launch.ts';
const AUTH_HELPERS = /^(?:claudeAuthStatus|claudeAuthMethod|claudeAuthStatusJson)$/;

/** Lines that name the claude binary and may: file, the line's whole text (trimmed), why, and how many lines have it (1 when absent). */
// check-table: never-grow
export const PINS: ([string, string, string] | [string, string, string, number])[] = [
  ["src/cli-agents.ts", "if (req.interactive) return 'a person is waiting on this run; it runs on claude';", "a message naming claude (data): which runtime a run uses"],
  ["src/runner.ts", "if (req.provider?.kind === 'cli') return { reason: 'failed', detail: `${req.provider.name} runs on its own CLI, not claude; not starting`, costUsd: 0, turns: 0, model: req.model };", "a message naming claude (data): a provider's run uses its own CLI"],
  ["src/user-facing-error.ts", "\"that holds a Claude credential (a setup token, or a sign-in code), and the dashboard never takes one: install it at a root shell on the machine (credentials.sh <name> claude), or sign in there as the agent user; nothing was stored\",", "a message naming `credentials.sh <name> claude` (data): a root admin runs it"],
  ["src/claude-credential-guard.ts", "'issue #711: the dashboard never takes a Claude credential; a root admin installs it on the machine (sudo bash credentials.sh <name> claude), or signs in there as the agent user. See docs/auth.md';", "a message naming `credentials.sh <name> claude` (data): a root admin runs it"],
  ["src/claude-signin.ts", "const script = `sudo bash ${join(o.engineRoot, 'scripts', 'setup', 'credentials.sh')} ${o.instance} claude`;", "the sign-in script's text shown to a person (data): it names `credentials.sh <name> claude`"],
  ["src/claude-credential-guard.ts", "\"the dashboard no longer takes a Claude credential: a root admin installs one on the machine (sudo bash credentials.sh <name> claude), or signs in there as the agent user (sudo -u <agent user> -i claude auth login). See docs/auth.md\";", "a message naming claude (data): how a root admin installs a login"],
  ["src/cli.ts", "const USAGE = `${BRAND.name} ${pkg.version}: ${BRAND.tagline}", "the CLI's usage text (data): it names claude's commands, runs none"],
  ["src/cli.ts", "scaffold ${BRAND.configDir}/; with --instance, write the hooks and rules", "the CLI's usage text (data), a later line of the same template"],
  ["src/setup-steps.ts", "today: `Run \\`claude auth login\\` in a terminal, then \\`${BRAND.cli} init\\` again (it picks up here). An API key instead: \\`${BRAND.cli} init --answer agent-runtime=api_key --answer api-key-file=<path>\\`. The login must be one agent_runtime.kind runs on.`,", "a message naming `claude auth login` (data): the person runs it"],
  ["src/agent-settings.ts", "return `claude did not apply the --settings this run passed (${what}): its init event doesn't report the run's check value in output_style, so the run's deny rules and hooks may be off (one invalid value makes claude drop the whole file without a word)`;", "a message naming claude (data): the run's check that its --settings applied"],
  ["src/runner.ts", "? `claude sent ${j.type === 'assistant' || j.type === 'user' || j.type === 'result' ? `a ${j.type} line` : 'a line'} before its init event confirmed the --settings this run passed (${settingsName}), so its deny rules and hooks may be off`", "a message naming claude (data): what claude sent"],
  ["src/runner.ts", "if (settingsState === 'pending') return done({ reason: 'failed', detail: `claude exited ${code} before its init event confirmed the --settings this run passed (${settingsName}): ${stderrTail(stderr)}`, ...base });", "a message naming claude (data): claude exited before its init event"],
  ["src/claude-auth-failure.ts", "export const DEFAULT_LOGIN_KEY = 'claude';", "a login key (data), never run"],
  ["src/claude-signin.ts", "const c = spawn('claude', ['auth', 'login'], { env, stdio: 'ignore' });", "`claude auth login`: the sign-in, no session"],
  ["src/claude-signin.ts", "execFile('claude', ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 30_000, env: signinEnv(null) }, (_e, stdout) => resolve(parseClaudeStatus(stdout ?? '')));", "`claude auth status --json`: no session"],
  ["src/doctor.ts", "const claude = findTool('claude');", "a lookup; its only use is doctor's `claude --version`, no session"],
  ["src/doctor.ts", "if (!claude) add('claude', cfg?.project.agent_runtime.kind === 'cli' ? 'fail' : 'warn', `Claude Code CLI not on PATH or in ${toolBin()}`);", "a report row's name (data)"],
  ["src/doctor.ts", "add('claude', v.status === 0 ? 'ok' : 'warn', (v.stdout || v.stderr || '').trim().split('\\n')[0] ?? '');", "a report row's name (data)"],
  ["src/init.ts", "if (c.mode === 'server') return handoff(c, 'claude', act);", "a setup step id (data)"],
  ["src/init.ts", "if (!c.interactive || !c.io.which('claude')) return v.mismatch ? asStep(v) : { status: 'failed', detail: `${v.detail}: run \\`claude auth login\\`, then \\`${BRAND.cli} init\\` again (it picks up here)` };", "a lookup, and a message"],
  ["src/init.ts", "await c.io.interactive('claude', ['auth', 'login']);", "`claude auth login` on the person's terminal: no session"],
  ["src/instance.ts", "throw new ConfigInvalid([{ file: join(home, 'credentials.yaml'), path: 'claude', message: 'agents run as the coordinator user, so set claude.config_dir to the Claude login they use' }]);", "a config key (data)"],
  ["src/runner.ts", "export function authStatusCommand(env: NodeJS.ProcessEnv, runAs?: RunAs, bin = 'claude', agentPath?: string): { file: string; args: string[]; env: NodeJS.ProcessEnv } {", "the default binary of `claude auth status --json` (its only argv)"],
  ["src/runner.ts", "export function claudeAuthMethod(env: NodeJS.ProcessEnv, runAs?: RunAs, bin = 'claude'): string {", "the default binary of `claude auth status --json`"],
  ["src/runner.ts", "export function claudeAuthStatus(env: NodeJS.ProcessEnv, runAs?: RunAs, bin = 'claude', agentPath?: string): { method: string; text: string; account?: string | null } {", "the default binary of `claude auth status --json`"],
  ["src/runner.ts", "export function claudeAuthStatusJson(env: NodeJS.ProcessEnv, runAs?: RunAs, bin = 'claude'): { loggedIn: boolean; expiresAt?: unknown } | null {", "the default binary of `claude auth status --json`"],
  ["src/runner.ts", "private bin = 'claude',", "the runner's binary: it reaches only launchClaude and the auth-status helpers (the `this.bin` rule)"],
  ["src/service.ts", "const claude = new CliRunner(instanceRuntime(i).runtime, process.env, 'claude', i.runAs ?? undefined, allLanes(i), identity, {}, () => guardrailSettings(i.home, i.name, i.repo.path), agentKeyFile, login, plugins, { instance: i.name, register: (role, ttlMs) => registerRun(i.name, role, ttlMs), end: (ticket) => endRun(i.name, ticket) }, i.repo.path, start.cfg.project.project.default_branch, start.note === null ? undefined : start.cfg.guardrails.secret_paths, worktreePlaces(i.repo.path, start.cfg.tests.worktree.root, agentTasksDir(i.repo.path, i.stateDir, i.runAs ?? undefined)));", "an instance runner's binary (CliRunner's `bin`)"],
  ["src/setup-steps.ts", "export function claudeProbeRun(spec: LoginProofSpec, env: NodeJS.ProcessEnv, timeoutMs: number, bin = 'claude'): RunResult {", "the login proof's binary: handed only to launchClaudeSync, in this function"],
  ["src/setup-steps.ts", "{ id: 'claude', title: 'Claude login', optional: false, modes: MODES, walked: true },", "a setup group id (data)"],
  ["src/setup-steps.ts", "export const REQUIRED_TOOLS: Record<Mode, string[]> = { local: ['git', 'gitleaks', 'claude', 'gh'], server: ['git', 'gitleaks', 'claude'] };", "tool names the tools step looks up (data)"],
  ["src/setup-steps.ts", "if (!p.which('claude')) return no('claude is not installed (the tools step)');", "a lookup"],
  ["src/setup-steps.ts", "const r = p.run('claude', ['auth', 'status'], as);", "`claude auth status`: no session"],
  ["src/setup-steps.ts", "group: 'claude',", "a setup group id (data), on two steps", 2],
  ["src/skilleval.ts", "const child = launchClaude({ bin: 'claude', cwd: req.cwd, env: agentEnv(ownEnv(), 'cli'), settings: {}, mode: 'json', model: req.model, maxTurns: 3, maxBudgetUsd: req.maxBudgetUsd, allowedTools: [], disallowedTools: NO_TOOLS, jsonSchema: req.schema, ...(req.system ? { appendSystemPrompt: req.system } : {}) });", "skill-eval's binary, handed to launchClaude on this line"],
  ["src/tool-install.ts", "if (tool === 'claude') {", "a tool name (data)"],
  ["src/tool-install.ts", "return { tool, version: v, url: `https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-${v}.tgz`, checksum: { algo: 'sha512', value: PINS.claude.integrity.slice('sha512-'.length) }, archive: 'npm', member: '', dest, prefix };", "the pinned package's download URL (data)"],
  ["src/usage-limit.ts", "return { resetAt: new Date(Math.max(named, o.now + MIN_PAUSE_MS)).toISOString(), source: 'claude', kind };", "an event field's value (data)"],
  ["src/events/types.ts", "'usage.limit_hit': z.strictObject({ issue: issue.nullable(), role: z.string(), model: z.string(), provider: z.string().nullable(), reset_at: z.string(), source: z.enum(['claude', 'default']), kind: z.string().nullable(), detail: z.string() }),", "an event field's schema (data)"],
  ["src/events/types.ts", "'usage.paused': z.strictObject({ reset_at: z.string(), source: z.enum(['claude', 'default']), kind: z.string().nullable(), issue: issue.nullable(), role: z.string(), detail: z.string() }),", "an event field's schema (data)"],
];

/** Each line of `text` (the file `path`) that names the claude binary unpinned, or sends the runner's binary elsewhere. */
export function launchProblems(path: string, text: string): string[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const lines = text.split('\n');
  const lineOf = (n: Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const out: string[] = [];
  const inType = (n: Node) => {
    for (let p = n.parent; p; p = p.parent) if (ts.isTypeNode(p)) return true;
    return false;
  };
  // The lines each pin covers, so far: past its count, a copy is refused.
  const used = new Map<(typeof PINS)[number], Set<number>>();
  const visit = (n: Node) => {
    // A template is read whole too, each substitution as one word (R1185ag D1: a flag in its tail), besides its parts.
    const t = ts.isTemplateExpression(n) ? n.head.text + n.templateSpans.map((s: Node) => `X${s.literal.text}`).join('') : ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) ? n.text : null;
    if (t !== null && (BINARY.test(t) || COMMAND.test(t) || WORD_TOKEN.test(t) || (shellContext(n) && shellTokens(t).some((w) => SHELL_TOKEN.test(w)))) && path !== LAUNCHER && !inType(n)) {
      const at = lineOf(n);
      const line = lines[at - 1]!.trim();
      const pin = PINS.find(([f, l]) => f === path && l === line);
      const seen = pin ? (used.get(pin) ?? new Set<number>()) : null;
      if (pin && seen) {
        seen.add(at);
        used.set(pin, seen);
      }
      if (pin && seen && seen.size > (pin[3] ?? 1)) out.push(`${path}:${at}: a copy of a pinned line (\`${line.slice(0, 100)}\`): its pin covers ${pin[3] ?? 1} line(s); start every session with launchClaude`);
      else if (!pin) out.push(`${path}:${at}: names the claude binary (${n.getText(sf).slice(0, 60)}) outside ${LAUNCHER}: start every session with launchClaude; a lookup, an auth call or data is pinned in PINS with why (\`${line.slice(0, 100)}\`)`);
    }
    // The runner's binary reaches nothing but launchClaude (and the auth-status helpers, which start no session).
    // Destructured from `this`, or read as `this['bin']`, it is refused outright (R1185ai D1: M12, M13).
    if (path !== LAUNCHER && ((ts.isVariableDeclaration(n) && n.initializer?.kind === ts.SyntaxKind.ThisKeyword && ts.isObjectBindingPattern(n.name) && n.name.elements.some((e: Node) => (e.propertyName ?? e.name).getText(sf) === 'bin')) || (ts.isElementAccessExpression(n) && n.expression.kind === ts.SyntaxKind.ThisKeyword && ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === 'bin'))) out.push(`${path}:${lineOf(n)}: the runner's binary (\`${n.getText(sf).replace(/\s+/g, ' ').slice(0, 100)}\`) read another way than this.bin: read it as this.bin, into launchClaude`);
    if (ts.isPropertyAccessExpression(n) && n.expression.kind === ts.SyntaxKind.ThisKeyword && n.name.text === 'bin' && path !== LAUNCHER) {
      const p = n.parent;
      let call = p.parent;
      while (call && (ts.isAsExpression(call.parent) || ts.isSatisfiesExpression(call.parent) || ts.isParenthesizedExpression(call.parent))) call = call.parent;
      const intoLaunch = ts.isPropertyAssignment(p) && p.name.getText(sf) === 'bin' && ts.isObjectLiteralExpression(p.parent) && call?.parent && ts.isCallExpression(call.parent) && call.parent.expression.getText(sf) === 'launchClaude';
      const intoAuth = ts.isCallExpression(p) && AUTH_HELPERS.test(p.expression.getText(sf)) && p.arguments.includes(n);
      const intoResolver = ts.isCallExpression(p) && p.expression.getText(sf) === 'claudeBin' && p.arguments[0] === n;
      if (!intoLaunch && !intoAuth && !intoResolver) out.push(`${path}:${lineOf(n)}: the runner's binary (\`${p.getText(sf).replace(/\s+/g, ' ').slice(0, 100)}\`) goes somewhere but launchClaude`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const srcFiles = () => readdirSync(join(repoRoot, 'src'), { recursive: true }).map((x) => String(x).split(sep).join('/')).filter((x) => x.endsWith('.ts') && !x.endsWith('.d.ts')).map((x) => `src/${x}`);

test('#958: no module in src/ names the claude binary but src/claude-launch.ts and its pinned lines (fail closed)', () => {
  const files = srcFiles().map((p): [string, string] => [p, readFileSync(join(repoRoot, p), 'utf8')]);
  assert.deepEqual(files.flatMap(([p, t]) => launchProblems(p, t)), []);
  // It reads the real launch, and no pin is stale: each still names a line that is there.
  assert.match(readFileSync(join(repoRoot, LAUNCHER), 'utf8'), /return spawn\(w\.file, w\.args/);
  const text = new Map(files);
  for (const [f, l, , n = 1] of PINS) assert.equal((text.get(f) ?? '').split('\n').filter((x) => x.trim() === l).length, n, `${f}: the pinned line is there as many times as its pin says: ${l.slice(0, 80)}`);
});

test('#958: every way of naming claude outside the launch function is refused (fixtures), and the controls pass', () => {
  const dir = join(repoRoot, 'test', 'fixtures', 'claude-launch');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts.txt')).sort();
  // Every fixture by name: one deleted fails here.
  // check-table: never-shrink
  const MUST_FAIL = [
    'absolute-path',
    'agent-sdk',
    'alias-assign',
    'and-no-space',
    'array-join-line',
    'concat-args',
    'const-command-execsync',
    'const-multiline-script',
    'const-object-wrappers',
    'const-script',
    'const-bin',
    'data-literal',
    'default-expansion-sh',
    'default-import',
    'destructure-namespace',
    'direct-spawn',
    'case-folded-name',
    'cmd-c',
    'cmd-name',
    'copied-pinned-line',
    'exe-join',
    'exe-name',
    'exe-sh-c',
    'exec-renamed-import',
    'doctor-unpinned-line',
    'dyn-import',
    'element-access',
    'exec-string',
    'execpath-cli-js',
    'exported-name',
    'fn-call',
    'helper-const-findtool',
    'helper-findtool',
    'helper-findtool-nullish',
    'helper-join',
    'helper-object-bin',
    'helper-tuple-file',
    'namespace-import',
    'native-versions-join',
    'native-versions-template',
    'object-file',
    'os-wrapper',
    'npx-bare',
    'param-default',
    'pinned-line-plus-launch',
    'pkg-dir',
    'pkg-parts',
    'promisify-exec',
    'pwsh-command',
    'ps1-shim',
    'redirect-no-space',
    'reflect-apply',
    'renamed-import',
    'require-destructured',
    'runner-bin-escapes',
    'runner-bin-spawn',
    'sh-arg-before-flag',
    'shell-bin-bash',
    'sh-assignment-prefix',
    'sh-args-variable',
    'sh-c',
    'sh-exec-args',
    'sh-lookup',
    'sh-pipe',
    'sh-quoted-name',
    'sh-setsid',
    'sh-template-tail',
    'sh-timeout-args',
    'sh-timeout-k',
    'shell-true-template',
    'sh-xargs',
    'signin-session',
    'src-helper',
    'sudo-wrapper',
    'template-args',
    'this-bin-destructured',
    'this-bin-element',
    'template-path',
    'ternary',
    'wrapper-cjs',
  ];
  // check-table: never-shrink
  const CONTROLS = ['ok-launch-bin', 'ok-launcher', 'ok-other-tool', 'ok-signin', 'ok-type-position'];
  assert.deepEqual(files.map((f) => f.replace(/\.ts\.txt$/, '')).sort(), [...MUST_FAIL, ...CONTROLS].sort(), 'every fixture, by name');
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    // A fixture names where it stands in its first line: `// as src/<path>`.
    const as = /^\/\/ as (\S+)/.exec(text)?.[1] ?? `src/${f.replace(/\.txt$/, '')}`;
    const problems = launchProblems(as, text);
    if (f.startsWith('ok-')) assert.deepEqual(problems, [], `${f}: a control passes`);
    else assert.ok(problems.length > 0, `${f}: refused`);
  }
});
