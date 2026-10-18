import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentSettingsPath, guardrailSettings, HOOK_MARKER, NO_ATTRIBUTION, projectSettingsRefusal, readAgentSettings, runSettings, SETTINGS_CHECK_KEY, type Settings } from '../src/agent-settings.js';
import { BRAND } from '../src/brand.js';
import { doctor } from '../src/doctor.js';
import { hookEntry, install, invokedEngine } from '../src/install.js';
import { childEnv } from '../src/os/index.js';
import { CliRunner } from '../src/runner.js';
import { engineCli, exampleProject, STDIN_LINE } from './helpers.js';

const INSTANCES = `${BRAND.envPrefix}_INSTANCES_DIR`;
const isWindows = process.platform === 'win32';

/** An example checkout and an (empty) instance home for it, with the instances dir pointed at it for this test. */
function setup(t: { after: (fn: () => void) => void }) {
  const { dir } = exampleProject();
  const instances = mkdtempSync(join(tmpdir(), 'agent-hooks-'));
  const home = join(instances, 'shop');
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(home, 'instance.yaml'), `version: 1\nname: shop\nrepos:\n  - path: ${JSON.stringify(dir)}\n    repo: example-org/example-shop\n`);
  const before = process.env[INSTANCES];
  process.env[INSTANCES] = instances;
  t.after(() => {
    if (before === undefined) delete process.env[INSTANCES];
    else process.env[INSTANCES] = before;
  });
  return { dir, home, instances };
}

test("install --instance writes the hooks and rules to the instance's agent settings, never into the checkout", (t) => {
  const { dir, home } = setup(t);
  const r = install({ root: dir, engineCli, instance: 'shop' });
  assert.equal(r.settingsPath, agentSettingsPath(home));
  assert.equal(existsSync(join(dir, '.claude', 'settings.json')), false, 'the repo needs no .claude/settings.json');
  const first = readFileSync(r.settingsPath, 'utf8');
  install({ root: dir, engineCli, instance: 'shop' });
  assert.equal(readFileSync(r.settingsPath, 'utf8'), first, 're-running is idempotent');
  const s = readAgentSettings(home);
  assert.equal(s.disableAllHooks, false, 'pinned off, so a project file cannot turn the hooks off');
  for (const event of ['PreToolUse', 'SessionStart', 'SessionEnd']) {
    const cmds = s.hooks![event]!.flatMap((e) => e.hooks).map((h) => h.command);
    assert.equal(cmds.length, 1, event);
    // The guard's own entry beside the engine's cli.js (#665).
    assert.ok(cmds[0]!.includes(HOOK_MARKER) && cmds[0]!.includes(`E="${hookEntry(engineCli)}"`), 'an absolute engine path, not one inside the agent-writable checkout');
  }
  assert.ok(s.permissions!.allow!.includes('Bash(npm test:*)'));
  assert.ok(s.permissions!.deny!.includes('Read(~/.ssh/**)'));
  if (!isWindows) assert.equal(statSync(r.settingsPath).mode & 0o777, 0o600, "only the coordinator user can read or change it");
  assert.throws(() => install({ root: dir, engineCli, instance: 'nope' }), /no instance "nope"/);
});

test('an agent run without agent settings never starts, and the error names the exact install command', (t) => {
  const { dir, home } = setup(t);
  const fix = `${BRAND.cli} install --root ${JSON.stringify(dir)} --instance shop`;
  assert.throws(() => guardrailSettings(home, 'shop', dir), (e: Error) => e.message.includes(fix) && /no agent settings at/.test(e.message));
  // Regression: hooks in the checkout's own .claude/settings.json (an install from before agent settings) never
  // stand in for them.
  install({ root: dir, engineCli });
  assert.throws(() => guardrailSettings(home, 'shop', dir), (e: Error) => e.message.includes(fix));
  install({ root: dir, engineCli, instance: 'shop' });
  assert.ok(guardrailSettings(home, 'shop', dir).hooks?.PreToolUse);
  // Incomplete agent settings are an error, never "no hooks".
  writeFileSync(agentSettingsPath(home), JSON.stringify({ hooks: {}, disableAllHooks: false }));
  assert.throws(() => guardrailSettings(home, 'shop', dir), /hook PreToolUse: not installed/);
});

test('a project .claude/settings.json that could loosen agent runs refuses them; hooks and tightening rules are fine', () => {
  const ours: Settings = { permissions: { allow: ['Bash(npm test:*)'] } };
  const dir = mkdtempSync(join(tmpdir(), 'proj-settings-'));
  mkdirSync(join(dir, '.claude'));
  const project = (s: object) => {
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(s));
    return projectSettingsRefusal(dir, ours);
  };
  assert.equal(projectSettingsRefusal(join(dir, 'none'), ours), null, 'no file: nothing to check');
  assert.equal(project({ hooks: { PostToolUse: [] }, permissions: { allow: ['Bash(npm test:*)'], deny: ['Read(./secret)'], ask: ['Bash(rm:*)'] } }), null);
  // Claude Code applies a project's env over the process environment, also to hooks: it could unset the agent flag.
  assert.match(project({ env: { [`${BRAND.envPrefix}_AGENT`]: '0' } }) ?? '', /it sets env/);
  assert.match(project({ disableAllHooks: true }) ?? '', /it sets disableAllHooks/);
  // A project's default effort refuses the run too, and says where it belongs (#584 shipped one and no agent run could start).
  assert.match(project({ effortLevel: 'high' }) ?? '', /it sets effortLevel \(an agent's effort is set by the runner, per role: #579/);
  assert.match(project({ sandbox: { network: { allowedDomains: ['*'] } } }) ?? '', /it sets sandbox/);
  assert.match(project({ permissions: { additionalDirectories: ['/'] } }) ?? '', /permissions\.additionalDirectories/);
  assert.match(project({ permissions: { allow: ['Bash(npm test:*)', 'Bash(curl:*)'] } }) ?? '', /it allows Bash\(curl:\*\), beyond/);
  writeFileSync(join(dir, '.claude', 'settings.json'), '{ not json');
  assert.match(projectSettingsRefusal(dir, ours) ?? '', /can't be read/);
});

test("a run's settings: the instance's hooks and rules, the lane's sandbox, the harness variables pinned, hooks kept on", () => {
  const ours: Settings = { disableAllHooks: false, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'ours' }] }] }, permissions: { allow: ['A'], deny: ['D1'] } };
  const lane = { sandbox: { enabled: true }, permissions: { deny: ['D2', 'D1'] }, hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'lane' }] }] } };
  const s = runSettings(ours, lane, { [`${BRAND.envPrefix}_AGENT`]: '1' });
  assert.deepEqual(s.sandbox, { enabled: true });
  assert.deepEqual(s.permissions, { allow: ['A'], deny: ['D1', 'D2'] });
  assert.deepEqual(s.hooks!.PreToolUse!.map((e) => e.hooks[0]!.command), ['ours', 'lane']);
  assert.deepEqual(s.env, { [`${BRAND.envPrefix}_AGENT`]: '1' });
  assert.equal(s.disableAllHooks, false);
});

// The setting names are Claude Code's own (its settings schema in the pinned CLI, 2.1.296): `attribution.commit` /
// `attribution.pr`, where an empty string hides it, `attribution.sessionUrl: false` (no session trailer or PR-body
// link), and the deprecated `includeCoAuthoredBy` that older versions read.
const attributionOff = (s: Settings) => {
  assert.deepEqual(s.attribution, { commit: '', pr: '', sessionUrl: false }, 'no attribution or session link in commits or PR bodies');
  assert.equal(s.includeCoAuthoredBy, false);
};

test("a run's settings turn commit and PR attribution off, and neither the instance's nor the lane's settings can turn it back on (#576)", () => {
  attributionOff(runSettings({ disableAllHooks: false }, undefined, {}));
  const on = { attribution: { commit: 'Co-Authored-By: x', pr: 'Generated with x' }, includeCoAuthoredBy: true };
  attributionOff(runSettings({ disableAllHooks: false, ...on }, on, {}));
});

/** A stand-in claude that records its arguments, or `null` when it was never started past auth. */
function fakeClaude(): { bin: string; seen: () => { settings: Settings | null } | null } {
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
  const log = join(dir, 'log.json');
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
${STDIN_LINE};
const i = args.indexOf('--settings');
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ settings: i >= 0 ? JSON.parse(args[i + 1]) : null }));
// As claude does with a --settings it applied (#626): the init event reports its outputStyle.
console.log(JSON.stringify({ type: 'system', subtype: 'init', output_style: (i >= 0 && JSON.parse(args[i + 1]).outputStyle) || 'default' }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0, num_turns: 1 }));
`,
  );
  chmodSync(bin, 0o755);
  return { bin, seen: () => (existsSync(log) ? (JSON.parse(readFileSync(log, 'utf8')) as { settings: Settings | null }) : null) };
}

const req = (cwd: string, lane?: string) => ({ prompt: 'p', model: 'm', cwd, allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, stallMs: 60_000, timeoutMs: 60_000, role: 'worker', ...(lane ? { lane } : {}) });

test("acceptance: an instance's agent run gets the hooks with --settings; without them, or with a loosening project file, it never starts", { skip: isWindows && 'POSIX stand-in claude' }, async (t) => {
  const { dir, home } = setup(t);
  const lanes = { default: { settings: { sandbox: { enabled: true }, permissions: { deny: ['Read(//x/**)'] } } }, research: { ownHooks: true } };
  const runner = (bin: string) => new CliRunner('cli', childEnv(), bin, undefined, lanes, undefined, {}, () => guardrailSettings(home, 'shop', dir));

  let c = fakeClaude();
  let r = await runner(c.bin).run(req(dir));
  assert.equal(r.reason, 'failed');
  assert.match(r.detail, /no agent settings at [\s\S]*install --root [\s\S]* --instance shop`; not starting/);
  assert.equal(c.seen(), null, 'claude never ran');

  install({ root: dir, engineCli, instance: 'shop' });
  c = fakeClaude();
  r = await runner(c.bin).run(req(dir));
  assert.equal(r.reason, 'succeeded', r.detail);
  const s = c.seen()!.settings!;
  assert.ok(s.hooks!.PreToolUse![0]!.hooks[0]!.command.includes(HOOK_MARKER));
  assert.equal(s.disableAllHooks, false);
  assert.equal(s.env![`${BRAND.envPrefix}_AGENT`], '1', 'pinned above any project env');
  assert.equal(s.env![`${BRAND.envPrefix}_ROLE`], 'worker');
  assert.deepEqual(s.sandbox, { enabled: true }, "the lane's sandbox is kept");
  assert.ok(s.permissions!.deny!.includes('Read(//x/**)') && s.permissions!.deny!.includes('Read(~/.ssh/**)'));
  attributionOff(s);

  // A lane with its own hooks (research without repo access) runs on those alone.
  c = fakeClaude();
  r = await runner(c.bin).run(req(dir, 'research'));
  assert.equal(r.reason, 'succeeded', r.detail);
  assert.equal(c.seen()!.settings, null);

  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ env: { [`${BRAND.envPrefix}_AGENT`]: '0' } }));
  c = fakeClaude();
  r = await runner(c.bin).run(req(dir));
  assert.equal(r.reason, 'failed');
  assert.match(r.detail, /could loosen agent runs: it sets env/);
  assert.equal(c.seen(), null, 'claude never ran');
});

test('a run without instance guardrails still gets attribution off in any --settings it is passed, and none when it is passed none (#576)', { skip: isWindows && 'POSIX stand-in claude' }, async (t) => {
  const { dir } = setup(t);
  const lanes = { default: { settings: { sandbox: { enabled: true } } }, research: { ownHooks: true, settings: { permissions: { deny: ['Read(//x/**)'] } } }, bare: { ownHooks: true } };
  for (const lane of ['default', 'research']) {
    const c = fakeClaude();
    const r = await new CliRunner('cli', childEnv(), c.bin, undefined, lanes).run(req(dir, lane));
    assert.equal(r.reason, 'succeeded', r.detail);
    attributionOff(c.seen()!.settings!);
  }
  const c = fakeClaude();
  assert.equal((await new CliRunner('cli', childEnv(), c.bin, undefined, lanes).run(req(dir, 'bare'))).reason, 'succeeded');
  assert.equal(c.seen()!.settings, null, 'no --settings is invented for a run that had none');
});

test("the attribution pin can never replace the run's --settings check value: the check key is spread last (#576, #626)", { skip: isWindows && 'POSIX stand-in claude' }, async (t) => {
  const { dir } = setup(t);
  const lanes = { default: { settings: { sandbox: { enabled: true } } } };
  // A pin that grew a value for the check key: the run's own fresh check value must still be the one claude gets.
  const pin = NO_ATTRIBUTION as unknown as Record<string, unknown>;
  pin[SETTINGS_CHECK_KEY] = 'from-the-attribution-pin';
  t.after(() => delete pin[SETTINGS_CHECK_KEY]);
  const c = fakeClaude();
  const r = await new CliRunner('cli', childEnv(), c.bin, undefined, lanes).run(req(dir));
  assert.equal(r.reason, 'succeeded', r.detail);
  const s = c.seen()!.settings! as Record<string, unknown>;
  assert.match(String(s[SETTINGS_CHECK_KEY]), /-settings-check-[0-9a-f]{16}$/, "the run's own check value, not the pin's");
  attributionOff(s as Settings);
});

test("doctor checks an instance's agent hooks where they now live, and fails an older install's project-level hooks", (t) => {
  const { dir, home } = setup(t);
  // The instance is found through the repo it runs, as on the coordinator's machine.
  writeFileSync(join(home, 'policy.yaml'), 'version: 1\nbudget: { daily_usd: 40 }\nagents: { max_workers: 4 }\n');
  let checks = doctor(dir);
  assert.equal(checks.find((c) => c.name === 'agent hooks shop')?.level, 'fail');
  // Regression: an older install's hooks in the checkout no longer count; doctor fails and names the command.
  install({ root: dir, engineCli });
  checks = doctor(dir);
  const legacy = checks.find((c) => c.name === 'agent hooks shop');
  assert.equal(legacy?.level, 'fail');
  assert.match(legacy!.detail, /no longer used for agent runs[\s\S]*install --root "[^"]+" --instance shop/);
  // Moved: the agent settings are checked, and a repo without .claude/settings.json is fine.
  install({ root: dir, engineCli, instance: 'shop' });
  const fresh = exampleProject().dir;
  writeFileSync(join(home, 'instance.yaml'), `version: 1\nname: shop\nrepos:\n  - path: ${JSON.stringify(fresh)}\n    repo: example-org/example-shop\n`);
  checks = doctor(fresh);
  for (const e of ['PreToolUse', 'SessionStart', 'SessionEnd']) {
    const c = checks.find((x) => x.name === `agent hook shop ${e}`);
    assert.equal(c?.level, 'ok', e);
    assert.match(c!.detail, /for agent runs only/);
  }
  assert.equal(checks.find((c) => c.name === 'hooks')?.level, 'ok');
  assert.ok(!checks.some((c) => c.name.startsWith('hook ')), 'no project-level hook checks without a project file');
  // A project file that would refuse every agent run fails doctor before the instance finds out.
  mkdirSync(join(fresh, '.claude'));
  writeFileSync(join(fresh, '.claude', 'settings.json'), JSON.stringify({ disableAllHooks: true }));
  assert.equal(doctor(fresh).find((c) => c.name === 'project settings')?.level, 'fail');
});

test('the CLI: install --instance and doctor --instance', { skip: isWindows && 'POSIX modes' }, (t) => {
  const { dir, instances } = setup(t);
  const env = { ...childEnv(), [INSTANCES]: instances };
  const inst = spawnSync(process.execPath, [engineCli, 'install', '--root', dir, '--instance', 'shop'], { encoding: 'utf8', env });
  assert.equal(inst.status, 0, inst.stderr);
  assert.match(inst.stdout, /hooks for shop's agent runs written to .*agent-settings\.json/);
  const doc = spawnSync(process.execPath, [engineCli, 'doctor', '--root', dir, '--instance', 'shop'], { encoding: 'utf8', env });
  assert.match(doc.stdout, /ok {4}agent hook shop PreToolUse: installed, fails closed, for agent runs only/);
});

test('install --instance points the hooks at the engine as invoked, not the versioned release behind its link', { skip: isWindows && 'symlinks need privileges on Windows' }, () => {
  // /usr/local/bin/<cli> -> /opt/<cli>/current/dist/src/cli.js, where current -> a release that an update replaces.
  const base = mkdtempSync(join(tmpdir(), 'engine-links-'));
  mkdirSync(join(base, 'release-1'));
  writeFileSync(join(base, 'release-1', 'cli.js'), '');
  symlinkSync(join(base, 'release-1'), join(base, 'current'));
  symlinkSync(join(base, 'current', 'cli.js'), join(base, 'bin-cli'));
  assert.equal(invokedEngine(join(base, 'bin-cli')), join(base, 'current', 'cli.js'));
  assert.equal(invokedEngine(join(base, 'release-1', 'cli.js')), join(base, 'release-1', 'cli.js'), 'not a link: itself');
});
